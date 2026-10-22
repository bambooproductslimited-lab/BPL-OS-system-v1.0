import { money } from '../../lib/currency';
import { tr } from '../../lib/i18n.jsx';
import { FULFILLMENT, FulfillmentIcon, fulfillmentName } from './tillShared';
import { billOf, serviceWords } from './tillBill';

// The bill's rules in the till settings (TillSettings.jsx, "Discounts,
// service and tax"; backend restaurantTillAccess cleanSettings): the
// manager's ready-made discounts (anyone on the till may give an "anyone"
// one; the others need the discount right or a manager's PIN), the
// service charge and on which orders, and the taxes — included in the
// menu's prices or added on top, a compound one charged on those above it.
// A worked example shows what a 100 cedi dine-in bill comes to.

function newId() { return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'd-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

export default function BillSettings({ draft, set }) {
  const discounts = draft.discounts || [];
  const sc = draft.serviceCharge || { on: false, rate: 10, types: {}, taxed: true, name: '' };
  const tax = draft.tax || { included: true, list: [] };
  const example = billOf([{ price: 100, qty: 1 }], {}, draft, 'dine_in');
  function setDiscount(i, patch) { set(['discounts'], discounts.map((d, j) => (j === i ? { ...d, ...patch } : d))); }
  function setTax(i, patch) { set(['tax', 'list'], tax.list.map((t, j) => (j === i ? { ...t, ...patch } : t))); }
  return (
    <section className="ts-sec ts-bill">
      <div className="ts-bill-block">
        <h3><span aria-hidden="true">%</span>{tr('Ready-made discounts')}</h3>
        <p className="dk-muted">{tr('The till shows them first. "Anyone" lets every cashier and waiter give it; the others need the right to give discounts, or a manager\'s PIN.')}</p>
        {discounts.length > 0 && (
          <ul className="ts-bill-rows is-plain">
            {discounts.map((d, i) => (
              <li key={d.id || i}>
                <input className="input" maxLength={40} value={d.name} onChange={(e) => setDiscount(i, { name: e.target.value })} placeholder={tr('e.g. Staff meal')} aria-label={tr('Name')} />
                <div className="dk-segment" role="radiogroup" aria-label={tr('Kind of discount')}>
                  <button type="button" role="radio" aria-checked={d.kind === 'percent'} className={d.kind === 'percent' ? 'is-on' : ''} onClick={() => setDiscount(i, { kind: 'percent' })}>%</button>
                  <button type="button" role="radio" aria-checked={d.kind === 'amount'} className={d.kind === 'amount' ? 'is-on' : ''} onClick={() => setDiscount(i, { kind: 'amount' })}>GHS</button>
                </div>
                <input className="input ts-bill-num" type="number" min="0" step="0.01" value={d.value} onChange={(e) => setDiscount(i, { value: e.target.value })} aria-label={tr('How much off')} />
                <label className="ts-bill-check"><input type="checkbox" checked={!!d.open} onChange={(e) => setDiscount(i, { open: e.target.checked })} />{tr('Anyone')}</label>
                <button type="button" className="pos-line-x" onClick={() => set(['discounts'], discounts.filter((_, j) => j !== i))} aria-label={tr('Remove')}>×</button>
              </li>
            ))}
          </ul>
        )}
        <button type="button" className="btn btn-secondary tl-btn" onClick={() => set(['discounts'], discounts.concat([{ id: newId(), name: '', kind: 'percent', value: 10, open: false }]))}>+ {tr('A discount')}</button>
      </div>

      <div className="ts-bill-block">
        <h3><span aria-hidden="true">🛎</span>{tr('Service charge')}</h3>
        <button type="button" role="switch" aria-checked={!!sc.on} className="ts-toggle-row" onClick={() => set(['serviceCharge'], { ...sc, on: !sc.on, types: sc.types && Object.values(sc.types).some(Boolean) ? sc.types : { dine_in: true } })}>
          <span><strong>{tr('Add a service charge')}</strong><small>{tr('A percentage of the dishes after discounts. A cashier with the right to give discounts can take it off a bill.')}</small></span>
          <span className={'ts-switch' + (sc.on ? ' is-on' : '')} aria-hidden="true"><i /></span>
        </button>
        {sc.on && (
          <div className="ts-bill-service">
            <div className="field"><label htmlFor="ts-sc-name">{tr('Called')}</label>
              <input id="ts-sc-name" className="input" maxLength={40} value={sc.name || ''} onChange={(e) => set(['serviceCharge', 'name'], e.target.value)} placeholder={tr('Service charge')} /></div>
            <div className="field"><label htmlFor="ts-sc-rate">{tr('Percentage')}</label>
              <input id="ts-sc-rate" className="input ts-bill-num" type="number" min="0.5" max="50" step="0.5" value={sc.rate} onChange={(e) => set(['serviceCharge', 'rate'], e.target.value)} /></div>
            <div className="field ts-bill-types"><label>{tr('On')}</label>
              <div className="ts-chips">
                {FULFILLMENT.map((f) => (
                  <button key={f.key} type="button" className={'ts-chip' + (sc.types && sc.types[f.key] ? ' is-on' : '')} aria-pressed={!!(sc.types && sc.types[f.key])}
                    onClick={() => set(['serviceCharge', 'types'], { ...(sc.types || {}), [f.key]: !(sc.types && sc.types[f.key]) })}>
                    <FulfillmentIcon kind={f.key} />{fulfillmentName(f.key)}
                  </button>
                ))}
              </div>
            </div>
            <label className="ts-bill-check"><input type="checkbox" checked={sc.taxed !== false} onChange={(e) => set(['serviceCharge', 'taxed'], e.target.checked)} />{tr('Taxes are charged on it too')}</label>
          </div>
        )}
      </div>

      <div className="ts-bill-block">
        <h3><span aria-hidden="true">🧾</span>{tr('Taxes')}</h3>
        <div className="dk-segment" role="radiogroup" aria-label={tr('The menu\'s prices')}>
          <button type="button" role="radio" aria-checked={tax.included !== false} className={tax.included !== false ? 'is-on' : ''} onClick={() => set(['tax', 'included'], true)}>{tr('Included in the prices')}</button>
          <button type="button" role="radio" aria-checked={tax.included === false} className={tax.included === false ? 'is-on' : ''} onClick={() => set(['tax', 'included'], false)}>{tr('Added on top')}</button>
        </div>
        <p className="dk-muted">{tax.included !== false ? tr('The customer pays the menu price; the receipt shows the taxes in it.') : tr('The taxes are added to the bill, and the receipt shows each.')}</p>
        {(tax.list || []).length > 0 && (
          <ul className="ts-bill-rows is-plain">
            {tax.list.map((t, i) => (
              <li key={t.id || i}>
                <input className="input" maxLength={40} value={t.name} onChange={(e) => setTax(i, { name: e.target.value })} placeholder={tr('e.g. VAT')} aria-label={tr('Name')} />
                <input className="input ts-bill-num" type="number" min="0" max="50" step="0.001" value={t.rate} onChange={(e) => setTax(i, { rate: e.target.value })} aria-label={tr('Rate in %')} />
                <span className="ts-bill-pct">%</span>
                <label className="ts-bill-check" title={tr('Charged on the price and the taxes above it, as Ghana\'s VAT is on the levies.')}>
                  <input type="checkbox" checked={!!t.compound} disabled={i === 0} onChange={(e) => setTax(i, { compound: e.target.checked })} />{tr('On the taxes above')}</label>
                <button type="button" className="pos-line-x" onClick={() => set(['tax', 'list'], tax.list.filter((_, j) => j !== i))} aria-label={tr('Remove')}>×</button>
              </li>
            ))}
          </ul>
        )}
        <button type="button" className="btn btn-secondary tl-btn" onClick={() => set(['tax', 'list'], (tax.list || []).concat([{ id: newId(), name: '', rate: '', compound: false }]))}>+ {tr('A tax')}</button>
      </div>

      <div className="ts-bill-example">
        <strong>{tr('A dine-in bill of {amount} in dishes:', { amount: money(100) })}</strong>
        {example.serviceCharge > 0 && <span><i>{serviceWords(sc.name, tr)} {sc.rate}%</i><b>{money(example.serviceCharge)}</b></span>}
        {example.taxes.map((t) => <span key={t.name}><i>{t.name} {t.rate}%{t.included ? ' · ' + tr('included') : ''}</i><b>{money(t.amount)}</b></span>)}
        <span className="is-total"><i>{tr('The customer pays')}</i><b>{money(example.total)}</b></span>
      </div>
    </section>
  );
}
