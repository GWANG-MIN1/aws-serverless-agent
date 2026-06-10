#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Day19CalendarSkillStack } from '../lib/day-19-calendar-skill-stack';

const app = new cdk.App();
// iCloud 공개 캘린더 링크와 시간대는 배포 시 context 로 주입한다.
new Day19CalendarSkillStack(app, 'Day19CalendarSkillStack', {
  // Lambda@Edge 가 그대로 있으므로 us-east-1 고정 (Day 16 그대로).
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  description: 'Day 19: read-only iCloud public ICS calendar skill injected into the agent sandbox',
});
