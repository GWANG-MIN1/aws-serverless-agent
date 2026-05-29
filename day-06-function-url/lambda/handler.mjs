// Day 6 Chat handler — Lambda Function URL + Bedrock streaming
//
// Day 5 와의 차이:
//   - export 가 awslambda.streamifyResponse(...) 로 감싸짐 → streaming Lambda
//   - 이벤트 포맷이 API GW v2 호환 ({ body: "json string", ... }) → JSON.parse 필요
//   - Bedrock 도 ConverseCommand → ConverseStreamCommand
//   - 토큰 받는 즉시 responseStream.write(chunk) → 클라이언트가 끊김 없이 받음
//   - assistant 메시지는 stream 끝난 뒤 누적본을 한 번에 DDB Put
//
// 입력 (HTTP body):  { "sessionId": "abc-123", "message": "안녕" }
// 응답 (stream):     "안녕" "하세" "요!" ... (text chunks, plain text/event-stream)

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

// awslambda 는 Node.js Lambda 런타임이 글로벌로 주입하는 객체.
// import 불필요. streamifyResponse 는 streaming Lambda 마커 역할.
//   - 인자: (event, responseStream, context)
//   - responseStream 은 Writable. write/end 로 청크 전송.
export const handler = awslambda.streamifyResponse(
  async (event, responseStream) => {
    console.log("Event:", JSON.stringify(event));

    // Function URL 호출은 API GW v2 와 같은 이벤트 모양.
    // body 는 JSON 문자열로 들어옴.
    let body = {};
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch {
      responseStream.write("ERROR: invalid JSON body");
      responseStream.end();
      return;
    }

    const sessionId = body.sessionId;
    const message = body.message;

    if (!sessionId || !message) {
      responseStream.write("ERROR: sessionId and message are required");
      responseStream.end();
      return;
    }

    try {
      // 1) 이력 조회 — Day 5 와 동일
      const past = await ddb.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "sessionId = :sid",
        ExpressionAttributeValues: { ":sid": sessionId },
        Limit: HISTORY_LIMIT,
        ScanIndexForward: true,
      }));

      const history = (past.Items ?? []).map((item) => ({
        role: item.role,
        content: [{ text: item.content }],
      }));

      // 2) user 메시지 저장 (Bedrock 호출 전에 먼저 박아둠 — 실패해도 user 입력은 남음)
      const userTs = new Date().toISOString();
      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: { sessionId, ts: userTs, role: "user", content: message },
      }));

      // 3) Bedrock streaming 호출
      const messages = [
        ...history,
        { role: "user", content: [{ text: message }] },
      ];

      const bedrockRes = await bedrock.send(new ConverseStreamCommand({
        modelId: MODEL_ID,
        messages,
        inferenceConfig: { maxTokens: 1024, temperature: 0.7 },
      }));

      // 4) 청크 받는 대로 즉시 클라이언트로 흘려보내고, DDB 저장용으로도 누적
      //    bedrockRes.stream 은 async iterable.
      //    이벤트 종류:
      //      - messageStart        : { role: "assistant" }
      //      - contentBlockDelta   : { delta: { text: "..." } }  ← 텍스트 토막
      //      - contentBlockStop    : (블록 종료)
      //      - messageStop         : { stopReason }
      //      - metadata            : { usage: { inputTokens, outputTokens } }
      let assistantText = "";
      let usage = null;

      for await (const chunk of bedrockRes.stream) {
        if (chunk.contentBlockDelta?.delta?.text) {
          const piece = chunk.contentBlockDelta.delta.text;
          assistantText += piece;
          responseStream.write(piece);
        } else if (chunk.metadata?.usage) {
          usage = chunk.metadata.usage;
        }
      }

      responseStream.end();

      // 5) 응답 다 흘려보낸 뒤 assistant 누적본을 DDB 에 저장
      //    end() 이후에도 Lambda 는 코드 끝까지 실행됨 → 사용자 대기시간엔 영향 없음
      const assistantTs = new Date().toISOString();
      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: {
          sessionId,
          ts: assistantTs,
          role: "assistant",
          content: assistantText,
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
        },
      }));
    } catch (err) {
      console.error("Handler error:", err);
      // 이미 일부 청크가 흘렀을 수도 있으니 에러 마커만 덧붙임
      try { responseStream.write(`\n[ERROR] ${err.message}`); } catch {}
      try { responseStream.end(); } catch {}
    }
  }
);
