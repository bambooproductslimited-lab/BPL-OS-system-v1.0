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

// ── lease term totals ──────────────────────────────────────────────────────
// What a whole tenancy comes to: rent for every billing period between the
// start and end dates, plus the deposit. The lease dialog shows this as the
// dates and amounts are typed, so nobody has to multiply it out by hand and
// nobody signs a lease having mis-multiplied it.
//
// The arithmetic deliberately mirrors billingPeriod() in
// backend/src/services/pokiBilling.service.js, including the pro-rated final
// period. A figure that disagreed with what the rent run will actually
// invoice would be worse than showing nothing at all — the tenant would be
// quoted one number and billed another. authorization-adjacent tests aside,
// there is a test asserting the two agree (see poki-term-total below in
// backend/test/pokiTermTotal.test.js).

// Adds whole months, clamping the day so 31 Jan + 1 month is 28/29 Feb
// rather than rolling into March. Same rule as poki.service.js's addMonths.
function addMonths(iso, months) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

function addDays(iso, days) {
  const t = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

function daysInclusive(fromISO, toISO) {
  return Math.round(
    (new Date(toISO + 'T00:00:00Z').getTime() - new Date(fromISO + 'T00:00:00Z').getTime()) / 86400000
  ) + 1;
}

// Walks the lease period by period, exactly as the rent run will.
// Returns { periods, fullPeriods, partialPeriod, rentTotal } — or null when
// the inputs are not yet complete enough to mean anything, so the caller can
// simply render nothing rather than a misleading zero.
export function leaseRentTotal(startDate, endDate, rentAmount, cycle) {
  const rent = Number(rentAmount) || 0;
  const start = String(startDate || '').slice(0, 10);
  const end = String(endDate || '').slice(0, 10);
  if (!start || !end || end < start || rent <= 0) return null;

  // A one-off term is a single charge for the whole tenancy, not a rate.
  if (!CYCLE_MONTHS[cycle]) {
    return { periods: 1, fullPeriods: 1, partialPeriod: null, rentTotal: round2(rent) };
  }

  let cursor = start, total = 0, full = 0, partial = null, guard = 0;
  while (cursor <= end && guard++ < 600) {
    const fullEnd = addDays(addMonths(cursor, CYCLE_MONTHS[cycle]), -1);
    const isPartial = fullEnd > end;
    const periodEnd = isPartial ? end : fullEnd;
    const fullDays = daysInclusive(cursor, fullEnd);
    const billedDays = daysInclusive(cursor, periodEnd);
    const factor = isPartial && fullDays > 0 ? billedDays / fullDays : 1;

    total += rent * factor;
    if (isPartial) partial = { billedDays, fullDays, amount: round2(rent * factor) };
    else full += 1;

    cursor = addDays(fullEnd, 1);
  }

  return { periods: full + (partial ? 1 : 0), fullPeriods: full, partialPeriod: partial, rentTotal: round2(total) };
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
