import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as path from 'path';

// Day 9 = Day 8 의 "S3 정적 호스팅 + 브라우저가 Function URL 직접 fetch" 를
//          "한 개의 CloudFront 배포 뒤에 S3(웹) + Function URL(/api/*)" 로 통합.
//
// 얻는 것:
//   1) HTTPS (cloudfront.net 기본 도메인) + 단일 오리진 → 브라우저는 same-origin 으로 `/api/...` 만 호출
//   2) 정적 자산 캐싱 (CACHING_OPTIMIZED) — Vite 의 hashed asset 와 잘 맞음
//   3) S3 를 private 로 잠그고 OAC 로 CloudFront 만 읽게 — Day 8 의 public 정책 폐기
//   4) CORS 가 사라짐 — 동일 오리진이라 브라우저가 preflight 조차 안 보냄
//   5) SPA-style 직접 URL 입력 시 index.html 로 fallback (errorResponses)
//
// 트레이드오프:
//   - 첫 배포 시 CloudFront 분배 propagation 이 5~15분 걸림 (S3 only 보다 느림)
//   - 캐시 무효화 비용 — 학습 단계에선 매 배포 BucketDeployment 가 distributionPaths:['/*'] 로 invalidate
//   - 비용은 PB 단위 가기 전까지 무료티어/매우저렴 (1TB out / 월 10M 요청 무료)

interface Day09CloudfrontStackProps extends cdk.StackProps {
  /** Day 7 의 Function URL (예: https://xxxx.lambda-url.us-east-1.on.aws/). 끝 슬래시는 무관. */
  functionUrl: string;
}

export class Day09CloudfrontStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Day09CloudfrontStackProps) {
    super(scope, id, props);

    // --- 0) Function URL → host 만 뽑기 ---
    //
    // HttpOrigin 은 hostname 만 받음 (스킴/경로 X).
    // `https://abcd1234.lambda-url.us-east-1.on.aws/` → `abcd1234.lambda-url.us-east-1.on.aws`
    const fnUrlParsed = new URL(props.functionUrl);
    const fnHost = fnUrlParsed.host;
    if (!/\.lambda-url\.[a-z0-9-]+\.on\.aws$/.test(fnHost)) {
      // 학습용이라 hard fail 보다는 경고만. 다른 백엔드 (API GW 등) 로도 쓰일 수 있음.
      cdk.Annotations.of(this).addWarning(
        `functionUrl host (${fnHost}) 가 lambda-url 형식이 아니다 — 의도된 거면 무시.`,
      );
    }

    // --- 1) S3 WebBucket (private) ---
    //
    // Day 8 과 결정적으로 다른 점:
    //   - websiteIndexDocument 없음 — S3 website endpoint 안 씀
    //   - publicReadAccess 없음 — 버킷은 완전 private
    //   - blockPublicAccess: BLOCK_ALL (default) — public 막음
    //   - 권한은 OAC 가 자동으로 깎아 넣음 (아래 S3BucketOrigin.withOriginAccessControl)
    const bucket = new s3.Bucket(this, 'WebBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- 2) CloudFront Function — /api/* URI 재작성 ---
    //
    // 왜 필요한가:
    //   - 브라우저는 `/api/chat`, `/api/sessions/...` 로 호출 (same-origin)
    //   - Function URL 백엔드(Day 7 Hono) 라우트는 `/chat`, `/sessions/...` 임
    //   - CloudFront 의 origin path 는 PREPEND 만 됨 → "/api" 를 STRIP 할 방법이 없음
    //   - 그래서 viewer-request 단계에서 URI 만 살짝 잘라줌
    //
    // CloudFront Function 은 µs 단위 / 무료 1M req/mo / 콜드스타트 없음 — Lambda@Edge 와 다름.
    // Phase 3 (Day 11) 에서 Lambda@Edge 본격 도입 전 가벼운 워밍업 격.
    const rewriteFn = new cloudfront.Function(this, 'ApiRewrite', {
      comment: 'strip /api prefix before forwarding to Lambda Function URL',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var req = event.request;
  if (req.uri === '/api' || req.uri === '/api/') {
    req.uri = '/';
  } else if (req.uri.startsWith('/api/')) {
    req.uri = req.uri.substring(4);
  }
  return req;
}
      `.trim()),
    });

    // --- 3) Origins ---
    //
    // (a) S3 private + OAC — 신규 권장. (구) OAI 대신 SigV4 기반.
    //     withOriginAccessControl 헬퍼가 OAC 생성 + 버킷 정책에 cloudfront.amazonaws.com 허용까지 자동.
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(bucket);

    // (b) Function URL = HTTPS 만 받는 HTTP 오리진.
    //     Host 헤더는 절대 viewer 의 것을 그대로 못 보냄 — Lambda Function URL 은
    //     자신의 도메인 (xxx.lambda-url.aws) 의 SNI/Host 만 받아들임.
    //     → OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER 와 짝.
    const fnOrigin = new origins.HttpOrigin(fnHost, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      // Function URL 은 TLS 1.2 만 받으므로 SSLv3 등 보낼 일 없음 (기본값으로 충분).
      // readTimeout 은 Lambda 의 응답 스트림에 맞춰 늘림 — Day 7 timeout 60s.
      readTimeout: cdk.Duration.seconds(60),
      keepaliveTimeout: cdk.Duration.seconds(60),
    });

    // --- 4) Distribution ---
    //
    // 정책 선택:
    //   - default (S3):
    //       cachePolicy: CACHING_OPTIMIZED (Vite hashed asset 와 잘 맞음 — 파일명에 hash 가 들어가니 invalidate 도 거의 불필요)
    //       viewerProtocolPolicy: REDIRECT_TO_HTTPS
    //       allowedMethods: GET_HEAD (S3 정적이라 POST 못 옴)
    //   - /api/*:
    //       cachePolicy: CACHING_DISABLED (chat 응답 캐싱하면 큰일)
    //       originRequestPolicy: ALL_VIEWER_EXCEPT_HOST_HEADER (Host 만 제외하고 다 넘김 — query, header, cookie)
    //       allowedMethods: ALLOW_ALL (POST + GET)
    //       viewerProtocolPolicy: REDIRECT_TO_HTTPS
    //
    // SPA fallback:
    //   - S3 가 객체 없으면 403 (private OAC + ListBucket 권한 없음 → NoSuchKey 가 403 으로 옴) 또는 404
    //   - errorResponses 로 둘 다 200 + /index.html 로 고침 → 브라우저 라우터가 처리 가능
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'day-09 unified CDN: S3 (default) + Lambda Function URL (/api/*)',
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      additionalBehaviors: {
        'api/*': {
          origin: fnOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // ALL_VIEWER_EXCEPT_HOST_HEADER — Host 만 제외하고 헤더/쿠키/쿼리 그대로 전달.
          // Function URL 백엔드가 viewer 측 정보 (content-type 등) 를 그대로 받음.
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          compress: true,
          functionAssociations: [
            {
              function: rewriteFn,
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            },
          ],
        },
      },
      // SPA 직접진입 (예: /chat/foo) 시 index.html 로 — 현재 라우터는 없지만 향후 대비 + 404 처리.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(5) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(5) },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // 학습용 — 북미/유럽 엣지만, 가장 저렴.
    });

    // --- 5) BucketDeployment — 빌드 산출물 업로드 + 캐시 무효화 ---
    //
    // distribution + distributionPaths:['/*'] 를 같이 주면, deploy 끝나고 자동으로
    // CreateInvalidation 까지 쳐줌. 다음 GET 부터 새 index.html 보장.
    new s3deploy.BucketDeployment(this, 'WebDeploy', {
      destinationBucket: bucket,
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'web', 'dist'))],
      distribution,
      distributionPaths: ['/*'],
    });

    // --- 6) Outputs ---
    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'https://<this>/ 로 브라우저 접속',
    });
    new cdk.CfnOutput(this, 'DistributionUrl', {
      value: `https://${distribution.distributionDomainName}`,
    });
    new cdk.CfnOutput(this, 'ApiBase', {
      value: `https://${distribution.distributionDomainName}/api/`,
      description: '브라우저가 fetch 할 동일오리진 API base — VITE_API_BASE 로 박힘',
    });
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'FunctionOriginHost', { value: fnHost });
  }
}
