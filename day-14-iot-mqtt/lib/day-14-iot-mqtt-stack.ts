import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

// Day 14 = Day 13 의 Agent Loop 위에 "실시간 출력" 한 가지만 더한다.
//
// Day 13 까지 루프의 각 단계(text/tool_call/tool_result)는 MessagesTable 행으로만 남았다.
//   → 진행 상황을 보려면 GET /sessions/:id/messages 를 폴링해야 한다 (Day 13 숙제).
// Day 14 는 그 행을 저장하는 그 순간, 같은 내용을 IoT Core MQTT 토픽으로도 publish 한다.
//   → 구독자(Day 15 의 브라우저)가 루프가 도는 걸 실시간으로 본다.
//
// 토픽: sessions/${sessionId}/events  (세션 1개 = 토픽 1개, 이벤트 type 으로 단계 구분)
//   원본은 ${ns}/users/${userId}/events 의 "유저별" 토픽이지만, 우리는 Day 13 이 이미
//   세션 단위로 행을 쌓고 있어 "세션별" 토픽이 자연스럽다 (Day 15 도 세션 화면 단위로 구독).
//
// 원본(breath103/serverless-agent) 매핑 — packages/backend/src/lib/*:
//   realtime-publish.ts  IoTDataPlaneClient + PublishCommand(qos 1)   ← 우리 worker 의 publishEvent()
//   realtime-events.ts   entity_update / echo 이벤트 타입 정의          ← worker 의 이벤트 shape
//   mqtt.ts              broker URL → 엔드포인트/리전 파싱              ← 우리는 DescribeEndpoint 로 런타임 조회
//   (원본은 broker URL 을 env 로 주입받지만, 우리는 IoT Data 엔드포인트를 cold start 때
//    iot:DescribeEndpoint(iot:Data-ATS) 로 직접 조회해 캐싱 — 외부 설정값 0개. superjson → JSON 으로 간소화.)
//
// 인프라 변화 = 딱 두 가지. 나머지는 Day 13 그대로.
//   1) Worker IAM 에 IoT 권한 추가: iot:DescribeEndpoint(*) + iot:Publish(우리 세션 토픽으로 한정).
//   2) Worker 번들에 @aws-sdk/client-iot / -iot-data-plane 를 external 로 추가(런타임 제공).
//
// 안 변하는 것: 테이블 3개, API↔Worker 분리, Worker timeout 5min, MAX_TURN_STEPS,
//   workerAlias.grantInvoke(api), Function URL(BUFFERED), 책임 분리 IAM(API 는 Bedrock/IoT 모름).

export class Day14IotMqttStack extends cdk.Stack {
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

    // ── 2) Worker Lambda — Agent Loop + 단계별 IoT MQTT publish ──
    //    timeout 5min/MAX_TURN_STEPS 는 Day 13 그대로. Day 14 변화는 IoT 권한·env·번들뿐.
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
          // Day 14: IoT control plane(DescribeEndpoint) + data plane(Publish). 런타임이 제공.
          '@aws-sdk/client-iot',
          '@aws-sdk/client-iot-data-plane',
        ],
      },
      environment: {
        MESSAGES_TABLE: messagesTable.tableName,
        SESSIONS_TABLE: sessionsTable.tableName,
        MODEL_ID: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
        HISTORY_LIMIT: '20',
        // 한 턴에서 LLM ↔ 도구 왕복을 최대 몇 번 돌지. 무한루프 컷.
        MAX_TURN_STEPS: '5',
        // Day 14: MQTT 토픽 접두어. 실제 토픽 = `${MQTT_TOPIC_PREFIX}/${sessionId}/events`.
        //   원본 AGENT_MQTT_NAMESPACE 자리. IAM 리소스 ARN 과 코드가 같은 값을 봐야 한다.
        MQTT_TOPIC_PREFIX: 'sessions',
      },
    });

    // Worker 권한 — Day 13(Bedrock + Messages RW + Sessions RW) 에 Day 14 IoT 권한 추가.
    messagesTable.grantReadWriteData(workerFn);
    sessionsTable.grantReadWriteData(workerFn);
    workerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: ['*'],
    }));
    // Day 14: 계정의 IoT Data 엔드포인트 조회(리소스 단위 없음 → *) + 우리 세션 토픽으로만 publish.
    workerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iot:DescribeEndpoint'],
      resources: ['*'],
    }));
    workerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iot:Publish'],
      // topic/<MQTT_TOPIC_PREFIX>/*/events 만 허용 — 다른 토픽으로는 못 쏜다(최소 권한).
      resources: [
        cdk.Stack.of(this).formatArn({
          service: 'iot',
          resource: 'topic',
          resourceName: 'sessions/*/events',
        }),
      ],
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
    // Day 14: 검증 시 IoT Core MQTT test client 에서 구독할 토픽 패턴. (sessions/+/events 로 와일드카드 구독)
    new cdk.CfnOutput(this, 'MqttTopicPattern', { value: 'sessions/<sessionId>/events' });
  }
}
