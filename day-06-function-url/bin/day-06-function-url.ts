#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Day06FunctionUrlStack } from '../lib/day-06-function-url-stack';

const app = new cdk.App();
new Day06FunctionUrlStack(app, 'Day06FunctionUrlStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Day 6: Lambda Function URL + Bedrock streaming',
});
