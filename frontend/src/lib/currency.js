// Multi-currency: every quotation/estimate/invoice/sales order/payment/
// receipt now carries its own currency (chosen per document, defaulting
// from the customer — see backend/src/utils/documents.js's
// resolveCurrency()). This replaces the old hardcoded 'GHS ' + n.toLocaleString()
// strings scattered across the commercial pages with one shared formatter,
// and a helper for rendering the per-currency breakdown arrays the backend
// now returns from dashboard/report aggregations instead of one blended sum.

export function money(amount, currency) {
  var n = Number(amount) || 0;
  var code = currency || 'GHS';
  return code + ' ' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// [{ currency, amount }] -> "GHS 1,660.00 · USD 500.00 · EUR 600.00", or a
// fallback when the list is empty (a company that's never invoiced yet, or
// a viewer without the permission that populates it).
export function moneyBreakdown(list, emptyLabel) {
  if (!list || !list.length) return emptyLabel !== undefined ? emptyLabel : money(0);
  return list.map(function (r) { return money(r.amount, r.currency); }).join(' · ');
}
