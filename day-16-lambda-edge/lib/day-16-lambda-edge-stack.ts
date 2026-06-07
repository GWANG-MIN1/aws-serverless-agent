import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as path from 'path';

// Day 16 = Day 15 의 백엔드(API+Worker+IoT) 위에 "정식 웹 호스팅 + 엣지 라우팅"을 얹는다.
//          Day 15 까지 정적 페이지는 localhost 로만 띄웠다 → 이제 S3 + CloudFront 로 호스팅한다.
//          그리고 Day 9 의 CloudFront Function(/api strip)을 Lambda@Edge 로 업그레이드한다.
//
// 핵심 한 가지: "backend Function URL 을 distribution 에 굽지 않고 SSM 에 두고, 엣지가 런타임에 조회."
//   Day 9: backend host 를 deploy-time prop 으로 distribution 에 박음 → 백엔드 URL 바뀌면 CF 재배포.
//   Day 16: host 를 SSM Parameter(`/serverless-agent/backend/url`)에 두고 origin-request Lambda@Edge 가
//           cold start 때 조회·캐싱(60s) → origin 을 그쪽으로 동적 교체 + "/api" strip.
//           → 백엔드와 CDN 디커플링(백엔드만 갈아도 엣지가 60초 안에 따라옴). 원본 packages/edge 의 정공법.
//
// 원본 매핑:
//   packages/edge/src/origin-request/index.ts  → lambda/edge-origin-request.mjs (SSM 조회 + origin 교체)
//   packages/shared/src/ssm-parameters.ts        → 파라미터 이름 규칙 `/${project}/backend/url`
//   (원본은 edge 가 별도 스택/배포라 SSM 이 유일한 연결고리. 우리는 한 스택이라 같은 값을 SSM 에도 써서
//    같은 디커플링 패턴을 보여준다. viewer-request 의 멀티브랜치 서브도메인 로직은 우리 범위 밖이라 생략.)
//
// Lambda@Edge 제약:
//   - 반드시 us-east-1 (bin 에서 region 고정).  - 환경변수 불가 → PROJECT/SSM_REGION 은 esbuild define 로 주입.
//   - NodejsFunction 기본 env(AWS_NODEJS_CONNECTION_REUSE_ENABLED) 도 금지 → awsSdkConnectionReuse:false.
//
// 안 변하는 것: 테이블 3개, Worker(Day 14), RealtimeRole·SigV4 발급(Day 15), API↔Worker 분리, Function URL(BUFFERED).

const PROJECT = 'serverless-agent';
const BACKEND_URL_PARAM = `/${PROJECT}/backend/url`;

export class Day16LambdaEdgeStack extends cdk.Stack {
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

    // ════════════════════════════════════════════════════════════════
    //  Day 16: SSM 파라미터 + S3/CloudFront 호스팅 + origin-request Lambda@Edge
    // ════════════════════════════════════════════════════════════════

    // ── 5) SSM Parameter — backend Function URL 을 여기에 둔다(엣지가 런타임에 조회) ──
    //    Day 9 처럼 distribution 에 굽지 않는 게 핵심. 백엔드만 바꿔도 CF 재배포 불필요.
    new ssm.StringParameter(this, 'BackendUrlParam', {
      parameterName: BACKEND_URL_PARAM,
      stringValue: apiUrl.url,
      description: 'Day16 - backend Function URL, read by origin-request Lambda@Edge',
    });
    const backendParamArn = cdk.Stack.of(this).formatArn({
      service: 'ssm', resource: 'parameter', resourceName: BACKEND_URL_PARAM.replace(/^\//, ''),
    });

    // ── 6) origin-request Lambda@Edge ──
    //    Lambda@Edge 전용 Role: lambda + edgelambda 둘 다 trust. ssm:GetParameter 만 추가로 허용.
    const edgeRole = new iam.Role(this, 'EdgeRole', {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lambda.amazonaws.com'),
        new iam.ServicePrincipal('edgelambda.amazonaws.com'),
      ),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    edgeRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [backendParamArn],
    }));

    const edgeFn = new nodejs.NodejsFunction(this, 'OriginRequestFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '..', 'lambda', 'edge-origin-request.mjs'),
      handler: 'handler',
      role: edgeRole,
      memorySize: 128,
      timeout: cdk.Duration.seconds(5), // origin-request 상한은 30s 지만 SSM 조회뿐이라 5s 로 충분.
      awsSdkConnectionReuse: false,      // ★ Lambda@Edge 는 환경변수 금지 → 이 env 도 끈다.
      bundling: {
        format: nodejs.OutputFormat.CJS, // Lambda@Edge 는 CJS 가 무난 (ESM 핸들러 제약 회피).
        target: 'node20',
        // PROJECT/SSM_REGION 은 핸들러에 상수로 박았다(엣지 env 불가 + Windows esbuild define 버그 회피).
        // @aws-sdk/* 는 NodejsFunction 기본 external — Node20 엣지 런타임이 client-ssm 을 제공.
      },
    });

    // ── 7) S3 (private) + OAC — Day 9 그대로 ──
    const bucket = new s3.Bucket(this, 'WebBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(bucket);

    // ── 8) /api/* 의 origin = backend host (토큰에서 추출) ──
    //    Function URL 은 같은 스택의 토큰이라 new URL() 파싱 불가 → CFN intrinsic 으로 host 추출.
    //    이 값은 CloudFront 가 요구하는 "기본 origin"이고, 실제 라우팅은 엣지가 SSM 으로 덮어쓴다.
    const backendHost = cdk.Fn.select(2, cdk.Fn.split('/', apiUrl.url));
    const fnOrigin = new origins.HttpOrigin(backendHost, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      readTimeout: cdk.Duration.seconds(30),
      keepaliveTimeout: cdk.Duration.seconds(5),
    });

    // ── 9) CloudFront Distribution ──
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'day-16 CDN: S3 (default) + backend via origin-request Lambda@Edge (/api/*)',
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      additionalBehaviors: {
        'api/*': {
          origin: fnOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          compress: true,
          // ★ Day 9 의 CloudFront Function 자리를 Lambda@Edge origin-request 로 교체.
          edgeLambdas: [{
            functionVersion: edgeFn.currentVersion,
            eventType: cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST,
          }],
        },
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(5) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(5) },
      ],
    });

    // ── 10) web/ 정적 페이지 업로드 + 캐시 무효화 (Day 9 그대로, 단 빌드 없는 단일 HTML) ──
    new s3deploy.BucketDeployment(this, 'WebDeploy', {
      destinationBucket: bucket,
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'web'))],
      distribution,
      distributionPaths: ['/*'],
    });

    // ── 11) Outputs ──
    new cdk.CfnOutput(this, 'SiteUrl', { value: `https://${distribution.distributionDomainName}`, description: '브라우저로 접속 (same-origin /api)' });
    new cdk.CfnOutput(this, 'DistributionDomainName', { value: distribution.distributionDomainName });
    new cdk.CfnOutput(this, 'BackendUrlParamName', { value: BACKEND_URL_PARAM });
    new cdk.CfnOutput(this, 'ApiUrl', { value: apiUrl.url });
    new cdk.CfnOutput(this, 'WorkerFunctionName', { value: workerFn.functionName });
    new cdk.CfnOutput(this, 'UsersTableName', { value: usersTable.tableName });
    new cdk.CfnOutput(this, 'SessionsTableName', { value: sessionsTable.tableName });
    new cdk.CfnOutput(this, 'MessagesTableName', { value: messagesTable.tableName });
    new cdk.CfnOutput(this, 'MqttTopicPattern', { value: 'sessions/<sessionId>/events' });
    new cdk.CfnOutput(this, 'RealtimeRoleArn', { value: realtimeRole.roleArn });
  }
}
