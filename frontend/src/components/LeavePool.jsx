import { tr } from '../lib/i18n.jsx';
import './LeavePool.css';

// One yearly leave total (backend leavePool.service.js), shown the same way
// everywhere: the total agreed, less that year's company holidays, is what
// can be taken; then what was taken, what is waiting, what is left — and
// what is owed when more was taken than there was.

export function poolLeftNow(p) {
  return p ? p.available - p.used - p.pending : 0;
}

export default function LeavePool({ pool, mine = false, compact = false }) {
  if (!pool || !pool.inEffect) return null;
  const leftAfterWaiting = Math.max(0, pool.available - pool.used - pool.pending);
  return (
    <div className={'lpl' + (compact ? ' is-compact' : '') + (pool.owedOutstanding > 0 ? ' is-owing' : '')}>
      <div className="lpl-sum" aria-label={tr('How the leave balance is worked out')}>
        <span className="lpl-term">
          <strong>{pool.total}</strong>
          <small>{pool.totalFrom === 'company' ? tr('yearly total (company)') : tr('yearly total')}</small>
        </span>
        <span className="lpl-op" aria-hidden="true">−</span>
        <span className="lpl-term">
          <strong>{pool.holidays}</strong>
          <small>{tr('company holidays in {year}', { year: pool.year })}</small>
        </span>
        <span className="lpl-op" aria-hidden="true">=</span>
        <span className="lpl-term is-key">
          <strong>{Math.max(0, pool.available)}</strong>
          <small>{tr('days to take')}</small>
        </span>
      </div>
      <div className="lpl-facts">
        <span><strong>{pool.used}</strong> {tr('taken')}</span>
        {pool.pending > 0 && <span><strong>{pool.pending}</strong> {tr('waiting for approval')}</span>}
        <span className="lpl-left"><strong>{pool.left}</strong> {tr('left')}{pool.pending > 0 ? ' · ' + tr('{n} if the waiting ones are approved', { n: leftAfterWaiting }) : ''}</span>
        {pool.owed > 0 && (pool.owedOutstanding > 0 ? (
          <span className="lpl-owed">
            <strong>{pool.owedOutstanding}</strong> {tr('owed to the company')}
            {pool.settled > 0 ? ' · ' + tr('{n} settled', { n: pool.settled }) : ''}
          </span>
        ) : (
          <span className="lpl-settled">{tr('{n} day(s) owed, all settled', { n: pool.owed })}</span>
        ))}
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
