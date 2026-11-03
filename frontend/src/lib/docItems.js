import { money } from './currency';
import { formatDocDate } from './dates';
import { tr, docTr, msg } from './i18n.jsx';

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

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// The taxes a document charges, one entry each, from what it stores: its
// totals, its tax rate and its taxes by name (taxComponents: VAT, NHIL,
// GETFund…, each a rate on the amount after discounts — backend
// utils/documents.js docTaxOf, migration 0212). First the tax its own lines
// carry, if any; then each tax on the whole amount — or one plain rate. The
// last takes the odd cent, so they always add up to the document's tax
// total. The same arithmetic as the backend's taxLines (the emailed PDF).
// Returns [{ name, rate, amount, onItems, alone }]: name '' for a plain rate.
export function taxBreakdown(doc) {
  const taxTotal = round2(doc && doc.taxTotal);
  if (!(taxTotal > 0.005)) return [];
  const rate = Number(doc.taxRate) || 0;
  const base = Math.max(0, (Number(doc.subtotal) || 0) - (Number(doc.discountTotal) || 0));
  let whole = rate > 0 ? Math.min(taxTotal, round2((base * rate) / 100)) : 0;
  let onItems = round2(taxTotal - whole);
  // A cent's difference is the rounding of the stored totals, not a tax.
  if (whole > 0 && onItems <= 0.01) { whole = taxTotal; onItems = 0; }
  const out = [];
  if (onItems > 0) out.push({ name: '', rate: null, amount: onItems, onItems: true, alone: !(whole > 0) });
  if (whole > 0) {
    const comps = ((doc && doc.taxComponents) || []).filter((t) => Number(t.rate) > 0);
    if (!comps.length) out.push({ name: '', rate, amount: whole, onItems: false });
    else {
      const sum = comps.reduce((s, t) => s + Number(t.rate), 0);
      let given = 0;
      comps.forEach((t, i) => {
        const amount = i === comps.length - 1 ? round2(whole - given) : round2((whole * Number(t.rate)) / sum);
        given = round2(given + amount);
        out.push({ name: t.name, rate: Number(t.rate), amount, onItems: false });
      });
    }
  }
  return out;
}

// A tax's line label: "VAT (15%)", "Tax (20%)", "Tax on items" — through
// tr (on screen, the reader's language) or docTr (the printed document).
export function taxLabel(t, t9 = tr) {
  if (t.onItems) return t.alone ? t9(msg('Tax')) : t9(msg('Tax on items'));
  return t.name ? t9(msg('{name} ({n}%)'), { name: t.name, n: t.rate }) : t9(msg('Tax ({n}%)'), { n: t.rate });
}

// Subtotal/discount/tax are only worth a row when they are not zero — a
// document with no discount should not carry an empty "Discount 0.00" line.
export function totalsForDialog(doc, currency) {
  return [
    // On-screen (the row's detail panel), so these follow the reader.
    { label: tr('Subtotal'), value: money(doc.subtotal, currency) },
    Number(doc.discountTotal) > 0 ? { label: tr('Discount'), value: '− ' + money(doc.discountTotal, currency) } : null,
    // Each tax by name — VAT, NHIL, GETFund — as the document charges them.
    ...taxBreakdown(doc).map((t) => ({ label: taxLabel(t), value: money(t.amount, currency) })),
    { label: tr('Total'), value: money(doc.grandTotal, currency), strong: true },
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
// For the printed document, so docTr — see the note on totalsForDialog.
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
  if (itemDiscounts > 0.005) discountRows.push({ label: docTr('Discount on items'), value: money(itemDiscounts, currency) });
  if (docDiscAmount > 0.005) {
    discountRows.push({
      label: docDisc.type === 'percent' ? docTr('Discount ({n}%)', { n: docDiscValue }) : docTr('Discount'),
      value: money(docDiscAmount, currency),
    });
  }

  // One row per tax: "VAT (15%)", "NHIL (2.5%)", "GETFund (2.5%)" — what a
  // customer (and a VAT inspector) looks for — or the one plain rate.
  const taxRows = taxTotal > 0.005
    ? taxBreakdown(doc).map((t) => ({ label: taxLabel(t, docTr), value: money(t.amount, currency) }))
    : [];

  return { discountRows, taxRows };
}

// Payments formatted for a document: the date it was received, how, and the
// reference — not just a total. A customer querying a balance asks "which
// payment, and when", and a lump sum cannot answer that.
export function paymentsForDocument(payments, currency) {
  return (payments || []).map((p) => {
    // A refund (a credit note's money going back) is a negative payment:
    // shown as money returned, adding back to what the total has to cover.
    const refund = p.refund || Number(p.amount) < 0;
    return {
      id: p.id,
      date: formatDocDate(p.date),
      amount: money(Math.abs(Number(p.amount)), currency),
      label: refund ? docTr('Refunded') : docTr('Payment received'),
      sign: refund ? '+' : '−',
      refund,
      methodLabel: String(p.method || '').replace(/_/g, ' '),
      reference: p.reference || '',
    };
  });
}

// What credit notes took off an invoice, as a row before its payments.
export function creditRows(doc, currency) {
  const n = Number(doc && doc.creditTotal) || 0;
  return n > 0.005 ? [{ label: docTr('Credit notes'), value: '− ' + money(n, currency) }] : [];
}
