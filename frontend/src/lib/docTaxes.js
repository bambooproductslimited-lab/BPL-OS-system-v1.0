import { api } from '../api/client';

// The taxes a quotation, estimate or invoice can charge by name — VAT, NHIL,
// GETFund and any others set up in Billing settings — for the document
// editor's tax switches (components/DocTaxes.jsx). Withholding tax is left
// out: the customer holds it back from what they pay, it is never added to
// a bill. So is a 0% rate. Asked again after a minute, so a tax just added
// in Billing settings shows up without a reload.
let cached = null;
let cachedAt = 0;
export function companyTaxes() {
  if (!cached || Date.now() - cachedAt > 60000) {
    cachedAt = Date.now();
    cached = api.get('/commercial-settings/tax-rates')
      .then((list) => (list || []).filter((t) => !t.withheld && Number(t.rate) > 0))
      .catch((e) => { cached = null; throw e; });
  }
  return cached;
}

// Ghana's usual three, when all are set up: VAT with NHIL and GETFund, each
// on the same amount (20% together since 2026).
export function standardSet(taxes) {
  const find = (re) => (taxes || []).find((t) => re.test(String(t.name || '')));
  const set = [find(/^vat\b/i), find(/nhil/i), find(/getfund|get\s*fund/i)];
  return set.every(Boolean) ? set : null;
}

export const sameTax = (a, b) => (a.id && b.id ? a.id === b.id : String(a.name || '').trim().toLowerCase() === String(b.name || '').trim().toLowerCase());
export const sumRates = (list) => Math.round((list || []).reduce((s, t) => s + (Number(t.rate) || 0), 0) * 1000) / 1000;
