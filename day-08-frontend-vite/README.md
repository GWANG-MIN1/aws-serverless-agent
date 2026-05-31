# Day 8: 최소 React 프론트 (Vite) + S3 정적 호스팅

Phase 2 네 번째. Day 7 까지 만든 Function URL 백엔드 위에 **브라우저 챗 UI** 를 얹는다. 라우팅·상태관리 라이브러리는 0개, 컴포넌트도 사실상 `App.tsx` 하나 — "프론트 한 줄로 붙이는 최소 단위" 가 목표.

원본 레포(breath103/serverless-agent)는 `packages/frontend` Vite + React 를 CloudFront + Lambda@Edge + private S3 (OAI) 와 함께 한 번에 묶지만, Day 8 은 **S3 정적 웹사이트 호스팅** + Function URL 직접 fetch 까지만 한다. Day 9 에서 CloudFront 를 얹으면서 origin 을 좁힌다.

## 🎯 학습 목표

- Vite + React + TS 최소 셋업 (라우팅·상태관리 라이브러리 없이)
- `fetch` 의 `ReadableStream` 으로 RESPONSE_STREAM Lambda chunk 읽기
- S3 정적 웹사이트 호스팅 (`websiteIndexDocument`) + 신 버킷 기본 BlockPublicAccess 와 싸우는 법
- `aws-cdk-lib/aws-s3-deployment` 의 `BucketDeployment` — 빌드 산출물을 zip 으로 올려 풀기
- Vite env (`VITE_*` prefix + `import.meta.env`) — 빌드 타임 endpoint 주입

## 📐 아키텍처

```
                      브라우저 (S3 website endpoint)
                              │
        ┌─────────────────────┴─────────────────────┐
        │                                           │
GET index.html / *.js                       fetch (CORS *)
        │                                           │
        ▼                                           ▼
┌──────────────────────────┐          ┌────────────────────────┐
│  S3 WebBucket            │          │ Day 7 Function URL     │
│  websiteIndexDocument    │          │  ├─ POST /chat (stream)│
│  publicReadAccess        │          │  ├─ GET  /sessions/... │
└──────────────────────────┘          │  └─ GET  /health       │
        ▲                              └──────────┬─────────────┘
        │                                         │
   BucketDeployment                           DynamoDB + Bedrock
   (web/dist zip 업로드)                      (Day 7 스택 그대로)
```

Day 8 스택은 **버킷 + 업로드 2 리소스만** 만든다. 백엔드 인프라(Lambda/DDB/Bedrock)는 Day 7 스택을 그대로 재사용 — `VITE_FUNCTION_URL` 로 빌드 타임에 주입할 뿐.

## 🗂️ 폴더 구조

```
day-08-frontend-vite/
├── bin/day-08-frontend-vite.ts        # CDK 엔트리
├── lib/day-08-frontend-vite-stack.ts  # S3 + BucketDeployment
├── cdk.json / tsconfig.json / package.json
└── web/                                # Vite React 앱 (독립 package.json)
    ├── index.html
    ├── vite.config.ts
    ├── .env.sample                     # VITE_FUNCTION_URL 템플릿
    └── src/
        ├── main.tsx
        ├── App.tsx                     # 채팅 UI (히스토리 + 스트리밍)
        ├── chat.ts                     # Function URL fetch 클라이언트
        └── styles.css
```

## 🧠 왜 S3 website endpoint 인가 (Day 9 의 CloudFront 가 아니라)

선택지:

|  | 무엇 | 장점 | 단점 |
|---|---|---|---|
| **S3 website endpoint** | `http://...s3-website-...amazonaws.com` | 1 리소스, 즉시 동작 | http only, 캐시 무효화 불가, custom error 없음 |
| S3 + CloudFront (OAI/OAC) | private bucket + CDN | https, 캐시, edge | 리소스 4~6개, ACM/배포 시간 |
| Amplify Hosting | 매니지드 | git push 만 | 학습 의도와 안 맞음 |

Phase 2 의 "**연결된 MVP 가 동작하는 게 우선**" 원칙. Day 8 의 핵심 학습은 "브라우저 → Function URL 직접 fetch + 스트리밍" 이지, CDN 셋업이 아님. **CloudFront 셋업의 가치를 Day 9 한 통으로 몰아서** origin lockdown 까지 같이 다룬다.

## 🧠 BlockPublicAccess — 신 버킷이 막는 이유

S3 는 2023 년부터 신규 버킷의 **모든 BlockPublicAccess 4종** 이 기본 ON. `publicReadAccess: true` 만 주면 CDK 가 bucket policy 를 붙이긴 하지만, `blockPublicPolicy` 가 막아서 정책이 무시됨 → 배포는 되는데 브라우저는 403.

```ts
blockPublicAccess: s3.BlockPublicAccess.BLOCK_ACLS,
//   ↑ ACL 류만 막고 bucket policy 는 허용 (3종 ON / blockPublicPolicy 만 OFF)
objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
//   ↑ ACL 자체를 끔 — 권한은 정책으로만 (2023 이후 신규 기본)
```

Day 9 의 CloudFront + OAC 로 가면 버킷은 **다시 private** 으로 잠그고, CloudFront 만 읽을 수 있게 정책을 다시 깎는다.

## 🧠 RESPONSE_STREAM chunk 읽기 — `fetch().body.getReader()`

Day 7 Function URL 은 `invokeMode: RESPONSE_STREAM` 으로 Bedrock 토큰을 raw chunk 로 흘려보낸다 (SSE/JSON 이벤트 포장 없음). 브라우저에선 그냥 `ReadableStream` 그대로 읽으면 됨:

```ts
const res = await fetch(`${FUNCTION_URL}chat`, { method: 'POST', body: JSON.stringify({...}) });
const reader = res.body!.getReader();
const decoder = new TextDecoder();
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  onToken(decoder.decode(value, { stream: true }));   // chunk 그대로 누적
}
```

`TextDecoder` 의 `{ stream: true }` 가 멀티바이트 경계를 잘라 먹지 않게 해줌 — 한글이 끊겨도 다음 청크와 합쳐 디코드. 마지막에 인자 없이 한 번 더 호출해 tail flush.

## 🧠 Vite env — 빌드 타임 vs 런타임

`VITE_*` prefix 가 붙은 env 만 `import.meta.env` 에 노출되고, 그 값은 **빌드 타임에 문자열로 substitute** 된다. 즉 `web/dist/assets/index-XXX.js` 안에 Function URL 이 박혀 있음.

런타임 환경변수 (CloudFront 단에서 주입) 가 아니라는 점에 주의:
- Day 7 의 Function URL 이 바뀌면 → **재빌드 + 재배포** 필요
- 더 깔끔하게 하려면 `/config.json` 같은 파일을 S3 에 같이 올리고 부팅 시 fetch — 학습 단계에선 과함

## ▶️ 배포 & 테스트

### 0) Day 7 가 살아있어야 함

이 스택은 Day 7 의 Function URL 을 부르므로 Day 7 이 배포되어 있어야 한다. 아니면 먼저:

```bash
cd ../day-07-history-api
npx cdk deploy
# → Day07HistoryApiStack.FunctionUrl 출력 메모
```

### 1) Function URL 을 env 에 넣기

```bash
cd day-08-frontend-vite/web
cp .env.sample .env
# .env 의 VITE_FUNCTION_URL 에 Day 7 의 출력값 붙여넣기
```

### 2) 의존성 + 빌드 + 배포

```bash
cd day-08-frontend-vite
npm install
npm run web:install          # web/ 의존성
npm run deploy               # web:build → cdk deploy
```

배포 끝나면:
```
Day08FrontendViteStack.BucketWebsiteUrl = http://<bucket>.s3-website-us-east-1.amazonaws.com
```

### 3) 브라우저로 열기

위 URL 을 열면 session 입력 박스 + 빈 채팅창이 뜬다.
- 입력 → send → assistant 응답이 **토큰 단위로 stream 으로 흘러나옴**
- 새로고침해도 같은 sessionId 라면 히스토리가 다시 뜸 (Day 7 GET 으로 reload)
- 우상단 `new` 버튼 → 새 sessionId → 빈 대화

### 4) 로컬 dev 서버 (선택)

```bash
cd day-08-frontend-vite/web
npm run dev
# http://localhost:5173 — Function URL 은 .env 의 값 그대로 부름
```

CORS 가 `*` 라 localhost 에서도 그대로 호출됨.

## 🐛 막힐 만한 곳

### 브라우저에서 403 Forbidden — index.html 가 안 뜸

- 십중팔구 BlockPublicAccess 가 정책을 막은 경우. CDK 로 만들면 위 코드대로 자동인데, 콘솔에서 만든 버킷이라면 "퍼블릭 액세스 차단" 의 `blockPublicPolicy` 가 켜져 있을 수 있음.

### 브라우저에서 CORS 에러 — Function URL fetch 가 막힘

- Day 7 의 CORS 가 `*` 인지 확인. `cors.allowedMethods` 에 `POST`, `GET` 둘 다 있어야 함 (Day 7 스택 코드 참조).
- 사전요청(OPTIONS) 은 Function URL 이 자동 처리하므로 신경 안 써도 됨.

### 채팅이 chunk 가 아니라 한 번에 떨어짐

- 어떤 브라우저/네트워크 환경에선 응답을 버퍼링해서 chunk 의미가 사라질 수 있음. DevTools Network 탭에서 Response Headers 에 `Transfer-Encoding: chunked` 가 있는지 확인.
- 사내 프록시/CDN 이 끼면 버퍼링 가능 — Day 9 의 CloudFront 도 기본은 버퍼링 모드라 별도 설정 필요.

### 빌드 후 변경한 Function URL 이 반영 안 됨

- `VITE_*` 는 **빌드 타임** 치환. `.env` 만 바꾸고 `npm run deploy` 안 돌리면 옛 URL 박힌 채로 배포됨.

### `BucketDeployment` 가 Lambda 권한 에러

- 처음 한 번은 BucketDeployment 가 임시 Lambda + 임시 버킷을 만들면서 CDK Bootstrap 이 필요. 다른 day 에서 이미 bootstrap 했으면 그대로 통과.

## 💰 비용 감각

- S3 storage: web/dist 가 ~200KB → 무시 가능
- S3 GET: 1000회당 $0.0004 — 학습 단계 무료 티어 내
- 데이터 전송 out: 첫 100GB 무료
- BucketDeployment 임시 Lambda: 배포마다 몇 초만 돌고 꺼짐 → 무료 티어 내

**Day 7 Function URL 호출 비용** (Day 7 와 동일):
- POST /chat: ~$0.0014/회 (Bedrock 200/200 토큰 기준)
- GET history: ~$0.000002/회

## 🔜 다음 단계 (Day 9)

- CloudFront 분배 + S3 origin (private, OAC)
- 같은 도메인 뒤에서 `/api/*` → Function URL 로 라우팅 (Day 11 의 Lambda@Edge 사전 정지작업)
- HTTPS / 기본 `*.cloudfront.net` 호스트로 ACM 없이 시작
