import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as path from 'path';

export class Day04DynamodbStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1) DynamoDB 테이블 정의
    //    - Partition Key: id (string)
    //    - On-demand billing (사용량만큼 과금, 학습 단계에선 사실상 무료)
    //    - 스택 삭제 시 테이블도 함께 삭제 (학습용이라 OK, 실서비스 NEVER)
    const table = new ddb.Table(this, 'NotesTable', {
      partitionKey: { name: 'id', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 2) Lambda 함수 정의
    const fn = new lambda.Function(this, 'NotesFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda')),
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: {
        // 핸들러에서 process.env.TABLE_NAME 으로 읽음
        TABLE_NAME: table.tableName,
      },
    });

    // 3) Lambda에 DDB read/write 권한 부여
    //    CDK가 알아서 최소 권한 IAM 정책 만들어서 Lambda Role에 attach함
    //    (PutItem, GetItem, Scan, Query, UpdateItem, DeleteItem ...)
    table.grantReadWriteData(fn);

    // 4) Outputs — 호출/디버깅 편의용
    new cdk.CfnOutput(this, 'FunctionName', { value: fn.functionName });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
