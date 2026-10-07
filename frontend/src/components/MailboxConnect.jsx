import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { Icon, Section, Status, fmtDate } from './DashKit';
import { tr, activeIntlLocale } from '../lib/i18n.jsx';
import './WhatsAppConnect.css';
import './MailboxConnect.css';

// Integrations → Email inbox: the sales mailbox the CRM inbox reads
// customers' emails from and replies from
// (backend/src/services/crmMailbox.service.js). The OS signs in both ways
// before keeping anything, so a wrong password or server is said here and
// then. The password is kept sealed on the server and never shown again;
// changing other settings of the same mailbox keeps it.

const PROVIDERS = ['gmail', 'hostinger', 'other'];
const BLANK = { provider: 'gmail', address: '', password: '', fromName: 'Bamboo Products', imapHost: '', imapPort: '993', smtpHost: '', smtpPort: '465', sent: '' };

function when(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(activeIntlLocale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function providerName(p) { return p === 'gmail' ? 'Gmail' : p === 'hostinger' ? tr('Hostinger email') : tr('Other email provider'); }

export default function MailboxConnect({ onToast }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(null);
  const [checked, setChecked] = useState(null); // { ok, text }

  const load = useCallback(async () => {
    try { setInfo(await api.get('/crm/mailbox')); } catch (err) { setError(err.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  function openForm() {
    const on = info && info.source === 'os';
    setForm(on ? {
      ...BLANK, provider: info.provider || 'other', address: info.address || '', fromName: info.fromName || 'Bamboo Products',
      imapHost: info.imapHost || '', smtpHost: info.smtpHost || '', sent: info.sent || ''
    } : { ...BLANK, address: info && info.source === 'render' ? info.address || '' : '' });
    setChecked(null); setError(null); setEditing(true);
  }
  const set = (k) => (e) => { setForm({ ...form, [k]: e.target.value }); setChecked(null); };
  const body = () => ({ ...form, sent: form.sent.trim() });
  const keepsPassword = info && info.source === 'os' && !info.broken && form.address.trim().toLowerCase() === info.address;

  async function testIt() {
    setBusy('test'); setChecked(null);
    try {
      const out = await api.post('/crm/mailbox/test', body());
      setChecked({ ok: true, text: out.sentFolder ? tr('Signed in to read and to send. Replies will be copied to “{folder}”.', { folder: out.sentFolder }) : tr('Signed in to read and to send. No sent-mail folder was found, so replies written in the OS won\'t show in the mail app\'s Sent.') });
    } catch (err) { setChecked({ ok: false, text: err.message }); } finally { setBusy(null); }
  }
  async function connect(e) {
    e.preventDefault();
    setBusy('connect'); setChecked(null);
    try {
      const out = await api.put('/crm/mailbox', body());
      setInfo(out); setEditing(false); setForm(BLANK);
      if (onToast) onToast(tr('{address} is connected. New emails are read every 3 minutes.', { address: out.address }));
    } catch (err) { setChecked({ ok: false, text: err.message }); } finally { setBusy(null); }
  }
  async function readNow() {
    setBusy('sync'); setError(null);
    try {
      const out = await api.post('/crm/mailbox/sync');
      setInfo(out.mailbox);
      if (out.error) setError(tr('Reading the mailbox failed: {why}', { why: out.error }));
      else if (onToast) onToast(out.notSetUp ? tr('No mailbox is set up yet.') : tr('{n} new emails brought in, {m} left out (newsletters, automatic mail, staff).', { n: out.kept, m: out.skipped }));
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }
  async function disconnect() {
    if (!window.confirm(tr('Disconnect {address} from the CRM inbox? Emails already brought in stay on the profiles; new ones stop coming in, and replies can\'t be sent from the OS.', { address: info.address }))) return;
    setBusy('off'); setError(null);
    try { setInfo(await api.del('/crm/mailbox')); if (onToast) onToast(tr('The mailbox was disconnected.')); } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  if (!info) return error ? <Section id="in-email" title={tr('Email inbox')}><div className="error-banner">{error}</div></Section> : null;
  const on = info.source === 'os' && !info.broken;
  const showForm = editing || !on;

  return (
    <Section id="in-email" title={tr('Email inbox')} sub={tr('Connect the sales mailbox, so customers\' emails land in the CRM inbox on their profiles, and replies written there go out from that mailbox.')}>
      {error && <div className="error-banner" role="alert">{error}</div>}

      <div className="mbx-grid">
        <div className="mbx-main">
          {on && (
            <div className="wac-card is-on">
              <div className="wac-head">
                <span className="wac-icon"><Icon name="mail" /></span>
                <div className="wac-who">
                  <strong>{info.address}</strong>
                  <span className="dk-muted tl-small">{providerName(info.provider)}</span>
                </div>
                <Status tone={info.lastError ? 'warn' : 'good'}>{info.lastError ? tr('Connected — last read failed') : tr('Connected')}</Status>
              </div>
              <dl className="wac-facts">
                <div><dt>{tr('Last read')}</dt><dd>{info.lastOkAt ? when(info.lastOkAt) : tr('Not yet — within 3 minutes')}</dd></div>
                <div><dt>{tr('Emails brought in')}</dt><dd>{info.items}</dd></div>
                <div><dt>{tr('Reading from')}</dt><dd>{info.imapHost} · {info.inbox}</dd></div>
                <div><dt>{tr('Replies go out through')}</dt><dd>{info.smtpHost}</dd></div>
                <div><dt>{tr('Copy of replies kept in')}</dt><dd>{info.provider === 'gmail' ? tr('Gmail\'s Sent (Gmail keeps it by itself)') : info.sent || tr('Nowhere — no sent-mail folder found')}</dd></div>
                <div><dt>{tr('Connected')}</dt><dd>{fmtDate(info.connectedAt)}{info.connectedByName ? ' · ' + info.connectedByName : ''}</dd></div>
              </dl>
              {info.lastError && <p className="wac-err"><Icon name="warn" /> {tr('The last read failed: {why}', { why: info.lastError })}</p>}
              <div className="wac-acts">
                <button type="button" className="btn btn-primary" disabled={!!busy} onClick={readNow}><Icon name="mail" /> {busy === 'sync' ? tr('Reading…') : tr('Read new mail now')}</button>
                <Link className="btn btn-secondary" to="/crminbox">{tr('Open the inbox')}</Link>
                {!editing && <button type="button" className="dk-link" disabled={!!busy} onClick={openForm}>{tr('Change settings or password')}</button>}
                <button type="button" className="dk-link" disabled={!!busy} onClick={disconnect}>{tr('Disconnect')}</button>
              </div>
            </div>
          )}

          {info.broken && <p className="wac-err mbx-banner"><Icon name="warn" /> {tr('The saved password for {address} can no longer be opened (the server\'s secret key was changed). Enter the password again to keep reading and replying.', { address: info.address })}</p>}
          {info.source === 'render' && (
            <div className="wac-card">
              <p className="wac-note"><Icon name="info" /> {tr('The OS is reading {address} with the settings on Render. Connecting a mailbox here replaces them, and the password no longer needs to be on Render.', { address: info.address })}</p>
              <div className="wac-acts">
                <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={readNow}>{busy === 'sync' ? tr('Reading…') : tr('Read new mail now')}</button>
                <span className="dk-muted tl-small">{tr('Last read: {when} · {n} emails brought in', { when: when(info.lastOkAt), n: info.items })}</span>
              </div>
            </div>
          )}

          {showForm && (
            <form className="wac-card mbx-form" onSubmit={connect} autoComplete="off">
              <div className="wac-tool-head">
                <h4>{on ? tr('Change the mailbox settings') : tr('Connect a mailbox')}</h4>
                <span className="dk-muted tl-small">{tr('The OS signs in to read and to send before keeping anything, so a wrong password is said straight away.')}</span>
              </div>

              <div className="mbx-providers" role="radiogroup" aria-label={tr('Email provider')}>
                {PROVIDERS.map((key) => (
                  <button key={key} type="button" role="radio" aria-checked={form.provider === key} className={'mbx-provider' + (form.provider === key ? ' is-on' : '')} onClick={() => { setForm({ ...form, provider: key }); setChecked(null); }}>
                    <strong>{key === 'gmail' ? 'Gmail / Google Workspace' : providerName(key)}</strong>
                    <span className="dk-muted tl-small">{key === 'gmail' ? tr('Sign in with an app password') : key === 'hostinger' ? tr('Mailboxes made in hPanel') : tr('Any mailbox with IMAP and SMTP')}</span>
                  </button>
                ))}
              </div>

              <div className="wac-row">
                <div className="field"><label htmlFor="mbx-address">{tr('Email address')}</label><input id="mbx-address" className="input" type="email" value={form.address} onChange={set('address')} placeholder="sales@example.com" required autoComplete="off" /></div>
                <div className="field">
                  <label htmlFor="mbx-pass">{form.provider === 'gmail' ? tr('App password') : tr('Password')}</label>
                  <input id="mbx-pass" className="input" type="password" value={form.password} onChange={set('password')} required={!keepsPassword} autoComplete="new-password"
                    placeholder={keepsPassword ? tr('Leave empty to keep the saved one') : form.provider === 'gmail' ? 'abcd efgh ijkl mnop' : ''} />
                </div>
              </div>
              {form.provider === 'gmail' && (
                <ol className="wac-steps mbx-help">
                  <li>{tr('Gmail needs an app password, not the normal one. In the Google account of this mailbox: Security → 2-Step Verification (turn it on if it is off).')}</li>
                  <li>{tr('At the bottom of that page, App passwords: name it “Bamboo OS” and press Create.')}</li>
                  <li>{tr('Copy the 16 letters it shows into the box above. Google shows them once.')}</li>
                </ol>
              )}
              {form.provider === 'hostinger' && <p className="wac-note"><Icon name="info" /> {tr('Use the mailbox\'s own password. Forgotten it? Set a new one in hPanel → Emails → this mailbox → Change password (the mail app on phones then needs the new one too).')}</p>}

              {form.provider === 'other' && (
                <div className="wac-row mbx-servers">
                  <div className="field"><label htmlFor="mbx-ih">{tr('Reading server (IMAP)')}</label><input id="mbx-ih" className="input" value={form.imapHost} onChange={set('imapHost')} placeholder="imap.example.com" required /></div>
                  <div className="field mbx-port"><label htmlFor="mbx-ip">{tr('Port')}</label><input id="mbx-ip" className="input" inputMode="numeric" value={form.imapPort} onChange={set('imapPort')} /></div>
                  <div className="field"><label htmlFor="mbx-sh">{tr('Sending server (SMTP)')}</label><input id="mbx-sh" className="input" value={form.smtpHost} onChange={set('smtpHost')} placeholder="smtp.example.com" required /></div>
                  <div className="field mbx-port"><label htmlFor="mbx-sp">{tr('Port')}</label><input id="mbx-sp" className="input" inputMode="numeric" value={form.smtpPort} onChange={set('smtpPort')} /></div>
                </div>
              )}

              <details className="mbx-more">
                <summary>{tr('More settings')}</summary>
                <div className="wac-row">
                  <div className="field"><label htmlFor="mbx-from">{tr('Name replies come from')}</label><input id="mbx-from" className="input" value={form.fromName} onChange={set('fromName')} maxLength={80} /></div>
                  <div className="field"><label htmlFor="mbx-sent">{tr('Sent-mail folder')}</label><input id="mbx-sent" className="input" value={form.sent} onChange={set('sent')} placeholder={tr('Found by itself')} /></div>
                </div>
                <p className="dk-muted tl-small">{tr('Each reply is signed with the name of the person who wrote it, followed by this name.')}</p>
              </details>

              {checked && <p className={checked.ok ? 'wac-ok mbx-checked' : 'wac-err'} role="status"><Icon name={checked.ok ? 'check' : 'warn'} /> {checked.text}</p>}
              <div className="wac-acts">
                <button type="submit" className="btn btn-primary" disabled={!!busy}><Icon name="mail" /> {busy === 'connect' ? tr('Signing in…') : on ? tr('Save') : tr('Connect')}</button>
                <button type="button" className="btn btn-secondary" disabled={!!busy || !form.address || (!form.password && !keepsPassword)} onClick={testIt}>{busy === 'test' ? tr('Checking…') : tr('Test the connection')}</button>
                {on && <button type="button" className="dk-link" onClick={() => { setEditing(false); setChecked(null); }}>{tr('Cancel')}</button>}
              </div>
            </form>
          )}
        </div>

        <aside className="wac-card mbx-what">
          <h4>{tr('What lands in the inbox')}</h4>
          <ul className="mbx-list">
            <li className="is-yes"><Icon name="check" /> <span>{tr('Emails from customers, one conversation per email thread, on the customer\'s profile — a new profile is made for someone new.')}</span></li>
            <li className="is-yes"><Icon name="check" /> <span>{tr('Only the new words of each email, not the earlier emails quoted under them.')}</span></li>
            <li className="is-yes"><Icon name="check" /> <span>{tr('Replies written in the mail app, read back from the sent-mail folder, so the conversation is complete.')}</span></li>
            <li className="is-no"><Icon name="void" /> <span>{tr('Not newsletters, mailing lists, automatic notices, or mail between staff.')}</span></li>
          </ul>
          <h4>{tr('When')}</h4>
          <p className="tl-small">{tr('The first read goes back 30 days. After that, new mail is read every 3 minutes, or at once with “Read new mail now”.')}</p>
          <h4>{tr('Replies')}</h4>
          <p className="tl-small">{tr('A reply written in the CRM inbox goes out from this mailbox, in the same email thread, and a copy is put in its sent-mail folder so it shows in the mail app too.')}</p>
        </aside>
      </div>
    </Section>
  );
}
