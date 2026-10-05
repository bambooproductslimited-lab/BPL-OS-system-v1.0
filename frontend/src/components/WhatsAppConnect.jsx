import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { Icon, Section, Status, fmtDate } from './DashKit';
import { tr } from '../lib/i18n.jsx';
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
                <li>{tr('META_WA_CONFIG_ID: in Meta for Developers → BPL OS_ Tracker → Facebook Login for Business → Configurations → Create configuration, choose "WhatsApp Embedded Signup", then copy its Configuration ID.')}</li>
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
    </Section>
  );
}
