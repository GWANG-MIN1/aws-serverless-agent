# Serverless Agent

> 📚 Based on [breath103/serverless-agent](https://github.com/breath103/serverless-agent)
> (AWS Summit Korea 2026 DEV308)

AWS 서버리스 인프라 위에서 동작하는 AI 에이전트를, 원본 레퍼런스를 분해해서 **부품 → 조립 → 고급 패턴** 순으로 직접 만들어보는 학습 프로젝트.

## 🎯 학습 목표
- AWS 서버리스 아키텍처 실전 적용 (Lambda, DynamoDB, Bedrock, IoT Core)
- LLM 에이전트 시스템 설계 이해
- Lambda@Edge + SigV4 WebSocket 인증 흐름

## 🗺️ 로드맵

원본 아키텍처를 한 번에 따라 만들면 어디서 막혔는지 알기 어렵다.
**부품 학습 → MVP 조립 → 고급 패턴 차용 → 내 색깔** 4단계로 나눠 진행한다.

| Phase | 목표 | 대상 컴포넌트 |
|---|---|---|
| **Phase 1** | 부품 하나씩 익히기 | Lambda, DDB, Bedrock 각각 단독 |
| **Phase 2** | 연결된 MVP 챗봇 동작 | API Lambda + DDB + Bedrock + S3/CloudFront |
| **Phase 3** | 원본 고급 패턴 차용 | Agent Loop, IoT MQTT, Lambda@Edge, Telegram |
| **Phase 4** | 원본에서 갈라지기 | Cost Explorer skill, Discord 봇, X-Ray/관측성 |

---

## 📝 진행 상황

### Phase 1: 부품 학습

각 AWS 서비스를 단독으로 다뤄보면서 "어디서 막혔는지" 정확히 짚을 수 있게 만든다.

- [x] **Day 1**: AWS 계정 + IAM 유저 + CLI 세팅
- [x] **Day 2**: Bedrock 모델 액세스 + Claude API 호출 → [`day-02-bedrock/`](./day-02-bedrock/)
- [x] **Day 3**: Lambda Hello World 배포 (CDK) → [`day-03-lambda-hello/`](./day-03-lambda-hello/)
- [x] **Day 4**: DynamoDB CRUD via Lambda → [`day-04-dynamodb/`](./day-04-dynamodb/)

### Phase 2: MVP 챗봇 조립

부품을 연결해서 "유저가 채팅 → API Lambda → DDB 저장 → Bedrock 호출 → 응답" 흐름을 한 줄로 잇는다.

- [x] **Day 5**: Lambda + DDB + Bedrock 통합 (서버 측 챗봇 API) → [`day-05-chat-mvp/`](./day-05-chat-mvp/)
- [x] **Day 6**: Lambda Function URL + 응답 스트리밍 → [`day-06-function-url/`](./day-06-function-url/) <br/>&nbsp;&nbsp;&nbsp;&nbsp;<sub>※ 원본 레포가 API GW 대신 Function URL + RESPONSE_STREAM 사용하여 노선 변경</sub>
- [x] **Day 7**: Hono 멀티 라우트 + 히스토리 조회 API (SK 합성, `ScanIndexForward:false`) → [`day-07-history-api/`](./day-07-history-api/)
- [x] **Day 8**: 최소 React 프론트 (Vite) + S3 정적 호스팅 (BlockPublicAccess BLOCK_ACLS, BucketDeployment) → [`day-08-frontend-vite/`](./day-08-frontend-vite/)
- [x] **Day 9**: CloudFront 로 프론트 + API 통합 (S3 private/OAC + `/api/*` → Function URL + CF Function URL rewrite) → [`day-09-cloudfront/`](./day-09-cloudfront/)
- [x] **Day 10**: Phase 2 회고 — Day 5~9 진화, 누적 트러블슈팅 12종, 실비용 ~$0.07, Phase 3 day-by-day 플랜 → [`day-10-phase2-retro/`](./day-10-phase2-retro/)

### Phase 3: 원본 고급 패턴 차용

> 2026-06-01 정합성 점검 — 원본 [breath103/serverless-agent](https://github.com/breath103/serverless-agent) 실구성 (`packages/{backend,frontend,edge,shared}`, DDB 멀티 테이블, IoT Core MQTT, Lambda@Edge + SSM) 에 맞춰 플랜 재정렬. SQS/EventBridge/Cognito/API GW 는 원본 미사용이라 제외.

- [x] **Day 11**: API ↔ Worker Lambda 분리 — `InvocationType: Event` async invoke (SQS 없이 원본 패턴 그대로) → [`day-11-api-worker-split/`](./day-11-api-worker-split/)
- [x] **Day 12**: DynamoDB 멀티 테이블 분리 — `ConversationsTable` 1개 → Users / Sessions / Messages 3개 (원본 `users`/`chat-sessions`/`chat-messages` 키 스키마 미러). `SessionsTable` PK=`user_id` 로 "유저별 세션 목록" Query 가 열림 → [`day-12-multi-table/`](./day-12-multi-table/)
- [x] **Day 13**: Agent Loop + `executeCode` 단일 도구 — Worker 가 Bedrock Converse `toolUse`/`toolResult` 를 루프로 왕복(`node:vm` 샌드박스 + `read()`), 단계별 `kind` 행 저장, timeout 60s→5min → [`day-13-agent-loop/`](./day-13-agent-loop/)
- [x] **Day 14**: IoT Core MQTT — Worker 가 Agent Loop 각 단계를 저장하는 순간 `sessions/${id}/events` 토픽에 publish (`IoTDataPlaneClient`, `iot:DescribeEndpoint(Data-ATS)` 런타임 조회 + `iot:Publish` 토픽 한정 IAM, best-effort) → [`day-14-iot-mqtt/`](./day-14-iot-mqtt/)
- [x] **Day 15**: 브라우저 ↔ MQTT WSS 직접 subscribe — API 가 `GET /sessions/:id/realtime` 로 SigV4-presigned WSS URL 발급(STS AssumeRole + 세션정책으로 그 세션 토픽만 구독 허용), 브라우저는 mqtt.js(esm.sh)로 구독·렌더. 페이지는 localhost 검증(호스팅은 Day 16) → [`day-15-browser-mqtt/`](./day-15-browser-mqtt/)
- [x] **Day 16**: Lambda@Edge 로 Day 9 CF Function 업그레이드 — CloudFront+S3 호스팅(same-origin `/api`), origin-request Lambda@Edge 가 `/api/*` 를 **SSM Parameter Store(`/serverless-agent/backend/url`)** 에서 읽은 backend Function URL 로 origin 동적 교체 + `/api` strip (백엔드/CDN 디커플링, cold start 60s 캐시) → [`day-16-lambda-edge/`](./day-16-lambda-edge/)
### Phase 4: 내 색깔 — 원본에서 갈라지기

> 원본 코어(Agent Loop·IoT·Edge) 재현이 끝나, 여기서부턴 원본과 다르게 확장한다.

- [x] **Day 17**: `awsCost` skill — Day 13 에서 들어냈던 "샌드박스 skill 주입"을 되살려, `executeCode` 안에 `awsCost()` 함수를 넣음. "내 AWS 비용 얼마야?" 질문에 모델이 Cost Explorer 를 실제 호출(`ce:GetCostAndUsage`)해 답하고, `skillCalls` 로 호출을 추적(LLM 엔 비공개) → [`day-17-cost-skill/`](./day-17-cost-skill/)
- [x] **Day 18**: 디스코드 봇 — 원본 Telegram 대신 Discord Interactions 웹훅. 전용 Lambda 가 Ed25519 서명검증(node:crypto, 의존성 0) → PING/PONG → `/ask` 슬래시 → `type 5`(deferred) 즉시 반환 + Worker async 호출, Worker 가 끝나면 followup webhook 을 PATCH 해 답을 채움. 기존 Agent Loop+`awsCost` skill 그대로 재사용 → [`day-18-discord-bot/`](./day-18-discord-bot/)
- [x] **Day 19**: 캘린더 skill — 아이폰(iCloud) 캘린더의 **공개 `.ics` 링크**를 읽어, 샌드박스에 `calendar()` skill 주입. "이번 주 일정 뭐 있어?" 에 실제 일정으로 답(읽기 전용, 애플 인증 불필요) → [`day-19-calendar-skill/`](./day-19-calendar-skill/)
- [x] **Day 20**: 관측성/운영 — X-Ray 분산추적(api/worker/discord `Tracing.ACTIVE` + `captureAWSv3Client` 로 API→Worker→Bedrock/DDB subsegment) + CloudWatch 대시보드(호출/에러/p99+Bedrock) + Worker/API 에러 알람 → SNS. Lambda@Edge 는 X-Ray 미지원이라 제외. 비용은 Day 17 에서 다뤄 예산 항목 제외 → [`day-20-observability/`](./day-20-observability/)
- [ ] **Day 21**: CI/CD — GitHub Actions 가 push 때 **OIDC 역할**로 `cdk deploy` 자동화(장기 키 없이 무키 배포). 환경/시크릿 분리
- [ ] **Day 22 (캡스톤)**: 전체 회고 — 아키텍처 종합 다이어그램 + 트러블슈팅 #1~70 요약 + 비용/보안 정리. "프로젝트 완성" 마침표

---

## 🧰 기술 스택

- **언어**: TypeScript / Node.js 20
- **IaC**: AWS CDK v2
- **컴퓨트**: Lambda, Lambda@Edge
- **저장**: DynamoDB, S3
- **AI**: AWS Bedrock (Anthropic Claude Haiku 4.5)
- **네트워크**: CloudFront, IoT Core (MQTT)
- **리전**: us-east-1 (Bedrock 최신 모델 + Lambda@Edge 호환)

## 🗂️ 폴더 구조

```
aws-serverless-agent/
├── day-02-bedrock/        # Phase 1
├── day-03-lambda-hello/   # Phase 1
├── day-04-dynamodb/       # Phase 1
├── day-05-chat-mvp/       # Phase 2 — Lambda + DDB + Bedrock 통합 ✅
├── day-06-function-url/   # Phase 2 — Function URL + Bedrock streaming ✅
├── day-07-history-api/    # Phase 2 — Hono 멀티 라우트 + 히스토리 GET ✅
├── day-08-frontend-vite/  # Phase 2 — Vite React + S3 정적 호스팅 ✅
└── ...
```

각 `day-XX-*/` 폴더는 독립 실행 가능한 CDK 프로젝트이며, 그날 배운 내용을 별도 README로 정리해둠. Day 9 이후 폴더는 위 "진행 상황" 섹션의 링크에서.

## ⚠️ 비용 관리

학습 후 미사용 스택은 반드시 정리:

```bash
cd day-XX-*/
npx cdk destroy --force
```

DDB / Lambda 정도는 무료 티어 안에서 거의 무료지만, CloudFront + IoT + Lambda@Edge 가 추가되는 Phase 3부터는 월 몇 달러 발생 가능.
