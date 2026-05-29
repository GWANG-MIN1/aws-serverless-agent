import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

// Day 6 = Day 5 챗봇을 HTTP 로 노출 + Bedrock 응답을 토큰 단위 스트리밍.
//
// API Gateway (v1/v2) 가 아니라 Lambda Function URL 선택한 이유:
//   - 원본(breath103/serverless-agent) 패턴 차용
//   - API Gateway 는 v1/v2 모두 응답 스트리밍 미지원 → 챗봇 토큰 스트리밍이 안 됨
//   - Function URL + invokeMode=RESPONSE_STREAM 이 유일한 선택지
//
// 트레이드오프:
//   - 잃는 것: API key + usage plan, request validator, WAF 등 API GW 기능 전부
//   - 얻는 것: 토큰 단위 streaming, 단순함, 추가 비용 0 (Lambda 호출비만)

export class Day06FunctionUrlStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1) Conversations 테이블 — Day 5 와 동일 스키마
    const table = new ddb.Table(this, 'ConversationsTable', {
      partitionKey: { name: 'sessionId', type: ddb.AttributeType.STRING },
      sortKey: { name: 'ts', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 2) Chat Lambda
    //    Day 5 와 거의 동일. 차이는 핸들러가 streamifyResponse 패턴이라는 것뿐.
    //    CDK 입장에선 streaming 여부는 invokeMode 로만 표현되고,
    //    Function 정의 자체는 동일하다.
    const fn = new lambda.Function(this, 'ChatFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda')),
      memorySize: 512,
      timeout: cdk.Duration.seconds(60),
      environment: {
        TABLE_NAME: table.tableName,
        MODEL_ID: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
        HISTORY_LIMIT: '20',
      },
    });

    // 3) 권한 — Day 5 와 동일
    table.grantReadWriteData(fn);
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: ['*'],
    }));

    // 4) Alias("live") 위에 Function URL 부착
    //    원본 패턴. 왜 alias 를 끼우는가:
    //    - Function URL 을 $LATEST 가 아닌 특정 version 에 고정 → 배포 중에도 URL 안정
    //    - 가중치 기반 traffic shifting (canary 배포) 의 자리 잡아둠
    //    - 학습 단계라 canary 안 쓰지만 패턴은 미리 따라둠
    const fnAlias = new lambda.Alias(this, 'ChatFunctionAlias', {
      aliasName: 'live',
      version: fn.currentVersion,
    });

    const fnUrl = fnAlias.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE, // 학습용 공개. 실서비스면 IAM/Cognito.
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
      cors: {
        // 학습용 와이드 오픈. day-9 CloudFront 붙이면 도메인 좁힐 것.
        allowedOrigins: ['*'],
        // OPTIONS preflight 는 Function URL 이 자동 처리. enum 에 OPTIONS 없음.
        allowedMethods: [lambda.HttpMethod.POST],
        allowedHeaders: ['content-type'],
        maxAge: cdk.Duration.hours(1),
      },
    });

    // 5) Outputs
    new cdk.CfnOutput(this, 'FunctionUrl', { value: fnUrl.url });
    new cdk.CfnOutput(this, 'FunctionName', { value: fn.functionName });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
