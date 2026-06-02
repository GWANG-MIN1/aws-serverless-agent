import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

// Day 11 = Day 7 의 단일 Lambda 를 API ↔ Worker 두 개로 쪼개기.
//
// 원본(breath103/serverless-agent) 매핑:
//   packages/backend/scripts/lib/backend-stack.ts
//     Handler  (lambda-api/handler.handler, mem 1769, timeout 30s)   ← 우리의 ApiFunction
//     Worker   (worker/handler.handler,     mem 512,  timeout 5min)  ← 우리의 WorkerFunction
//     workerAlias.grantInvoke(fn)                                    ← 그대로 차용
//     env: AGENT_WORKER_FUNCTION_NAME = workerAlias.functionArn      ← API 가 invoke 대상을 안다
//
// Day 7 과의 핵심 변화:
//   - POST /chat 이 더 이상 Bedrock 을 직접 부르지 않음.
//     API 는 user 메시지만 DDB 에 박고 Worker 를 `InvocationType: Event` 로 async invoke 한 뒤 202 즉시 응답.
//   - Worker 가 Bedrock Converse (스트리밍 X) → assistant 메시지 DDB 저장.
//     "스트리밍 응답이 어디로 가느냐" 는 Day 14 (IoT MQTT publish) 에서 부활. 오늘은 결과를 DDB GET 으로 확인.
//   - Function URL 은 BUFFERED 로 다운그레이드 — POST 가 202 즉시 응답이므로 RESPONSE_STREAM 의미가 없음.
//
// SQS 없이 Lambda 직접 async invoke 만 쓰는 이유 = 원본이 그렇게 함.
// SQS 가 주는 것 (재시도/DLQ/visibility) 은 Lambda async invoke 도 일부 기본 제공(2회 재시도 + DLQ 설정 가능)이라 학습 단계 충분.

export class Day11ApiWorkerSplitStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1) Conversations 테이블 — Day 7 과 동일 스키마 그대로.
    //    Day 12 에서 users/sessions/messages 3개로 쪼갤 예정. 오늘은 손대지 않음.
    const table = new ddb.Table(this, 'ConversationsTable', {
      partitionKey: { name: 'sessionId', type: ddb.AttributeType.STRING },
      sortKey: { name: 'ts', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 2) Worker Lambda — Bedrock 호출 + assistant 저장 담당.
    //
    //    원본은 `worker/handler.handler` 처럼 같은 dist 의 다른 엔트리를 가리킴.
    //    우리는 NodejsFunction 으로 각각 별도 번들을 만든다 — 단일 day 학습 단위라
    //    공유 dist 빌드 파이프라인까지 도입하면 무거워짐. 같은 lambda/ 폴더의
    //    다른 .mjs 두 개를 각각 entry 로 잡아 esbuild 가 알아서 트리쉐이킹.
    //
    //    timeout 을 5분(원본) 까지 가지 않아도 됨 — 오늘 Worker 는 Bedrock 한 번 호출 + DDB Put 두 번뿐.
    //    Day 13 에서 Agent Loop (tool 반복) 들어오면 그때 늘림. 지금은 60s 로 충분.
    const workerFn = new nodejs.NodejsFunction(this, 'WorkerFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '..', 'lambda', 'worker.mjs'),
      handler: 'handler',
      memorySize: 512,
      timeout: cdk.Duration.seconds(60),
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: 'node20',
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

    // Worker 권한 — Bedrock(non-stream) + DDB RW.
    // Day 7 에선 InvokeModelWithResponseStream 도 같이 줬지만 오늘은 안 씀. (Day 14 부터 다시 의미)
    table.grantReadWriteData(workerFn);
    workerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: ['*'],
    }));

    // Worker Alias("live") — 원본 패턴.
    //   - Alias 로 한 번 감싸야 나중에 canary/weighted routing 자리가 생김
    //   - grantInvoke 도 Alias 에 걸어야 API 가 alias ARN 으로 정확히 부를 수 있음
    const workerAlias = new lambda.Alias(this, 'WorkerFunctionAlias', {
      aliasName: 'live',
      version: workerFn.currentVersion,
    });

    // 3) API Lambda — Hono 라우터 + DDB 읽기 + Worker async invoke.
    //    Bedrock 권한 없음 — API 는 모델을 직접 부르지 않는다 (책임 분리의 핵심).
    const apiFn = new nodejs.NodejsFunction(this, 'ApiFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '..', 'lambda', 'api.mjs'),
      handler: 'handler',
      memorySize: 512,
      timeout: cdk.Duration.seconds(30),
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: 'node20',
        externalModules: [
          '@aws-sdk/client-dynamodb',
          '@aws-sdk/lib-dynamodb',
          '@aws-sdk/client-lambda',
        ],
      },
      environment: {
        TABLE_NAME: table.tableName,
        HISTORY_LIMIT: '20',
        // 원본과 동일한 env 이름.
        // 값은 alias ARN — 같은 함수의 $LATEST/다른 alias 와 명시적으로 구분됨.
        AGENT_WORKER_FUNCTION_NAME: workerAlias.functionArn,
      },
    });

    // API 권한
    //   - DDB: user 메시지 Put + 히스토리 Query
    //   - Lambda: workerAlias 한정 InvokeFunction (Async invoke 도 같은 action)
    table.grantReadWriteData(apiFn);
    workerAlias.grantInvoke(apiFn);

    // 4) API Alias + Function URL (BUFFERED)
    //    Day 6/7/9 의 RESPONSE_STREAM 다운그레이드:
    //    POST /chat 이 202 즉시 응답 → 청크 흘려보낼 게 없음.
    //    Day 14 에서 "결과는 MQTT 토픽으로 push" 로 가면 BUFFERED 그대로 유지하면 됨.
    const apiAlias = new lambda.Alias(this, 'ApiFunctionAlias', {
      aliasName: 'live',
      version: apiFn.currentVersion,
    });

    const apiUrl = apiAlias.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.BUFFERED,
      cors: {
        allowedOrigins: ['*'],
        allowedMethods: [lambda.HttpMethod.POST, lambda.HttpMethod.GET],
        allowedHeaders: ['content-type'],
        maxAge: cdk.Duration.hours(1),
      },
    });

    // 5) Outputs
    new cdk.CfnOutput(this, 'ApiUrl', { value: apiUrl.url });
    new cdk.CfnOutput(this, 'ApiFunctionName', { value: apiFn.functionName });
    new cdk.CfnOutput(this, 'WorkerFunctionName', { value: workerFn.functionName });
    new cdk.CfnOutput(this, 'WorkerAliasArn', { value: workerAlias.functionArn });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
