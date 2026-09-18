import { money } from './currency';

// Mirrors the line-total formula used everywhere else in the doc wizard
// (qty * unitPrice, minus the line's own discount, tax excluded) — kept
// here so groupPackageItems doesn't depend on callers passing it in.
// What the line is worth before anything is taken off it. The Amount column
// used to show the figure AFTER the line's discount, while the Subtotal row
// showed the figure before — so a customer adding up the column got a
// different number from the Subtotal printed beneath it, and a line reading
// "3 x GHS 120.00 = GHS 324.00" looked like an arithmetic mistake. The
// column is gross now, the discount is stated on its own line, and the two
// reconcile.
function lineGross(it) {
  return (Number(it.qty) || 0) * (Number(it.unitPrice) || 0);
}

function lineDiscountAmount(it) {
  const gross = lineGross(it);
  return it.discountType === 'percent'
    ? (gross * (Number(it.discount) || 0)) / 100
    : Number(it.discount) || 0;
}

// Spelled out under the description, so a discount is never silently applied.
function discountNote(it, currency) {
  const amt = lineDiscountAmount(it);
  if (!amt) return '';
  const basis = it.discountType === 'percent' ? (Number(it.discount) || 0) + '% off' : 'discount';
  return 'Less ' + basis + ': ' + money(amt, currency);
}

function taxNote(it, currency) {
  const rate = Number(it.taxRate) || 0;
  if (!rate) return '';
  const taxable = Math.max(0, lineGross(it) - lineDiscountAmount(it));
  return 'Tax ' + rate + '%: ' + money((taxable * rate) / 100, currency);
}

// Groups line items that share a non-empty packageLabel into one display
// row with a single combined price (Square's "package" bundling) — items
// stay individually priced/tracked in the stored data; this only changes
// what a customer-facing preview (DocPreview/SharePage) renders. Returns
// display rows already formatted with `money()`, matching what those
// components expect in their `items` prop.
export function groupPackageItems(items, currency) {
  const order = [];
  const packageIndex = new Map();
  (items || []).forEach((it) => {
    const label = (it.packageLabel || '').trim();
    const total = lineGross(it);
    if (!label) {
      order.push({
        description: it.description, notes: it.notes, qty: it.qty, unitPrice: it.unitPrice, total,
        discountNote: discountNote(it, currency), taxNote: taxNote(it, currency), isPackage: false,
      });
      return;
    }
    let group = packageIndex.get(label);
    if (!group) {
      group = { description: label, names: [], total: 0, discountAmount: 0, isPackage: true };
      packageIndex.set(label, group);
      order.push(group);
    }
    group.total += total;
    group.discountAmount += lineDiscountAmount(it);
    group.names.push(it.description);
  });
  return order.map((g) => (g.isPackage
    ? {
        description: g.description, notes: 'Includes: ' + g.names.join(', '),
        qty: '', unitPrice: '', lineTotal: money(g.total, currency),
        discountNote: g.discountAmount ? 'Less discount: ' + money(g.discountAmount, currency) : '',
        taxNote: '',
      }
    : {
        description: g.description, notes: g.notes, qty: g.qty,
        unitPrice: money(g.unitPrice, currency), lineTotal: money(g.total, currency),
        discountNote: g.discountNote, taxNote: g.taxNote,
      }));
}
