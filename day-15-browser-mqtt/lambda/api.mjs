// Day 15 API handler — Hono + Lambda Function URL (BUFFERED).
//
// Day 14 까지 API 는 IoT 를 몰랐다(publish 는 Worker 책임). Day 15 에서 API 가 한 가지를 맡는다:
//   "브라우저가 sessions/:id/events 토픽을 구독할 수 있는 SigV4-presigned WSS URL 발급."
//   브라우저엔 AWS 키가 없으니, 그 세션 토픽만 구독 가능한 단명 자격증명을 서버가 서명해 URL 로 내려준다.
//
//   GET /sessions/:id/realtime →
//     1) STS AssumeRole(RealtimeRole) + 세션정책 → 그 세션 토픽만 Connect/Subscribe/Receive 가능한 임시 키
//     2) iot:DescribeEndpoint → WSS 호스트(xxxx-ats.iot.<region>.amazonaws.com)
//     3) signIotWebSocketUrl() → wss://host/mqtt?...SigV4... 반환  { url, channel }
//
// 원본 매핑: lib/iot-sigv4.ts(서명) + lambda-api/routes/realtime.ts(/connection) + lib/mqtt.ts(AssumeRole 스코핑).
//   원본은 유저별 토픽 + broker URL env. 우리는 세션별 토픽 + DescribeEndpoint 런타임 조회.
//
// 라우트 계층:
//   POST /users                        → 유저 생성
//   POST /users/:userId/sessions       → 세션 생성(유저 소속)
//   GET  /users/:userId/sessions       → 유저의 세션 목록
//   POST /chat                         → { userId, sessionId, message } → user msg Put + Worker invoke
//   GET  /sessions/:sessionId/messages → 세션 메시지 시간순 (+ 루프 단계 노출)
//   GET  /sessions/:sessionId/realtime → ★ Day 15: 브라우저용 SigV4 WSS URL + channel
//
// 책임 분리 유지(Day 11~): API 는 Bedrock 권한 없음. Worker 만 모델을 부른다.

import { randomUUID, createHash, createHmac } from "node:crypto";

import { Hono } from "hono";
import { handle } from "hono/aws-lambda";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  LambdaClient,
  InvokeCommand,
  InvocationType,
} from "@aws-sdk/client-lambda";
import { IoTClient, DescribeEndpointCommand } from "@aws-sdk/client-iot";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambdaClient = new LambdaClient({});
const iot = new IoTClient({});
const sts = new STSClient({});

const USERS_TABLE = process.env.USERS_TABLE;
const SESSIONS_TABLE = process.env.SESSIONS_TABLE;
const MESSAGES_TABLE = process.env.MESSAGES_TABLE;
const HISTORY_LIMIT = parseInt(process.env.HISTORY_LIMIT ?? "20", 10);
const WORKER_FN = process.env.AGENT_WORKER_FUNCTION_NAME;
const MESSAGE_MAX = 4096;
// Day 15
const MQTT_TOPIC_PREFIX = process.env.MQTT_TOPIC_PREFIX ?? "sessions";
const REALTIME_ROLE_ARN = process.env.AGENT_MQTT_ROLE_ARN;
const REGION = process.env.AWS_REGION; // Lambda 가 항상 주입.

// created_at_id 합성 SK — Day 7/11 의 makeSk 그대로. (created_at + id 를 한 정렬키로)
const makeCreatedAtId = () => `${new Date().toISOString()}#${randomUUID()}`;
const tsOf = (s) => s.split("#")[0];

const sessionTopic = (sessionId) => `${MQTT_TOPIC_PREFIX}/${sessionId}/events`;

// ────────────────────────────────────────────────────────────
// Day 15: WSS 호스트(IoT Data-ATS 엔드포인트) — cold start 때 한 번 조회해 캐싱 (Worker 와 동일 패턴).
// ────────────────────────────────────────────────────────────
let iotHostPromise;
function getIotHost() {
  if (!iotHostPromise) {
    iotHostPromise = iot
      .send(new DescribeEndpointCommand({ endpointType: "iot:Data-ATS" }))
      .then((r) => r.endpointAddress);
  }
  return iotHostPromise;
}

// ────────────────────────────────────────────────────────────
// Day 15: 한 세션 토픽만 Connect/Subscribe/Receive 가능한 임시 자격증명.
//   RealtimeRole 을 AssumeRole 하되, "세션정책"으로 이 sessionId 토픽까지 더 좁힌다.
//   → 브라우저가 URL 을 탈취당해도 그 세션 한 개만 구독 가능(다른 세션·publish 불가).
//   원본 lambda-api/routes/realtime.ts 의 scopedIotCredentialsFor 와 동일 발상.
// ────────────────────────────────────────────────────────────
async function scopedSessionCredentials(sessionId) {
  const topic = sessionTopic(sessionId);
  const sessionPolicy = {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: "iot:Connect", Resource: `arn:aws:iot:${REGION}:*:client/*` },
      { Effect: "Allow", Action: "iot:Subscribe", Resource: `arn:aws:iot:${REGION}:*:topicfilter/${topic}` },
      { Effect: "Allow", Action: "iot:Receive", Resource: `arn:aws:iot:${REGION}:*:topic/${topic}` },
    ],
  };
  const out = await sts.send(new AssumeRoleCommand({
    RoleArn: REALTIME_ROLE_ARN,
    RoleSessionName: `rt-${sessionId}`.slice(0, 64),
    DurationSeconds: 3600,
    Policy: JSON.stringify(sessionPolicy),
  }));
  const c = out.Credentials;
  return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken };
}

// ────────────────────────────────────────────────────────────
// Day 15: SigV4 로 IoT Core MQTT-over-WebSocket URL 서명 — 원본 lib/iot-sigv4.ts 그대로 포팅.
//   서비스명은 iotdevicegateway, 경로는 /mqtt. 보안 토큰은 서명 계산에서 빼고 URL 끝에 붙인다(IoT 특유).
// ────────────────────────────────────────────────────────────
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const sha256hex = (data) => createHash("sha256").update(data).digest("hex");

function signIotWebSocketUrl({ host, region, credentials }) {
  const iso = new Date().toISOString().replace(/[-:]/g, "");
  const date = iso.slice(0, 8);                 // YYYYMMDD
  const datetime = `${date}T${iso.slice(9, 15)}Z`; // YYYYMMDDTHHMMSSZ
  const service = "iotdevicegateway";
  const scope = `${date}/${region}/${service}/aws4_request`;

  const params = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${credentials.accessKeyId}/${scope}`,
    "X-Amz-Date": datetime,
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const canonicalRequest = [
    "GET", "/mqtt", canonicalQuery, `host:${host}\n`, "host", sha256hex(""),
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256", datetime, scope, sha256hex(canonicalRequest),
  ].join("\n");

  const signingKey = [date, region, service, "aws4_request"].reduce(
    (key, data) => hmac(key, data),
    Buffer.from(`AWS4${credentials.secretAccessKey}`),
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  let url = `wss://${host}/mqtt?${canonicalQuery}&X-Amz-Signature=${signature}`;
  if (credentials.sessionToken) {
    url += `&X-Amz-Security-Token=${encodeURIComponent(credentials.sessionToken)}`;
  }
  return url;
}

const app = new Hono();

// ────────────────────────────────────────────────────────────
// POST /users — 유저 생성
// ────────────────────────────────────────────────────────────
app.post("/users", async (c) => {
  let body = {};
  try {
    body = await c.req.json();
  } catch {
    // body 없이도 생성 허용 (name 은 옵션)
  }
  const name = typeof body?.name === "string" ? body.name.slice(0, 256) : undefined;

  const id = randomUUID();
  await ddb.send(new PutCommand({
    TableName: USERS_TABLE,
    Item: { id, name, createdAt: new Date().toISOString() },
  }));

  return c.json({ id, name }, 201);
});

// ────────────────────────────────────────────────────────────
// POST /users/:userId/sessions — 세션 생성 (유저 소속)
// ────────────────────────────────────────────────────────────
app.post("/users/:userId/sessions", async (c) => {
  const userId = c.req.param("userId");
  if (!userId) return c.json({ error: "userId required" }, 400);

  let body = {};
  try {
    body = await c.req.json();
  } catch { /* title 옵션 */ }
  const title = typeof body?.title === "string" ? body.title.slice(0, 256) : undefined;

  const now = new Date().toISOString();
  const sessionId = randomUUID();

  // SessionsTable: PK user_id, SK id. id 는 곧 sessionId — MessagesTable 의 session_id 와 연결된다.
  await ddb.send(new PutCommand({
    TableName: SESSIONS_TABLE,
    Item: { user_id: userId, id: sessionId, title, createdAt: now, updatedAt: now },
  }));

  return c.json({ sessionId, userId, title, createdAt: now }, 201);
});

// ────────────────────────────────────────────────────────────
// GET /users/:userId/sessions — 유저의 세션 목록 (★ 분리가 연 새 패턴)
// ────────────────────────────────────────────────────────────
app.get("/users/:userId/sessions", async (c) => {
  const userId = c.req.param("userId");
  if (!userId) return c.json({ error: "userId required" }, 400);

  const res = await ddb.send(new QueryCommand({
    TableName: SESSIONS_TABLE,
    KeyConditionExpression: "user_id = :uid",
    ExpressionAttributeValues: { ":uid": userId },
    ScanIndexForward: false, // SK(id=uuid) 기준 일관 정렬. 시간순 정렬은 updatedAt 으로 추후 GSI 영역.
  }));

  const sessions = (res.Items ?? []).map((it) => ({
    sessionId: it.id,
    title: it.title,
    createdAt: it.createdAt,
    updatedAt: it.updatedAt,
  }));

  return c.json({ userId, count: sessions.length, sessions });
});

// ────────────────────────────────────────────────────────────
// POST /chat — { userId, sessionId, message } async dispatch
// ────────────────────────────────────────────────────────────
app.post("/chat", async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const userId = body?.userId;
  const sessionId = body?.sessionId;
  const message = body?.message;

  if (!userId || !sessionId || !message) {
    return c.json({ error: "userId, sessionId and message are required" }, 400);
  }
  if (typeof message !== "string" || message.length > MESSAGE_MAX) {
    return c.json({ error: `message must be a string <= ${MESSAGE_MAX} chars` }, 400);
  }

  // 1) user 메시지 먼저 MessagesTable 에 박기 (Day 11 패턴 — invoke 실패해도 입력은 남음).
  const createdAtId = makeCreatedAtId();
  await ddb.send(new PutCommand({
    TableName: MESSAGES_TABLE,
    Item: {
      session_id: sessionId,
      created_at_id: createdAtId,
      role: "user",
      content: message,
    },
  }));

  // 2) Worker async invoke. userId 를 같이 넘겨 Worker 가 세션 updatedAt 을 bump 할 수 있게.
  await lambdaClient.send(new InvokeCommand({
    FunctionName: WORKER_FN,
    InvocationType: InvocationType.Event,
    Payload: Buffer.from(JSON.stringify({
      type: "run_chat",
      userId,
      sessionId,
      message,
      createdAtId,
    })),
  }));

  return c.json({ userId, sessionId, status: "queued", createdAtId }, 202);
});

// ────────────────────────────────────────────────────────────
// GET /sessions/:sessionId/messages — Day 11 로직, 키 이름만 변경
// ────────────────────────────────────────────────────────────
app.get("/sessions/:sessionId/messages", async (c) => {
  const sessionId = c.req.param("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);

  const limitRaw = parseInt(c.req.query("limit") ?? `${HISTORY_LIMIT}`, 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), 100)
    : HISTORY_LIMIT;
  const before = c.req.query("before");

  const keyExpr = before
    ? "session_id = :sid AND created_at_id < :before"
    : "session_id = :sid";

  const exprValues = before
    ? { ":sid": sessionId, ":before": before }
    : { ":sid": sessionId };

  const res = await ddb.send(new QueryCommand({
    TableName: MESSAGES_TABLE,
    KeyConditionExpression: keyExpr,
    ExpressionAttributeValues: exprValues,
    Limit: limit,
    ScanIndexForward: false,
  }));

  const itemsDesc = res.Items ?? [];
  const messages = itemsDesc
    .slice()
    .reverse()
    .map((item) => ({
      ts: tsOf(item.created_at_id),
      sk: item.created_at_id,
      role: item.role,
      // Day 13: 루프 단계 구분. 없으면(Day 12 이전 행) undefined → 평범한 text 로 취급.
      kind: item.kind,
      content: item.content,
      // tool_call 행이면 실행한 코드, tool_result 행이면 성공 여부 / 도구 호출 id.
      code: item.code,
      toolUseId: item.toolUseId,
      ok: item.ok,
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
    }));

  const nextBefore = itemsDesc.length === limit
    ? itemsDesc[itemsDesc.length - 1].created_at_id
    : null;

  return c.json({ sessionId, count: messages.length, messages, nextBefore });
});

// ────────────────────────────────────────────────────────────
// GET /sessions/:sessionId/realtime — ★ Day 15
//   브라우저가 이 세션 토픽을 WSS 로 구독하도록, 세션 한정 SigV4 URL + channel 발급.
//   응답: { url: "wss://...-ats.iot...amazonaws.com/mqtt?...", channel: "sessions/<id>/events", expiresInSec }
// ────────────────────────────────────────────────────────────
app.get("/sessions/:sessionId/realtime", async (c) => {
  const sessionId = c.req.param("sessionId");
  if (!sessionId) return c.json({ error: "sessionId required" }, 400);
  if (!REALTIME_ROLE_ARN) return c.json({ error: "realtime_not_configured" }, 500);

  try {
    const [host, credentials] = await Promise.all([
      getIotHost(),
      scopedSessionCredentials(sessionId),
    ]);
    const url = signIotWebSocketUrl({ host, region: REGION, credentials });
    return c.json({ url, channel: sessionTopic(sessionId), expiresInSec: 3600 });
  } catch (e) {
    console.error("realtime connection failed", { sessionId, name: e?.name, msg: e?.message });
    return c.json({ error: "realtime_failed" }, 500);
  }
});

app.get("/health", (c) => c.json({ ok: true, day: 15, role: "api" }));

app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));

export const handler = handle(app);
