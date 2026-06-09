#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Day18DiscordBotStack } from '../lib/day-18-discord-bot-stack';

const app = new cdk.App();
// 디스코드 앱의 Public Key 는 배포 시 context 로 주입: npm run deploy -- -c discordPublicKey=<hex>
// (스택 안에서 this.node.tryGetContext('discordPublicKey') 로 읽는다.)
new Day18DiscordBotStack(app, 'Day18DiscordBotStack', {
  // Lambda@Edge 가 그대로 있으므로 us-east-1 고정 (Day 16 그대로).
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  description: 'Day 18: Discord interactions endpoint (Ed25519 verify + deferred) reuses the agent loop; Worker PATCHes the followup',
});
