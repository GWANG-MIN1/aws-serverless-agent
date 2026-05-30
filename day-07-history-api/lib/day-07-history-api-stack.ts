import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

// Day 7 = Day 6 위에 멀티 라우트 + 히스토리 조회 API.
//
// Day 6 와의 차이:
//   - Hono 도입 → 같은 Function URL Lambda 안에서 POST(stream) + GET(buffered) 공존
//   - 메시지 SK 를 `ts` → `ts#uuid` 합성으로 변경 (동시 insert 충돌 방지, 원본 패턴)
//   - GET /sessions/:id/messages?limit=N — ScanIndexForward:false + reverse 로 "최근 N턴" 정확히 가져오기
//
// 원본(breath103/serverless-agent) 차용:
//   - lambda-api/handler.ts 의 streamHandle(app) 패턴
//   - chat-sessions-repository 의 SK = `${ISO}#${uuid}` 합성
// 생략:
//   - 인증/크레딧/세션 메타데이터 분리 (day-8 이후)
//   - beginGenerating 락 (Phase 3 worker 분리 때 의미가 살아남)

export class Day07HistoryApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1) Conversations 테이블
    //    스키마는 Day 6 와 모양상 동일하지만 (PK string / SK string),
    //    SK 의 의미가 `ts` 단독 → `ts#uuid` 합성으로 바뀜.
    //    DDB 입장에선 둘 다 그냥 STRING 이라 테이블 정의는 손댈 게 없음.
    //    같은 ms 에 들어오는 메시지가 덮어쓰이는 사고를 막는 게 목적.
    const table = new ddb.Table(this, 'ConversationsTable', {
      partitionKey: { name: 'sessionId', type: ddb.AttributeType.STRING },
      sortKey: { name: 'ts', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 2) Chat / History Lambda — 단일 함수 안에서 Hono 가 라우팅
    //
    //    Day 6 는 plain `lambda.Function` + `code.fromAsset(lambda/)` 였지만,
    //    이번엔 Hono npm 의존성이 들어가서 zip 에 node_modules 가 필요함.
    //    NodejsFunction(aws-cdk-lib/aws-lambda-nodejs) 가 esbuild 로 entry+deps 를
    //    단일 파일로 번들해줌 → Docker 없이 로컬 esbuild 만으로 처리.
    //
    //    aws-sdk 류는 Lambda 런타임에 이미 있으므로 externalModules 로 빼서
    //    번들 크기 줄임.
    const fn = new nodejs.NodejsFunction(this, 'ChatFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '..', 'lambda', 'handler.mjs'),
      handler: 'handler',
      memorySize: 512,
      timeout: cdk.Duration.seconds(60),
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: 'node20',
        // aws-sdk 류는 Lambda 런타임에 이미 포함 → 번들 제외로 크기 축소.
        externalModules: [
          '@aws-sdk/client-bedrock-runtime',
          '@aws-sdk/client-dynamodb',
          '@aws-sdk/lib-dynamodb',
        ],
      },
      environment: {
        TABLE_NAME: table.tableName,
        MODEL_ID: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
        HISTORY_LIMIT: '20',
      },
    });

    // 3) 권한 — Day 6 와 동일
    table.grantReadWriteData(fn);
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: ['*'],
    }));

    // 4) Alias("live") + Function URL — Day 6 패턴 그대로
    //    invokeMode 는 RESPONSE_STREAM 유지. Hono 의 streamHandle 이
    //    스트리밍 응답과 일반 JSON 응답 둘 다 같은 streaming Lambda 안에서 처리해줌.
    //    (GET 라우트는 그냥 Response 반환 → streamHandle 이 한 번에 흘려보냄)
    const fnAlias = new lambda.Alias(this, 'ChatFunctionAlias', {
      aliasName: 'live',
      version: fn.currentVersion,
    });

    const fnUrl = fnAlias.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
      cors: {
        allowedOrigins: ['*'],
        // Day 6 와 다르게 GET 도 추가. OPTIONS 는 enum 에 없음 (Function URL 이 자동 처리).
        allowedMethods: [lambda.HttpMethod.POST, lambda.HttpMethod.GET],
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
