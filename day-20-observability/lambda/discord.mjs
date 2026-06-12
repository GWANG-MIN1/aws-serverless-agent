// Day 18 Discord interactions endpoint — 원본 Telegram 채널 자리를 Discord 로.
//
// Discord 는 슬래시 명령(`/ask message:...`)을 이 Function URL 로 HTTP POST 한다(Interactions 웹훅).
// 우리가 할 일:
//   1) Ed25519 서명검증 — 모든 요청은 X-Signature-Ed25519 / X-Signature-Timestamp + raw body 로 검증.
//      (Discord 가 엔드포인트 등록 시에도 잘못된 서명으로 한 번 찔러봄 → 반드시 통과/거부 정확해야 함.)
//   2) type 1 (PING) → type 1 (PONG). 엔드포인트 유효성 확인용.
//   3) type 2 (APPLICATION_COMMAND) → 3초 안에 응답해야 하는데 Agent Loop 는 더 걸린다.
//      → type 5 (DEFERRED) 로 "생각 중…"을 먼저 반환하고, Worker 를 async 호출.
//        Worker 가 끝나면 그 interaction 의 followup webhook 을 PATCH 해서 최종 답을 채운다.
//
// 책임 분리: 이 람다는 Bedrock 을 모른다(Agent Loop 는 Worker 일). api.mjs 의 /chat 과 같은 역할 —
//   유저/세션 보장 + user 메시지 저장 + Worker invoke. 다른 점은 "Discord 로 돌려보내라"는 표식뿐.
//
// 서명검증은 의존성 0 — node:crypto 로 ed25519 raw 공개키를 SPKI DER 로 감싸 verify.

import crypto from "node:crypto";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand, InvocationType } from "@aws-sdk/client-lambda";
import { randomUUID } from "node:crypto";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambdaClient = new LambdaClient({});

const USERS_TABLE = process.env.USERS_TABLE;
const SESSIONS_TABLE = process.env.SESSIONS_TABLE;
const MESSAGES_TABLE = process.env.MESSAGES_TABLE;
const WORKER_FN = process.env.AGENT_WORKER_FUNCTION_NAME;
const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;

// ed25519 raw(32B) → SPKI DER 로 만들 고정 접두어. node:crypto 가 raw 키를 직접 못 받아서 감싼다.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function verifySignature(rawBody, signatureHex, timestamp) {
  if (!DISCORD_PUBLIC_KEY || !signatureHex || !timestamp) return false;
  try {
    const der = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(DISCORD_PUBLIC_KEY, "hex")]);
    const key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(timestamp + rawBody), key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

const json = (obj, statusCode = 200) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(obj),
});

const makeCreatedAtId = () => `${new Date().toISOString()}#${randomUUID()}`;

// Discord 유저/채널을 우리 스키마에 매핑: 유저 = discord-<userId>, 세션 = discord-<channelId>(채널=대화).
async function ensureUserAndSession(userId, sessionId, label) {
  const now = new Date().toISOString();
  await ddb.send(new PutCommand({
    TableName: USERS_TABLE,
    Item: { id: userId, name: label ?? "discord", createdAt: now },
  }));
  await ddb.send(new PutCommand({
    TableName: SESSIONS_TABLE,
    Item: { user_id: userId, id: sessionId, title: "discord", updatedAt: now },
    // createdAt 은 처음에만 — 매 메시지마다 덮어쓰지 않도록 조건부.
    ConditionExpression: "attribute_not_exists(id)",
  })).catch((e) => {
    if (e?.name !== "ConditionalCheckFailedException") throw e; // 이미 있으면 무시.
  });
}

export const handler = async (event) => {
  const headers = event.headers ?? {};
  const sig = headers["x-signature-ed25519"];
  const ts = headers["x-signature-timestamp"];
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : (event.body ?? "");

  // 1) 서명검증 — 실패 시 401 (Discord 가 요구하는 규약).
  if (!verifySignature(raw, sig, ts)) {
    return { statusCode: 401, body: "invalid request signature" };
  }

  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }

  // 2) PING → PONG.
  if (body.type === 1) return json({ type: 1 });

  // 3) 슬래시 명령.
  if (body.type === 2) {
    const message = (body.data?.options ?? []).find((o) => o.name === "message")?.value ?? "";
    const discordUser = body.member?.user ?? body.user ?? {};
    const discordUserId = discordUser.id ?? "anon";
    const channelId = body.channel_id ?? discordUserId;

    const userId = `discord-${discordUserId}`;
    const sessionId = `discord-${channelId}`;

    if (!message) {
      // 즉시 텍스트 응답(type 4) — 빈 입력.
      return json({ type: 4, data: { content: "메시지를 입력해줘. 예) /ask message: 안녕" } });
    }

    // api.mjs /chat 과 동일: 유저/세션 보장 + user 메시지 저장 + Worker async 호출.
    await ensureUserAndSession(userId, sessionId, discordUser.username);
    await ddb.send(new PutCommand({
      TableName: MESSAGES_TABLE,
      Item: { session_id: sessionId, created_at_id: makeCreatedAtId(), role: "user", content: message },
    }));
    await lambdaClient.send(new InvokeCommand({
      FunctionName: WORKER_FN,
      InvocationType: InvocationType.Event,
      Payload: Buffer.from(JSON.stringify({
        type: "run_chat",
        userId,
        sessionId,
        message,
        // ★ Worker 가 끝나면 이 interaction 으로 답을 돌려보내라는 표식.
        channel: "discord",
        interactionToken: body.token,
        applicationId: body.application_id,
      })),
    }));

    // 3초 제한 회피 — "생각 중…"을 먼저(type 5 DEFERRED). 실제 답은 Worker 가 PATCH 로 채운다.
    return json({ type: 5 });
  }

  return json({ type: 4, data: { content: "unsupported interaction" } });
};
