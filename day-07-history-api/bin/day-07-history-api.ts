#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Day07HistoryApiStack } from '../lib/day-07-history-api-stack';

const app = new cdk.App();
new Day07HistoryApiStack(app, 'Day07HistoryApiStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Day 7: Hono multi-route (POST chat stream + GET history)',
});
