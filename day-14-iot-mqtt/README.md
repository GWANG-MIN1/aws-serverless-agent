# Day 14: IoT Core MQTT — 루프 단계를 실시간으로 push

Day 13 까지 Agent Loop 의 각 단계(`text`/`tool_call`/`tool_result`)는 `MessagesTable` 행으로만 남았다. 진행 상황을 보려면 `GET /sessions/:id/messages` 를 **폴링**해야 했다. Day 14 는 그 행을 저장하는 **바로 그 순간**, 같은 내용을 **IoT Core MQTT 토픽**으로도 publish 한다. 구독자(Day 15 의 브라우저)는 루프가 도는 걸 실시간으로 본다.

> **규칙: 매일 한 가지만 더하기.** Day 14 는 "Worker 가 단계마다 MQTT 로 push" 한 가지. Agent Loop·샌드박스·멀티 테이블·책임 분리 IAM 은 Day 13 것을 그대로 가져온다. 브라우저가 MQTT 를 직접 구독(SigV4 WSS)하는 건 Day 15 몫.

## 🎯 이 day 가 답하는 것

1. **Lambda 가 IoT Core 로 어떻게 메시지를 쏘나** — `IoTDataPlaneClient` + `PublishCommand`. 단, **엔드포인트를 직접 줘야** 한다(계정/리전마다 다른 IoT *Data* 엔드포인트). 그걸 `iot:DescribeEndpoint(iot:Data-ATS)` 로 cold start 때 한 번 조회해 캐싱한다.
2. **토픽을 어떻게 가르나** — `sessions/${sessionId}/events`. 세션 1개 = 토픽 1개, 이벤트의 `type` 으로 단계를 구분. 한 세션 화면만 구독하면 그 세션의 루프만 흘러온다.
3. **실시간 출력과 영속 저장의 관계** — 진실의 원본은 여전히 `MessagesTable`. MQTT 는 그 위에 얹은 "곁가지"라서 publish 가 실패해도 루프/저장은 그대로 간다(best-effort).
4. **최소 권한을 어떻게 거나** — Worker IAM 은 `iot:Publish` 를 **우리 토픽(`topic/sessions/*/events`)으로만** 허용. 다른 토픽으로는 못 쏜다.

## 🧩 원본과의 매핑

원본 `packages/backend/src/lib/` 의 realtime 3총사를 worker 안 작은 헬퍼로 합쳤다.

| 우리 (`worker.mjs`) | 원본 파일 | 원본이 하는 일 |
|---|---|---|
| `publishEvent()` | `realtime-publish.ts` | `IoTDataPlaneClient.send(PublishCommand{ qos:1 })` |
| `getIotDataClient()` | `mqtt.ts` `getBrokerHost/getRegion` | IoT Data 엔드포인트/리전 확보 |
| `{ type:"entity_update", table, op, row }` | `realtime-events.ts` `EntityUpdateEvent` | 테이블 행 변경을 토픽으로 broadcast |

**일부러 바꾼/들어낸 것**:

- **엔드포인트 조달**: 원본은 `AGENT_MQTT_BROKER_URL` env 를 주입받는다 → 우리는 `DescribeEndpoint` 로 **런타임 조회**(외부 설정값 0개). cold start 1회 control-plane 호출이 비용.
- **토픽 단위**: 원본은 `${ns}/users/${userId}/events` 의 **유저별** → 우리는 `sessions/${sessionId}/events` 의 **세션별**. Day 13 이 이미 세션 단위로 행을 쌓고, Day 15 화면도 세션 단위라 자연스럽다.
- **직렬화**: `superjson` → **`JSON`**. 의존성 하나 덜기(우리 페이로드엔 Date/BigInt 같은 특수타입 없음).
- **이벤트 종류**: `echo`/discriminated union 풀세트 → `entity_update` 한 종류로 시작(텍스트/도구호출/도구결과는 `row.kind` 로 이미 구분됨).

## 🔁 흐름 — 저장하는 그 줄에서 publish

```
 for step in 0..MAX_TURN_STEPS:        (Day 13 그대로)
   res = Converse(messages, toolConfig)
   각 block 마다:
     putRow(...)  ──┬─▶ DynamoDB PutItem        (영속 — 진실의 원본)
                    └─▶ MQTT Publish (qos 1)     (실시간 — 곁가지, best-effort)  ◀── Day 14 추가
        토픽: sessions/${sessionId}/events
        페이로드: { type:"entity_update", table:"messages", op:"upsert", row:{...저장한 행...} }
   toolUse 있으면 runSandbox → putRow(tool_result) → (역시 DDB + MQTT) → 루프 top
```

핵심: **`putRow` 가 DDB 저장 직후 같은 `Item` 을 그대로 MQTT 로 흘린다.** Day 13 README 가 약속한 "kind 로 한 테이블에 루프 단계 풀어 적기 → Day 14 에서 같은 단계를 MQTT 이벤트로도 흘릴 토대" 가 여기서 실현된다.

## 🛰️ `publishEvent` — IoT Data 엔드포인트 조회 + publish

```js
import { IoTClient, DescribeEndpointCommand } from "@aws-sdk/client-iot";
import { IoTDataPlaneClient, PublishCommand } from "@aws-sdk/client-iot-data-plane";

// 엔드포인트는 계정/리전당 고정 → cold start 때 한 번 조회해 캐싱.
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

async function publishEvent(sessionId, event) {
  try {
    const client = await getIotDataClient();
    await client.send(new PublishCommand({
      topic: `${MQTT_TOPIC_PREFIX}/${sessionId}/events`,  // sessions/<id>/events
      qos: 1,
      payload: Buffer.from(JSON.stringify(event)),
    }));
  } catch (e) {
    console.warn("Worker: MQTT publish skipped", { sessionId, name: e?.name });
  }
}
```

`DescribeEndpoint`(control plane, `@aws-sdk/client-iot`) 와 `Publish`(data plane, `@aws-sdk/client-iot-data-plane`)는 **서로 다른 SDK 패키지**다 — 둘 다 필요.

## 🪜 Day 13 → Day 14 diff

| 측면 | Day 13 | Day 14 |
|---|---|---|
| 루프 단계 출력 | DDB 행만 (폴링으로 조회) | DDB 행 + **MQTT publish** (실시간) |
| `putRow` | PutItem 1줄 | PutItem + **`publishEvent` 1줄** |
| Worker IAM | Bedrock + DDB(RW) | + **`iot:DescribeEndpoint`(\*) + `iot:Publish`(우리 토픽만)** |
| Worker SDK | bedrock/dynamodb/lib-dynamodb | + **client-iot / client-iot-data-plane** (둘 다 external) |
| Worker env | MODEL_ID/HISTORY_LIMIT/MAX_TURN_STEPS | + **`MQTT_TOPIC_PREFIX`** |
| Output | (테이블/함수명) | + **`MqttTopicPattern`** (구독용 힌트) |

**안 변한 것**: Agent Loop 골격, `runSandbox`, 테이블 3개, API↔Worker 분리, Worker timeout 5min, `MAX_TURN_STEPS`, Function URL(BUFFERED), 책임 분리 IAM. **API(`api.mjs`)는 `/health` day 숫자만** — Day 14 변화는 전부 Worker 안 일이다.

## 📦 이벤트 페이로드 형태

토픽 `sessions/${sessionId}/events` 로 흐르는 각 메시지(= 저장된 한 행):

```jsonc
{ "type": "entity_update", "table": "messages", "op": "upsert",
  "row": {
    "session_id": "...", "created_at_id": "2026-...#uuid",
    "role": "assistant", "kind": "tool_call",     // text / tool_call / tool_result
    "content": "48571 × 92834 계산", "code": "...read(r)", "toolUseId": "..."
  } }
```

구독자는 `row.kind` 로 텍스트/도구호출/도구결과를 가르고, `created_at_id` 로 순서를 맞춘다 — `GET /messages` 가 내려주던 것과 **동일한 모양**이라 렌더 코드를 공유할 수 있다.

## 🏗️ 아키텍처

```
[curl] ── POST /chat ──▶ ApiFunction ── invoke(Event) ──▶ WorkerFunction (Agent Loop)
                                                              │  각 step:
                          MessagesTable ◀── PutItem ──────────┤  putRow()
                                                              │     │
                          IoT Core  ◀── Publish(qos1) ────────┘     │ topic: sessions/${id}/events
                              │                                     ▼
                              └──▶ (Day 15) 브라우저가 WSS 로 직접 subscribe
```

## 🚀 배포 + 검증 절차

### 1) 배포

```powershell
cd day-14-iot-mqtt
npm install
npx cdk synth            # 합성 에러 먼저 거르기
npm run deploy
# Outputs: ApiUrl, WorkerFunctionName, MqttTopicPattern 메모
```

### 2) 유저 / 세션 생성 (Day 12~13 동일)

```powershell
$URL = "<ApiUrl>"
$U  = curl.exe -s -X POST "$URL/users" -H "content-type: application/json" -d '{\"name\":\"gwangmin\"}' | ConvertFrom-Json
$UID = $U.id
$S  = curl.exe -s -X POST "$URL/users/$UID/sessions" -H "content-type: application/json" -d '{\"title\":\"mqtt\"}' | ConvertFrom-Json
$SID = $S.sessionId
$SID   # ← 이 값을 토픽에 넣는다
```

### 3) AWS Console 에서 MQTT 구독 (브라우저 구독은 Day 15, 여기선 콘솔 테스트 클라이언트로 검증)

1. **AWS Console → IoT Core → MQTT test client** (배포 리전과 **같은 리전**인지 확인).
2. **Subscribe to a topic** 에 `sessions/+/events` (모든 세션) 또는 `sessions/<$SID>/events` 입력 → Subscribe.

### 4) 도구를 *쓸 수밖에 없는* 질문 → 단계가 실시간으로 흘러온다

```powershell
$enc = [System.Text.UTF8Encoding]::new($false)
[System.IO.Directory]::SetCurrentDirectory((Get-Location).Path)
function Send-Chat($msg) {
  $p = @{ userId=$UID; sessionId=$SID; message=$msg } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllBytes("payload.json", $enc.GetBytes($p))
  curl.exe -s -i -X POST "$URL/chat" -H "content-type: application/json" --data-binary "@payload.json"
}

Send-Chat "48571 곱하기 92834 가 정확히 얼마야? 도구로 계산해줘."   # → HTTP 202
```

기대 — MQTT test client 에 **순서대로** 이벤트가 도착(폴링 없이):

```
entity_update row.kind:"tool_call"   row.code:"... 48571 * 92834 ... read(r)"
entity_update row.kind:"tool_result" row.role:"tool"  (reads:[4509040214])
entity_update row.kind:"text"        row.content:"4509040214 입니다"
```

→ **`/chat` 응답(202)이 떨어진 직후, GET 폴링 없이도 콘솔에 단계가 차례로 뜨면** Worker 가 실시간 push 에 성공한 것. (`GET /sessions/$SID/messages` 로 조회한 결과와 내용이 일치하는지 교차 확인)

### 5) 정리

```powershell
npx cdk destroy --force
```

## ⚠️ 함정 / 트러블슈팅 (Day 14 발견분)

| # | 함정 | 원인 | 회피 |
|---|---|---|---|
| 27 | `PublishCommand` 가 endpoint 에러 / 아무 데도 안 감 | `IoTDataPlaneClient` 를 endpoint 없이 만들면 기본값이 안 맞음. publish 는 계정별 **IoT Data 엔드포인트**로 가야 함 | `DescribeEndpoint({ endpointType:"iot:Data-ATS" })` 결과를 `endpoint:` 로 지정 |
| 28 | `iot:Publish` AccessDenied | IAM 리소스 ARN 이 토픽과 안 맞음. publish 는 `topic/...`, subscribe 는 `topicfilter/...` (다름) | ARN `topic/sessions/*/events` + 코드 `MQTT_TOPIC_PREFIX` 를 **같은 값**으로 |
| 29 | `Cannot find package @aws-sdk/client-iot...` | DescribeEndpoint(control plane)와 Publish(data plane)는 **다른 패키지** | `@aws-sdk/client-iot` **와** `@aws-sdk/client-iot-data-plane` 둘 다 추가(번들 external) |
| 30 | MQTT test client 에 안 뜸 | 콘솔 리전이 배포 리전과 다름 / 토픽 오타 / 와일드카드 안 씀 | 같은 리전, `sessions/+/events` 로 와일드카드 구독 후 정확 토픽으로 좁히기 |
| 31 | publish 실패가 턴 전체를 죽임 | publish 에러를 그냥 throw 하면 루프 중단 | `publishEvent` 를 try/catch best-effort 로 — 진실은 DDB, MQTT 는 곁가지 |

> 함정 1~20 은 Phase 2 회고 / Day 11~12 README, 21~26 은 Day 13 README. Day 14 부터 27~ 누적.

## 🧠 남긴 숙제 → 다음 day 들로

| 숙제 | 어디서 |
|---|---|
| 브라우저가 이 토픽을 직접 구독 (mqtt.js v5 + SigV4 쿼리스트링 WSS 서명) | Day 15 |
| user 메시지(API 가 쓰는 행)도 publish — 지금은 Worker 단계만 흐름 | Day 15(+) |
| 턴 종료 신호 이벤트(`type:"turn_done"`) — 구독자가 "끝"을 명시적으로 알게 | 옵션 |
| 엔드포인트 조회를 SSM 캐싱으로 (Day 16 의 정공법과 동일 패턴) | 옵션 |

## 🎁 Day 14 가 남긴 자산

- **Lambda → IoT Core publish 패턴** — `DescribeEndpoint`(Data-ATS) → `IoTDataPlaneClient(endpoint)` → `PublishCommand(qos)`
- **"저장 = publish" 한 줄** — DDB 행과 MQTT 페이로드가 같은 모양이라 조회/구독 렌더 코드를 공유
- **세션별 토픽 + 최소 권한 IAM** — Day 15 브라우저가 `sessions/${id}/events` 만 구독하면 되는 토대
