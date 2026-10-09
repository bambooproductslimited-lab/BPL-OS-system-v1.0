import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { Icon, Section, Status } from './DashKit';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import './WhatsAppConnect.css';

// Integrations → Facebook & Instagram messages: the setup check for the
// CRM inbox's Messenger chats and Instagram direct messages
// (backend/src/services/crmMeta.service.js check()). It asks Meta, step by
// step, whether the OS can read them, says which step is not right and how
// to put it right — "Connect with Facebook" where a new Page token is the
// answer, "Read messages now" to run the 3-minute read at once.

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
  app: () => tr('Meta accepts the app’s ID and secret'),
  page: () => tr('The company’s Facebook Page'),
  token: () => tr('The OS’s permission to read and answer messages (the Page token)'),
  messenger: () => tr('Messenger chats with the Page'),
  instagram: () => tr('Instagram direct messages'),
  review: () => tr('Who Meta lets write in (App Review)'),
  arriving: () => tr('Messages arriving in the CRM inbox')
};

function recent(d) {
  if (!d.seen) return tr('none yet');
  return (d.seen === 1 ? tr('1 recent chat') : tr('{n} recent chats', { n: d.seen })) + (d.latest ? ', ' + tr('the latest {when}', { when: ago(d.latest) }) : '');
}

function channelLine(label, c) {
  if (!c) return null;
  if (c.error) return tr('{channel}: the last read failed ({why}).', { channel: label, why: c.error });
  if (!c.lastReadAt) return tr('{channel}: not read yet.', { channel: label });
  return [tr('{channel}: read {when}', { channel: label, when: ago(c.lastReadAt) }),
    c.received === 1 ? tr('1 customer message kept') : tr('{n} customer messages kept', { n: c.received || 0 }),
    c.lastCustomerAt ? tr('the last {when}', { when: ago(c.lastCustomerAt) }) : null].filter(Boolean).join(' · ') + '.';
}

function stepText(st, steps) {
  const d = st.data || {};
  const pageMissing = steps.some((x) => x.key === 'page' && x.state === 'bad' && !x.error);
  switch (st.key) {
    case 'app':
      if (d.missing && d.missing.length) return tr('Missing on Render: {names}. Add them in Render → bamboo-os-backend → Environment, then deploy.', { names: d.missing.join(', ') });
      return st.state === 'ok' ? tr('Meta knows the app: {name}.', { name: d.name || '—' })
        : tr('Meta did not accept them ({why}). Copy the App ID and App secret again from Meta → App settings → Basic.', { why: st.error || '—' });
    case 'page':
      if (st.error) return tr('Meta did not answer for the Page ({why}). Connect with Facebook again.', { why: st.error });
      if (st.state !== 'ok') return tr('No Facebook Page is connected yet. Press “Connect with Facebook”, sign in as an admin of the company Page and choose it.');
      return d.instagram ? tr('{page}, with its Instagram account @{ig}.', { page: d.name || '—', ig: d.instagram })
        : tr('{page}. No Instagram account is linked to it.', { page: d.name || '—' });
    case 'token':
      if (st.state === 'skip') return pageMissing ? tr('Checked once a Page is connected.') : tr('Needs META_APP_ID and META_APP_SECRET.');
      if (st.error) return tr('Meta did not check it ({why}). Connect with Facebook again.', { why: st.error });
      if (!d.valid) return tr('It no longer works — usually because the Facebook password was changed or the person who connected is no longer an admin of the Page. Connect with Facebook again.');
      if ((d.lacking || []).length) return d.configId
        ? tr('It lacks {scopes}. Add them to the Facebook Login for Business configuration set on Render (META_PAGES_CONFIG_ID), then connect with Facebook again.', { scopes: d.lacking.join(', ') })
        : tr('It lacks {scopes}. Connect with Facebook again and leave every permission ticked in Meta’s window.', { scopes: d.lacking.join(', ') });
      return tr('Valid: the OS may read the chats and answer them.');
    case 'messenger':
      if (st.state === 'skip') return tr('Checked once a Page is connected.');
      if (st.error) return tr('Meta refused to show the Page’s chats ({why}). Connect with Facebook again and leave every permission ticked.', { why: st.error });
      return tr('The OS can read them: {recent}.', { recent: recent(d) });
    case 'instagram':
      if (st.state === 'skip') return tr('Checked once a Page is connected.');
      if (d.noAccount) return tr('No Instagram account is linked to the Page. In the Instagram app, switch the company account to a Professional account; then link it to the Page (Facebook Page → Settings → Linked accounts → Instagram) and connect with Facebook again.');
      if (d.notSaved) return tr('The Page’s Instagram account @{ig} is not connected in the OS yet. Connect with Facebook again: it comes with the Page.', { ig: d.username || '—' });
      if (st.error) return tr('Meta refused @{ig}’s direct messages ({why}). In the Instagram app: Settings → Messages and story replies → Message controls → Connected tools → turn on “Allow access to messages”, then check again.', { ig: d.username || '—', why: st.error });
      return tr('@{ig}: the OS can read them: {recent}.', { ig: d.username || '—', recent: recent(d) });
    case 'review':
      return tr('Until Meta’s App Review approves pages_messaging and instagram_manage_messages, Meta only passes on messages from people with a role on the app (Meta for Developers → App roles). Test with such an account; customers’ messages come in once Meta approves.');
    case 'arriving':
      if (st.state === 'wait') return tr('Nothing read yet. The OS reads every 3 minutes once the Page is connected; press “Read messages now” to read at once.');
      return null;
    default: return '';
  }
}

export default function MetaMessagesCheck({ onToast }) {
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const run = useCallback(async () => {
    setBusy('check'); setError(null);
    try { setRes(await api.get('/crm/meta-check')); } catch (err) { setError(err.message); } finally { setBusy(null); }
  }, []);
  useEffect(() => { run(); }, [run]);

  async function connect() {
    setBusy('connect'); setError(null);
    try {
      const { url } = await api.post('/marketing/oauth/meta/start', {});
      window.location.href = url;
    } catch (err) { setError(err.message); setBusy(null); }
  }
  async function readNow() {
    setBusy('sync'); setError(null);
    try {
      const out = await api.post('/crm/meta-sync');
      setRes(out);
      const s = out.synced || {};
      const n = ['facebook', 'instagram'].reduce((a, k) => a + ((s[k] && s[k].messages) || 0), 0);
      if (onToast) onToast(n ? (n === 1 ? tr('Read now: 1 new message.') : tr('Read now: {n} new messages.', { n })) : tr('Read now: nothing new.'));
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  if (!res && error && /role does not allow/i.test(error)) return null;
  const bad = res ? res.steps.filter((x) => x.state === 'bad').length : 0;
  const warn = res ? res.steps.filter((x) => x.state === 'warn').length : 0;
  return (
    <Section id="in-meta-messages" title={tr('Facebook & Instagram messages')} sub={tr('Customers’ Messenger chats with the company Page and the Instagram account’s direct messages land in the CRM inbox, next to WhatsApp and email. The OS reads them every 3 minutes with the Page connected under Accounts above. This check asks Meta whether each step is in place.')}>
      <div className="wac-card wac-check" id="meta-check">
        <div className="wac-check-head">
          <div>
            <h4>{tr('Check the setup')}</h4>
            <span className="dk-muted tl-small">{tr('Asks Meta whether the OS can read the Page’s chats and the Instagram direct messages.')}</span>
          </div>
          {res && <Status tone={bad ? 'bad' : warn ? 'warn' : 'good'}>{bad ? (bad === 1 ? tr('1 step to put right') : tr('{n} steps to put right', { n: bad })) : warn ? tr('Almost: see the step marked !') : tr('Everything is in place')}</Status>}
          <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={run}>{busy === 'check' ? tr('Checking…') : tr('Check again')}</button>
        </div>
        {error && <p className="wac-err"><Icon name="warn" /> {error}</p>}
        {!res ? <p className="eyebrow">{tr('Asking Meta…')}</p> : (
          <ol className="wac-check-list">
            {res.steps.map((st) => (
              <li key={st.key} className={'wac-step is-' + st.state}>
                <span className="wac-step-mark" aria-hidden="true">{st.state === 'ok' ? '✓' : st.state === 'bad' ? '✕' : st.state === 'warn' ? '!' : st.state === 'wait' ? '…' : st.state === 'info' ? 'i' : '–'}</span>
                <div className="wac-step-main">
                  <strong>{STEP_TITLE[st.key] ? STEP_TITLE[st.key]() : st.key}</strong>
                  {stepText(st, res.steps) && <span className="tl-small">{stepText(st, res.steps)}</span>}
                  {st.key === 'arriving' && st.state !== 'wait' && (
                    <span className="tl-small wac-lines">
                      <span>{channelLine('Messenger', st.data.facebook)}</span>
                      <span>{channelLine('Instagram', st.data.instagram)}</span>
                    </span>
                  )}
                  {st.fix === 'connect' && <button type="button" className="btn btn-primary wac-step-fix" disabled={!!busy} onClick={connect}>{busy === 'connect' ? tr('Redirecting…') : tr('Connect with Facebook')}</button>}
                  {st.fix === 'sync' && <button type="button" className="btn btn-secondary wac-step-fix" disabled={!!busy} onClick={readNow}>{busy === 'sync' ? tr('Reading…') : tr('Read messages now')}</button>}
                </div>
              </li>
            ))}
          </ol>
        )}
        {res && res.steps.some((x) => x.key === 'page' && x.state === 'ok') && !res.steps.some((x) => x.fix === 'connect') && (
          <p className="dk-muted tl-small wac-again">
            <button type="button" className="dk-link" disabled={!!busy} onClick={connect}>{busy === 'connect' ? tr('Redirecting…') : tr('Connect with Facebook again')}</button>
            {' '}{tr('— to give the OS new permissions, or to record the screencast for Meta’s App Review. The connection stays until Meta’s window is finished.')}
          </p>
        )}
        {res && <p className="dk-muted tl-small">{tr('Checked {when}.', { when: ago(res.checkedAt) })}</p>}
      </div>
    </Section>
  );
}
