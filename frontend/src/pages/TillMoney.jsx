import { useEffect, useMemo, useState } from 'react';
import { posFetch } from '../lib/posApi';
import { money } from '../lib/currency';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import { Icon } from '../components/DashKit';

// The till's money beyond a plain sale (backend: restaurantTillMoney.service.js):
// refunds approved with a manager's PIN, VIP guests' money put down and
// spent, and IOUs paid later. Each is one dialog opened from the till's top
// bar (RestaurantPosPage.jsx).

function whenOf(ts) {
  const d = new Date(ts);
  const today = new Date();
  const time = d.toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return time;
  return d.toLocaleDateString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short' }) + ' · ' + time;
}
function qtyText(n) { return String(Math.round(n * 100) / 100); }

// How a refund goes back, said for the cashier.
const REFUND_WAYS = {
  cash: () => tr('Cash from the drawer'),
  mobile_money: () => tr('Mobile Money'),
  vip: () => tr('Back to their VIP balance'),
  iou: () => tr('Off what they owe')
};
const REASONS = [() => tr('Wrong order'), () => tr('Food was cold or not good'), () => tr('Took too long'), () => tr('Charged twice'), () => tr('Guest changed their mind')];

export function RefundDialog({ token, startWith, onClose, onShowReceipt, onChanged, onAuth }) {
  const [step, setStep] = useState(startWith ? 'pick' : 'find');
  const [q, setQ] = useState('');
  const [sales, setSales] = useState(null);
  const [sale, setSale] = useState(null);
  const [qty, setQty] = useState({});
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  function fail(err) { if (err.status === 401) onAuth(); else setError(err.message); }

  useEffect(() => {
    if (step !== 'find') return undefined;
    let live = true;
    const t = setTimeout(() => {
      posFetch('GET', '/pos/refunds/sales' + (q.trim() ? '?q=' + encodeURIComponent(q.trim()) : ''), token)
        .then((rows) => { if (live) setSales(rows); }).catch((err) => { if (live) fail(err); });
    }, q ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [q, step, token]); // eslint-disable-line react-hooks/exhaustive-deps

  async function openSale(id) {
    setError(null); setBusy(true);
    try {
      const s = await posFetch('GET', '/pos/refunds/sales/' + id, token);
      setSale(s); setQty({}); setReason(''); setPin(''); setMethod(s.methods[0]); setStep('pick');
    } catch (err) { fail(err); } finally { setBusy(false); }
  }
  useEffect(() => { if (startWith) openSale(startWith); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const lines = sale ? sale.items.map((i) => ({ ...i, left: Math.round((i.qty - i.refundedQty) * 100) / 100 })) : [];
  const amount = Math.round(lines.reduce((s, i) => s + (qty[i.id] || 0) * i.lineTotal / i.qty, 0) * 100) / 100;
  const leftOnSale = sale ? Math.round((sale.total - sale.refunded) * 100) / 100 : 0;
  const shown = Math.min(amount, leftOnSale);
  function setLine(i, n) { setQty({ ...qty, [i.id]: Math.max(0, Math.min(i.left, n)) }); }
  function everything() { const all = {}; lines.forEach((i) => { all[i.id] = i.left; }); setQty(all); }

  async function submit(e) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      const r = await posFetch('POST', '/pos/refunds/sales/' + sale.id, token, {
        items: lines.filter((i) => qty[i.id] > 0).map((i) => ({ id: i.id, qty: qty[i.id] })), reason: reason.trim(), method, managerPin: pin
      });
      setResult(r); setSale(r.sale); setStep('done'); onChanged();
    } catch (err) { setPin(''); fail(err); } finally { setBusy(false); }
  }

  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog pos-panel pos-money" onClick={(e) => e.stopPropagation()}>
        {step === 'find' && (
          <>
            <h2><span className="pos-money-ico is-refund"><Icon name="void" /></span>{tr('Refund a sale')}</h2>
            <p className="dk-muted">{tr('Pick the sale: today\'s and yesterday\'s are here, or search by its number, table or guest. A manager approves every refund with their PIN.')}</p>
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Search: number, table or guest…')} autoFocus />
            {error && <div className="error-banner">{error}</div>}
            {!sales ? <p className="dk-muted">{tr('Loading…')}</p> : !sales.length ? (
              <div className="dk-empty"><Icon name="info" /><p>{q ? tr('No sale matches "{search}".', { search: q }) : tr('No sales today or yesterday yet.')}</p></div>
            ) : (
              <ul className="dk-rows pos-tabs">
                {sales.map((s) => (
                  <li key={s.id} className="dk-row pos-money-row" onClick={() => openSale(s.id)}>
                    <span className="dk-lead-icon"><Icon name="receipt" /></span>
                    <div className="dk-row-main">
                      <div className="dk-row-title">{s.orderNo}{s.refunded > 0 && <span className="pos-money-tag is-refund">{s.refunded >= s.total ? tr('Refunded') : tr('Part refunded')}</span>}</div>
                      <div className="dk-muted dk-row-meta">{[whenOf(s.createdAt), s.tableName, s.guestName, s.items === 1 ? tr('1 item') : tr('{n} items', { n: qtyText(s.items) }), codeLabel(s.paymentMethod), s.cashierName].filter(Boolean).join(' · ')}</div>
                    </div>
                    <div className="dk-row-side"><div className="dk-row-amount">{money(s.total)}</div></div>
                  </li>
                ))}
              </ul>
            )}
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button></div>
          </>
        )}

        {step === 'pick' && !sale && <p className="dk-muted">{error || tr('Loading…')}</p>}
        {step === 'pick' && sale && (
          <form onSubmit={submit} className="pos-money-form">
            <h2><span className="pos-money-ico is-refund"><Icon name="void" /></span>{tr('Refund {no}', { no: sale.orderNo })}</h2>
            <p className="dk-muted">{[whenOf(sale.createdAt), sale.tableName, sale.guestName, codeLabel(sale.paymentMethod), money(sale.total)].filter(Boolean).join(' · ')}</p>
            {sale.status !== 'completed' ? <div className="error-banner">{tr('That sale was voided: there is nothing to refund.')}</div> : (
              <>
                <div className="pos-money-h"><span>{tr('What goes back')}</span><button type="button" className="pos-link" onClick={everything} disabled={!lines.some((i) => i.left > 0)}>{tr('Everything')}</button></div>
                <ul className="pos-refund-lines">
                  {lines.map((i) => (
                    <li key={i.id} className={i.left <= 0 ? 'is-done' : (qty[i.id] || 0) > 0 ? 'is-on' : ''}>
                      <span className="pos-refund-name">{i.name}<small>{i.left <= 0 ? tr('Already refunded') : i.refundedQty > 0 ? tr('{n} of {m} left to refund', { n: qtyText(i.left), m: qtyText(i.qty) }) : qtyText(i.qty) + ' × ' + money(i.unitPrice)}</small></span>
                      {i.left > 0 && (
                        <span className="pos-stepper">
                          <button type="button" onClick={() => setLine(i, (qty[i.id] || 0) - 1)} aria-label={tr('Decrease')}>−</button>
                          <span>{qtyText(qty[i.id] || 0)}</span>
                          <button type="button" onClick={() => setLine(i, (qty[i.id] || 0) + 1)} aria-label={tr('Increase')}>+</button>
                        </span>
                      )}
                      <strong>{(qty[i.id] || 0) > 0 ? money((qty[i.id] || 0) * i.lineTotal / i.qty) : ''}</strong>
                    </li>
                  ))}
                </ul>
                <div className="field">
                  <label htmlFor="refund-reason">{tr('Why')}</label>
                  <div className="pos-quick">
                    {REASONS.map((r) => <button key={r()} type="button" className={reason === r() ? 'is-on' : ''} onClick={() => setReason(r())}>{r()}</button>)}
                  </div>
                  <input id="refund-reason" className="input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder={tr('Or say why in your own words')} />
                </div>
                <div className="pos-money-h"><span>{tr('How it goes back')}</span></div>
                <div className="pos-ways" role="radiogroup" aria-label={tr('How it goes back')}>
                  {sale.methods.map((m) => (
                    <button key={m} type="button" role="radio" aria-checked={method === m} className={method === m ? 'is-on' : ''} data-m={m} onClick={() => setMethod(m)}>{REFUND_WAYS[m]()}</button>
                  ))}
                </div>
                <div className="pos-refund-sum">
                  <span>{tr('To refund')}</span><strong>{money(shown)}</strong>
                </div>
                <div className="field pos-manager">
                  <label htmlFor="refund-pin"><Icon name="key" /> {tr('Manager PIN')}</label>
                  <input id="refund-pin" className="input" type="password" inputMode="numeric" autoComplete="off" maxLength={4} value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="••••" />
                  <small className="dk-muted">{tr('A manager types their 4-digit PIN to approve it.')}</small>
                </div>
              </>
            )}
            {error && <div className="error-banner">{error}</div>}
            <div className="dialog-actions">
              {!startWith && <button type="button" className="btn btn-secondary" onClick={() => { setStep('find'); setSale(null); setError(null); }} disabled={busy}>{tr('Back')}</button>}
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
              {sale.status === 'completed' && (
                <button type="submit" className="btn btn-primary pos-refund-go" disabled={busy || !(shown > 0) || reason.trim().length < 3 || pin.length !== 4}>
                  {busy ? tr('Checking…') : tr('Refund {amount}', { amount: money(shown) })}
                </button>
              )}
            </div>
          </form>
        )}

        {step === 'done' && result && (
          <div className="pos-money-done">
            <span className="pos-done-mark is-good is-burst"><Icon name="check" /></span>
            <h2>{tr('{amount} refunded', { amount: money(result.refund.amount) })}</h2>
            <p className="pos-done-big">
              {result.refund.method === 'cash' ? tr('Give {amount} back from the drawer.', { amount: money(result.refund.amount) })
                : result.refund.method === 'mobile_money' ? tr('Send {amount} back by Mobile Money.', { amount: money(result.refund.amount) })
                  : result.refund.method === 'vip' ? tr('{amount} is back on their VIP balance.', { amount: money(result.refund.amount) })
                    : tr('{amount} is taken off what they owe.', { amount: money(result.refund.amount) })}
            </p>
            <p className="dk-muted">{tr('Approved by {name}. Reason: {reason}', { name: result.refund.approvedByName, reason: result.refund.reason })}</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => onShowReceipt(sale.id)}>{tr('Show the receipt')}</button>
              <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>{tr('Done')}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const TOPUPS = [50, 100, 200, 500, 1000];
const ENTRY = {
  topup: (e) => e.method === 'cash' ? tr('Put down in cash') : tr('Put down by Mobile Money'),
  sale: (e) => e.orderNo ? tr('Sale {no}', { no: e.orderNo }) : tr('Sale'),
  refund: (e) => e.note === 'Sale voided' ? tr('Sale {no} voided', { no: e.orderNo || '' }) : tr('Refund on {no}', { no: e.orderNo || '' })
};

export function VipDialog({ token, startGuest, onClose, onChanged, onAuth }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(null); // { guest, balance, entries }
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [note, setNote] = useState('');
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(null);

  function fail(err) { if (err.status === 401) onAuth(); else setError(err.message); }
  async function openGuest(id) {
    setError(null);
    try { setOpen(await posFetch('GET', '/pos/vip/' + id, token)); setAmount(''); setNote(''); setMethod('cash'); } catch (err) { fail(err); }
  }
  useEffect(() => { if (startGuest) openGuest(startGuest.id); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open) return undefined;
    let live = true;
    const t = setTimeout(() => {
      posFetch('GET', '/pos/vip' + (q.trim() ? '?q=' + encodeURIComponent(q.trim()) : ''), token)
        .then((rows) => { if (live) setList(rows); }).catch((err) => { if (live) fail(err); });
    }, q ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [q, open, token]); // eslint-disable-line react-hooks/exhaustive-deps

  async function addGuest(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const g = await posFetch('POST', '/pos/guests', token, { name: newName.trim(), phone: newPhone.trim() });
      setNewName(''); setNewPhone('');
      await openGuest(g.id);
    } catch (err) { fail(err); } finally { setBusy(false); }
  }
  async function topUp(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await posFetch('POST', '/pos/vip/topups', token, { guestId: open.guest.id, amount: Number(amount), method, note: note.trim() });
      setFlash(tr('{amount} put down. {name} now has {balance}.', { amount: money(r.amount), name: r.guest.name, balance: money(r.balance) }));
      onChanged();
      await openGuest(open.guest.id);
    } catch (err) { fail(err); } finally { setBusy(false); }
  }
  const total = useMemo(() => (list || []).reduce((s, g) => s + g.balance, 0), [list]);

  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog pos-panel pos-money" onClick={(e) => e.stopPropagation()}>
        {!open ? (
          <>
            <h2><span className="pos-money-ico is-vip"><Icon name="spark" /></span>{tr('VIP guests')}</h2>
            <p className="dk-muted">{tr('VIP guests put money down here, then pay for their orders with VIP at the till until it runs out.')}</p>
            {!q && list && list.length > 0 && <div className="pos-vip-total"><span>{tr('Held for {n} VIP guests', { n: list.length })}</span><strong>{money(total)}</strong></div>}
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Find a guest by name or phone…')} autoFocus />
            {error && <div className="error-banner">{error}</div>}
            {!list ? <p className="dk-muted">{tr('Loading…')}</p> : (
              <ul className="dk-rows pos-tabs">
                {list.map((g) => (
                  <li key={g.id} className="dk-row pos-money-row" onClick={() => openGuest(g.id)}>
                    <span className="pos-vip-avatar" aria-hidden="true">{g.name.replace(/^zq\s+/i, '').slice(0, 1).toUpperCase()}</span>
                    <div className="dk-row-main">
                      <div className="dk-row-title">{g.name}</div>
                      <div className="dk-muted dk-row-meta">{[g.phone, g.toppedUp > 0 ? tr('{amount} put down in all', { amount: money(g.toppedUp) }) : tr('No money down yet')].filter(Boolean).join(' · ')}</div>
                    </div>
                    <div className="dk-row-side"><div className={'dk-row-amount' + (g.balance > 0 ? ' pos-vip-bal' : '')}>{money(g.balance)}</div></div>
                  </li>
                ))}
                {!list.length && <li className="dk-empty"><Icon name="info" /><p>{q ? tr('No guest matches "{search}". Add them below.', { search: q }) : tr('No VIP guests yet. Find a guest, or add one below, and put their money down.')}</p></li>}
              </ul>
            )}
            <form className="pos-vip-new" onSubmit={addGuest}>
              <span className="pos-money-h"><span>{tr('A new VIP guest')}</span></span>
              <input className="input" value={newName} maxLength={100} onChange={(e) => setNewName(e.target.value)} placeholder={tr('Name')} aria-label={tr('Name')} />
              <input className="input" value={newPhone} maxLength={30} inputMode="tel" onChange={(e) => setNewPhone(e.target.value)} placeholder={tr('Phone')} aria-label={tr('Phone')} />
              <button type="submit" className="btn btn-secondary" disabled={busy || !newName.trim()}>{tr('Add')}</button>
            </form>
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button></div>
          </>
        ) : (
          <form onSubmit={topUp} className="pos-money-form">
            <h2><span className="pos-money-ico is-vip"><Icon name="spark" /></span>{open.guest.name}</h2>
            <div className="pos-vip-card">
              <span>{tr('VIP balance')}</span>
              <strong>{money(open.balance)}</strong>
              <small>{open.guest.phone || tr('No phone number')}</small>
            </div>
            {flash && <div className="pos-money-flash" role="status"><Icon name="check" />{flash}</div>}
            <div className="pos-money-h"><span>{tr('Put money down')}</span></div>
            <input className="input pos-big-input" type="number" min="0.01" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" aria-label={tr('Amount')} />
            <div className="pos-quick">
              {TOPUPS.map((v) => <button key={v} type="button" className={Number(amount) === v ? 'is-on' : ''} onClick={() => setAmount(String(v))}>{money(v)}</button>)}
            </div>
            <div className="pos-ways" role="radiogroup" aria-label={tr('Paid with')}>
              {['cash', 'mobile_money'].map((m) => (
                <button key={m} type="button" role="radio" aria-checked={method === m} className={method === m ? 'is-on' : ''} data-m={m} onClick={() => setMethod(m)}>{m === 'cash' ? tr('Cash (into the drawer)') : tr('Mobile Money')}</button>
              ))}
            </div>
            <input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder={tr('Note (optional)')} aria-label={tr('Note (optional)')} />
            {error && <div className="error-banner">{error}</div>}
            {open.entries.length > 0 && (
              <>
                <div className="pos-money-h"><span>{tr('History')}</span></div>
                <ul className="pos-vip-history">
                  {open.entries.map((e) => (
                    <li key={e.id}>
                      <span>{ENTRY[e.kind](e)}<small>{[whenOf(e.createdAt), e.by].filter(Boolean).join(' · ')}</small></span>
                      <strong className={e.amount < 0 ? 'is-minus' : 'is-plus'}>{e.amount < 0 ? '−' : '+'}{money(Math.abs(e.amount))}</strong>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => { setOpen(null); setFlash(null); setError(null); }} disabled={busy}>{tr('All VIP guests')}</button>
              <button type="submit" className="btn btn-primary" disabled={busy || !(Number(amount) > 0)}>{busy ? tr('Saving…') : Number(amount) > 0 ? tr('Put down {amount}', { amount: money(Number(amount)) }) : tr('Put money down')}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export function IouDialog({ token, onClose, onChanged, onAuth }) {
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [paying, setPaying] = useState(null); // { iou, method }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(null);

  function fail(err) { if (err.status === 401) onAuth(); else setError(err.message); }
  function load() {
    return posFetch('GET', '/pos/ious' + (q.trim() ? '?q=' + encodeURIComponent(q.trim()) : ''), token).then(setData).catch(fail);
  }
  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, token]); // eslint-disable-line react-hooks/exhaustive-deps

  async function pay() {
    setBusy(true); setError(null);
    try {
      const r = await posFetch('POST', '/pos/ious/' + paying.iou.id + '/paid', token, { method: paying.method });
      setFlash(tr('{name} paid {amount} by {method}.', { name: r.guestName || r.orderNo, amount: money(r.paidAmount), method: codeLabel(r.paidMethod) }));
      setPaying(null); onChanged(); await load();
    } catch (err) { fail(err); } finally { setBusy(false); }
  }
  const days = (ts) => Math.floor((Date.now() - new Date(ts).getTime()) / 86400000);

  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog pos-panel pos-money" onClick={(e) => e.stopPropagation()}>
        <h2><span className="pos-money-ico is-iou"><Icon name="owed" /></span>{tr('IOUs')}</h2>
        <p className="dk-muted">{tr('Sales a guest owes. When they pay, mark it paid here: cash goes into your drawer.')}</p>
        {data && <div className="pos-iou-total"><span>{data.open.length === 1 ? tr('1 IOU not paid yet') : tr('{n} IOUs not paid yet', { n: data.open.length })}</span><strong>{money(data.owed)}</strong></div>}
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Search: guest, phone or number…')} />
        {flash && <div className="pos-money-flash" role="status"><Icon name="check" />{flash}</div>}
        {error && <div className="error-banner">{error}</div>}
        {!data ? <p className="dk-muted">{tr('Loading…')}</p> : !data.open.length ? (
          <div className="dk-empty"><Icon name="check" /><p>{q ? tr('No IOU matches "{search}".', { search: q }) : tr('Nobody owes anything. IOU sales show here until they are paid.')}</p></div>
        ) : (
          <ul className="dk-rows pos-tabs">
            {data.open.map((x) => (
              <li key={x.id} className={'dk-row pos-iou' + (days(x.createdAt) >= 7 ? ' is-old' : '')}>
                <span className="pos-vip-avatar is-iou" aria-hidden="true">{(x.guestName || '?').replace(/^zq\s+/i, '').slice(0, 1).toUpperCase()}</span>
                <div className="dk-row-main">
                  <div className="dk-row-title">{x.guestName || tr('No name')}{x.guestPhone ? <span className="dk-muted"> · {x.guestPhone}</span> : null}</div>
                  <div className="dk-muted dk-row-meta">{[x.orderNo, whenOf(x.createdAt), days(x.createdAt) >= 1 ? (days(x.createdAt) === 1 ? tr('1 day ago') : tr('{n} days ago', { n: days(x.createdAt) })) : null, x.tableName].filter(Boolean).join(' · ')}</div>
                  <div className="dk-muted dk-row-meta">{x.dishes}</div>
                  {paying && paying.iou.id === x.id && (
                    <div className="pos-iou-pay">
                      <div className="pos-ways" role="radiogroup" aria-label={tr('Paid with')}>
                        {['cash', 'mobile_money'].map((m) => (
                          <button key={m} type="button" role="radio" aria-checked={paying.method === m} className={paying.method === m ? 'is-on' : ''} data-m={m} onClick={() => setPaying({ ...paying, method: m })}>{m === 'cash' ? tr('Cash') : tr('Mobile Money')}</button>
                        ))}
                      </div>
                      <button type="button" className="btn btn-secondary tl-btn" onClick={() => setPaying(null)} disabled={busy}>{tr('Cancel')}</button>
                      <button type="button" className="btn btn-primary tl-btn" onClick={pay} disabled={busy}>{busy ? tr('Saving…') : tr('{amount} paid', { amount: money(x.owed) })}</button>
                    </div>
                  )}
                </div>
                <div className="dk-row-side">
                  <div className="dk-row-amount">{money(x.owed)}</div>
                  {x.refunded > 0 && <small className="dk-muted">{tr('{amount} refunded', { amount: money(x.refunded) })}</small>}
                  {!(paying && paying.iou.id === x.id) && <button type="button" className="btn btn-primary tl-btn" onClick={() => { setFlash(null); setPaying({ iou: x, method: 'cash' }); }}>{tr('Paid…')}</button>}
                </div>
              </li>
            ))}
          </ul>
        )}
        {data && data.paidToday.length > 0 && (
          <>
            <div className="pos-money-h"><span>{tr('Paid today')}</span></div>
            <ul className="pos-vip-history">
              {data.paidToday.map((x) => (
                <li key={x.id}>
                  <span>{x.guestName || x.orderNo}<small>{[x.orderNo, x.paidMethod ? codeLabel(x.paidMethod) : tr('Refunded'), x.paidBy, whenOf(x.paidAt)].filter(Boolean).join(' · ')}</small></span>
                  <strong className="is-plus">{money(x.paidAmount || 0)}</strong>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button></div>
      </div>
    </div>
  );
}

// In the payment dialog: who a VIP or IOU sale is for, and for VIP what is
// on their balance.
export function PayFor({ token, method, guest, total, refreshKey, onPickGuest, onTopUp, onShort }) {
  const [balance, setBalance] = useState(null);
  useEffect(() => {
    if (method !== 'vip' || !guest) { setBalance(null); return undefined; }
    let live = true;
    posFetch('GET', '/pos/vip/' + guest.id, token).then((r) => { if (live) setBalance(r.balance); }).catch(() => { if (live) setBalance(null); });
    return () => { live = false; };
  }, [method, guest, token, refreshKey]);
  const short = method === 'vip' && balance !== null && balance < total;
  useEffect(() => { onShort(short); }, [short]); // eslint-disable-line react-hooks/exhaustive-deps
  if (method !== 'vip' && method !== 'iou') return null;
  return (
    <div className={'pos-payfor is-' + method + (short ? ' is-short' : '') + (guest ? '' : ' is-missing')}>
      {!guest ? (
        <>
          <span className="pos-payfor-text">
            <strong>{method === 'vip' ? tr('Whose VIP money?') : tr('Who owes it?')}</strong>
            <span>{method === 'vip' ? tr('A VIP sale is paid from the guest\'s balance.') : tr('An IOU needs the name of the guest who will pay it later.')}</span>
          </span>
          <button type="button" className="btn btn-primary tl-btn" onClick={onPickGuest}>{tr('Pick the guest')}</button>
        </>
      ) : (
        <>
          <span className="pos-payfor-text">
            <strong>{guest.name}</strong>
            <span>
              {method === 'iou' ? tr('Owes {amount}. They pay it later from IOUs on the till.', { amount: money(total) })
                : balance === null ? tr('Checking their VIP balance…')
                  : short ? tr('Has {balance} on their VIP balance: not enough for {amount}.', { balance: money(balance), amount: money(total) })
                    : tr('{balance} on their VIP balance; {left} left after this sale.', { balance: money(balance), left: money(Math.round((balance - total) * 100) / 100) })}
            </span>
          </span>
          {short ? <button type="button" className="btn btn-primary tl-btn" onClick={onTopUp}>{tr('Put money down…')}</button>
            : <button type="button" className="pos-link" onClick={onPickGuest}>{tr('Another guest')}</button>}
        </>
      )}
    </div>
  );
}
