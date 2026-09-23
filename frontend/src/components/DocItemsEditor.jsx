import { useState } from 'react';
import { money } from '../lib/currency';
import CatalogPicker from './CatalogPicker';
import { tr } from '../lib/i18n.jsx';
import './DocItemsEditor.css';

// Shared line-item editor used identically by the New Quotation, New
// Estimate, New Manual Invoice, and Edit Estimate dialogs in
// Bamboo OS.dc.html (docItemsRows / blankDocItem / addDocItem / removeDocItem
// / setDocItem / applyCatalogItem / docTotals). Mirrors backend
// backend/src/utils/documents.js's buildLineItems/computeDocTotals so the
// totals shown here match what the server will compute (no document-level
// discount/tax fields exist in these dialogs — only per-line ones).

// packageLabel: a "package" bundles two or more lines under one heading
// with a single combined price shown to the customer (Square's packages).
// Lines sharing the same hand-typed label get grouped in DocPreview/
// SharePage — see lib/packages.js's groupPackageItems — while staying
// individually priced/tracked here and in the stored data.
export function blankDocItem() {
  return { description: '', notes: '', qty: 1, unit: 'each', unitPrice: 0, discount: 0, discountType: 'fixed', taxRate: 0, packageLabel: '' };
}

// One row of a document's payment schedule — a percentage or fixed-amount
// installment against the grand total, with its own due date.
export function blankScheduleRow() {
  return { label: '', type: 'percent', value: 0, dueDate: '' };
}

// Mirrors backend/src/utils/documents.js's computeDocTotals(items,
// docDiscount, docTaxRate) exactly, so the wizard's live total matches
// what the server actually persists — docDiscount/docTaxRate are the
// document-level "Add discount" amount and a document-level tax rate, on
// top of whatever each line already carries.
export function computeDocTotals(items, docDiscount, docTaxRate) {
  let subtotal = 0, discountTotal = 0, taxTotal = 0;
  items.forEach((it) => {
    const qty = Number(it.qty) || 0, price = Number(it.unitPrice) || 0;
    const line = qty * price;
    const disc = it.discountType === 'percent' ? (line * (Number(it.discount) || 0)) / 100 : Number(it.discount) || 0;
    const afterDisc = Math.max(0, line - disc);
    const tax = (afterDisc * (Number(it.taxRate) || 0)) / 100;
    subtotal += line; discountTotal += disc; taxTotal += tax;
  });
  let docDiscountAmt = 0;
  if (docDiscount && docDiscount.value) docDiscountAmt = docDiscount.type === 'percent' ? ((subtotal - discountTotal) * docDiscount.value) / 100 : Number(docDiscount.value) || 0;
  discountTotal += docDiscountAmt;
  const docTaxAmt = docTaxRate ? (Math.max(0, subtotal - discountTotal) * (Number(docTaxRate) || 0)) / 100 : 0;
  taxTotal += docTaxAmt;
  const grandTotal = Math.max(0, subtotal - discountTotal) + taxTotal;
  return { subtotal, discountTotal, taxTotal, grandTotal };
}

function lineTotal(it) {
  const qty = Number(it.qty) || 0, price = Number(it.unitPrice) || 0;
  const line = qty * price;
  const disc = it.discountType === 'percent' ? (line * (Number(it.discount) || 0)) / 100 : Number(it.discount) || 0;
  return Math.max(0, line - disc);
}

// Deliberate prototype quirk, kept for fidelity: picking a catalogue item
// sets description/unit/unitPrice/qty but never touches taxRate, even
// though catalogue items carry a tax rate. Replicated verbatim rather than
// "fixed", since this build stays faithful to intentional (if odd) UI
// behavior from the design tool unless it would actively break the flow.
export function applyCatalogItem(items, idx, item) {
  if (!item) return items;
  return items.map((it, i) => (i === idx ? {
    ...it, description: item.name, unit: item.unit, unitPrice: item.unitPrice, qty: item.defaultQty || 1,
    // Only prefills notes from the catalogue item's own description when the
    // line's notes field is still empty — never clobbers something the user
    // already typed by hand.
    notes: it.notes ? it.notes : (item.description || '')
  } : it));
}

export default function DocItemsEditor({
  items, onChange, catalogOptions, currency, docDiscount, onDocDiscountChange, docTaxRate, onDocTaxRateChange,
  paymentSchedule, onPaymentScheduleChange
}) {
  const totals = computeDocTotals(items, docDiscount, docTaxRate);
  const cur = currency || 'GHS';
  const [discountOpen, setDiscountOpen] = useState(!!(docDiscount && docDiscount.value));
  const [scheduleOpen, setScheduleOpen] = useState(!!(paymentSchedule && paymentSchedule.length));

  function setField(idx, key, value) {
    onChange(items.map((it, i) => (i === idx ? { ...it, [key]: value } : it)));
  }
  function addLine() {
    onChange(items.concat([blankDocItem()]));
  }
  // A shipping/service charge is just a regular line, pre-named, the way
  // Square's own "Add shipping fee or service charge" works underneath —
  // no new data model needed, just a shortcut into the existing one.
  function addShippingLine() {
    onChange(items.concat([{ ...blankDocItem(), description: 'Shipping / Service charge' }]));
  }
  function removeLine(idx) {
    if (items.length <= 1) return;
    onChange(items.filter((_, i) => i !== idx));
  }
  function moveLine(idx, dir) {
    const target = idx + dir;
    if (target < 0 || target >= items.length) return;
    const next = items.slice();
    [next[idx], next[target]] = [next[target], next[idx]];
    onChange(next);
  }
  function pickCatalog(idx, item) {
    onChange(applyCatalogItem(items, idx, item));
  }

  const schedule = paymentSchedule || [];
  const scheduledAmount = schedule.reduce((sum, row) => {
    const value = Number(row.value) || 0;
    return sum + (row.type === 'fixed' ? value : (totals.grandTotal * value) / 100);
  }, 0);
  function addScheduleRow() {
    onPaymentScheduleChange(schedule.concat([blankScheduleRow()]));
  }
  function setScheduleField(idx, key, value) {
    onPaymentScheduleChange(schedule.map((r, i) => (i === idx ? { ...r, [key]: value } : r)));
  }
  function removeScheduleRow(idx) {
    onPaymentScheduleChange(schedule.filter((_, i) => i !== idx));
  }

  return (
    <div className="doc-items-editor">
      <div className="doc-items-scroll">
        <table className="table doc-items-table">
          <thead>
            <tr>
              <th></th><th>{tr('Item')}</th><th>{tr('Qty')}</th><th>{tr('Unit')}</th><th>{tr('Price (')}{cur})</th><th>{tr('Disc.')}</th><th>{tr('Type')}</th><th>{tr('Tax %')}</th><th>{tr('Line total')}</th><th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, idx) => (
              <tr key={idx}>
                <td className="doc-items-reorder-cell">
                  <button type="button" className="doc-items-reorder-btn" disabled={idx === 0} onClick={() => moveLine(idx, -1)} aria-label={tr('Move up')} title={tr('Move up')}>▲</button>
                  <button type="button" className="doc-items-reorder-btn" disabled={idx === items.length - 1} onClick={() => moveLine(idx, 1)} aria-label={tr('Move down')} title={tr('Move down')}>▼</button>
                </td>
                <td className="doc-items-desc-cell">
                  <CatalogPicker
                    value={it.description}
                    onChange={(text) => setField(idx, 'description', text)}
                    onPickOption={(c) => pickCatalog(idx, c)}
                    options={catalogOptions || []}
                    placeholder={tr('Search catalogue or type a custom item…')}
                    renderOption={(c) => c.name + ' — ' + money(c.unitPrice, cur)}
                  />
                  <textarea
                    className="input doc-items-notes"
                    rows={2}
                    value={it.notes || ''}
                    placeholder={tr('Add a description (optional)…')}
                    onChange={(e) => setField(idx, 'notes', e.target.value)}
                  />
                  <input
                    className="input doc-items-package"
                    value={it.packageLabel || ''}
                    placeholder={tr('Package name (optional) — groups with other lines under one price')}
                    onChange={(e) => setField(idx, 'packageLabel', e.target.value)}
                  />
                </td>
                <td><input className="input" type="number" value={it.qty} onChange={(e) => setField(idx, 'qty', e.target.value)} /></td>
                <td><input className="input" value={it.unit} onChange={(e) => setField(idx, 'unit', e.target.value)} /></td>
                <td><input className="input" type="number" value={it.unitPrice} onChange={(e) => setField(idx, 'unitPrice', e.target.value)} /></td>
                <td><input className="input" type="number" value={it.discount} onChange={(e) => setField(idx, 'discount', e.target.value)} /></td>
                <td>
                  <select className="input" value={it.discountType} onChange={(e) => setField(idx, 'discountType', e.target.value)}>
                    <option value="fixed">{cur}</option><option value="percent">%</option>
                  </select>
                </td>
                <td><input className="input" type="number" value={it.taxRate} onChange={(e) => setField(idx, 'taxRate', e.target.value)} /></td>
                <td className="doc-items-total-cell">{money(lineTotal(it), cur)}</td>
                <td>{items.length > 1 && <button type="button" className="btn btn-secondary doc-items-remove" onClick={() => removeLine(idx)}>✕</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="doc-items-quick-actions">
        <button type="button" className="btn btn-secondary doc-items-add" onClick={addLine}>{tr('+ Add line')}</button>
        <button type="button" className="btn btn-secondary doc-items-add" onClick={addShippingLine}>{tr('+ Add shipping fee or service charge')}</button>
        {onDocDiscountChange && !discountOpen && (
          <button type="button" className="btn btn-secondary doc-items-add" onClick={() => setDiscountOpen(true)}>{tr('+ Add discount')}</button>
        )}
        {onPaymentScheduleChange && !scheduleOpen && (
          <button type="button" className="btn btn-secondary doc-items-add" onClick={() => { setScheduleOpen(true); if (!schedule.length) addScheduleRow(); }}>{tr('+ Add payment schedule')}</button>
        )}
      </div>
      {onDocDiscountChange && discountOpen && (
        <div className="doc-items-doc-discount">
          <span>{tr('Discount for the whole document')}</span>
          <input
            className="input" type="number" min="0" value={(docDiscount && docDiscount.value) || ''}
            placeholder="0" onChange={(e) => onDocDiscountChange({ value: e.target.value, type: (docDiscount && docDiscount.type) || 'fixed' })}
          />
          <select
            className="input" value={(docDiscount && docDiscount.type) || 'fixed'}
            onChange={(e) => onDocDiscountChange({ value: (docDiscount && docDiscount.value) || 0, type: e.target.value })}
          >
            <option value="fixed">{cur}</option><option value="percent">%</option>
          </select>
          <button type="button" className="btn btn-secondary doc-items-remove" onClick={() => { setDiscountOpen(false); onDocDiscountChange({ value: 0, type: 'fixed' }); }}>✕</button>
        </div>
      )}
      {onPaymentScheduleChange && scheduleOpen && (
        <div className="doc-items-schedule">
          <div className="doc-items-schedule-head">
            <span>{tr('Payment schedule')}</span>
            <button type="button" className="btn btn-secondary doc-items-remove" onClick={() => { setScheduleOpen(false); onPaymentScheduleChange([]); }}>✕</button>
          </div>
          {schedule.map((row, idx) => (
            <div className="doc-items-schedule-row" key={idx}>
              <input className="input" value={row.label} placeholder={tr('e.g. Deposit')} onChange={(e) => setScheduleField(idx, 'label', e.target.value)} />
              <input className="input" type="number" min="0" value={row.value} onChange={(e) => setScheduleField(idx, 'value', e.target.value)} />
              <select className="input" value={row.type} onChange={(e) => setScheduleField(idx, 'type', e.target.value)}>
                <option value="percent">%</option>
                <option value="fixed">{cur}</option>
              </select>
              <input className="input" type="date" value={row.dueDate} onChange={(e) => setScheduleField(idx, 'dueDate', e.target.value)} />
              <span className="doc-items-schedule-amount">
                {money(row.type === 'fixed' ? Number(row.value) || 0 : (totals.grandTotal * (Number(row.value) || 0)) / 100, cur)}
              </span>
              <button type="button" className="btn btn-secondary doc-items-remove" onClick={() => removeScheduleRow(idx)}>✕</button>
            </div>
          ))}
          <div className="doc-items-schedule-foot">
            <button type="button" className="btn btn-secondary doc-items-add" onClick={addScheduleRow}>{tr('+ Add installment')}</button>
            <span className={'doc-items-schedule-check' + (Math.abs(scheduledAmount - totals.grandTotal) > 0.01 ? ' doc-items-schedule-mismatch' : '')}>
              {tr('Scheduled {amount} of {amount2}', { amount: money(scheduledAmount, cur), amount2: money(totals.grandTotal, cur) })}
            </span>
          </div>
        </div>
      )}
      <div className="doc-items-footer">
        <div>{tr('Subtotal')} <strong>{money(totals.subtotal, cur)}</strong></div>
        <div>{tr('Discount')} <strong>{money(totals.discountTotal, cur)}</strong></div>
        <div>
          {tr('Tax')} <strong>{money(totals.taxTotal, cur)}</strong>
          {onDocTaxRateChange && (
            <span className="doc-items-doc-tax">
              (<input className="input" type="number" min="0" step="0.1" value={docTaxRate || ''} placeholder="0" onChange={(e) => onDocTaxRateChange(e.target.value)} />%)
            </span>
          )}
        </div>
        <div>{tr('Total')} <strong className="doc-items-grand-total">{money(totals.grandTotal, cur)}</strong></div>
      </div>
    </div>
  );
}
