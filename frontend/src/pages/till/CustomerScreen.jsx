import { useState } from 'react';
import { displayUrl } from './customerScreenLink';
import { posFetch } from '../../lib/posApi';
import { tr } from '../../lib/i18n.jsx';

// The screen that faces the customer, from the till's side (backend
// restaurantDisplays; the screen itself is pages/CustomerDisplay.jsx): a
// tablet or second monitor showing /display (on the till's own website) or
// /customer-display (in the OS) shows a code; typed here, it shows this
// till — this browser, by a device id kept on it. useCustomerDisplay sends
// it the order as it stands, and reads back the tip the customer taps.

export default function CustomerScreen({ token, device, displays, onChanged, onToast, onClose }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function pair(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await posFetch('POST', '/pos/displays/pair', token, { code, device, name: name || tr('Customer screen') });
      setCode(''); setName('');
      onToast(tr('The customer screen now shows this till.'));
      onChanged();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function unpair(d) {
    setBusy(true);
    try { await posFetch('POST', '/pos/displays/' + d.id + '/unpair', token); onChanged(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog pos-panel cs" role="dialog" aria-modal="true" aria-labelledby="cs-title" onClick={(e) => e.stopPropagation()}>
        <header className="bk-head">
          <span className="bk-ico is-screen" aria-hidden="true">🖥️</span>
          <div><h2 id="cs-title">{tr('Customer screen')}</h2><p className="dk-muted">{tr('A tablet or a second screen facing the customer: the order as you ring it up, the total, a tip to tap and a thank-you.')}</p></div>
        </header>
        <ol className="cs-steps">
          <li><b>1</b><span>{tr('On the customer\'s tablet, open:')} <code>{displayUrl()}</code></span></li>
          <li><b>2</b><span>{tr('It shows 6 numbers. Type them here:')}</span></li>
        </ol>
        <form className="cs-pair" onSubmit={pair}>
          <input className="input cs-code" inputMode="numeric" autoComplete="off" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" aria-label={tr('The code on the screen')} />
          <input className="input" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('Its name, e.g. Counter')} aria-label={tr('Name')} />
          <button type="submit" className="btn btn-primary" disabled={busy || code.length !== 6}>{tr('Show this till')}</button>
        </form>
        {error && <div className="error-banner">{error}</div>}
        {displays.length > 0 && (
          <ul className="cs-list is-plain">
            {displays.map((d) => (
              <li key={d.id}><i className={d.online ? 'is-on' : ''} aria-hidden="true" /><span><strong>{d.name}</strong><small>{d.online ? tr('Showing this till now') : tr('Not seen for a while: is it on?')}</small></span>
                <button type="button" className="pos-link is-bad" disabled={busy} onClick={() => unpair(d)}>{tr('Take off')}</button></li>
            ))}
          </ul>
        )}
        <div className="dialog-actions"><button type="button" className="btn btn-primary" onClick={onClose}>{tr('Done')}</button></div>
      </div>
    </div>
  );
}
