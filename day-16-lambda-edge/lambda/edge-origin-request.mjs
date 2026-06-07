// Day 16 — origin-request Lambda@Edge.  Day 9 의 CloudFront Function(/api strip)을 대체·확장.
//
// 하는 일:
//   1) /api/* 요청이면 → SSM 에서 backend Function URL 을 읽어(cold start 캐싱) origin 을 그쪽으로 갈아끼우고,
//      "/api" 접두어를 떼어 백엔드(Hono: /chat, /sessions/...)가 알아듣는 경로로 보낸다.
//   2) 그 외(프론트) 요청이면 → 확장자 없는 경로는 index.html 로(SPA fallback). 정적 파일은 S3 그대로.
//
// 왜 SSM 인가 (Day 16 의 핵심):
//   Day 9 는 backend host 를 distribution 설정에 "구워" 넣었다(deploy-time prop). 그러면 백엔드 URL 이 바뀔 때마다
//   CloudFront 를 다시 배포해야 한다. Day 16 은 host 를 SSM Parameter 에 두고 엣지가 런타임에 조회한다 →
//   백엔드와 엣지가 디커플링(백엔드만 바꿔도 60초 TTL 안에 엣지가 따라옴). 원본 packages/edge 의 정공법.
//
// Lambda@Edge 제약: 환경변수 못 씀 → 설정값은 소스에 상수로 박는다.
//   원본은 esbuild define 으로 주입하지만, 우리 값은 고정이고 Windows esbuild 의 define 따옴표
//   처리 버그도 있어 그냥 상수로 둔다(엣지는 env 불가라 어차피 빌드타임 고정이 정답).
//
// 원본 매핑: packages/edge/src/origin-request/index.ts (그대로 옮기고, 우리 백엔드에 맞춰 "/api" strip 추가).

import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const PROJECT = "serverless-agent";   // SSM 파라미터 이름 접두어 (스택의 PROJECT 와 일치)
const SSM_REGION = "us-east-1";        // 파라미터가 사는 리전 (Lambda@Edge 는 us-east-1 원천)

const ssm = new SSMClient({ region: SSM_REGION });

// backend URL 캐시 — 엣지 인스턴스가 살아있는 동안 60초 재사용.
const BACKEND_URL_TTL_MS = 60 * 1000;
let cached = null; // { value, expires }

// 원본 shared/ssm-parameters.ts 의 backendUrlName 과 동일 규칙.
const backendUrlParamName = () => `/${PROJECT}/backend/url`;

async function getBackendUrl() {
  if (cached && cached.expires > Date.now()) return cached.value;
  try {
    const out = await ssm.send(new GetParameterCommand({ Name: backendUrlParamName() }));
    const value = out.Parameter?.Value ?? null;
    cached = { value, expires: Date.now() + BACKEND_URL_TTL_MS };
    return value;
  } catch (e) {
    console.error("SSM lookup failed:", e);
    return null;
  }
}

export const handler = async (event) => {
  const request = event.Records[0].cf.request;
  const uri = request.uri;

  // ── 1) API 요청 → 백엔드로 라우팅 + "/api" strip ──
  if (uri === "/api" || uri.startsWith("/api/")) {
    const backendUrl = await getBackendUrl();
    if (!backendUrl) {
      return { status: "503", statusDescription: "Service Unavailable", body: "Backend URL not configured" };
    }
    const host = new URL(backendUrl).hostname;

    // origin 을 backend Function URL 로 동적 교체 (distribution 설정값을 런타임에 덮어씀).
    request.origin = {
      custom: {
        domainName: host,
        port: 443,
        protocol: "https",
        path: "",
        sslProtocols: ["TLSv1.2"],
        readTimeout: 30,
        keepaliveTimeout: 5,
        customHeaders: {},
      },
    };
    // Function URL 은 자신의 도메인 Host 만 받는다 → Host 헤더를 backend 호스트로.
    request.headers.host = [{ key: "Host", value: host }];

    // "/api" 접두어 제거 (우리 Hono 라우트엔 /api 가 없음 — Day 9 의 strip 을 엣지로 이관).
    request.uri = uri === "/api" || uri === "/api/" ? "/" : uri.slice(4);
    return request;
  }

  // ── 2) 프론트 요청 → SPA fallback ──
  //   확장자 없는 경로(/, /chat 등)는 index.html 로. 정적 파일(*.js, *.css, *.png)은 그대로 S3.
  const last = uri.split("/").pop() ?? "";
  if (uri === "/" || uri === "" || !last.includes(".")) {
    request.uri = "/index.html";
  }
  return request;
};
