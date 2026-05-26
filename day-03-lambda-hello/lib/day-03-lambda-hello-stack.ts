import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as path from 'path';

export class Day03LambdaHelloStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Lambda 함수 정의
    // CDK가 알아서:
    //  1) lambda/ 폴더를 zip으로 묶고
    //  2) S3에 업로드하고
    //  3) Lambda 함수 생성하면서 그 zip을 코드로 지정
    //  4) 실행 권한이 있는 IAM Role도 자동 생성
    const helloFn = new lambda.Function(this, 'HelloFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler.handler', // 파일명.export이름 → handler.mjs의 export const handler
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda')),
      memorySize: 128,                          // 최소 (가장 저렴)
      timeout: cdk.Duration.seconds(10),
      description: 'Day 3 hello world Lambda — first deployment via CDK',
    });

    // 배포 후 CLI에서 호출하기 편하게 함수 이름을 Output으로 노출
    new cdk.CfnOutput(this, 'FunctionName', {
      value: helloFn.functionName,
      description: 'Lambda function name (use with aws lambda invoke)',
    });

    new cdk.CfnOutput(this, 'FunctionArn', {
      value: helloFn.functionArn,
    });
  }
}
