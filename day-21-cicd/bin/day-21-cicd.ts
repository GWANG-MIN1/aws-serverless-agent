#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Day21CicdStack } from '../lib/day-21-cicd-stack';
import { Day21PipelineStack } from '../lib/pipeline-stack';

const app = new cdk.App();

// 배포 대상이 되는 에이전트 스택 (Day 20 그대로 — CI 가 이걸 deploy 한다).
new Day21CicdStack(app, 'Day21CicdStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  description: 'Day 21: same agent stack as Day 20; deployed by GitHub Actions via OIDC',
});

// CI 가 키 없이 assume 할 OIDC 배포 역할 (한 번만 수동 배포해 부트스트랩).
//   레포는 context 로 바꿀 수 있게: `-c githubRepo=owner/repo`. 기존 GitHub OIDC provider 가 있으면
//   `-c oidcProviderArn=<arn>` 로 재사용(중복 생성 방지).
new Day21PipelineStack(app, 'Day21PipelineStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  githubRepo: (app.node.tryGetContext('githubRepo') as string) ?? 'GWANG-MIN1/aws-serverless-agent',
  existingOidcProviderArn: (app.node.tryGetContext('oidcProviderArn') as string) ?? undefined,
  description: 'Day 21: GitHub OIDC provider + keyless deploy role for CI',
});
