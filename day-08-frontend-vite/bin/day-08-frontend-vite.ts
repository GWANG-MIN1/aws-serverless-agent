#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Day08FrontendViteStack } from '../lib/day-08-frontend-vite-stack';

const app = new cdk.App();
new Day08FrontendViteStack(app, 'Day08FrontendViteStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Day 8: Vite React frontend on S3 static website hosting',
});
