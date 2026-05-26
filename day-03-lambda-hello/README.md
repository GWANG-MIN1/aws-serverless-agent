# Day 3: Lambda Hello World via AWS CDK

첫 AWS Lambda를 코드(CDK)로 정의하고 배포·호출까지.

## 🎯 학습 목표

- AWS CDK 프로젝트 구조 이해
- Lambda 함수를 코드로 정의하는 방법
- IaC(Infrastructure as Code) 흐름: synth → diff → deploy
- 배포된 Lambda를 CLI에서 호출하기

## 📐 CDK 프로젝트 구조

```
day-03-lambda-hello/
├── bin/day-03-lambda-hello.ts      ← 진입점: App 생성 + Stack 인스턴스화
├── lib/day-03-lambda-hello-stack.ts ← Stack 정의: AWS 리소스 코드
├── lambda/handler.mjs               ← 실제 Lambda 핸들러 코드
├── cdk.json                         ← CDK CLI 설정
├── package.json                     ← Node 의존성
└── tsconfig.json
```

**Stack vs App:**
- App = 배포 단위들의 컨테이너 (`new cdk.App()`)
- Stack = 함께 배포되는 AWS 리소스 묶음 (CloudFormation 1개 = Stack 1개)

## 📝 배운 것

### 1. CDK가 자동으로 해주는 것

`lambda.Function` 한 줄 선언하면 CDK가:
1. `lambda/` 폴더를 zip으로 묶음
2. S3 staging 버킷에 업로드
3. Lambda 함수 생성하면서 zip을 코드로 지정
4. **실행용 IAM Role 자동 생성** (`AWSLambdaBasicExecutionRole` 자동 부여 → CloudWatch Logs 쓰기 권한)
5. CloudWatch LogGroup 자동 생성

→ 이걸 콘솔에서 일일이 클릭하면 10분. CDK로는 30초.

### 2. `cdk bootstrap`은 계정당 1회만

CDK가 동작하려면 AWS 계정에 인프라가 필요함:
- `cdk-hnb659fds-assets-{account}-{region}` S3 버킷 (zip 업로드용)
- IAM Role 5개 (배포 권한, 파일 publish, 이미지 publish 등)
- CloudFormation Stack: `CDKToolkit`

`cdk bootstrap` 한 번 돌리면 위 인프라가 깔리고, 그 후엔 `cdk deploy`만 반복.

### 3. CDK 워크플로우

```bash
npx cdk synth          # CloudFormation 템플릿 미리보기 (배포 안 함)
npx cdk diff           # 배포된 것과 현재 코드 차이 확인
npx cdk deploy         # 실제 배포
npx cdk destroy        # 스택 통째로 삭제
```

`synth` → `diff` → `deploy` 가 안전한 순서. 처음엔 `--require-approval never` 옵션으로 권한 변경 프롬프트 스킵 가능.

### 4. Lambda 호출

```bash
aws lambda invoke \
  --function-name <함수이름> \
  --payload '{"name":"Gwangmin"}' \
  --cli-binary-format raw-in-base64-out \
  output.json
```

- `--cli-binary-format raw-in-base64-out`: AWS CLI v2의 payload 인코딩 이슈 우회
- 응답은 stdout이 아닌 파일로 떨어짐

### 5. Lambda 함수 핸들러 시그니처

```javascript
export const handler = async (event, context) => {
  // event:   호출자가 보낸 JSON
  // context: Lambda 런타임 정보 (함수명, 메모리, 남은시간 등)
  return { /* JSON 반환 */ };
};
```

- 비동기 함수면 `return` 값이 응답
- 예외 throw하면 호출자에게 에러로 전달

## 🐛 막혔던 곳

특별히 없음. CDK가 시키는 대로 했고 한 번에 됨.

> Node v20 환경에서 AWS SDK v3가 "2027년부터 Node 22+ 요구" 경고 띄움. 동작엔 문제 없음.

## 💰 비용

- Lambda 호출 1회: 약 **$0.0000002** (사실상 무료, 매달 1M회까지 무료 티어)
- CloudFormation 사용: 무료
- CDK bootstrap 시 만든 S3 버킷: 저장 용량만큼 (월 몇 원 수준)

학습 단계에선 비용 무시 가능.

## ▶️ 재현 방법

```bash
cd day-03-lambda-hello
npm install
npx cdk bootstrap     # 이미 했으면 스킵됨
npx cdk deploy --require-approval never

# 호출
aws lambda invoke \
  --function-name <Outputs에 찍힌 FunctionName> \
  --payload '{"name":"World"}' \
  --cli-binary-format raw-in-base64-out \
  output.json
cat output.json
```

## 🧹 정리

학습 끝나면 비용 누수 방지:
```bash
npx cdk destroy
```

> ⚠️ 이번 학습에선 일부러 안 지움 — Day 4 (DynamoDB)에서 같은 패턴 반복하면서 비교할 거라.

## 🔜 다음 단계 (Day 4)

DynamoDB 테이블을 CDK로 만들고 Lambda에서 read/write.
