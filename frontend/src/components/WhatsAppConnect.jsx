import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { Icon, Section, Status, fmtDate } from './DashKit';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import './WhatsAppConnect.css';

// Integrations → WhatsApp: connecting the company number with Meta's
// Embedded Signup (backend/src/services/whatsappConnect.service.js).
//
// "Keep it in the WhatsApp Business app" opens Meta's window in the
// coexistence mode: the person scans a QR code with the WhatsApp Business
// app on the company phone, the phone keeps working, and the OS gets the
// messages, the replies typed on the phone, the contacts and the past chats.
// Meta tells the page which number was connected (a window message from
// facebook.com) and gives a one-time code (FB.login's answer); both go to
// the server, which swaps the code for the token with the app secret.

const SDK = 'https://connect.facebook.net/en_US/sdk.js';
const GRAPH_VERSION = 'v21.0';
let sdkPromise = null;
function loadSdk(appId) {
  if (window.FB) return Promise.resolve(window.FB);
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      window.fbAsyncInit = () => { window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version: GRAPH_VERSION }); resolve(window.FB); };
      const s = document.createElement('script');
      s.src = SDK; s.async = true; s.defer = true; s.crossOrigin = 'anonymous';
      s.onerror = () => { sdkPromise = null; reject(new Error('sdk')); };
      document.body.appendChild(s);
    });
  }
  return sdkPromise;
}
function fromFacebook(origin) { try { return /(^|\.)facebook\.com$/.test(new URL(origin).hostname); } catch { return false; } }

export default function WhatsAppConnect({ onToast }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sdk, setSdk] = useState('idle'); // idle | loading | ready | failed
  const pending = useRef(null);

  const load = useCallback(async () => {
    try { setInfo(await api.get('/whatsapp-connect')); } catch (err) { setError(err.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // The SDK is loaded ahead, so the click can open Meta's window at once
  // (browsers block pop-ups opened after a wait).
  useEffect(() => {
    if (!info || !info.ready || info.connection || sdk !== 'idle') return;
    setSdk('loading');
    loadSdk(info.appId).then(() => setSdk('ready'), () => setSdk('failed'));
  }, [info, sdk]);

  const finish = useCallback(async () => {
    const p = pending.current;
    if (!p || !p.code || !p.session) return;
    pending.current = null;
    const ev = p.session.event || '';
    const d = p.session.data || {};
    if (!/^FINISH/.test(ev)) return;
    setBusy(true); setError(null);
    try {
      const out = await api.post('/whatsapp-connect/finish', { code: p.code, wabaId: d.waba_id, phoneNumberId: d.phone_number_id, coexistence: ev === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' || p.coexistence });
      setInfo(out);
      if (onToast) onToast(tr('WhatsApp {number} is connected.', { number: (out.connection && out.connection.displayPhone) || '' }));
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }, [onToast]);

  // Meta's window says which number was connected (or where it stopped).
  useEffect(() => {
    function onMessage(e) {
      if (!fromFacebook(e.origin)) return;
      let msg = e.data;
      try { if (typeof msg === 'string') msg = JSON.parse(msg); } catch { return; }
      if (!msg || msg.type !== 'WA_EMBEDDED_SIGNUP' || !pending.current) return;
      if (msg.event === 'CANCEL') {
        pending.current = null; setBusy(false);
        setError(msg.data && msg.data.current_step ? tr('Meta\'s window was closed at the step “{step}”. Nothing was connected.', { step: msg.data.current_step }) : tr('Meta\'s window was closed. Nothing was connected.'));
      } else if (msg.event === 'ERROR') {
        pending.current = null; setBusy(false);
        setError(tr('Meta reported a problem: {why}', { why: (msg.data && msg.data.error_message) || '—' }));
      } else {
        pending.current.session = msg;
        finish();
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [finish]);

  function start(coexistence) {
    if (!window.FB) { setError(tr('Facebook\'s sign-in could not be loaded. Check the connection, turn off any blocker for facebook.com, and reload the page.')); return; }
    setError(null); setBusy(true);
    pending.current = { coexistence, code: null, session: null };
    const extras = { setup: {}, sessionInfoVersion: '3' };
    if (coexistence) extras.featureType = 'whatsapp_business_app_onboarding';
    // FB.login wants a plain function, not an async one.
    window.FB.login(function (resp) {
      if (!pending.current) return;
      if (resp && resp.authResponse && resp.authResponse.code) {
        pending.current.code = resp.authResponse.code;
        finish();
        // The window message normally comes first; if it never does, say so.
        setTimeout(() => { if (pending.current && pending.current.code && !pending.current.session) { pending.current = null; setBusy(false); setError(tr('Meta signed in but did not say which number was connected. Try again and finish every step in Meta\'s window.')); } }, 8000);
      } else {
        pending.current = null; setBusy(false);
      }
    }, { config_id: info.configId, response_type: 'code', override_default_response_type: true, extras });
  }

  async function resync() {
    setBusy(true); setError(null);
    try { setInfo(await api.post('/whatsapp-connect/resync')); if (onToast) onToast(tr('Asked Meta again for the contacts and past chats.')); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function disconnect() {
    if (!window.confirm(tr('Disconnect this number from the OS? Messages stop coming in here. The WhatsApp Business app on the phone is not affected.'))) return;
    setBusy(true); setError(null);
    try { setInfo(await api.del('/whatsapp-connect')); if (onToast) onToast(tr('WhatsApp disconnected from the OS.')); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  if (!info) return error ? <Section id="in-whatsapp" title={tr('WhatsApp')}><div className="error-banner">{error}</div></Section> : null;
  const c = info.connection;

  return (
    <Section id="in-whatsapp" title={tr('WhatsApp')} sub={tr('Connect the company WhatsApp number so customers\' messages land in the CRM inbox. The number can stay in the WhatsApp Business app on the company phone: staff keep using it there, and the OS gets every message, the replies typed on the phone, the saved contacts and up to about 6 months of past chats.')}>
      {error && <div className="error-banner" role="alert">{error}</div>}
      {c ? (
        <div className="wac-card is-on">
          <div className="wac-head">
            <span className="wac-icon"><Icon name="phone" /></span>
            <div className="wac-who">
              <strong>{c.displayPhone || c.phoneNumberId}</strong>
              <span className="dk-muted tl-small">{c.verifiedName}</span>
            </div>
            <Status tone="good">{tr('Connected')}</Status>
          </div>
          <dl className="wac-facts">
            <div><dt>{tr('On the phone')}</dt><dd>{c.coexistence ? tr('Kept in the WhatsApp Business app') : tr('Only through the OS')}</dd></div>
            <div><dt>{tr('Connected')}</dt><dd>{fmtDate(c.connectedAt)}{c.connectedBy ? ' · ' + c.connectedBy : ''}</dd></div>
            {c.coexistence && <div><dt>{tr('Contacts and past chats')}</dt><dd>{c.historyRequestedAt ? tr('Asked for on {date}. They arrive in batches; Data health shows how far they have got.', { date: fmtDate(c.historyRequestedAt) }) : tr('Not asked for yet.')}</dd></div>}
          </dl>
          {c.lastError && <p className="wac-err"><Icon name="warn" /> {tr('Meta refused the request for past chats: {why}', { why: c.lastError })}</p>}
          <div className="wac-acts">
            {c.canRequestHistory && <button type="button" className="btn btn-secondary" disabled={busy} onClick={resync}>{tr('Ask again for past chats')}</button>}
            <button type="button" className="dk-link" disabled={busy} onClick={disconnect}>{tr('Disconnect')}</button>
          </div>
          {c.coexistence && c.canRequestHistory && <p className="dk-muted tl-small">{tr('Meta only sends past chats within 24 hours of connecting (until {date}).', { date: fmtDate(c.syncUntil) })}</p>}
        </div>
      ) : (
        <div className="wac-card">
          {info.fromEnv && <p className="wac-note"><Icon name="info" /> {tr('The OS is using the number set on Render for now. Connecting here replaces it.')}</p>}
          {!info.ready ? (
            <>
              <p className="wac-err"><Icon name="warn" /> {tr('The button needs these settings on Render first: {names}', { names: info.missing.join(', ') })}</p>
              <ol className="wac-steps">
                <li>{tr('META_WA_CONFIG_ID: in Meta for Developers → BPL OS_ Tracker → Facebook Login for Business → Configurations → Create configuration. Choose the login variation “WhatsApp Embedded Signup”, set the access token to never expire, choose the WhatsApp accounts as assets with the permissions whatsapp_business_management and whatsapp_business_messaging, then create it and copy its Configuration ID.')}</li>
                <li>{tr('Add it in Render → bamboo-os-backend → Environment, then deploy.')}</li>
              </ol>
            </>
          ) : (
            <>
              <ol className="wac-steps">
                <li>{tr('Update WhatsApp Business on the company phone and keep the phone at hand.')}</li>
                <li>{tr('Press the button. Meta\'s window opens: sign in with Facebook, choose the Bamboo Products business, and choose to connect your existing WhatsApp Business app.')}</li>
                <li>{tr('Scan the QR code it shows with the WhatsApp Business app, and agree to share the chat history.')}</li>
              </ol>
              <div className="wac-acts">
                <button type="button" className="btn btn-primary" disabled={busy || sdk !== 'ready'} onClick={() => start(true)}>
                  <Icon name="phone" /> {busy ? tr('Waiting for Meta…') : sdk === 'loading' ? tr('Loading Facebook…') : tr('Connect the WhatsApp Business app')}
                </button>
                <button type="button" className="dk-link" disabled={busy || sdk !== 'ready'} onClick={() => start(false)}>{tr('Connect a new number instead')}</button>
              </div>
              {sdk === 'failed' && <p className="wac-err"><Icon name="warn" /> {tr('Facebook\'s sign-in could not be loaded. Check the connection, turn off any blocker for facebook.com, and reload the page.')}</p>}
            </>
          )}
          <p className="dk-muted tl-small">{tr('Meta must also send messages to the OS: in the app\'s WhatsApp → Configuration, the webhook is {url}, with the verify phrase from Render (WHATSAPP_VERIFY_TOKEN), subscribed to messages, smb_message_echoes, history and smb_app_state_sync.', { url: info.webhookUrl })}</p>
        </div>
      )}
      <SetupCheck onToast={onToast} onChanged={load} />
      {info.sending && <WhatsAppTools sending={info.sending} onToast={onToast} />}
    </Section>
  );
}

// ── the setup check ──────────────────────────────────────────────────
// Asks Meta whether each thing a WhatsApp message needs on its way to the OS
// is in place (whatsappConnect.service.js check()), says which is not and
// how to put it right — with a button where the OS can do it itself.
function ago(t) {
  if (!t) return '';
  const s = Math.round((new Date(t).getTime() - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(activeIntlLocale(), { numeric: 'auto' });
  const a = Math.abs(s);
  if (a < 60) return rtf.format(s, 'second');
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}
const STEP_TITLE = {
  settings: () => tr('Settings on Render'),
  app: () => tr('Meta accepts the app’s ID and secret'),
  webhook: () => tr('Meta sends WhatsApp messages to the OS (the webhook)'),
  number: () => tr('The WhatsApp number'),
  token: () => tr('The OS’s permission to use it (the access token)'),
  subscribed: () => tr('The number’s account sends its messages to this app'),
  receiving: () => tr('Messages arriving')
};
const FIX_LABEL = { webhook: () => tr('Point Meta’s webhook at the OS'), subscribe: () => tr('Subscribe the app') };
function source(d) { return d.source === 'env' ? tr('set on Render') : d.coexistence ? tr('kept in the WhatsApp Business app') : tr('only through the OS'); }

function stepText(st) {
  const d = st.data || {};
  switch (st.key) {
    case 'settings':
      return st.state === 'ok' ? tr('META_APP_ID, META_APP_SECRET, META_WA_CONFIG_ID and WHATSAPP_VERIFY_TOKEN are set.')
        : tr('Missing on Render: {names}. Add them in Render → bamboo-os-backend → Environment, then deploy.', { names: (d.missing || []).join(', ') });
    case 'app':
      if (st.state === 'skip') return tr('Needs META_APP_ID and META_APP_SECRET.');
      return st.state === 'ok' ? tr('Meta knows the app: {name}.', { name: d.name || '—' })
        : tr('Meta did not accept them ({why}). Copy the App ID and App secret again from Meta → App settings → Basic.', { why: st.error || '—' });
    case 'webhook':
      if (st.state === 'skip') return tr('Checked once Meta accepts the app’s ID and secret.');
      if (st.error) return tr('Meta did not say ({why}).', { why: st.error });
      if (st.state === 'ok') return tr('Meta sends the messages, the replies typed on the phone, the past chats and its notices to the OS.');
      if (!d.set) return tr('This app has no WhatsApp webhook yet, so Meta sends the OS nothing.');
      if (d.url !== d.expected) return tr('Meta sends them to {url}, not to the OS.', { url: d.url || '—' });
      if (!d.active || (d.fields || []).indexOf('messages') < 0) return tr('The webhook is not subscribed to messages.');
      return tr('Not subscribed to: {fields}. Replies typed on the phone, past chats or Meta’s notices will not arrive.', { fields: (d.lacking || []).join(', ') });
    case 'number':
      if (st.error && d.expired) return d.source === 'env'
        ? tr('The token set on Render (WHATSAPP_ACCESS_TOKEN) has run out, so Meta did not answer for the number. Connect the company number above: it gets a token that does not run out.')
        : tr('The token has run out, so Meta did not answer for the number. Disconnect, then connect the number again above.');
      if (st.error) return tr('Meta did not answer for the number ({why}). Connect it again.', { why: st.error });
      if (st.state === 'bad' && !d.displayPhone) return tr('No number is connected yet. Press “Connect the WhatsApp Business app” above.');
      {
        const facts = [d.displayPhone, d.verifiedName, source(d)].filter(Boolean).join(' · ');
        if (d.platform && d.platform !== 'CLOUD_API') return tr('{facts}. The number is not on WhatsApp’s Cloud API: connect it again.', { facts });
        const warns = [];
        if (d.status && d.status !== 'CONNECTED') warns.push(tr('Meta says the number is {status}.', { status: String(d.status).toLowerCase().replace(/_/g, ' ') }));
        if (d.nameStatus === 'DECLINED') warns.push(tr('Meta declined the display name.'));
        if (d.quality === 'RED') warns.push(tr('Meta rates the number’s quality low.'));
        return [facts + '.'].concat(warns).join(' ');
      }
    case 'token':
      if (st.state === 'skip') return d.source ? tr('Needs META_APP_ID and META_APP_SECRET.') : tr('Checked once a number is connected.');
      if (st.error) return tr('Meta did not check it ({why}). Connect the number again.', { why: st.error });
      if (!d.valid) return d.source === 'env'
        ? tr('The token set on Render (WHATSAPP_ACCESS_TOKEN) no longer works: it was a temporary one, from Meta’s API Setup page. Connect the company number above instead: it gets a token that does not run out.')
        : tr('It no longer works: connect the number again.');
      if ((d.lacking || []).length) return tr('It lacks {scopes}: connect the number again and allow WhatsApp.', { scopes: d.lacking.join(', ') });
      if (d.expiresAt) return st.state === 'warn' ? tr('It runs out {when}: connect the number again before then.', { when: ago(d.expiresAt) }) : tr('Valid until {date}.', { date: fmtDate(d.expiresAt) });
      return tr('Valid, and it does not run out.');
    case 'subscribed':
      if (st.state === 'skip') return d.tokenDead ? tr('Checked once the token works.') : d.noAccount ? tr('The account’s ID is not known: connect the number, or set WHATSAPP_BUSINESS_ACCOUNT_ID on Render.') : tr('Checked once a number is connected.');
      if (st.error) return tr('Meta did not say ({why}).', { why: st.error });
      return st.state === 'ok' ? tr('Yes.') : tr('No: the account’s messages are not sent to this app.');
    case 'receiving':
      if (d.signature) return tr('Meta is sending, but its signature does not match META_APP_SECRET on Render: the secret there is not this app’s. Copy it again from Meta → App settings → Basic.');
      if (st.state === 'ok') return [tr('Last call from Meta {when}', { when: ago(d.lastAt) }), d.count === 1 ? tr('1 received') : tr('{n} received', { n: d.count }),
        d.lastCustomerAt ? tr('last customer message {when}', { when: ago(d.lastCustomerAt) }) : null].filter(Boolean).join(' · ') + '.';
      return tr('Nothing has arrived yet. Send a WhatsApp message to the number from a personal phone, wait a minute and check again. If nothing comes, make sure the app is Published (Live) in Meta: in development mode Meta sends no real messages.');
    default: return '';
  }
}

function SetupCheck({ onToast, onChanged }) {
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const run = useCallback(async () => {
    setBusy('check'); setError(null);
    try { setRes(await api.get('/whatsapp-connect/check')); } catch (err) { setError(err.message); } finally { setBusy(null); }
  }, []);
  useEffect(() => { run(); }, [run]);
  async function fix(kind) {
    setBusy(kind); setError(null);
    try {
      const out = await api.post(kind === 'webhook' ? '/whatsapp-connect/webhook' : '/whatsapp-connect/subscribe');
      setRes(out);
      if (onToast) onToast(kind === 'webhook' ? tr('Meta now sends WhatsApp messages to the OS.') : tr('The app is subscribed to the number’s account.'));
      if (onChanged) onChanged();
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }
  const bad = res ? res.steps.filter((x) => x.state === 'bad').length : 0;
  return (
    <div className="wac-card wac-check" id="wa-check">
      <div className="wac-check-head">
        <div>
          <h4>{tr('Check the setup')}</h4>
          <span className="dk-muted tl-small">{tr('Asks Meta whether everything a WhatsApp message needs on its way to the OS is in place.')}</span>
        </div>
        {res && <Status tone={bad ? 'bad' : 'good'}>{bad ? (bad === 1 ? tr('1 step to put right') : tr('{n} steps to put right', { n: bad })) : tr('Everything is in place')}</Status>}
        <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={run}>{busy === 'check' ? tr('Checking…') : tr('Check again')}</button>
      </div>
      {error && <p className="wac-err"><Icon name="warn" /> {error}</p>}
      {!res ? <p className="eyebrow">{tr('Asking Meta…')}</p> : (
        <ol className="wac-check-list">
          {res.steps.map((st) => (
            <li key={st.key} className={'wac-step is-' + st.state}>
              <span className="wac-step-mark" aria-hidden="true">{st.state === 'ok' ? '✓' : st.state === 'bad' ? '✕' : st.state === 'warn' ? '!' : st.state === 'wait' ? '…' : '–'}</span>
              <div className="wac-step-main">
                <strong>{STEP_TITLE[st.key] ? STEP_TITLE[st.key]() : st.key}</strong>
                <span className="tl-small">{stepText(st)}</span>
                {st.fix && FIX_LABEL[st.fix] && <button type="button" className="btn btn-primary wac-step-fix" disabled={!!busy} onClick={() => fix(st.fix)}>{busy === st.fix ? tr('Asking Meta…') : FIX_LABEL[st.fix]()}</button>}
                {st.fix === 'connect' && st.key !== 'number' && st.data && st.data.source === 'connect' && <span className="tl-small dk-muted">{tr('Use “Disconnect”, then connect the number again above.')}</span>}
                {st.key === 'webhook' && st.state !== 'ok' && !st.fix && st.state !== 'skip' && <span className="tl-small dk-muted">{tr('Set WHATSAPP_VERIFY_TOKEN on Render first; then this button appears.')}</span>}
              </div>
            </li>
          ))}
        </ol>
      )}
      {res && <p className="dk-muted tl-small">{tr('Checked {when}. The webhook address is {url}.', { when: ago(res.checkedAt), url: res.webhookUrl })}</p>}
    </div>
  );
}

// ── a test message, and message templates ────────────────────────────
// What Meta's App Review asks to see (the app sending a WhatsApp message;
// a template created through the API) — and the templates the OS will use
// for messages to customers who haven't written in the last 24 hours.
const STATUS_TONE = { APPROVED: 'good', PENDING: 'info', IN_APPEAL: 'info', REJECTED: 'bad', PAUSED: 'warn', DISABLED: 'bad' };
function statusText(st) {
  switch (st) {
    case 'APPROVED': return tr('Approved');
    case 'PENDING': return tr('Waiting for Meta');
    case 'REJECTED': return tr('Rejected');
    case 'PAUSED': return tr('Paused');
    case 'DISABLED': return tr('Disabled');
    default: return st;
  }
}
function blanks(text) { const n = (String(text).match(/\{\{(\d+)\}\}/g) || []).map((x) => Number(x.replace(/\D/g, ''))); return n.length ? Math.max(...n) : 0; }

function WhatsAppTools({ sending, onToast }) {
  const [templates, setTemplates] = useState(null);
  const [tplError, setTplError] = useState(null);
  const [test, setTest] = useState({ to: '', template: 'hello_world', language: 'en_US', params: [] });
  const [result, setResult] = useState(null);
  const [form, setForm] = useState({ name: '', category: 'UTILITY', language: 'en', body: '', examples: [] });
  const [busy, setBusy] = useState(null);

  const loadTemplates = useCallback(async () => {
    if (!sending.templates) return;
    try { setTemplates(await api.get('/whatsapp-connect/templates')); setTplError(null); } catch (err) { setTplError(err.message); setTemplates([]); }
  }, [sending.templates]);
  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  const approved = (templates || []).filter((t) => t.status === 'APPROVED');
  const chosen = approved.find((t) => t.name === test.template && t.language === test.language) || null;
  const testBlanks = chosen ? chosen.variables : 0;
  const formBlanks = blanks(form.body);

  async function send(e) {
    e.preventDefault();
    setBusy('send'); setResult(null);
    try {
      const out = await api.post('/whatsapp-connect/test-message', { to: test.to, template: test.template, language: test.language, params: test.params.slice(0, testBlanks) });
      setResult({ ok: true, text: tr('Sent “{template}” to {to}. Check WhatsApp on that phone.', { template: out.template, to: out.to }) });
    } catch (err) { setResult({ ok: false, text: err.message }); } finally { setBusy(null); }
  }
  async function create(e) {
    e.preventDefault();
    setBusy('create'); setTplError(null);
    try {
      const out = await api.post('/whatsapp-connect/templates', { ...form, examples: form.examples.slice(0, formBlanks) });
      if (onToast) onToast(tr('Template “{name}” sent to Meta for review.', { name: out.name }));
      setForm({ name: '', category: form.category, language: form.language, body: '', examples: [] });
      await loadTemplates();
    } catch (err) { setTplError(err.message); } finally { setBusy(null); }
  }
  async function remove(t) {
    if (!window.confirm(tr('Delete the template “{name}” from WhatsApp?', { name: t.name }))) return;
    setBusy('del-' + t.name);
    try { await api.del('/whatsapp-connect/templates/' + encodeURIComponent(t.name)); await loadTemplates(); } catch (err) { setTplError(err.message); } finally { setBusy(null); }
  }

  return (
    <div className="wac-tools">
      <form className="wac-card wac-tool" onSubmit={send}>
        <div className="wac-tool-head">
          <h4>{tr('Send a test message')}</h4>
          <span className="dk-muted tl-small">{sending.source === 'env' ? tr('From the number set on Render (Meta\'s test number while you record the App Review videos).') : tr('From {number}.', { number: sending.displayPhone || sending.phoneNumberId })}</span>
        </div>
        <div className="wac-row">
          <div className="field"><label htmlFor="wac-to">{tr('To (WhatsApp number)')}</label><input id="wac-to" className="input" value={test.to} onChange={(e) => setTest({ ...test, to: e.target.value })} placeholder="024 000 0000" required /></div>
          <div className="field">
            <label htmlFor="wac-tpl">{tr('Template')}</label>
            <select id="wac-tpl" className="input" value={test.template + '|' + test.language} onChange={(e) => { const [template, language] = e.target.value.split('|'); setTest({ ...test, template, language, params: [] }); }}>
              {!approved.some((t) => t.name === 'hello_world') && <option value="hello_world|en_US">hello_world (en_US)</option>}
              {approved.map((t) => <option key={t.id} value={t.name + '|' + t.language}>{t.name} ({t.language})</option>)}
            </select>
          </div>
        </div>
        {chosen && <p className="wac-preview">{chosen.body}</p>}
        {Array.from({ length: testBlanks }, (_, i) => (
          <div className="field" key={i}><label htmlFor={'wac-p' + i}>{tr('Blank {n}', { n: '{{' + (i + 1) + '}}' })}</label><input id={'wac-p' + i} className="input" value={test.params[i] || ''} onChange={(e) => { const params = [...test.params]; params[i] = e.target.value; setTest({ ...test, params }); }} required /></div>
        ))}
        <div className="wac-acts">
          <button type="submit" className="btn btn-primary" disabled={busy === 'send'}><Icon name="send" /> {busy === 'send' ? tr('Sending…') : tr('Send')}</button>
          {result && <span className={result.ok ? 'wac-ok' : 'wac-err'}><Icon name={result.ok ? 'check' : 'warn'} /> {result.text}</span>}
        </div>
        <p className="dk-muted tl-small">{tr('Messages to people who haven\'t written in the last 24 hours must use an approved template. Meta\'s test number only sends to the phones on its recipient list (Meta → Connect on WhatsApp → Step 1. Try it out).')}</p>
      </form>

      <div className="wac-card wac-tool">
        <div className="wac-tool-head">
          <h4>{tr('Message templates')}</h4>
          <span className="dk-muted tl-small">{tr('Ready-made messages Meta approves in advance — for reminders and notices to customers who haven\'t written recently. Write {{1}}, {{2}} … where a name, an amount or a date goes.')}</span>
        </div>
        {tplError && <p className="wac-err"><Icon name="warn" /> {tplError}</p>}
        {!sending.templates ? <p className="dk-muted tl-small">{tr('Set WHATSAPP_BUSINESS_ACCOUNT_ID on Render, or connect the number above, to see and create templates.')}</p> : (
          <>
            {templates === null ? <p className="eyebrow">{tr('Loading…')}</p> : templates.length ? (
              <ul className="wac-tpls">
                {templates.map((t) => (
                  <li key={t.id}>
                    <div className="wac-tpl-main">
                      <span className="wac-tpl-name"><strong>{t.name}</strong> <span className="dk-muted tl-small">{t.language} · {t.category === 'MARKETING' ? tr('Marketing') : t.category === 'UTILITY' ? tr('Utility') : t.category}</span></span>
                      <span className="tl-small wac-tpl-body">{t.body}</span>
                      {t.rejectedReason && <span className="wac-err tl-small">{tr('Meta\'s reason: {why}', { why: t.rejectedReason.toLowerCase().replace(/_/g, ' ') })}</span>}
                    </div>
                    <Status tone={STATUS_TONE[t.status] || 'muted'}>{statusText(t.status)}</Status>
                    {t.name !== 'hello_world' && <button type="button" className="dk-link" disabled={busy === 'del-' + t.name} onClick={() => remove(t)}>{tr('Delete')}</button>}
                  </li>
                ))}
              </ul>
            ) : <p className="dk-muted tl-small">{tr('No templates yet.')}</p>}
            <form className="wac-new" onSubmit={create}>
              <h5>{tr('New template')}</h5>
              <div className="wac-row">
                <div className="field"><label htmlFor="wac-name">{tr('Name')}</label><input id="wac-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="order_ready" required /></div>
                <div className="field">
                  <label htmlFor="wac-cat">{tr('Kind')}</label>
                  <select id="wac-cat" className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                    <option value="UTILITY">{tr('Utility — orders, payments, appointments')}</option>
                    <option value="MARKETING">{tr('Marketing — offers and news')}</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="wac-lang">{tr('Language')}</label>
                  <select id="wac-lang" className="input" value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>
                    <option value="en">English</option>
                    <option value="en_US">English (US)</option>
                    <option value="fr">Français</option>
                    <option value="zh_CN">中文</option>
                  </select>
                </div>
              </div>
              <div className="field"><label htmlFor="wac-body">{tr('Message')}</label><textarea id="wac-body" className="input" rows={3} maxLength={1024} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder={tr('Hello {{1}}, your order {{2}} is ready for pickup at Bamboo Products.')} required /></div>
              {Array.from({ length: formBlanks }, (_, i) => (
                <div className="field" key={i}><label htmlFor={'wac-ex' + i}>{tr('Example for {n}', { n: '{{' + (i + 1) + '}}' })}</label><input id={'wac-ex' + i} className="input" value={form.examples[i] || ''} onChange={(e) => { const examples = [...form.examples]; examples[i] = e.target.value; setForm({ ...form, examples }); }} required /></div>
              ))}
              <div className="wac-acts"><button type="submit" className="btn btn-secondary" disabled={busy === 'create'}>{busy === 'create' ? tr('Sending to Meta…') : tr('Create and send to Meta for review')}</button></div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
