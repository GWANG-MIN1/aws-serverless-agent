// Day 14 Worker handler — Agent Loop(Day 13) + 단계별 IoT MQTT 실시간 publish.
//
// 입력 (event): { type: "run_chat", userId, sessionId, message, createdAtId }
//
// Day 13 까지: 루프의 각 단계는 MessagesTable 행으로만 남았다 → 진행을 보려면 폴링.
// Day 14: 그 행을 저장하는 그 순간, 같은 내용을 IoT Core MQTT 토픽으로도 publish.
//   토픽 = `${MQTT_TOPIC_PREFIX}/${sessionId}/events` (세션 1개 = 토픽 1개).
//   → 구독자(Day 15 브라우저)가 text/tool_call/tool_result 가 쌓이는 걸 실시간으로 본다.
//   변경점은 putRow 안에 publishEvent 한 줄 + 엔드포인트 조회 헬퍼가 전부 — 루프 골격은 Day 13 그대로.
//
// 원본 매핑 (packages/backend/src/):
//   agent-runtime/orchestrate.ts runChatTurn  → 아래 for(step) 루프
//   agent-runtime/tools.ts       executeCode  → EXECUTE_CODE_TOOL (Bedrock Converse toolConfig)
//   agent-runtime/code-executor  node:vm      → runSandbox()
//   lib/realtime-publish.ts      IoTDataPlaneClient + PublishCommand(qos 1)  → publishEvent()
//   lib/realtime-events.ts       entity_update(table/op/row) 이벤트 shape    → publishEvent 의 페이로드
//   원본은 Anthropic SDK + TypeChecker + skills + superjson + broker URL env. 우리는 Bedrock Converse +
//   JSON + DescribeEndpoint 런타임 조회로 간소화 — 외부 설정값 0개.
//
// 저장 정책: 루프의 각 단계를 MessagesTable 행으로 남긴다 (kind 로 구분).
//   kind:"text"        assistant 의 일반 텍스트
//   kind:"tool_call"   assistant 가 executeCode 를 부른 사실(설명 + 코드)
//   kind:"tool_result" 샌드박스 실행 결과(reads / error)
//   → GET /sessions/:id/messages 로 루프 전 과정을 그대로 들여다볼 수 있다.
//     Day 14 부터는 같은 단계가 MQTT 이벤트로도 실시간으로 흐른다.
//
// 단, 다음 턴에서 history 를 다시 읽을 땐 tool_call/tool_result 행은 건너뛴다(간소화).
//   턴을 가로질러서는 "최종 텍스트 결론"만 맥락으로 충분하고, toolUse↔toolResult 짝을
//   턴 경계 너머로 재구성하는 복잡도(Converse 의 짝 매칭 제약)를 피한다.

import { randomUUID } from "node:crypto";
import vm from "node:vm";

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
import { IoTClient, DescribeEndpointCommand } from "@aws-sdk/client-iot";
import { IoTDataPlaneClient, PublishCommand } from "@aws-sdk/client-iot-data-plane";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const bedrock = new BedrockRuntimeClient({});

const MESSAGES_TABLE = process.env.MESSAGES_TABLE;
const SESSIONS_TABLE = process.env.SESSIONS_TABLE;
const MODEL_ID = process.env.MODEL_ID;
const HISTORY_LIMIT = parseInt(process.env.HISTORY_LIMIT ?? "20", 10);
const MAX_TURN_STEPS = parseInt(process.env.MAX_TURN_STEPS ?? "5", 10);
const SANDBOX_TIMEOUT_MS = 5_000;
const MQTT_TOPIC_PREFIX = process.env.MQTT_TOPIC_PREFIX ?? "sessions";

const SYSTEM_PROMPT = [
  "You are Claude, an AI assistant created by Anthropic.",
  "When asked about yourself, identify as Claude made by Anthropic.",
  "",
  "You have ONE tool: `executeCode`, which runs JavaScript in a sandbox.",
  "Use it for ANY arithmetic, counting, sorting, date math, or data manipulation —",
  "do NOT compute those in your head; call the tool and use the real result.",
  "Inside the code, call `read(value)` to surface a value back to yourself.",
  "You only get back whatever you `read()` — nothing is printed implicitly.",
  "For pure conversation that needs no computation, just reply in text.",
].join("\n");

// created_at_id 합성 SK — Day 7/11/12 의 makeSk 그대로.
const makeCreatedAtId = () => `${new Date().toISOString()}#${randomUUID()}`;

// ────────────────────────────────────────────────────────────
// executeCode 도구 정의 — Bedrock Converse toolConfig 포맷.
//   원본 tools.ts 는 zod → JSONSchema 였지만, 우리는 JSONSchema 를 직접 박는다(간소화).
// ────────────────────────────────────────────────────────────
const EXECUTE_CODE_TOOL = {
  toolSpec: {
    name: "executeCode",
    description:
      "Execute JavaScript in a sandbox. Call read(value) to surface a value back so you can inspect it. " +
      "You only receive what you read(). Safe globals only (JSON/Date/Math/...); no network, no filesystem.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description:
              "A short, non-technical one-line label of what this code does, in the user's language.",
          },
          code: { type: "string", description: "JavaScript code to execute." },
        },
        required: ["code"],
      },
    },
  },
};

// ────────────────────────────────────────────────────────────
// runSandbox — node:vm 으로 LLM 이 생성한 코드를 격리 실행.
//   원본 code-executor.ts 의 축약판: TypeChecker/skills 없이 안전 글로벌 + read() 만.
//   ⚠️ vm 은 진짜 격리가 아님(동기 무한루프는 못 막음). 학습용 경계로만 사용.
// ────────────────────────────────────────────────────────────
async function runSandbox(code) {
  const reads = [];
  // read(): 값을 직렬화해 LLM 에게 돌려줄 버킷에 담는다. JSON 으로 깊은 복사 → 함수/순환참조 제거.
  function read(value) {
    reads.push(JSON.parse(JSON.stringify(value)));
  }

  const sandbox = {
    read,
    console,
    JSON, Date, Math,
    Array, Object, String, Number, Boolean,
    RegExp, Map, Set, Promise,
    parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent,
  };

  const ctx = vm.createContext(sandbox);

  try {
    const wrapped = `(async () => {\n${code}\n})()`;
    const script = new vm.Script(wrapped, { filename: "agent-code.js" });
    const promise = script.runInContext(ctx);

    // 비동기 코드는 vm 의 timeout 옵션이 못 막으므로 race 로 상한을 건다(원본과 동일 한계).
    await Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`sandbox timed out (${SANDBOX_TIMEOUT_MS}ms)`)), SANDBOX_TIMEOUT_MS),
      ),
    ]);

    return { type: "success", reads };
  } catch (err) {
    return { type: "failure", reads, error: err instanceof Error ? err.message : String(err) };
  }
}

// ────────────────────────────────────────────────────────────
// IoT MQTT publish — 원본 lib/realtime-publish.ts 축약판.
//   원본은 broker URL(env) 로 엔드포인트를 알지만, 우리는 계정/리전당 고정인
//   IoT Data 엔드포인트를 cold start 때 한 번 DescribeEndpoint 로 조회해 캐싱한다(외부 설정 0개).
//   QoS 1 = at-least-once. 페이로드는 superjson 대신 JSON.
// ────────────────────────────────────────────────────────────
let iotDataClientPromise;
function getIotDataClient() {
  if (!iotDataClientPromise) {
    iotDataClientPromise = (async () => {
      const iot = new IoTClient({});
      const { endpointAddress } = await iot.send(
        new DescribeEndpointCommand({ endpointType: "iot:Data-ATS" }),
      );
      return new IoTDataPlaneClient({ endpoint: `https://${endpointAddress}` });
    })();
  }
  return iotDataClientPromise;
}

const sessionTopic = (sessionId) => `${MQTT_TOPIC_PREFIX}/${sessionId}/events`;

// 한 이벤트를 세션 토픽으로 publish. 실시간 출력은 best-effort —
//   publish 가 실패해도 루프/DDB 저장은 계속 간다(영속 진실은 MessagesTable, MQTT 는 곁가지).
async function publishEvent(sessionId, event) {
  try {
    const client = await getIotDataClient();
    await client.send(new PublishCommand({
      topic: sessionTopic(sessionId),
      qos: 1,
      payload: Buffer.from(JSON.stringify(event)),
    }));
  } catch (e) {
    console.warn("Worker: MQTT publish skipped", { sessionId, name: e?.name, msg: e?.message });
  }
}

// MessagesTable 한 행 저장. undefined 필드는 제거(DDB marshalling 안전).
//   Day 14: 저장한 그 행을 그대로 MQTT 로도 흘린다(Day 13 이 깔아둔 "kind 로 단계 풀어 적기" 토대).
//   원본 realtime-events.ts 의 entity_update(table/op/row) 모양 그대로.
async function putRow(sessionId, fields) {
  const Item = { session_id: sessionId, created_at_id: makeCreatedAtId(), ...fields };
  for (const k of Object.keys(Item)) {
    if (Item[k] === undefined) delete Item[k];
  }
  await ddb.send(new PutCommand({ TableName: MESSAGES_TABLE, Item }));
  await publishEvent(sessionId, { type: "entity_update", table: "messages", op: "upsert", row: Item });
}

// 저장된 행 → Converse messages 로 복원.
//   - tool_call/tool_result 행은 건너뜀(턴 경계 너머엔 최종 텍스트만).
//   - 같은 role 이 연달아 나오면 한 메시지로 합침(Converse 의 user/assistant 교대 규칙 보호).
function rowsToConverseMessages(itemsAsc) {
  const messages = [];
  for (const item of itemsAsc) {
    if (item.kind === "tool_call" || item.kind === "tool_result") continue;
    const role = item.role === "assistant" ? "assistant" : "user";
    const block = { text: item.content ?? "" };
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      last.content.push(block);
    } else {
      messages.push({ role, content: [block] });
    }
  }
  return messages;
}

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

  // 1) 최근 N턴 이력 — MessagesTable Query (Day 12 패턴 그대로).
  const past = await ddb.send(new QueryCommand({
    TableName: MESSAGES_TABLE,
    KeyConditionExpression: "session_id = :sid",
    ExpressionAttributeValues: { ":sid": sessionId },
    Limit: HISTORY_LIMIT,
    ScanIndexForward: false,
  }));

  const itemsAsc = (past.Items ?? []).slice().reverse();
  const messages = rowsToConverseMessages(itemsAsc);

  if (messages.length === 0 || messages[0].role !== "user") {
    console.error("Worker: invalid history head (must start with user)", { sessionId });
    return { ok: false, reason: "invalid_history_head" };
  }

  // 2) Agent Loop — toolUse 가 없을 때(또는 MAX_TURN_STEPS)까지 LLM ↔ 샌드박스 왕복.
  let steps = 0;
  let toolRuns = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let finalText = "";

  for (let step = 0; step < MAX_TURN_STEPS; step += 1) {
    steps = step + 1;

    const res = await bedrock.send(new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: SYSTEM_PROMPT }],
      messages,
      toolConfig: { tools: [EXECUTE_CODE_TOOL] },
      inferenceConfig: { maxTokens: 1024, temperature: 0.7 },
    }));

    const content = res.output?.message?.content ?? [];
    totalInput += res.usage?.inputTokens ?? 0;
    totalOutput += res.usage?.outputTokens ?? 0;

    // 2a) assistant 가 뱉은 블록(text / toolUse)을 각각 한 행으로 저장.
    for (const block of content) {
      if (typeof block.text === "string") {
        finalText = block.text;
        await putRow(sessionId, {
          role: "assistant",
          kind: "text",
          content: block.text,
          inputTokens: res.usage?.inputTokens,
          outputTokens: res.usage?.outputTokens,
        });
      } else if (block.toolUse) {
        await putRow(sessionId, {
          role: "assistant",
          kind: "tool_call",
          content: block.toolUse.input?.description ?? "",
          code: block.toolUse.input?.code ?? "",
          toolUseId: block.toolUse.toolUseId,
        });
      }
    }

    // 2b) assistant 턴을 in-memory history 에 그대로 push (toolUse 포함 — 짝 매칭 필요).
    messages.push({ role: "assistant", content });

    // 2c) toolUse 가 없으면 종료.
    const toolUses = content.flatMap((b) => (b.toolUse ? [b.toolUse] : []));
    if (toolUses.length === 0) break;

    // 2d) 각 toolUse 코드를 샌드박스 실행 → toolResult 로 되먹임.
    const toolResults = [];
    for (const tu of toolUses) {
      toolRuns += 1;
      const result = await runSandbox(tu.input?.code ?? "");
      const payload = result.type === "success"
        ? { reads: result.reads }
        : { reads: result.reads, error: result.error };

      await putRow(sessionId, {
        role: "tool",
        kind: "tool_result",
        toolUseId: tu.toolUseId,
        ok: result.type === "success",
        content: JSON.stringify(payload),
      });

      toolResults.push({
        toolResult: {
          toolUseId: tu.toolUseId,
          content: [{ json: payload }],
          status: result.type === "success" ? "success" : "error",
        },
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  // 3) 세션 updatedAt bump (Day 12 그대로). userId 없으면 skip.
  if (userId) {
    try {
      await ddb.send(new UpdateCommand({
        TableName: SESSIONS_TABLE,
        Key: { user_id: userId, id: sessionId },
        UpdateExpression: "SET updatedAt = :now",
        ConditionExpression: "attribute_exists(user_id)",
        ExpressionAttributeValues: { ":now": new Date().toISOString() },
      }));
    } catch (e) {
      console.warn("Worker: session updatedAt bump skipped", { sessionId, name: e?.name });
    }
  }

  return {
    ok: true,
    sessionId,
    steps,
    toolRuns,
    finalChars: finalText.length,
    inputTokens: totalInput,
    outputTokens: totalOutput,
  };
};
