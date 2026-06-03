import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

// Day 12 = Day 11 의 단일 ConversationsTable 을 도메인별 3개로 쪼개기.
//
// 원본(breath103/serverless-agent) 매핑 — packages/backend/scripts/lib/backend-stack.ts:
//   ${id}-users         PK id                          ← 우리의 UsersTable
//   ${id}-chat-sessions PK user_id, SK id              ← 우리의 SessionsTable
//   ${id}-chat-messages PK session_id, SK created_at_id ← 우리의 MessagesTable
//   (원본 나머지 5개 accounts/sessions(auth)/profiles/memories/user-skills 는
//    auth·agent 전용이라 MVP 범위 밖 — 제외)
//
// 왜 쪼개나 (이 day 가 답하는 것):
//   Day 7 이래 단일 테이블(PK sessionId, SK ts)은 sessionId 를 알아야만 조회 가능했다.
//   "이 유저의 세션 목록" 같은 접근 패턴은 Scan 외엔 길이 없었다.
//   chat-sessions 를 PK user_id 로 두면 그 패턴이 깨끗한 Query 한 번으로 열린다.
//   → 이게 원본이 single-table design 대신 도메인별 멀티 테이블을 택한 이유.
//
// Day 11 에서 그대로 가져오는 것:
//   API ↔ Worker 분리, workerAlias.grantInvoke(api), AGENT_WORKER_FUNCTION_NAME env,
//   Function URL(BUFFERED), IAM 책임 분리(API 는 Bedrock 모름 / Worker 는 lambda invoke 못 함).

export class Day12MultiTableStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── 1) 도메인별 테이블 3개 (원본 키 스키마 그대로) ───────────────────
    //
    // UsersTable — 유저 프로필. PK 단일(id). 세션/메시지와 완전히 분리된 도메인.
    const usersTable = new ddb.Table(this, 'UsersTable', {
      partitionKey: { name: 'id', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // SessionsTable (원본 chat-sessions) — PK user_id, SK id.
    //   PK 를 user_id 로 둔 게 이 day 의 핵심: Query(user_id) = "이 유저의 모든 세션".
    //   단일 세션을 집으려면 user_id + id 둘 다 필요(의도된 계층 구조).
    const sessionsTable = new ddb.Table(this, 'SessionsTable', {
      partitionKey: { name: 'user_id', type: ddb.AttributeType.STRING },
      sortKey: { name: 'id', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // MessagesTable (원본 chat-messages) — PK session_id, SK created_at_id.
    //   Day 11 의 (sessionId, ts) 와 사실상 동일. created_at_id = `${iso}#${uuid}` 합성 SK.
    //   세션 단위로 메시지를 시간순 Query — Day 7/11 패턴 그대로.
    const messagesTable = new ddb.Table(this, 'MessagesTable', {
      partitionKey: { name: 'session_id', type: ddb.AttributeType.STRING },
      sortKey: { name: 'created_at_id', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── 2) Worker Lambda — Bedrock 호출 + assistant 저장 + 세션 updatedAt bump ──
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
        MESSAGES_TABLE: messagesTable.tableName,
        SESSIONS_TABLE: sessionsTable.tableName,
        MODEL_ID: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
        HISTORY_LIMIT: '20',
      },
    });

    // Worker 권한 — Bedrock + Messages RW + Sessions RW(updatedAt bump).
    //   Users 는 안 건드림. lambda invoke 권한도 없음(다른 람다 못 부름) — Day 11 제약 유지.
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

    // ── 3) API Lambda — Hono 라우터 + 3테이블 접근 + Worker async invoke ──
    //    Bedrock 권한 없음(Day 11 책임 분리 그대로).
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

    // API 권한 — 3테이블 RW + workerAlias 한정 invoke. Bedrock 없음.
    usersTable.grantReadWriteData(apiFn);
    sessionsTable.grantReadWriteData(apiFn);
    messagesTable.grantReadWriteData(apiFn);
    workerAlias.grantInvoke(apiFn);

    // ── 4) API Alias + Function URL (BUFFERED, Day 11 그대로) ──
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
