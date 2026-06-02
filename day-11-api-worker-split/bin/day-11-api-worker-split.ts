#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Day11ApiWorkerSplitStack } from '../lib/day-11-api-worker-split-stack';

const app = new cdk.App();
new Day11ApiWorkerSplitStack(app, 'Day11ApiWorkerSplitStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Day 11: API ↔ Worker Lambda split (async InvocationType:Event, SQS-less)',
});
