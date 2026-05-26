# Day 2: AWS Bedrock + Claude 첫 호출

로컬 Node.js에서 AWS Bedrock의 Claude Haiku 4.5 모델을 호출하는 가장 단순한 예제.

## 🎯 학습 목표

- AWS Bedrock에서 모델 호출 방식 이해
- Converse API vs InvokeModel API 차이 인지
- IAM 유저 credentials로 자동 인증 흐름
- Inference Profile (Global / US) 개념

## 📝 배운 것

### 1. Bedrock 모델 액세스 정책 변경 (2026년)

기존: "Model access" 페이지에서 명시적으로 활성화 요청
**현재**: serverless foundation model은 **첫 호출 시 자동 활성화**됨. 별도 신청 불필요.
예외: Anthropic 모델은 최초 사용자에 한해 use case 양식 1회 제출 필요.

### 2. Inference Profile ID 형식

```
{region-prefix}.{provider}.{model-name}-{date}-v{n}:{rev}
```

예시:
- `us.anthropic.claude-haiku-4-5-20251001-v1:0` — US 리전 한정
- `global.anthropic.claude-haiku-4-5-20251001-v1:0` — 글로벌 (여러 리전 자동 라우팅)

조회 명령:
```bash
aws bedrock list-inference-profiles --region us-east-1
```

### 3. Converse API > InvokeModel API

원래 Bedrock은 provider마다 request 포맷이 다 달랐음 (Claude는 `anthropic_version`, Llama는 `prompt` 등).
**Converse API**는 통합 인터페이스 — `messages` 배열만 넘기면 provider 무관하게 동작.
신규 코드는 무조건 Converse 권장.

### 4. 인증 흐름

코드에 access key 직접 안 박음. SDK가 자동으로 credentials chain 따라감:
1. 환경변수 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
2. `~/.aws/credentials` 파일 (← `aws configure`로 만든 것, 이번 케이스)
3. EC2/ECS instance role

→ 로컬 개발 시 `aws configure` 한 번 해두면 모든 SDK 자동 인증.

### 5. 비용 감각

Haiku 4.5 가격 (2026 기준):
- Input: $1.00 / 1M tokens
- Output: $5.00 / 1M tokens

123 tokens 호출 → **약 0.5원**. 학습 중엔 비용 걱정 거의 없음.

## ▶️ 실행 방법

```bash
cd day-02-bedrock
npm install
node hello-bedrock.mjs
```

## 🐛 막혔던 곳

### "ResourceNotFoundException: Model is marked by provider as Legacy"

처음에 `Claude 3.5 Haiku` 선택했더니 위 에러. 3.5 시리즈는 이미 Legacy 처리됨.
→ 최신 **4.5 시리즈** 사용해야 함.

### Node v20 SDK 경고

```
Warning: NodeVersionSupportWarning: ... will require node >=22.
```

AWS SDK v3가 2027년부터 Node 22+ 요구 예정. 동작엔 문제없지만 추후 업그레이드 필요.

## 🔜 다음 단계 (Day 3)

Lambda Hello World 배포 — 같은 Bedrock 호출을 Lambda에서 실행.
