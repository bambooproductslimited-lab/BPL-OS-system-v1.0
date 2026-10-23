import { useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { tr } from '../../lib/i18n.jsx';

// What the tables ask for from their QR codes (backend restaurantTableOrders
// inbox): orders to accept — onto the table's open order, sent to the
// kitchen — or turn down with a reason the table sees; and calls for the
// waiter or the bill, answered with "On my way" (the bill also opens the
// table's order on the till, to charge it). The till asks for it every few
// seconds and rings when something new comes (RestaurantPosPage).
// Orders from the self-order kiosk wait here too (K-0012; backend
// restaurantKiosk): eaten here or taken away, paid on the kiosk or at the
// counter; accepted, they open as their own order and go to the kitchen.
// Tables whose guests paid from their phones (backend restaurantTablePay)
// show here too, to open the bill and close it with what was paid.

const REASONS = [() => tr('A dish is sold out'), () => tr('The kitchen is closing'), () => tr('A waiter will come and take it')];

function OrderCard({ o, token, waiters, requireWaiter, canSend, onDone, onError }) {
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [waiterId, setWaiterId] = useState('');
  const kiosk = o.kind === 'kiosk';
  const needsWaiter = requireWaiter && !o.hasOpenOrder && !kiosk;
  async function run(path, body, text) {
    setBusy(true);
    try { await posFetch('POST', '/pos/table-orders/' + o.id + path, token, body); onDone(text); } catch (e) { onError(e); } finally { setBusy(false); }
  }
  return (
    <article className={'tq-card' + (o.waitingMinutes >= 3 ? ' is-late' : '') + (kiosk ? ' is-kiosk' : '')}>
      <header>
        {kiosk ? <span className="tq-table is-kiosk"><span aria-hidden="true">🖥️</span>{o.kioskName || tr('Kiosk')}</span>
          : <span className="tq-table"><span aria-hidden="true">🪑</span>{o.tableName}</span>}
        <span className="tq-ref">{o.ref}{o.name ? ' · ' + o.name : ''}</span>
        <span className="tq-wait">{o.waitingMinutes < 1 ? tr('just now') : tr('waiting {n} min', { n: o.waitingMinutes })}</span>
      </header>
      <ul className="tq-items is-plain">
        {o.items.map((l, i) => <li key={i}><b>{l.qty}×</b><span>{l.name}{l.note && <em>{l.note}</em>}</span><i>{money(l.lineTotal)}</i></li>)}
      </ul>
      {o.note && <p className="tq-note">✎ {o.note}</p>}
      {kiosk && (
        <div className="tq-tags">
          <span className={'tq-tag is-' + (o.dining || 'away')}>{o.dining === 'here' ? '🍽️ ' + tr('Eat here') : '🥡 ' + tr('Take away')}</span>
          <span className={'tq-tag' + (o.paid ? ' is-paid' : ' is-due')}>{o.paid ? '✓ ' + tr('Paid on the kiosk') : '💵 ' + tr('Pays at the counter')}</span>
        </div>
      )}
      <div className="tq-sum">
        <span>{kiosk ? tr('Its own order, called by its number') : o.hasOpenOrder ? tr('Added to the table\'s open order{waiter}', { waiter: o.waiterName ? ' · ' + o.waiterName : '' }) : tr('A new order for this table')}</span>
        <strong>{money(o.subtotal)}</strong>
      </div>
      {!rejecting ? (
        <div className="tq-go">
          {needsWaiter && (
            <select className="input" value={waiterId} onChange={(e) => setWaiterId(e.target.value)} aria-label={tr('Waiter')}>
              <option value="">{tr('Pick the waiter')}</option>
              {waiters.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          )}
          <button type="button" className="btn btn-primary" disabled={busy || !canSend || (needsWaiter && !waiterId)}
            onClick={() => run('/accept', { waiterId: waiterId || undefined }, kiosk ? tr('{ref} from the kiosk is in the kitchen.', { ref: o.ref }) : tr('{ref} from {table} is in the kitchen.', { ref: o.ref, table: o.tableName }))}>
            {busy ? tr('Sending…') : '✓ ' + tr('Accept · to the kitchen')}
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setRejecting(true)}>{tr('Turn down')}</button>
        </div>
      ) : (
        <div className="tq-no">
          <div className="tq-chips">{REASONS.map((r, i) => <button key={i} type="button" className={reason === r() ? 'is-on' : ''} onClick={() => setReason(r())}>{r()}</button>)}</div>
          <input className="input" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder={tr('Or write the reason: the table sees it')} aria-label={tr('Reason')} />
          <div className="tq-go">
            <button type="button" className="btn tq-stop" disabled={busy || !reason.trim()} onClick={() => run('/reject', { reason: reason.trim() }, tr('{ref} turned down. The table sees why.', { ref: o.ref }))}>{tr('Turn it down')}</button>
            <button type="button" className="btn btn-secondary" onClick={() => setRejecting(false)}>{tr('Back')}</button>
          </div>
        </div>
      )}
      {!canSend && <p className="tq-hint">{tr('Your role cannot send orders to the kitchen: ask a waiter or the cashier.')}</p>}
    </article>
  );
}

export default function TableInbox({ token, box, waiters, canSend, onClose, onChanged, onToast, onOpenBill, onUnauthorized }) {
  const [busy, setBusy] = useState(null);
  function failed(e) { if (e.status === 401) onUnauthorized(); else { onToast(e.message); onChanged(); } }
  async function answer(c, bill) {
    setBusy(c.id);
    try {
      await posFetch('POST', '/pos/table-calls/' + c.id + '/answer', token);
      onChanged();
      if (bill) onOpenBill(c); else onToast(tr('{table}: on your way.', { table: c.tableName }));
    } catch (e) { failed(e); } finally { setBusy(null); }
  }
  const paid = box.paidAtTable || [];
  const empty = !box.orders.length && !box.calls.length && !paid.length;
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog tl-dialog tq-inbox" role="dialog" aria-modal="true" aria-labelledby="tq-title" onClick={(e) => e.stopPropagation()}>
        <div className="tq-head">
          <span className="tl-dialog-ico is-qr" aria-hidden="true">📱</span>
          <div><h2 id="tq-title">{box.orders.some((o) => o.kind === 'kiosk') ? tr('From the tables and the kiosk') : tr('From the tables')}</h2>
            <p className="dk-muted">{box.settings && box.settings.straightToKitchen ? tr('Orders from the QR codes go straight to the kitchen; tables with no waiter yet wait here.') : tr('Orders from the QR codes wait here to be accepted.')}</p></div>
        </div>
        {box.calls.length > 0 && (
          <ul className="tq-calls is-plain">
            {box.calls.map((c) => (
              <li key={c.id} className={'is-' + c.kind}>
                <span className="tq-call-ico" aria-hidden="true">{c.kind === 'bill' ? '🧾' : '🙋'}</span>
                <span className="tq-call-text"><strong>{c.kind === 'bill' ? tr('{table} asks for the bill', { table: c.tableName }) : tr('{table} calls the waiter', { table: c.tableName })}</strong>
                  <small>{c.minutes < 1 ? tr('just now') : tr('{n} min ago', { n: c.minutes })}</small></span>
                {c.kind === 'bill' && <button type="button" className="btn btn-primary" disabled={busy === c.id} onClick={() => answer(c, true)}>{tr('Open the bill')}</button>}
                <button type="button" className="btn btn-secondary" disabled={busy === c.id} onClick={() => answer(c, false)}>{tr('On my way')}</button>
              </li>
            ))}
          </ul>
        )}
        {paid.length > 0 && (
          <ul className="tq-calls is-plain">
            {paid.map((x) => (
              <li key={x.tabId} className="is-paid">
                <span className="tq-call-ico" aria-hidden="true">💳</span>
                <span className="tq-call-text"><strong>{tr('{table} paid {amount} from the table', { table: x.tableName, amount: money(x.amount) })}</strong>
                  <small>{[x.payments === 1 ? tr('1 payment') : tr('{n} payments', { n: x.payments }), x.tip > 0 ? tr('a tip of {amount}', { amount: money(x.tip) }) : null].filter(Boolean).join(' · ')}</small></span>
                <button type="button" className="btn btn-primary" onClick={() => onOpenBill({ tabId: x.tabId, tableName: x.tableName })}>{tr('Open the bill')}</button>
              </li>
            ))}
          </ul>
        )}
        <div className="tq-list">
          {box.orders.map((o) => (
            <OrderCard key={o.id} o={o} token={token} waiters={waiters} requireWaiter={box.requireWaiter} canSend={canSend}
              onDone={(text) => { onToast(text); onChanged(); }} onError={failed} />
          ))}
        </div>
        {empty && <div className="tq-empty"><span aria-hidden="true">📱</span><strong>{tr('Nothing from the tables')}</strong><p>{tr('When a table orders or calls from its QR code, it shows here and the till rings.')}</p></div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button></div>
      </div>
    </div>
  );
}
