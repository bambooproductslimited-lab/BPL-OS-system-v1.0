import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, API_URL } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import RowMenu from '../components/RowMenu';
import { Glossary, Hero, Insights, Section, Status, avatarColor, fmtDate, initials, jump } from '../components/DashKit';
import { tr, msg } from '../lib/i18n.jsx';
import './EmployeesPage.css';
import './AssistantPage.css';

// The AI Assistant: Claude, answering from the OS through the backend
// (POST /api/ai/chat -> ai.service.js), which runs Claude's tools as the
// signed-in person — so it sees only what their role can see. Same
// "explains itself" layout as the dashboards (components/DashKit.jsx):
// how the person has used it, changes waiting for their Confirm, what it
// can look up and do for their role, the saved conversations beside the
// chat, every change it prepared and how it ended, and the Claude apps
// connected as them (GET /api/ai/overview).
//
// When asked to change something (create a task, request leave…), Claude
// only prepares it: the reply carries action cards, and nothing happens
// until the person presses Confirm on one (POST /api/ai/actions/:id/confirm).
// Conversations are saved for the person who had them only; ?c=<id> opens
// one. Without an ANTHROPIC_API_KEY on the server every reply says so and
// nothing is saved; the page also says it up front.

// What each tool is, in words, with a question that uses it. Only the ones
// the person's role allows are shown (the overview lists them).
const TOOL_INFO = {
  get_company_overview: { label: msg('Today\'s company snapshot'), what: msg('Headcount, who is in, late or on leave, stock running low, approvals and — with report access — revenue.'), ask: msg('Summarize company operations today.') },
  search_employees: { label: msg('People'), what: msg('Names, job titles, departments and contact details.'), ask: msg('Who works in the finance department?') },
  get_attendance: { label: msg('Attendance'), what: msg('Who clocked in, who is late and who is absent, by day.'), ask: msg('Who is late today?') },
  search_products: { label: msg('Products and stock'), what: msg('Stock levels, reorder levels and prices.'), ask: msg('Which products are below reorder level?') },
  search_customers: { label: msg('Clients'), what: msg('Client details, category and contacts.'), ask: msg('Which of our clients are VIPs?') },
  list_invoices: { label: msg('Invoices'), what: msg('What was billed, paid and is still owed.'), ask: msg('Which invoices are overdue?') },
  list_quotations: { label: msg('Quotations'), what: msg('Offers sent to clients and their answers.'), ask: msg('Which quotations are still waiting for an answer?') },
  search_suppliers: { label: msg('Suppliers and farmers'), what: msg('Who supplies what, and how to reach them.'), ask: msg('Which suppliers sell bamboo poles?') },
  list_tasks: { label: msg('Tasks'), what: msg('Tasks, who has them and when they are due.'), ask: msg('What tasks are due this week?') },
  list_leave_requests: { label: msg('Leave'), what: msg('Leave requests and who is away.'), ask: msg('Who is on leave this week?') },
  get_approval_queue: { label: msg('Your approvals'), what: msg('What is waiting for your decision.'), ask: msg('What is in my approval queue?') },
  list_purchase_requests: { label: msg('Purchase requests'), what: msg('What was asked to be bought and where it stands.'), ask: msg('Which purchase requests are still open?') },
  list_expense_claims: { label: msg('Expense claims'), what: msg('Claims, their amounts and where they stand.'), ask: msg('Which expense claims are waiting for a decision?') },
  create_task: { label: msg('Create a task'), what: msg('For you or someone else, with a due date and priority.'), ask: msg('Create a task for me to check the kiln by Friday.') },
  request_leave: { label: msg('Request leave'), what: msg('For you, on the dates you give.'), ask: msg('Request annual leave for me next Monday to Wednesday.') },
  submit_purchase_request: { label: msg('Ask to buy something'), what: msg('A purchase request that goes for approval.'), ask: msg('Ask to buy 20 bags of cement for the workshop.') },
  add_customer: { label: msg('Add a client'), what: msg('A new client with their contact details.'), ask: msg('Add a new client called Riverside Lodge, phone 020 000 0000.') },
  update_product_stock: { label: msg('Correct a stock count'), what: msg('Sets the stock to what was counted, with the reason.'), ask: msg('We counted 40 bamboo stools. Correct the stock.') }
};

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
const ACTION_TONE = { pending: 'warn', done: 'good', cancelled: 'muted', failed: 'bad', expired: 'muted' };

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

// The Claude connector (backend src/mcp/): the same tools, from claude.ai
// and the Claude apps, signed in as the person with their OS email and
// password.
const CONNECTOR_URL = API_URL.replace(/\/api\/?$/, '') + '/mcp';

function CopyUrl() {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(CONNECTOR_URL);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard permission denied — the address is still selectable text */ }
  }
  return (
    <div className="assistant-connector-url">
      <code>{CONNECTOR_URL}</code>
      <button type="button" className="btn btn-secondary" onClick={copy}>{copied ? tr('Copied!') : tr('Copy')}</button>
    </div>
  );
}

function when(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === today.toDateString() ? tr('today {time}', { time }) : fmtDate(ts) + ' ' + time;
}

export default function AssistantPage() {
  const { session } = useAuth();
  const userName = session && session.employee ? session.employee.firstName + ' ' + session.employee.lastName : tr('You');
  const [params, setParams] = useSearchParams();
  const [overview, setOverview] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(() => params.get('c'));
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState(null);
  const [changeChip, setChangeChip] = useState('all');
  const scrollRef = useRef(null);
  // Set when a conversation was just started on screen: its messages are
  // already showing, so the id changes without fetching them again.
  const skipOpen = useRef(false);

  const loadSide = useCallback(async () => {
    try {
      const [ov, cs] = await Promise.all([api.get('/ai/overview'), api.get('/ai/conversations')]);
      setOverview(ov);
      setConversations(cs);
    } catch (err) {
      setError(err.message);
    }
  }, []);
  useEffect(() => { loadSide(); }, [loadSide]);

  // Opening a saved conversation (from the list, a link, or ?c=).
  useEffect(() => {
    if (skipOpen.current) { skipOpen.current = false; return undefined; }
    if (!conversationId) { setMessages([]); return undefined; }
    let live = true;
    setOpening(true);
    api.get('/ai/conversations/' + conversationId)
      .then((c) => { if (live) setMessages(c.messages); })
      .catch((err) => { if (live) { setError(err.message); setConversationId(null); } })
      .finally(() => { if (live) setOpening(false); });
    return () => { live = false; };
  }, [conversationId]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  function pick(id) {
    setError(null);
    setConversationId(id);
    if (id) params.set('c', id); else params.delete('c');
    setParams(params, { replace: true });
  }

  async function send(text) {
    const q = text.trim();
    if (!q || busy) return;
    setMessages((prev) => prev.concat([{ role: 'user', text: q }]));
    setInput('');
    setBusy(true);
    setError(null);
    try {
      const r = await api.post('/ai/chat', { message: q, conversationId: conversationId || undefined });
      setMessages((prev) => prev.concat([{ role: 'assistant', text: r.reply, actions: r.actions || [] }]));
      if (r.conversation && r.conversation.id !== conversationId) {
        skipOpen.current = true;
        setConversationId(r.conversation.id);
        params.set('c', r.conversation.id);
        setParams(params, { replace: true });
      }
      loadSide();
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
    loadSide();
  }

  async function rename(c) {
    const title = window.prompt(tr('Name this conversation'), c.title);
    if (!title || !title.trim() || title.trim() === c.title) return;
    try { await api.patch('/ai/conversations/' + c.id, { title }); loadSide(); } catch (err) { setError(err.message); }
  }
  async function remove(c) {
    if (!window.confirm(tr('Delete the conversation "{title}"? Changes already made through it stay made.', { title: c.title }))) return;
    try {
      await api.del('/ai/conversations/' + c.id);
      if (c.id === conversationId) pick(null);
      loadSide();
    } catch (err) { setError(err.message); }
  }
  async function disconnect(c) {
    if (!window.confirm(tr('Disconnect {name}? It will no longer reach Bamboo OS as you until you connect it again.', { name: c.name }))) return;
    try { await api.del('/ai/connections/' + encodeURIComponent(c.clientId)); loadSide(); } catch (err) { setError(err.message); }
  }

  function handleSubmit(e) {
    e.preventDefault();
    send(input);
  }

  if (!overview) return error ? <div className="error-banner" role="alert">{error}</div> : <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const s = overview.stats;
  const lookups = overview.tools.filter((t) => t.kind === 'read' && TOOL_INFO[t.name]);
  const doers = overview.tools.filter((t) => t.kind === 'action' && TOOL_INFO[t.name]);
  const pending = overview.pending;
  const failedLately = overview.recent.filter((a) => a.status === 'failed' && Date.now() - new Date(a.createdAt).getTime() < 7 * 86400000);
  const suggestions = overview.tools.map((t) => TOOL_INFO[t.name]).filter(Boolean).map((t) => t.ask).slice(0, 6);

  function showChanges(chip) { setChangeChip(chip); jump('ai-changes'); }
  const stats = [
    { icon: 'send', value: String(s.questionsThisMonth), label: s.questionsThisMonth === 1 ? tr('question you asked this month') : tr('questions you asked this month'), note: s.questions ? tr('{n} this week · {c} conversations kept', { n: s.questionsThisWeek, c: s.conversations }) : tr('nothing asked yet'), onClick: () => jump('ai-chat') },
    { icon: 'clock', value: String(pending.length), label: pending.length === 1 ? tr('change waiting for your Confirm') : tr('changes waiting for your Confirm'), note: pending.length ? tr('each expires {m} minutes after it was prepared', { m: overview.expiresAfterMinutes }) : tr('nothing waiting'), tone: pending.length ? 'warn' : '', onClick: () => showChanges('pending') },
    { icon: 'check', value: String(s.done), label: s.done === 1 ? tr('change made for you') : tr('changes made for you'), note: tr('{n} this month · {c} through the Claude app', { n: s.doneThisMonth, c: s.doneByConnector }), tone: s.done ? 'good' : '', onClick: () => showChanges('done') },
    { icon: 'spark', value: String(lookups.length + doers.length), label: tr('things it can do for your role'), note: tr('{r} to look up · {a} to prepare for you', { r: lookups.length, a: doers.length }), onClick: () => jump('ai-can') }
  ];

  const insights = [];
  if (!overview.configured) insights.push({ tone: 'bad', icon: 'warn', text: tr('The assistant isn\'t switched on yet. An administrator needs to add the Anthropic API key (ANTHROPIC_API_KEY) to the backend\'s environment on Render. Until then every question gets this same answer.'), action: null });
  if (pending.length) insights.push({ tone: 'warn', icon: 'clock', text: pending.length === 1 ? tr('"{summary}" is waiting for you to press Confirm.', { summary: pending[0].summary }) : tr('{n} prepared changes are waiting for you to press Confirm.', { n: pending.length }), action: { label: tr('Show them'), run: () => showChanges('pending') } });
  if (failedLately.length) insights.push({ tone: 'bad', icon: 'void', text: tr('"{summary}" could not be done: {why}', { summary: failedLately[0].summary, why: failedLately[0].result || '—' }), action: { label: tr('Show them'), run: () => showChanges('failed') } });
  if (overview.connections.length) insights.push({ tone: 'info', icon: 'info', text: overview.connections.length === 1 ? tr('{name} is connected to Bamboo OS as you, last used {date}.', { name: overview.connections[0].name, date: fmtDate(overview.connections[0].lastUsed) }) : tr('{n} Claude apps are connected to Bamboo OS as you.', { n: overview.connections.length }), action: { label: tr('Manage'), run: () => jump('ai-connector') } });
  if (overview.configured && !s.questions) insights.push({ tone: 'info', icon: 'spark', text: tr('Ask in your own words, in English, French or Chinese. It looks things up before answering and never changes anything without your Confirm.'), action: { label: tr('Start'), run: () => jump('ai-chat') } });
  if (!insights.length) insights.push({ tone: 'good', icon: 'check', text: tr('Nothing is waiting for you. Every change it prepared has been decided.') });

  const changeTest = { all: () => true, pending: (a) => a.status === 'pending', done: (a) => a.status === 'done', dropped: (a) => a.status === 'cancelled' || a.status === 'expired', failed: (a) => a.status === 'failed' };
  const changes = overview.recent.filter(changeTest[changeChip] || changeTest.all);
  const changeChips = [
    ['all', tr('All'), overview.recent.length], ['pending', tr('Waiting'), overview.recent.filter(changeTest.pending).length],
    ['done', tr('Done'), overview.recent.filter(changeTest.done).length], ['dropped', tr('Cancelled or expired'), overview.recent.filter(changeTest.dropped).length],
    ['failed', tr('Could not be done'), overview.recent.filter(changeTest.failed).length]
  ].filter(([k, , c]) => c > 0 || k === 'all' || k === changeChip);
  const current = conversations.find((c) => c.id === conversationId);

  return (
    <div className="dk ai">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('Intelligence')}
        title={tr('AI Assistant')}
        sub={tr('Ask about the company in plain words. It answers only from what your role can see, and when you ask it to do something it prepares it — nothing happens until you press Confirm. Press a number to go to it.')}
        actions={<button type="button" className="btn btn-primary" onClick={() => { pick(null); jump('ai-chat'); }}>{tr('New conversation')}</button>}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      <Section id="ai-chat" title={current ? current.title : tr('New conversation')} sub={tr('Your conversations are kept for you only. Pick one to carry on where you left off.')}>
        <div className="ai-chat">
          <aside className="ai-rail" aria-label={tr('Your conversations')}>
            <button type="button" className={'ai-convo ai-convo-new' + (!conversationId ? ' is-on' : '')} onClick={() => pick(null)}>+ {tr('New conversation')}</button>
            {conversations.map((c) => (
              <div key={c.id} className={'ai-convo' + (c.id === conversationId ? ' is-on' : '')}>
                <button type="button" className="ai-convo-open" onClick={() => pick(c.id)}>
                  <span className="ai-convo-title">{c.title}</span>
                  <span className="dk-muted ai-convo-meta">
                    {when(c.updatedAt)} · {c.questions === 1 ? tr('1 question') : tr('{n} questions', { n: c.questions })}
                    {c.pending > 0 && <span className="ai-convo-pending">{tr('{n} to confirm', { n: c.pending })}</span>}
                  </span>
                </button>
                <RowMenu actions={[{ label: tr('Rename'), onClick: () => rename(c) }, { label: tr('Delete'), onClick: () => remove(c), danger: true }]} />
              </div>
            ))}
            {!conversations.length && <p className="dk-muted ai-rail-empty">{tr('Your conversations will be kept here.')}</p>}
          </aside>
          <div className="assistant-panel">
            <div className="assistant-history" ref={scrollRef}>
              {opening && <div className="assistant-thinking">{tr('Loading…')}</div>}
              {!opening && !messages.length && (
                <div className="assistant-suggestions">
                  <div className="assistant-suggestions-label">{tr('Try asking:')}</div>
                  {suggestions.map((q) => (
                    <button key={q} type="button" className="btn btn-secondary assistant-suggestion-btn" onClick={() => send(tr(q))}>{tr(q)}</button>
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
                aria-label={tr('Your question')}
                disabled={busy}
              />
              <button className="btn btn-primary" type="submit" disabled={busy || !input.trim()}>{tr('Send')}</button>
            </form>
          </div>
        </div>
      </Section>

      <Section id="ai-can" title={tr('What it can do for you')} sub={tr('Decided by your role: it can only look up and prepare what you could on the screens yourself. Press a question to ask it.')}>
        <div className="ai-can">
          <div className="ai-can-col">
            <h4 className="ai-can-h">{tr('Looks up')}</h4>
            <ul className="ai-tools">
              {lookups.map((t) => {
                const info = TOOL_INFO[t.name];
                return (
                  <li key={t.name}>
                    <strong>{tr(info.label)}</strong>
                    <span className="dk-muted">{tr(info.what)}</span>
                    <button type="button" className="ai-ask" onClick={() => { jump('ai-chat'); send(tr(info.ask)); }}>“{tr(info.ask)}”</button>
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="ai-can-col">
            <h4 className="ai-can-h">{tr('Prepares for you to confirm')}</h4>
            {doers.length ? (
              <ul className="ai-tools">
                {doers.map((t) => {
                  const info = TOOL_INFO[t.name];
                  return (
                    <li key={t.name}>
                      <strong>{tr(info.label)}</strong>
                      <span className="dk-muted">{tr(info.what)}</span>
                      <button type="button" className="ai-ask" onClick={() => { jump('ai-chat'); setInput(tr(info.ask)); }}>“{tr(info.ask)}”</button>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="dk-muted">{tr('Your role doesn\'t allow it to change anything for you. It can still look things up.')}</p>}
          </div>
        </div>
      </Section>

      <Section id="ai-changes" title={tr('Changes it prepared')} sub={tr('The latest 30, here and through the Claude app, with how each one ended.')}>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {changeChips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={changeChip === key} className={'ppl-chip' + (changeChip === key ? ' is-on' : '')} onClick={() => setChangeChip(key)}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
        </div>
        {!changes.length ? (
          <div className="dk-empty"><p>{overview.recent.length ? tr('Nothing here.') : tr('Nothing prepared yet. Ask it to create a task, request leave or the like, and the change shows up here.')}</p></div>
        ) : (
          <ul className="ai-changes">
            {changes.map((a) => (
              <li key={a.id} className={'ai-change is-' + a.status}>
                <div className="ai-change-main">
                  <Status tone={ACTION_TONE[a.status]}>{tr(ACTION_STATUS[a.status] || ACTION_STATUS.failed)}</Status>
                  <span className="ai-change-summary">{a.summary}</span>
                  <span className="dk-muted ai-change-meta">
                    {when(a.createdAt)} · {a.source === 'connector' ? tr('through the Claude app') : tr('in the assistant')}
                    {a.result && a.status !== 'cancelled' ? ' · ' + a.result : ''}
                  </span>
                </div>
                <div className="ai-change-actions">
                  {a.status === 'pending' && <button type="button" className="btn btn-primary" onClick={() => decide(a.id, 'confirm')}>{tr('Confirm')}</button>}
                  {a.status === 'pending' && <button type="button" className="btn btn-secondary" onClick={() => decide(a.id, 'cancel')}>{tr('Cancel')}</button>}
                  {a.conversationId && <button type="button" className="btn btn-secondary" onClick={() => { pick(a.conversationId); jump('ai-chat'); }}>{tr('Open the conversation')}</button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="ai-connector" title={tr('Use Bamboo OS from the Claude app')} sub={tr('In claude.ai or the Claude app, go to Settings → Connectors → Add custom connector and paste this address. You sign in with your OS email and password, and Claude sees only what you can see. The Claude app asks you before each change.')}>
        <CopyUrl />
        {overview.connections.length > 0 && (
          <ul className="ai-connections">
            {overview.connections.map((c) => (
              <li key={c.clientId}>
                <span className="ai-conn-name"><strong>{c.name}</strong><span className="dk-muted">{tr('Connected {since} · last used {last}', { since: fmtDate(c.since), last: when(c.lastUsed) })}</span></span>
                <button type="button" className="btn btn-secondary" onClick={() => disconnect(c)}>{tr('Disconnect')}</button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Glossary items={[
        [tr('AI Assistant'), tr('Claude, made by Anthropic, answering from Bamboo OS. It reads the same records your screens show you, as you.')],
        [tr('Looks up'), tr('It searches the OS before answering. If it can\'t find something, or your role can\'t see it, it says so rather than guessing.')],
        [tr('Prepared change'), tr('When you ask it to do something, it checks the request and shows a card. Nothing happens until you press Confirm on it.')],
        [tr('Expired'), tr('A prepared change nobody confirmed within {m} minutes. Ask again if you still want it.', { m: overview.expiresAfterMinutes })],
        [tr('Conversation'), tr('Your questions and its answers, kept so you can carry on later. Only you can open them. Deleting one doesn\'t undo changes made through it.')],
        [tr('Claude app connection'), tr('Using Bamboo OS from claude.ai or the Claude apps, signed in as you. Disconnect it here to cut it off at once.')]
      ]} />
    </div>
  );
}
