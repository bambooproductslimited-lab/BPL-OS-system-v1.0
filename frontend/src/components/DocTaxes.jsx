import { useEffect, useState } from 'react';
import { money } from '../lib/currency';
import { companyTaxes, sameTax, standardSet, sumRates } from '../lib/docTaxes';
import { taxBreakdown, taxLabel } from '../lib/docItems';
import { tr } from '../lib/i18n.jsx';
import './DocTaxes.css';

// The taxes on a quotation, estimate or invoice (in DocItemsEditor): the
// company's own — VAT, NHIL, GETFund — switched on one by one, or all three
// at once, each charged on the amount after discounts and printed as its own
// line on the document; or one other rate typed in. The amounts show as they
// are chosen. Saved as the document's taxComponents, its tax rate their sum
// (backend utils/documents.js docTaxOf).
export default function DocTaxes({ currency, totals, docTaxRate, components, onChange }) {
  const [taxes, setTaxes] = useState(null);
  const comps = components || [];
  const plainRate = !comps.length && Number(docTaxRate) > 0;
  const [otherOpen, setOtherOpen] = useState(plainRate);
  useEffect(() => {
    let live = true;
    companyTaxes().then((list) => { if (live) setTaxes(list); }).catch(() => { if (live) setTaxes([]); });
    return () => { live = false; };
  }, []);

  const list = taxes || [];
  // A tax on the document that is no longer set up stays on it, to take off.
  const extra = comps.filter((c) => !list.some((t) => sameTax(t, c)));
  const chips = list.concat(extra);
  const on = (t) => comps.some((c) => sameTax(c, t));
  const order = (next) => chips.filter((t) => next.some((c) => sameTax(c, t))).map((t) => ({ ...(t.id ? { id: t.id } : {}), name: t.name, rate: Number(t.rate) }));
  function set(next) {
    onChange(next, sumRates(next));
    setOtherOpen(false);
  }
  function toggle(t) { set(on(t) ? comps.filter((c) => !sameTax(c, t)) : order(comps.concat([t]))); }
  const std = standardSet(list);
  const stdOn = std && comps.length === std.length && std.every(on);

  const rows = taxBreakdown({ subtotal: totals.subtotal, discountTotal: totals.discountTotal, taxTotal: totals.taxTotal, taxRate: docTaxRate, taxComponents: comps });
  const cur = currency || 'GHS';
  const nothing = !comps.length && !plainRate;

  return (
    <div className={'doc-tax' + (nothing ? '' : ' is-on')}>
      <div className="doc-tax-head">
        <span className="doc-tax-ico" aria-hidden="true">🧾</span>
        <span>
          <strong>{tr('Taxes')}</strong>
          <small>{tr('Charged on the amount after discounts. Each prints on its own line on the document.')}</small>
        </span>
      </div>
      <div className="doc-tax-chips">
        {std && (
          <button type="button" className={'doc-tax-chip is-quick' + (stdOn ? ' is-on' : '')} aria-pressed={!!stdOn} onClick={() => set(stdOn ? [] : order(std))}>
            <span aria-hidden="true">{stdOn ? '✓' : '⚡'}</span> {std.map((t) => t.name).join(' + ')} <b>{sumRates(std)}%</b>
          </button>
        )}
        {chips.map((t) => (
          <button key={t.id || t.name} type="button" role="switch" aria-checked={on(t)} className={'doc-tax-chip' + (on(t) ? ' is-on' : '')} onClick={() => toggle(t)}>
            <span className="doc-tax-tick" aria-hidden="true">{on(t) ? '✓' : '+'}</span> {t.name} <b>{Number(t.rate)}%</b>
          </button>
        ))}
        {!otherOpen && !plainRate && (
          <button type="button" className="doc-tax-chip is-other" onClick={() => setOtherOpen(true)}>{tr('Other rate…')}</button>
        )}
        {(otherOpen || plainRate) && (
          <span className="doc-tax-other">
            <label htmlFor="doc-tax-other">{tr('Other rate')}</label>
            <input
              id="doc-tax-other" className="input" type="number" min="0" max="100" step="0.1" placeholder="0"
              value={plainRate ? docTaxRate : ''} onChange={(e) => onChange([], Math.max(0, Number(e.target.value) || 0))}
            />%
            <button type="button" className="doc-tax-x" aria-label={tr('No other rate')} onClick={() => { onChange([], 0); setOtherOpen(false); }}>✕</button>
          </span>
        )}
      </div>
      {taxes && !list.length && !comps.length && (
        <p className="doc-tax-hint">{tr('To pick VAT, NHIL and GETFund here, add them under Billing settings → Tax rates.')}</p>
      )}
      {rows.length > 0 && (
        <ul className="doc-tax-lines">
          {rows.map((t, i) => <li key={i}><span>{taxLabel(t)}</span><b>{money(t.amount, cur)}</b></li>)}
          {rows.length > 1 && <li className="is-total"><span>{tr('Total tax')}</span><b>{money(totals.taxTotal, cur)}</b></li>}
        </ul>
      )}
    </div>
  );
}
