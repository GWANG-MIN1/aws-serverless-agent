#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Day09CloudfrontStack } from '../lib/day-09-cloudfront-stack';

const app = new cdk.App();

// Function URL 은 두 가지 방법으로 주입:
//   1) 환경변수 FUNCTION_URL=https://xxxx.lambda-url.us-east-1.on.aws/
//   2) cdk context: -c functionUrl=https://...
// Day 7 의 출력 (Day07HistoryApiStack.FunctionUrl) 을 그대로 붙여 넣으면 됨.
const functionUrl =
  process.env.FUNCTION_URL ?? (app.node.tryGetContext('functionUrl') as string | undefined);

if (!functionUrl) {
  throw new Error(
    'FUNCTION_URL 가 없다. env FUNCTION_URL=... 또는 -c functionUrl=... 로 Day 7 의 Function URL 을 넘겨라.',
  );
}

new Day09CloudfrontStack(app, 'Day09CloudfrontStack', {
  functionUrl,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Day 9: CloudFront in front of S3 (private/OAC) + Lambda Function URL /api/*',
});
