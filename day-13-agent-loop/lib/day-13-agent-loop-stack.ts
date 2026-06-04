import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

// Day 13 = Day 12 의 멀티 테이블 위에 Worker 를 "한 번 호출"에서 "Agent Loop" 로 키우기.
//
// Day 12 까지 Worker 는 Bedrock 을 단 한 번 Converse → assistant Put 으로 끝났다.
// Day 13 은 그 한 번을 루프로 바꾼다:
//   LLM 응답에 toolUse 가 있으면 → 코드 샌드박스 실행 → toolResult 를 되먹임 → 다시 LLM.
//   toolUse 가 없을 때까지 (또는 MAX_TURN_STEPS 까지) 반복.
//
// 원본(breath103/serverless-agent) 매핑 — packages/backend/src/agent-runtime/*:
//   orchestrate.ts   runChatTurn 의 for(step) 루프            ← 우리 worker.mjs 의 agent loop
//   tools.ts         executeCode 단일 도구 정의               ← worker 의 EXECUTE_CODE_TOOL
//   code-executor.ts node:vm 샌드박스 + read()               ← worker 의 runSandbox()
//   (원본은 Anthropic SDK + TypeChecker + skills. 우리는 Bedrock Converse 로 변환하고
//    TypeChecker/skills 를 들어내 "간소화 sandbox" 로 줄임 — Day 13 은 루프 흐름 한 가지만.)
//
// 인프라 변화 = 딱 두 가지. 나머지는 Day 12 그대로.
//   1) Worker timeout 60s → 300s(5min): 루프가 여러 번 LLM+샌드박스를 돈다 (Day 12 숙제).
//   2) MAX_TURN_STEPS env: 무한루프 안전장치(LLM 이 계속 toolUse 만 뱉는 경우 컷).
//
// 안 변하는 것: 테이블 3개, API↔Worker 분리, workerAlias.grantInvoke(api),
//   Function URL(BUFFERED), 책임 분리 IAM(API 는 Bedrock 모름 / Worker 는 lambda invoke 못 함).

export class Day13AgentLoopStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── 1) 도메인별 테이블 3개 (Day 12 그대로) ───────────────────────────
    const usersTable = new ddb.Table(this, 'UsersTable', {
      partitionKey: { name: 'id', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const sessionsTable = new ddb.Table(this, 'SessionsTable', {
      partitionKey: { name: 'user_id', type: ddb.AttributeType.STRING },
      sortKey: { name: 'id', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const messagesTable = new ddb.Table(this, 'MessagesTable', {
      partitionKey: { name: 'session_id', type: ddb.AttributeType.STRING },
      sortKey: { name: 'created_at_id', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── 2) Worker Lambda — Agent Loop (Bedrock 반복 + 코드 샌드박스 + 단계별 저장) ──
    //    ★ Day 13 변화: timeout 60s → 300s. 루프가 LLM ↔ 샌드박스를 여러 번 왕복하므로.
    const workerFn = new nodejs.NodejsFunction(this, 'WorkerFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '..', 'lambda', 'worker.mjs'),
      handler: 'handler',
      memorySize: 512,
      timeout: cdk.Duration.minutes(5),
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
        MESSAGES_TABLE: messagesTable.tableName,
        SESSIONS_TABLE: sessionsTable.tableName,
        MODEL_ID: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
        HISTORY_LIMIT: '20',
        // 한 턴에서 LLM ↔ 도구 왕복을 최대 몇 번 돌지. 무한루프 컷.
        MAX_TURN_STEPS: '5',
      },
    });

    // Worker 권한 — Day 12 그대로. Bedrock + Messages RW + Sessions RW. Users 안 봄, invoke 권한 없음.
    messagesTable.grantReadWriteData(workerFn);
    sessionsTable.grantReadWriteData(workerFn);
    workerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: ['*'],
    }));

    const workerAlias = new lambda.Alias(this, 'WorkerFunctionAlias', {
      aliasName: 'live',
      version: workerFn.currentVersion,
    });

    // ── 3) API Lambda — Hono 라우터 + 3테이블 접근 + Worker async invoke (Day 12 그대로) ──
    //    Bedrock 권한 없음. Day 13 에서 API 는 손대지 않는다(루프는 Worker 안 일).
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
        USERS_TABLE: usersTable.tableName,
        SESSIONS_TABLE: sessionsTable.tableName,
        MESSAGES_TABLE: messagesTable.tableName,
        HISTORY_LIMIT: '20',
        AGENT_WORKER_FUNCTION_NAME: workerAlias.functionArn,
      },
    });

    usersTable.grantReadWriteData(apiFn);
    sessionsTable.grantReadWriteData(apiFn);
    messagesTable.grantReadWriteData(apiFn);
    workerAlias.grantInvoke(apiFn);

    // ── 4) API Alias + Function URL (BUFFERED, Day 11/12 그대로) ──
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

    // ── 5) Outputs ──
    new cdk.CfnOutput(this, 'ApiUrl', { value: apiUrl.url });
    new cdk.CfnOutput(this, 'ApiFunctionName', { value: apiFn.functionName });
    new cdk.CfnOutput(this, 'WorkerFunctionName', { value: workerFn.functionName });
    new cdk.CfnOutput(this, 'WorkerAliasArn', { value: workerAlias.functionArn });
    new cdk.CfnOutput(this, 'UsersTableName', { value: usersTable.tableName });
    new cdk.CfnOutput(this, 'SessionsTableName', { value: sessionsTable.tableName });
    new cdk.CfnOutput(this, 'MessagesTableName', { value: messagesTable.tableName });
  }
}
