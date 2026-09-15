// How a rent cycle reads next to an amount, e.g. "per month". The raw
// enum values ("annual", "semiannual") don't survive a naive "per " prefix,
// so both screens that show a rent figure share this instead of each
// patching the string their own way.
const PER_CYCLE = {
  monthly: 'per month',
  quarterly: 'per quarter',
  semiannual: 'per 6 months',
  annual: 'per year',
  one_off: 'one-off, for the term'
};

export function perCycle(cycle) {
  return PER_CYCLE[cycle] || 'per ' + String(cycle || '').replace(/_/g, ' ');
}

// How many months one billing cycle spans. Mirrors CYCLE_MONTHS in
// backend/src/services/poki.service.js — kept in step deliberately rather
// than fetched, because it is a fixed property of the cycle names, not
// configuration.
const CYCLE_MONTHS = { monthly: 1, quarterly: 3, semiannual: 6, annual: 12, one_off: 0 };

// Rent stated per cycle, expressed per month. Deposits are quoted in months
// of rent whatever the billing cycle, so an annual unit at GHS 24,000 has to
// resolve to GHS 2,000/month before "2 months deposit" means anything. A
// one-off term has no monthly rate, so the whole figure stands.
export function monthlyEquivalent(rent, cycle) {
  const amount = Number(rent) || 0;
  const months = CYCLE_MONTHS[cycle];
  if (!months) return Math.round(amount * 100) / 100;
  return Math.round((amount / months) * 100) / 100;
}
