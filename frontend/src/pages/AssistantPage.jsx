import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import './AssistantPage.css';

// Ported from Bamboo OS.dc.html's assistant screen (screens.assistant
// block + aiMessages/aiSuggestions/sendAi). The prototype's own sendAi()
// calls window.claude.complete, a bridge that only exists inside the
// design tool's own preview runtime — there is no such thing in a real
// deployment. This talks to a real backend proxy instead
// (POST /api/ai/chat -> ai.service.js), which assembles the same kind of
// permission-scoped company snapshot the prototype's ai.context described
// and calls the real Anthropic API server-side. Without an
// ANTHROPIC_API_KEY configured on the server, every reply is the same
// "not configured" message — that's the backend's own graceful fallback,
// not something this page special-cases.

const SUGGESTIONS = [
  'Summarize company operations today.',
  'Which products are below reorder level?',
  'What is in my approval queue?',
  'How is this month\'s revenue looking?'
];

export default function AssistantPage() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  async function send(text) {
    const q = text.trim();
    if (!q || busy) return;
    const history = messages.concat([{ role: 'user', text: q }]);
    setMessages(history);
    setInput('');
    setBusy(true);
    setError(null);
    try {
      const r = await api.post('/ai/chat', { message: q, history });
      setMessages((prev) => prev.concat([{ role: 'assistant', text: r.reply }]));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function handleSubmit(e) {
    e.preventDefault();
    send(input);
  }

  return (
    <div>
      <p className="assistant-intro">
        Answers only from what your role can see — the same data your dashboard and screens already
        show you. It does not take actions on your behalf.
      </p>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="assistant-panel">
        <div className="assistant-history" ref={scrollRef}>
          {!messages.length && (
            <div className="assistant-suggestions">
              <div className="assistant-suggestions-label">Try asking:</div>
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="btn btn-secondary assistant-suggestion-btn" onClick={() => send(s)}>{s}</button>
              ))}
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={'assistant-bubble ' + (m.role === 'user' ? 'assistant-bubble-user' : 'assistant-bubble-reply')}>
              {m.text}
            </div>
          ))}
          {busy && <div className="assistant-thinking">Thinking…</div>}
        </div>
        <form className="assistant-form" onSubmit={handleSubmit}>
          <input
            className="input assistant-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about attendance, stock, sales, approvals…"
            disabled={busy}
          />
          <button className="btn btn-primary" type="submit" disabled={busy}>Send</button>
        </form>
      </div>
    </div>
  );
}
