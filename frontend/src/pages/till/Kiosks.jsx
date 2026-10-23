import { useCallback, useEffect, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { tr } from '../../lib/i18n.jsx';
import { kioskUrl } from './customerScreenLink';
import './growth.css';

// The self-order kiosk from the till's side (More → Self-order kiosk;
// backend restaurantKiosk; the kiosk itself is pages/SelfOrderPage.jsx): a
// tablet at the counter opened at /self-order shows 6 numbers; typed here,
// it takes this restaurant's orders. What customers order on it waits in
// the till's inbox (K-0012), or goes straight to the kitchen, as the
// manager set it up (back office → Setup → Self-order kiosk).

export default function Kiosks({ token, onToast, onClose }) {
  const [data, setData] = useState(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const load = useCallback(() => posFetch('GET', '/pos/kiosks', token).then(setData).catch((e) => setError(e.message)), [token]);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  async function pair(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      setData(await posFetch('POST', '/pos/kiosks/pair', token, { code, name: name || tr('Kiosk') }));
      setCode(''); setName('');
      onToast(tr('The kiosk now takes this restaurant\'s orders.'));
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function unpair(k) {
    setBusy(true);
    try { setData(await posFetch('POST', '/pos/kiosks/' + k.id + '/unpair', token)); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const s = data && data.settings;
  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog pos-panel ko" role="dialog" aria-modal="true" aria-labelledby="ko-title" onClick={(e) => e.stopPropagation()}>
        <header className="bk-head">
          <span className="bk-ico is-kiosk" aria-hidden="true">🖥️</span>
          <div><h2 id="ko-title">{tr('Self-order kiosk')}</h2><p className="dk-muted">{tr('A tablet at the counter: customers order on it with photos, then pay at the counter or on the kiosk.')}</p></div>
        </header>
        {s && (
          <div className="ko-state">
            <span className={'ko-pill' + (s.on ? ' is-on' : '')}>{s.on ? tr('Taking orders') : tr('Not taking orders')}</span>
            <span className="ko-pill">{s.straightToKitchen ? tr('Straight to the kitchen') : tr('Waits for the till')}</span>
            <span className="ko-pill">{s.payHere && data.paystack ? tr('Pay on the kiosk or at the counter') : tr('Pay at the counter')}</span>
          </div>
        )}
        {s && !s.on && <p className="tl-pay-lock"><span>{tr('A manager turns the kiosk on in the back office: Setup → Self-order kiosk.')}</span></p>}
        <ol className="cs-steps">
          <li><b>1</b><span>{tr('On the tablet, open:')} <code>{kioskUrl()}</code></span></li>
          <li><b>2</b><span>{tr('It shows 6 numbers. Type them here:')}</span></li>
        </ol>
        <form className="cs-pair" onSubmit={pair}>
          <input className="input cs-code" inputMode="numeric" autoComplete="off" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" aria-label={tr('The code on the kiosk')} />
          <input className="input" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('Its name, e.g. By the door')} aria-label={tr('Name')} />
          <button type="submit" className="btn btn-primary" disabled={busy || code.length !== 6}>{tr('Pair the kiosk')}</button>
        </form>
        {error && <div className="error-banner">{error}</div>}
        {data && data.kiosks.length > 0 && (
          <ul className="cs-list is-plain">
            {data.kiosks.map((k) => (
              <li key={k.id}><i className={k.online ? 'is-on' : ''} aria-hidden="true" /><span><strong>{k.name}</strong><small>{k.online ? tr('On now') : tr('Not seen for a while: is it on?')}</small></span>
                <button type="button" className="pos-link is-bad" disabled={busy} onClick={() => unpair(k)}>{tr('Take off')}</button></li>
            ))}
          </ul>
        )}
        <div className="dialog-actions"><button type="button" className="btn btn-primary" onClick={onClose}>{tr('Done')}</button></div>
      </div>
    </div>
  );
}
