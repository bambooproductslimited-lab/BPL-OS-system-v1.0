import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Empty, Glossary, Icon, Section, fmtDate } from '../../components/DashKit';
import Photo from '../../components/Photo';
import SearchInput from '../../components/SearchInput';
import { msg, tr } from '../../lib/i18n.jsx';
import CustomerProfile from './CustomerProfile';
import { CHANNELS, CategoryTag, ChannelDot, CustMark, ago, channelLabel, ghsOr, ourAuthor, timeOf, useReps } from './crmHubShared';
import { Confetti, Ring, WaitPill, spanText, weekdayShort } from './crmFun';
import { Toast } from './crmShared';
import '../EmployeesPage.css';
import '../ToolRoomPage.css';
import './CrmPage.css';
import './CrmHub.css';
import './CrmInbox.css';

// Every conversation with customers, from every channel, in one inbox
// (GET /api/crm/conversations): WhatsApp, the sales mailbox, Instagram and
// Facebook messages, and calls and visits written down by hand. Each lands
// on the sender's profile by itself; one from someone new gets a new
// profile. Replies go out on the same channel when it is connected.
// ?c= opens a conversation. Old WhatsApp chats come in from WhatsApp's own
// "Export chat" file (ImportChatDialog).
//
// Laid out like a chat app: a banner with how close the inbox is to
// "inbox zero" (every customer answered) and how fast they get an answer
// (GET /api/crm/inbox/pulse); the customers waiting longest, with a timer
// in the colour of how long; the list, the conversation and — on a wide
// screen — the customer beside it; then how the team is replying. Keys:
// J/K or ↓/↑ move through the list, R writes a reply, E closes, / searches.

const LIVE = ['whatsapp', 'email', 'instagram', 'facebook'];
// Quick replies: a short name on the chip, the words it puts in the box
// (in the reader's language; change anything before sending).
const QUICK = [
  [msg('Greeting'), msg('Hello! Thank you for writing to Bamboo Products. How can we help you?')],
  [msg('Price coming'), msg('Thank you! We will get back to you shortly with the price.')],
  [msg('Ask for the location'), msg('Could you share your location, so we can work out the delivery?')],
  [msg('We\'ll call'), msg('Thank you. Someone from our team will call you shortly.')],
  [msg('Thanks for the order'), msg('Thank you for your order! We will let you know as soon as it is ready.')]
];

function typing(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export default function CrmInboxPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const canManage = can('crm.manage');
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [pulse, setPulse] = useState(null);
  const [channels, setChannels] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [dialog, setDialog] = useState(null);
  const [toast, setToast] = useState(null);
  const [burst, setBurst] = useState(0);
  const prevWaiting = useRef(null);
  const listRef = useRef(null);
  const { reps } = useReps();

  const ch = params.get('channel') || '';
  const waiting = params.get('waiting') === '1';
  const unlinked = params.get('unlinked') === '1';
  const mine = params.get('mine') === '1';
  const status = params.get('status') || 'open';
  const openId = params.get('c');
  function setParam(k, v) { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: k !== 'c' }); }
  function setView(v) { const p = new URLSearchParams(params); ['waiting', 'unlinked', 'mine'].forEach((k) => p.delete(k)); if (v) p.set(v, '1'); setParams(p, { replace: true }); }

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ status, limit: '200' });
    if (ch) qs.set('channel', ch);
    if (waiting) qs.set('waiting', '1');
    if (unlinked) qs.set('unlinked', '1');
    if (mine) qs.set('mine', '1');
    if (q.trim()) qs.set('search', q.trim());
    try { setData(await api.get('/crm/conversations?' + qs.toString())); setError(null); } catch (err) { setError(err.message); }
  }, [ch, waiting, unlinked, mine, status, q]);
  const loadPulse = useCallback(() => api.get('/crm/inbox/pulse').then(setPulse).catch(() => {}), []);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => { api.get('/crm/channels').then(setChannels).catch(() => {}); loadPulse(); }, [loadPulse]);
  // New messages come in by themselves; look again every 30 seconds.
  useEffect(() => { const t = setInterval(() => { load(); loadPulse(); }, 30000); return () => clearInterval(t); }, [load, loadPulse]);

  // Every customer answered: a little celebration (only when it just happened).
  const waitingNow = data ? data.counts.reduce((a, c) => a + c.waiting, 0) : null;
  useEffect(() => {
    if (waitingNow === null) return;
    if (prevWaiting.current > 0 && waitingNow === 0) { setBurst(Date.now()); setToast(tr('Inbox zero! Every customer has an answer.')); }
    prevWaiting.current = waitingNow;
  }, [waitingNow]);

  const afterChange = useCallback(() => { load(); loadPulse(); }, [load, loadPulse]);

  // Keys: J/K (or ↓/↑) move, R reply, E close, / search, Esc back to the list.
  useEffect(() => {
    function onKey(e) {
      if (dialog || e.ctrlKey || e.metaKey || e.altKey) return;
      if (typing(e)) { if (e.key === 'Escape') e.target.blur(); return; }
      const list = data ? data.conversations : [];
      const i = list.findIndex((c) => c.id === openId);
      const k = e.key.toLowerCase();
      if ((k === 'j' || e.key === 'ArrowDown') && list.length) { e.preventDefault(); setParam('c', list[Math.min(list.length - 1, i + 1)].id); }
      else if ((k === 'k' || e.key === 'ArrowUp') && list.length) { e.preventDefault(); setParam('c', list[Math.max(0, i < 0 ? 0 : i - 1)].id); }
      else if (k === '/') { const box = document.querySelector('.ib-list .search-input'); if (box) { e.preventDefault(); box.focus(); } }
      else if (k === 'r' && openId) { const box = document.querySelector('.ib-composer textarea'); if (box) { e.preventDefault(); box.focus(); } }
      else if (k === 'e' && openId && canManage) {
        e.preventDefault();
        api.put('/crm/conversations/' + openId + '/status', { status: 'closed' }).then(() => { setToast(tr('Closed.')); afterChange(); }).catch((err) => setToast(err.message));
      } else if (e.key === 'Escape' && openId) setParam('c', '');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  useEffect(() => {
    const el = listRef.current && listRef.current.querySelector('.ib-row.is-on');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [openId]);

  if (!data) return <div className="dk">{error ? <div className="error-banner">{error}</div> : <div className="eyebrow">{tr('Loading…')}</div>}</div>;
  const counts = {};
  data.counts.forEach((c) => { counts[c.channel] = c; });
  const total = (k) => data.counts.reduce((a, c) => a + c[k], 0);
  const connected = channels ? [channels.whatsapp.configured, channels.email.configured, channels.meta && channels.meta.facebook && channels.meta.facebook.connected, channels.meta && channels.meta.instagram && channels.meta.instagram.connected].filter(Boolean).length : null;
  const open = total('open'), wait = total('waiting');
  const longest = pulse && pulse.waiting.longest.length ? pulse.waiting.longest : [];
  const view = waiting ? 'waiting' : mine ? 'mine' : unlinked ? 'unlinked' : '';

  return (
    <div className="dk crm hub ib">
      <Confetti burst={burst} />
      {error && <div className="error-banner" role="alert">{error}</div>}

      <section className="ib-hero">
        <span className="ib-hero-glow" aria-hidden="true" />
        <div className="ib-hero-main">
          <p className="ib-eyebrow">{tr('Sales & CRM')} · {tr('Inbox')} <span className="ib-live"><span aria-hidden="true" />{tr('Live')}</span></p>
          <h1 className="ib-hero-title">{wait === 0 ? tr('Inbox zero. Every customer has an answer.') : wait === 1 ? tr('1 customer is waiting for an answer') : tr('{n} customers are waiting for an answer', { n: wait })}</h1>
          <p className="ib-hero-sub">{tr('Every message from customers, on every channel, in one place. Each conversation lands on the customer\'s profile by itself, and a reply goes back on the same channel.')}</p>
          <div className="ib-hero-actions">
            {longest[0] && <button type="button" className="ib-btn is-primary" onClick={() => setParam('c', longest[0].id)}><Icon name="send" /> {tr('Answer the longest wait')}</button>}
            {canManage && <button type="button" className="ib-btn is-ghost" onClick={() => setDialog({ kind: 'import' })}><Icon name="doc" /> {tr('Import a WhatsApp chat')}</button>}
          </div>
        </div>
        <div className="ib-hero-side">
          <div className="ib-zero">
            <Ring value={open - wait} max={open || 1} size={132} stroke={13} tone={wait ? (wait > 5 ? 'hot' : 'warm') : 'good'}>
              <strong>{wait}</strong>
              <small>{tr('waiting')}</small>
            </Ring>
            <span className="ib-zero-cap">{open ? tr('{pct}% of open conversations answered', { pct: Math.round((open - wait) / open * 100) }) : tr('No open conversations')}</span>
          </div>
          <div className="ib-tiles">
            <button type="button" className="ib-tile" onClick={() => document.getElementById('ib-pulse') && document.getElementById('ib-pulse').scrollIntoView({ behavior: 'smooth' })}>
              <span className="ib-tile-label">{tr('Typical reply time')}</span>
              <span className="ib-tile-value">{pulse ? spanText(pulse.reply.median) : '…'}</span>
              <span className="ib-tile-note">{pulse && pulse.reply.within1h !== null ? tr('{pct}% answered within the hour', { pct: pulse.reply.within1h }) : tr('last 7 days')}</span>
            </button>
            <div className="ib-tile">
              <span className="ib-tile-label">{tr('Today')}</span>
              <span className="ib-tile-value">{pulse ? pulse.today.in : '…'} <small>{tr('in')}</small> · {pulse ? pulse.today.out : '…'} <small>{tr('replies')}</small></span>
              <span className="ib-tile-note">{pulse && pulse.reply.today.median !== null ? tr('answered in {time}, typically', { time: spanText(pulse.reply.today.median) }) : tr('messages from customers, and ours')}</span>
            </div>
            <button type="button" className={'ib-tile' + (total('unlinked') ? ' is-warn' : '')} onClick={() => setView(unlinked ? '' : 'unlinked')}>
              <span className="ib-tile-label">{tr('Not on a profile')}</span>
              <span className="ib-tile-value">{total('unlinked')}</span>
              <span className="ib-tile-note">{tr('put them on the right customer')}</span>
            </button>
            <button type="button" className="ib-tile" onClick={() => navigate('/crmhealth#channels')}>
              <span className="ib-tile-label">{tr('Channels connected')}</span>
              <span className="ib-tile-value">{connected === null ? '…' : connected + ' / 4'}</span>
              <span className="ib-tile-note">{tr('WhatsApp, email, Facebook, Instagram')}</span>
            </button>
          </div>
        </div>
      </section>

      <section className="ib-waitbar" aria-label={tr('Waiting longest')}>
        <span className="ib-waitbar-t"><Icon name="clock" /> {tr('Waiting longest')}</span>
        {longest.length ? (
          <div className="ib-waitbar-list">
            {longest.map((w) => (
              <button key={w.id} type="button" className={'ib-waitchip' + (w.id === openId ? ' is-on' : '')} onClick={() => setParam('c', w.id)}>
                <span className="ib-row-mark"><CustMark name={w.name || '?'} size={30} /><ChannelDot channel={w.channel} /></span>
                <span className="ib-waitchip-name">{w.name || tr('Someone new')}</span>
                <WaitPill since={w.since} />
              </button>
            ))}
            {pulse.waiting.total > longest.length && <button type="button" className="ib-waitchip is-more" onClick={() => setView('waiting')}>{tr('+{n} more', { n: pulse.waiting.total - longest.length })}</button>}
          </div>
        ) : <span className="ib-waitbar-none">{pulse ? tr('Nobody is waiting. Nice work!') : tr('Loading…')}</span>}
      </section>

      <div className={'ib-shell' + (openId ? ' has-open' : '')}>
        <div className="ib-list" ref={listRef}>
          <div className="ib-list-head">
            <SearchInput value={q} onChange={setQ} placeholder={tr('Search name, number, words…')} />
            <div className="ib-seg" role="radiogroup" aria-label={tr('Show')}>
              {[['', tr('All'), open], ['waiting', tr('Waiting'), wait], ['mine', tr('My customers'), null], ['unlinked', tr('Not on a profile'), total('unlinked')]].map(([k, l, n]) => (
                <button key={k || 'all'} type="button" role="radio" aria-checked={view === k} className={'ib-seg-b' + (view === k ? ' is-on' : '') + (k === 'waiting' && n ? ' is-alert' : '')} onClick={() => setView(k)}>
                  {l}{n !== null && n !== undefined && <span className="ib-seg-n">{n}</span>}
                </button>
              ))}
            </div>
            <div className="ib-chs" role="radiogroup" aria-label={tr('Channel')}>
              <button type="button" role="radio" aria-checked={!ch} className={'ib-ch' + (!ch ? ' is-on' : '')} onClick={() => setParam('channel', '')}>{tr('Every channel')}</button>
              {CHANNELS.filter((c) => counts[c.key] || LIVE.includes(c.key)).map((c) => (
                <button key={c.key} type="button" role="radio" aria-checked={ch === c.key} className={'ib-ch is-' + c.key + (ch === c.key ? ' is-on' : '')} onClick={() => setParam('channel', ch === c.key ? '' : c.key)}>
                  <ChannelDot channel={c.key} /> {tr(c.label)} <span className={'ib-ch-n' + (counts[c.key] && counts[c.key].waiting ? ' is-alert' : '')}>{counts[c.key] ? counts[c.key].open : 0}</span>
                </button>
              ))}
              <select className="input ib-status" value={status} onChange={(e) => setParam('status', e.target.value === 'open' ? '' : e.target.value)} aria-label={tr('Status')}>
                <option value="open">{tr('Open')}</option>
                <option value="closed">{tr('Closed')}</option>
                <option value="spam">{tr('Spam')}</option>
                <option value="all">{tr('All')}</option>
              </select>
            </div>
            <p className="ib-keys dk-muted"><kbd>J</kbd><kbd>K</kbd> {tr('move')} · <kbd>R</kbd> {tr('reply')}{canManage ? <> · <kbd>E</kbd> {tr('close')}</> : null} · <kbd>/</kbd> {tr('search')}</p>
          </div>
          {data.conversations.length ? (
            <ul className="ib-rows">
              {data.conversations.map((c) => {
                const name = c.customer ? c.customer.name : c.contact.name || c.contact.label;
                return (
                  <li key={c.id}>
                    <button type="button" className={'ib-row is-' + c.channel + (openId === c.id ? ' is-on' : '') + (c.waiting ? ' is-waiting' : '')} onClick={() => setParam('c', c.id)} aria-current={openId === c.id ? 'true' : undefined}>
                      <span className="ib-row-mark"><CustMark name={name} size={42} /><ChannelDot channel={c.channel} /></span>
                      <span className="ib-row-main">
                        <span className="ib-row-top"><strong>{name}</strong><span className="ib-row-time">{ago(c.lastMessageAt)}</span></span>
                        {c.subject && <span className="ib-row-subject">{c.subject}</span>}
                        <span className="ib-row-preview">{c.lastDirection === 'out' ? <span className="ib-you">{tr('You:')}</span> : null} {c.lastPreview}</span>
                        <span className="ib-row-tags">
                          {c.waiting && <WaitPill since={c.lastMessageAt} />}
                          {!c.customer && <span className="ib-flag is-warn">{tr('not on a profile')}</span>}
                          {c.customer && !c.customer.repName && <span className="ib-flag is-warn">{tr('no rep')}</span>}
                          {c.customer && c.customer.repName && <span className="ib-rep">{c.customer.repName}</span>}
                          {c.imported && <span className="ib-flag">{tr('imported')}</span>}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : <Empty icon="send">{tr('No conversation matches.')}</Empty>}
        </div>

        <div className="ib-chat">
          {openId ? <ConversationView key={openId} id={openId} canManage={canManage} reps={reps} onChanged={afterChange} onProfile={(id) => setDialog({ kind: 'profile', id })} onToast={setToast} onClose={() => setParam('c', '')} />
            : (
              <div className="ib-chat-empty">
                <span className="ib-chat-empty-art" aria-hidden="true"><Icon name="send" /></span>
                <h3>{wait ? tr('Who\'s first?') : tr('All caught up')}</h3>
                <p className="dk-muted">{wait ? tr('Choose a conversation to read it and reply — or press J to start at the top.') : tr('Choose a conversation to read it. New messages appear here by themselves.')}</p>
              </div>
            )}
        </div>
      </div>

      {pulse && <Pulse pulse={pulse} reps={reps} />}

      <Glossary items={[
        [tr('Waiting for a reply'), tr('The customer wrote last. It stops waiting when someone replies, here or on the channel itself.')],
        [tr('Inbox zero'), tr('Every open conversation has an answer: the customer did not write last anywhere.')],
        [tr('Typical reply time'), tr('Half of the customers\' messages in the last 7 days were answered faster than this, half slower — counted from their first message until our next one, nights included.')],
        [tr('Not on a profile'), tr('The OS couldn\'t tell who this is (or it is staff or a business notice). Put it on the right customer and their next message lands there by itself.')],
        [tr('Imported'), tr('Older messages brought in from WhatsApp\'s "Export chat" file, before WhatsApp was connected.')],
        [tr('Closed'), tr('Dealt with. A new message from the customer opens it again.')]
      ]} />

      {dialog && dialog.kind === 'import' && <ImportChatDialog onClose={() => setDialog(null)} onDone={(out) => { setDialog(null); load(); setToast(tr('{n} new messages imported.', { n: out.added })); setParam('c', out.conversationId); }} />}
      {dialog && dialog.kind === 'profile' && <CustomerProfile id={dialog.id} reps={reps} onClose={() => setDialog(null)} onChanged={load} />}
      <Toast text={toast} onDone={() => setToast(null)} />
    </div>
  );
}

// ── how the team is replying ─────────────────────────────────────────
function Pulse({ pulse, reps }) {
  const r = pulse.reply;
  const dayMax = Math.max(1, ...pulse.days.map((d) => Math.max(d.in, d.out)));
  const chMax = Math.max(1, ...pulse.channels.map((c) => c.in));
  const chTotal = pulse.channels.reduce((a, c) => a + c.in, 0);
  const heat = pulse.heat;
  const level = (n) => (!n ? 0 : Math.min(4, Math.ceil(n / heat.max * 4)));
  const fastest = pulse.repliers.filter((p) => p.replies >= 2).sort((a, b) => a.median - b.median)[0] || null;
  const podium = pulse.repliers.slice(0, 3);
  const photo = (p) => { const x = reps.find((y) => y.id === p.id); return x ? x.photo : p.photo; };
  return (
    <Section id="ib-pulse" title={tr('How we\'re replying')} sub={tr('The last 7 days on WhatsApp, email, Facebook and Instagram. Updated every 30 seconds.')}>
      <div className="ib-pulse">
        <article className="ib-panel">
          <h3 className="ib-panel-t">{tr('Reply speed')}</h3>
          <div className="ib-speed">
            <Ring value={r.within1h || 0} max={100} size={96} stroke={10} tone={r.within1h === null ? '' : r.within1h >= 80 ? 'good' : r.within1h >= 50 ? 'warm' : 'hot'}>
              <strong>{r.within1h === null ? '—' : r.within1h + '%'}</strong>
            </Ring>
            <div className="ib-speed-txt">
              <span className="ib-big">{spanText(r.median)}</span>
              <span className="dk-muted tl-small">{tr('typical time to an answer')}</span>
              <span className="tl-small">{r.within1h === null ? tr('Nothing to measure yet.') : tr('{pct}% of messages answered within the hour', { pct: r.within1h })}</span>
              <span className="dk-muted tl-small">{tr('{a} of {n} answered', { a: r.answered, n: r.turns })}</span>
            </div>
          </div>
          <div className="ib-days" role="img" aria-label={tr('Messages each day, from customers and from us')}>
            {pulse.days.map((d) => (
              <div key={d.day} className="ib-day" title={tr('{day}: {a} from customers, {b} from us', { day: fmtDate(d.day), a: d.in, b: d.out })}>
                <div className="ib-day-bars">
                  <span className="ib-day-in" style={{ height: (d.in / dayMax * 100) + '%' }} />
                  <span className="ib-day-out" style={{ height: (d.out / dayMax * 100) + '%' }} />
                </div>
                <span className="ib-day-l">{weekdayShort((new Date(d.day + 'T00:00:00Z').getUTCDay() + 6) % 7)}</span>
              </div>
            ))}
          </div>
          <p className="ib-legend"><span className="ib-key is-in" /> {tr('From customers')} <span className="ib-key is-out" /> {tr('Our replies')}</p>
        </article>

        <article className="ib-panel">
          <h3 className="ib-panel-t">{tr('Where customers write')}</h3>
          {chTotal ? (
            <ul className="ib-chbars">
              {pulse.channels.map((c) => (
                <li key={c.channel} className={'is-' + c.channel}>
                  <span className="ib-chbars-l"><ChannelDot channel={c.channel} withLabel /></span>
                  <span className="ib-chbars-track"><span style={{ width: (c.in / chMax * 100) + '%' }} /></span>
                  <strong className="ib-chbars-n">{c.in}</strong>
                </li>
              ))}
            </ul>
          ) : <Empty icon="send">{tr('No messages from customers this week yet.')}</Empty>}
          {chTotal > 0 && <p className="dk-muted tl-small">{tr('{n} messages from customers this week.', { n: chTotal })}</p>}
        </article>

        <article className="ib-panel">
          <h3 className="ib-panel-t">{tr('Who answers most')}</h3>
          {podium.length ? (
            <>
              <ol className="ib-podium">
                {podium.map((p, i) => (
                  <li key={p.id} className={'is-' + (i + 1)}>
                    <span className="ib-podium-medal">{i + 1}</span>
                    <Photo id={p.id} name={p.name} photo={photo(p)} size={i === 0 ? 54 : 44} />
                    <strong title={p.name}>{p.name}</strong>
                    <span className="tl-small">{p.replies === 1 ? tr('1 reply') : tr('{n} replies', { n: p.replies })}</span>
                    <span className="dk-muted tl-small">{tr('typically {time}', { time: spanText(p.median) })}</span>
                    {fastest && fastest.id === p.id && <span className="ib-badge">⚡ {tr('Fastest')}</span>}
                  </li>
                ))}
              </ol>
              <p className="dk-muted tl-small">{tr('Replies written in the OS this week. Replies typed on the phone count for the customer, not for a person.')}</p>
            </>
          ) : <Empty icon="people">{tr('Nobody has replied from the OS this week yet. The first reply puts you on top.')}</Empty>}
        </article>
        <article className="ib-panel is-wide">
          <h3 className="ib-panel-t">{tr('When customers write')}</h3>
          <p className="dk-muted tl-small">{heat.busiest ? tr('Busiest: {day} from {from}:00 to {to}:00 — have someone on the inbox then.', { day: weekdayShort(heat.busiest.dow), from: String(heat.busiest.hour).padStart(2, '0'), to: String((heat.busiest.hour + 1) % 24).padStart(2, '0') }) : tr('The last 30 days. Nothing yet.')}</p>
          <div className="ib-heat" role="img" aria-label={tr('Messages from customers by weekday and hour, the last 30 days')}>
            <span />
            {Array.from({ length: 24 }, (_, h) => <span key={h} className="ib-heat-h">{h % 3 === 0 ? String(h).padStart(2, '0') : ''}</span>)}
            {heat.grid.map((row, d) => [
              <span key={'l' + d} className="ib-heat-d">{weekdayShort(d)}</span>,
              ...row.map((n, h) => <span key={d + '-' + h} className={'ib-heat-c is-l' + level(n)} title={tr('{day} {hour}:00 — {n} messages', { day: weekdayShort(d), hour: String(h).padStart(2, '0'), n })} />)
            ])}
          </div>
          <p className="ib-legend">{tr('Fewer')} {[0, 1, 2, 3, 4].map((l) => <span key={l} className={'ib-heat-c is-l' + l} />)} {tr('More')}</p>
        </article>

      </div>
    </Section>
  );
}

// ── one conversation ─────────────────────────────────────────────────
function ConversationView({ id, canManage, reps, onChanged, onProfile, onToast, onClose }) {
  const [c, setC] = useState(null);
  const [error, setError] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState(false);
  const end = useRef(null);
  const load = useCallback(async () => { try { setC(await api.get('/crm/conversations/' + id)); setError(null); } catch (err) { setError(err.message); } }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (end.current && end.current.parentNode) end.current.parentNode.scrollTop = end.current.parentNode.scrollHeight; }, [c && c.messages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(fn, done) {
    setBusy(true); setError(null);
    try { setC(await fn()); onChanged(); if (done) onToast(done); return true; } catch (err) { setError(err.message); return false; } finally { setBusy(false); }
  }
  if (!c) return error ? <div className="error-banner">{error}</div> : <p className="eyebrow ib-pad">{tr('Loading…')}</p>;
  const who = c.customer ? c.customer.name : c.contact.name || c.contact.label;
  let lastDay = null;

  return (
    <div className={'ib-conv is-' + c.channel}>
      <div className="ib-conv-main">
        <header className="ib-conv-head">
          <button type="button" className="ib-back" onClick={onClose} aria-label={tr('Back to the list')}>←</button>
          <span className="ib-row-mark"><CustMark name={who} size={44} /><ChannelDot channel={c.channel} /></span>
          <div className="ib-conv-who">
            <strong>{who}</strong>
            <span className="dk-muted tl-small">{channelLabel(c.channel)}{c.contact.label && c.contact.label !== who ? ' · ' + c.contact.label : ''}{c.subject ? ' · ' + c.subject : ''}</span>
          </div>
          {c.waiting && <WaitPill since={c.lastMessageAt} label={tr('waiting')} />}
          <div className="ib-conv-acts">
            {c.customer && <button type="button" className="ib-btn is-soft" onClick={() => onProfile(c.customer.id)}>{tr('Profile')}</button>}
            {canManage && c.status === 'open' && <button type="button" className="ib-btn is-soft" disabled={busy} onClick={() => act(() => api.put('/crm/conversations/' + id + '/status', { status: 'closed' }), tr('Closed.'))}><Icon name="check" /> {tr('Close')}</button>}
            {canManage && c.status !== 'open' && <button type="button" className="ib-btn is-soft" disabled={busy} onClick={() => act(() => api.put('/crm/conversations/' + id + '/status', { status: 'open' }))}>{tr('Open again')}</button>}
            {canManage && c.status !== 'spam' && <button type="button" className="dk-link" disabled={busy} onClick={() => act(() => api.put('/crm/conversations/' + id + '/status', { status: 'spam' }), tr('Marked as spam.'))}>{tr('Spam')}</button>}
          </div>
        </header>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {!c.customer && (
          <div className="crm-note is-warn">
            <Icon name="people" />
            <span>{tr('This conversation isn\'t on a customer\'s profile yet.')}</span>
            {canManage && <button type="button" className="dk-link" onClick={() => setLinking(true)}>{tr('Put it on a profile')} <Icon name="arrow" /></button>}
          </div>
        )}
        {c.customer && !c.customer.repName && <div className="crm-note is-warn"><Icon name="warn" /><span>{tr('{name} has no sales rep. Open the profile to give them one.', { name: c.customer.name })}</span></div>}

        <ol className="ib-msgs" aria-label={tr('Messages')}>
          {c.messages.map((m, i) => {
            const d = new Date(m.sentAt).toDateString();
            const sep = d !== lastDay; lastDay = d;
            const next = c.messages[i + 1];
            const tail = !next || next.direction !== m.direction || new Date(next.sentAt).toDateString() !== d;
            return (
              <li key={m.id} className={'ib-msg is-' + (m.direction === 'in' ? 'them' : 'us') + (tail ? ' has-tail' : '')}>
                {sep && <span className="ib-msg-day">{fmtDate(m.sentAt)}</span>}
                <div className="ib-bubble">
                  {m.direction === 'out' && <span className="ib-msg-who">{ourAuthor(m.sentBy && m.sentBy.name, m.author)}</span>}
                  <p>{m.body || '—'}</p>
                  {m.attachments.length > 0 && <span className="ib-msg-att"><Icon name="doc" /> {m.attachments.map((a) => a.name).join(', ')}</span>}
                  <time className="ib-msg-time">{timeOf(m.sentAt)}</time>
                </div>
              </li>
            );
          })}
          <li ref={end} aria-hidden="true" />
        </ol>

        {canManage && (c.canReply ? (
          <form className="ib-composer" onSubmit={(e) => { e.preventDefault(); act(() => api.post('/crm/conversations/' + id + '/reply', { body: text }), tr('Sent on {channel}.', { channel: channelLabel(c.channel) })).then((ok) => ok && setText('')); }}>
            <div className="ib-quick" role="group" aria-label={tr('Quick replies')}>
              {QUICK.map(([label, words]) => <button key={label} type="button" className="ib-quick-b" title={tr(words)} onClick={() => setText((t) => (t ? t.replace(/\s*$/, ' ') : '') + tr(words))}>{tr(label)}</button>)}
            </div>
            <div className="ib-composer-row">
              <textarea className="input" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={tr('Reply on {channel}…', { channel: channelLabel(c.channel) })} aria-label={tr('Reply')}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.currentTarget.form.requestSubmit(); }} />
              <button type="submit" className="ib-send" disabled={busy || !text.trim()} aria-label={tr('Send')}><Icon name="send" /></button>
            </div>
            <p className="dk-muted tl-small ib-composer-hint">{tr('Ctrl + Enter sends. It goes out on {channel}, from the company.', { channel: channelLabel(c.channel) })}</p>
          </form>
        ) : (
          <p className="crm-note"><Icon name="info" /><span>{['call', 'visit', 'sms', 'other'].includes(c.channel) ? tr('This was written down by hand. Add the next call or visit on the customer\'s profile.') : tr('{channel} isn\'t connected for sending from the OS yet, so reply on {channel} itself. Your reply will show here once it is connected.', { channel: channelLabel(c.channel) })}</span></p>
        ))}
      </div>

      <CustomerSide conv={c} canManage={canManage} reps={reps} onProfile={onProfile} onLink={() => setLinking(true)} />

      {linking && <LinkDialog conv={c} onClose={() => setLinking(false)} onDone={(x) => { setLinking(false); setC(x); onChanged(); onToast(tr('Put on {name}\'s profile.', { name: x.customer ? x.customer.name : '' })); }} />}
    </div>
  );
}

// Who this is, beside the conversation on a wide screen: what they buy,
// what they owe, their rep and what is planned — no need to open the profile.
function CustomerSide({ conv, canManage, reps, onProfile, onLink }) {
  const [p, setP] = useState(null);
  const cid = conv.customer ? conv.customer.id : null;
  useEffect(() => {
    let alive = true;
    setP(null);
    if (cid) api.get('/crm/profiles/' + cid).then((x) => { if (alive) setP(x); }).catch(() => {});
    return () => { alive = false; };
  }, [cid]);
  if (!cid) {
    return (
      <aside className="ib-side">
        <span className="ib-side-art" aria-hidden="true"><Icon name="people" /></span>
        <h4>{tr('Who is this?')}</h4>
        <p className="dk-muted tl-small">{tr('Put the conversation on the right customer: their next message lands there by itself, with everything they buy and owe.')}</p>
        {canManage && <button type="button" className="ib-btn is-primary" onClick={onLink}>{tr('Put it on a profile')}</button>}
      </aside>
    );
  }
  if (!p) return <aside className="ib-side"><p className="eyebrow">{tr('Loading…')}</p></aside>;
  const repPhoto = p.rep ? ((reps.find((r) => r.id === p.rep.id) || {}).photo || p.rep.photo) : null;
  return (
    <aside className="ib-side">
      <div className="ib-side-head">
        <CustMark name={p.name} size={56} />
        <strong>{p.name}</strong>
        <span className="dk-muted tl-small">{[p.contactPerson, p.location].filter(Boolean).join(' · ') || '—'}</span>
        <CategoryTag value={p.category} />
      </div>
      <dl className="ib-side-facts">
        <div><dt>{tr('Bought')}</dt><dd>{ghsOr(p.lifetime)}</dd></div>
        <div className={p.outstanding > 0 ? 'is-bad' : ''}><dt>{tr('Owes')}</dt><dd>{ghsOr(p.outstanding)}</dd></div>
        <div><dt>{tr('Open quotations')}</dt><dd>{p.openQuotes}</dd></div>
        <div><dt>{tr('Next follow-up')}</dt><dd>{p.followUpOn ? fmtDate(p.followUpOn) : '—'}</dd></div>
      </dl>
      <div className="ib-side-rep">
        {p.rep ? <><Photo id={p.rep.id} name={p.rep.name} photo={repPhoto} size={30} /><span><small className="dk-muted">{tr('Sales rep')}</small><strong>{p.rep.name}</strong></span></>
          : <span className="ib-flag is-warn">{tr('no rep')}</span>}
      </div>
      {p.interests.length > 0 && (
        <div className="ib-side-block">
          <small className="dk-muted">{tr('Buys or asks about')}</small>
          <div className="ib-side-chips">{p.interests.slice(0, 5).map((x) => <span key={x.name} className={'ib-chip' + (x.bought ? ' is-bought' : '')}>{x.name}</span>)}</div>
        </div>
      )}
      {p.identities.length > 0 && (
        <div className="ib-side-block">
          <small className="dk-muted">{tr('Reaches us on')}</small>
          <div className="ib-side-chips">{p.identities.slice(0, 5).map((i) => <span key={i.kind + i.value} className="ib-chip"><ChannelDot channel={i.kind === 'phone' ? 'call' : i.kind} /> {i.label || i.value}</span>)}</div>
        </div>
      )}
      <button type="button" className="ib-btn is-soft" onClick={() => onProfile(p.id)}>{tr('Open the profile')} <Icon name="arrow" /></button>
    </aside>
  );
}

// Put a conversation on an existing customer, or make a new profile from it.
function LinkDialog({ conv, onClose, onDone }) {
  const [q, setQ] = useState(conv.contact.name || '');
  const [found, setFound] = useState([]);
  const [name, setName] = useState(conv.contact.name || conv.contact.label || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return undefined; }
    const t = setTimeout(() => api.get('/crm/profiles?limit=12&search=' + encodeURIComponent(q.trim())).then((x) => setFound(x.profiles)).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [q]);
  async function link(body) {
    setBusy(true); setError(null);
    try { onDone(await api.post('/crm/conversations/' + conv.id + '/link', body)); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop crm-over" onClick={() => !busy && onClose()}>
      <div className="dialog crm-dialog" role="dialog" aria-modal="true" aria-labelledby="hub-link-t" onClick={(e) => e.stopPropagation()}>
        <h2 id="hub-link-t">{tr('Whose conversation is this?')}</h2>
        <p className="dk-muted">{tr('Choose the customer. {who} will be added to their profile, so the next message lands there by itself.', { who: conv.contact.label || conv.contact.name })}</p>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <SearchInput value={q} onChange={setQ} placeholder={tr('Search customers…')} />
        <ul className="crm-pick">
          {found.map((p) => (
            <li key={p.id}><button type="button" disabled={busy || (conv.customer && conv.customer.id === p.id)} onClick={() => link({ customerId: p.id })}>
              <strong>{p.name}</strong><span className="dk-muted tl-small">{[p.phone, p.email, p.location, p.rep ? p.rep.name : tr('No rep yet')].filter(Boolean).join(' · ')}</span>
            </button></li>
          ))}
          {q.trim().length >= 2 && !found.length && <li className="dk-muted tl-small hub-pad">{tr('Nobody found.')}</li>}
        </ul>
        <div className="crm-box">
          <h3 className="dk-h3">{tr('Or make a new profile')}</h3>
          <div className="crm-inline"><input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-label={tr('Name')} /><button type="button" className="btn btn-secondary" disabled={busy || !name.trim()} onClick={() => link({ name })}>{tr('New profile')}</button></div>
        </div>
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button></div>
      </div>
    </div>
  );
}

// WhatsApp's own export (More → Export chat), .txt or .zip.
function ImportChatDialog({ onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [ours, setOurs] = useState([]);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function read(f) {
    setFile(f); setPreview(null); setError(null);
    if (!f) return;
    setBusy(true);
    try {
      const fd = new FormData(); fd.append('file', f);
      const pv = await api.upload('/crm/import/whatsapp/preview', fd);
      setPreview(pv);
      const cust = pv.guessCustomer;
      setOurs(pv.people.filter((p) => cust ? p.name !== cust : false).map((p) => p.name));
      const cp = pv.people.find((p) => p.name === cust);
      setPhone(cp && cp.phone ? cp.phone : '');
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function run() {
    setBusy(true); setError(null);
    try {
      const fd = new FormData(); fd.append('file', file); fd.append('ourNames', JSON.stringify(ours)); fd.append('phone', phone);
      onDone(await api.upload('/crm/import/whatsapp', fd));
    } catch (err) { setError(err.message); setBusy(false); }
  }
  const them = preview ? preview.people.filter((p) => !ours.includes(p.name)) : [];
  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog crm-dialog" role="dialog" aria-modal="true" aria-labelledby="hub-imp-t" onClick={(e) => e.stopPropagation()}>
        <h2 id="hub-imp-t">{tr('Import a WhatsApp chat')}</h2>
        <ol className="crm-howto">
          <li>{tr('On the phone, open the chat with the customer.')}</li>
          <li>{tr('Tap ⋮ (or the name on iPhone) → More → Export chat → Without media.')}</li>
          <li>{tr('Send the file to yourself, then choose it here (.txt or .zip).')}</li>
        </ol>
        <p className="dk-muted tl-small">{tr('Only the words are kept. Importing the same chat again adds only what is new.')}</p>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <input type="file" className="input" accept=".txt,.zip,text/plain,application/zip" onChange={(e) => read(e.target.files[0] || null)} aria-label={tr('The exported chat')} />
        {busy && !preview && <p className="eyebrow">{tr('Reading the chat…')}</p>}
        {preview && (
          <>
            <div className="crm-note is-good"><Icon name="check" /><span>{tr('{n} messages from {from} to {to}.', { n: preview.messages, from: fmtDate(preview.from), to: fmtDate(preview.to) })}</span></div>
            <fieldset className="hub-fieldset">
              <legend>{tr('Which of these is Bamboo Products? (the phone the chat was exported from)')}</legend>
              {preview.people.map((p) => (
                <label key={p.name} className="hub-check">
                  <input type="checkbox" checked={ours.includes(p.name)} onChange={(e) => setOurs(e.target.checked ? [...ours, p.name] : ours.filter((x) => x !== p.name))} />
                  <strong>{p.name}</strong> <span className="dk-muted tl-small">{tr('{n} messages', { n: p.messages })}{p.phone ? ' · ' + p.phone : ''}</span>
                </label>
              ))}
            </fieldset>
            {them.length === 1 && <p className="tl-small">{tr('The customer is {name}.', { name: them[0].name })}</p>}
            {them.length > 1 && <p className="crm-note is-warn"><Icon name="warn" /><span>{tr('More than one person is left as the customer. Tick everyone who is Bamboo Products; group chats can\'t be imported.')}</span></p>}
            <div className="field"><label htmlFor="hub-imp-ph">{tr('The customer\'s WhatsApp number')}</label><input id="hub-imp-ph" className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="024 000 0000" /></div>
            <p className="dk-muted tl-small">{tr('The number puts the chat on the right profile and joins it to their live WhatsApp messages.')}</p>
            <div className="hub-sample">{preview.sample.map((m, i) => <p key={i}><strong>{m.author}:</strong> {m.body}</p>)}</div>
          </>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
          <button type="button" className="btn btn-primary" onClick={run} disabled={busy || !preview || !ours.length || them.length !== 1}>{tr('Import')}</button>
        </div>
      </div>
    </div>
  );
}
