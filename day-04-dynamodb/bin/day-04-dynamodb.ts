#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Day04DynamodbStack } from '../lib/day-04-dynamodb-stack';

const app = new cdk.App();
new Day04DynamodbStack(app, 'Day04DynamodbStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Day 4: DynamoDB CRUD via Lambda',
});
