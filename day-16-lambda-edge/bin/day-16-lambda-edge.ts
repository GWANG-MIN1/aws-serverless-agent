#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Day16LambdaEdgeStack } from '../lib/day-16-lambda-edge-stack';

const app = new cdk.App();
new Day16LambdaEdgeStack(app, 'Day16LambdaEdgeStack', {
  // Lambda@Edge 는 반드시 us-east-1 에 있어야 한다 (CloudFront 글로벌 + 엣지 복제 원천).
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  description: 'Day 16: CloudFront + S3 hosting; origin-request Lambda@Edge routes /api/* to the backend Function URL read from SSM (replaces Day 9 CF Function)',
});
