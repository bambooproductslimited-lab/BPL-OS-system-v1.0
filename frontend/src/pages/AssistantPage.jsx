import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { tr, msg } from '../lib/i18n.jsx';
import './AssistantPage.css';

// The AI Assistant: Claude, answering from the OS through the backend
// (POST /api/ai/chat -> ai.service.js), which runs Claude's tools as the
// signed-in person — so it sees only what their role can see. Without an
// ANTHROPIC_API_KEY configured on the server, every reply is the same
// "not configured" message — that's the backend's own graceful fallback,
// not something this page special-cases.
//
// When asked to change something (create a task, request leave…), Claude
// only prepares it: the reply carries action cards, and nothing happens
// until the person presses Confirm on one (POST /api/ai/actions/:id/confirm).
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

// Claude is asked to write plain text; **bold** is the one mark-up it may
// use, rendered here without ever treating the reply as HTML.
function ReplyText({ text }) {
  const parts = String(text || '').split(/\*\*(.+?)\*\*/g);
  return parts.map((p, i) => (i % 2 ? <strong key={i}>{p}</strong> : p));
}

const ACTION_STATUS = {
  pending: msg('Waiting for you to confirm'),
  done: msg('Done'),
  cancelled: msg('Cancelled'),
  failed: msg('Could not be done'),
  expired: msg('Expired — ask again')
};

// How a card ended, told to Claude with the rest of the conversation so it
// knows what was confirmed and doesn't offer the same change twice.
function historyText(m) {
  if (!m.actions || !m.actions.length) return m.text;
  return m.text + '\n\n' + m.actions.map((a) => '[Prepared: ' + a.summary + ' — ' + a.status + (a.result ? ': ' + a.result : '') + ']').join('\n');
}

function ActionCard({ action, onDecide }) {
  const [working, setWorking] = useState(false);
  async function decide(what) {
    setWorking(true);
    try { await onDecide(action.id, what); } finally { setWorking(false); }
  }
  return (
    <div className={'assistant-action assistant-action-' + action.status}>
      <div className="assistant-action-summary">{action.summary}</div>
      {action.status === 'pending' ? (
        <div className="assistant-action-buttons">
          <button type="button" className="btn btn-primary" disabled={working} onClick={() => decide('confirm')}>{tr('Confirm')}</button>
          <button type="button" className="btn btn-secondary" disabled={working} onClick={() => decide('cancel')}>{tr('Cancel')}</button>
        </div>
      ) : (
        <div className="assistant-action-status">
          {tr(ACTION_STATUS[action.status] || ACTION_STATUS.failed)}
          {action.result && action.status !== 'cancelled' ? ' · ' + action.result : ''}
        </div>
      )}
    </div>
  );
}

const SUGGESTIONS = [
  msg('Summarize company operations today.'),
  msg('Which products are below reorder level?'),
  msg('What is in my approval queue?'),
  msg('How is this month\'s revenue looking?'),
  msg('Who is late today?'),
  msg('Create a task for me to check the kiln by Friday.')
];

export default function AssistantPage() {
  const { session } = useAuth();
  const userName = session && session.employee ? session.employee.firstName + ' ' + session.employee.lastName : tr('You');
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
    const history = messages.map((m) => ({ role: m.role, text: historyText(m) }));
    setMessages(messages.concat([{ role: 'user', text: q }]));
    setInput('');
    setBusy(true);
    setError(null);
    try {
      const r = await api.post('/ai/chat', { message: q, history });
      setMessages((prev) => prev.concat([{ role: 'assistant', text: r.reply, actions: r.actions || [] }]));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function updateAction(id, patch) {
    setMessages((prev) => prev.map((m) => (m.actions && m.actions.some((a) => a.id === id)
      ? { ...m, actions: m.actions.map((a) => (a.id === id ? { ...a, ...patch } : a)) }
      : m)));
  }

  async function decide(id, what) {
    try {
      const r = await api.post('/ai/actions/' + id + '/' + what, {});
      updateAction(id, { status: r.status, result: r.result });
    } catch (err) {
      // Already decided or expired: the server says which, in words.
      updateAction(id, { status: /expired/i.test(err.message) ? 'expired' : 'failed', result: err.message });
    }
  }

  function handleSubmit(e) {
    e.preventDefault();
    send(input);
  }

  return (
    <div>
      <p className="assistant-intro">
        {tr('Answers only from what your role can see — the same data your dashboard and screens already show you. When you ask it to do something, it prepares it and nothing happens until you press Confirm.')}
      </p>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="assistant-panel">
        <div className="assistant-history" ref={scrollRef}>
          {!messages.length && (
            <div className="assistant-suggestions">
              <div className="assistant-suggestions-label">{tr('Try asking:')}</div>
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="btn btn-secondary assistant-suggestion-btn" onClick={() => send(tr(s))}>{tr(s)}</button>
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
              <div className="assistant-message">
                <div className="assistant-bubble">{m.role === 'user' ? m.text : <ReplyText text={m.text} />}</div>
                {(m.actions || []).map((a) => <ActionCard key={a.id} action={a} onDecide={decide} />)}
              </div>
            </div>
          ))}
          {busy && (
            <div className="assistant-row assistant-row-reply">
              <span className="assistant-avatar assistant-avatar-bot"><SparkleIcon /></span>
              <div className="assistant-thinking">{tr('Thinking…')}</div>
            </div>
          )}
        </div>
        <form className="assistant-form" onSubmit={handleSubmit}>
          <input
            className="input assistant-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={tr('Ask about attendance, stock, sales, approvals…')}
            disabled={busy}
          />
          <button className="btn btn-primary" type="submit" disabled={busy}>{tr('Send')}</button>
        </form>
      </div>
    </div>
  );
}
