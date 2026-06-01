import { useEffect, useRef, useState } from 'react';
import { fetchHistory, streamChat, type Message, API_BASE } from './chat';

// Day 9 UI = Day 8 그대로. 차이는 chat.ts 의 base url 뿐.
// 헤더만 "Day 9 — Chat (CloudFront)" 로 바꿨음.

const SESSION_KEY = 'day09.sessionId';

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
        <h1>Day 9 — Chat (CloudFront)</h1>
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

      <div className="banner">
        <small>API base: <code>{API_BASE}</code></small>
      </div>
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
