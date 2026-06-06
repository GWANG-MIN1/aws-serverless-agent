import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

// Day 15 = Day 14 가 토픽에 쏘기 시작한 이벤트를 "브라우저가 직접" 구독하게 한다.
//
// Day 14 까지: Worker 가 sessions/${id}/events 로 publish → 확인은 AWS 콘솔 MQTT test client.
// Day 15: 브라우저가 mqtt.js 로 그 토픽에 WSS 직접 연결한다. 단 브라우저는 AWS 자격증명이 없으니,
//   API 가 "그 세션 토픽만" 구독 가능한 SigV4-presigned WSS URL 을 만들어 내려준다(X.509 인증서 없이 IAM 으로).
//
// 흐름:
//   브라우저 ─ GET /sessions/:id/realtime ─▶ API
//                                            ├ STS AssumeRole(RealtimeRole, 세션정책으로 이 토픽만 허용)
//                                            ├ DescribeEndpoint 로 WSS 호스트 확보
//                                            └ signIotWebSocketUrl() → { url, channel } 반환
//   브라우저 ─ mqtt.connect(url) → subscribe(channel) ─▶ IoT Core ─ 이벤트 ─▶ 화면에 실시간 렌더
//
// 원본(breath103/serverless-agent) 매핑:
//   lib/iot-sigv4.ts                 signIotWebSocketUrl       ← api.mjs 의 signIotWebSocketUrl (그대로 포팅)
//   lambda-api/routes/realtime.ts    /api/realtime/connection  ← api.mjs 의 GET /sessions/:id/realtime
//   lib/mqtt.ts resolveIotCredentials(AssumeRole+세션정책)      ← api.mjs 의 scopedSessionCredentials
//   frontend/src/lib/realtime/client.ts  mqtt.connect+subscribe ← web/index.html 의 브라우저 구독 코드
//   (원본은 유저별 토픽 + superjson + Vite 프론트. 우리는 세션별 토픽 + JSON + 단일 정적 HTML 로 간소화.)
//
// 인프라 변화 = 세 가지. 나머지는 Day 14 그대로(Worker/테이블/Function URL 불변).
//   1) RealtimeRole: API 역할이 AssumeRole 할 대상. iot:Connect/Subscribe/Receive 를 sessions/*/events 로 한정.
//      AssumeRole 시 "세션정책"으로 한 세션 토픽까지 더 좁힌다(브라우저가 받는 자격증명 = 그 세션 전용).
//   2) API IAM: sts:AssumeRole(RealtimeRole) + iot:DescribeEndpoint(*). API env 에 AGENT_MQTT_ROLE_ARN.
//   3) API 번들에 @aws-sdk/client-iot / -sts 추가(external).
//
// 안 변하는 것: 테이블 3개, Worker(Day 14 그대로), Worker IoT publish 권한, Function URL(BUFFERED),
//   API↔Worker 분리. ★ 브라우저 호스팅은 아직 안 함 — 정적 페이지는 localhost 로 띄워 검증(S3/CloudFront 는 Day 16).

export class Day15BrowserMqttStack extends cdk.Stack {
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

    // ── 3) API Lambda — Hono 라우터 + 3테이블 + Worker invoke (Day 14 그대로) + Day 15 realtime 라우트 ──
    //    Bedrock 권한 없음. Day 15 에서 추가되는 건 "브라우저에 줄 WSS URL 발급"뿐.
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
          // Day 15: WSS 호스트 조회(DescribeEndpoint) + 세션 한정 자격증명(AssumeRole). 런타임 제공.
          '@aws-sdk/client-iot',
          '@aws-sdk/client-sts',
        ],
      },
      environment: {
        USERS_TABLE: usersTable.tableName,
        SESSIONS_TABLE: sessionsTable.tableName,
        MESSAGES_TABLE: messagesTable.tableName,
        HISTORY_LIMIT: '20',
        AGENT_WORKER_FUNCTION_NAME: workerAlias.functionArn,
        // Day 15: 토픽 접두어(Worker 와 동일해야 함) — channel = `${MQTT_TOPIC_PREFIX}/${sessionId}/events`.
        MQTT_TOPIC_PREFIX: 'sessions',
      },
    });

    usersTable.grantReadWriteData(apiFn);
    sessionsTable.grantReadWriteData(apiFn);
    messagesTable.grantReadWriteData(apiFn);
    workerAlias.grantInvoke(apiFn);

    // ── 3b) RealtimeRole — 브라우저에게 줄 자격증명의 "상한선" (Day 15) ──
    //    API 역할이 이 Role 을 AssumeRole 한다. Role 자체 권한은 sessions/*/events 전체를 허용하지만,
    //    AssumeRole 할 때 코드가 "세션정책"으로 한 세션 토픽까지 더 좁힌다 → 둘의 교집합이 브라우저 권한.
    //    iot:Connect(client/*) + Subscribe(topicfilter/...) + Receive(topic/...). publish 권한은 안 줌(구독 전용).
    const realtimeRole = new iam.Role(this, 'RealtimeRole', {
      assumedBy: new iam.ArnPrincipal(apiFn.role!.roleArn),
      description: 'Day15 - scoped IoT subscribe creds handed to the browser via SigV4 WSS URL',
      maxSessionDuration: cdk.Duration.hours(1),
    });
    realtimeRole.addToPolicy(new iam.PolicyStatement({
      actions: ['iot:Connect'],
      resources: [cdk.Stack.of(this).formatArn({ service: 'iot', resource: 'client', resourceName: '*' })],
    }));
    realtimeRole.addToPolicy(new iam.PolicyStatement({
      actions: ['iot:Subscribe'],
      resources: [cdk.Stack.of(this).formatArn({ service: 'iot', resource: 'topicfilter', resourceName: 'sessions/*/events' })],
    }));
    realtimeRole.addToPolicy(new iam.PolicyStatement({
      actions: ['iot:Receive'],
      resources: [cdk.Stack.of(this).formatArn({ service: 'iot', resource: 'topic', resourceName: 'sessions/*/events' })],
    }));

    // API 가 그 Role 을 assume + WSS 호스트 조회. (env 는 함수 생성 후 주입 — Role↔함수 순환 회피)
    apiFn.addEnvironment('AGENT_MQTT_ROLE_ARN', realtimeRole.roleArn);
    apiFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [realtimeRole.roleArn],
    }));
    apiFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iot:DescribeEndpoint'],
      resources: ['*'],
    }));

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
    new cdk.CfnOutput(this, 'MqttTopicPattern', { value: 'sessions/<sessionId>/events' });
    // Day 15: 브라우저가 받을 WSS URL 을 발급하는 엔드포인트 + assume 대상 Role.
    new cdk.CfnOutput(this, 'RealtimeConnectionUrl', { value: `${apiUrl.url}sessions/<sessionId>/realtime` });
    new cdk.CfnOutput(this, 'RealtimeRoleArn', { value: realtimeRole.roleArn });
  }
}
