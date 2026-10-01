import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { tr } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import { fmtDate } from './DashKit';
import './EmailDocumentDialog.css';
import './BillReadingsDialog.css';

// Billing the ticked meter readings (backend pokiBilling.billReadings):
// one invoice per tenant with every meter of theirs on it, and — ticked
// here — their recurring charges (the month's CAM, a flat fee) on the same
// invoice, so a tenant gets one bill for the month. Each line carries its
// working (readings, units × rate, days). Once raised, each invoice opens
// to send by WhatsApp or email, or to change; nothing is sent by itself.

export default function BillReadingsDialog({ readingIds, onClose, onBilled, onSend, onEdit }) {
  const [plan, setPlan] = useState(null);
  const [pick, setPick] = useState({}); // chargeId -> true
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    let alive = true;
    api.post('/poki/readings/bill/preview', { readingIds }).then((p) => {
      if (!alive) return;
      setPlan(p);
      const k = {};
      p.groups.forEach((g) => g.charges.forEach((c) => { if (c.due) k[c.id] = true; }));
      setPick(k);
    }).catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [readingIds]);

  const totals = useMemo(() => Object.fromEntries((plan ? plan.groups : []).map((g) => [g.bookingId,
    g.readings.reduce((t, r) => t + r.amount, 0) + g.charges.filter((c) => pick[c.id]).reduce((t, c) => t + c.amount, 0)])), [plan, pick]);

  async function raise() {
    setSaving(true); setError(null);
    try {
      const chargeIds = Object.keys(pick).filter((k) => pick[k]);
      const r = await api.post('/poki/readings/bill', { readingIds, chargeIds });
      setDone(r);
      if (onBilled) onBilled(r);
      // One bill: straight to sending it.
      if (r.invoices.length === 1 && onSend) onSend(r.invoices[0]);
    } catch (e) { setError(e.message); }
    setSaving(false);
  }

  const periodText = (c) => c.periods.length === 1
    ? fmtDate(c.periods[0].start) + ' – ' + fmtDate(c.periods[0].end)
    : tr('{n} periods, {from} – {to}', { n: c.periods.length, from: fmtDate(c.periods[0].start), to: fmtDate(c.periods[c.periods.length - 1].end) });

  return (
    <div className="dialog-backdrop" onClick={() => !saving && onClose()}>
      <div className="dialog ed brd" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="brd-title">
        <div className="ed-head">
          <span className="ed-head-icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3h9l3 3v15H6z" /><path d="M9 9h6M9 13h6M9 17h3" /></svg>
          </span>
          <div>
            <h2 id="brd-title">{done ? tr('Bills raised — send them') : tr('Bill the readings')}</h2>
            <p className="ed-sub">{done
              ? tr('Nothing has been sent yet. Open each bill to send it by WhatsApp or email, or change it first.')
              : tr('Each tenant gets one invoice with all their meters on it. Tick their service charge (CAM) or other recurring charges to put them on the same invoice. Every line shows its working.')}</p>
          </div>
        </div>

        {!plan && !error && <p className="ed-sub">{tr('Working it out…')}</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}

        {done ? (
          <ul className="brd-done">
            {done.invoices.map((i) => (
              <li key={i.invoiceId}>
                <span className="brd-done-main">
                  <strong>{i.tenantName}</strong>
                  <small>{i.invoiceNo} · {tr('{n} lines', { n: i.lines })}{i.charges ? ' · ' + tr('with recurring charges') : ''}</small>
                </span>
                <strong className="brd-amt">{money(i.amount, i.currency)}</strong>
                <span className="brd-done-acts">
                  {onEdit && <button type="button" className="btn btn-secondary tl-btn" onClick={() => onEdit(i)}>{tr('Change')}</button>}
                  <button type="button" className="btn btn-primary tl-btn" onClick={() => onSend(i)}>{tr('Send')}</button>
                </span>
              </li>
            ))}
            {done.skippedUnits && done.skippedUnits.length > 0 && <li className="ed-note is-warn">{tr('Not billed: {units} — no active booking.', { units: done.skippedUnits.join(', ') })}</li>}
          </ul>
        ) : plan && (
          <>
            {plan.skippedUnits.length > 0 && <div className="ed-note is-warn">{tr('{units} has no active booking, so there is nobody to bill. Its readings stay unbilled.', { units: plan.skippedUnits.join(', ') })}</div>}
            <ul className="brd-list">
              {plan.groups.map((g) => (
                <li key={g.bookingId} className="brd-group">
                  <div className="brd-head">
                    <span>
                      <strong>{g.tenantName}</strong>
                      <small>{g.propertyName} · {g.unitCode} · {g.bookingNo}</small>
                    </span>
                    <strong className="brd-amt">{money(totals[g.bookingId], g.currency)}</strong>
                  </div>
                  <ul className="brd-lines">
                    {g.readings.map((r) => (
                      <li key={r.id}>
                        <span className={'brd-icon is-' + r.utilityType} aria-hidden="true" />
                        <span className="brd-line-main">
                          <strong>{codeLabel(r.utilityType)} · {r.unitCode}</strong>
                          <small>{fmtDate(r.periodStart)} – {fmtDate(r.periodEnd)} · {tr('{n} {unit} used', { n: r.consumption, unit: r.measureUnit })}</small>
                        </span>
                        <span className="brd-line-amt">{money(r.amount, g.currency)}</span>
                      </li>
                    ))}
                  </ul>
                  {(g.chargesInOtherCurrency || []).length > 0 && (
                    <div className="ed-note">{tr('Utilities are billed in GHS. {what} is in {currency}, so it stays on its own invoice (Recurring charges).', { what: g.chargesInOtherCurrency.map((c) => c.description).join(', '), currency: g.chargesInOtherCurrency[0].currency })}</div>
                  )}
                  {g.charges.length > 0 && (
                    <div className="brd-charges">
                      <div className="brd-charges-title">{tr('Put on the same invoice')}</div>
                      {g.charges.map((c) => (
                        <label key={c.id} className={'brd-charge' + (pick[c.id] ? ' is-on' : '')}>
                          <input type="checkbox" checked={!!pick[c.id]} onChange={(e) => setPick((k) => ({ ...k, [c.id]: e.target.checked }))} />
                          <span className="brd-line-main">
                            <strong>{c.description}</strong>
                            <small>{periodText(c)} · {c.due ? tr('due since {date}', { date: fmtDate(c.nextDate) }) : tr('not due until {date} — billed early', { date: fmtDate(c.nextDate) })}</small>
                          </span>
                          <span className="brd-line-amt">{money(c.amount, g.currency)}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="dialog-actions">
          {done ? <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Done')}</button> : (
            <>
              <button type="button" className="btn btn-secondary" disabled={saving} onClick={onClose}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={saving || !plan || !plan.groups.length} onClick={raise}>
                {saving ? tr('Raising…') : plan && plan.groups.length === 1 ? tr('Raise the bill and send') : tr('Raise {n} bills', { n: plan ? plan.groups.length : 0 })}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
