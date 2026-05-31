// Day 7 Function URL 클라이언트.
//
// 두 가지만 한다:
//   1) GET  /sessions/:id/messages?limit=N   — JSON 히스토리
//   2) POST /chat                            — RESPONSE_STREAM chunk 받아서 콜백
//
// Function URL 은 Day 7 에서 CORS allowedOrigins=['*'] 로 열어둠 → 브라우저 직접 fetch OK.

const RAW = (import.meta.env.VITE_FUNCTION_URL ?? '').trim();
// 끝 슬래시 보장 — 경로 합성 시 // 가 생기지 않게.
export const FUNCTION_URL = RAW.endsWith('/') ? RAW : RAW + '/';

export type Role = 'user' | 'assistant';

export interface Message {
  role: Role;
  content: string;
  ts?: string;
  sk?: string;
  inputTokens?: number;
  outputTokens?: number;
}

interface HistoryResponse {
  sessionId: string;
  count: number;
  messages: Message[];
  nextBefore: string | null;
}

export async function fetchHistory(sessionId: string, limit = 20): Promise<Message[]> {
  if (!FUNCTION_URL) throw new Error('VITE_FUNCTION_URL 가 비어있다. .env 확인.');
  const url = `${FUNCTION_URL}sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`history ${res.status}: ${await res.text()}`);
  const data: HistoryResponse = await res.json();
  // Day 7 핸들러가 이미 시간순(과거→최신) reverse 해서 보내준다.
  return data.messages;
}

// POST /chat 의 RESPONSE_STREAM chunk 를 토큰 단위로 콜백.
//
// Day 7 핸들러는 Bedrock 의 raw delta text 를 그대로 chunk 로 흘려보낸다 (JSON event 가 아님).
// 그러니 TextDecoder 로 디코드한 문자열을 그대로 onToken 에 넘기면 끝.
export async function streamChat(opts: {
  sessionId: string;
  message: string;
  onToken: (chunk: string) => void;
  signal?: AbortSignal;
}): Promise<void> {
  if (!FUNCTION_URL) throw new Error('VITE_FUNCTION_URL 가 비어있다. .env 확인.');
  const res = await fetch(`${FUNCTION_URL}chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: opts.sessionId, message: opts.message }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`chat ${res.status}: ${await res.text().catch(() => '')}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value && value.length) {
      opts.onToken(decoder.decode(value, { stream: true }));
    }
  }
  // flush trailing bytes
  const tail = decoder.decode();
  if (tail) opts.onToken(tail);
}
