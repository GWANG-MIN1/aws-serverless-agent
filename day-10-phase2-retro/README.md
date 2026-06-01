# Day 10: Phase 2 회고 — 챗봇 MVP 5단계 진화

Phase 2 는 끝났다. **하루 한 조각씩 더해 5일 만에 "브라우저에서 HTTPS 로 동일오리진 fetch 하는 스트리밍 챗봇"** 까지 도달. 이 문서는 코드 없이 **회고만** 한다: 무엇이 매일 더해졌는지, 어떤 패턴이 반복됐는지, 어디서 막혔는지, 다음 5일(Phase 3) 은 뭘 풀 차례인지.

## 🎯 이 문서가 답하는 것

1. **Day 5~9 가 매일 한 조각씩 무엇을 더했는가** — Additive diff 형식
2. **5일 내내 반복된 패턴은 무엇인가** — "한 번 익히면 끝나는" 자산
3. **어떤 트러블슈팅이 쌓였는가** — 다시 안 밟을 함정 목록
4. **실제 비용은 얼마였나** — 영수증 기반 회고
5. **Phase 2 가 답하지 못한 질문은 무엇인가** — Phase 3 의 진입점

## 🪜 한눈에 — Day 5~9 의 진화

| Day | 한 줄 | 추가된 핵심 리소스 | 결과물 | 도달 가능 호출자 |
|---|---|---|---|---|
| **5** | Lambda + DDB + Bedrock 한 함수에서 엮기 | `DDB.Table`, `Lambda.Function`, IAM(Bedrock+DDB) | 멀티턴 챗봇 (BUFFERED) | `aws lambda invoke` 만 |
| **6** | HTTP + 토큰 스트리밍 | `Lambda.Alias("live")`, `Lambda.Url` (RESPONSE_STREAM, CORS=`*`) | 같은 챗봇이 `curl --no-buffer` 로 chunk | curl/httpie (CORS \*) |
| **7** | 멀티 라우트 + 히스토리 조회 | Hono 도입, SK 합성(`ts#uuid`), GET `/sessions/:id/messages` | POST 1 + GET 1 동시 운영 | curl + JSON parsing |
| **8** | 최소 React UI + S3 정적 호스팅 | `S3.Bucket(websiteIndexDocument)`, `BucketDeployment`, Vite | 브라우저 직접 fetch 챗봇 | 브라우저 (HTTP, CORS \*) |
| **9** | CloudFront 통합 + 동일오리진 + HTTPS | `CloudFront.Distribution(multi-origin)`, OAC, `/api/*` rewrite | HTTPS, 동일오리진, 캐시, S3 private | 브라우저 (HTTPS, no CORS) |

**핵심 통찰**: 매일 한 가지만 더했다. Day 5 는 "엮기", Day 6 은 "HTTP + 스트림", Day 7 은 "라우트 분기 + 조회", Day 8 은 "UI", Day 9 는 "통합 도메인". **한 번에 두 가지 더하면 어디서 깨졌는지 분리가 안 된다** — 이게 부품→조립 학습 전략의 핵심 가치였다.

## 🏗️ 아키텍처 진화 — 매일 한 줄씩 더해진 상자

```
Day 5  [aws lambda invoke] ──► Lambda ──► DDB
                                  └──► Bedrock (Converse, BUFFERED)

Day 6  curl ──HTTP──► [Function URL] ──► Alias("live") ──► Lambda ──► DDB
                                                              └──► Bedrock (ConverseStream)
       ◀──── chunked stream ────                                       (RESPONSE_STREAM)

Day 7  curl ──HTTP──► Function URL ──► Lambda(Hono)
                                          ├── POST /chat        (stream)
                                          ├── GET  /sessions/.. (buffered JSON)
                                          └── GET  /health
                                          → DDB (SK=ts#uuid)

Day 8  [브라우저] ──HTTP──► S3 website (정적, public)
       [브라우저] ──HTTP──► Day 7 Function URL (CORS *)
                       ↑ 두 오리진을 브라우저가 직접 알고 fetch

Day 9  [브라우저] ──HTTPS──► CloudFront ──► [default]  ──► S3 (private/OAC)
                                  └──► [/api/*] ──► CF Function (strip /api)
                                                ──► Day 7 Function URL
       ↑ 단일 도메인 / preflight 0 / 캐싱 분기
```

## 🧩 매일 더해진 조각 — 어디서 새로 배웠나

### Day 5 (시작점) — "AWS 리소스 셋이 어떻게 엮이는가"
- **새로움**: DDB 의 PK+SK = 같은 세션 시간순 Query 한 줄. Bedrock Converse 의 `messages[]` 누적 = 멀티턴 컨텍스트.
- **타협**: HTTP 노출 X (오직 `aws lambda invoke`), 응답은 buffered (스트림 X).
- **남긴 숙제**: "최근 N턴" 정확히 가져오기 (`ScanIndexForward:false`), 같은 ms 호출시 SK 충돌 — 둘 다 Day 7 에서 해결.

### Day 6 — "HTTP + 스트림"
- **새로움**: Function URL (vs API GW 선택 근거 표), `Alias("live")` 끼우는 이유 (canary 자리), `RESPONSE_STREAM` + `awslambda.streamifyResponse`, `ConverseStreamCommand` 의 이벤트 종류 (`contentBlockDelta` / `metadata.usage`).
- **타협**: 라우트 1개 (POST /chat 뿐), CORS `*`, 히스토리 조회 API 없음.
- **남긴 숙제**: 멀티 라우트, 라우터 도입 (Hono) — Day 7 에서.

### Day 7 — "라우터 + 조회"
- **새로움**: Hono `streamHandle(app)` 패턴 — 같은 streaming Lambda 안에서 POST stream + GET JSON 공존. SK 합성 `ts#uuid` (동시 insert 충돌). `Query(ScanIndexForward:false, Limit:N).reverse()` — "최근 N턴" 정확한 패턴.
- **타협**: 프런트엔드 X, CORS 여전히 `*` 와이드 오픈, HTTPS 인증서 직접 관리 X (Function URL 의 기본 cert 사용).
- **남긴 숙제**: 브라우저에서 호출하는 실제 UI, origin 좁히기 — Day 8/9 에서.

### Day 8 — "UI 한 줄 붙이기"
- **새로움**: Vite + React + TS 최소 셋업 (라우팅·상태관리 라이브러리 0개), `fetch().body.getReader()` + `TextDecoder({stream:true})` 로 RESPONSE_STREAM 청크 디코딩, `s3.BucketDeployment` (web/dist zip → S3), `BlockPublicAccess.BLOCK_ACLS` (2023+ 신버킷 함정), `VITE_*` env 가 **빌드 타임 substitute** 되는 메커니즘.
- **타협**: HTTP (HTTPS 없음 — S3 website endpoint 의 한계), 캐시 무효화 불가, 두 도메인 (S3 호스팅 + Function URL) 을 브라우저가 따로 인지.
- **남긴 숙제**: 단일 도메인 / HTTPS / origin 좁히기 → Day 9.

### Day 9 — "통합 + 잠금 + HTTPS"
- **새로움**: CloudFront `Distribution` multi-origin (default S3 + `/api/*` Function URL), `S3BucketOrigin.withOriginAccessControl()` 한 줄로 OAC + 버킷 정책, `OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER` 의 의미 (Function URL SNI 보호), CloudFront Function 인라인 4줄로 URI rewrite (`/api/foo` → `/foo`), `CACHING_OPTIMIZED` vs `CACHING_DISABLED` 분기, `BucketDeployment(distributionPaths:['/*'])` 자동 invalidation, `errorResponses` 로 SPA fallback.
- **타협**: `cloudfront.net` 기본 도메인 (ACM/Route53 X), CDK 차원에서 Lambda@Edge 미도입 (CF Function 만), `/api`(슬래시 없음) 엣지케이스가 SPA fallback 으로 빨려들어가는 quirk.
- **남긴 숙제** = Phase 3 진입점: Custom 도메인 + ACM, Lambda@Edge, Agent Loop, IoT MQTT.

## 🔁 5일 내내 반복된 6가지 패턴

한 번 익히면 Phase 3 에서도 그대로 쓰는, **횡단 자산**:

### 1. "한 리소스에 한 권한" — IAM 의 명시성
- Day 5: `table.grantReadWriteData(fn)` + `addToRolePolicy(bedrock:InvokeModel)`
- Day 6: 위 + `bedrock:InvokeModelWithResponseStream` 추가 (스트림 호출은 별도 action)
- Day 9: S3 의 OAC bucket policy 는 `withOriginAccessControl()` 한 줄로 자동
- → CDK 의 헬퍼가 있는 권한 (`grantReadWriteData`) 과 없는 권한 (`addToRolePolicy`) 을 구분해서 다루는 감각.

### 2. "환경변수로 분리" — 코드 안 건드리고 튜닝
- 매일 빠짐없이 등장: `TABLE_NAME`, `MODEL_ID`, `HISTORY_LIMIT`, `VITE_API_BASE`, `FUNCTION_URL` 등
- 빌드 타임 (Vite `VITE_*` 가 substitute) vs 런타임 (Lambda env) 의 차이를 Day 8 에서 명확히 함

### 3. "user 메시지 먼저 Put, assistant 마지막에 Put"
- Day 5 부터 일관되게: 호출 도중 에러 나도 user 입력은 살아남게
- Day 7 에서 SK 충돌 막으려 `${ts}#${uuid}` 합성. PK+SK 만 살짝 진화했지 흐름은 그대로

### 4. "RemovalPolicy.DESTROY + autoDeleteObjects"
- 학습 단계 — DDB / S3 / Lambda 모두 destroy 한 줄로 정리되게
- Phase 3 에선 production 이 아니어도 일부 리소스 (IoT 토픽 등) 는 정리 패턴이 달라질 것

### 5. "PowerShell + curl + 한글 페이로드" 정형 패턴
- Day 5/6/8 README 모두에 등장하는 BOM 함정. 결국 다음 패턴이 표준화됨:
  ```powershell
  $enc = [System.Text.UTF8Encoding]::new($false)  # no BOM
  [System.IO.Directory]::SetCurrentDirectory((Get-Location).Path)  # .NET cwd 동기화
  [System.IO.File]::WriteAllBytes($absPath, $enc.GetBytes($json))
  curl.exe --no-buffer -N -X POST $URL -H "content-type: application/json" --data-binary "@payload.json"
  ```
- 같은 함정을 3번 만났으므로 이제 Phase 3 에선 한 번에 정확히 친다

### 6. "매 day = 독립 CDK 프로젝트 + npm run deploy 한 줄"
- 각 day-XX 폴더가 자기 완결적인 학습 단위
- `deploy` 스크립트가 `web:build → cdk deploy --require-approval never` 묶음 (Day 8 부터)
- 의존성은 day 마다 독립 설치 — node_modules 격리로 버전 충돌 0

## 🐛 누적된 트러블슈팅 — 다시 안 밟을 함정 12종

| # | 함정 | 발견 | 해결 |
|---|---|---|---|
| 1 | DDB `Scan` 으로 멀티턴 가져오면 비용·성능 폭발 | Day 5 | PK+SK 로 `Query` |
| 2 | Bedrock `resources:['*']` 는 학습 OK, 실서비스에선 foundation-model + inference-profile **둘 다** 명시 필요 | Day 5 | 두 ARN 명시 |
| 3 | 같은 ms 두 메시지 → SK 충돌 → 한 건이 덮어써짐 | Day 5 (예고) → Day 7 (해결) | SK = `${ISO}#${uuid}` 합성 |
| 4 | Bedrock `ValidationException: messages[0].role must be user` | Day 5 | 첫 메시지 = user 보장 가드 |
| 5 | 응답이 토막이 아니라 한 번에 옴 | Day 6 | `invokeMode: RESPONSE_STREAM` + curl `-N` 둘 다 필요 |
| 6 | `AccessDeniedException: bedrock:InvokeModelWithResponseStream` | Day 6 | stream 전용 action 추가 |
| 7 | `responseStream.end()` 누락 → Lambda timeout 까지 매달림 | Day 6 | try/finally 로 `end()` 보장 |
| 8 | Function URL `cors.allowedMethods` 에 `OPTIONS` 넣으면 deploy 깨짐 | Day 6 | OPTIONS 는 Function URL 자동 처리 — 명시 X |
| 9 | 2023+ 신규 S3 의 `BlockPublicAccess` 가 `publicReadAccess:true` 를 막음 → 배포는 되는데 403 | Day 8 | `BLOCK_ACLS` (정책은 허용) + `BUCKET_OWNER_ENFORCED` |
| 10 | Vite `VITE_*` env 는 **빌드 타임** substitute — `.env` 만 바꿔서는 반영 안 됨 | Day 8 | `.env` 변경 시 무조건 재빌드+재배포 |
| 11 | CloudFront 가 viewer Host (`*.cloudfront.net`) 를 Function URL 에 그대로 보내면 즉시 403 | Day 9 | `OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER` |
| 12 | CloudFront origin path 는 PREPEND 만 됨 — `/api` strip 불가 | Day 9 | CloudFront Function (viewer-request) 로 URI rewrite |

12개 중 9개가 **"코드는 컴파일·deploy 되는데 실행 시점에 깨지는"** 종류. CDK synth 만으로는 안 잡힘 — 실배포 + 실호출까지 가야 발견. **이래서 매 day 마다 실배포 + curl 검증을 README 에 박는 패턴이 가치 있다**.

## 💰 비용 회고 — 실제 영수증 (us-east-1, 학습용)

### Phase 2 누적 (Day 5~9, 약 일주일)

| 항목 | 발생 | 비용 |
|---|---|---|
| **Bedrock Haiku 4.5** | ~50회 호출 (200in/200out 평균) | ~$0.07 (≈ 100원) |
| **Lambda 호출** | ~80회 (512MB × 평균 3초) | < $0.001 |
| **DynamoDB on-demand** | Query ~50 + Put ~100 | < $0.001 |
| **S3** | Day 8/9 객체 ~30KB × 수 회 PUT/GET | < $0.001 |
| **CloudFront 데이터 전송** | ~10MB out | $0 (무료티어 1TB/월) |
| **CloudFront 요청** | ~100 req | $0 (무료티어 10M/월) |
| **CloudFront Function** | ~50 호출 | $0 (무료티어 2M/월) |
| **DynamoDB 영구 storage** | KB 단위 | < $0.001 |
| **CloudWatch Logs** | Lambda 로그 ~1MB | < $0.001 |
| **총합** | | **~$0.07 (≈ 100원)** |

### 결정적 비용 = Bedrock 호출

- Bedrock 이 전체의 99% — 다른 모든 AWS 리소스 합쳐도 1센트 안 됨
- → 학습 단계 비용 절약 포인트는 **Bedrock 호출 줄이기** 뿐. 인프라 destroy 보다 호출 수 줄이는 게 효과적
- 매 배포 후 `cdk destroy` 패턴은 **비용 때문이 아니라 깨끗한 상태 보장** 이 본질 (cleanup 자산)

### "매 배포 후 destroy" 패턴이 유효한 이유

1. **CloudFront 분배 leftover** = 5~15분 propagation × 잊으면 누적
2. **DynamoDB 가 free tier 끝나면 storage 가 시간당 누적**
3. **S3 BucketDeployment 가 만드는 임시 Lambda + ECR 이미지** 가 destroy 안 하면 남음
4. 무엇보다 **destroy 가 안 되는 상태 (예: S3 가 비어있지 않아 거부) 를 학습 단계에서 미리 발견** 하는 게 production 가서 더 큰 사고를 막음

## 🧠 Phase 2 가 답하지 못한 질문들 → Phase 3 의 진입점

### 1. "Lambda 가 60초 넘게 일해야 하면?"
- 현재 Bedrock 응답은 평균 4초, 최대 10초. 60s timeout 안에 들어옴.
- **Agent Loop** (LLM tool calling) 은 도구 호출 결과를 다시 LLM 에 넣고… 반복. 5~10 step 이면 분 단위로 길어짐.
- → API Lambda 는 즉시 응답하고 **Worker Lambda 가 비동기로 돌면서 결과를 stream** 하는 패턴 필요. **Day 11**.

### 2. "응답이 stream 인데 클라이언트 연결이 끊기면?"
- 현재 fetch chunk 가 사라짐. 재접속해도 "어디까지 받았는지" 모름.
- **IoT Core MQTT** 로 sessionId 별 토픽에 publish → 클라이언트가 (재)구독하면 누락 없이 받음.
- → **Day 13**. Lambda 가 IoT 에 publish 하고, 브라우저는 IoT 에 직접 SigV4-signed WebSocket 으로 구독.

### 3. "브라우저가 AWS IoT 에 어떻게 직접 인증해?"
- IAM 사용자 키를 브라우저에 박는 건 미친 짓. Cognito identity pool 같은 정공법도 있지만 원본은 안 씀.
- 원본 패턴: **브라우저가 직접 mqtt.js v5 로 SigV4 쿼리스트링 서명 WSS 연결** — Lambda@Edge 가 일회용 자격증명을 viewer-request 단계에서 발급해 cookie 로 떨궈줌.
- → **Day 15, 16**. Lambda@Edge 는 us-east-1 전용이고 우리도 us-east-1 이라 호환.

### 4. "Agent 가 도구를 호출하려면?"
- Bedrock Converse 의 `toolConfig` + `toolUse` / `toolResult` 흐름.
- 원본은 도구 하나만 줌 — **`executeCode`**: LLM 이 TypeScript 코드를 만들어 보내면 sandbox 안에서 실행, 결과를 `toolResult` 로 되돌려줌. "어떤 도구를 쓸까" 가 아니라 "코드를 짠다 = 도구 선택" 이라는 단순화.
- → **Day 13**. Day 11 Worker 안에서 도는 while 루프 (`stop_reason == tool_use` 이면 sandbox 실행 후 재호출).

### 5. "DDB 한 테이블에 모든 게 다 들어가도 되나?"
- 현재 (`ConversationsTable`): 메시지만 저장. 원본은 **7개 테이블**로 분리 — users, sessions, messages, memory, skills 등 도메인별.
- 같은 PK pattern (sessionId) 으로 묶이는 entity 가 여러 종류일 때 single-table design vs multi-table 의 트레이드오프.
- → **Day 12**. Day 7 의 단일 테이블 → 최소 3개 (users, sessions, messages) 로 쪼개기.

### 6. "사용자가 Telegram / Notion 등 다른 채널에서 들어오면?"
- 현재는 브라우저만 호출자. 같은 Agent Loop 를 다른 inbound 채널이 부르려면 입구만 갈아끼우면 됨.
- 원본은 **로컬 dev 에서만** Telegram 을 부수적으로 다룸 — 메인 production 아키텍처 아님. 우리도 옵션으로 demote.
- → **Day 17+ 옵션**.

## 🗺️ Phase 3 day-by-day 플랜 (원본 정렬판, 2026-06-01)

원본 [breath103/serverless-agent](https://github.com/breath103/serverless-agent) 의 실구성 (`packages/{backend, frontend, edge, shared}`) 을 한 번 더 훑고 정렬한 결과. **원본 미사용 자원 (SQS / EventBridge / Cognito / API Gateway / 일반 WebSocket) 은 전부 제외**. Telegram 도 원본은 로컬 dev 전용이라 Day 17+ 옵션으로 demote.

| Day | 주제 | 새로 더할 핵심 리소스 | 원본 매핑 | 이전 day 와의 관계 |
|---|---|---|---|---|
| **11** | API ↔ Worker Lambda 분리 | 새 `Worker Lambda`, API Lambda 에 `lambda:InvokeFunction` 권한 + `InvocationType: Event` (SQS/EventBridge 없이) | `packages/backend` 의 api / worker 분리 | Day 7 의 한 Lambda 를 둘로 쪼개기, POST /chat 은 202 즉시 응답 + Worker async invoke |
| **12** | DynamoDB 멀티 테이블 분리 | `UsersTable` / `SessionsTable` / `MessagesTable` 최소 3개 (원본은 7) | 원본 `tables.ts` 의 도메인 분리 | Day 7 의 `ConversationsTable` 1개 → 3개로 normalize, IAM grant 도 테이블별 |
| **13** | Agent Loop + `executeCode` 단일 도구 | Bedrock `toolConfig` (도구 `executeCode` 만), `toolUse`/`toolResult` 흐름, **TS sandbox 간소화 실행** (vm2 또는 isolated-vm 대신 최소 Function constructor) | 원본 `executeCode` tool | Day 11 Worker 안에서 도는 while 루프, `stop_reason == tool_use` 면 sandbox 실행 후 재호출 |
| **14** | IoT Core MQTT — Worker → 토픽 publish | `IoT.Endpoint`, `sessions/${id}/events` 토픽, Worker 에 `iot:Publish` 권한, message envelope (`{type, content, ts}`) 표준화 | 원본 backend → MQTT publish | Day 13 Agent loop 의 출력 채널을 stream → MQTT 로 교체. 클라이언트 연결 끊겨도 토픽엔 남음 |
| **15** | 브라우저 ↔ MQTT WSS subscribe + SigV4 | mqtt.js v5, `wss://<iot-endpoint>/?X-Amz-Algorithm=...` 쿼리스트링 SigV4 서명 (브라우저 측), Day 14 envelope 디코딩 | 원본 frontend 의 mqtt 클라이언트 | Day 14 publisher 에 subscriber 붙이기. Day 8 의 `fetch.body.getReader` → MQTT subscribe 로 갈아끼움 |
| **16** | Lambda@Edge 로 Day 9 업그레이드 + SSM 캐싱 | `cloudfront.experimental.EdgeFunction` (us-east-1), viewer-request 에서 `/api/*` 라우팅, **SSM Parameter Store 로 backend Function URL 캐싱** (cold start 마다 deploy-time output 모름의 정공법) | 원본 `packages/edge` 그대로 | Day 9 의 CF Function 4줄 → Lambda@Edge 로 승격, SSM put 은 Day 11 Worker 배포 시 자동 |
| **17+** | 회고 + 비용/보안 + (옵션) Telegram skill | 문서 단계 + 옵션 `/telegram/webhook` 라우트 (원본 로컬 dev 패턴) | 원본 회고 / Telegram 옵션 | Phase 3 전체 마무리, `day-17-phase3-retro/` 작성 |

**가장 무거울 것 같은 day**: Day 13 (sandbox 실행 + tool loop 의 에러 처리), Day 15 (브라우저에서 SigV4 직접 서명 — 쿼리스트링 canonical 만들기가 까다로움), Day 16 (Lambda@Edge 의 us-east-1 전용 제약 + IAM Role 의 region pinning).

**원본 정렬에서 빠진 것 (의도적)**: SQS / EventBridge / Cognito / API Gateway / 일반 WebSocket — 원본 미사용. Telegram 은 학습 가치는 있지만 메인 흐름 끝난 뒤 옵션으로 추가.

## 🎁 Phase 2 가 남긴 자산

Phase 3 진입 시 그대로 쓰는 것들:

1. **`day-09-cloudfront/`** — CloudFront 분배 자체는 Day 16 에서 CF Function → Lambda@Edge 로 교체만 하면 됨 (multi-origin / OAC / `/api/*` behavior 구조 그대로)
2. **`day-07-history-api/`** — Hono 라우터 + DDB SK 합성 + 권한 패턴 (Day 12 에서 테이블만 분리)
3. **`day-08-frontend-vite/`** 에서 익힌 Vite + RESPONSE_STREAM 디코딩 — Day 15 에서 `fetch.body.getReader` 대신 `mqtt.js subscribe` 로 교체
4. **PowerShell + curl + 한글 BOM 회피** 정형 패턴
5. **매 day = 독립 CDK + npm run deploy + README 검증** 의 작업 리듬

## ▶️ 이 문서는 어떻게 사용하나

- Phase 3 시작 전에 1회 읽기 — "어디서 멈췄는지" 다시 매핑
- 새로운 함정 발견할 때마다 위 트러블슈팅 표에 한 줄 추가
- Phase 3 끝나면 같은 형식으로 `day-17-phase3-retro/` (또는 마지막 day 번호로) 작성 → Day 5~끝 의 큰 흐름이 한눈에

---

> **다음**: Day 11 부터 Phase 3. **API ↔ Worker Lambda 분리** 로 시작 — Day 7 의 한 Lambda 를 둘로 쪼개고 비동기 호출 (`InvocationType: Event`, SQS 없이) 패턴을 익힌다. 원본 `packages/backend` 가 정확히 이 모양.
