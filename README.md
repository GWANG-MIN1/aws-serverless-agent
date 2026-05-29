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
**부품 학습 → MVP 조립 → 고급 패턴 차용** 3단계로 나눠 진행한다.

| Phase | 목표 | 대상 컴포넌트 |
|---|---|---|
| **Phase 1** | 부품 하나씩 익히기 | Lambda, DDB, Bedrock 각각 단독 |
| **Phase 2** | 연결된 MVP 챗봇 동작 | API Lambda + DDB + Bedrock + S3/CloudFront |
| **Phase 3** | 원본 고급 패턴 차용 | Agent Loop, IoT MQTT, Lambda@Edge, Telegram |

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
- [ ] **Day 7**: 대화 히스토리 저장/조회 + 멀티턴 컨텍스트
- [ ] **Day 8**: 최소 React 프론트 (Vite) + S3 정적 호스팅
- [ ] **Day 9**: CloudFront로 프론트 + API 통합 배포
- [ ] **Day 10**: Phase 2 회고 + 비용/구조 정리

### Phase 3: 원본 고급 패턴 차용

- [ ] **Day 11**: API Lambda / Worker Lambda 분리 (async invocation)
- [ ] **Day 12**: Agent Loop — LLM tool calling 구현
- [ ] **Day 13**: IoT Core MQTT로 실시간 스트리밍 응답
- [ ] **Day 14**: SigV4-signed WebSocket 인증
- [ ] **Day 15**: Lambda@Edge로 엣지 라우팅 (us-east-1 제약 확인)
- [ ] **Day 16**: Skill 추가 — Telegram 또는 Notion 등 외부 통합
- [ ] **Day 17+**: 회고, 비용 분석, 보안 강화

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
└── ...                    # Phase 2 진행 중 (Day 7+)
```

각 `day-XX-*/` 폴더는 독립 실행 가능한 CDK 프로젝트이며, 그날 배운 내용을 별도 README로 정리해둠.

## ⚠️ 비용 관리

학습 후 미사용 스택은 반드시 정리:

```bash
cd day-XX-*/
npx cdk destroy --force
```

DDB / Lambda 정도는 무료 티어 안에서 거의 무료지만, CloudFront + IoT + Lambda@Edge 가 추가되는 Phase 3부터는 월 몇 달러 발생 가능.
