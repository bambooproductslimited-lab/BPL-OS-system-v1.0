import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../components/DashKit';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';

// The till settings' loyalty and gift card reports (TillSettings.jsx;
// backend restaurantLoyalty.report / adjust and restaurantGiftCards.report,
// a manager's PIN in the body): who has points and what they spent them
// on, a manager's points given or taken (saying why); the gift cards sold,
// what is left on them, and what was spent.

function when(iso) { return iso ? new Date(iso).toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }

function useReport(path, token, pin, q, onFail) {
  const [data, setData] = useState(null);
  const load = useCallback(() => posFetch('POST', path, token, { managerPin: pin || undefined, q: q || undefined }).then(setData).catch(onFail), [path, token, pin, q, onFail]);
  useEffect(() => { const t = setTimeout(load, q ? 300 : 0); return () => clearTimeout(t); }, [load, q]);
  return [data, load];
}

export function LoyaltyReport({ token, pin, onFail }) {
  const [q, setQ] = useState('');
  const [data, reload] = useReport('/pos/settings/loyalty', token, pin, q.trim(), onFail);
  const [adj, setAdj] = useState(null); // { member, points, note }
  const [busy, setBusy] = useState(false);
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await posFetch('POST', '/pos/settings/loyalty/' + adj.member.id + '/adjust', token, { managerPin: pin || undefined, points: Number(adj.points), note: adj.note });
      setAdj(null); reload();
    } catch (err) { onFail(err); } finally { setBusy(false); }
  }
  if (!data) return <section className="ts-sec"><p className="dk-muted">{tr('Loading…')}</p></section>;
  const t = data.totals;
  const most = Math.max(1, ...data.rewards.map((r) => r.times));
  return (
    <section className="ts-sec ts-lo">
      <div className="ts-act-sum">
        <span className="is-sales"><b>{t.members}</b>{tr('customers with points')}</span>
        <span><b>{t.givenMonth.toLocaleString(activeIntlLocale())}</b>{tr('points earned this month')}</span>
        <span><b>{t.spentMonth.toLocaleString(activeIntlLocale())}</b>{tr('points spent this month')}</span>
        <span className="is-kitchen"><b>{t.outstanding.toLocaleString(activeIntlLocale())}</b>{tr('points not spent yet')}</span>
      </div>
      {data.rewards.length > 0 && (
        <div className="ts-lo-rewards">
          <h3>{tr('Rewards taken')}</h3>
          <ul className="is-plain">
            {data.rewards.map((r) => (
              <li key={r.name}>
                <span>{r.name}</span>
                <i aria-hidden="true"><b style={{ width: Math.max(6, (r.times / most) * 100) + '%' }} /></i>
                <small>{r.times === 1 ? tr('once') : tr('{n} times', { n: r.times })} · {tr('{n} points', { n: r.points })}</small>
              </li>
            ))}
          </ul>
        </div>
      )}
      <input className="input ts-lo-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Find a customer by name or phone')} aria-label={tr('Find a customer')} />
      {!data.members.length ? <div className="dk-empty"><Icon name="star" /><p>{q ? tr('Nobody with points matches.') : tr('No customer has earned points yet. Turn loyalty on in Bookings, tips and rewards.')}</p></div> : (
        <ul className="ts-ac-list ts-lo-list">
          {data.members.map((m, i) => (
            <li key={m.id}>
              <span className={'ts-lo-rank' + (i < 3 && !q ? ' is-top' : '')} aria-hidden="true">{i < 3 && !q ? ['🥇', '🥈', '🥉'][i] : i + 1}</span>
              <span className="ts-ac-main"><strong>{m.name}</strong>
                <small>{[m.phone, m.visits === 1 ? tr('1 visit') : tr('{n} visits', { n: m.visits }), tr('earned {n}', { n: m.earned }), m.spent ? tr('spent {n}', { n: m.spent }) : null, m.lastAt ? tr('last {date}', { date: when(m.lastAt) }) : null].filter(Boolean).join(' · ')}</small></span>
              <b className="ts-ac-amt ts-lo-pts">⭐ {m.balance.toLocaleString(activeIntlLocale())}</b>
              <button type="button" className="pos-link" onClick={() => setAdj({ member: m, points: '', note: '' })}>{tr('Give or take points')}</button>
            </li>
          ))}
        </ul>
      )}
      {adj && (
        <div className="dialog-backdrop" onClick={() => !busy && setAdj(null)}>
          <form className="dialog pos-panel" role="dialog" aria-modal="true" aria-labelledby="lo-adj-title" onClick={(e) => e.stopPropagation()} onSubmit={save}>
            <h2 id="lo-adj-title">{tr('Points for {name}', { name: adj.member.name })}</h2>
            <p className="dk-muted">{tr('They have {n} points. A minus takes points off.', { n: adj.member.balance })}</p>
            <div className="field"><label htmlFor="lo-adj-pts">{tr('Points')}</label><input id="lo-adj-pts" className="input" type="number" required autoFocus value={adj.points} onChange={(e) => setAdj({ ...adj, points: e.target.value })} placeholder="50" /></div>
            <div className="field"><label htmlFor="lo-adj-note">{tr('Why')}</label><input id="lo-adj-note" className="input" required minLength={3} maxLength={200} value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} placeholder={tr('e.g. Sorry for the long wait')} /></div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setAdj(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={busy || !Number(adj.points)}>{tr('Save')}</button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}

const STATUS = { active: () => tr('Active'), void: () => tr('Cancelled'), used: () => tr('Used up') };

export function GiftCardsReport({ token, pin, onFail }) {
  const [q, setQ] = useState('');
  const [data] = useReport('/pos/settings/gift-cards', token, pin, q.trim(), onFail);
  if (!data) return <section className="ts-sec"><p className="dk-muted">{tr('Loading…')}</p></section>;
  const t = data.totals;
  return (
    <section className="ts-sec ts-gcr">
      <div className="ts-act-sum">
        <span className="is-sales"><b>{money(t.sold)}</b>{t.cards === 1 ? tr('sold on 1 card') : tr('sold on {n} cards', { n: t.cards })}</span>
        <span><b>{money(t.soldMonth)}</b>{tr('sold this month')}</span>
        <span><b>{money(t.spent)}</b>{tr('spent at the till')}</span>
        <span className="is-kitchen"><b>{money(t.outstanding)}</b>{tr('still on the cards')}</span>
        {t.voided > 0 && <span className="is-refunds"><b>{money(t.voided)}</b>{tr('given back on cancelled cards')}</span>}
      </div>
      <p className="dk-muted ts-gcr-note">{tr('A card sold is money in the drawer, not a sale; the sale is counted when the card is spent. What is still on the cards is owed to their holders.')}</p>
      <input className="input ts-lo-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Find a card by name or its last 4 digits')} aria-label={tr('Find a card')} />
      {!data.cards.length ? <div className="dk-empty"><Icon name="card" /><p>{q ? tr('No card matches.') : tr('No gift card sold yet. Turn gift cards on in Bookings, tips and rewards.')}</p></div> : (
        <ul className="ts-ac-list ts-gcr-list">
          {data.cards.map((c) => {
            const status = c.status === 'void' ? 'void' : c.balance <= 0 ? 'used' : 'active';
            return (
              <li key={c.id} className={'is-' + status}>
                <span className="ts-gcr-chip" aria-hidden="true">🎁</span>
                <span className="ts-ac-main"><strong>•••• {c.code.slice(-4)}{c.toName ? ' · ' + c.toName : ''}</strong>
                  <small>{[when(c.createdAt), c.soldBy, c.soldMethod === 'cash' ? tr('Cash') : tr('Mobile Money'), c.fromName ? tr('from {name}', { name: c.fromName }) : null].filter(Boolean).join(' · ')}</small>
                  <i className="ts-gcr-bar" aria-hidden="true"><b style={{ width: Math.max(0, Math.min(100, (c.balance / c.amount) * 100)) + '%' }} /></i></span>
                <span className={'ts-ac-tag is-' + status}>{STATUS[status]()}</span>
                <b className="ts-ac-amt">{money(c.balance)}<small>{tr('of {amount}', { amount: money(c.amount) })}</small></b>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
