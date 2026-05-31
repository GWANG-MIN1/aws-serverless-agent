import { useEffect, useRef, useState } from 'react';
import { fetchHistory, streamChat, type Message, FUNCTION_URL } from './chat';

// Day 8 의 "최소" 라는 단어를 진짜로 지킨다:
//   - sessionId 는 입력 박스 하나 (localStorage 에 캐시)
//   - 히스토리 GET 1번 → 채팅 인풋 1개 → 스트리밍 응답 1개
//   - 라우팅/상태관리 라이브러리 0개

const SESSION_KEY = 'day08.sessionId';

function defaultSessionId(): string {
  const cached = localStorage.getItem(SESSION_KEY);
  if (cached) return cached;
  const fresh = 'sess-' + Math.random().toString(36).slice(2, 8);
  localStorage.setItem(SESSION_KEY, fresh);
  return fresh;
}

export function App() {
  const [sessionId, setSessionId] = useState(defaultSessionId);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 세션 바뀌면 캐시 + 히스토리 reload
  useEffect(() => {
    localStorage.setItem(SESSION_KEY, sessionId);
    let cancelled = false;
    setError(null);
    setMessages([]);
    fetchHistory(sessionId)
      .then((msgs) => { if (!cancelled) setMessages(msgs); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [sessionId]);

  // 메시지 늘면 맨 아래로
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setError(null);
    setBusy(true);

    // 1) 낙관적 렌더: user 메시지 + 빈 assistant placeholder
    setMessages((m) => [
      ...m,
      { role: 'user', content: text },
      { role: 'assistant', content: '' },
    ]);

    try {
      await streamChat({
        sessionId,
        message: text,
        onToken: (chunk) => {
          // assistant 마지막 메시지에 chunk 누적
          setMessages((m) => {
            const last = m[m.length - 1];
            if (!last || last.role !== 'assistant') return m;
            const updated: Message = { ...last, content: last.content + chunk };
            return [...m.slice(0, -1), updated];
          });
        },
      });
    } catch (err) {
      setError(String(err));
      // 실패시 placeholder 정리
      setMessages((m) => {
        const last = m[m.length - 1];
        if (last && last.role === 'assistant' && last.content === '') return m.slice(0, -1);
        return m;
      });
    } finally {
      setBusy(false);
    }
  }

  function onNewSession() {
    const fresh = 'sess-' + Math.random().toString(36).slice(2, 8);
    setSessionId(fresh);
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1>Day 8 — Chat</h1>
        <div className="session">
          <label>
            session
            <input
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              spellCheck={false}
            />
          </label>
          <button type="button" onClick={onNewSession}>new</button>
        </div>
      </header>

      {!FUNCTION_URL && (
        <div className="banner err">
          VITE_FUNCTION_URL 가 비어있다. <code>web/.env</code> 를 만들고 Day 7 의 Function URL 을 넣어라.
        </div>
      )}
      {error && <div className="banner err">{error}</div>}

      <div className="log" ref={scrollRef}>
        {messages.length === 0 && !busy && (
          <div className="empty">아직 메시지 없음. 아래에서 시작.</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <div className="role">{m.role}</div>
            <div className="content">{m.content || (busy && i === messages.length - 1 ? '…' : '')}</div>
          </div>
        ))}
      </div>

      <form className="composer" onSubmit={onSend}>
        <input
          type="text"
          placeholder={busy ? '응답 받는 중…' : '메시지'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()}>send</button>
      </form>
    </div>
  );
}
