# Day 9: CloudFront 로 프론트 + API 통합 배포

Phase 2 의 마지막 봉합 단계. Day 8 까지 만든 두 조각 — **S3 정적 웹** (Day 8) 과 **Lambda Function URL 백엔드** (Day 7) — 을 **한 개의 CloudFront 배포** 뒤로 묶는다.

원본 레퍼런스(breath103/serverless-agent) 의 `CloudFront + S3 (private/OAI) + Lambda@Edge` 구성에서 **Lambda@Edge 만 떼고** 골격을 그대로 따른다. Lambda@Edge 는 Phase 3 (Day 11) 의 IoT/MQTT 인증 흐름과 같이 다룬다.

## 🎯 학습 목표

- **CloudFront 배포** 의 multi-origin + behavior 분기 (S3 기본 / `/api/*` Function URL)
- **OAC (Origin Access Control)** — S3 를 private 로 잠그고 CloudFront 만 SigV4 로 읽게 (구 OAI 후속)
- **CloudFront Function** (viewer-request) 으로 URI 재작성 — `/api/foo` → `/foo` 로 origin path strip
- **Origin Request Policy** `ALL_VIEWER_EXCEPT_HOST_HEADER` — Function URL 이 viewer Host 받으면 깨지는 이유
- **CACHING_DISABLED vs CACHING_OPTIMIZED** — API 와 정적 자산의 캐시 정책 분리
- 캐시 무효화 (`distributionPaths: ['/*']`) — `BucketDeployment` 가 배포마다 자동으로 invalidate
- SPA fallback (`errorResponses` 403/404 → /index.html)
- 동일 오리진의 효과: **CORS 가 사라진다** (preflight 자체가 발생 안 함)

## 📐 아키텍처

```
                       브라우저 (https://dxxxx.cloudfront.net)
                                     │
                          ┌──────────┴──────────┐
                          │                     │
                  /  /assets/*.js          /api/*
                  /api 없음               (chat, sessions, health)
                          │                     │
                          ▼                     ▼
        ┌─────────────────────────┐   ┌───────────────────────────────┐
        │ Default Behavior         │   │ Behavior: /api/*              │
        │   cache: OPTIMIZED       │   │   cache: DISABLED             │
        │   methods: GET/HEAD      │   │   methods: ALL                │
        │   viewer→origin S3 (OAC) │   │   originReq:                  │
        │                          │   │     ALL_VIEWER_EXCEPT_HOST    │
        │                          │   │   CloudFront Function:        │
        │                          │   │     viewer-request → strip /api│
        └────────────┬─────────────┘   └────────────────┬──────────────┘
                     │                                    │
                     ▼                                    ▼
        ┌─────────────────────────┐         ┌─────────────────────────────┐
        │ S3 WebBucket             │         │ Day 7 Function URL           │
        │  PRIVATE / BLOCK_ALL     │         │  ├─ POST /chat (RESPONSE_    │
        │  객체: index.html +      │         │  │           STREAM)        │
        │       /assets/*          │         │  ├─ GET /sessions/:id/...   │
        │  policy: cloudfront 만   │         │  └─ GET /health             │
        │           읽기 허용 (OAC)│         └─────────────┬───────────────┘
        └─────────────────────────┘                       │
                                                          ▼
                                                   DynamoDB + Bedrock
                                                   (Day 7 스택 그대로)
```

Day 9 스택은 **CloudFront 배포 + 새 S3 (private) + CloudFront Function 한 개** 만 만든다. 백엔드(Lambda/DDB/Bedrock) 는 Day 7 스택을 그대로 재사용 — `FUNCTION_URL` 환경변수로 host 만 받음.

## 🗂️ 폴더 구조

```
day-09-cloudfront/
├── bin/day-09-cloudfront.ts          # CDK 엔트리 (FUNCTION_URL env 검증)
├── lib/day-09-cloudfront-stack.ts    # S3(private) + CloudFront + CF Function + BucketDeployment
├── cdk.json / tsconfig.json / package.json
└── web/                              # Vite React 앱 (Day 8 와 거의 동일)
    ├── index.html
    ├── vite.config.ts                # dev proxy: VITE_FUNCTION_URL_FOR_DEV → /api 매핑
    ├── .env.sample                   # VITE_API_BASE=/api (기본)
    └── src/
        ├── main.tsx
        ├── App.tsx                   # 채팅 UI (Day 8 그대로, 타이틀만)
        ├── chat.ts                   # base URL = /api 동일오리진
        └── styles.css
```

## 🧠 왜 multi-origin + behavior 분기인가

원본 레퍼런스는 `CloudFront → S3 (정적)` 한 가지만 두고 API 는 별도 도메인을 쓰는 대신, **같은 cloudfront.net 도메인 하나로 둘 다** 서빙한다. 얻는 것:

1. **브라우저 same-origin** — `/api/chat` 호출이 cross-origin 이 아니라 동일 오리진 → CORS 정책 전부 무시됨, preflight OPTIONS 가 안 나감.
2. **운영 도메인 1개** — Phase 3 의 ACM/Route53 결합 시 도메인을 한 군데만 묶으면 됨.
3. **HTTPS 강제** — `cloudfront.net` 기본 인증서로 ACM 없이 즉시 HTTPS.

대안과 비교:

|  | 구성 | 장점 | 단점 |
|---|---|---|---|
| **CloudFront 1개로 합치기** (선택) | S3 + Function URL 두 origin | same-origin, HTTPS, 캐시 | CF Function 한 개 + URL rewrite 필요 |
| CloudFront 2개 따로 | `cdn.x.com` + `api.x.com` | 정책 분리 깔끔 | cross-origin → CORS, 도메인 2개 |
| API Gateway 추가 | APIGW → Lambda | 사용량 플랜 등 | 한 층 더, Function URL 의 RESPONSE_STREAM 손실 |
| Lambda@Edge 라우팅 | 단일 origin + 엣지 분기 | 더 유연 | 비싸고 디버깅 까다로움 — Day 11 |

## 🧠 OAC vs OAI — 왜 withOriginAccessControl

OAI (Origin Access Identity, 구식) 는 IAM 사용자처럼 동작하는 CloudFront 의 "신원". 2022년부터 **OAC (Origin Access Control)** 로 교체 — **SigV4 기반** + 추가 리전(아시아 등)에서 OAI 가 안 먹는 버그도 없음.

CDK v2 의 `origins.S3BucketOrigin.withOriginAccessControl(bucket)` 한 줄이:

1. CloudFront OAC 리소스 생성
2. 버킷 정책에 `Service: cloudfront.amazonaws.com` 의 GetObject 허용 (해당 distribution 으로만 한정)
3. 버킷의 `BlockPublicAccess.BLOCK_ALL` 와 호환 — public 안 풀어도 작동

까지 자동. **버킷이 private 인 채로 CloudFront 만 읽을 수 있는 상태** 가 한 줄로 떨어진다.

Day 8 의 `publicReadAccess: true + BLOCK_ACLS` 조합은 OAC 로 가면서 **버킷이 다시 private** 으로 잠긴다. 콘솔에서 버킷 직접 URL 로 가면 403.

## 🧠 CloudFront Function 으로 `/api` strip — 왜 필요한가

문제: 브라우저는 `/api/chat` 으로 호출 → Function URL 백엔드(Day 7 Hono) 는 `/chat` 라우트.

CloudFront origin path 는 **PREPEND** 만 됨 (예: originPath="/v1" → 모든 요청에 /v1 붙임). **STRIP** 은 못 함.

해결 옵션:
1. **CloudFront Function** (viewer-request) — JS 한 함수, µs 단위, 1M req/월 무료. ← 선택
2. Lambda@Edge — 더 강력하지만 콜드스타트 + 비용. Day 11 까지 보류.
3. Day 7 라우트를 `/api/chat` 으로 변경 — Day 7 스택 침범 + Day 8 와 결합도 깨짐. 안 함.

코드 (인라인 4줄):
```js
function handler(event) {
  var req = event.request;
  if (req.uri === '/api' || req.uri === '/api/') req.uri = '/';
  else if (req.uri.startsWith('/api/')) req.uri = req.uri.substring(4);
  return req;
}
```

`substring(4)` 가 `'/api'` 길이(=4)만 자르고 그 다음 `/chat` 은 그대로. `/api/sessions/foo/messages` → `/sessions/foo/messages`.

## 🧠 ALL_VIEWER_EXCEPT_HOST_HEADER — Host 헤더 함정

Function URL 의 TLS 인증서/SNI 는 자신의 `*.lambda-url.<region>.on.aws` 도메인용. CloudFront 가 viewer 의 Host (`dxxx.cloudfront.net`) 를 그대로 보내면 → **403 The request could not be satisfied** 가 즉시 떨어진다.

`OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER` 가 이걸 해결: viewer 의 모든 헤더/쿠키/쿼리를 그대로 전달하되 **Host 만 origin (lambda-url) 의 것으로 재설정**. AWS 가 정확히 이 시나리오를 위해 만들어 둔 managed policy.

(만약 직접 `OriginRequestPolicy` 를 정의한다면 `headerBehavior: { behavior: 'allExcept', headers: ['Host'] }` 가 됨.)

## 🧠 CACHING_DISABLED vs CACHING_OPTIMIZED

- **CACHING_DISABLED** (/api/*): Cache-Control 무시, 항상 origin 으로 forward. 채팅 응답을 다른 사람에게 캐싱해서 주면 큰일이라 필수.
- **CACHING_OPTIMIZED** (정적): Gzip/Brotli, Vite hashed asset (`index-abc123.js`) 에 최적. 캐시 hit ratio 가 매우 높음.

Vite 가 빌드 산출물 이름에 hash 를 박아주기 때문에 **/index.html 만 매 배포 invalidate 하면** 새 hash 가 박힌 새 index.html 이 새 .js/.css 를 가리킴. 그래도 학습 단계라 `/*` 전체 invalidate (BucketDeployment 가 자동).

## 🧠 RESPONSE_STREAM passthrough

Day 7 Function URL 은 `invokeMode: RESPONSE_STREAM`. CloudFront 가 끼면 응답이 buffer 되어 chunk 의미가 사라지지 않을까?

다행히 CloudFront 는 **2023 이후 origin 의 chunked transfer-encoding 을 viewer 측까지 passthrough** 한다 (response streaming 정식 지원). `cachePolicy: CACHING_DISABLED` 와 결합되면 origin → viewer 까지 chunked 가 유지됨. 브라우저 `fetch().body.getReader()` 가 Day 8 직접호출 때와 동일하게 토큰 단위로 받음.

단, 검증 필요 항목 — 첫 토큰 latency 가 Day 8 대비 +50~150ms 정도 증가할 수 있음 (CloudFront 엣지 hop). 배포 후 실측.

## ▶️ 배포 & 테스트

### 0) Day 7 가 배포되어 있어야 함

Day 9 는 Day 7 의 Function URL 을 origin 으로 잡는다. 없으면 먼저:

```bash
cd ../day-07-history-api
npx cdk deploy
# → Day07HistoryApiStack.FunctionUrl 출력 메모
```

### 1) Function URL 을 env 로 주입

PowerShell:
```powershell
$env:FUNCTION_URL = "https://xxxxxxxxxxxxxx.lambda-url.us-east-1.on.aws/"
```

bash:
```bash
export FUNCTION_URL="https://xxxxxxxxxxxxxx.lambda-url.us-east-1.on.aws/"
```

또는 `cdk deploy -c functionUrl=https://xxxx.lambda-url.us-east-1.on.aws/`.

### 2) 의존성 + 빌드 + 배포

```bash
cd day-09-cloudfront
npm install
npm run web:install          # web/ 의존성
npm run deploy               # web:build → cdk deploy
```

CDK 가 묻는 IAM/리소스 변경은 학습용이라 `--require-approval never` 로 통과 (deploy script 안에 포함됨).

배포 끝나면 (대략 8~15분, CloudFront propagation 포함):
```
Day09CloudfrontStack.DistributionDomainName = dxxxxxxxxxx.cloudfront.net
Day09CloudfrontStack.DistributionUrl       = https://dxxxxxxxxxx.cloudfront.net
Day09CloudfrontStack.ApiBase               = https://dxxxxxxxxxx.cloudfront.net/api/
```

### 3) 브라우저로 열기

```
https://dxxxxxxxxxx.cloudfront.net
```

- 같은 채팅 UI (Day 8 과 동일), 다만 상단 banner 에 `API base: /api`
- send → 토큰 stream
- F5 → 같은 sessionId localStorage 에서 복원 → history GET
- new → 새 session

### 4) 동일오리진 확인 (DevTools Network)

- 모든 요청이 같은 `dxxxx.cloudfront.net` 호스트
- `/api/chat` 요청의 `Request URL` 은 `https://dxxxx.cloudfront.net/api/chat`
- Response Headers 에 `x-cache: Miss from cloudfront` (또는 RefreshHit) + `x-amz-cf-pop`
- OPTIONS preflight 가 **하나도 안 보임** ← same-origin 의 효과
- 정적 자산은 두 번째 로드부터 `x-cache: Hit from cloudfront` 가 떠야 함

### ✅ 실 배포 검증 결과 (2026-06-01, us-east-1)

Day 7 (FunctionUrl=`https://m44kbqb32lmjsu6hwtp2yojeim0esuxd.lambda-url.us-east-1.on.aws/`) 재배포 후 Day 9 `npm run deploy` — **16 리소스 / 329.6s** (CloudFront 분배 propagation 포함).

```
Day09CloudfrontStack.DistributionUrl       = https://d1f80tvc0unj19.cloudfront.net
Day09CloudfrontStack.ApiBase               = https://d1f80tvc0unj19.cloudfront.net/api/
Day09CloudfrontStack.BucketName            = day09cloudfrontstack-webbucket12880f5b-7gxqiqzjpias
Day09CloudfrontStack.FunctionOriginHost    = m44kbqb32lmjsu6hwtp2yojeim0esuxd.lambda-url.us-east-1.on.aws
```

**1) `/` — S3 origin 으로 정적 자산 서빙 (Day 9 빌드 박힘)**
```
HTTP/1.1 200 OK
Content-Type: text/html
X-Cache: Miss from cloudfront
X-Amz-Cf-Pop: SEA900-P5
<title>Day 9 — Serverless Agent Chat (CloudFront)</title>
```

**2) `/api/health` — `/api` strip 후 Function URL `/health` 도달**
```
HTTP/1.1 200 OK
Content-Type: application/json
Transfer-Encoding: chunked
X-Cache: Miss from cloudfront
Via: 1.1 ... .cloudfront.net (CloudFront)
X-Amzn-Trace-Id: Root=1-... ;Parent=...
{"ok":true,"day":7}
```
→ CF Function 의 `req.uri.substring(4)` 가 정확히 동작. `X-Amzn-Trace-Id` 는 Lambda(Function URL) 가 만든 거 — CloudFront 뒤에서도 trace 살아있음 확인.

**3) S3 직접 GET — OAC 락 동작**
```
$ curl https://day09cloudfrontstack-webbucket12880f5b-7gxqiqzjpias.s3.amazonaws.com/index.html
HTTP 403
<Error><Code>AccessDenied</Code>...
```
→ `BlockPublicAccess.BLOCK_ALL` + OAC SigV4 정책 외 모든 접근 차단. 의도된 동작.

**4) POST `/api/chat` — RESPONSE_STREAM passthrough**
```
$ curl --no-buffer -N -X POST "$CF/api/chat" -d '{"sessionId":"sess-day09-verify","message":"..."}' \
       -w "first-byte: %{time_starttransfer}s | total: %{time_total}s"
[응답 본문]
first-byte: 3.154s | total: 4.245s
```
→ **first-byte 3.15s** (Day 8 직접호출 2.21s 대비 +0.94s — CF 엣지 hop + 첫 호출 인증/SSL 비용).
→ total - first-byte = ~1.1s 의 스프레드 → chunked transfer-encoding 이 viewer 까지 살아있음 (한 방에 떨어진 게 아님).

**5) POST `/api/chat` turn 2 — 멀티턴 컨텍스트 전달**
```
first-byte: 3.089s | total: 3.957s
```
→ 첫 호출 대비 미세하게 빠름 (TLS 재사용). 멀티턴 컨텍스트는 아래 6) 의 히스토리에서 turn1+2 합쳐 input 133 tokens 으로 확인.

**6) GET `/api/sessions/sess-day09-verify/messages?limit=10`**
```json
{"sessionId":"sess-day09-verify","count":4,"messages":[
  {"ts":"2026-06-01T00:55:12.513Z",
   "sk":"2026-06-01T00:55:12.513Z#b08a9f8a-06a1-4f27-ad7c-ae809a28ce79",
   "role":"user","content":"오늘 너의 day 가 몇 day 인지 한 줄로"},
  {"ts":"2026-06-01T00:55:14.847Z",
   "sk":"2026-06-01T00:55:14.847Z#3d24961b-6cd4-4fc0-b608-7fb85f447930",
   "role":"assistant","content":"저는 AI 어시스턴트이기 때문에 ...",
   "inputTokens":59,"outputTokens":52},
  {"role":"user","content":"방금 너가 한 말 한 줄로"},
  {"role":"assistant","content":"저는 AI 어시스턴트이기 때문에 ...",
   "inputTokens":133,"outputTokens":53}
],"nextBefore":null}
```
→ Day 7 의 SK 합성/ScanIndexForward 가 CloudFront 뒤에서도 그대로 동작. turn2 의 inputTokens=133 이 turn1 4건 합산(=user+assistant+user, ~133) 과 맞아 컨텍스트 전달 검증.

**7) 정적 자산 캐시 — 1차 MISS / 2차 HIT**
```
1차: X-Cache: Miss from cloudfront
2차: X-Cache: Hit from cloudfront
     Age: 3
```
→ `CACHING_OPTIMIZED` 정책 + Vite hashed asset 조합으로 즉시 캐시 잡힘.

**8) SPA fallback — 404 → 200 + index.html**
```
$ curl -w "%{http_code}" $CF/nonexistent/route
HTTP 200 | content-type text/html | <!doctype html>...
```
→ `errorResponses 404 → /index.html` 로 SPA 라우터 진입 대비.

**9) CF Function rewrite 엣지 케이스 — `/api`, `/api/`**
- `/api` → strip 후 `/` → Function URL 의 `/` 라우트 없음 → 404 → errorResponses 가 index.html 로 회복 (HTTP 200, SPA html)
- 의도와 다르지만 무해 — 브라우저 코드가 `/api/...` 하위만 호출하지 `/api` 자체는 안 부름.
- "엄격하게" 차단하려면 errorResponses 의 origin matching 을 behavior 별로 분기해야 함 (CDK 표준 prop 으로는 안 됨, Lambda@Edge 까지 가야). Day 11 의 숙제로 남김.

**검증 통과 요약**:
- CloudFront 단일 도메인으로 S3 정적 + Function URL `/api/*` 둘 다 서빙 ✓
- CF Function 이 `/api/foo` → `/foo` 로 viewer-request 단계에서 rewrite ✓
- `ALL_VIEWER_EXCEPT_HOST_HEADER` 정책으로 Function URL 의 Host SNI 보호 (Host 헤더 함정 회피) ✓
- S3 가 **private + OAC** 상태 그대로 — 직접 GET 403 ✓
- RESPONSE_STREAM 의 chunked transfer 가 CloudFront 통과 후에도 살아있음 (first-byte 3.15s / total 4.25s) ✓
- 정적 자산 캐시 (CACHING_OPTIMIZED) + API 캐시 차단 (CACHING_DISABLED) ✓
- 멀티턴/히스토리/세션격리 (Day 7) 가 동일오리진 fetch 로 그대로 동작 ✓
- SPA fallback (errorResponses) ✓
- **CORS 가 사라짐** — preflight OPTIONS 가 한 번도 안 나옴 (same-origin) ✓

> 정리: Day 9 + Day 7 둘 다 `npx cdk destroy --force` 로 즉시 정리. CloudFront destroy 도 propagation 으로 ~5분.

### 5) 로컬 dev (선택)

CloudFront 없이 Day 7 백엔드만 부르는 로컬 모드도 가능 — vite 의 dev proxy 가 `/api` 를 Function URL 로 그대로 흘려준다.

```bash
cd day-09-cloudfront/web
cp .env.sample .env
# .env 의 VITE_FUNCTION_URL_FOR_DEV 주석 풀고 Day 7 의 URL 넣기
npm run dev
# http://localhost:5173 — /api/* 는 proxy 가 Day 7 으로 forward
```

## 🐛 막힐 만한 곳

### 첫 배포 직후 https://dxxx.cloudfront.net 가 503/404

- CloudFront propagation 이 아직 안 끝남. 5~15분 기다리고 강력 새로고침 (Ctrl+Shift+R).
- BucketDeployment 가 끝났는지 콘솔에서 확인 — index.html 이 S3 에 떨어졌어야 함.

### /api/chat 가 403 The request could not be satisfied

- 거의 100%, `ALL_VIEWER_EXCEPT_HOST_HEADER` 가 안 붙은 상태. 스택 코드의 originRequestPolicy 확인.
- 직접 OriginRequestPolicy 를 만들어 쓰는 경우 `headerBehavior.behavior='allExcept'` + headers 에 'Host' 포함되어 있어야 함.

### /api/chat 가 잘 가는데 백엔드가 404 says "no route"

- CloudFront Function 의 URI 재작성이 안 먹은 것. functionAssociations 가 /api/* behavior 에 붙었는지, eventType 이 VIEWER_REQUEST 인지 확인.
- 콘솔의 CloudFront → Functions → Stage:Live 가 됐는지 (CDK 는 자동 publish).

### chunked stream 이 한 번에 떨어짐 / 끊김

- 브라우저 DevTools 의 Network 탭 → Response Headers 에 `transfer-encoding: chunked` 가 보여야 함.
- `cache-control: no-store` 도 함께. CACHING_DISABLED 가 설정해줌.
- 회사 프록시/AV 가 끼면 버퍼링 가능 — 외부망에서 테스트.

### S3 버킷에 직접 GET → 403 AccessDenied

- 의도된 동작. OAC 로 잠갔으니 CloudFront 거치지 않은 직접 접근은 막힘. 콘솔에서도 마찬가지.

### 재배포 후에도 옛 index.html 가 뜸

- 강력 새로고침 (Ctrl+Shift+R) 또는 브라우저 캐시 비우기. BucketDeployment 의 invalidation 은 갔지만 브라우저 로컬 캐시는 별개.

### `npm run deploy` 가 esbuild/ts-node 에러

- node 20+ 필수. `node --version` 확인.
- CDK bootstrap (`npx cdk bootstrap`) 이 안 됐으면 한 번 돌려야 함 (Day 3 이후로 됐을 가능성).

## 💰 비용 감각

| 항목 | 무료 티어 | 가격 |
|---|---|---|
| CloudFront 데이터 out | 1TB/월 | 이후 $0.085/GB (PRICE_CLASS_100) |
| CloudFront 요청 | 10M/월 | 이후 $0.0075/10k (HTTPS) |
| CloudFront Function 호출 | 2M/월 | 이후 $0.10/1M |
| OAC | 무료 | — |
| S3 storage / GET | 5GB / 20k req | 미미 |
| BucketDeployment Lambda | — | 배포당 몇 초만 |
| Invalidation | 1000 paths/월 | 이후 $0.005/path |

학습 단계 일일 트래픽 (수십~수백 요청) → **사실상 $0**.

Day 7 Function URL 의 호출 비용 (Day 7 와 동일):
- POST /chat: ~$0.0014/회 (Bedrock 200/200 토큰 기준)
- GET history: ~$0.000002/회

## 🔜 다음 단계 (Day 10 = Phase 2 회고)

- Phase 2 (Day 5~9) 다섯 단계 결합 회고 — 각 day 가 뭘 더했는지, 어디서 멈췄는지
- 비용 정리: 매 배포 후 destroy 패턴 유지 점검
- Phase 3 진입 준비: Agent Loop / IoT MQTT / Lambda@Edge / Telegram bot

> 정리: `npm run destroy` 로 day-09 스택만 즉시 정리 가능 (CloudFront propagation 으로 destroy 도 5~15분).
> Day 7 의 Function URL 은 destroy 해도 day-09 가 영향 X — origin host 가 사라지면 /api/* 가 502 가 될 뿐.
