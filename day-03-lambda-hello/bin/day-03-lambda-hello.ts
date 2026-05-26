#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { Day03LambdaHelloStack } from '../lib/day-03-lambda-hello-stack';

const app = new cdk.App();
new Day03LambdaHelloStack(app, 'Day03LambdaHelloStack', {
  // CLI에 설정된 계정 + 리전 사용 (aws configure 한 값)
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Day 3: First Lambda deployed via AWS CDK',
});
