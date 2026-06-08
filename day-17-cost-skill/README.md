# Day 17: `awsCost` skill — 에이전트가 진짜 AWS 비용을 조회

Day 13 에서 `executeCode` 샌드박스를 만들 때 원본의 **skill 주입**(원본은 `memory`/`webSearch`/`google-calendar` 를 샌드박스 글로벌로 넣음)을 일부러 들어냈었다. Day 17 은 그걸 되살린다 — 단, 우리만의 첫 skill 로 **`awsCost()`** 를 넣는다. 샌드박스 안에서 모델이 `await awsCost(...)` 를 부르면 **Cost Explorer 를 실제로 호출**해 이 계정의 비용을 돌려준다. 도구가 "계산"을 넘어 "행동(외부 조회)"으로 넘어가는 첫 발.

> **규칙: 매일 한 가지만 더하기.** Day 17 은 "샌드박스에 awsCost skill 주입" 한 가지. 엣지/호스팅(Day 16)·IoT(Day 14)·realtime(Day 15)·테이블은 그대로. 변화는 거의 전부 `worker.mjs` 안이다.

## 🎯 이 day 가 답하는 것

1. **skill 이 도구와 어떻게 다른가** — 도구(`executeCode`)는 모델이 Converse `toolUse` 로 부른다. skill 은 그 도구 **안쪽**(샌드박스)에서 코드가 부르는 함수다. 모델은 코드를 쓰고, 코드가 `awsCost()` 를 호출한다 → 도구 1개로 임의의 행동을 조합.
2. **샌드박스에 네트워크를 어떻게 안전하게 여나** — 임의 네트워크는 여전히 막혀 있고, **딱 그 skill 함수 하나**만 주입한다. 모델은 `awsCost` 로 Cost Explorer 만 부를 수 있을 뿐, 다른 AWS 호출은 못 한다(함수가 클로저로 감싸 노출).
3. **호출 흔적을 어떻게 남기나** — `skillCalls`(이름/인자/성공여부/소요시간)를 기록해 `tool_result` 행·MQTT 에 실어 보낸다. **단 LLM 에는 안 보낸다**(원본도 skillCalls 는 UI 전용) — 토큰 낭비·혼선 방지.

## 🧩 원본과의 매핑

| 우리 (`worker.mjs`) | 원본 | 하는 일 |
|---|---|---|
| `runSandbox` 의 `sandbox.awsCost` 주입 | `agent-runtime/code-executor.ts` 의 skill 주입 | 샌드박스 글로벌에 skill 함수 넣기 |
| `getAwsCost()` (Cost Explorer 래퍼) | `skills/*`(memory/webSearch 등) | skill 본체 |
| `skillCalls[]` → `tool_result.content` | `realtime-events.ts` `AssistantMessageContent.skillCalls` | UI 추적용 호출 기록 |

**다른 점**: 원본 skill 은 memory/검색/캘린더. 우리는 **AWS 비용**(자기참조적 — "이 프로젝트가 돈을 얼마 쓰는지 에이전트가 안다"). zod 스키마 없이 JS 함수로 직접 주입.

## 🛠️ `awsCost` skill

```js
// 샌드박스 밖(모듈 스코프)에 실제 구현 — Cost Explorer 호출.
const ce = new CostExplorerClient({ region: "us-east-1" }); // CE 엔드포인트는 us-east-1 단일
async function getAwsCost({ start, end, granularity = "MONTHLY", metric = "UnblendedCost", groupByService = false } = {}) {
  // start/end 미지정 → 이번 달 1일 ~ 내일(exclusive)
  const input = { TimePeriod: { Start: start, End: end }, Granularity: granularity, Metrics: [metric] };
  if (groupByService) input.GroupBy = [{ Type: "DIMENSION", Key: "SERVICE" }];
  const out = await ce.send(new GetCostAndUsageCommand(input));
  return out.ResultsByTime.map((r) => ({ start, end, total: r.Total?.[metric]?.Amount, unit: ..., byService: [...] }));
}

// runSandbox 안: skill 을 래핑해 호출 흔적을 남기고 샌드박스 글로벌에 주입.
async function awsCost(args = {}) {
  const t0 = Date.now();
  try { const r = await getAwsCost(args); skillCalls.push({ name:"awsCost", input:args, ok:true, ms:Date.now()-t0 }); return r; }
  catch (e) { skillCalls.push({ name:"awsCost", input:args, ok:false, error:e?.message }); throw e; }
}
const sandbox = { read, awsCost, JSON, Date, Math, /* ... 안전 글로벌 ... */ };
```

시스템 프롬프트에 "AWS 비용 질문엔 `awsCost()` 를 부르고 `read()` 해라 — 절대 추측하지 마라" 를 명시.

## 🔁 한 턴 흐름 (비용 질문)

```
user: "이번 달 AWS 비용 얼마야? 서비스별로도."
  └▶ Converse → toolUse(executeCode, code: "const c = await awsCost({groupByService:true}); read(c);")
       └▶ runSandbox: awsCost() → Cost Explorer GetCostAndUsage → reads=[{total, byService:[...]}]
                       skillCalls=[{name:"awsCost", ok:true, ms:~900}]
       └▶ toolResult(reads) → Converse → text: "이번 달 $3.12, 상위는 CloudFront $1.40, …"
```

## 🪜 Day 16 → Day 17 diff

| 측면 | Day 16 | Day 17 |
|---|---|---|
| 샌드박스 글로벌 | read + 안전 글로벌 | + **`awsCost` skill** |
| 외부 호출 | 없음(순수 계산) | **Cost Explorer**(그 skill 한정) |
| 샌드박스 timeout | 5s | **10s** (네트워크 여유) |
| Worker IAM | bedrock + iot | + **`ce:GetCostAndUsage`** |
| Worker 번들 | …+iot | + **client-cost-explorer**(external) |
| `tool_result` 기록 | reads/error | + **`skillCalls`**(LLM 엔 비공개) |

**안 변한 것**: Agent Loop 골격, MQTT publish, 엣지/호스팅, 테이블, API. (api.mjs 는 `/health` day 만.)

## 🚀 배포 + 검증 절차

### 0) 사전: Cost Explorer 활성화 확인

계정에서 **Cost Explorer 를 한 번도 안 열었다면** 먼저 AWS Console → **Billing → Cost Explorer** 를 한 번 열어 활성화한다(데이터 채워지는 데 최대 24h). 안 그러면 `awsCost` 가 `DataUnavailable` 로 실패.

### 1) 배포 (Day 16 처럼 CloudFront+Edge 라 5~15분)

```powershell
cd day-17-cost-skill
npm install ; npx cdk synth ; npm run deploy
# Outputs: SiteUrl, ApiUrl
```

### 2) 비용 질문 한 방 (curl, same-origin /api)

```powershell
$SITE = "<SiteUrl>"
$U  = curl.exe -s -X POST "$SITE/api/users" -H "content-type: application/json" -d '{\"name\":\"gwangmin\"}' | ConvertFrom-Json
$UID = $U.id
$S  = curl.exe -s -X POST "$SITE/api/users/$UID/sessions" -H "content-type: application/json" -d '{\"title\":\"cost\"}' | ConvertFrom-Json
$SID = $S.sessionId

$enc = [System.Text.UTF8Encoding]::new($false)
[System.IO.Directory]::SetCurrentDirectory((Get-Location).Path)
$p = @{ userId=$UID; sessionId=$SID; message="이번 달 내 AWS 비용 얼마야? 서비스별 상위도 알려줘." } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllBytes("payload.json", $enc.GetBytes($p))
curl.exe -s -X POST "$SITE/api/chat" -H "content-type: application/json" --data-binary "@payload.json"   # 202

Start-Sleep -Seconds 15
curl.exe -s "$SITE/api/sessions/$SID/messages?limit=20"
```

기대 — `messages` 안에:
```
kind:"tool_call"   code:"... await awsCost({groupByService:true}) ... read(...)"
kind:"tool_result" content:{"reads":[{"total":"3.12",...,"byService":[...]}], "skillCalls":[{"name":"awsCost","ok":true,...}]}
kind:"text"        content:"이번 달 약 $3.12 입니다. 상위: CloudFront ..., DynamoDB ..."
```

→ **`tool_result` 의 `reads.total` 숫자가 최종 텍스트에 그대로 박혀 있으면** 모델이 추측이 아니라 **실제 Cost Explorer 값**으로 답한 것. `skillCalls` 로 awsCost 호출 사실까지 추적됨.

### 3) 브라우저로 (선택)

`$SITE` 접속 → ⓪ 생성 → ① 연결+구독 → ② 전송(기본 메시지가 비용 질문) → 카드 실시간.

### 4) 정리

```powershell
npx cdk destroy --force   # Lambda@Edge 복제본 때문에 시간 두고 재시도(Day 16 함정 #46)
```

## ⚠️ 함정 / 트러블슈팅 (Day 17 발견분)

| # | 함정 | 원인 | 회피 |
|---|---|---|---|
| 47 | `awsCost` 가 `DataUnavailable`/AccessDenied | 계정에서 Cost Explorer 미활성 | Billing→Cost Explorer 한 번 열어 활성화(데이터 ~24h) |
| 48 | CE 호출이 엔드포인트 에러 | Cost Explorer 는 **us-east-1 단일 엔드포인트** | `CostExplorerClient({ region: "us-east-1" })` 고정 |
| 49 | 샌드박스가 timeout | 네트워크 skill 추가로 5s 가 빠듯 | `SANDBOX_TIMEOUT_MS` 5s → **10s** |
| 50 | 토큰 폭증/모델 혼선 | `skillCalls` 까지 LLM 에 되먹임 | LLM payload 엔 `reads/error` 만, `skillCalls` 는 **저장/MQTT 전용** |
| 51 | 비용이 슬금슬금 | CE 는 **호출당 ~$0.01** | `MAX_TURN_STEPS` 가 컷 + 질문당 보통 1~2회 |
| 52 | "오늘 비용"이 0 으로 나옴 | CE `TimePeriod.End` 는 **exclusive** | 오늘 포함하려면 `end = 내일` (기본값이 그렇게 처리) |

> 함정 1~20 Phase 2/Day 11~12, 21~26 Day 13, 27~31 Day 14, 32~38 Day 15, 39~46 Day 16. Day 17 부터 47~ 누적.

## 🧠 남긴 숙제 → 다음 day 들로

| 숙제 | 어디서 |
|---|---|
| 디스코드 봇 — 채널에서 말 걸면 이 에이전트(+skill)가 답 | Day 18 |
| 관측성 — X-Ray/대시보드/알람/예산으로 전부 계측 | Day 19 |
| skill 더 추가(memory: 세션 메모 저장/조회 등) | 옵션 |

## 🎁 Day 17 이 남긴 자산

- **skill 주입 패턴** — 도구 1개(`executeCode`) 안에 함수를 넣어 "행동"을 무한 확장(다음 skill 도 같은 자리에)
- **`awsCost` skill** — 에이전트가 자기 인프라 비용을 실제로 조회(자기참조적 데모)
- **`skillCalls` 추적** — 무엇을 호출했는지 행/MQTT 에 남기되 LLM 컨텍스트는 깨끗하게
