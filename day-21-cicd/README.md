# Day 21: CI/CD — GitHub Actions OIDC 키리스 배포

지금까지는 매번 로컬에서 `npm run deploy` 를 손으로 쳤다. Day 21 은 그걸 **GitHub Actions** 로 옮긴다. 핵심은 **OIDC(키리스)**: AWS 액세스 키를 GitHub 에 저장하지 않고, 워크플로 실행마다 GitHub 가 발급한 **단명 토큰**으로 AWS 역할을 잠깐 빌려 배포한다. 저장된 장기 키 0개.

> **규칙: 매일 한 가지만 더하기.** Day 21 은 "CI/CD 파이프라인" 한 가지. 에이전트 스택(Day 20)은 **그대로**, 바깥에 배포 자동화를 두른다. push/PR 엔 `cdk synth`(검증)만, 실제 배포는 **수동(workflow_dispatch)** — 매 커밋 자동배포로 인한 과금·사고 방지.

## 🎯 이 day 가 답하는 것

1. **왜 OIDC 인가** — 예전엔 AWS 키를 `Secrets` 에 박았다(유출·회전 부담). OIDC 는 GitHub↔AWS 가 **신뢰 관계**만 맺고, 실행마다 단명 토큰을 교환한다 → **저장 키 없음**. 신뢰는 "이 레포의 워크플로"로만 한정.
2. **닭-달걀을 어떻게 푸나** — CI 가 배포할 역할은, 그 CI 가 배포하는 스택 **안에 있으면 안 된다**(역할이 있어야 배포 가능). → **별도 `Day21PipelineStack`** 에 두고 **한 번만 수동 배포**해 부트스트랩.
3. **CI 역할에 관리자 권한을 주나** — 아니. `cdk deploy` 는 **부트스트랩 역할(`cdk-*`)을 assume** 해서 실제 작업을 한다. 그래서 CI 역할엔 **`sts:AssumeRole` on `cdk-*`** 만 준다(최소 권한).
4. **실수 배포를 어떻게 막나** — push/PR 트리거는 **`synth`(검증)까지만**. `deploy` 는 `if: workflow_dispatch` + GitHub `environment: production`(승인 규칙 가능)으로 **사람이 눌러야** 돈다.

## 🧩 구성 요소

| 파일 | 역할 |
|---|---|
| `lib/pipeline-stack.ts` | GitHub OIDC provider + **배포 역할**(키리스 trust + `cdk-*` assume) |
| `.github/workflows/serverless-agent.yml` | **repo 루트**의 워크플로 — synth(자동) / deploy(수동) |
| `lib/day-21-cicd-stack.ts` | 배포 대상 = Day 20 에이전트 스택 그대로(`Day21CicdStack`) |

> ⚠️ 워크플로 YAML 은 **반드시 repo 루트 `.github/workflows/`** 에 있어야 GitHub 가 인식한다(day 폴더 안에 두면 안 돎). `paths` 필터로 `day-21-cicd/**` 변경에만 반응하게 했다.

## 🔁 흐름

```
[git push / PR]  ──▶  synth job (자격증명 불필요)  ──▶  cdk synth (더미 context) = 검증
[Actions 탭에서 Run workflow]  ──▶  deploy job:
     GitHub OIDC 토큰 ──▶ AWS STS (역할 신뢰: repo:GWANG-MIN1/aws-serverless-agent:*)
        └─ 단명 자격증명 ──▶ cdk deploy Day21CicdStack
             └─ cdk-* 부트스트랩 역할 assume ──▶ 실제 리소스 생성
```

## 🛡️ 최소 권한 배포 역할 (핵심)

```ts
assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
  StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
  StringLike:   { 'token.actions.githubusercontent.com:sub': 'repo:GWANG-MIN1/aws-serverless-agent:*' },
}),
// 권한은 이것뿐 — cdk 부트스트랩 역할을 빌릴 수 있는 권한.
deployRole.addToPolicy(new iam.PolicyStatement({
  actions: ['sts:AssumeRole'], resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
}));
```

## 🚀 설정 + 검증 절차

### 0) 사전: CDK 부트스트랩 (한 번)
계정/리전이 `cdk bootstrap` 돼 있어야 한다(이미 배포해왔으면 돼 있음). 안 됐으면:
```powershell
npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1
```

### 1) 파이프라인 스택 한 번 수동 배포 (배포 역할 생성)
```powershell
cd day-21-cicd
npm install
# 계정에 이미 GitHub OIDC provider 가 있으면: 끝에 -c oidcProviderArn=<arn> 추가(중복 생성 방지)
npx cdk deploy Day21PipelineStack
# Output: GithubDeployRoleArn 복사
```

### 2) GitHub 레포 설정 (Settings → Secrets and variables → Actions)
- **Variables**: `AWS_DEPLOY_ROLE_ARN` = 위 `GithubDeployRoleArn`, (옵션) `ALERT_EMAIL`
- **Secrets**: `DISCORD_PUBLIC_KEY`, `CALENDAR_ICS_URL`

### 3) synth 자동 검증 확인
`day-21-cicd/` 를 건드려 push(또는 PR) → **Actions 탭**에서 `synth` job 이 초록이면 검증 파이프라인 동작 ✅ (AWS 자격증명 없이 합성만).

### 4) 수동 배포
**Actions 탭 → serverless-agent CI/CD → Run workflow** → `deploy` job 이:
- OIDC 로 역할 assume(저장 키 0) → `cdk deploy Day21CicdStack` 성공하면 **키리스 배포 완료** ✅

### 5) 정리
```powershell
npx cdk destroy Day21CicdStack --force      # 에이전트 스택 (Lambda@Edge 지연은 Day 16 #46)
npx cdk destroy Day21PipelineStack --force  # 배포 역할/ OIDC provider (provider 를 import 했으면 안 지워짐)
```

## ⚠️ 함정 / 트러블슈팅 (Day 21 발견분)

| # | 함정 | 원인 | 회피 |
|---|---|---|---|
| 71 | `EntityAlreadyExists: ...OIDC provider` | 계정에 GitHub OIDC provider 이미 존재 | `-c oidcProviderArn=<arn>` 로 **import** |
| 72 | 아무 레포나 역할 빌림(위험) | trust `sub` 가 너무 넓음 | `repo:owner/repo:*` 로 한정(브랜치까지 좁히려면 `:ref:refs/heads/main`) |
| 73 | "역할이 없어 배포 못 함" 순환 | 배포 역할을 에이전트 스택 안에 둠 | **별도 pipeline-stack** 으로 분리 + 1회 수동 배포 |
| 74 | CI 역할에 과한 권한 | 관리자 정책을 그대로 붙임 | `sts:AssumeRole on cdk-*` 만(부트스트랩이 실제 권한 보유) |
| 75 | deploy job 이 bootstrap 에러 | 계정/리전 미부트스트랩 | `cdk bootstrap` 먼저 |
| 76 | 워크플로가 안 돎 | YAML 을 day 폴더 안에 둠 | **repo 루트 `.github/workflows/`** 에 둬야 인식 |
| 77 | `Error: Credentials could not be loaded` | 워크플로에 `permissions: id-token: write` 누락 | OIDC 토큰 발급 권한 명시 |


## 🧠 남긴 숙제 → 다음 day 들로

| 숙제 | 어디서 |
|---|---|
| 캡스톤 회고 — 전체 아키텍처 종합 다이어그램 + 트러블슈팅 #1~77 요약 + 비용/보안 | Day 22 |
| PR 코멘트로 `cdk diff` 자동 게시 / main 머지 시 자동 배포(승인 게이트) | 옵션 |

## 🎁 Day 21 이 남긴 자산

- **키리스(OIDC) 배포** — 저장된 AWS 키 0개, 신뢰는 레포로 한정(DevOps 실무 표준)
- **닭-달걀 분리** — CI 정체성(pipeline-stack)과 배포 대상(agent-stack)을 갈라 부트스트랩
- **안전한 트리거 설계** — push=검증, 배포=수동/승인. 자동화하되 사고는 막는다
