# Day 13: Agent Loop + `executeCode` 단일 도구

Day 12 까지 Worker 는 Bedrock 을 **딱 한 번** 부르고 끝났다 (`history → Converse 1회 → assistant Put`). Day 13 은 그 한 번을 **루프**로 키운다. LLM 이 도구(`executeCode`)를 쓰겠다고 하면, 코드를 샌드박스에서 실행하고 그 결과를 다시 LLM 에게 먹인 뒤 한 번 더 부른다 — 도구를 더 안 쓸 때까지. 이게 "에이전트"의 최소 형태다.

> **규칙: 매일 한 가지만 더하기.** Day 13 은 "Agent Loop + 단일 도구" 한 가지. 멀티 테이블·API↔Worker 분리·책임 분리 IAM 은 Day 11/12 것을 그대로 가져온다. MQTT 실시간 출력(Day 14), skills(후속)은 다음 몫.

## 🎯 이 day 가 답하는 것

1. **"LLM 이 도구를 쓴다"는 게 실제로 무슨 흐름인가** — Bedrock Converse 의 `stopReason: "tool_use"` → `toolUse` 블록 → 우리가 코드를 실행 → `toolResult` 블록을 되먹임 → 다시 Converse. 이 왕복이 곧 agent loop.
2. **도구를 왜 코드 실행 하나로 두나** — 산술·정렬·날짜계산·데이터 가공을 LLM "머리"로 시키면 틀린다. `executeCode` 하나만 줘도 그 안에서 무엇이든 계산해 **진짜 값**을 `read()` 로 돌려받는다. (원본이 택한 single-tool 설계 — 도구를 N개 늘리는 대신 "코드 실행" 한 개로 일반화.)
3. **무한루프를 어떻게 막나** — LLM 이 계속 도구만 부를 수 있으니 `MAX_TURN_STEPS` 로 컷. 샌드박스 자체도 `SANDBOX_TIMEOUT_MS` 상한.
4. **루프의 중간 단계를 어떻게 남기나** — 각 step(텍스트 / 도구호출 / 도구결과)을 `MessagesTable` 행으로 저장(`kind` 로 구분)해서 `GET .../messages` 로 전 과정을 들여다본다.

## 🧩 원본과의 매핑

원본 `packages/backend/src/agent-runtime/` 의 세 파일을 한 `worker.mjs` 로 합치고, Anthropic SDK → **Bedrock Converse** 로 옮겼다.

| 우리 (`worker.mjs`) | 원본 파일 | 원본이 하는 일 |
|---|---|---|
| `for (step…)` 루프 | `orchestrate.ts` `runChatTurn` | LLM ↔ tool 왕복, 각 블록을 행으로 persist |
| `EXECUTE_CODE_TOOL` | `tools.ts` `executeCodeTool` | 단일 도구 정의(이름/설명/입력 스키마) |
| `runSandbox()` | `code-executor.ts` `CodeExecutor` | `node:vm` 격리 실행 + `read()` |

**일부러 들어낸 것 (= "간소화 sandbox")**:

- **TypeChecker** (원본은 sandbox 코드를 TS 컴파일러로 타입체크 후 실행) → 제거. 우리는 JS 를 그대로 vm 에 넣는다. 루프 흐름 학습이 목적이라 타입 게이트는 과함.
- **skills** (원본은 `memory`/`webSearch`/`google-calendar` 를 sandbox 에 주입) → 제거. Day 13 샌드박스 글로벌은 안전 내장(JSON/Date/Math/…)뿐. skill 주입은 후속 day 몫.
- **zod → JSONSchema** → JSONSchema 를 직접 박음. 의존성 하나 덜기.

## 🔁 Agent Loop 흐름

```
                  ┌──────────────────────────────────────────────┐
 history (Query)  │  for step in 0..MAX_TURN_STEPS:              │
   ──────────────▶│    res = Converse(messages, toolConfig)      │
                  │    persist each block (text / tool_call)     │
                  │    messages.push(assistant turn)             │
                  │                                              │
                  │    toolUse 있나? ──no──▶ break (최종 텍스트)  │
                  │        │ yes                                 │
                  │        ▼                                     │
                  │    runSandbox(code) → reads / error          │
                  │    persist tool_result                       │
                  │    messages.push(user: toolResult)  ─────────┘ (루프 top 으로)
                  └──────────────────────────────────────────────┘
```

핵심: **assistant 의 `toolUse` 블록과, 그 다음 user 메시지의 `toolResult` 블록은 `toolUseId` 로 짝이 맞아야** Converse 가 받아준다. in-memory `messages` 에는 짝을 그대로 push 하고, `MessagesTable` 에는 단계별로 풀어서 저장한다.

## 🛠️ `executeCode` — 단일 도구

Bedrock Converse `toolConfig` 포맷으로 정의:

```js
const EXECUTE_CODE_TOOL = {
  toolSpec: {
    name: "executeCode",
    description: "Execute JavaScript in a sandbox. Call read(value) to surface a value back…",
    inputSchema: { json: {
      type: "object",
      properties: {
        description: { type: "string", … },  // 유저 언어로 된 한 줄 라벨
        code:        { type: "string", … },  // 실행할 JS
      },
      required: ["code"],
    } },
  },
};
```

샌드박스(`runSandbox`)는 `node:vm` 으로 코드를 격리 실행하고, 코드가 부른 `read(value)` 값만 모아서 돌려준다. LLM 은 **`read()` 한 것 외에는 아무것도 못 본다** (console.log 는 사라짐) — 그래서 시스템 프롬프트가 "결과는 반드시 `read()` 해라"라고 못박는다.

```js
function read(value) { reads.push(JSON.parse(JSON.stringify(value))); }
const sandbox = { read, console, JSON, Date, Math, Array, Object, String,
                  Number, Boolean, RegExp, Map, Set, Promise, parseInt, … };
// 네트워크/파일시스템 글로벌은 안 줌 — 순수 계산용.
```

## 🪜 Day 12 → Day 13 diff

| 측면 | Day 12 | Day 13 |
|---|---|---|
| Worker 의 Bedrock 호출 | **1회** Converse | **루프** (toolUse 없을 때까지, ≤ `MAX_TURN_STEPS`) |
| 도구 | 없음 | **`executeCode` 1개** (`toolConfig`) |
| 코드 실행 | 없음 | **`node:vm` 샌드박스** + `read()` |
| 저장 행 종류 | user / assistant(text) | + `kind:"tool_call"` / `kind:"tool_result"` |
| 다음 턴 history 복원 | 모든 행 | tool 행은 **건너뜀**(최종 텍스트만), 같은 role 병합 |
| Worker timeout | 60s | **300s (5min)** — 루프가 여러 번 왕복 |
| 무한루프 컷 | — | **`MAX_TURN_STEPS`** env + 샌드박스 timeout |
| `GET .../messages` | role/content/tokens | + `kind`/`code`/`toolUseId`/`ok` |

**안 변한 것**: 테이블 3개, API↔Worker 분리, `workerAlias.grantInvoke(api)`, Function URL(BUFFERED), 세션 `updatedAt` bump, 책임 분리 IAM(API 는 Bedrock 모름 / Worker 는 lambda invoke 못 함). **API(`api.mjs`)는 거의 그대로** — Day 13 변화는 전부 Worker 안 일이다.

## 🗃️ 저장 정책 — `kind` 로 루프를 풀어 적기

`MessagesTable`(PK `session_id`, SK `created_at_id`) 한 테이블에 `kind` 를 붙여 단계를 구분한다.

| `kind` | role | 추가 필드 | 의미 |
|---|---|---|---|
| `text` | assistant | `inputTokens`/`outputTokens` | 모델의 일반 텍스트 |
| `tool_call` | assistant | `code`, `toolUseId` | `executeCode` 호출 사실(설명 + 코드) |
| `tool_result` | tool | `toolUseId`, `ok` | 샌드박스 결과(`content` = `{reads}` or `{reads,error}` JSON) |

**턴 경계 너머 간소화**: 다음 `/chat` 에서 history 를 다시 읽을 땐 `tool_call`/`tool_result` 행을 **건너뛴다**. 턴을 가로질러선 "최종 텍스트 결론"만 맥락으로 충분하고, `toolUse↔toolResult` 짝을 턴 경계 너머로 재구성하는 복잡도(Converse 의 짝 매칭 제약)를 피하기 위함. 한 턴 *안*에서는 in-memory `messages` 에 짝을 그대로 들고 돈다.

## 🏗️ 아키텍처

```
[curl] ── POST /chat {userId,sessionId,message} ──▶ ┌──────────────────┐
                                                    │  ApiFunction     │ user msg Put → Worker invoke(Event) → 202
                                                    └──────────────────┘
                                                             │ async
                                                             ▼
                            ┌───────────────────────────────────────────────┐
                            │  WorkerFunction  (Agent Loop, timeout 5min)    │
                            │  Query history ──▶ ┌─────────────────────────┐ │
                            │                    │ Converse(toolConfig)    │ │
   MessagesTable ◀──────────┼─ persist ─────────│   ↕ toolUse / toolResult │ │
   (text/tool_call/         │  step rows         │ runSandbox(node:vm)     │ │
    tool_result)            │                    └─────────────────────────┘ │
   SessionsTable ◀──────────┼─ updatedAt bump                                │
                            └───────────────────────────────────────────────┘
```

## 🚀 배포 + 검증 절차

### 1) 배포

```powershell
cd day-13-agent-loop
npm install
npx cdk synth        # 합성 에러 먼저 거르기
npm run deploy
# Outputs: ApiUrl, MessagesTableName, WorkerFunctionName 메모
```

### 2) 유저 / 세션 생성 (Day 12 와 동일)

```powershell
$URL = "<ApiUrl>"
$U  = curl.exe -s -X POST "$URL/users" -H "content-type: application/json" -d '{\"name\":\"gwangmin\"}' | ConvertFrom-Json
$UID = $U.id
$S  = curl.exe -s -X POST "$URL/users/$UID/sessions" -H "content-type: application/json" -d '{\"title\":\"agent\"}' | ConvertFrom-Json
$SID = $S.sessionId
```

### 3) 도구를 *쓸 수밖에 없는* 질문 → Agent Loop 발화

```powershell
$enc = [System.Text.UTF8Encoding]::new($false)
[System.IO.Directory]::SetCurrentDirectory((Get-Location).Path)
function Send-Chat($msg) {
  $p = @{ userId=$UID; sessionId=$SID; message=$msg } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllBytes("payload.json", $enc.GetBytes($p))
  curl.exe -s -i -X POST "$URL/chat" -H "content-type: application/json" --data-binary "@payload.json"
}

# 머리로 풀면 거의 틀리는 큰 곱셈 → 모델이 executeCode 를 부르게 유도
Send-Chat "48571 곱하기 92834 가 정확히 얼마야? 도구로 계산해줘."   # → HTTP 202
Start-Sleep -Seconds 12

curl.exe -s "$URL/sessions/$SID/messages?limit=20"
```

기대 결과 — `messages` 안에 루프 단계가 순서대로:

```
kind:"tool_call"   code:"... 48571 * 92834 ... read(r)"   ← 모델이 코드를 부름
kind:"tool_result" ok:true  content:{"reads":[4509040214]} ← 샌드박스 실행 결과
kind:"text"        content:"4509040214 입니다"             ← 결과를 받아 최종 답
```

→ **`4509040214` 가 `tool_result` 에서 나오고 최종 텍스트에 그대로 박혀 있으면**, LLM 이 추측이 아니라 실제 실행 결과로 답한 것. (`48571 * 92834 = 4509040214`)

### 4) 멀티턴에서 도구 없이 이어지는지 (간소화 확인)

```powershell
Send-Chat "방금 그 숫자에서 1000 빼면?"   # → 이전 결과(4509040214)를 맥락으로 받아 다시 도구 호출
Start-Sleep -Seconds 12
curl.exe -s "$URL/sessions/$SID/messages?limit=20"
# 기대: 직전 턴의 최종 text(4509040214)가 history 로 들어가 4509039214 를 도출
```

### 5) 정리

```powershell
npx cdk destroy --force
```

## ⚠️ 함정 / 트러블슈팅 (Day 13 발견분)

| # | 함정 | 원인 | 회피 |
|---|---|---|---|
| 21 | `toolResult` 를 넣었더니 Converse 가 ValidationException | `toolUse` 블록과 다음 `toolResult` 의 `toolUseId` 가 안 맞음 / 짝이 빠짐 | assistant 턴(`res.output.message`)을 **통째로** push 하고, 같은 `toolUseId` 로 `toolResult` 를 짝지어 바로 다음 user 메시지에 넣기 |
| 22 | 다음 턴에서 history 로드 시 Converse 가 교대 규칙 위반 | tool 행을 빼니 assistant text 가 연달아 2개 | `rowsToConverseMessages` 가 같은 role 연속 시 **한 메시지로 병합** (text 블록 여러 개) |
| 23 | `read()` 안 했더니 LLM 이 결과를 못 봄 | 샌드박스는 `read()` 한 값만 반환(`console.log` 는 버려짐) | 시스템 프롬프트에 "결과는 반드시 `read()` 하라" 명시 + 도구 설명에도 |
| 24 | DDB Put 이 `undefined` 필드로 실패 | `code`/`toolUseId` 등은 행 종류마다 있/없음이 갈림 | `putRow` 가 `undefined` 키를 **저장 전 제거** |
| 25 | 루프가 안 끝남(토큰만 태움) | LLM 이 계속 `toolUse` 만 뱉을 수 있음 | `MAX_TURN_STEPS`(=5) 컷 + 샌드박스 `SANDBOX_TIMEOUT_MS`(=5s) |
| 26 | 60s timeout 에 루프가 걸림 | Day 12 timeout 그대로면 여러 번 왕복 못 함 | Worker timeout **60s → 300s(5min)** |

> ⚠️ **`node:vm` 은 진짜 격리가 아니다.** `while(true){}` 같은 동기 무한루프는 `Promise.race` 로도 못 막는다(이벤트 루프 자체가 멈춤). 원본도 같은 한계 — 진짜 격리는 worker_threads/isolate 가 필요. 학습용 경계로만 쓴다.
>
> 함정 1~20 은 Phase 2 회고 / Day 11~12 README. Day 13 부터 21~ 누적.

## 🧠 남긴 숙제 → 다음 day 들로

| 숙제 | 어디서 |
|---|---|
| Worker 출력(루프 단계)이 폴링으로만 보임 → IoT MQTT `sessions/${id}/events` publish 로 실시간 push | Day 14 |
| 브라우저가 MQTT 를 직접 구독 (mqtt.js + SigV4 WSS) | Day 15 |
| 샌드박스에 skill 주입(memory/webSearch) — 도구가 "계산"을 넘어 "행동"으로 | 후속 |
| sandbox TypeChecker 복원(원본처럼 TS 타입게이트) | 옵션 |

## 🎁 Day 13 이 남긴 자산

- **Bedrock Converse 의 toolUse/toolResult 왕복 패턴** — 도구를 N개로 늘려도 루프 골격은 동일
- **단일 `executeCode` 도구 + `node:vm` 샌드박스** — 도구를 늘리는 대신 "코드 실행"으로 일반화하는 설계
- **`kind` 로 한 테이블에 루프 단계 풀어 적기** — Day 14 에서 같은 단계를 MQTT 이벤트로도 흘릴 토대
