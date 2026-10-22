import { useState } from 'react';
import { money } from '../../lib/currency';
import { tr } from '../../lib/i18n.jsx';
import { kmText, minText, navLink, payName, rideLeft, riderSpot, sinceText, statusName, stepOf, telLink, timeOf, trafficMinutes, vehicleEmoji, vehicleName, waLink } from './dlShared';

// The cards of the delivery screen (DeliveryApp.jsx): a website order to
// accept or turn down; an order cooking or ready to go out; a delivery on
// its way with its steps, rider and customer; one done or turned down.
// Pressing a card shows it on the map.

// Call, WhatsApp and (with a pin) directions.
export function ContactLinks({ phone, lat, lng, text }) {
  return (
    <span className="dl-contact" onClick={(e) => e.stopPropagation()}>
      {phone && <a className="dl-round" href={telLink(phone)} aria-label={tr('Call {phone}', { phone })} title={phone}>📞</a>}
      {phone && <a className="dl-round is-wa" href={waLink(phone, text)} target="_blank" rel="noopener noreferrer" aria-label={tr('WhatsApp')}>💬</a>}
      {lat != null && <a className="dl-round is-nav" href={navLink(lat, lng)} target="_blank" rel="noopener noreferrer" aria-label={tr('Directions')}>🧭</a>}
    </span>
  );
}

const REASONS = [() => tr('The kitchen is too busy right now'), () => tr('A dish is sold out'), () => tr('Too far for us'), () => tr('We are closing soon')];

export function NewOrderCard({ o, settings, selected, onSelect, onAccept, onReject }) {
  const [mins, setMins] = useState(settings.readyMinutes);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const late = o.waitingMinutes >= 5;
  const pickup = o.fulfillment === 'pickup';
  async function run(fn) { setBusy(true); try { await fn(); } finally { setBusy(false); } }
  return (
    <article className={'dl-card is-new' + (selected ? ' is-sel' : '') + (late ? ' is-late' : '')} onClick={onSelect}>
      <header className="dl-card-head">
        <span className="dl-badge is-new">{pickup ? '🥡' : '🛵'} {o.ref}</span>
        <span className="dl-kind">{pickup ? tr('Pickup') : tr('Delivery')}{!pickup && o.distanceKm != null ? ' · ' + kmText(o.distanceKm) : ''}</span>
        <span className={'dl-wait' + (late ? ' is-late' : '')}>{o.waitingMinutes < 1 ? tr('just now') : tr('waiting {n} min', { n: o.waitingMinutes })}</span>
      </header>
      <div className="dl-who"><strong>{o.customer.name}</strong><ContactLinks phone={o.customer.phone} text={tr('Hello {name}, this is about your order {ref}.', { name: o.customer.name, ref: o.ref })} /></div>
      {!pickup && <p className="dl-where"><span aria-hidden="true">📍</span><span>{o.customer.address}{o.customer.landmark && <small>{o.customer.landmark}</small>}</span></p>}
      <ul className="dl-items">
        {o.items.map((l, i) => <li key={i}><b>{l.qty}×</b><span>{l.name}{l.note && <em>{l.note}</em>}</span><i>{money(l.lineTotal)}</i></li>)}
      </ul>
      {o.note && <p className="dl-note">✎ {o.note}</p>}
      <div className="dl-money">
        <span>{tr('Food {amount}', { amount: money(o.subtotal) })}{o.deliveryFee > 0 ? ' + ' + tr('delivery {amount}', { amount: money(o.deliveryFee) }) : ''}</span>
        <strong>{money(o.total)}</strong>
        <small>{payName(o.payMethod)} · {pickup ? tr('paid at pickup') : tr('paid on delivery')}</small>
      </div>
      {!rejecting ? (
        <div className="dl-answer" onClick={(e) => e.stopPropagation()}>
          <span className="dl-answer-label">{tr('Ready in')}</span>
          <div className="dl-chips" role="radiogroup" aria-label={tr('Ready in')}>
            {[15, 20, 30, 45, 60].map((m) => <button key={m} type="button" role="radio" aria-checked={mins === m} className={mins === m ? 'is-on' : ''} onClick={() => setMins(m)}>{minText(m)}</button>)}
          </div>
          <div className="dl-answer-go">
            <button type="button" className="btn dl-go" disabled={busy} onClick={() => run(() => onAccept(mins))}>{busy ? tr('Accepting…') : '✓ ' + tr('Accept and cook')}</button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setRejecting(true)}>{tr('Turn down')}</button>
          </div>
        </div>
      ) : (
        <div className="dl-answer is-no" onClick={(e) => e.stopPropagation()}>
          <span className="dl-answer-label">{tr('Why? The customer sees this.')}</span>
          <div className="dl-chips">{REASONS.map((r, i) => <button key={i} type="button" className={reason === r() ? 'is-on' : ''} onClick={() => setReason(r())}>{r()}</button>)}</div>
          <input className="input" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder={tr('Or write the reason')} aria-label={tr('Reason')} />
          <div className="dl-answer-go">
            <button type="button" className="btn dl-stop" disabled={busy || !reason.trim()} onClick={() => run(() => onReject(reason.trim()))}>{tr('Turn it down')}</button>
            <button type="button" className="btn btn-secondary" onClick={() => setRejecting(false)}>{tr('Back')}</button>
          </div>
        </div>
      )}
    </article>
  );
}

export function WaitingCard({ w, now, selected, onSelect, onSend }) {
  const pickup = w.fulfillment === 'pickup';
  const cooking = w.stage === 'cooking';
  return (
    <article className={'dl-card is-' + (cooking ? 'cooking' : 'ready') + (selected ? ' is-sel' : '')} onClick={onSelect}>
      <header className="dl-card-head">
        <span className={'dl-badge is-' + (cooking ? 'cooking' : 'ready')}>{cooking ? '🍳' : '📦'} {w.onlineRef || w.label}</span>
        <span className="dl-kind">{w.onlineRef ? tr('Website') : tr('Till')} · {pickup ? tr('Pickup') : tr('Delivery')}</span>
        <span className="dl-wait">{sinceText(w.since, now)}</span>
      </header>
      <div className="dl-who"><strong>{w.customer.name || w.label}</strong><ContactLinks phone={w.customer.phone} /></div>
      {!pickup && (
        <p className="dl-where"><span aria-hidden="true">📍</span><span>{w.customer.address || tr('No address')}{w.customer.landmark && <small>{w.customer.landmark}</small>}
          {w.customer.lat == null && <small className="is-warn">{tr('No pin on the map yet: drop one when you send it.')}</small>}</span></p>
      )}
      <ul className="dl-items is-short">{w.items.map((l, i) => <li key={i}><span>{l}</span></li>)}</ul>
      <div className="dl-money">
        <span>{w.paid ? tr('Paid at the till') : pickup ? tr('Paid at the counter') : tr('The rider collects')}</span>
        <strong>{w.paid ? '✓' : money(w.total)}</strong>
        {!w.paid && w.payMethod && <small>{payName(w.payMethod)}</small>}
      </div>
      <div className="dl-actions" onClick={(e) => e.stopPropagation()}>
        {pickup ? <p className="dl-hint">🥡 {tr('The customer collects it at the counter: charge it on the till then.')}</p>
          : <button type="button" className={'btn ' + (cooking ? 'btn-secondary' : 'dl-go')} onClick={onSend}>🛵 {cooking ? tr('Send a rider now') : tr('Send with a rider')}</button>}
        {cooking && !pickup && <p className="dl-hint">{w.readyMinutes ? tr('The kitchen said about {m}.', { m: minText(w.readyMinutes) }) : tr('A rider can wait at the counter.')}</p>}
      </div>
    </article>
  );
}

// The four steps of a delivery, the scooter riding along them.
function Steps({ d, progress }) {
  const at = stepOf(d.status);
  const labels = [tr('Sent'), tr('Picked up'), tr('At the door'), tr('Delivered')];
  const fill = d.status === 'picked_up' ? (1 + Math.min(0.95, progress || 0)) / 3 : at / 3;
  return (
    <div className="dl-steps" style={{ '--fill': Math.min(1, fill) }}>
      <div className="dl-steps-bar"><i /><span className="dl-steps-ride" aria-hidden="true">{vehicleEmoji(d.rider.vehicle)}</span></div>
      <ol>{labels.map((l, i) => <li key={i} className={i < at ? 'is-done' : i === at ? 'is-now' : ''}>{l}</li>)}</ol>
    </div>
  );
}

export function ActiveCard({ d, now, fetchedAt, here, selected, onSelect, onStatus, onReassign, onCopied }) {
  const [ending, setEnding] = useState(null); // 'failed' | 'cancelled'
  const [taking, setTaking] = useState(false); // delivered: what was collected
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const spot = riderSpot(d, here, now, fetchedAt);
  const next = { assigned: ['picked_up', tr('Picked up the food')], picked_up: ['arrived', tr('Arrived at the door')], arrived: ['delivered', tr('Delivered')] }[d.status];
  const left = rideLeft(d, now);
  const jam = trafficMinutes(d);
  const share = tr('Delivery {ref} for {name}. Open your delivery: {link}', { ref: d.ref, name: d.customer.name, link: d.riderLink || '' });
  async function run(fn) { setBusy(true); try { await fn(); } finally { setBusy(false); } }
  function copy() { if (navigator.clipboard && d.riderLink) navigator.clipboard.writeText(d.riderLink).then(onCopied).catch(() => {}); }
  return (
    <article className={'dl-card is-road' + (selected ? ' is-sel' : '')} onClick={onSelect}>
      <header className="dl-card-head">
        <span className="dl-badge is-road">{vehicleEmoji(d.rider.vehicle)} {d.ref}</span>
        <span className="dl-kind">{d.onlineRef ? d.onlineRef + ' · ' : ''}{statusName(d.status)}</span>
        <span className="dl-wait">{tr('sent {time}', { time: timeOf(d.createdAt) })}</span>
      </header>
      <Steps d={d} progress={spot ? spot.progress : 0} />
      <div className="dl-rider">
        <span className="dl-rider-face" aria-hidden="true">{vehicleEmoji(d.rider.vehicle)}</span>
        <span className="dl-rider-text">
          <strong>{d.rider.name}</strong>
          <small>{vehicleName(d.rider.vehicle)}{d.rider.plate ? ' · ' + d.rider.plate : ''} · <span className={spot && spot.live ? 'dl-live' : 'dl-est'}>{spot && spot.live ? tr('live on the map') : tr('estimated on the map')}</span></small>
        </span>
        <ContactLinks phone={d.rider.phone} text={share} />
      </div>
      <div className="dl-who"><strong>{d.customer.name}</strong><ContactLinks phone={d.customer.phone} lat={d.customer.lat} lng={d.customer.lng} /></div>
      <p className="dl-where"><span aria-hidden="true">📍</span><span>{d.customer.address}{d.customer.landmark && <small>{d.customer.landmark}</small>}</span></p>
      <div className="dl-money">
        <span>{left != null ? tr('About {m} away', { m: minText(left) }) : d.distanceKm != null ? kmText(d.distanceKm) + (d.etaMinutes ? ' · ' + tr('about {m} by road', { m: minText(d.etaMinutes) }) : '') : ''}
          {jam > 0 && <em className="dl-jam">🚦 {tr('{m} more than usual, traffic', { m: minText(jam) })}</em>}</span>
        <strong>{d.toCollect > 0 ? money(d.toCollect) : '✓'}</strong>
        <small>{d.toCollect > 0 ? tr('to collect · {method}', { method: payName(d.collectMethod) }) : tr('paid')}</small>
      </div>
      {taking ? (
        <CollectForm d={d} busy={busy} onBack={() => setTaking(false)} onDone={(c) => run(async () => { await onStatus('delivered', '', c); setTaking(false); })} />
      ) : !ending ? (
        <div className="dl-actions" onClick={(e) => e.stopPropagation()}>
          {next && <button type="button" className="btn dl-go" disabled={busy} onClick={() => (next[0] === 'delivered' && d.toCollect > 0 ? setTaking(true) : run(() => onStatus(next[0])))}>{next[1]}</button>}
          {d.riderLink && <a className="btn btn-secondary dl-share" href={waLink(d.rider.phone, share)} target="_blank" rel="noopener noreferrer">💬 {tr('Send the rider their link')}</a>}
          <div className="dl-more">
            {d.riderLink && <button type="button" className="pos-link" onClick={copy}>{tr('Copy link')}</button>}
            <button type="button" className="pos-link" onClick={onReassign}>{tr('Another rider')}</button>
            <button type="button" className="pos-link" onClick={() => setEnding('failed')}>{tr('Could not deliver')}</button>
            <button type="button" className="pos-link is-bad" onClick={() => setEnding('cancelled')}>{tr('Cancel')}</button>
          </div>
        </div>
      ) : (
        <div className="dl-answer is-no" onClick={(e) => e.stopPropagation()}>
          <span className="dl-answer-label">{ending === 'failed' ? tr('What happened?') : tr('Why is it cancelled?')}</span>
          <input className="input" autoFocus value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder={ending === 'failed' ? tr('e.g. nobody answered, wrong address') : tr('e.g. the customer will come for it')} />
          <div className="dl-answer-go">
            <button type="button" className="btn dl-stop" disabled={busy || !note.trim()} onClick={() => run(async () => { await onStatus(ending, note.trim()); setEnding(null); setNote(''); })}>{ending === 'failed' ? tr('Could not deliver') : tr('Cancel the delivery')}</button>
            <button type="button" className="btn btn-secondary" onClick={() => setEnding(null)}>{tr('Back')}</button>
          </div>
        </div>
      )}
    </article>
  );
}

// What the rider collected at the door, said when it is delivered (on the
// rider's page, or the delivery screen for them): how the customer paid and
// how much — less than the order needs the reason (backend restaurantDelivery
// collectedFrom).
export function CollectForm({ d, busy, onDone, onBack, big }) {
  const owed = d.money ? d.money.owed : d.toCollect;
  const [method, setMethod] = useState(d.collectMethod || 'cash');
  const [amount, setAmount] = useState(String(owed));
  const [why, setWhy] = useState('');
  const n = Number(amount);
  const valid = amount !== '' && Number.isFinite(n) && n >= 0;
  const short = valid && n < owed - 0.004 ? Math.round((owed - n) * 100) / 100 : 0;
  return (
    <div className={'dl-take' + (big ? ' is-big' : '')} onClick={(e) => e.stopPropagation()}>
      <strong className="dl-take-title">💵 {tr('Collect {amount}', { amount: money(owed) })}</strong>
      <span className="dl-answer-label">{tr('How did the customer pay?')}</span>
      <div className="dl-pay-pick" role="radiogroup" aria-label={tr('How did the customer pay?')}>
        {['cash', 'mobile_money'].map((m) => (
          <button key={m} type="button" role="radio" aria-checked={method === m} className={method === m ? 'is-on' : ''} onClick={() => setMethod(m)}>{m === 'cash' ? '💵' : '📱'} {payName(m)}</button>
        ))}
      </div>
      {method === 'mobile_money' && <p className="dl-hint">{tr('Check the customer\'s Mobile Money message shows the payment to the restaurant\'s number.')}</p>}
      <label className="dl-take-amount"><span>{tr('Amount collected')}</span>
        <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} /></label>
      {short > 0 && (
        <>
          <p className="dl-take-short">⚠️ {tr('{amount} less than the order.', { amount: money(short) })}</p>
          <input className="input" value={why} maxLength={200} onChange={(e) => setWhy(e.target.value)} placeholder={tr('Why less? e.g. the customer had only part of it')} />
        </>
      )}
      <div className="dl-answer-go">
        <button type="button" className="btn dl-go" disabled={busy || !valid || (short > 0 && !why.trim())} onClick={() => onDone({ amount: n, method, note: why.trim() })}>
          ✅ {tr('Collected {amount} · Delivered', { amount: money(valid ? n : 0) })}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onBack}>{tr('Back')}</button>
      </div>
    </div>
  );
}

// Where a delivery's money stands: with the rider to hand in, handed in (in
// full, or short), in a line.
export function MoneyLine({ d }) {
  const m = d.money;
  if (!m || m.state === 'none' || m.state === 'to_collect') return null;
  if (m.state === 'with_rider') {
    return (
      <p className="dl-money-line is-held">💵 {tr('{name} has {amount} ({method}) to hand in', { name: d.rider.name, amount: money(m.collected.amount), method: payName(m.collected.method) })}
        {m.short > 0 && <em> · {tr('{amount} less than the order: {why}', { amount: money(m.short), why: m.collected.note })}</em>}</p>
    );
  }
  return (
    <p className={'dl-money-line ' + (m.short > 0 ? 'is-short' : 'is-in')}>{m.short > 0 ? '⚠️' : '✅'} {tr('{amount} handed in to {name} at {time}', { amount: money(m.handed.amount), name: m.handed.by || '—', time: timeOf(m.handed.at) })}
      {m.short > 0 && <em> · {tr('short by {amount}', { amount: money(m.short) })}</em>}</p>
  );
}

export function DoneCard({ d, selected, onSelect }) {
  const took = d.endedAt ? Math.max(1, Math.round((new Date(d.endedAt) - new Date(d.createdAt)) / 60000)) : null;
  const ok = d.status === 'delivered';
  return (
    <article className={'dl-card is-done is-' + d.status + (selected ? ' is-sel' : '')} onClick={onSelect}>
      <header className="dl-card-head">
        <span className={'dl-badge ' + (ok ? 'is-ready' : 'is-bad')}>{ok ? '✅' : d.status === 'failed' ? '⚠️' : '✕'} {d.ref}</span>
        <span className="dl-kind">{statusName(d.status)}{took ? ' · ' + tr('in {m}', { m: minText(took) }) : ''}</span>
        <span className="dl-wait">{timeOf(d.endedAt)}</span>
      </header>
      <p className="dl-done-line"><strong>{d.customer.name}</strong> · {vehicleEmoji(d.rider.vehicle)} {d.rider.name}</p>
      <MoneyLine d={d} />
      {d.note && <p className="dl-note">✎ {d.note}</p>}
    </article>
  );
}

export function TurnedDownCard({ o }) {
  return (
    <article className="dl-card is-done is-turned">
      <header className="dl-card-head">
        <span className="dl-badge is-bad">✕ {o.ref}</span>
        <span className="dl-kind">{o.status === 'cancelled' ? tr('Cancelled') : tr('Turned down')}</span>
        <span className="dl-wait">{timeOf(o.decidedAt || o.placedAt)}</span>
      </header>
      <p className="dl-done-line"><strong>{o.customer.name}</strong> · {money(o.total)}</p>
      {o.rejectReason && <p className="dl-note">✎ {o.rejectReason}</p>}
    </article>
  );
}
