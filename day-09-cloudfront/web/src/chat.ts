// Day 9 = 동일오리진 fetch. CORS preflight 자체가 없어진다.
//
// API_BASE 우선순위:
//   1) import.meta.env.VITE_API_BASE       — .env 로 명시한 값 (보통 "/api")
//   2) "/api"                              — 기본 fallback (CloudFront /api/* behavior)
//
// 끝 슬래시는 항상 보장 — 경로 합성시 // 가 생기지 않도록.

const RAW = (import.meta.env.VITE_API_BASE ?? '/api').trim();
export const API_BASE = RAW.endsWith('/') ? RAW : RAW + '/';

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
  const url = `${API_BASE}sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`history ${res.status}: ${await res.text()}`);
  const data: HistoryResponse = await res.json();
  return data.messages;
}

// POST /api/chat 의 RESPONSE_STREAM chunk 를 토큰 단위로 콜백.
//
// CloudFront 가 /api/* behavior 의 cachePolicy = CACHING_DISABLED + chunked transfer 를
// 그대로 passthrough 해주므로, 브라우저 입장에서 Day 8 (직접 Function URL) 과 동일하게 작동.
export async function streamChat(opts: {
  sessionId: string;
  message: string;
  onToken: (chunk: string) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const res = await fetch(`${API_BASE}chat`, {
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
  const tail = decoder.decode();
  if (tail) opts.onToken(tail);
}
