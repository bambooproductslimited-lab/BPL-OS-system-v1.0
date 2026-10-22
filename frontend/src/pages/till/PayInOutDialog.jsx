import { useEffect, useMemo, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { tr } from '../../lib/i18n.jsx';
import { round2 } from './tillShared';

// Pay in / Pay out on the till: cash into or out of the drawer, and what
// it is for — the drawer itself (change, supplies, a delivery…), a
// customer's VIP account, or their IOU account (backend
// restaurantTillMoney):
//
//   in   VIP  money put down on their VIP balance (a top-up, in cash)
//        IOU  what they owe paid back: the IOUs ticked, all together
//   out  VIP  money on their VIP balance given back (a manager's PIN)
//        IOU  cash lent, owed on their IOU account within its limit
//
// Each account choice is offered only to someone whose till role may handle
// it (can). Done, the drawer is asked for again and handed to onDone.

function SearchList({ token, filter, picked, onPick, emptyText, render }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      posFetch('GET', '/pos/guests' + (q.trim() ? '?q=' + encodeURIComponent(q.trim()) : ''), token)
        .then((r) => { if (live) setRows(r.filter(filter)); }).catch(() => { if (live) setRows([]); });
    }, q ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  if (picked) return null;
  return (
    <div className="tl-pio-find">
      <input className="input" type="search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Find the customer: name or phone')} aria-label={tr('Find the customer: name or phone')} />
      <ul className="tl-pio-people is-plain">
        {rows && !rows.length && <li className="tl-pio-none">{emptyText}</li>}
        {(rows || []).map((g) => (
          <li key={g.id}>
            <button type="button" onClick={() => onPick(g)}>
              <span className="tl-pio-face" aria-hidden="true">{(g.name || '?').replace(/^zq\w*\s+/i, '').charAt(0)}</span>
              <span className="tl-pio-who"><strong>{g.name}</strong><small>{g.phone || '—'}</small></span>
              {render(g)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function PayInOutDialog({ token, direction, can, onClose, onDone, onUnauthorized }) {
  const inward = direction === 'in';
  const [account, setAccount] = useState('drawer'); // drawer | vip | iou
  const [guest, setGuest] = useState(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [pin, setPin] = useState('');
  const [ious, setIous] = useState(null); // the picked customer's open IOUs (pay in)
  const [ticked, setTicked] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false); // a new customer, to put VIP money down for
  const [fresh, setFresh] = useState({ name: '', phone: '' });

  function choose(a) { setAccount(a); setGuest(null); setAmount(''); setNote(''); setPin(''); setIous(null); setTicked({}); setError(null); setAdding(false); }
  useEffect(() => {
    if (!(guest && account === 'iou' && inward)) return;
    posFetch('GET', '/pos/ious?q=' + encodeURIComponent(guest.phone || guest.name), token).then((r) => {
      const mine = r.open.filter((x) => x.guestId === guest.id);
      setIous(mine); setTicked(Object.fromEntries(mine.map((x) => [x.id, true])));
    }).catch((e) => setError(e.message));
  }, [guest, account, inward, token]);

  const n = Number(amount);
  const iouTotal = useMemo(() => round2((ious || []).filter((x) => ticked[x.id]).reduce((s, x) => s + x.owed, 0)), [ious, ticked]);
  const lendable = guest && guest.iouLimit != null ? Math.max(0, round2(guest.iouLimit - guest.iouOwed)) : null;
  const sum = account === 'iou' && inward ? iouTotal : (amount !== '' && Number.isFinite(n) && n > 0 ? round2(n) : 0);
  let problem = null;
  if (account === 'vip' && !inward && guest && sum > guest.vipBalance + 0.004) problem = tr('{name} has {amount} on their VIP balance.', { name: guest.name, amount: money(guest.vipBalance) });
  if (account === 'iou' && !inward && guest && lendable != null && sum > lendable + 0.004) problem = tr('{name} can borrow up to {amount} more (IOU limit {limit}).', { name: guest.name, amount: money(lendable), limit: money(guest.iouLimit) });
  const ready = sum > 0 && !problem && (account === 'drawer' || guest) && (!(account === 'vip' && !inward) || pin.length === 4);

  async function addGuest() {
    setBusy(true); setError(null);
    try { const g = await posFetch('POST', '/pos/guests', token, { name: fresh.name.trim(), phone: fresh.phone.trim() }); setGuest(g); setAdding(false); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function save(e) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true); setError(null);
    try {
      let text;
      if (account === 'drawer') {
        await posFetch('POST', '/pos/drawer/movements', token, { direction, amount: sum, note: note.trim() });
        text = inward ? tr('Cash paid in recorded.') : tr('Cash paid out recorded.');
      } else if (account === 'vip' && inward) {
        const r = await posFetch('POST', '/pos/vip/topups', token, { guestId: guest.id, amount: sum, method: 'cash', note: note.trim() });
        text = tr('{amount} put down for {name}. VIP balance {balance}.', { amount: money(sum), name: guest.name, balance: money(r.balance) });
      } else if (account === 'vip') {
        const r = await posFetch('POST', '/pos/vip/cashouts', token, { guestId: guest.id, amount: sum, note: note.trim(), managerPin: pin });
        text = tr('{amount} given back to {name}. VIP balance {balance}.', { amount: money(sum), name: guest.name, balance: money(r.balance) });
      } else if (inward) {
        await posFetch('POST', '/pos/ious/pay', token, { ids: ious.filter((x) => ticked[x.id]).map((x) => x.id), method: 'cash' });
        text = tr('{amount} paid back by {name}.', { amount: money(sum), name: guest.name });
      } else {
        const r = await posFetch('POST', '/pos/ious/advances', token, { guestId: guest.id, amount: sum, note: note.trim() });
        text = tr('{amount} lent to {name} ({ref}). They owe {owed}.', { amount: money(sum), name: guest.name, ref: r.advance.orderNo, owed: money(r.owed) });
      }
      onDone(await posFetch('GET', '/pos/drawer', token), text);
    } catch (err) {
      if (err.status === 401) onUnauthorized(); else setError(err.message);
    } finally { setBusy(false); }
  }

  const FOR = [
    ['drawer', '💵', tr('The drawer'), inward ? tr('Change, a float top-up…') : tr('Supplies, a delivery, change…'), true],
    ['vip', '👑', tr('VIP account'), inward ? tr('Money put down on a VIP balance') : tr('VIP money given back'), can.vip],
    ['iou', '📒', tr('IOU account'), inward ? tr('Money owed, paid back') : tr('Cash lent, owed back'), inward ? can.iouIn : can.iouOut]
  ].filter((f) => f[4]);
  let go = tr('Save');
  if (guest && sum > 0) {
    if (account === 'vip') go = inward ? tr('Put down {amount} for {name}', { amount: money(sum), name: guest.name }) : tr('Give back {amount} to {name}', { amount: money(sum), name: guest.name });
    if (account === 'iou') go = inward ? tr('Received {amount} from {name}', { amount: money(sum), name: guest.name }) : tr('Lend {amount} to {name}', { amount: money(sum), name: guest.name });
  } else if (account === 'drawer' && sum > 0) go = inward ? tr('Pay in {amount}', { amount: money(sum) }) : tr('Pay out {amount}', { amount: money(sum) });

  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <form className={'dialog tl-dialog tl-pio is-' + direction} role="dialog" aria-modal="true" aria-labelledby="tl-pio-title" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="tl-pio-head">
          <span className={'tl-dialog-ico ' + (inward ? 'is-money' : 'is-out')} aria-hidden="true">{inward ? '⬇️' : '⬆️'}</span>
          <div><h2 id="tl-pio-title">{inward ? tr('Paid in') : tr('Paid out')}</h2>
            <p className="dk-muted">{inward ? tr('Cash coming into the drawer. What is it for?') : tr('Cash going out of the drawer. What is it for?')}</p></div>
        </div>
        <div className="tl-pio-for" role="radiogroup" aria-label={tr('What is it for?')} style={{ '--n': FOR.length }}>
          {FOR.map(([k, icon, label, sub]) => (
            <button key={k} type="button" role="radio" aria-checked={account === k} className={'is-' + k + (account === k ? ' is-on' : '')} onClick={() => choose(k)}>
              <span aria-hidden="true">{icon}</span><strong>{label}</strong><small>{sub}</small>
            </button>
          ))}
        </div>

        {account !== 'drawer' && !guest && !adding && (
          <SearchList token={token} picked={guest} onPick={setGuest}
            filter={account === 'vip' ? (inward ? () => true : (g) => g.vipBalance > 0) : inward ? (g) => g.iouOwed > 0 : (g) => g.iouAllowed}
            emptyText={account === 'vip' ? (inward ? tr('Nobody called that.') : tr('Nobody called that has VIP money.')) : inward ? tr('Nobody called that owes anything.') : tr('Nobody called that has an IOU account. A manager opens one in the till settings (Customers).')}
            render={(g) => account === 'vip'
              ? <span className={'tl-pio-bal' + (g.vipBalance > 0 ? ' is-vip' : '')}>{g.vip ? money(g.vipBalance) : tr('New VIP')}</span>
              : <span className={'tl-pio-bal' + (g.iouOwed > 0 ? ' is-owed' : '')}>{g.iouOwed > 0 ? tr('owes {amount}', { amount: money(g.iouOwed) }) : tr('owes nothing')}</span>} />
        )}
        {account === 'vip' && inward && !guest && (adding ? (
          <div className="tl-pio-new">
            <input className="input" autoFocus value={fresh.name} maxLength={100} onChange={(e) => setFresh({ ...fresh, name: e.target.value })} placeholder={tr('Customer name')} aria-label={tr('Customer name')} />
            <input className="input" type="tel" value={fresh.phone} maxLength={40} onChange={(e) => setFresh({ ...fresh, phone: e.target.value })} placeholder="024 000 0000" aria-label={tr('Phone')} />
            <button type="button" className="btn btn-secondary" disabled={busy || !fresh.name.trim()} onClick={addGuest}>{tr('Add')}</button>
          </div>
        ) : <button type="button" className="pos-link tl-pio-add" onClick={() => setAdding(true)}>＋ {tr('A new customer')}</button>)}

        {guest && (
          <div className={'tl-pio-picked is-' + account}>
            <span className="tl-pio-face" aria-hidden="true">{(guest.name || '?').replace(/^zq\w*\s+/i, '').charAt(0)}</span>
            <span className="tl-pio-who"><strong>{guest.name}</strong>
              <small>{account === 'vip' ? tr('VIP balance {amount}', { amount: money(guest.vipBalance) })
                : tr('Owes {amount}', { amount: money(guest.iouOwed) }) + (guest.iouLimit != null ? ' · ' + tr('limit {amount}', { amount: money(guest.iouLimit) }) : '')}</small></span>
            <button type="button" className="pos-link" onClick={() => { setGuest(null); setIous(null); }}>{tr('Change')}</button>
          </div>
        )}

        {account === 'iou' && inward && guest && (
          <div className="tl-pio-ious">
            <span className="tl-pio-label">{tr('What they are paying back')}</span>
            {!ious ? <p className="dk-muted">{tr('Loading…')}</p> : !ious.length ? <p className="dk-muted">{tr('{name} owes nothing.', { name: guest.name })}</p> : (
              <ul className="is-plain">
                {ious.map((x) => (
                  <li key={x.id}>
                    <label>
                      <input type="checkbox" checked={!!ticked[x.id]} onChange={(e) => setTicked({ ...ticked, [x.id]: e.target.checked })} />
                      <span><strong>{x.orderNo}</strong><small>{x.kind === 'advance' ? '💵 ' + tr('Cash lent') + (x.note ? ' · ' + x.note : '') : x.dishes}</small></span>
                      <b>{money(x.owed)}</b>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {(account === 'drawer' || (guest && !(account === 'iou' && inward))) && (
          <div className="tl-pio-amount">
            <label className="field"><span>{tr('Amount')}</span>
              <input className="input is-big" inputMode="decimal" autoFocus={account === 'drawer' || !!guest} value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0.00" /></label>
            {account === 'vip' && !inward && guest && guest.vipBalance > 0 && <button type="button" className="pos-link" onClick={() => setAmount(String(guest.vipBalance))}>{tr('All of it ({amount})', { amount: money(guest.vipBalance) })}</button>}
            {account === 'iou' && !inward && guest && lendable != null && <small className="dk-muted">{tr('Up to {amount} more on their IOU account.', { amount: money(lendable) })}</small>}
          </div>
        )}
        {(account === 'drawer' || (guest && !(account === 'iou' && inward))) && (
          <label className="field"><span>{tr('Note')}</span>
            <input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)}
              placeholder={account === 'drawer' ? (inward ? tr('e.g. Change fund top-up') : tr('e.g. Delivery')) : account === 'iou' ? tr('e.g. Taxi home, pays back Friday') : tr('Optional')} /></label>
        )}
        {account === 'vip' && !inward && guest && (
          <label className="field tl-pio-pin"><span>🔐 {tr('Manager\'s PIN: giving VIP money back is approved like a refund')}</span>
            <input className="input ts-pin" type="password" inputMode="numeric" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} /></label>
        )}
        {problem && <p className="tl-pio-problem">⚠️ {problem}</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !ready}>{busy ? tr('Saving…') : go}</button>
        </div>
      </form>
    </div>
  );
}
