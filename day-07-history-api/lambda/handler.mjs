// Day 7 Chat + History handler — Hono + Lambda Function URL streaming
//
// Day 6 와의 차이:
//   - awslambda.streamifyResponse 를 직접 안 쓰고 hono/aws-lambda 의 streamHandle 사용
//     → 같은 Lambda 안에서 POST(streaming) + GET(JSON) 라우트를 함께 노출
//   - 메시지 SK 를 `ts` → `${ts}#${uuid}` 합성 (같은 ms 동시 insert 시 덮어쓰기 방지)
//   - GET /sessions/:id/messages?limit=N — ScanIndexForward:false + reverse 로 "최근 N턴" 정확히
//
// 라우트:
//   POST /chat
//     body  : { sessionId, message }
//     resp  : text/plain chunks (Bedrock 토큰 스트림)
//   GET  /sessions/:sessionId/messages?limit=N&before=<ts>
//     resp  : { sessionId, count, messages: [{ ts, role, content }], nextBefore? }

import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import { streamHandle } from "hono/aws-lambda";
import { streamText } from "hono/streaming";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const bedrock = new BedrockRuntimeClient({});

const TABLE = process.env.TABLE_NAME;
const MODEL_ID = process.env.MODEL_ID;
const HISTORY_LIMIT = parseInt(process.env.HISTORY_LIMIT ?? "20", 10);
const MESSAGE_MAX = 4096;

// 자기 정체성 anchor — system prompt 가 비어 있으면 모델이 "OpenAI 의 Claude" 같은
// 모순 응답을 confabulate 함. 학습 데이터 분포상 "AI 자기소개" 토큰 시퀀스의
// 회사 슬롯에 ChatGPT/OpenAI 가 강한 prior 로 잡혀 있기 때문.
// → system 한 줄로 회사 슬롯을 Anthropic 으로 고정.
//
// 주의: 부정형("X 가 만들지 않았다") 을 넣으면 모델이 응답에 그대로 노출시켜
//       "저는 Anthropic 이 만든 Claude 이며 OpenAI, Google 이 만들지 않았다" 같은 누출 발생.
//       → 긍정형만으로 짧게.
const SYSTEM_PROMPT =
  "You are Claude, an AI assistant created by Anthropic. " +
  "When asked about yourself, identify as Claude made by Anthropic.";

// SK 합성: `${ISO}#${uuid}`
//   - 정렬은 ISO 가 앞에 있어 시간순 그대로
//   - 같은 ms 에 두 insert 가 들어와도 uuid 가 달라 키 충돌/덮어쓰기 없음
//   - 원본(breath103) 의 `${now}#${id}` 와 동일 패턴
const makeSk = () => `${new Date().toISOString()}#${randomUUID()}`;

// SK 에서 ts 부분만 뽑기 — GET 응답을 깔끔히 하려고 ts 컬럼 노출 시 사용.
const tsOf = (sk) => sk.split("#")[0];

const app = new Hono();

// ────────────────────────────────────────────────────────────
// POST /chat  — Bedrock 스트리밍 응답
// ────────────────────────────────────────────────────────────
app.post("/chat", async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.text("ERROR: invalid JSON body", 400);
  }

  const sessionId = body?.sessionId;
  const message = body?.message;

  if (!sessionId || !message) {
    return c.text("ERROR: sessionId and message are required", 400);
  }
  if (typeof message !== "string" || message.length > MESSAGE_MAX) {
    return c.text(`ERROR: message must be a string <= ${MESSAGE_MAX} chars`, 400);
  }

  // streamText: Hono 가 streamHandle 컨텍스트에서 chunk 단위로 흘려보낼 수 있게 해줌.
  // 내부적으로 awslambda.streamifyResponse 의 responseStream.write 로 매핑됨.
  return streamText(c, async (stream) => {
    try {
      // 1) 최근 N턴 이력 조회
      //    ScanIndexForward:false + Limit N → 가장 최근 N개를 효율적으로 가져옴.
      //    Bedrock 에 넣을 땐 시간순(오래된→최신) 이어야 하므로 reverse.
      //    Day 5/6 는 ScanIndexForward:true 로 가져와서 "가장 오래된 N개"가 됐었음.
      const past = await ddb.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "sessionId = :sid",
        ExpressionAttributeValues: { ":sid": sessionId },
        Limit: HISTORY_LIMIT,
        ScanIndexForward: false,
      }));

      const history = (past.Items ?? [])
        .slice()
        .reverse()
        .map((item) => ({
          role: item.role,
          content: [{ text: item.content }],
        }));

      // 2) user 메시지 저장 — Bedrock 호출 전에 먼저 박아둠 (Day 6 와 동일 이유)
      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: {
          sessionId,
          ts: makeSk(),
          role: "user",
          content: message,
        },
      }));

      // 3) Bedrock streaming
      const messages = [
        ...history,
        { role: "user", content: [{ text: message }] },
      ];

      const bedrockRes = await bedrock.send(new ConverseStreamCommand({
        modelId: MODEL_ID,
        // system prompt: 모델 자기정체성 anchoring — 없으면 "OpenAI의 Claude" 환각이 stochastic 하게 뜸.
        system: [{ text: SYSTEM_PROMPT }],
        messages,
        inferenceConfig: { maxTokens: 1024, temperature: 0.7 },
      }));

      let assistantText = "";
      let usage = null;

      for await (const chunk of bedrockRes.stream) {
        if (chunk.contentBlockDelta?.delta?.text) {
          const piece = chunk.contentBlockDelta.delta.text;
          assistantText += piece;
          await stream.write(piece);
        } else if (chunk.metadata?.usage) {
          usage = chunk.metadata.usage;
        }
      }

      // 4) assistant 메시지 저장
      //    stream 콜백이 return 한 뒤에 Hono 가 응답을 닫지만,
      //    Lambda 는 콜백 안 await 이 끝나야 다음으로 넘어가므로
      //    여기서 await Put 해도 응답 close 타이밍엔 영향 없음.
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
    } catch (err) {
      console.error("Chat handler error:", err);
      try { await stream.write(`\n[ERROR] ${err.message}`); } catch {}
    }
  });
});

// ────────────────────────────────────────────────────────────
// GET /sessions/:sessionId/messages — 히스토리 조회 (멀티턴 UI 용)
// ────────────────────────────────────────────────────────────
//
// Query params:
//   limit  : 기본 HISTORY_LIMIT, 1~100 사이 clamp
//   before : 페이지네이션 커서. ts(SK) 보다 이전 메시지만 가져옴.
//
// 반환은 항상 시간순(ASC) — UI 가 그대로 렌더하기 편하게.
// 내부적으론 ScanIndexForward:false 로 "최근 N개"를 가져와서 reverse.
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
    ScanIndexForward: false, // 최신 → 과거 순으로 N개
  }));

  const itemsDesc = res.Items ?? [];
  const messages = itemsDesc
    .slice()
    .reverse() // 응답은 시간순(과거 → 최신)
    .map((item) => ({
      ts: tsOf(item.ts),
      sk: item.ts,
      role: item.role,
      content: item.content,
      inputTokens: item.inputTokens,
      outputTokens: item.outputTokens,
    }));

  // nextBefore: 더 가져올 게 있을 때, 다음 페이지 호출용 커서.
  //   "이번 응답 중 가장 오래된 ts" 를 다음 호출의 before= 로 쓰면 됨.
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

// 헬스체크 — 단순 ping. 라우터 잘 붙었는지 빠르게 확인용.
app.get("/health", (c) => c.json({ ok: true, day: 7 }));

// 404 핸들러 — 라우트 못 맞춘 경우. Hono 기본은 plain text 라 json 으로 통일.
app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));

// streamHandle: Hono app → AWS Lambda streaming 핸들러.
// 내부적으로 awslambda.streamifyResponse 를 호출하므로
//   - Function URL 의 invokeMode 는 RESPONSE_STREAM 이어야 함
//   - 일반 c.json 응답도 streaming 으로 한 번에 흘러나감 (브라우저 입장에선 동일)
export const handler = streamHandle(app);
