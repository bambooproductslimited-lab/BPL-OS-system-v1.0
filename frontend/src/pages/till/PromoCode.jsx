import { useState } from 'react';
import { createPortal } from 'react-dom';
import { tr } from '../../lib/i18n.jsx';
import { codeOf, isOpen } from './promos';
import './sixth.css';

// A promo code typed for a deal (backend restaurantPromos): on the till,
// checked against the till's own deals; on the kiosk and the website,
// looked up with the restaurant (lookup: code → the deal, or fails). The
// bill then takes the deal if it is the best one; the server checks again.
// Drawn on the page itself, not inside the website's checkout form (a form
// in a form would send the order).
export default function PromoCodeDialog({ promotions, channel, current, lookup, onApply, onClose }) {
  const [code, setCode] = useState(current || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function apply(e) {
    e.preventDefault();
    e.stopPropagation();
    const c = codeOf(code);
    if (!c) return;
    setError(null);
    const here = (promotions || []).find((p) => p.code === c && isOpen(p, { channel, code: c }));
    if (here) { onApply(c, here); return; }
    if (!lookup) { setError(tr('That promo code is not right, or not on now.')); return; }
    setBusy(true);
    try { onApply(c, await lookup(c)); }
    catch (err) { setError(err.status === 404 || err.status === 400 ? tr('That promo code is not right, or not on now.') : err.message); }
    finally { setBusy(false); }
  }
  return createPortal(
    <div className="dialog-backdrop pq-back" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <form className="dialog pq" onClick={(e) => e.stopPropagation()} onSubmit={apply}>
        <span className="pq-art" aria-hidden="true">🎟️</span>
        <h2>{tr('Promo code')}</h2>
        <p className="dk-muted">{tr('Type the code from the voucher, the text or the poster.')}</p>
        <input className="input pq-input" autoFocus autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={24} value={code}
          onChange={(e) => { setCode(e.target.value.toUpperCase()); setError(null); }} placeholder="WELCOME15" aria-label={tr('Promo code')} />
        {error && <div className="error-banner">{error}</div>}
        <div className="dialog-actions">
          {current && <button type="button" className="pos-link is-bad pq-remove" onClick={() => onApply(null)}>{tr('Take the code off')}</button>}
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !codeOf(code)}>{busy ? tr('Checking…') : tr('Use the code')}</button>
        </div>
      </form>
    </div>,
    document.body
  );
}
