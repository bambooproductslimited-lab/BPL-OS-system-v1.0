import { money } from './currency';

// Mirrors the line-total formula used everywhere else in the doc wizard
// (qty * unitPrice, minus the line's own discount, tax excluded) — kept
// here so groupPackageItems doesn't depend on callers passing it in.
function lineTotal(it) {
  const qty = Number(it.qty) || 0, price = Number(it.unitPrice) || 0;
  const line = qty * price;
  const disc = it.discountType === 'percent' ? (line * (Number(it.discount) || 0)) / 100 : Number(it.discount) || 0;
  return Math.max(0, line - disc);
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
    const total = lineTotal(it);
    if (!label) {
      order.push({ description: it.description, notes: it.notes, qty: it.qty, unitPrice: it.unitPrice, total, isPackage: false });
      return;
    }
    let group = packageIndex.get(label);
    if (!group) {
      group = { description: label, names: [], total: 0, isPackage: true };
      packageIndex.set(label, group);
      order.push(group);
    }
    group.total += total;
    group.names.push(it.description);
  });
  return order.map((g) => (g.isPackage
    ? { description: g.description, notes: 'Includes: ' + g.names.join(', '), qty: '', unitPrice: '', lineTotal: money(g.total, currency) }
    : { description: g.description, notes: g.notes, qty: g.qty, unitPrice: money(g.unitPrice, currency), lineTotal: money(g.total, currency) }));
}
