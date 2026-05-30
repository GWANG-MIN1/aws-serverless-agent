# Day 7: Hono 멀티 라우트 + 대화 히스토리 조회 API

Phase 2 세 번째. Day 6 streaming 챗봇 위에 **히스토리 조회 GET 라우트**를 얹고, 그 김에 라우터를 **Hono** 로 갈아끼운다. Day 5 README 에서 미뤄둔 "최근 N턴 정확히 가져오기" 숙제도 같이 정리.

원본 레포(breath103/serverless-agent)가 `lambda-api/handler.ts` 에서 `streamHandle(app)` 으로 Hono 를 Function URL 위에 올린 패턴을 그대로 차용. 인증/크레딧/세션 메타 분리 같은 고급 패턴은 day-8 이후로 미룸.

## 🎯 학습 목표

- Hono — 서버리스용 경량 라우터
- `hono/aws-lambda` 의 `streamHandle` — streaming Lambda + 멀티 라우트 공존
- DynamoDB `ScanIndexForward: false` + reverse — "가장 최근 N개" 정확히 가져오기
- SK 합성 키 (`${ts}#${uuid}`) — 같은 ms 동시 insert 충돌 방지
- 커서 기반 페이지네이션 (`before=<ts>`) 1단
- `aws-cdk-lib/aws-lambda-nodejs` (esbuild 번들링) — npm 의존성을 Lambda 에 싣는 표준 방법

## 📐 아키텍처

```
                 ┌─────────────────────────────┐
                 │   ConversationsTable        │
                 │ PK: sessionId               │
                 │ SK: ts ("ISO#uuid" 합성)    │
                 └──────────┬──────────────────┘
                            │ Query / Put
                            ▼
                       ┌─────────────┐
HTTP ──▶ Function URL ─▶  Hono app   │
                       │  ├─ POST /chat                 (stream)
                       │  ├─ GET  /sessions/:id/messages (json)
                       │  └─ GET  /health                (json)
                       └──────┬──────┘
                              │
                              ▼ (POST /chat 만)
                         AWS Bedrock
                      (Claude Haiku 4.5)
```

같은 Function URL Lambda 가 두 종류 응답을 동시에 함.
- **POST /chat**: Bedrock 토큰 스트림을 chunk 로 흘려보냄
- **GET /sessions/:id/messages**: DDB Query 1번 → JSON 응답

`invokeMode: RESPONSE_STREAM` 인데 GET 도 잘 동작하는 이유: `streamHandle` 이 `c.json(...)` 응답도 그대로 한 번에 흘려보내줌. 클라이언트 입장에선 그냥 일반 JSON.

## 🔁 Day 6 → Day 7 변경 요약

| 항목 | Day 6 | Day 7 |
|---|---|---|
| 진입점 | `awslambda.streamifyResponse(...)` 직접 | `streamHandle(honoApp)` |
| 라우트 | 단일 POST | POST + GET 2개 + /health |
| 메시지 SK | `ts` (ISO) | `${ts}#${uuid}` 합성 |
| 이력 조회 | `ScanIndexForward:true` (오래된 N개) | `false` + reverse (최근 N개) |
| 히스토리 조회 API | ❌ | `GET /sessions/:id/messages?limit=N&before=<ts>` |
| Lambda 패키징 | plain `lambda.Function` + asset | `NodejsFunction` + esbuild |

## 🧠 왜 Hono 를 끼우는가

Day 6 까지는 핸들러 하나라 라우터 없어도 됐는데, 히스토리 GET 이 들어오는 순간 `event.requestContext.http.method + path` 분기를 직접 짜야 함. 그 분기를 직접 매번 쓸 거면 라우터 하나 끼우는 게 답.

선택지:
| | 무엇 | 장점 | 단점 |
|---|---|---|---|
| 직접 분기 | switch(method+path) | 의존성 0 | 라우트 늘면 지옥 |
| express | 전통 | 친숙 | 무겁고 Lambda 비친화, streamify 패턴 직접 |
| **Hono** | edge/serverless용 경량 | Lambda streaming 지원(`streamHandle`), 번들 작음 | 학습곡선 미미 |

원본 레포가 Hono 를 쓰고, 같은 Lambda 안에서 streaming 라우트 + 일반 라우트를 깔끔히 공존시키는 게 핵심 패턴이라 그대로 따라간다.

## 🧠 왜 SK 를 `${ts}#${uuid}` 합성으로 바꾸나

Day 5/6 의 SK = `ts` (ISO 문자열) 은 같은 ms 에 메시지 두 개가 들어오면 **두 번째가 첫 번째를 덮어씀**. PK+SK 가 같으면 Put 은 그냥 overwrite.

학습 단계에선 한 사용자가 두 번 동시 요청할 일이 거의 없지만:
- assistant 응답이 너무 빨라서 user 메시지 Put 과 동일 ms 가 되면 안 깨질까? → 가능성 낮지만 0 은 아님
- 멀티 디바이스로 같은 sessionId 호출하면? → 가능

`${ISO}#${uuid}` 합성:
- 정렬은 ISO 가 앞이라 시간순 그대로
- uuid 가 뒤에 붙어 고유성 보장
- DDB 입장에선 그냥 STRING 이라 테이블 정의는 손 안 댐
- 원본 레포가 `${now}#${id}` 로 똑같이 함

## 🧠 `ScanIndexForward` — 왜 false 가 맞나

DDB Query 의 `Limit` 은 **정렬 순서로 앞에서 N개**. 의미를 정확히 짚자면:

| `ScanIndexForward` | 의미 | 우리에게 |
|---|---|---|
| `true` (default) | SK 오름차순 | "가장 **오래된** N개" 가져옴 |
| `false` | SK 내림차순 | "가장 **최근** N개" 가져옴 |

챗봇 컨텍스트엔 **최근** 대화가 중요하지 오래된 게 중요한 게 아님. Day 5/6 는 `true` 라서 sessionId 가 오래되면 모델이 **첫 대화만** 컨텍스트로 받는 버그가 있었음. (학습 단계에선 이력이 짧아 티 안 났을 뿐.)

```js
// Day 7
ScanIndexForward: false,  // 최근 N개
Limit: HISTORY_LIMIT,

// 받은 뒤 reverse → Bedrock 에 넘길 땐 시간순(과거→최신) 으로
const history = items.slice().reverse().map(...)
```

GET API 도 동일 — 내부는 "최신 N개" 로 Query 한 뒤 응답에서 reverse 해서 시간순 보장 (UI 가 그대로 렌더하기 편함).

## 🧠 esbuild 번들링 — 왜 NodejsFunction 으로 바꿨나

Day 6 까지는 `lambda.Function` + `code.fromAsset(lambda/)` 였음. 핸들러가 `.mjs` 한 파일에 표준 라이브러리 + Lambda 런타임 내장 AWS SDK 만 썼기 때문에 그게 통했음.

Day 7 부터 `hono` 라는 외부 npm 의존성이 들어옴 → zip 에 `node_modules/hono/...` 가 포함돼야 import 가 됨.

선택지:
- **(A)** asset 폴더에 `npm install hono` 해서 node_modules 까지 같이 올림 — 깔끔하지만 git 에 node_modules 들어가거나, 빌드 스크립트 따로 필요
- **(B)** CDK bundling 옵션으로 Docker 안에서 `npm install` — Docker 의존
- **(C)** `aws-cdk-lib/aws-lambda-nodejs` (esbuild) — 로컬 esbuild 가 entry + deps 를 단일 파일로 번들 → **Docker 없음, 빠름, 작음**

(C) 가 표준. AWS SDK 류는 Lambda 런타임에 이미 있으므로 `externalModules` 로 제외해서 번들 더 작게.

## ▶️ 배포 & 테스트

```bash
cd day-07-history-api
npm install
npx cdk deploy
```

배포 후:
```
Day07HistoryApiStack.FunctionUrl = https://yyyy.lambda-url.us-east-1.on.aws/
```

### 1) 헬스체크

```bash
URL=https://yyyy.lambda-url.us-east-1.on.aws/
curl -s "${URL}health"
# → {"ok":true,"day":7}
```

### 2) 스트리밍 채팅 (Day 6 와 동일 동작 확인)

```bash
curl --no-buffer -N -X POST "${URL}chat" \
  -H "content-type: application/json" \
  -d '{"sessionId":"sess-007","message":"긴 자기소개 부탁해"}'
```

토큰이 chunk 단위로 흘러나와야 함.

### 3) 같은 sessionId 로 한 번 더 — 멀티턴

```bash
curl --no-buffer -N -X POST "${URL}chat" \
  -H "content-type: application/json" \
  -d '{"sessionId":"sess-007","message":"방금 뭐라고 했는지 한 줄 요약"}'
```

이전 자기소개를 요약하면 → `ScanIndexForward:false + reverse` 로 최근 N턴 컨텍스트가 잘 들어간 것.

### 4) 히스토리 GET

```bash
curl -s "${URL}sessions/sess-007/messages?limit=10" | jq
```

```json
{
  "sessionId": "sess-007",
  "count": 4,
  "messages": [
    { "ts": "2026-05-30T...", "role": "user",      "content": "긴 자기소개 부탁해" },
    { "ts": "2026-05-30T...", "role": "assistant", "content": "저는 ..." },
    { "ts": "2026-05-30T...", "role": "user",      "content": "방금 뭐라고 했는지 한 줄 요약" },
    { "ts": "2026-05-30T...", "role": "assistant", "content": "..." }
  ],
  "nextBefore": null
}
```

`nextBefore` 가 `null` 이 아니면 다음 페이지 있음 → `?before=<nextBefore>` 로 호출.

### ✅ 로컬 검증 결과 (2026-05-30)

실 배포 전 `npm install` + `npx cdk synth` 만 돌려서 코드/스택 정합성 확인:

```
$ npm install
added 81 packages, and audited 119 packages in 1m

$ npx cdk synth
Bundling asset Day07HistoryApiStack/ChatFunction/Code/Stage...
  ...building/index.mjs  77.1kb
Done in 24ms
77 feature flags are not configured. Run 'cdk flags --unstable=flags' to learn more.
```

- **esbuild 번들 = 77.1KB** — hono 만 inline, aws-sdk 류는 `externalModules` 로 빠짐 → 의도대로
- CloudFormation 템플릿 (`cdk.out/Day07HistoryApiStack.template.json`) 정상 생성
- Lambda asset = 단일 `index.mjs` 79KB

### ✅ 실 배포 검증 결과 (2026-05-30, us-east-1)

`npx cdk deploy --require-approval never` → 65초만에 12 리소스 CREATE_COMPLETE. 받은 Function URL 로 6종 호출.

**1) GET /health — 라우터 부팅 확인**
```
$ curl -s "${URL}health"
{"ok":true,"day":7}
```

**2) POST /chat (turn 1, streaming + 타이밍)**
```
$ curl --no-buffer -N -X POST "${URL}chat" -d '{"sessionId":"sess-007","message":"긴 문장으로 자기소개 부탁해"}'
# 자기소개

안녕하세요, 저는 ... Claude입니다. ... 편하게 말씀해 주세요.
--- first-byte: 2.583s | total: 4.470s ---
```
→ **첫 토큰 ~2.6s, 전체 ~4.5s** — Day 6 와 거의 같은 수치. Hono `streamHandle` 이 chunk 흐름을 그대로 흘려줌. **streaming OK**.

**3) POST /chat (turn 2, 같은 sessionId 멀티턴)**
```
$ curl -s --no-buffer -N -X POST "${URL}chat" -d '{"sessionId":"sess-007","message":"방금 뭐라고 했는지 한 줄로 요약해줘"}'
저는 OpenAI의 인공지능 어시스턴트 Claude로서, 다양한 질문에 답변하고 여러 분야에서 정직하고 윤리적으로 도움을 드리는 것이 제 역할입니다.
--- first-byte: 1.767s | total: 2.282s ---
```
→ **이전 turn 1 의 자기소개를 정확히 한 줄로 요약**. `ScanIndexForward:false` + reverse 로 짠 컨텍스트 사이클이 정상. (모델이 자기를 "OpenAI"라고 hallucinate 한 건 모델 이슈, 파이프라인엔 무관.)

**4) GET /sessions/sess-007/messages — 히스토리 전체**
```json
{
  "sessionId": "sess-007",
  "count": 4,
  "messages": [
    {
      "ts": "2026-05-30T07:46:53.761Z",
      "sk": "2026-05-30T07:46:53.761Z#f2d4fb16-6bad-42fe-a60d-60b1bc596879",
      "role": "user",
      "content": "긴 문장으로 자기소개 부탁해"
    },
    {
      "ts": "2026-05-30T07:46:56.988Z",
      "sk": "2026-05-30T07:46:56.988Z#99d6f457-a8b5-4699-98ea-499491ebde5a",
      "role": "assistant",
      "content": "# 자기소개\n\n안녕하세요 ...",
      "inputTokens": 25,
      "outputTokens": 354
    },
    { "role": "user",      "content": "방금 뭐라고 했는지 한 줄로 요약해줘" },
    { "role": "assistant", "content": "저는 ...", "inputTokens": 410, "outputTokens": 79 }
  ],
  "nextBefore": null
}
```
→ `sk` 에 `${ISO}#${uuid}` 합성 키 정확히 박힘, 시간순(과거→최신) 정렬, `inputTokens`/`outputTokens` 같이 반환. count=4 < limit=10 이라 `nextBefore:null`.

**5) GET ?limit=2 — 페이지네이션 cursor 확인**
```json
{
  "sessionId": "sess-007",
  "count": 2,
  "messages": [ ...최신 turn 2 의 user + assistant... ],
  "nextBefore": "2026-05-30T07:47:15.997Z#7830156c-cf38-4b9b-a8af-939504962706"
}
```
→ "최신 2개" 가 정확히 잡힘 (`ScanIndexForward:false + Limit 2` → reverse). `nextBefore` 에 그 중 가장 오래된 SK 가 채워짐 → 다음 호출에서 `?before=<nextBefore>` 로 이어 받기 가능.

**6) 세션 격리 — 다른 sessionId**
```json
{"sessionId":"sess-999","count":0,"messages":[],"nextBefore":null}
```
→ PK 단위로 깔끔히 격리.

**검증 통과 요약**:
- Hono `streamHandle` 이 같은 Lambda 에서 streaming POST + JSON GET 둘 다 처리 ✓
- SK 합성 키 (`ts#uuid`) 가 실제로 박혀서 동시 insert 충돌 면역 ✓
- `ScanIndexForward:false` + reverse 로 "최근 N턴" 정확히 (Day 5/6 버그 수정) ✓
- 커서 페이지네이션 (`before=` ↔ `nextBefore`) 동작 ✓
- 검증 후 `npx cdk destroy --force` 로 즉시 정리 (학습 단계 비용 제로 관리)

### PowerShell 한글 payload (Day 5/6 와 동일 함정)

```powershell
$body = '{"sessionId":"sess-007","message":"안녕"}'
$bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($body)
[System.IO.File]::WriteAllBytes("payload.json", $bytes)
curl.exe --no-buffer -N -X POST "${URL}chat" `
  -H "content-type: application/json" --data-binary "@payload.json"
```

## 🐛 막힐 만한 곳

### `Cannot find module 'hono'` — Lambda 가 import 못 함

- `npm install` 안 함 → 로컬 esbuild 가 hono 못 찾음 → 번들 결과에 hono 없음
- CDK bundling 로그에서 esbuild 에러 났는지 확인. `cdk deploy --no-rollback` 으로 중간 상태 보기.

### `awslambda is not defined` — 로컬에서 import 시

Day 6 와 동일. `awslambda` 는 Lambda 런타임 글로벌. 로컬 실행은 mock 필요. 우리는 Lambda 안에서만 돌리니 신경 안 써도 됨.

### GET 가 OPTIONS preflight 에서 막힘

- CDK 스택의 `cors.allowedMethods` 에 `GET` 빠뜨림 → 브라우저에서만 막힘 (curl 은 됨)
- 이번 스택은 `[POST, GET]` 명시함

### 히스토리에 최근 메시지가 빠짐

- POST /chat 안에서 assistant Put 이 `await` 끝나기 전에 다음 GET 이 호출되면 race
- 학습 단계에선 손으로 호출하니 사실상 안 일어남. 실서비스라면 GET 호출 직전 sleep 한 번 또는 read-after-write consistency 옵션 (`ConsistentRead: true`) 고려.

## 💰 비용 감각

호출 1회당 (Day 6 와 거의 동일, GET 1회는 사실상 무료):
- POST /chat: ~$0.0014 (Bedrock 200/200 토큰 기준)
- GET  /messages: Lambda + DDB Query 1 = ~$0.000002 → **무시 가능**

esbuild 번들 크기 ~150KB 추가됐지만 Lambda 콜드스타트 영향은 ms 단위.

## 🔜 다음 단계 (Day 8)

- 최소 React 프론트 (Vite) — GET /messages 로 과거 대화 렌더, POST /chat 으로 chunk 받기
- S3 정적 호스팅 + Function URL 직접 fetch (CORS 는 이미 `*` 로 열어둠)
- Day 9 에서 CloudFront 로 묶으면서 origin 좁히기
