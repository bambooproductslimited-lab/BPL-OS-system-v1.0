import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
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
//
// Redesigned around the icon/avatar language established elsewhere: an
// initials avatar for the signed-in user's own messages, a sparkle badge
// for the assistant's replies (mirroring Messages' bubble+avatar layout).

const AVATAR_COLORS = ['#3f7d3b', '#2f5f2c', '#7d5c3f', '#3f5a7d', '#7d3f5c', '#5c3f7d', '#7d6b3f', '#3f7d6b'];
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return ((parts[0] ? parts[0][0] : '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function avatarColor(name) { return AVATAR_COLORS[hashStr(name || '') % AVATAR_COLORS.length]; }

function SparkleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

const SUGGESTIONS = [
  'Summarize company operations today.',
  'Which products are below reorder level?',
  'What is in my approval queue?',
  'How is this month\'s revenue looking?'
];

export default function AssistantPage() {
  const { session } = useAuth();
  const userName = session && session.employee ? session.employee.firstName + ' ' + session.employee.lastName : 'You';
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
            <div key={i} className={'assistant-row ' + (m.role === 'user' ? 'assistant-row-user' : 'assistant-row-reply')}>
              {m.role === 'user' ? (
                <span className="assistant-avatar" style={{ background: avatarColor(userName) }}>{initials(userName)}</span>
              ) : (
                <span className="assistant-avatar assistant-avatar-bot"><SparkleIcon /></span>
              )}
              <div className="assistant-bubble">{m.text}</div>
            </div>
          ))}
          {busy && (
            <div className="assistant-row assistant-row-reply">
              <span className="assistant-avatar assistant-avatar-bot"><SparkleIcon /></span>
              <div className="assistant-thinking">Thinking…</div>
            </div>
          )}
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
