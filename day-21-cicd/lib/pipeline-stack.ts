import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

// Day 21 Pipeline stack — GitHub Actions 가 "장기 키 없이" AWS 에 배포하도록 하는 OIDC 신뢰 설정.
//
// 왜 OIDC 인가:
//   예전 방식은 AWS 액세스 키를 GitHub Secrets 에 넣었다 → 유출 위험 + 회전 부담.
//   OIDC 는 GitHub 가 워크플로 실행마다 단명 토큰을 발급하고, AWS 가 그 토큰을 검증해 역할을
//   잠깐 빌려준다 → 저장된 키 0개. 신뢰는 "이 레포의 워크플로"로만 한정한다.
//
// 닭-달걀 회피: 이 역할은 자기가 배포할 에이전트 스택 "밖"에 있어야 한다(역할이 있어야 CI 가 배포 가능).
//   → 별도 스택으로 두고 한 번만 수동 배포(관리자 자격)해서 부트스트랩한다.
//
// 최소 권한: cdk deploy 는 CDK 부트스트랩 역할(cdk-*)을 assume 해서 실제 작업을 한다.
//   따라서 이 역할엔 "cdk-* 역할을 assume" 하는 권한만 주면 된다(광범위한 관리자 권한 불필요).

export interface Day21PipelineStackProps extends cdk.StackProps {
  /** "owner/repo" — 이 레포의 워크플로만 역할을 빌릴 수 있게 신뢰를 한정한다. */
  githubRepo: string;
  /** 계정에 이미 GitHub OIDC provider 가 있으면 그 ARN 을 주어 재사용(중복 생성 시 배포 실패 방지). */
  existingOidcProviderArn?: string;
}

export class Day21PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Day21PipelineStackProps) {
    super(scope, id, props);

    const provider = props.existingOidcProviderArn
      ? iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GithubOidc', props.existingOidcProviderArn)
      : new iam.OpenIdConnectProvider(this, 'GithubOidc', {
          url: 'https://token.actions.githubusercontent.com',
          clientIds: ['sts.amazonaws.com'],
        });

    // GitHub 워크플로가 assume 할 역할. 신뢰 조건:
    //   aud = sts.amazonaws.com,  sub = repo:<owner/repo>:*  (이 레포의 어떤 브랜치/PR 워크플로든)
    const deployRole = new iam.Role(this, 'GithubDeployRole', {
      roleName: 'serverless-agent-github-deploy',
      description: 'GitHub Actions assumes this via OIDC to run cdk deploy (keyless)',
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: { 'token.actions.githubusercontent.com:sub': `repo:${props.githubRepo}:*` },
      }),
    });

    // cdk deploy 는 부트스트랩 역할(cdk-<qualifier>-{deploy,file-publishing,lookup,...}-role)을 assume 한다.
    //   → 이 역할엔 그 assume 권한만. (실제 리소스 생성 권한은 부트스트랩의 cfn-exec-role 이 가짐)
    deployRole.addToPolicy(new iam.PolicyStatement({
      sid: 'AssumeCdkBootstrapRoles',
      actions: ['sts:AssumeRole'],
      resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
    }));

    new cdk.CfnOutput(this, 'GithubDeployRoleArn', {
      value: deployRole.roleArn,
      description: 'GitHub 레포 Variables 의 AWS_DEPLOY_ROLE_ARN 에 넣는다',
    });
  }
}
