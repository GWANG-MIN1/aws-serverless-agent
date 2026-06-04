#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Day13AgentLoopStack } from '../lib/day-13-agent-loop-stack';

const app = new cdk.App();
new Day13AgentLoopStack(app, 'Day13AgentLoopStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Day 13: Worker agent loop (Bedrock Converse toolUse/toolResult) + single executeCode tool in a node:vm sandbox',
});
