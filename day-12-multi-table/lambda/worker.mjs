// Day 12 Worker handler — async invoked by API Lambda.
//
// 입력 (event): { type: "run_chat", userId, sessionId, message, createdAtId }
//
// Day 11 과의 차이:
//   - 히스토리 Query / assistant Put 대상이 단일 테이블 → MessagesTable
//     (PK session_id, SK created_at_id).
//   - 추가로 userId 가 있으면 SessionsTable 의 해당 세션 updatedAt 을 bump.
//     (SessionsTable PK 가 user_id 라서 세션 행을 집으려면 user_id 가 필요 — payload 로 받아온다)
//
// 책임 분리(Day 11):
//   - API: user msg Put + Worker async invoke 까지.
//   - Worker: 히스토리 조회 + Bedrock + assistant Put + 세션 updatedAt bump.

import { randomUUID } from "node:crypto";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const bedrock = new BedrockRuntimeClient({});

const MESSAGES_TABLE = process.env.MESSAGES_TABLE;
const SESSIONS_TABLE = process.env.SESSIONS_TABLE;
const MODEL_ID = process.env.MODEL_ID;
const HISTORY_LIMIT = parseInt(process.env.HISTORY_LIMIT ?? "20", 10);

const SYSTEM_PROMPT =
  "You are Claude, an AI assistant created by Anthropic. " +
  "When asked about yourself, identify as Claude made by Anthropic.";

const makeCreatedAtId = () => `${new Date().toISOString()}#${randomUUID()}`;

export const handler = async (event) => {
  if (event?.type !== "run_chat") {
    console.error("Worker: unknown event type", event?.type);
    return { ok: false, reason: "unknown_event_type" };
  }

  const { userId, sessionId, message } = event;
  if (!sessionId || !message) {
    console.error("Worker: missing sessionId or message", event);
    return { ok: false, reason: "missing_fields" };
  }

  // 1) 최근 N턴 이력 — MessagesTable Query (Day 11 패턴 그대로).
  //    이 시점에 API 가 방금 Put 한 user 메시지가 포함되어 있음.
  const past = await ddb.send(new QueryCommand({
    TableName: MESSAGES_TABLE,
    KeyConditionExpression: "session_id = :sid",
    ExpressionAttributeValues: { ":sid": sessionId },
    Limit: HISTORY_LIMIT,
    ScanIndexForward: false,
  }));

  const messages = (past.Items ?? [])
    .slice()
    .reverse()
    .map((item) => ({
      role: item.role,
      content: [{ text: item.content }],
    }));

  if (messages.length === 0 || messages[0].role !== "user") {
    console.error("Worker: invalid history head (must start with user)", { sessionId });
    return { ok: false, reason: "invalid_history_head" };
  }

  // 2) Bedrock Converse (non-stream)
  const res = await bedrock.send(new ConverseCommand({
    modelId: MODEL_ID,
    system: [{ text: SYSTEM_PROMPT }],
    messages,
    inferenceConfig: { maxTokens: 1024, temperature: 0.7 },
  }));

  const assistantText = res.output?.message?.content?.[0]?.text ?? "";
  const usage = res.usage ?? null;

  // 3) assistant 메시지 저장 → MessagesTable
  await ddb.send(new PutCommand({
    TableName: MESSAGES_TABLE,
    Item: {
      session_id: sessionId,
      created_at_id: makeCreatedAtId(),
      role: "assistant",
      content: assistantText,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    },
  }));

  // 4) 세션 updatedAt bump (분리된 SessionsTable 의 메타데이터 갱신).
  //    SessionsTable PK 가 user_id 라서 userId 가 있어야 행을 집을 수 있음.
  //    userId 없으면(하위호환) skip — 메시지 흐름 자체는 깨지지 않는다.
  if (userId) {
    try {
      await ddb.send(new UpdateCommand({
        TableName: SESSIONS_TABLE,
        Key: { user_id: userId, id: sessionId },
        UpdateExpression: "SET updatedAt = :now",
        // 세션이 아직 없으면 메타행을 만들지 않도록 존재 조건 — 없으면 조용히 무시.
        ConditionExpression: "attribute_exists(user_id)",
        ExpressionAttributeValues: { ":now": new Date().toISOString() },
      }));
    } catch (e) {
      // ConditionalCheckFailed = 세션 메타행 부재. assistant Put 은 이미 성공했으니 치명적 아님.
      console.warn("Worker: session updatedAt bump skipped", { sessionId, name: e?.name });
    }
  }

  return {
    ok: true,
    sessionId,
    outputChars: assistantText.length,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
  };
};
