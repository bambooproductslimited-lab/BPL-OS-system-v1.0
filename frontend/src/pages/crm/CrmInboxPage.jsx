import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Empty, Glossary, Hero, Icon, Section, fmtDate } from '../../components/DashKit';
import SearchInput from '../../components/SearchInput';
import { tr } from '../../lib/i18n.jsx';
import CustomerProfile from './CustomerProfile';
import { CHANNELS, ChannelDot, CustMark, ago, channelLabel, timeOf, useReps } from './crmHubShared';
import { Toast } from './crmShared';
import '../EmployeesPage.css';
import '../ToolRoomPage.css';
import './CrmPage.css';
import './CrmHub.css';

// Every conversation with customers, from every channel, in one inbox
// (GET /api/crm/conversations): WhatsApp, the sales mailbox, Instagram and
// Facebook messages, and calls and visits written down by hand. Each lands
// on the sender's profile by itself; one from someone new gets a new
// profile. Replies go out on the same channel when it is connected.
// ?c= opens a conversation. Old WhatsApp chats come in from WhatsApp's own
// "Export chat" file (ImportChatDialog).

const LIVE = ['whatsapp', 'email', 'instagram', 'facebook'];

export default function CrmInboxPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const canManage = can('crm.manage');
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [channels, setChannels] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [dialog, setDialog] = useState(null);
  const [toast, setToast] = useState(null);
  const { reps } = useReps();

  const ch = params.get('channel') || '';
  const waiting = params.get('waiting') === '1';
  const unlinked = params.get('unlinked') === '1';
  const mine = params.get('mine') === '1';
  const status = params.get('status') || 'open';
  const openId = params.get('c');
  function setParam(k, v) { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: k !== 'c' }); }

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ status, limit: '200' });
    if (ch) qs.set('channel', ch);
    if (waiting) qs.set('waiting', '1');
    if (unlinked) qs.set('unlinked', '1');
    if (mine) qs.set('mine', '1');
    if (q.trim()) qs.set('search', q.trim());
    try { setData(await api.get('/crm/conversations?' + qs.toString())); setError(null); } catch (err) { setError(err.message); }
  }, [ch, waiting, unlinked, mine, status, q]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);
  useEffect(() => { api.get('/crm/channels').then(setChannels).catch(() => {}); }, []);
  // New messages come in by themselves; look again every 30 seconds.
  useEffect(() => { const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  if (!data) return <div className="dk">{error ? <div className="error-banner">{error}</div> : <div className="eyebrow">{tr('Loading…')}</div>}</div>;
  const counts = {};
  data.counts.forEach((c) => { counts[c.channel] = c; });
  const total = (k) => data.counts.reduce((a, c) => a + c[k], 0);
  const connected = channels ? [channels.whatsapp.configured, channels.email.configured, channels.meta && channels.meta.facebook && channels.meta.facebook.connected, channels.meta && channels.meta.instagram && channels.meta.instagram.connected].filter(Boolean).length : null;

  return (
    <div className="dk crm hub">
      {error && <div className="error-banner" role="alert">{error}</div>}
      <Hero eyebrow={tr('Sales & CRM')} title={tr('Inbox')}
        sub={tr('Every message from customers, on every channel, in one place. Each conversation lands on the customer\'s profile by itself, and a reply goes back on the same channel.')}
        actions={canManage && <button type="button" className="btn btn-secondary" onClick={() => setDialog({ kind: 'import' })}><Icon name="doc" /> {tr('Import a WhatsApp chat')}</button>}
        stats={[
          { icon: 'send', value: String(total('waiting')), label: tr('waiting for a reply'), note: tr('they wrote last'), tone: total('waiting') ? 'alert' : 'good', onClick: () => setParam('waiting', waiting ? '' : '1') },
          { icon: 'drawer', value: String(total('open')), label: tr('open conversations'), note: tr('on {n} channels', { n: data.counts.length }), onClick: () => { const p = new URLSearchParams(); setParams(p, { replace: true }); } },
          { icon: 'people', value: String(total('unlinked')), label: tr('not on a profile'), note: tr('put them on the right customer'), tone: total('unlinked') ? 'bad' : '', onClick: () => setParam('unlinked', unlinked ? '' : '1') },
          { icon: 'phone', value: connected === null ? '…' : connected + ' / 4', label: tr('channels connected'), note: tr('WhatsApp, email, Facebook, Instagram'), onClick: () => navigate('/crmhealth#channels') }
        ]} />

      <Section id="hub-inbox" title={tr('Conversations')} sub={tr('Newest first. A red dot means the customer is waiting for us.')}>
        <div className="hub-inbox">
          <div className="hub-inbox-list">
            <div className="crm-filters">
              <SearchInput value={q} onChange={setQ} placeholder={tr('Search name, number, words…')} />
            </div>
            <div className="ppl-chips hub-ch-chips" role="radiogroup" aria-label={tr('Channel')}>
              <button type="button" role="radio" aria-checked={!ch} className={'ppl-chip' + (!ch ? ' is-on' : '')} onClick={() => setParam('channel', '')}>{tr('All')} <span className="ppl-chip-n">{total('open')}</span></button>
              {CHANNELS.filter((c) => counts[c.key] || LIVE.includes(c.key)).map((c) => (
                <button key={c.key} type="button" role="radio" aria-checked={ch === c.key} className={'ppl-chip' + (ch === c.key ? ' is-on' : '')} onClick={() => setParam('channel', c.key)}>
                  <ChannelDot channel={c.key} /> {tr(c.label)} <span className={'ppl-chip-n' + (counts[c.key] && counts[c.key].waiting ? ' is-bad' : '')}>{counts[c.key] ? counts[c.key].open : 0}</span>
                </button>
              ))}
            </div>
            <div className="ppl-chips">
              {[['waiting', waiting, tr('Waiting for a reply')], ['unlinked', unlinked, tr('Not on a profile')], ['mine', mine, tr('My customers')]].map(([k, on, l]) => (
                <button key={k} type="button" aria-pressed={on} className={'ppl-chip' + (on ? ' is-on' : '')} onClick={() => setParam(k, on ? '' : '1')}>{l}</button>
              ))}
              <select className="input crm-date" value={status} onChange={(e) => setParam('status', e.target.value === 'open' ? '' : e.target.value)} aria-label={tr('Status')}>
                <option value="open">{tr('Open')}</option>
                <option value="closed">{tr('Closed')}</option>
                <option value="spam">{tr('Spam')}</option>
                <option value="all">{tr('All')}</option>
              </select>
            </div>
            {data.conversations.length ? (
              <ul className="hub-convs">
                {data.conversations.map((c) => (
                  <li key={c.id}>
                    <button type="button" className={'hub-conv' + (openId === c.id ? ' is-on' : '') + (c.waiting ? ' is-waiting' : '')} onClick={() => setParam('c', c.id)} aria-current={openId === c.id ? 'true' : undefined}>
                      <span className="hub-conv-mark"><CustMark name={c.customer ? c.customer.name : c.contact.name || c.contact.label} size={40} /><ChannelDot channel={c.channel} /></span>
                      <span className="hub-conv-main">
                        <span className="hub-thread-top"><strong>{c.customer ? c.customer.name : c.contact.name || c.contact.label}</strong><span className="dk-muted tl-small">{ago(c.lastMessageAt)}</span></span>
                        {c.subject && <span className="tl-small hub-clip hub-conv-subject">{c.subject}</span>}
                        <span className="dk-muted tl-small hub-clip">{c.lastDirection === 'out' ? tr('You:') + ' ' : ''}{c.lastPreview}</span>
                        <span className="hub-conv-tags">
                          {!c.customer && <span className="hub-flag is-warn">{tr('not on a profile')}</span>}
                          {c.customer && !c.customer.repName && <span className="hub-flag is-warn">{tr('no rep')}</span>}
                          {c.customer && c.customer.repName && <span className="dk-muted tl-small">{c.customer.repName}</span>}
                          {c.imported && <span className="dk-muted tl-small">{tr('imported')}</span>}
                        </span>
                      </span>
                      {c.waiting && <span className="hub-waiting-dot" title={tr('Waiting for a reply')} />}
                    </button>
                  </li>
                ))}
              </ul>
            ) : <Empty icon="send">{tr('No conversation matches.')}</Empty>}
          </div>
          <div className="hub-inbox-view">
            {openId ? <ConversationView key={openId} id={openId} canManage={canManage} onChanged={load} onProfile={(id) => setDialog({ kind: 'profile', id })} onToast={setToast} onClose={() => setParam('c', '')} />
              : <div className="hub-inbox-empty"><Icon name="send" /><p>{tr('Choose a conversation to read it and reply.')}</p></div>}
          </div>
        </div>
      </Section>

      <Glossary items={[
        [tr('Waiting for a reply'), tr('The customer wrote last. It stops waiting when someone replies, here or on the channel itself.')],
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

function ConversationView({ id, canManage, onChanged, onProfile, onToast, onClose }) {
  const [c, setC] = useState(null);
  const [error, setError] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState(false);
  const end = useRef(null);
  const load = useCallback(async () => { try { setC(await api.get('/crm/conversations/' + id)); setError(null); } catch (err) { setError(err.message); } }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (end.current) end.current.scrollIntoView({ block: 'end' }); }, [c && c.messages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(fn, done) {
    setBusy(true); setError(null);
    try { setC(await fn()); onChanged(); if (done) onToast(done); return true; } catch (err) { setError(err.message); return false; } finally { setBusy(false); }
  }
  if (!c) return error ? <div className="error-banner">{error}</div> : <p className="eyebrow">{tr('Loading…')}</p>;
  const who = c.customer ? c.customer.name : c.contact.name || c.contact.label;
  let lastDay = null;

  return (
    <div className="hub-view">
      <header className="hub-view-head">
        <button type="button" className="crm-x hub-view-back" onClick={onClose} aria-label={tr('Back to the list')}>←</button>
        <CustMark name={who} size={42} />
        <div className="hub-view-who">
          <strong>{who}</strong>
          <span className="dk-muted tl-small"><ChannelDot channel={c.channel} withLabel /> {c.contact.label && c.contact.label !== who ? '· ' + c.contact.label : ''}{c.subject ? ' · ' + c.subject : ''}</span>
        </div>
        <div className="hub-view-acts">
          {c.customer && <button type="button" className="btn btn-secondary" onClick={() => onProfile(c.customer.id)}>{tr('Profile')}</button>}
          {canManage && c.status === 'open' && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => act(() => api.put('/crm/conversations/' + id + '/status', { status: 'closed' }), tr('Closed.'))}><Icon name="check" /> {tr('Close')}</button>}
          {canManage && c.status !== 'open' && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => act(() => api.put('/crm/conversations/' + id + '/status', { status: 'open' }))}>{tr('Open again')}</button>}
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
      {c.customer && canManage && <p className="dk-muted tl-small hub-view-move">{tr('On {name}\'s profile.', { name: c.customer.name })} <button type="button" className="dk-link" onClick={() => setLinking(true)}>{tr('Wrong customer?')}</button></p>}

      <ol className="hub-msgs" aria-label={tr('Messages')}>
        {c.messages.map((m) => {
          const d = new Date(m.sentAt).toDateString();
          const sep = d !== lastDay; lastDay = d;
          return (
            <li key={m.id} className={'hub-msg hub-from-' + (m.direction === 'in' ? 'them' : 'us')}>
              {sep && <span className="hub-msg-day">{fmtDate(m.sentAt)}</span>}
              <div className="hub-bubble">
                {m.direction === 'out' && <span className="hub-msg-who">{m.sentBy ? m.sentBy.name : m.author || tr('Us')}</span>}
                <p>{m.body || '—'}</p>
                {m.attachments.length > 0 && <span className="hub-msg-att"><Icon name="doc" /> {m.attachments.map((a) => a.name).join(', ')}</span>}
                <time className="hub-msg-time">{timeOf(m.sentAt)}</time>
              </div>
            </li>
          );
        })}
        <li ref={end} aria-hidden="true" />
      </ol>

      {canManage && (c.canReply ? (
        <form className="hub-reply" onSubmit={(e) => { e.preventDefault(); act(() => api.post('/crm/conversations/' + id + '/reply', { body: text }), tr('Sent on {channel}.', { channel: channelLabel(c.channel) })).then((ok) => ok && setText('')); }}>
          <textarea className="input" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={tr('Reply on {channel}…', { channel: channelLabel(c.channel) })} aria-label={tr('Reply')}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.currentTarget.form.requestSubmit(); }} />
          <button type="submit" className="btn btn-primary" disabled={busy || !text.trim()}><Icon name="send" /> {tr('Send')}</button>
        </form>
      ) : (
        <p className="crm-note"><Icon name="info" /><span>{['call', 'visit', 'sms', 'other'].includes(c.channel) ? tr('This was written down by hand. Add the next call or visit on the customer\'s profile.') : tr('{channel} isn\'t connected for sending from the OS yet, so reply on {channel} itself. Your reply will show here once it is connected.', { channel: channelLabel(c.channel) })}</span></p>
      ))}

      {linking && <LinkDialog conv={c} onClose={() => setLinking(false)} onDone={(x) => { setLinking(false); setC(x); onChanged(); onToast(tr('Put on {name}\'s profile.', { name: x.customer ? x.customer.name : '' })); }} />}
    </div>
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
