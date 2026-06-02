// Day 11 API handler — Hono + Lambda Function URL (BUFFERED).
//
// Day 7 과의 차이 (핵심):
//   - POST /chat 이 Bedrock 을 직접 부르지 않는다.
//     1) sessionId/message validate
//     2) user 메시지를 DDB 에 Put (Day 7 와 동일 패턴 — 호출 도중 에러나도 입력은 살아남음)
//     3) Worker Lambda 를 `InvocationType: Event` 로 async invoke
//     4) 202 + { sessionId, status: "queued" } 즉시 응답
//   - streamHandle / streamText 사용 안 함. 일반 hono/aws-lambda handle().
//   - GET /sessions/:id/messages 는 Day 7 그대로.
//
// 왜 굳이 Function URL 을 BUFFERED 로 내리는가:
//   POST 응답이 단순 JSON 202 이고, GET 도 buffered JSON.
//   RESPONSE_STREAM 은 streamifyResponse 가 강제되어 작은 응답이 오히려 무거움.
//
// Worker 에러는 어떻게 알지?
//   오늘은 모름. async invoke 는 fire-and-forget — 클라이언트는 GET /sessions/:id/messages
//   로 "assistant 메시지가 도착했는지" 폴링해서 확인. 이 한계가 Day 14 에서 MQTT 로 풀린다.
//   실패는 Lambda 의 async 재시도(기본 2회) 후 DLQ 로 — 그것도 Day 13/14 작업.

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

const TABLE = process.env.TABLE_NAME;
const HISTORY_LIMIT = parseInt(process.env.HISTORY_LIMIT ?? "20", 10);
const WORKER_FN = process.env.AGENT_WORKER_FUNCTION_NAME;
const MESSAGE_MAX = 4096;

// Day 7 의 SK 합성 패턴 그대로.
const makeSk = () => `${new Date().toISOString()}#${randomUUID()}`;
const tsOf = (sk) => sk.split("#")[0];

const app = new Hono();

// ────────────────────────────────────────────────────────────
// POST /chat — async dispatch
// ────────────────────────────────────────────────────────────
app.post("/chat", async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const sessionId = body?.sessionId;
  const message = body?.message;

  if (!sessionId || !message) {
    return c.json({ error: "sessionId and message are required" }, 400);
  }
  if (typeof message !== "string" || message.length > MESSAGE_MAX) {
    return c.json({ error: `message must be a string <= ${MESSAGE_MAX} chars` }, 400);
  }

  // 1) user 메시지 먼저 박기 — Worker invoke 가 실패해도 입력은 남는다.
  //    (Day 5 부터 일관된 패턴: "user 먼저 Put, assistant 마지막 Put")
  const userSk = makeSk();
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      sessionId,
      ts: userSk,
      role: "user",
      content: message,
    },
  }));

  // 2) Worker async invoke.
  //    InvocationType: Event = fire-and-forget. 응답 본문 안 기다리고 바로 리턴.
  //    Worker 가 200 OK 안 줘도 무방 — Lambda 내부 큐가 receive 만 확인.
  //
  //    payload 형식은 원본의 `{ type: "run_chat", ... }` discriminated union 패턴.
  //    Day 13 에서 다른 type (e.g. tool_loop) 이 추가될 수 있게 미리 type 필드 둠.
  await lambdaClient.send(new InvokeCommand({
    FunctionName: WORKER_FN,
    InvocationType: InvocationType.Event,
    Payload: Buffer.from(JSON.stringify({
      type: "run_chat",
      sessionId,
      message,
      // userSk: 디버그용. Worker 가 같은 sessionId 의 직전 user 메시지를 식별하기 쉽게.
      userSk,
    })),
  }));

  // 3) 202 Accepted — 표준 "받았고 비동기로 처리 중" 응답
  return c.json({ sessionId, status: "queued", userSk }, 202);
});

// ────────────────────────────────────────────────────────────
// GET /sessions/:sessionId/messages — Day 7 그대로
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
    ? "sessionId = :sid AND ts < :before"
    : "sessionId = :sid";

  const exprValues = before
    ? { ":sid": sessionId, ":before": before }
    : { ":sid": sessionId };

  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
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
      ts: tsOf(item.ts),
      sk: item.ts,
      role: item.role,
      content: item.content,
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
    }));

  const nextBefore = itemsDesc.length === limit
    ? itemsDesc[itemsDesc.length - 1].ts
    : null;

  return c.json({
    sessionId,
    count: messages.length,
    messages,
    nextBefore,
  });
});

app.get("/health", (c) => c.json({ ok: true, day: 11, role: "api" }));

app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));

// BUFFERED Function URL 에선 streamHandle 이 아니라 일반 handle 사용.
export const handler = handle(app);
