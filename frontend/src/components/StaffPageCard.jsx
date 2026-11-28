import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { tr, activeIntlLocale } from '../lib/i18n.jsx';
import './StaffPageCard.css';

// People → the staff page (pages/StaffPage.jsx, backend staffPage.service.js),
// for HR (employee.write): the link to send everyone, who can sign in (a
// phone number on their record) and who can't yet, numbers two people
// share, who is signed in — and signing someone out (a lost phone).

function ago(ts) {
  if (!ts) return '';
  const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 2) return tr('just now');
  if (mins < 60) return tr('{n} min ago', { n: mins });
  const h = Math.round(mins / 60);
  if (h < 24) return tr('{n} h ago', { n: h });
  return new Date(ts).toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' });
}

export default function StaffPageCard({ onOpen }) {
  const [o, setO] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(null); // 'nophone' | 'signedin'
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(null);
  const link = window.location.origin + '/staff';
  const load = useCallback(() => api.get('/staff-page').then((x) => { setO(x); setErr(null); }).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  async function copy() {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { window.prompt(tr('Copy this link:'), link); }
  }
  async function signOut(p) {
    if (!window.confirm(tr('Sign {name} out of the staff page on every phone? They can sign in again with a new code.', { name: p.name }))) return;
    setBusy(p.id);
    try { await api.post('/staff-page/' + p.id + '/sign-out', {}); await load(); } catch (e) { setErr(e.message); }
    setBusy(null);
  }
  const c = o ? o.counts : null;
  return (
    <section className="spc" aria-labelledby="spc-title">
      <div className="spc-top">
        <span className="spc-ico" aria-hidden="true">📱</span>
        <div className="spc-text">
          <strong id="spc-title">{tr('My Info: the staff page')}</strong>
          <small>{tr('Every employee sees their own attendance, leave, work orders and payslips on their phone, and can ask for leave. They sign in with the phone number on their record and a code sent by text message: no account or password. Payslips show once payroll approves a run, and not on a number two people share.')}</small>
          {c && (
            <span className="spc-stats">
              <b>{tr('{n} of {total} can sign in', { n: c.withPhone, total: c.active })}</b>
              <span>{c.signedIn === 1 ? tr('1 signed in') : tr('{n} signed in', { n: c.signedIn })}</span>
              {c.noPhone > 0 && <span className="is-warn">{c.noPhone === 1 ? tr('1 has no phone number') : tr('{n} have no phone number', { n: c.noPhone })}</span>}
            </span>
          )}
          {o && !o.smsReady && <span className="spc-warn" role="alert">{tr('Text messages are not set up, so no codes can be sent yet: Company settings → Text messages.')}</span>}
          {err && <span className="spc-warn" role="alert">{err}</span>}
        </div>
        <div className="spc-acts">
          <a className="btn btn-primary" href="/staff" target="_blank" rel="noreferrer">{tr('Open the staff page')}</a>
          <button type="button" className="btn btn-secondary" onClick={copy}>{copied ? '✓ ' + tr('Copied') : tr('Copy the link')}</button>
        </div>
      </div>
      {o && (
        <div className="spc-tabs">
          {o.noPhone.length > 0 && <button type="button" className={open === 'nophone' ? 'is-on' : ''} aria-expanded={open === 'nophone'} onClick={() => setOpen(open === 'nophone' ? null : 'nophone')}>{tr('No phone number ({n})', { n: o.noPhone.length })}</button>}
          {o.signedIn.length > 0 && <button type="button" className={open === 'signedin' ? 'is-on' : ''} aria-expanded={open === 'signedin'} onClick={() => setOpen(open === 'signedin' ? null : 'signedin')}>{tr('Signed in ({n})', { n: o.signedIn.length })}</button>}
          {o.shared.length > 0 && <button type="button" className={open === 'shared' ? 'is-on' : ''} aria-expanded={open === 'shared'} onClick={() => setOpen(open === 'shared' ? null : 'shared')}>{tr('Shared numbers ({n})', { n: o.shared.length })}</button>}
        </div>
      )}
      {o && open === 'nophone' && (
        <div className="spc-list">
          <p className="spc-hint">{tr('They can\'t sign in until their phone number is on their record. Press a name to open it.')}</p>
          <ul>
            {o.noPhone.map((p) => (
              <li key={p.id}><button type="button" className="spc-name" onClick={() => onOpen && onOpen(p.id)}>{p.name}</button><span>{[p.position, p.department].filter(Boolean).join(' · ')}</span></li>
            ))}
          </ul>
        </div>
      )}
      {o && open === 'signedin' && (
        <div className="spc-list">
          <ul>
            {o.signedIn.map((p) => (
              <li key={p.id}>
                <button type="button" className="spc-name" onClick={() => onOpen && onOpen(p.id)}>{p.name}</button>
                <span>{tr('last seen {when}', { when: ago(p.lastSeen) })}{p.phones > 1 ? ' · ' + tr('{n} phones', { n: p.phones }) : ''}</span>
                <button type="button" className="spc-out" disabled={busy === p.id} onClick={() => signOut(p)}>{tr('Sign out')}</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {o && open === 'shared' && (
        <div className="spc-list">
          <p className="spc-hint">{tr('These people have the same number on their record: after the code, they choose their name.')}</p>
          <ul>{o.shared.map((s) => <li key={s.phone}><b>{s.phone}</b><span>{s.people.join(', ')}</span></li>)}</ul>
        </div>
      )}
    </section>
  );
}
