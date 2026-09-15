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
