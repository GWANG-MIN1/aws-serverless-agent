#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Day15BrowserMqttStack } from '../lib/day-15-browser-mqtt-stack';

const app = new cdk.App();
new Day15BrowserMqttStack(app, 'Day15BrowserMqttStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Day 15: browser subscribes to sessions/${id}/events over MQTT WSS — API issues a SigV4-presigned URL scoped to one session via STS AssumeRole',
});
