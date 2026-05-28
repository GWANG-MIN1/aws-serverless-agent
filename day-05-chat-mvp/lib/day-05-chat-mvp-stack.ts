import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

// Day 5 = MVP 챗봇 1단계:
//   유저 메시지 → Lambda → (DDB 이력 조회 + 저장) → Bedrock 호출 → (응답 저장) → 반환
//
// 아직 API Gateway 없음. `aws lambda invoke` 로 직접 호출해 동작 검증함.
// HTTP 노출은 Day 6 에서 추가 예정.

export class Day05ChatMvpStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1) Conversations 테이블
    //    PK = sessionId  (한 대화 세션을 묶는 키)
    //    SK = ts         (ISO timestamp — 같은 세션 내 시간순 정렬용)
    //    → Query(sessionId="...", ScanIndexForward=true) 로 이력 시간순 조회 가능
    //    Scan 안 씀. 한 세션의 이력만 Query 로 가져옴 → 비용/속도 OK
    const table = new ddb.Table(this, 'ConversationsTable', {
      partitionKey: { name: 'sessionId', type: ddb.AttributeType.STRING },
      sortKey: { name: 'ts', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // 학습용
    });

    // 2) Chat Lambda
    //    timeout 30s — Bedrock 호출이 보통 1~5s 걸리지만 여유 둠
    //    memory 512 — JS 런타임 + SDK 두 개 (DDB + Bedrock) 띄우는 데 256은 빠듯
    const fn = new lambda.Function(this, 'ChatFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda')),
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      environment: {
        TABLE_NAME: table.tableName,
        // 모델 ID 도 환경변수로 빼둠 → 모델 교체 시 코드 수정 불필요
        MODEL_ID: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
        // 이력은 최근 N 턴만 컨텍스트로 사용 (토큰 비용 통제)
        HISTORY_LIMIT: '20',
      },
    });

    // 3) DDB 권한 — 이력 Query + 신규 메시지 Put
    table.grantReadWriteData(fn);

    // 4) Bedrock 권한
    //    grantInvoke 같은 헬퍼는 CDK 에 없음. 직접 IAM statement 부착.
    //    Resource = "*" 로 풀어둠. 실서비스에선 사용 중인 모델 ARN 만 허용해야 함:
    //      arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-4-5-*
    //      arn:aws:bedrock:*::inference-profile/global.anthropic.claude-haiku-4-5-*
    //    여러 리전 자동 라우팅(inference profile) 때문에 ARN 두 종류 다 필요.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: ['*'],
    }));

    // 5) Outputs
    new cdk.CfnOutput(this, 'FunctionName', { value: fn.functionName });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
