import { tr } from '../lib/i18n.jsx';
import './LeavePool.css';

// One yearly leave total (backend leavePool.service.js), shown the same way
// everywhere: the total agreed, less that year's company holidays, is what
// can be taken; then what was taken, what is waiting, what is left — and
// what is owed when more was taken than there was.
//
// Three pieces: a ring (days left of the days to take, or days owed), the
// sum written out as chips (total − holidays = to take), and one bar for
// the whole year (holidays, taken, waiting, left, and owed past its end).

export function poolLeftNow(p) {
  return p ? p.available - p.used - p.pending : 0;
}

function plural(n, one, many) { return n === 1 ? one : many; }

// Ring: the share of the days to take still left; amber with a minus when
// more was taken than there was.
export function PoolRing({ pool, size = 116 }) {
  const avail = Math.max(0, pool.available);
  const owing = pool.owedOutstanding > 0;
  const share = owing ? 1 : avail > 0 ? Math.max(0, Math.min(1, pool.left / avail)) : 0;
  const r = 44, c = 2 * Math.PI * r;
  return (
    <span className={'lpl-ring' + (owing ? ' is-owing' : pool.left === 0 ? ' is-empty' : '')} style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle className="lpl-ring-track" cx="50" cy="50" r={r} />
        <circle className="lpl-ring-fill" cx="50" cy="50" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - share)} />
      </svg>
      <span className="lpl-ring-text">
        <strong>{owing ? '−' + pool.owedOutstanding : pool.left}</strong>
        <small>{owing ? plural(pool.owedOutstanding, tr('day owed'), tr('days owed')) : plural(pool.left, tr('day left'), tr('days left'))}</small>
      </span>
    </span>
  );
}

// Bar: the whole year at a glance. Its length is the total, or what was
// used if that is more (the owed part runs past the total's end mark).
export function PoolBar({ pool, slim = false }) {
  const holidays = Math.min(pool.holidays, pool.total);
  const span = Math.max(pool.total, holidays + pool.used + pool.pending, 1);
  const pct = (n) => (Math.max(0, n) / span) * 100 + '%';
  const takenIn = Math.min(pool.used, Math.max(0, pool.available));
  const waitingIn = Math.min(pool.pending, Math.max(0, pool.available - takenIn));
  const over = Math.max(0, pool.used + pool.pending - Math.max(0, pool.available));
  const left = Math.max(0, pool.available - pool.used - pool.pending);
  return (
    <span className={'lpl-bar' + (slim ? ' is-slim' : '')} role="img"
      aria-label={tr('{h} company holidays, {u} taken, {w} waiting, {l} left, {o} over', { h: pool.holidays, u: pool.used, w: pool.pending, l: left, o: over })}>
      <i className="lpl-seg is-holidays" style={{ width: pct(holidays) }} title={tr('{n} company holidays', { n: pool.holidays })} />
      <i className="lpl-seg is-taken" style={{ width: pct(takenIn) }} title={tr('{n} taken', { n: pool.used })} />
      <i className="lpl-seg is-waiting" style={{ width: pct(waitingIn) }} title={tr('{n} waiting for approval', { n: pool.pending })} />
      <i className="lpl-seg is-left" style={{ width: pct(left) }} title={tr('{n} left', { n: left })} />
      <i className="lpl-seg is-over" style={{ width: pct(over) }} title={tr('{n} over the total', { n: over })} />
      {over > 0 && <b className="lpl-bar-end" style={{ left: pct(pool.total) }} aria-hidden="true" />}
    </span>
  );
}

export default function LeavePool({ pool, mine = false, compact = false }) {
  if (!pool || !pool.inEffect) return null;
  const leftAfterWaiting = Math.max(0, pool.available - pool.used - pool.pending);
  const owing = pool.owedOutstanding > 0;
  return (
    <div className={'lpl' + (compact ? ' is-compact' : '') + (owing ? ' is-owing' : '')}>
      <div className="lpl-top">
        <PoolRing pool={pool} size={compact ? 92 : 116} />
        <div className="lpl-main">
          <span className="lpl-eyebrow">{mine ? tr('Your leave in {year}', { year: pool.year }) : tr('Leave in {year}', { year: pool.year })}</span>
          <div className="lpl-eq" aria-label={tr('How the leave balance is worked out')}>
            <span className="lpl-chip">
              <strong>{pool.total}</strong>
              <small>{pool.totalFrom === 'company' ? tr('yearly total (company)') : tr('yearly total')}</small>
            </span>
            <span className="lpl-op" aria-hidden="true">−</span>
            <span className="lpl-chip is-holidays">
              <strong>{pool.holidays}</strong>
              <small>{tr('company holidays in {year}', { year: pool.year })}</small>
            </span>
            <span className="lpl-op" aria-hidden="true">=</span>
            <span className="lpl-chip is-key">
              <strong>{Math.max(0, pool.available)}</strong>
              <small>{tr('days to take')}</small>
            </span>
          </div>
          <PoolBar pool={pool} />
          <div className="lpl-legend">
            <span><i className="lpl-dot is-holidays" />{tr('{n} holidays', { n: pool.holidays })}</span>
            <span><i className="lpl-dot is-taken" />{tr('{n} taken', { n: pool.used })}</span>
            {pool.pending > 0 && <span><i className="lpl-dot is-waiting" />{tr('{n} waiting for approval', { n: pool.pending })}</span>}
            <span><i className="lpl-dot is-left" />{tr('{n} left', { n: pool.left })}{pool.pending > 0 ? ' · ' + tr('{n} if the waiting ones are approved', { n: leftAfterWaiting }) : ''}</span>
            {pool.owed > 0 && (owing
              ? <span className="lpl-owed"><i className="lpl-dot is-over" />{tr('{n} owed to the company', { n: pool.owedOutstanding })}{pool.settled > 0 ? ' · ' + tr('{n} settled', { n: pool.settled }) : ''}</span>
              : <span className="lpl-settled"><i className="lpl-dot is-settled" />{tr('{n} day(s) owed, all settled', { n: pool.owed })}</span>)}
          </div>
        </div>
      </div>
      {!compact && (
        <p className="lpl-note">
          {mine
            ? tr('Annual, compassionate and sick leave all come out of this total. The year\'s company holidays are part of it, so they are taken off on 1 January; a holiday added or removed during the year changes it at once. Taking more than is left is allowed: the extra days are owed to the company, and HR settles them.')
            : tr('Annual, compassionate and sick leave all come out of this total. The year\'s company holidays are taken off on 1 January, and the balance follows the holiday list as it changes. More than is left can be taken: the extra days are owed and settled by HR.')}
        </p>
      )}
    </div>
  );
}

// The request form's answer, and the approver's: what the request leaves,
// or what it would have them owe.
export function PoolVerdict({ days, left, owe, who }) {
  const owing = owe > 0;
  return (
    <div className={'lpl-verdict' + (owing ? ' is-owing' : '')} role="status">
      <span className="lpl-verdict-icon" aria-hidden="true">
        {owing
          ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>
          : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}
      </span>
      <span className="lpl-verdict-steps">
        <span className="lpl-mini"><strong>{left}</strong><small>{tr('left now')}</small></span>
        <span className="lpl-op" aria-hidden="true">−</span>
        <span className="lpl-mini"><strong>{days}</strong><small>{tr('this request')}</small></span>
        <span className="lpl-op" aria-hidden="true">=</span>
        <span className={'lpl-mini is-result' + (owing ? ' is-owing' : '')}><strong>{owing ? '−' + owe : left - days}</strong><small>{owing ? tr('owed') : tr('left after')}</small></span>
      </span>
      <span className="lpl-verdict-text">
        {owing
          ? (who
            ? tr('Approving this means {name} owes the company {n} day(s), for HR to settle.', { name: who, n: owe })
            : tr('If it is approved you will owe the company {n} day(s). You can still send it; HR settles owed days.', { n: owe }))
          : (who ? tr('{name} keeps {n} day(s) after this.', { name: who, n: left - days }) : tr('You keep {n} day(s) after this.', { n: left - days }))}
      </span>
    </div>
  );
}
