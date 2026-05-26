# Day 4: DynamoDB CRUD via Lambda

DDB 테이블 생성 + Lambda에서 read/write. CDK가 권한 자동 부여하는 패턴 학습.

## 🎯 학습 목표

- DynamoDB 테이블을 CDK로 정의
- Lambda → DDB 호출 (AWS SDK v3)
- IAM 권한을 `table.grantReadWriteData(fn)` 한 줄로 부여
- Document Client로 marshalling 자동화

## 📐 아키텍처

```
User → aws lambda invoke → Lambda (NotesFunction) → DynamoDB (NotesTable)
                                    ↓
                           CloudWatch Logs (자동)
```

## 📝 배운 것

### 1. CDK에서 DDB 테이블 한 줄 정의

```ts
const table = new ddb.Table(this, 'NotesTable', {
  partitionKey: { name: 'id', type: ddb.AttributeType.STRING },
  billingMode: ddb.BillingMode.PAY_PER_REQUEST, // 사용량 과금
  removalPolicy: cdk.RemovalPolicy.DESTROY,     // 스택 삭제 시 테이블도 삭제 (학습용)
});
```

**billingMode 두 종류:**
- `PAY_PER_REQUEST` (on-demand) — 호출 건당 과금. 트래픽 예측 불가하거나 학습용
- `PROVISIONED` — RCU/WCU 미리 할당. 안정적 트래픽에 저렴

**removalPolicy:**
- `DESTROY` — 스택 삭제 시 테이블도 삭제 (데이터 날아감)
- `RETAIN` (default) — 스택 삭제해도 테이블 유지 (실서비스 안전판)

### 2. 권한 부여 — `table.grantReadWriteData(fn)` 마법

이 한 줄이 백그라운드에서 하는 일:
1. Lambda의 자동 생성된 IAM Role 찾음
2. 정확히 필요한 권한만 담은 IAM Policy 생성:
   - `dynamodb:BatchGetItem`, `dynamodb:GetItem`, `dynamodb:Query`, `dynamodb:Scan`
   - `dynamodb:BatchWriteItem`, `dynamodb:PutItem`, `dynamodb:UpdateItem`, `dynamodb:DeleteItem`
   - `dynamodb:ConditionCheckItem`, `dynamodb:DescribeTable`
3. 해당 테이블 ARN 으로 리소스 제한
4. Role에 Policy 부착

→ 콘솔에서 일일이 하면 5분, JSON 직접 쓰면 30줄. CDK는 1줄.

**더 좁은 권한도 가능:**
- `table.grantReadData(fn)` — 읽기만
- `table.grantWriteData(fn)` — 쓰기만
- `table.grant(fn, 'dynamodb:Query')` — 특정 액션만

### 3. AWS SDK v3 — `DynamoDBDocumentClient` 의 중요성

raw DynamoDB API는 타입을 명시해야 함:
```js
// 안 쓰면 이렇게 적어야 함 (지옥)
{ id: { S: "abc" }, count: { N: "5" }, tags: { L: [{ S: "a" }] } }
```

`DocumentClient`는 자동 변환:
```js
// 그냥 JS 객체로 OK
{ id: "abc", count: 5, tags: ["a"] }
```

→ 신규 코드는 무조건 `lib-dynamodb` 의 `DynamoDBDocumentClient` 사용.

### 4. Lambda에서 SDK import — Node 20 런타임 트릭

`@aws-sdk/client-dynamodb` 가 Node 20 Lambda 런타임에 **이미 포함**되어 있음.
→ `npm install` 안 해도 import만 하면 동작.
→ Lambda 패키지 크기 작아져서 콜드스타트 빠름.

### 5. 환경변수로 리소스 이름 전달

```ts
environment: { TABLE_NAME: table.tableName }
```

CDK가 deploy 시점에 실제 테이블명을 환경변수에 주입함.
핸들러에선 `process.env.TABLE_NAME`으로 읽음.

→ 코드에 테이블명 하드코딩 금지. 같은 코드로 dev/staging/prod 환경 분리 가능.

### 6. Scan은 학습용일 뿐 — 실서비스에선 금기

```js
new ScanCommand({ TableName: TABLE })
```

`Scan`은 전체 테이블 다 읽음 → 1만 건 테이블이면 1만 건 다 가져옴 → 비싸고 느림.
**실서비스에선 GSI(Global Secondary Index) + Query** 써야 함.

이번엔 학습 단순화를 위해 사용. Day 5+ 에서 패턴 개선 예정.

## ▶️ 실행 결과

```bash
# CREATE
{"ok":true,"action":"create","item":{"id":"5b4a...","title":"My first note","body":"DDB works!","createdAt":"2026-05-26T00:52:46Z"}}

# LIST
{"ok":true,"action":"list","count":1,"items":[...]}

# READ (존재)
{"ok":true,"action":"read","item":{...}}

# READ (없음)
{"ok":true,"action":"read","item":null}   ← 에러 아닌 null 반환
```

## 🐛 막혔던 곳

특별히 없음. CDK + grantReadWriteData 패턴이 정말 깔끔.

## 💰 비용

DynamoDB on-demand:
- Read: $0.25 / 1M requests
- Write: $1.25 / 1M requests

테스트 4번 호출 = **사실상 무료** ($0.000005)
저장 용량: 25GB까지 무료 티어, 그 이상 GB당 $0.25/월

## 🔜 다음 단계 (Day 5)

Lambda + DDB + Bedrock 통합 — 채팅 메시지를 DDB에 저장하면서 Bedrock에 LLM 호출, 응답도 저장.
**= MVP 챗봇의 첫 동작**
