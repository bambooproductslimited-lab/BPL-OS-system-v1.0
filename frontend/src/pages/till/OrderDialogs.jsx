import { useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { Icon } from '../../components/DashKit';
import { money } from '../../lib/currency';
import { msg, tr } from '../../lib/i18n.jsx';
import { FulfillmentIcon, QUICK_NOTES, fulfillmentName, kitchenKey as lineKey } from './tillShared';
import { AllergyStrip } from './ServiceParts';

// The till's small dialogs around an order (RestaurantPosPage.jsx): a note
// on one dish, a dish that is not on the menu, where a delivery goes, the
// check before an order goes to the kitchen, and a problem reported (a
// complaint, a wrong charge) for a manager to resolve.

// A note on one dish for the kitchen ("no pepper"), typed or tapped.
export function NoteDialog({ line, onSave, onClose }) {
  const [note, setNote] = useState(line.note || '');
  function tap(q) {
    const word = tr(q);
    const parts = note.split(',').map((x) => x.trim()).filter(Boolean);
    setNote(parts.includes(word) ? parts.filter((x) => x !== word).join(', ') : parts.concat([word]).join(', '));
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog tl-dialog" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onSave(note.trim()); }}>
        <h2>{tr('Note for {dish}', { dish: line.name })}</h2>
        <p className="dk-muted">{tr('The kitchen sees it under the dish, and it prints on the receipt.')}</p>
        <div className="tl-chips">
          {QUICK_NOTES.map((q) => {
            const on = note.split(',').map((x) => x.trim()).includes(tr(q));
            return <button key={q} type="button" className={'tl-chip' + (on ? ' is-on' : '')} aria-pressed={on} onClick={() => tap(q)}>{tr(q)}</button>;
          })}
        </div>
        <input className="input" autoFocus maxLength={140} value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr('e.g. no onions, sauce on the side')} aria-label={tr('Note')} />
        <div className="dialog-actions">
          {line.note && <button type="button" className="btn btn-secondary" onClick={() => onSave('')}>{tr('Remove the note')}</button>}
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary">{tr('Save note')}</button>
        </div>
      </form>
    </div>
  );
}

// A dish that is not on the menu: its name, price, how many, which part of
// the kitchen cooks it (by menu category) and a note.
export function CustomItemDialog({ categories, onAdd, onClose }) {
  const [f, setF] = useState({ name: '', price: '', qty: 1, category: '', note: '' });
  const price = Number(f.price);
  const ok = f.name.trim() && f.price !== '' && price >= 0;
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog tl-dialog" onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (ok) onAdd({ name: f.name.trim(), price: Math.round(price * 100) / 100, qty: Math.max(1, Number(f.qty) || 1), category: f.category, note: f.note.trim() }); }}>
        <span className="tl-dialog-ico is-custom" aria-hidden="true"><Icon name="spark" /></span>
        <h2>{tr('A dish not on the menu')}</h2>
        <p className="dk-muted">{tr('For something the menu does not have: give it a name and a price. It goes on this order only.')}</p>
        <div className="tl-form-grid">
          <div className="field tl-span">
            <label htmlFor="tl-c-name">{tr('Name')}</label>
            <input id="tl-c-name" className="input" autoFocus maxLength={80} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={tr('e.g. Extra plantain, Birthday cake')} />
          </div>
          <div className="field">
            <label htmlFor="tl-c-price">{tr('Price each')}</label>
            <input id="tl-c-price" className="input" type="number" min="0" step="0.01" inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} placeholder="0.00" />
          </div>
          <div className="field">
            <label htmlFor="tl-c-qty">{tr('How many')}</label>
            <input id="tl-c-qty" className="input" type="number" min="1" step="1" inputMode="numeric" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} />
          </div>
          <div className="field tl-span">
            <label htmlFor="tl-c-cat">{tr('Cooked like')}</label>
            <select id="tl-c-cat" className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
              <option value="">{tr('Anything else (the main kitchen)')}</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <small className="dk-muted">{tr('Which kitchen station gets it: the one that cooks this part of the menu.')}</small>
          </div>
          <div className="field tl-span">
            <label htmlFor="tl-c-note">{tr('Note for the kitchen (optional)')}</label>
            <input id="tl-c-note" className="input" maxLength={140} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          </div>
        </div>
        {ok && <p className="tl-sum">{tr('{n} × {name} = {amount}', { n: Math.max(1, Number(f.qty) || 1), name: f.name.trim(), amount: money(price * Math.max(1, Number(f.qty) || 1)) })}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={!ok}>{tr('Add to the order')}</button>
        </div>
      </form>
    </div>
  );
}

// Who a delivery is for, a number to reach them and where to take it; or,
// for a pickup (pickup), who it is for and a number to call when it is ready.
// The customer picked fills in the name and phone.
export function DeliveryDialog({ value, customer, pickup, onSave, onClose, onPickCustomer }) {
  const [f, setF] = useState(() => ({
    name: value.name || (customer ? customer.name : ''), phone: value.phone || (customer ? customer.phone || '' : ''), address: value.address || ''
  }));
  const ok = f.name.trim() && f.phone.trim() && (pickup || f.address.trim());
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className={'dialog tl-dialog' + (pickup ? ' tl-pickup' : '')} onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (ok) onSave({ name: f.name.trim(), phone: f.phone.trim(), address: pickup ? value.address || '' : f.address.trim() }); }}>
        <span className={'tl-dialog-ico ' + (pickup ? 'is-pickup' : 'is-delivery')} aria-hidden="true"><Icon name={pickup ? 'bag' : 'send'} /></span>
        <h2>{pickup ? tr('Pickup') : tr('Delivery')}</h2>
        <p className="dk-muted">{pickup ? tr('Who it is for, and a number to call them on when it is ready. Both are needed.') : tr('Who it is for, a number to reach them, and where to take it. All three are needed.')}</p>
        <div className="tl-form-grid">
          <div className="field">
            <label htmlFor="tl-d-name">{tr('Customer name')}</label>
            <input id="tl-d-name" className="input" autoFocus={!f.name} maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="tl-d-phone">{tr('Phone or contact')}</label>
            <input id="tl-d-phone" className="input" type="tel" autoFocus={pickup && !!f.name} maxLength={40} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="024 000 0000" />
          </div>
          {!pickup && (
            <div className="field tl-span">
              <label htmlFor="tl-d-addr">{tr('Location')}</label>
              <textarea id="tl-d-addr" className="input" rows={3} autoFocus={!!f.name} maxLength={300} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })}
                placeholder={tr('Area, street, a landmark, the house — what the rider needs')} />
            </div>
          )}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onPickCustomer}>{customer ? tr('Another customer') : tr('Pick a customer')}</button>
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={!ok}>{pickup ? tr('Save pickup') : tr('Save delivery')}</button>
        </div>
      </form>
    </div>
  );
}

// Before an order goes to the kitchen: what goes now, for whom and where.
// What went before (an open order's earlier rounds) is listed apart, and a
// dish taken off is called out — the kitchen stops it.
// courseFor(line): its course and whether it waits for the waiter's call
// ({ name, waits }), when courses are on; allergy: the order's alert.
export function SendConfirmDialog({ cart, sent, total: billTotal, fulfillment, where, customer, waiter, delivery, kitchenNote, busy, error, onConfirm, onClose, courseFor, allergy }) {
  const before = new Map((sent || []).map((l) => [lineKey(l), l.qty]));
  const now = new Map(cart.map((l) => [lineKey(l), l]));
  const going = [];
  cart.forEach((l) => { const more = l.qty - (before.get(lineKey(l)) || 0); if (more > 0) going.push({ ...l, qty: more }); });
  const off = [];
  (sent || []).forEach((l) => { const left = now.get(lineKey(l)); const less = l.qty - (left ? left.qty : 0); if (less > 0) off.push({ ...l, qty: less }); });
  const already = (sent || []).reduce((n, l) => n + Math.min(l.qty, (now.get(lineKey(l)) || { qty: 0 }).qty), 0);
  // The bill so far, with its discounts, service charge and taxes (till/tillBill).
  const total = billTotal != null ? billTotal : cart.reduce((s, l) => s + l.price * l.qty, 0);
  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog tl-dialog tl-send" role="dialog" aria-modal="true" aria-labelledby="tl-send-title" onClick={(e) => e.stopPropagation()}>
        <span className="tl-dialog-ico is-send" aria-hidden="true"><Icon name="send" /></span>
        <h2 id="tl-send-title">{tr('Send to the kitchen?')}</h2>
        <div className="tl-send-where">
          <span className={'tl-ful is-' + fulfillment}><FulfillmentIcon kind={fulfillment} />{fulfillmentName(fulfillment)}</span>
          <strong>{where}</strong>
          {[customer, waiter ? tr('Waiter: {name}', { name: waiter }) : null].filter(Boolean).map((x) => <span key={x} className="dk-muted">{x}</span>)}
        </div>
        {fulfillment === 'delivery' && delivery && (
          <p className="tl-send-deliver"><Icon name="send" /><span><b>{delivery.address}</b><br />{delivery.name} · {delivery.phone}</span></p>
        )}
        <h3 className="tl-send-h">{going.length ? tr('Going to the kitchen now') : tr('Nothing new for the kitchen')}</h3>
        {going.length > 0 && (
          <ul className="tl-send-list">
            {going.map((l) => (
              <li key={lineKey(l)}><b>{l.qty}×</b><span>{l.seat ? <em className="tl-seat">S{l.seat}</em> : null}{l.name}{l.custom && <em className="tl-badge">{tr('not on the menu')}</em>}{l.note && <small>✎ {l.note}</small>}
                {(() => { const c = courseFor ? courseFor(l) : null; return c ? <em className={'tl-send-course' + (c.waits ? ' is-wait' : '')}>{c.waits ? '⏸ ' + tr('{course}: waits for your call', { course: c.name }) : c.name}</em> : null; })()}</span></li>
            ))}
          </ul>
        )}
        {off.length > 0 && (
          <ul className="tl-send-list is-off">
            {off.map((l) => <li key={'off' + lineKey(l)}><b>−{l.qty}×</b><span>{l.name}<small>{tr('taken off: the kitchen stops it')}</small></span></li>)}
          </ul>
        )}
        {already > 0 && <p className="dk-muted tl-small">{already === 1 ? tr('1 dish was sent before and stays as it is.') : tr('{n} dishes were sent before and stay as they are.', { n: already })}</p>}
        {kitchenNote && <p className="tl-send-note">✎ {kitchenNote}</p>}
        <AllergyStrip allergy={allergy} />
        <p className="tl-send-total"><span>{tr('The order so far')}</span><strong>{money(total)}</strong></p>
        <p className="dk-muted tl-small">{tr('It stays open on the till to add to and pay later.')}</p>
        {error && <div className="error-banner">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Go back')}</button>
          <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={busy} autoFocus>{busy ? tr('Sending…') : going.length ? tr('Yes, send it') : tr('Keep it open')}</button>
        </div>
      </div>
    </div>
  );
}

// A problem with a sale or an open order (or none): a complaint, a wrong
// charge, something else. It goes to the manager's Disputes
// (restaurantDisputes.service.js). target: { orderId?, tabId?, label, customerName }.
const DISPUTE_KINDS = [['complaint', msg('Complaint')], ['wrong_charge', msg('Wrong charge')], ['other', msg('Other problem')]];
export function DisputeDialog({ token, target, onClose, onSaved }) {
  const t = target || {};
  const [kind, setKind] = useState('complaint');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [customer, setCustomer] = useState(t.customerName || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const kinds = t.orderId ? DISPUTE_KINDS : DISPUTE_KINDS.filter(([k]) => k !== 'wrong_charge');
  async function send(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await posFetch('POST', '/pos/disputes', token, { kind, description, amount: amount === '' ? undefined : Number(amount), customerName: customer, orderId: t.orderId, tabId: t.tabId });
      onSaved();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <form className="dialog tl-dialog" onClick={(e) => e.stopPropagation()} onSubmit={send}>
        <span className="tl-dialog-ico is-dispute" aria-hidden="true"><Icon name="warn" /></span>
        <h2>{t.label ? tr('A problem with {order}', { order: t.label }) : tr('Report a problem')}</h2>
        <p className="dk-muted">{tr('It goes to the manager, who sees it under Disputes and says how it was resolved.')}</p>
        <div className="tl-chips" role="radiogroup" aria-label={tr('What kind of problem')}>
          {kinds.map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={kind === k} className={'tl-chip' + (kind === k ? ' is-on' : '')} onClick={() => setKind(k)}>{tr(label)}</button>)}
        </div>
        <div className="tl-form-grid">
          <div className="field tl-span">
            <label htmlFor="tl-dp-what">{tr('What happened')}</label>
            <textarea id="tl-dp-what" className="input" rows={3} autoFocus required maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder={kind === 'wrong_charge' ? tr('e.g. charged twice on Mobile Money') : tr('e.g. the fish came cold')} />
          </div>
          <div className="field">
            <label htmlFor="tl-dp-who">{tr('Customer (optional)')}</label>
            <input id="tl-dp-who" className="input" maxLength={80} value={customer} onChange={(e) => setCustomer(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="tl-dp-amt">{kind === 'wrong_charge' ? tr('Amount charged wrong') : tr('Amount (optional)')}</label>
            <input id="tl-dp-amt" className="input" type="number" min="0" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          </div>
        </div>
        {error && <div className="error-banner">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || description.trim().length < 3}>{busy ? tr('Sending…') : tr('Send to the manager')}</button>
        </div>
      </form>
    </div>
  );
}
