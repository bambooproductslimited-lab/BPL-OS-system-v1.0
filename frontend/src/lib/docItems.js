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

// The rows that explain the gap between Subtotal and Total on a printed
// document: what was taken off, and what was added.
//
// The stored figures are a combined discountTotal and a combined taxTotal,
// plus the document-level discount and tax rate as they were entered. That
// is enough to separate the two, and separating them matters: "Less 10% on
// the total" and "Less GHS 50" are different promises to a customer, and a
// document that shows neither is asking to be queried.
export function adjustmentRows(doc, currency) {
  const subtotal = Number(doc.subtotal) || 0;
  const discountTotal = Number(doc.discountTotal) || 0;
  const taxTotal = Number(doc.taxTotal) || 0;

  const docDisc = doc.discount || {};
  const docDiscValue = Number(docDisc.value) || 0;

  // Separating the two halves of discountTotal takes a little algebra,
  // because a percentage document discount is charged on what is left AFTER
  // the line discounts (backend utils/documents.js):
  //
  //   T = L + (S - L) * r        T = discountTotal, L = line discounts,
  //                              S = subtotal, r = the rate as a fraction
  //   T = L(1 - r) + S*r
  //   L = (T - S*r) / (1 - r)
  //
  // Guessing at this rather than solving it is what produced a phantom
  // "Discount on items GHS 10.00" on an invoice whose items carried no
  // discount at all.
  let itemDiscounts;
  let docDiscAmount;
  if (docDisc.type === 'percent' && docDiscValue) {
    const r = docDiscValue / 100;
    itemDiscounts = r >= 1 ? 0 : (discountTotal - subtotal * r) / (1 - r);
    itemDiscounts = Math.max(0, itemDiscounts);
    docDiscAmount = Math.max(0, discountTotal - itemDiscounts);
  } else {
    docDiscAmount = Math.min(docDiscValue, discountTotal);
    itemDiscounts = Math.max(0, discountTotal - docDiscAmount);
  }

  const discountRows = [];
  if (itemDiscounts > 0.005) discountRows.push({ label: 'Discount on items', value: money(itemDiscounts, currency) });
  if (docDiscAmount > 0.005) {
    discountRows.push({
      label: docDisc.type === 'percent' ? 'Discount (' + docDiscValue + '%)' : 'Discount',
      value: money(docDiscAmount, currency),
    });
  }

  const docTaxRate = Number(doc.taxRate) || 0;
  const taxRows = taxTotal > 0.005
    ? [{ label: docTaxRate ? 'Tax (' + docTaxRate + '%)' : 'Tax', value: money(taxTotal, currency) }]
    : [];

  return { discountRows, taxRows };
}
