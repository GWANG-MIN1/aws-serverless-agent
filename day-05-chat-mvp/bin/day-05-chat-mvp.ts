#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Day05ChatMvpStack } from '../lib/day-05-chat-mvp-stack';

const app = new cdk.App();
new Day05ChatMvpStack(app, 'Day05ChatMvpStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Day 5: Chat MVP — Lambda + DynamoDB + Bedrock 통합',
});
