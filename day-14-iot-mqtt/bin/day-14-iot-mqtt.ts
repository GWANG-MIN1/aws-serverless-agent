#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Day14IotMqttStack } from '../lib/day-14-iot-mqtt-stack';

const app = new cdk.App();
new Day14IotMqttStack(app, 'Day14IotMqttStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Day 14: Worker publishes each agent-loop step to IoT Core MQTT (sessions/${id}/events) for realtime push',
});
