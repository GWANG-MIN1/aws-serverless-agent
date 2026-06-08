#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Day17CostSkillStack } from '../lib/day-17-cost-skill-stack';

const app = new cdk.App();
new Day17CostSkillStack(app, 'Day17CostSkillStack', {
  // Lambda@Edge 가 그대로 있으므로 us-east-1 고정 (Day 16 그대로).
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  description: 'Day 17: inject an awsCost() skill (Cost Explorer) into the executeCode sandbox so the agent can answer real AWS spend questions',
});
