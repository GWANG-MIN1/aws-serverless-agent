// Day 13 API handler — Hono + Lambda Function URL (BUFFERED).
//
// Day 12 와 거의 동일하다. Day 13 의 변화는 전부 Worker 쪽(Agent Loop)이고,
// API 가 하는 일은 그대로다: user msg Put + Worker async invoke + 조회.
//   USERS_TABLE     PK id
//   SESSIONS_TABLE  PK user_id, SK id          (원본 chat-sessions)
//   MESSAGES_TABLE  PK session_id, SK created_at_id (원본 chat-messages)
//
// Day 12 대비 딱 두 군데만 손봄:
//   1) GET /sessions/:id/messages 가 루프 단계(kind/code/toolUseId/ok)도 같이 내려줌
//      → executeCode 호출·결과까지 한 눈에 보이게(Agent Loop 검증용).
//   2) /health day 12 → 13.
//
// 라우트 계층 (Day 12 그대로):
//   POST /users                      → 유저 생성
//   POST /users/:userId/sessions     → 세션 생성(유저 소속)
//   GET  /users/:userId/sessions     → 유저의 세션 목록
//   POST /chat                       → { userId, sessionId, message } → user msg Put + Worker invoke
//   GET  /sessions/:sessionId/messages → 세션 메시지 시간순 (+ Day 13: 루프 단계 노출)
//
// 책임 분리 유지(Day 11~): API 는 Bedrock 권한 없음. Worker 만 모델을 부른다.

import { randomUUID } from "node:crypto";

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

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambdaClient = new LambdaClient({});

const USERS_TABLE = process.env.USERS_TABLE;
const SESSIONS_TABLE = process.env.SESSIONS_TABLE;
const MESSAGES_TABLE = process.env.MESSAGES_TABLE;
const HISTORY_LIMIT = parseInt(process.env.HISTORY_LIMIT ?? "20", 10);
const WORKER_FN = process.env.AGENT_WORKER_FUNCTION_NAME;
const MESSAGE_MAX = 4096;

// created_at_id 합성 SK — Day 7/11 의 makeSk 그대로. (created_at + id 를 한 정렬키로)
const makeCreatedAtId = () => `${new Date().toISOString()}#${randomUUID()}`;
const tsOf = (s) => s.split("#")[0];

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

app.get("/health", (c) => c.json({ ok: true, day: 13, role: "api" }));

app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));

export const handler = handle(app);
