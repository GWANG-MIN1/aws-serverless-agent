import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as path from 'path';

// Day 8 = Day 7 의 Function URL 위에 React(Vite) 프론트를 얹는다.
//
// 핵심 결정:
//   - S3 정적 웹사이트 호스팅 (website endpoint, http://...s3-website-...)
//     → CloudFront/OAI 는 Day 9 에서 묶으면서 origin 좁힘.
//   - 프론트는 브라우저에서 Day 7 Function URL 을 직접 fetch (CORS 는 day-07 에서 * 로 열림)
//   - 빌드 산출물(web/dist)은 BucketDeployment 가 zip 으로 올려 푼다.
//
// 의도적으로 미루는 것:
//   - HTTPS / 커스텀 도메인 (CloudFront + ACM 필요)
//   - 캐시 무효화 (CloudFront 가 없으니 의미 없음)
//   - origin lockdown (Day 9 의 OAI/OAC)
//   - SPA 라우팅 (현재 라우트 1개, SPA 라우터 미사용)

export class Day08FrontendViteStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1) S3 정적 웹사이트 버킷
    //
    //   - 학습용이라 publicRead 로 누구나 GET 가능하게.
    //   - 신 버킷은 기본 BlockPublicAccess 가 켜져 있어서 그냥 publicReadAccess:true 만 줘도 막힌다.
    //     BLOCK_ACLS 프리셋(=ACL 류만 막고 정책은 허용) 으로 풀어줘야 정책 기반 public read 가 먹는다.
    //   - ACL 자체는 BUCKET_OWNER_ENFORCED 로 끔 (2023 이후 신규 버킷 기본값) — 권한은 IAM/버킷정책으로만.
    //   - 학습 단계 정리 편의를 위해 RemovalPolicy.DESTROY + autoDeleteObjects.
    const bucket = new s3.Bucket(this, 'WebBucket', {
      websiteIndexDocument: 'index.html',
      // SPA 가 아니더라도 404 가 index 로 가도록 — Day 9 라우팅 추가 대비.
      websiteErrorDocument: 'index.html',
      publicReadAccess: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ACLS,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // 2) BucketDeployment — Vite 빌드 산출물(web/dist) 을 그대로 업로드
    //
    //    내부적으로 zip 으로 묶어 임시 Lambda 가 풀어 넣는 패턴.
    //    `npm run web:build` 를 먼저 돌려야 web/dist 가 존재한다.
    //    → 루트 package.json 의 `deploy` 스크립트가 web:build → cdk deploy 순으로 묶음.
    //
    //    `prune: true` (기본값) 라서 같은 prefix 안의 옛 파일은 삭제됨 — 다음 배포 때 자동 청소.
    new s3deploy.BucketDeployment(this, 'WebDeploy', {
      destinationBucket: bucket,
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'web', 'dist'))],
    });

    // 3) Outputs
    //    - bucketWebsiteUrl: http://<bucket>.s3-website-<region>.amazonaws.com  ← 브라우저로 열 곳
    //    - bucketName: aws s3 cp 등으로 수동 확인용
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'BucketWebsiteUrl', { value: bucket.bucketWebsiteUrl });
    new cdk.CfnOutput(this, 'BucketDomainName', { value: bucket.bucketDomainName });
  }
}
