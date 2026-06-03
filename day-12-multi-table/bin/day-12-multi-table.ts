#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Day12MultiTableStack } from '../lib/day-12-multi-table-stack';

const app = new cdk.App();
new Day12MultiTableStack(app, 'Day12MultiTableStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Day 12: single table -> Users/Sessions/Messages multi-table split (mirrors breath103 chat-* tables)',
});
