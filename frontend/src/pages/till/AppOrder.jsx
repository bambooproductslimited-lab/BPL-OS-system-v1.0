import { useState } from 'react';
import { money } from '../../lib/currency';
import { tr } from '../../lib/i18n.jsx';
import { r2 } from './tillBill';
import './growth.css';

// Orders from delivery apps on the till (More → Delivery-app order; backend
// restaurantApps): the cashier picks the app whose tablet rang, types the
// app's order code and the customer's name, and rings the dishes up as
// usual — at the app's prices (the menu's with the app's markup, if the
// restaurant charges more there). It is paid on the app, so nothing goes in
// the drawer; to the kitchen with the app's name; handed to the app's rider.

const LOOK = { bolt: ['#34d399', '#059669', '🟢'], glovo: ['#fde047', '#f59e0b', '🟡'] };
function lookOf(key) { return LOOK[key] || ['#a5b4fc', '#6366f1', '🛵']; }

export function AppPicker({ apps, current, onPick, onClose }) {
  const on = apps.filter((a) => a.on);
  const [key, setKey] = useState(current ? current.key : on.length === 1 ? on[0].key : '');
  const [ref, setRef] = useState(current ? current.ref : '');
  const [customer, setCustomer] = useState(current ? current.customer : '');
  const app = on.find((a) => a.key === key);
  function go(e) {
    e.preventDefault();
    if (!app || ref.trim().replace(/^#/, '').length < 2) return;
    onPick({ key: app.key, name: app.name, markup: Number(app.markup) || 0, commission: Number(app.commission) || 0, ref: ref.trim().replace(/^#/, '').toUpperCase(), customer: customer.trim() });
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog pos-panel ao" role="dialog" aria-modal="true" aria-labelledby="ao-title" onClick={(e) => e.stopPropagation()} onSubmit={go}>
        <header className="bk-head">
          <span className="bk-ico is-app" aria-hidden="true">🛵</span>
          <div><h2 id="ao-title">{tr('An order from a delivery app')}</h2><p className="dk-muted">{tr('Ring it up as the app shows it: paid on the app, to the kitchen with its name, handed to its rider.')}</p></div>
        </header>
        {on.length === 0 ? (
          <p className="tl-pay-lock"><span>{tr('No delivery app is turned on. A manager turns them on in the back office: Setup → Delivery apps.')}</span></p>
        ) : (
          <>
            <div className="ao-apps" role="radiogroup" aria-label={tr('Which app')}>
              {on.map((a) => {
                const [c1, c2, dot] = lookOf(a.key);
                return (
                  <button key={a.key} type="button" role="radio" aria-checked={key === a.key} className={'ao-app' + (key === a.key ? ' is-on' : '')} style={{ '--ao-a': c1, '--ao-b': c2 }} onClick={() => setKey(a.key)}>
                    <span className="ao-app-dot" aria-hidden="true">{dot}</span>
                    <strong>{a.name}</strong>
                    <small>{a.markup ? tr('Prices +{n}%', { n: a.markup }) : tr('Menu prices')} · {tr('keeps {n}%', { n: a.commission })}</small>
                  </button>
                );
              })}
            </div>
            <div className="bk-grid">
              <label className="field"><span>{tr('The app\'s order code')}</span>
                <input className="input ao-ref" required autoFocus autoComplete="off" maxLength={30} value={ref} onChange={(e) => setRef(e.target.value)} placeholder={tr('e.g. #4471')} /></label>
              <label className="field"><span>{tr('Customer\'s name (optional)')}</span>
                <input className="input" maxLength={60} value={customer} onChange={(e) => setCustomer(e.target.value)} /></label>
            </div>
          </>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          {on.length > 0 && <button type="submit" className="btn btn-primary" disabled={!app || ref.trim().replace(/^#/, '').length < 2}>{current ? tr('Save') : tr('Start the order')}</button>}
        </div>
      </form>
    </div>
  );
}

// Above the order while it is an app's: which app, its code, its prices.
export function AppBanner({ app, total, onChange, onCancel }) {
  const [c1, c2, dot] = lookOf(app.key);
  return (
    <div className="ao-banner" style={{ '--ao-a': c1, '--ao-b': c2 }}>
      <span className="ao-app-dot" aria-hidden="true">{dot}</span>
      <div>
        <strong>{app.name} #{app.ref}{app.customer ? ' · ' + app.customer : ''}</strong>
        <small>{app.markup ? tr('The app\'s prices: the menu\'s +{n}%.', { n: app.markup }) + ' ' : ''}{tr('Paid on the app: it keeps {n}%, about {amount}.', { n: app.commission, amount: money(r2(total * app.commission / 100)) })}</small>
      </div>
      <button type="button" className="pos-link" onClick={onChange}>{tr('Change')}</button>
      <button type="button" className="pos-line-x" onClick={onCancel} aria-label={tr('Not an app order')}>×</button>
    </div>
  );
}
