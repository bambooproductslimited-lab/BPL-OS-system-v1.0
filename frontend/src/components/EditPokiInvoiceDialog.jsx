import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { tr } from '../lib/i18n.jsx';
import './EmailDocumentDialog.css';
import './EditPokiInvoiceDialog.css';

// Changing a Poki bill after it was raised (backend pokiInvoices.update):
// each line's wording, the working shown under it, quantity and rate; lines
// added or taken away; the due date and the note. The invoice keeps its
// number. The total can't go below what has been paid or credited — that
// is a credit note. Rent and deposit invoices follow their booking.

function lineTotal(l) {
  const base = (Number(l.qty) || 0) * (Number(l.unitPrice) || 0);
  const disc = l.discountType === 'percent' ? base * (Number(l.discount) || 0) / 100 : (Number(l.discount) || 0);
  const after = Math.max(0, base - disc);
  return after + after * (Number(l.taxRate) || 0) / 100;
}

export default function EditPokiInvoiceDialog({ invoiceId, onClose, onSaved }) {
  const [inv, setInv] = useState(null);
  const [lines, setLines] = useState([]);
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    api.get('/poki/invoices/' + invoiceId).then((i) => {
      if (!alive) return;
      setInv(i);
      setLines(i.items.map((it, k) => ({ ...it, key: k, orig: { qty: it.qty, unitPrice: it.unitPrice } })));
      setDueDate(String(i.dueDate || '').slice(0, 10));
      setNotes(i.notes || '');
    }).catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [invoiceId]);

  const total = useMemo(() => Math.round(lines.reduce((t, l) => t + lineTotal(l), 0) * 100) / 100, [lines]);
  const floor = inv ? (inv.amountPaid || 0) + (inv.creditTotal || 0) : 0;
  const tooLow = inv && total + 0.005 < floor;
  const set = (key, patch) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  async function save(e) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      const items = lines.map(({ key, orig, ...it }) => it);
      const saved = await api.put('/poki/invoices/' + invoiceId, { items, dueDate, notes });
      if (onSaved) onSaved(saved);
    } catch (err) { setError(err.message); }
    setSaving(false);
  }

  return (
    <div className="dialog-backdrop" onClick={() => !saving && onClose()}>
      <form className="dialog ed epi" onClick={(e) => e.stopPropagation()} onSubmit={save} role="dialog" aria-modal="true" aria-labelledby="epi-title">
        <div className="ed-head">
          <span className="ed-head-icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></svg>
          </span>
          <div>
            <h2 id="epi-title">{inv ? tr('Change invoice {no}', { no: inv.invoiceNo }) : tr('Change invoice')}</h2>
            <p className="ed-sub">{tr('Fix a line, its working, the quantity or the rate, add or remove a line, or move the due date. The invoice keeps its number; what is owed follows the new total. If it was already sent, send it again after saving.')}</p>
          </div>
        </div>

        {error && <div className="error-banner" role="alert">{error}</div>}
        {!inv && !error && <p className="ed-sub">{tr('Loading…')}</p>}

        {inv && (
          <>
            <ul className="epi-lines">
              {lines.map((l, n) => {
                const moved = l.notes && l.orig && (Number(l.qty) !== Number(l.orig.qty) || Number(l.unitPrice) !== Number(l.orig.unitPrice));
                return (
                  <li key={l.key} className="epi-line">
                    <div className="epi-row">
                      <label className="field epi-desc">
                        <span className="field-label">{tr('Line {n}', { n: n + 1 })}</span>
                        <input className="input" required maxLength={160} value={l.description} onChange={(e) => set(l.key, { description: e.target.value })} />
                      </label>
                      <label className="field epi-num">
                        <span className="field-label">{tr('Quantity')}{l.unit && l.unit !== 'each' ? ' (' + l.unit + ')' : ''}</span>
                        <input className="input" type="number" min="0.01" step="any" required value={l.qty} onChange={(e) => set(l.key, { qty: e.target.value })} />
                      </label>
                      <label className="field epi-num">
                        <span className="field-label">{tr('Rate')}</span>
                        <input className="input" type="number" min="0" step="any" required value={l.unitPrice} onChange={(e) => set(l.key, { unitPrice: e.target.value })} />
                      </label>
                      <span className="epi-total">{money(lineTotal(l), inv.currency)}</span>
                      <button type="button" className="epi-remove" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} aria-label={tr('Remove line {n}', { n: n + 1 })} title={tr('Remove line')}>×</button>
                    </div>
                    <label className="field">
                      <span className="field-label">{tr('Working shown under the line')}</span>
                      <textarea className="input epi-notes" rows={Math.min(4, Math.max(1, String(l.notes || '').split('\n').length))} value={l.notes || ''} onChange={(e) => set(l.key, { notes: e.target.value })} />
                    </label>
                    {moved && <span className="ed-hint">{tr('The quantity or rate changed: update the working above so it matches.')}</span>}
                  </li>
                );
              })}
            </ul>
            <button type="button" className="btn btn-secondary tl-btn epi-add" onClick={() => setLines((ls) => [...ls, { key: Date.now(), description: '', qty: 1, unitPrice: 0, notes: '' }])}>{tr('Add a line')}</button>

            <div className="ed-grid">
              <label className="field">
                <span className="field-label">{tr('Due date')}</span>
                <input className="input" type="date" required value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </label>
              <label className="field">
                <span className="field-label">{tr('Note on the invoice')}</span>
                <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </label>
            </div>

            <div className={'epi-sum' + (tooLow ? ' is-bad' : '')}>
              <span>{tr('Was {amount}', { amount: money(inv.grandTotal, inv.currency) })}</span>
              <strong>{tr('New total {amount}', { amount: money(total, inv.currency) })}</strong>
              {floor > 0 && <span>{tooLow
                ? tr('{amount} has been paid or credited already — the total can\'t go below that. Use a credit note instead.', { amount: money(floor, inv.currency) })
                : tr('{amount} paid or credited · {owed} would be owed', { amount: money(floor, inv.currency), owed: money(Math.max(0, total - floor), inv.currency) })}</span>}
            </div>
          </>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" disabled={saving} onClick={onClose}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={saving || !inv || tooLow}>{saving ? tr('Saving…') : tr('Save changes')}</button>
        </div>
      </form>
    </div>
  );
}
