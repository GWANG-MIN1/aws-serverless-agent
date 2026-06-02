// Day 11 Worker handler — async invoked by API Lambda.
//
// 입력 (event): API 가 InvokeCommand 의 Payload 로 보낸 JSON 그대로.
//   { type: "run_chat", sessionId, message, userSk }
//
// 책임 분리:
//   - API 는 "받았다" 까지만 — DDB 에 user msg Put + Worker async invoke
//   - Worker 가 "처리" — 히스토리 조회 + Bedrock 호출 + assistant msg Put
//
// 왜 ConverseStream 대신 Converse?
//   오늘은 Worker 의 출력이 어디로도 흘러갈 곳이 없음 (HTTP 응답은 이미 API 가 202 로 닫음).
//   결과는 DDB 에만 남고, 클라이언트는 GET 으로 폴링. 이 한계가 Day 14 에서 IoT MQTT 로 풀린다.
//   Day 14 가 오면 여기 ConverseStream + 토큰별 MQTT publish 로 바꿀 자리.
//
// 에러 처리:
//   throw 하면 Lambda async 가 기본 2회 재시도 후 destination/DLQ 로 보냄.
//   학습 단계라 DLQ 설정은 안 함 — 실패는 CloudWatch Logs 로만 확인.

import { randomUUID } from "node:crypto";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const bedrock = new BedrockRuntimeClient({});

const TABLE = process.env.TABLE_NAME;
const MODEL_ID = process.env.MODEL_ID;
const HISTORY_LIMIT = parseInt(process.env.HISTORY_LIMIT ?? "20", 10);

// Day 7 의 자기정체성 anchor 그대로.
const SYSTEM_PROMPT =
  "You are Claude, an AI assistant created by Anthropic. " +
  "When asked about yourself, identify as Claude made by Anthropic.";

const makeSk = () => `${new Date().toISOString()}#${randomUUID()}`;

export const handler = async (event) => {
  // discriminated union — Day 13 에서 다른 type 추가 대비.
  if (event?.type !== "run_chat") {
    console.error("Worker: unknown event type", event?.type);
    return { ok: false, reason: "unknown_event_type" };
  }

  const { sessionId, message } = event;
  if (!sessionId || !message) {
    console.error("Worker: missing sessionId or message", event);
    return { ok: false, reason: "missing_fields" };
  }

  // 1) 최근 N턴 이력 — Day 7 패턴 그대로 (ScanIndexForward:false + reverse).
  //    중요: 이 시점엔 API 가 방금 Put 한 user 메시지가 포함되어 있음.
  //    그래서 messages 배열을 만들 땐 "히스토리" 만으로 충분, 마지막 user 를 또 push 하지 않는다.
  //    (Day 7 는 user 를 Put 하기 *전에* 히스토리를 가져왔으므로 마지막 user 를 따로 push 했었음 — 거기와 다른 부분)
  const past = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "sessionId = :sid",
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

  // Bedrock 가드 — 히스토리 첫 메시지는 user 여야 함.
  // 정상 흐름에선 API 가 항상 user Put 을 먼저 하므로 보장됨.
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

  const assistantText =
    res.output?.message?.content?.[0]?.text ?? "";
  const usage = res.usage ?? null;

  // 3) assistant 메시지 저장
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      sessionId,
      ts: makeSk(),
      role: "assistant",
      content: assistantText,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    },
  }));

  return {
    ok: true,
    sessionId,
    outputChars: assistantText.length,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
  };
};
