import { money } from '../lib/currency';
import CatalogPicker from './CatalogPicker';
import './DocItemsEditor.css';

// Shared line-item editor used identically by the New Quotation, New
// Estimate, New Manual Invoice, and Edit Estimate dialogs in
// Bamboo OS.dc.html (docItemsRows / blankDocItem / addDocItem / removeDocItem
// / setDocItem / applyCatalogItem / docTotals). Mirrors backend
// backend/src/utils/documents.js's buildLineItems/computeDocTotals so the
// totals shown here match what the server will compute (no document-level
// discount/tax fields exist in these dialogs — only per-line ones).

export function blankDocItem() {
  return { description: '', qty: 1, unit: 'each', unitPrice: 0, discount: 0, discountType: 'fixed', taxRate: 0 };
}

export function computeDocTotals(items) {
  let subtotal = 0, discountTotal = 0, taxTotal = 0;
  items.forEach((it) => {
    const qty = Number(it.qty) || 0, price = Number(it.unitPrice) || 0;
    const line = qty * price;
    const disc = it.discountType === 'percent' ? (line * (Number(it.discount) || 0)) / 100 : Number(it.discount) || 0;
    const afterDisc = Math.max(0, line - disc);
    const tax = (afterDisc * (Number(it.taxRate) || 0)) / 100;
    subtotal += line; discountTotal += disc; taxTotal += tax;
  });
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
  return items.map((it, i) => (i === idx ? { ...it, description: item.name, unit: item.unit, unitPrice: item.unitPrice, qty: item.defaultQty || 1 } : it));
}

export default function DocItemsEditor({ items, onChange, catalogOptions, currency }) {
  const totals = computeDocTotals(items);
  const cur = currency || 'GHS';

  function setField(idx, key, value) {
    onChange(items.map((it, i) => (i === idx ? { ...it, [key]: value } : it)));
  }
  function addLine() {
    onChange(items.concat([blankDocItem()]));
  }
  function removeLine(idx) {
    if (items.length <= 1) return;
    onChange(items.filter((_, i) => i !== idx));
  }
  function pickCatalog(idx, item) {
    onChange(applyCatalogItem(items, idx, item));
  }

  return (
    <div className="doc-items-editor">
      <div className="doc-items-scroll">
        <table className="table doc-items-table">
          <thead>
            <tr>
              <th>Item</th><th>Qty</th><th>Unit</th><th>Price ({cur})</th><th>Disc.</th><th>Type</th><th>Tax %</th><th>Line total</th><th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, idx) => (
              <tr key={idx}>
                <td className="doc-items-desc-cell">
                  <CatalogPicker
                    value={it.description}
                    onChange={(text) => setField(idx, 'description', text)}
                    onPickOption={(c) => pickCatalog(idx, c)}
                    options={catalogOptions || []}
                    placeholder="Search catalogue or type a custom item…"
                    renderOption={(c) => c.name + ' — ' + money(c.unitPrice, cur)}
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
      <button type="button" className="btn btn-secondary doc-items-add" onClick={addLine}>+ Add line</button>
      <div className="doc-items-footer">
        <div>Subtotal <strong>{money(totals.subtotal, cur)}</strong></div>
        <div>Discount <strong>{money(totals.discountTotal, cur)}</strong></div>
        <div>Tax <strong>{money(totals.taxTotal, cur)}</strong></div>
        <div>Total <strong className="doc-items-grand-total">{money(totals.grandTotal, cur)}</strong></div>
      </div>
    </div>
  );
}
