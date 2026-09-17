import { money } from './currency';

// Line items, shaped for RecordDialog's items table.
//
// The per-line amount is computed here rather than read off the record,
// because the API stores each line's inputs (qty, unit price, discount, tax
// rate) and only the document-level totals — there is no stored line total
// to show. This mirrors the backend's own arithmetic in utils/documents.js:
// discount applies to the line, then tax applies to what is left.
export function lineAmount(it) {
  const gross = (Number(it.qty) || 0) * (Number(it.unitPrice) || 0);
  const disc = it.discountType === 'percent'
    ? (gross * (Number(it.discount) || 0)) / 100
    : (Number(it.discount) || 0);
  const net = Math.max(0, gross - disc);
  return net + (net * (Number(it.taxRate) || 0)) / 100;
}

export function itemsForDialog(items, currency) {
  return (items || []).map((it) => ({
    ...it,
    unitPriceText: money(it.unitPrice, currency),
    amountText: money(lineAmount(it), currency),
  }));
}

// Subtotal/discount/tax are only worth a row when they are not zero — a
// document with no discount should not carry an empty "Discount 0.00" line.
export function totalsForDialog(doc, currency) {
  return [
    { label: 'Subtotal', value: money(doc.subtotal, currency) },
    Number(doc.discountTotal) > 0 ? { label: 'Discount', value: '− ' + money(doc.discountTotal, currency) } : null,
    Number(doc.taxTotal) > 0 ? { label: 'Tax', value: money(doc.taxTotal, currency) } : null,
    { label: 'Total', value: money(doc.grandTotal, currency), strong: true },
  ].filter(Boolean);
}
