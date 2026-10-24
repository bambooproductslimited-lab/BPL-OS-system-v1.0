import { useState } from 'react';
import { createPortal } from 'react-dom';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import { payName } from '../delivery/dlShared';
import './tenth.css';

// Curbside pickup on the till (backend restaurantOnline curbside/brought):
// a website customer outside for their pickup says so on their order's
// page, with a word about their car. The pill at the top says how many are
// waiting outside; its list says who, where, for how long, whether the
// kitchen has it ready and how they pay; "Brought out" when it is in their hands.

function hhmm(iso) { return new Date(iso).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' }); }

// The pill at the top while somebody is outside.
export function CurbsidePill({ outside, onClick }) {
  if (!outside || !outside.length) return null;
  const longest = Math.max(...outside.map((o) => o.waitedMinutes));
  return (
    <button type="button" className={'pos-stat cbs-pill' + (longest >= 5 ? ' is-long' : '')} onClick={onClick}>
      <span className="pos-stat-ico" aria-hidden="true">🚗</span>
      <span className="pos-stat-text">
        <small>{tr('Outside for pickup')}</small>
        <strong>{outside.length === 1 ? outside[0].name : tr('{n} waiting', { n: outside.length })}{longest > 0 ? ' · ' + tr('{n} min', { n: longest }) : ''}</strong>
      </span>
    </button>
  );
}

export default function Curbside({ token, outside, onClose, onChanged, onToast }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  async function brought(o) {
    setBusy(o.id); setError(null);
    try {
      const r = await posFetch('POST', '/pos/curbside/' + o.id + '/brought', token);
      onChanged(r.outside);
      onToast(tr('{ref} brought out to {name}.', { ref: o.ref, name: o.name }));
      if (!r.outside.length) onClose();
    } catch (e) { setError(e.message); } finally { setBusy(null); }
  }
  return createPortal(
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog cbs-dlg" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="cbs-title">
        <div className="cbs-head">
          <span className="cbs-car" aria-hidden="true">🚗</span>
          <div><h2 id="cbs-title">{tr('Outside for pickup')}</h2><p className="dk-muted">{tr('Website customers waiting outside. Take it out to them, then tap Brought out.')}</p></div>
        </div>
        {!outside.length ? <p className="dk-muted">{tr('Nobody is waiting outside.')}</p> : (
          <ul className="cbs-list">
            {outside.map((o, i) => (
              <li key={o.id} className={o.waitedMinutes >= 5 ? 'is-long' : ''} style={{ '--i': i }}>
                <div className="cbs-who">
                  <strong>{o.name}</strong>
                  <small>{o.ref} · {money(o.total)} · {payName(o.payMethod)}</small>
                </div>
                <span className={'cbs-ready' + (o.ready ? ' is-ready' : '')}>{o.ready ? '✅ ' + tr('Ready') : '🔥 ' + tr('Still cooking')}</span>
                {o.note && <p className="cbs-note">🚙 “{o.note}”</p>}
                <div className="cbs-foot">
                  <span className="cbs-wait">⏱ {o.waitedMinutes > 0 ? tr('Waiting {n} min · since {time}', { n: o.waitedMinutes, time: hhmm(o.hereAt) }) : tr('Just arrived')}</span>
                  {o.phone && <a className="btn btn-secondary" href={'tel:' + o.phone}>📞 {tr('Call')}</a>}
                  <button type="button" className="btn btn-primary" disabled={busy === o.id} onClick={() => brought(o)}>🛍️ {tr('Brought out')}</button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button></div>
      </div>
    </div>,
    document.body
  );
}
