// Chat MVP Lambda
// 흐름:
//   1) 같은 sessionId 의 과거 메시지를 DDB Query (시간순)
//   2) 유저 메시지 DDB Put
//   3) history + 새 user 메시지 → Bedrock Converse 호출
//   4) assistant 응답 DDB Put
//   5) 응답 반환
//
// 입력 (event):  { "sessionId": "abc-123", "message": "안녕" }
// 응답:          { ok, reply, usage, sessionId }

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

export const handler = async (event) => {
  console.log("Event:", JSON.stringify(event));

  const sessionId = event?.sessionId;
  const message = event?.message;

  if (!sessionId || !message) {
    return { ok: false, error: "sessionId and message are required" };
  }

  try {
    // 1) 과거 이력 조회 — 시간순 (ScanIndexForward=true)
    //    Limit 으로 최근 N 턴만 가져와서 Bedrock 토큰 비용 통제.
    //    실제로 "가장 최근 N" 을 원하면 ScanIndexForward=false 로 받고 reverse 해야 정확함.
    //    여기선 단순화를 위해 그냥 앞에서부터 N개 (= 가장 오래된 N개)로 둠.
    //    Day 6+ 에서 개선 예정.
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

    // 2) user 메시지 저장
    //    ts 충돌 방지: ISO + nanoid 같은 거 쓰는 게 정석이지만 ms 정밀도면 충분.
    //    user/assistant 사이엔 Bedrock 호출(수초) 끼므로 절대 같은 ts 안 나옴.
    const userTs = new Date().toISOString();
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: {
        sessionId,
        ts: userTs,
        role: "user",
        content: message,
      },
    }));

    // 3) Bedrock Converse 호출
    //    history 뒤에 이번 user 메시지 추가
    const messages = [
      ...history,
      { role: "user", content: [{ text: message }] },
    ];

    const bedrockRes = await bedrock.send(new ConverseCommand({
      modelId: MODEL_ID,
      messages,
      inferenceConfig: {
        maxTokens: 1024,
        temperature: 0.7,
      },
    }));

    const reply = bedrockRes.output.message.content[0].text;
    const usage = bedrockRes.usage;

    // 4) assistant 응답 저장
    const assistantTs = new Date().toISOString();
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: {
        sessionId,
        ts: assistantTs,
        role: "assistant",
        content: reply,
        // 비용 분석용 — 나중에 Athena/S3 export 로 쿼리 가능
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      },
    }));

    return {
      ok: true,
      sessionId,
      reply,
      usage,
      historyCount: history.length,
    };
  } catch (err) {
    console.error("Handler error:", err);
    return { ok: false, error: err.message, stack: err.stack };
  }
};
