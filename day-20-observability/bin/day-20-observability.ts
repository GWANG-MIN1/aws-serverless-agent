#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Day20ObservabilityStack } from '../lib/day-20-observability-stack';

const app = new cdk.App();
new Day20ObservabilityStack(app, 'Day20ObservabilityStack', {
  // Lambda@Edge 가 그대로 있으므로 us-east-1 고정 (Day 16 그대로).
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  description: 'Day 20: observability — X-Ray active tracing (API->Worker->Bedrock) + CloudWatch dashboard + alarms (SNS)',
});
