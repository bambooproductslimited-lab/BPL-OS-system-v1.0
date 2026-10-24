import { useState } from 'react';
import { tr } from '../lib/i18n.jsx';
import { portalCall } from '../lib/portal';
import '../pages/ShopPage.css';
import '../pages/PortalPage.css';

// Making an account on Bamboo Products' website (backend portal.service.js
// signup): a name and an email or phone; a six-digit code goes to the email
// (else the phone), and typing it back makes the account and signs in. On
// the account page, and on an order's page for an account asked for at
// checkout (`initial` filled in, `compact`).
export default function MakeAccount({ initial, onIn, compact }) {
  const [f, setF] = useState({ name: '', email: '', phone: '', ...(initial || {}) });
  const [sent, setSent] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function ask(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { setSent(await portalCall('POST', '/portal/signup', f)); setCode(''); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function enter(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { const r = await portalCall('POST', '/portal/login', { address: sent.address, code }); onIn(r.token); } catch (err) { setError(err.message); setBusy(false); }
  }
  if (sent) {
    return (
      <form className="ptl-form" onSubmit={enter}>
        <p className="ptl-sent">{sent.kind === 'phone' ? '💬 ' : '✉️ '}{tr('A code is on its way to {to}. It works for {n} minutes.', { to: sent.to, n: sent.minutes })}</p>
        <label className="shp-field"><span>{tr('The six-digit code')}</span>
          <input className="input ptl-code" required inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="••••••" /></label>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <button type="submit" className="shp-go is-big" disabled={busy || code.length !== 6}>{busy ? tr('One moment…') : tr('Make my account')}</button>
        <button type="button" className="shp-link ptl-again" onClick={() => { setSent(null); setError(null); }}>{tr('Change my details, or send it again')}</button>
      </form>
    );
  }
  return (
    <form className={'ptl-form' + (compact ? ' is-compact' : '')} onSubmit={ask}>
      <label className="shp-field"><span>{tr('Your name')}</span>
        <input className="input" required maxLength={120} autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <div className={compact ? 'shp-two' : 'ptl-two'}>
        <label className="shp-field"><span>{tr('Email')}</span>
          <input className="input" type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="ama@example.com" /></label>
        <label className="shp-field"><span>{tr('Phone number')}</span>
          <input className="input" type="tel" inputMode="tel" autoComplete="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="024 000 0000" /></label>
      </div>
      <p className="ptl-note">🔒 {tr('We send a code to your email (or your phone, without one). No password to remember.')}</p>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <button type="submit" className="shp-go is-big" disabled={busy || f.name.trim().length < 2 || (!f.email.trim() && f.phone.trim().length < 9)}>{busy ? tr('One moment…') : tr('Send me a code')}</button>
    </form>
  );
}
