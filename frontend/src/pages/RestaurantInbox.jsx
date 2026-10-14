import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import SearchInput from '../components/SearchInput';
import { Icon, avatarColor, initials } from '../components/DashKit';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import { fromFacebook, loadSdk } from '../lib/metaSdk';
import './RestaurantInbox.css';

// A restaurant's message inbox, the Inbox view of its Guest CRM (backend:
// restaurantInbox.service.js): guests' WhatsApp messages to the
// restaurant's own number and Messenger and Instagram messages to its own
// Page and account, each chat with the guest it is from. On top, what is
// connected — the WhatsApp number (connected here with Meta's window, as
// Bamboo Products' is on Integrations) and the Page and Instagram account
// (connected on the Social tracker). Then the chats, waiting ones first to
// the eye, and the open chat: the guest's orders at a glance, the
// messages, and the answer box, which says how long Meta still allows a
// free answer (24 hours after the guest's last message).

const CHANNEL = { whatsapp: msg('WhatsApp'), facebook: msg('Messenger'), instagram: msg('Instagram') };
const CH_ICON = { whatsapp: 'phone', facebook: 'send', instagram: 'eye' };
const SHOW = [['waiting', msg('Waiting for us')], ['open', msg('Open')], ['closed', msg('Closed')], ['all', msg('All')]];
const POLL_MS = 30000;

function clock(iso) { return new Date(iso).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' }); }
function dayKey(iso) { const d = new Date(iso); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }
function dayName(iso) {
  const d = new Date(iso), now = new Date();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (dayKey(d) === dayKey(now)) return tr('Today');
  if (dayKey(d) === dayKey(y)) return tr('Yesterday');
  return d.toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long' });
}
// "14:05" today, "Mon" this week, "3 Oct" before.
function when(iso) {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  if (dayKey(d) === dayKey(now)) return clock(iso);
  if (now - d < 6 * 86400000) return d.toLocaleDateString(activeIntlLocale(), { weekday: 'short' });
  return d.toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' });
}
// When Meta stops allowing a free answer: "today 21:40", "tomorrow 09:15".
function untilText(d) {
  const now = new Date(), tom = new Date(now); tom.setDate(now.getDate() + 1);
  const t = clock(d.toISOString());
  if (dayKey(d) === dayKey(now)) return tr('today at {time}', { time: t });
  if (dayKey(d) === dayKey(tom)) return tr('tomorrow at {time}', { time: t });
  return d.toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long' }) + ' ' + t;
}
function ago(iso) {
  if (!iso) return '';
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return tr('just now');
  if (m < 60) return tr('{n} min ago', { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return tr('{n} h ago', { n: h });
  return when(iso);
}

function ChannelBadge({ channel, small }) {
  return <span className={'ri-ch is-' + channel + (small ? ' is-small' : '')} title={tr(CHANNEL[channel])}><Icon name={CH_ICON[channel]} /></span>;
}
function Face({ name, channel }) {
  return (
    <span className="ri-face" style={{ background: avatarColor(name || '?') }}>
      {initials(name || '?')}
      <ChannelBadge channel={channel} small />
    </span>
  );
}

export default function RestaurantInbox({ companyId, company, canManage, openId, onOpenId, onGuest, onLogOrder, say, onCounts }) {
  const [data, setData] = useState(null);
  const [show, setShow] = useState('open');
  const [channel, setChannel] = useState('');
  const [q, setQ] = useState('');
  const [conv, setConv] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    const p = { companyId, status: show };
    if (channel) p.channel = channel;
    if (q.trim()) p.q = q.trim();
    try {
      const d = await api.get('/restaurant-inbox?' + new URLSearchParams(p));
      setData(d); setError(null);
      if (onCounts) onCounts(d.counts);
    } catch (err) { setError(err.message); }
  }, [companyId, show, channel, q, onCounts]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(load, POLL_MS); return () => clearInterval(t); }, [load]);

  const open = useCallback(async (id) => {
    if (!id) { setConv(null); onOpenId(null); return; }
    try { setConv(await api.get('/restaurant-inbox/' + id)); onOpenId(id); } catch (err) { setError(err.message); }
  }, [onOpenId]);
  useEffect(() => { if (openId && (!conv || conv.id !== openId)) open(openId); }, [openId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setConv(null); }, [companyId]);

  function changed(c) { setConv(c); load(); }

  if (!data) return error ? <div className="error-banner" role="alert">{error}</div> : <div className="rc-skeleton" aria-busy="true"><span /><span /><span /></div>;
  const n = data.counts;
  const list = data.conversations;

  return (
    <section id="rc-inbox" className={'ri' + (conv ? ' is-reading' : '')}>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <Connections data={data} company={company} companyId={companyId} onChanged={(d, text) => { setData(d); if (text) say(text); }} />

      <div className={'ri-shell' + (conv ? ' is-reading' : '')}>
        <aside className="ri-list" aria-label={tr('Chats')}>
          <div className="ri-list-head">
            <div className="ri-show" role="radiogroup" aria-label={tr('Show')}>
              {SHOW.map(([k, label]) => (
                <button key={k} type="button" role="radio" aria-checked={show === k} className={'ri-show-opt' + (show === k ? ' is-on' : '')} onClick={() => setShow(k)}>
                  {tr(label)}<span>{k === 'all' ? n.all : n[k]}</span>
                </button>
              ))}
            </div>
            <div className="ri-filter">
              <SearchInput value={q} onChange={setQ} placeholder={tr('Name, number or words')} />
              <div className="ri-chs" role="group" aria-label={tr('Channel')}>
                {['whatsapp', 'facebook', 'instagram'].map((c) => (
                  <button key={c} type="button" aria-pressed={channel === c} className={'ri-chpick' + (channel === c ? ' is-on' : '')} onClick={() => setChannel(channel === c ? '' : c)} title={tr(CHANNEL[c])}>
                    <ChannelBadge channel={c} small /><span>{n[c]}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
          {list.length ? (
            <ul className="ri-items">
              {list.map((c) => (
                <li key={c.id}>
                  <button type="button" className={'ri-item' + (conv && conv.id === c.id ? ' is-open' : '') + (c.waiting ? ' is-waiting' : '') + (c.unread ? ' is-unread' : '')} onClick={() => open(c.id)}>
                    <Face name={c.contactName || c.contactHandle} channel={c.channel} />
                    <span className="ri-item-main">
                      <span className="ri-item-top">
                        <strong>{c.contactName || c.contactHandle || tr('Guest')}</strong>
                        <time dateTime={c.lastMessageAt}>{when(c.lastMessageAt)}</time>
                      </span>
                      <span className="ri-item-preview">{c.lastDirection === 'out' && <span className="ri-you">{tr('You:')} </span>}{c.lastPreview}</span>
                      <span className="ri-item-tags">
                        {c.guest ? <span className="ri-tag is-guest"><Icon name="people" /> {c.guest.name}</span> : <span className="ri-tag">{tr('Not a guest yet')}</span>}
                        {c.waiting && <span className="ri-tag is-wait"><Icon name="clock" /> {tr('Waiting')}</span>}
                        {c.status === 'closed' && <span className="ri-tag">{tr('Closed')}</span>}
                      </span>
                    </span>
                    {c.unread > 0 && <span className="ri-unread" aria-label={tr('{n} unread', { n: c.unread })}>{c.unread}</span>}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="ri-empty-list">
              <span className="ri-empty-icon"><Icon name="send" /></span>
              <p>{show === 'waiting' ? tr('Nobody is waiting for an answer.') : tr('No chats here yet. When a guest writes on WhatsApp, Messenger or Instagram, the chat comes in here.')}</p>
            </div>
          )}
        </aside>

        <div className="ri-thread">
          {conv ? <Thread conv={conv} companyId={companyId} canManage={canManage} onBack={() => open(null)} onChanged={changed}
            onGuest={onGuest} onLogOrder={onLogOrder} say={say} /> : (
            <div className="ri-thread-empty">
              <span className="ri-empty-icon is-big"><Icon name="send" /></span>
              <h3>{n.waiting ? (n.waiting === 1 ? tr('1 guest is waiting for an answer') : tr('{n} guests are waiting for an answer', { n: n.waiting })) : tr('All answered')}</h3>
              <p className="dk-muted">{tr('Pick a chat to read it and answer. Each chat sits with the guest it is from, next to their orders.')}</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// ── one chat ──────────────────────────────────────────────────────────
function Thread({ conv, companyId, canManage, onBack, onChanged, onGuest, onLogOrder, say }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const end = useRef(null);
  useEffect(() => { if (end.current) end.current.scrollIntoView({ block: 'end' }); }, [conv.id, conv.messages.length]);
  useEffect(() => { setText(''); setErr(null); }, [conv.id]);

  async function act(fn, done) {
    setBusy(true); setErr(null);
    try { const c = await fn(); onChanged(c); if (done) say(done); return true; } catch (e) { setErr(e.message); return false; } finally { setBusy(false); }
  }
  async function send(e) {
    e.preventDefault();
    if (!text.trim()) return;
    if (await act(() => api.post('/restaurant-inbox/' + conv.id + '/reply', { body: text }), null)) setText('');
  }
  const until = conv.lastInAt ? new Date(new Date(conv.lastInAt).getTime() + 24 * 3600000) : null;
  const name = conv.contactName || conv.contactHandle || tr('Guest');
  let lastDay = null;

  return (
    <div className="ri-chat">
      <header className="ri-chat-head">
        <button type="button" className="ri-back" onClick={onBack} aria-label={tr('Back to the chats')}><Icon name="arrow" /></button>
        <Face name={name} channel={conv.channel} />
        <div className="ri-chat-who">
          <strong>{name}</strong>
          <span className="dk-muted">{tr(CHANNEL[conv.channel])}{conv.contactHandle && conv.contactHandle !== name ? ' · ' + conv.contactHandle : ''}</span>
        </div>
        {canManage && (
          <button type="button" className="rc-btn is-ghost is-small" disabled={busy} onClick={() => act(() => api.post('/restaurant-inbox/' + conv.id + '/status', { status: conv.status === 'open' ? 'closed' : 'open' }), conv.status === 'open' ? tr('Chat closed.') : tr('Chat open again.'))}>
            {conv.status === 'open' ? <><Icon name="check" /> {tr('Close')}</> : tr('Open again')}
          </button>
        )}
      </header>

      <GuestBar conv={conv} companyId={companyId} canManage={canManage} busy={busy} act={act} onGuest={onGuest} onLogOrder={onLogOrder} />

      <div className="ri-msgs" aria-live="polite">
        {conv.imported && <p className="ri-note">{tr('Past chat, brought in when the number was connected.')}</p>}
        {conv.messages.map((m) => {
          const day = dayKey(m.sentAt);
          const sep = day !== lastDay ? <div className="ri-day" key={'d' + m.id}><span>{dayName(m.sentAt)}</span></div> : null;
          lastDay = day;
          return [sep, (
            <div key={m.id} className={'ri-msg ri-msg-' + m.direction}>
              <div className="ri-bubble">
                {m.direction === 'out' && m.author && <span className="ri-by">{m.author}</span>}
                {m.body && <p>{m.body}</p>}
                {(m.attachments || []).map((a, i) => <span key={i} className="ri-att"><Icon name="doc" /> {a.name}</span>)}
                <time dateTime={m.sentAt}>{clock(m.sentAt)}</time>
              </div>
            </div>
          )];
        })}
        <div ref={end} />
      </div>

      {err && <div className="error-banner" role="alert">{err}</div>}
      {canManage ? (
        conv.canReply ? (
          <form className="ri-reply" onSubmit={send}>
            <textarea className="input" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={tr('Write your answer…')} aria-label={tr('Your answer')} maxLength={4000}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e); } }} />
            <div className="ri-reply-foot">
              <span className="dk-muted">{until ? tr('Goes out on {channel}. Meta allows an answer until {when}.', { channel: tr(CHANNEL[conv.channel]), when: untilText(until) }) : ''}</span>
              <button type="submit" className="rc-btn is-primary is-small" disabled={busy || !text.trim()}><Icon name="send" /> {busy ? tr('Sending…') : tr('Send')}</button>
            </div>
          </form>
        ) : (
          <p className="ri-closed-window"><Icon name="clock" /> {conv.channel === 'whatsapp'
            ? tr('More than 24 hours since they last wrote, so Meta does not allow a free answer. Call them on {phone}, or wait for them to write again.', { phone: conv.contactHandle || '' })
            : tr('More than 24 hours since they last wrote, so Meta does not allow a free answer. Wait for them to write again.')}</p>
        )
      ) : <p className="ri-closed-window">{tr('Restaurant managers answer here.')}</p>}
    </div>
  );
}

// Who the chat is with: the guest's orders at a glance, or how to put the
// chat with a guest.
function GuestBar({ conv, companyId, canManage, busy, act, onGuest, onLogOrder }) {
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);
  const timer = useRef(null);
  useEffect(() => { setPicking(false); setQ(''); setFound([]); }, [conv.id]);
  function search(v) {
    setQ(v);
    clearTimeout(timer.current);
    if (v.trim().length < 2) { setFound([]); return; }
    timer.current = setTimeout(async () => {
      try { setFound((await api.get('/restaurant-crm/guests?' + new URLSearchParams({ companyId, q: v.trim(), limit: 6, sort: 'orders' }))).guests); } catch { setFound([]); }
    }, 250);
  }
  const g = conv.guest;
  if (g) {
    return (
      <div className="ri-guest is-linked">
        <span className="ri-guest-face" style={{ background: avatarColor(g.name) }}>{initials(g.name)}</span>
        <div className="ri-guest-main">
          <button type="button" className="ri-linklike" onClick={() => onGuest(g.id)}>{g.name}</button>
          <span className="dk-muted">
            {g.orders === 1 ? tr('1 order') : tr('{n} orders', { n: g.orders || 0 })}
            {g.lastOrder ? ' · ' + tr('last {date}', { date: new Date(g.lastOrder + 'T00:00:00').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' }) }) : ''}
            {g.rating ? ' · ★ ' + g.rating.toLocaleString(activeIntlLocale()) : ''}
          </span>
        </div>
        {canManage && <button type="button" className="rc-btn is-primary is-small" onClick={() => onLogOrder({ guest: { id: g.id, name: g.name, phone: g.phone }, channel: conv.channel === 'whatsapp' ? 'whatsapp' : conv.channel })}><Icon name="receipt" /> {tr('Log an order')}</button>}
      </div>
    );
  }
  return (
    <div className="ri-guest">
      <span className="ri-guest-face is-new"><Icon name="people" /></span>
      <div className="ri-guest-main">
        <strong>{tr('Not with a guest yet')}</strong>
        <span className="dk-muted">{conv.channel === 'whatsapp' ? tr('No guest has this number.') : tr('Messenger and Instagram don\'t share the number: say who it is.')}</span>
      </div>
      {canManage && !picking && <>
        <button type="button" className="rc-btn is-ghost is-small" onClick={() => setPicking(true)}>{tr('Find the guest')}</button>
        <button type="button" className="rc-btn is-primary is-small" disabled={busy} onClick={() => act(() => api.post('/restaurant-inbox/' + conv.id + '/guest', { create: true }), tr('{name} is now a guest.', { name: conv.contactName || conv.contactHandle }))}><Icon name="people" /> {tr('Make them a guest')}</button>
      </>}
      {picking && (
        <div className="ri-pick">
          <input className="input" autoFocus value={q} onChange={(e) => search(e.target.value)} placeholder={tr('Type the guest\'s name or number')} aria-label={tr('Find the guest')} />
          {found.length > 0 && (
            <ul className="rc-suggest" role="listbox">
              {found.map((x) => (
                <li key={x.id}><button type="button" onClick={() => act(() => api.post('/restaurant-inbox/' + conv.id + '/guest', { guestId: x.id }), tr('Chat put with {name}.', { name: x.name }))}>
                  <strong>{x.name}</strong> <span className="dk-muted">{x.phone || ''} · {x.orders === 1 ? tr('1 order') : tr('{n} orders', { n: x.orders || 0 })}</span>
                </button></li>
              ))}
            </ul>
          )}
          <button type="button" className="rc-btn is-ghost is-small" onClick={() => setPicking(false)}>{tr('Cancel')}</button>
        </div>
      )}
    </div>
  );
}

// ── what is connected ─────────────────────────────────────────────────
function Connections({ data, company, companyId, onChanged }) {
  const c = data.connections;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [sdk, setSdk] = useState('idle');
  const pending = useRef(null);
  const wa = c.whatsapp;
  const canWa = wa.ready && wa.canConnect && !wa.connection;

  useEffect(() => {
    if (!canWa || sdk !== 'idle') return;
    setSdk('loading');
    loadSdk(wa.appId).then(() => setSdk('ready'), () => setSdk('failed'));
  }, [canWa, sdk, wa.appId]);

  const finish = useCallback(async () => {
    const p = pending.current;
    if (!p || !p.code || !p.session) return;
    pending.current = null;
    const ev = p.session.event || '';
    const d = p.session.data || {};
    if (!/^FINISH/.test(ev)) return;
    setBusy(true); setErr(null);
    try {
      const out = await api.post('/restaurant-inbox/whatsapp', { companyId, code: p.code, wabaId: d.waba_id, phoneNumberId: d.phone_number_id, coexistence: ev === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' || p.coexistence });
      onChanged(out, tr('{restaurant}\'s WhatsApp {number} is connected.', { restaurant: company.name, number: (out.connections.whatsapp.connection && out.connections.whatsapp.connection.displayPhone) || '' }));
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }, [companyId, company.name, onChanged]);

  useEffect(() => {
    function onMessage(e) {
      if (!fromFacebook(e.origin)) return;
      let m = e.data;
      try { if (typeof m === 'string') m = JSON.parse(m); } catch { return; }
      if (!m || m.type !== 'WA_EMBEDDED_SIGNUP' || !pending.current) return;
      if (m.event === 'CANCEL') { pending.current = null; setBusy(false); setErr(tr('Meta\'s window was closed. Nothing was connected.')); }
      else if (m.event === 'ERROR') { pending.current = null; setBusy(false); setErr(tr('Meta reported a problem: {why}', { why: (m.data && m.data.error_message) || '—' })); }
      else { pending.current.session = m; finish(); }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [finish]);

  function connect(coexistence) {
    if (!window.FB) { setErr(tr('Facebook\'s sign-in could not be loaded. Check the connection, turn off any blocker for facebook.com, and reload the page.')); return; }
    setErr(null); setBusy(true);
    pending.current = { coexistence, code: null, session: null };
    const extras = { setup: {}, sessionInfoVersion: '3' };
    if (coexistence) extras.featureType = 'whatsapp_business_app_onboarding';
    window.FB.login(function (resp) {
      if (!pending.current) return;
      if (resp && resp.authResponse && resp.authResponse.code) { pending.current.code = resp.authResponse.code; finish(); }
      else { pending.current = null; setBusy(false); }
    }, { config_id: wa.configId, response_type: 'code', override_default_response_type: true, extras });
  }
  async function disconnect() {
    if (!window.confirm(tr('Disconnect {number} from {restaurant}\'s inbox? New messages stop coming in here; the chats stay. The WhatsApp Business app on the phone is not affected.', { number: wa.connection.displayPhone, restaurant: company.name }))) return;
    setBusy(true); setErr(null);
    try { onChanged(await api.del('/restaurant-inbox/whatsapp?companyId=' + companyId), tr('WhatsApp disconnected from the inbox.')); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function readNow() {
    setBusy(true); setErr(null);
    try {
      const out = await api.post('/restaurant-inbox/meta/read', { companyId });
      const r = out.read || {};
      const bad = ['facebook', 'instagram'].map((k) => r[k] && r[k].error).filter(Boolean);
      onChanged(out, bad.length ? null : tr('Messenger and Instagram read just now.'));
      if (bad.length) setErr(bad.join(' · '));
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  const fb = c.facebook, ig = c.instagram;
  const tracker = '/socialtracker?company=' + encodeURIComponent(company.code);
  return (
    <div className="ri-conns">
      <div className={'ri-conn' + (wa.connection ? ' is-on' : '')}>
        <ChannelBadge channel="whatsapp" />
        <div className="ri-conn-main">
          <strong>{tr('WhatsApp')}</strong>
          {wa.connection ? <>
            <span>{wa.connection.displayPhone || tr('Connected')}{wa.connection.verifiedName ? ' · ' + wa.connection.verifiedName : ''}</span>
            <span className="dk-muted">{wa.connection.coexistence ? tr('Also in the WhatsApp Business app on the phone') : tr('Only through the OS')}{wa.lastGuestAt ? ' · ' + tr('last guest message {when}', { when: ago(wa.lastGuestAt) }) : ''}</span>
          </> : !wa.ready ? (
            <span className="dk-muted">{tr('WhatsApp isn\'t set up for the OS yet. An administrator finishes Integrations → WhatsApp first; then each restaurant connects its number here.')}</span>
          ) : !wa.canConnect ? (
            <span className="dk-muted">{tr('Not connected. A restaurant manager connects the restaurant\'s number here.')}</span>
          ) : (
            <span className="dk-muted">{tr('Connect {restaurant}\'s own number. It can stay in the WhatsApp Business app on the restaurant phone: staff keep using it there, and the OS gets every message.', { restaurant: company.name })}</span>
          )}
        </div>
        <div className="ri-conn-act">
          {wa.connection ? (wa.canConnect && <button type="button" className="rc-btn is-ghost is-small" disabled={busy} onClick={disconnect}>{tr('Disconnect')}</button>)
            : canWa && <>
              <button type="button" className="rc-btn is-primary is-small" disabled={busy || sdk !== 'ready'} onClick={() => connect(true)}>{busy ? tr('Connecting…') : tr('Connect the number')}</button>
              <button type="button" className="ri-linklike" disabled={busy || sdk !== 'ready'} onClick={() => connect(false)}>{tr('or use a new number')}</button>
            </>}
        </div>
      </div>

      <div className={'ri-conn' + (fb.connected ? ' is-on' : '')}>
        <span className="ri-conn-pair"><ChannelBadge channel="facebook" /><ChannelBadge channel="instagram" /></span>
        <div className="ri-conn-main">
          <strong>{tr('Messenger & Instagram')}</strong>
          {fb.connected ? <>
            <span>{tr('Page connected')}{ig.connected ? ' · ' + tr('Instagram connected') : ' · ' + tr('no Instagram account on the Page')}</span>
            <span className="dk-muted">
              {!fb.messages ? tr('Connected before messages were asked for: connect the Page again on the Social tracker and allow messages.')
                : fb.lastError ? tr('Last read failed: {why}', { why: fb.lastError })
                  : fb.lastReadAt ? tr('Read {when}; new messages come in as they are sent.', { when: ago(fb.lastReadAt) }) : tr('Waiting for the first read (every few minutes).')}
            </span>
          </> : (
            <span className="dk-muted">{tr('Connect {restaurant}\'s Facebook Page (and the Instagram account linked to it) on the Social tracker; its messages then come in here.', { restaurant: company.name })}</span>
          )}
        </div>
        <div className="ri-conn-act">
          {fb.connected && fb.messages && wa.canConnect && <button type="button" className="rc-btn is-ghost is-small" disabled={busy} onClick={readNow}>{tr('Read now')}</button>}
          {(!fb.connected || !fb.messages) && (c.canTracker
            ? <a className="rc-btn is-primary is-small" href={tracker}>{tr('Connect on the Social tracker')}</a>
            : <span className="dk-muted ri-small">{tr('Someone in marketing connects it.')}</span>)}
        </div>
      </div>
      {err && <div className="error-banner ri-conn-err" role="alert">{err}</div>}
    </div>
  );
}
