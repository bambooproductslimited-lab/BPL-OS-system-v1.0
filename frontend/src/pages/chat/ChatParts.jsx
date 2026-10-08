import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import Photo from '../../components/Photo';
import SearchInput, { matchesQuery } from '../../components/SearchInput';
import { codeLabel } from '../../lib/codeLabels';
import { money } from '../../lib/currency';
import { msg, tr } from '../../lib/i18n.jsx';
import './ChatParts.css';

// The pieces of a chat added with migration 0110 (messages.service.js):
// reactions, a message's actions, quoted replies, "seen" ticks, "typing…",
// @mentions, forwarding, and OS records shared as cards.

const P = {
  smile: <><circle cx="12" cy="12" r="8.5" /><path d="M8.5 14c.9 1.3 2.1 2 3.5 2s2.6-.7 3.5-2M9.3 9.8v.1M14.7 9.8v.1" /></>,
  reply: <path d="M9.5 6 4 11.5 9.5 17M4 11.5h9.5a6.5 6.5 0 0 1 6.5 6.5" />,
  more: <><circle cx="12" cy="5.5" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="12" cy="18.5" r="1.2" /></>,
  forward: <path d="M14.5 6 20 11.5 14.5 17M20 11.5h-9.5A6.5 6.5 0 0 0 4 18" />,
  pin: <path d="M9 4h6l-1 5 3 3v2H7v-2l3-3zM12 14v6" />,
  copy: <><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" /></>,
  edit: <path d="M5 19h3.5L19 8.5 15.5 5 5 15.5zM13.5 7l3.5 3.5" />,
  trash: <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  check: <path d="m4.5 12.5 4 4 9-9.5" />,
  check2: <><path d="m2.5 12.5 4 4 9-9.5" /><path d="m11 16.5.5.5 9-9.5" /></>,
  ban: <><circle cx="12" cy="12" r="8" /><path d="m6.5 6.5 11 11" /></>,
  grid: <><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></>,
  task: <><rect x="4.5" y="4.5" width="15" height="15" rx="3" /><path d="m8.5 12.5 2.5 2.5 5-5.5" /></>,
  invoice: <><path d="M6.5 3.5h8l3 3v14h-11z" /><path d="M9 11h6M9 14.5h6M9 7.5h3" /></>,
  quotation: <><path d="M6.5 3.5h8l3 3v14h-11z" /><path d="M9.5 11.5c0-1 .7-1.5 1.5-1.5M13 11.5c0-1 .7-1.5 1.5-1.5M9 15h6" /></>,
  customer: <><path d="M4.5 20V8.5L12 4l7.5 4.5V20" /><path d="M9.5 20v-5h5v5" /></>,
  lead: <><circle cx="10" cy="8.5" r="3" /><path d="M4.5 19c.6-3 2.8-4.8 5.5-4.8 1.3 0 2.5.4 3.4 1.1M17.5 13.5v6M14.5 16.5h6" /></>,
  leave: <><rect x="4" y="5.5" width="16" height="14" rx="2" /><path d="M8 3.5v4M16 3.5v4M4 10h16" /></>,
  open: <path d="M13.5 5.5H19v5.5M19 5.5l-8 8M17 14v5H5V7h5" />,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></>
};
export function ChatGlyph({ name, size = 16 }) {
  return (
    <svg className="chat-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {P[name]}
    </svg>
  );
}

// ── OS records as cards ──────────────────────────────────────────────
const RECORD_LABEL = { task: msg('Work order'), invoice: msg('Invoice'), quotation: msg('Quotation'), customer: msg('Client'), lead: msg('Lead'), leave: msg('Leave request') };
const RECORD_PLURAL = { task: msg('Work orders'), invoice: msg('Invoices'), quotation: msg('Quotations'), customer: msg('Clients'), lead: msg('Leads'), leave: msg('Leave requests') };
export function recordLabel(type) { return RECORD_LABEL[type] ? tr(RECORD_LABEL[type]) : type; }
export function recordHref(r) {
  if (!r) return null;
  const id = encodeURIComponent(r.id);
  switch (r.type) {
    case 'task': return '/tasks?open=' + id;
    case 'invoice': return '/invoices?open=' + id;
    case 'quotation': return '/quotations?open=' + id;
    case 'customer': return '/customers?open=' + id;
    case 'lead': return '/crmleads?lead=' + id;
    case 'leave': return '/leave';
    default: return null;
  }
}
function recordFacts(r) {
  const out = [];
  if (r.amount != null && r.type !== 'leave' && r.currency) out.push(money(r.amount, r.currency));
  if (r.type === 'leave' && r.amount != null) out.push(r.amount === 1 ? tr('1 day') : tr('{n} days', { n: r.amount }));
  if (r.status) out.push(codeLabel(r.status));
  return out;
}
export function RecordCard({ record, onOpen, compact }) {
  return (
    <button type="button" className={'chat-record is-' + record.type + (compact ? ' is-compact' : '')} onClick={onOpen} title={tr('Open in the OS')}>
      <span className="chat-record-icon"><ChatGlyph name={record.type} size={compact ? 16 : 20} /></span>
      <span className="chat-record-text">
        <span className="chat-record-kind">{recordLabel(record.type)}</span>
        <span className="chat-record-title">{record.title}</span>
        {!compact && record.sub && <span className="chat-record-sub">{record.sub}</span>}
        {!compact && recordFacts(record).length > 0 && <span className="chat-record-facts">{recordFacts(record).join(' · ')}</span>}
      </span>
      {!compact && <span className="chat-record-open"><ChatGlyph name="open" size={15} /></span>}
    </button>
  );
}

export function RecordPicker({ onClose, onPick }) {
  const [types, setTypes] = useState(null);
  const [type, setType] = useState(null);
  const [q, setQ] = useState('');
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.get('/messages/records').then((r) => { setTypes(r.types); setType(r.types[0] || null); }).catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!type) return undefined;
    let alive = true;
    setItems(null);
    const t = setTimeout(() => {
      api.get('/messages/records?type=' + type + '&q=' + encodeURIComponent(q))
        .then((r) => { if (alive) setItems(r.items); })
        .catch((e) => { if (alive) setError(e.message); });
    }, q ? 250 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [type, q]);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog chat-dialog chat-rec-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{tr('Share from the OS')}</h2>
        <p className="chat-muted">{tr('Send a card people can press to open it. They still need the right to see it.')}</p>
        {error && <div className="error-banner">{error}</div>}
        {types && (
          <div className="chat-rec-types" role="tablist" aria-label={tr('What to share')}>
            {types.map((t) => (
              <button key={t} type="button" role="tab" aria-selected={type === t} className={type === t ? 'is-on' : ''} onClick={() => { setType(t); setQ(''); }}>
                <ChatGlyph name={t} size={15} /> {tr(RECORD_PLURAL[t])}
              </button>
            ))}
          </div>
        )}
        <SearchInput value={q} onChange={setQ} placeholder={tr('Search…')} />
        <div className="chat-rec-list">
          {items === null ? <p className="chat-muted chat-pad">{tr('Loading…')}</p>
            : !items.length ? <p className="chat-muted chat-pad">{q ? tr('Nothing matches.') : tr('Nothing to share here yet.')}</p>
              : items.map((r) => <RecordCard key={r.type + r.id} record={r} onOpen={() => onPick(r)} />)}
        </div>
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button></div>
      </div>
    </div>
  );
}

// ── reactions ───────────────────────────────────────────────────────
export function ReactionChips({ reactions, onToggle }) {
  if (!reactions || !reactions.length) return null;
  return (
    <div className="chat-reactions">
      {reactions.map((r) => (
        <button key={r.emoji} type="button" className={'chat-reaction' + (r.mine ? ' is-mine' : '')} onClick={() => onToggle(r.emoji)}
          title={r.names.join(', ')} aria-label={tr('{emoji} from {names}', { emoji: r.emoji, names: r.names.join(', ') })}>
          <span className="chat-reaction-emoji">{r.emoji}</span>{r.count > 1 && <span className="chat-reaction-n">{r.count}</span>}
        </button>
      ))}
    </div>
  );
}
export function ReactionPicker({ choices, mine, onPick, onClose, align, down }) {
  const ref = useRef(null);
  useEffect(() => {
    function away(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    function key(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [onClose]);
  return (
    <div ref={ref} className={'chat-react-picker is-' + (align || 'left') + (down ? ' is-down' : '')} role="menu" aria-label={tr('React')}>
      {choices.map((e, i) => (
        <button key={e} type="button" role="menuitem" className={e === mine ? 'is-mine' : ''} style={{ animationDelay: i * 22 + 'ms' }} onClick={() => onPick(e)} aria-label={e}>{e}</button>
      ))}
    </div>
  );
}
// A reaction floating up from where it was picked.
export function Burst({ emoji }) {
  return <span className="chat-burst" aria-hidden="true">{[0, 1, 2].map((i) => <span key={i} style={{ '--i': i }}>{emoji}</span>)}</span>;
}

// ── a message's actions ─────────────────────────────────────────────
export function MessageMenu({ items, onClose, align, up }) {
  const ref = useRef(null);
  useEffect(() => {
    function away(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    function key(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [onClose]);
  return (
    <div ref={ref} className={'chat-msg-menu is-' + (align || 'left') + (up ? ' is-up' : '')} role="menu">
      {items.map((it) => (
        <button key={it.label} type="button" role="menuitem" className={it.danger ? 'is-danger' : ''} onClick={() => { onClose(); it.run(); }}>
          <ChatGlyph name={it.icon} size={16} /> {it.label}
        </button>
      ))}
    </div>
  );
}

export function ReplyQuote({ reply, onJump, inComposer }) {
  if (!reply) return null;
  const what = reply.deleted ? tr('This message was deleted')
    : reply.body || (reply.record ? recordLabel(reply.record.type) + ': ' + reply.record.title : reply.files ? (reply.fileKind === 'image' ? tr('Photo') : reply.fileKind === 'audio' ? tr('Voice note or audio') : reply.fileKind === 'video' ? tr('Video') : tr('Document')) : '');
  return (
    <button type="button" className={'chat-quote' + (inComposer ? ' is-composer' : '')} onClick={onJump} disabled={!onJump}>
      <span className="chat-quote-who">{reply.fromName}</span>
      <span className="chat-quote-text">{what}</span>
    </button>
  );
}

export function SeenTicks({ state, title, onClick }) {
  // state: 'sent' | 'some' | 'seen'
  const inner = <ChatGlyph name={state === 'sent' ? 'check' : 'check2'} size={15} />;
  if (onClick) return <button type="button" className={'chat-ticks is-' + state + ' is-button'} title={title} aria-label={title} onClick={onClick}>{inner}</button>;
  return <span className={'chat-ticks is-' + state} title={title} aria-label={title}>{inner}</span>;
}

// Who has seen a message, and when (GET /messages/m/:id/seen). Refreshes
// while open, so people move to "Seen" as they read it.
function seenWhen(iso, locale) {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return tr('today at {time}', { time });
  const y = new Date(); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return tr('yesterday at {time}', { time });
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short' }) + ', ' + time;
}
export function SeenDialog({ messageId, locale, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.get('/messages/m/' + messageId + '/seen').then((r) => { if (alive) setData(r); }).catch((e) => { if (alive) setError(e.message); });
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [messageId]);
  const total = data ? data.seen.length + data.notSeen.length : 0;
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog chat-dialog chat-seen-dialog" role="dialog" aria-modal="true" aria-labelledby="chat-seen-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="chat-seen-title">{tr('Seen by')}</h2>
        {error && <div className="error-banner">{error}</div>}
        {!data ? <p className="chat-muted">{tr('Loading…')}</p> : (
          <>
            {data.body && <p className="chat-seen-msg">{data.body}</p>}
            <div className="chat-seen-bar" aria-hidden="true"><span style={{ width: total ? Math.round((data.seen.length / total) * 100) + '%' : 0 }} /></div>
            <p className="chat-muted">{total ? tr('{n} of {total} have seen it', { n: data.seen.length, total }) : tr('No one else is in this chat.')}</p>
            {data.seen.length > 0 && (
              <section className="chat-seen-section">
                <h3><ChatGlyph name="check2" size={16} /> {tr('Seen')} <span className="chat-muted">{data.seen.length}</span></h3>
                <ul>
                  {data.seen.map((p, i) => (
                    <li key={p.id} style={{ animationDelay: i * 30 + 'ms' }}>
                      <Photo id={p.id} name={p.name} photo={p.photo} size={36} />
                      <span className="chat-person-text"><span className="chat-person-name">{p.me ? tr('You') : p.name}</span><span className="chat-muted">{p.title}</span></span>
                      <span className="chat-seen-at">{p.readAt ? seenWhen(p.readAt, locale) : tr('seen')}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {data.notSeen.length > 0 && (
              <section className="chat-seen-section is-waiting">
                <h3><ChatGlyph name="check" size={16} /> {tr('Not seen yet')} <span className="chat-muted">{data.notSeen.length}</span></h3>
                <ul>
                  {data.notSeen.map((p) => (
                    <li key={p.id}>
                      <Photo id={p.id} name={p.name} photo={p.photo} size={36} />
                      <span className="chat-person-text"><span className="chat-person-name">{p.me ? tr('You') : p.name}</span><span className="chat-muted">{p.title}</span></span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button></div>
      </div>
    </div>
  );
}

export function TypingBubble({ names, isGroup }) {
  if (!names.length) return null;
  return (
    <div className="chat-row chat-typing-row" aria-live="polite">
      <div className="chat-bubble chat-typing">
        {isGroup && <span className="chat-typing-who">{names.length === 1 ? tr('{name} is typing', { name: names[0] }) : tr('{n} people are typing', { n: names.length })}</span>}
        <span className="chat-dots" aria-label={tr('typing…')}><i /><i /><i /></span>
      </div>
    </div>
  );
}

// ── text: links and @mentions ────────────────────────────────────────
const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)"'\]])/g;
export function RichText({ text, names }) {
  const parts = useMemo(() => {
    const sorted = (names || []).filter(Boolean).sort((a, b) => b.length - a.length);
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mentionRe = sorted.length ? new RegExp('@(' + sorted.map(esc).join('|') + ')', 'g') : null;
    const out = [];
    String(text).split(URL_RE).forEach((chunk, i) => {
      if (i % 2 === 1) { out.push({ t: 'url', v: chunk }); return; }
      if (!mentionRe) { out.push({ t: 'txt', v: chunk }); return; }
      let last = 0;
      chunk.replace(mentionRe, (m, name, at) => {
        if (at > last) out.push({ t: 'txt', v: chunk.slice(last, at) });
        out.push({ t: 'at', v: m });
        last = at + m.length;
        return m;
      });
      if (last < chunk.length) out.push({ t: 'txt', v: chunk.slice(last) });
    });
    return out;
  }, [text, names]);
  return (
    <span className="chat-text">
      {parts.map((p, i) => (p.t === 'url'
        ? <a key={i} href={p.v} target="_blank" rel="noopener noreferrer" className="chat-link-url">{p.v}</a>
        : p.t === 'at' ? <span key={i} className="chat-mention">{p.v}</span> : <span key={i}>{p.v}</span>))}
    </span>
  );
}

export function MentionPopup({ people, onPick, index }) {
  if (!people.length) return null;
  return (
    <div className="chat-mention-pop" role="listbox" aria-label={tr('Mention someone')}>
      {people.map((p, i) => (
        <button key={p.id} type="button" role="option" aria-selected={i === index} className={i === index ? 'is-on' : ''}
          onMouseDown={(e) => { e.preventDefault(); onPick(p); }}>
          <Photo id={p.id} name={p.name} photo={p.photo} size={28} />
          <span className="chat-person-text"><span className="chat-person-name">{p.name}</span><span className="chat-muted">{p.title}</span></span>
        </button>
      ))}
    </div>
  );
}

// ── forwarding ──────────────────────────────────────────────────────
export function ForwardDialog({ inbox, people, onClose, onSend }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState([]); // [{ kind: 'conv'|'peer', id }]
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const chatted = new Set(inbox.filter((c) => c.kind === 'direct').map((c) => c.peerId));
  const rows = [
    ...inbox.map((c) => ({ key: 'c' + c.id, kind: 'conv', id: c.id, name: c.name, sub: c.kind === 'group' ? tr('Group · {n} members', { n: c.memberCount }) : c.title, photo: c.photo, photoKind: c.kind === 'group' ? 'group' : 'person', photoId: c.kind === 'group' ? c.id : c.peerId })),
    ...people.filter((p) => !chatted.has(p.id)).map((p) => ({ key: 'p' + p.id, kind: 'peer', id: p.id, name: p.name, sub: p.title, photo: p.photo, photoKind: 'person', photoId: p.id }))
  ].filter((r) => matchesQuery(q, r.name, r.sub));
  const on = (r) => sel.some((s) => s.kind === r.kind && s.id === r.id);
  function toggle(r) {
    setSel((s) => (on(r) ? s.filter((x) => !(x.kind === r.kind && x.id === r.id)) : s.length >= 10 ? s : [...s, { kind: r.kind, id: r.id }]));
  }
  async function send() {
    setBusy(true); setError(null);
    try { await onSend(sel); } catch (e) { setError(e.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog chat-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{tr('Forward to…')}</h2>
        {error && <div className="error-banner">{error}</div>}
        <SearchInput value={q} onChange={setQ} placeholder={tr('Search chats and people…')} />
        <div className="chat-picker-list" role="listbox" aria-multiselectable="true">
          {rows.slice(0, 60).map((r) => (
            <button key={r.key} type="button" role="option" aria-selected={on(r)} className={'chat-person' + (on(r) ? ' is-on' : '')} onClick={() => toggle(r)}>
              <Photo kind={r.photoKind} id={r.photoId} name={r.name} photo={r.photo} size={36} />
              <span className="chat-person-text"><span className="chat-person-name">{r.name}</span><span className="chat-muted">{r.sub}</span></span>
              <span className={'chat-check' + (on(r) ? ' is-on' : '')}>{on(r) && <ChatGlyph name="check" size={14} />}</span>
            </button>
          ))}
          {!rows.length && <p className="chat-muted chat-pad">{tr('No one matches.')}</p>}
        </div>
        <div className="dialog-actions">
          <span className="chat-muted chat-fw-note">{sel.length >= 10 ? tr('10 at most at a time') : ''}</span>
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={!sel.length || busy} onClick={send}>{busy ? tr('Sending…') : tr('Forward to {n}', { n: sel.length })}</button>
        </div>
      </div>
    </div>
  );
}
