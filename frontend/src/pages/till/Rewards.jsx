import { useEffect, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';

// A customer's loyalty points on the till (backend restaurantLoyalty): what
// they have, the rewards they can have now (put on the bill as a discount;
// the points are taken when the sale is paid), and their last points.

const KIND = { earn: () => tr('Earned'), redeem: () => tr('Spent'), refund: () => tr('Refund'), adjust: () => tr('Changed by a manager') };

export default function Rewards({ token, guest, applied, onApply, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    posFetch('GET', '/pos/loyalty/' + guest.id, token).then(setData).catch((e) => setError(e.message));
  }, [guest.id, token]);
  const next = data ? data.rewards.filter((r) => !r.can).sort((a, b) => a.points - b.points)[0] : null;
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog pos-panel lo" role="dialog" aria-modal="true" aria-labelledby="lo-title" onClick={(e) => e.stopPropagation()}>
        <header className="lo-head">
          <span className="lo-star" aria-hidden="true">⭐</span>
          <div>
            <h2 id="lo-title">{guest.name}</h2>
            <p className="dk-muted">{data ? tr('A point for every {amount} spent.', { amount: money(data.spend) }) : tr('Loading…')}</p>
          </div>
          <div className="lo-points"><b>{data ? data.balance : '·'}</b><small>{tr('points')}</small></div>
        </header>
        {error && <div className="error-banner">{error}</div>}
        {data && next && (
          <div className="lo-next">
            <span>{tr('{n} more points to {reward}', { n: next.points - data.balance, reward: next.name })}</span>
            <i style={{ '--p': Math.min(100, Math.round((data.balance / next.points) * 100)) + '%' }} aria-hidden="true" />
          </div>
        )}
        {data && (
          <ul className="lo-rewards is-plain">
            {data.rewards.map((r) => {
              const on = applied === r.presetId;
              return (
                <li key={r.id} className={(r.can ? 'is-can' : 'is-not') + (on ? ' is-on' : '')}>
                  <span className="lo-r-ico" aria-hidden="true">{r.kind === 'percent' ? '%' : '🎁'}</span>
                  <span className="lo-r-text"><strong>{r.name}</strong><small>{r.kind === 'percent' ? tr('{n}% off the bill', { n: r.value }) : tr('{amount} off the bill', { amount: money(r.value) })} · {tr('{n} points', { n: r.points })}</small></span>
                  {on ? <button type="button" className="btn btn-secondary tl-btn" onClick={() => onApply(null)}>{tr('Take it off')}</button>
                    : <button type="button" className="btn btn-primary tl-btn" disabled={!r.can} onClick={() => onApply(r.presetId, r.name)}>{tr('Use it')}</button>}
                </li>
              );
            })}
          </ul>
        )}
        {data && data.entries.length > 0 && (
          <details className="lo-history">
            <summary>{tr('Their last points')}</summary>
            <ul className="is-plain">
              {data.entries.map((x) => (
                <li key={x.id}><span>{(KIND[x.kind] || KIND.adjust)()}{x.reward ? ' · ' + x.reward : ''}{x.orderNo ? ' · ' + x.orderNo : ''}<small>{new Date(x.createdAt).toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' })}</small></span>
                  <b className={x.points < 0 ? 'lo-out' : 'lo-in'}>{x.points > 0 ? '+' : ''}{x.points}</b></li>
              ))}
            </ul>
          </details>
        )}
        <p className="dk-muted tl-small">{tr('Points are taken when the sale is paid.')}</p>
        <div className="dialog-actions"><button type="button" className="btn btn-primary" onClick={onClose}>{tr('Done')}</button></div>
      </div>
    </div>
  );
}
