import { useState } from 'react';
import { Icon } from '../../components/DashKit';
import { money } from '../../lib/currency';
import { tr } from '../../lib/i18n.jsx';
import { FulfillmentIcon, QUICK_NOTES, fulfillmentName, lineKey } from './tillShared';

// The till's small dialogs around an order (RestaurantPosPage.jsx): a note
// on one dish, a dish that is not on the menu, where a delivery goes, and
// the check before an order goes to the kitchen.

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

// Who a delivery is for, how to reach them and where it goes. The customer
// picked fills in the name and phone.
export function DeliveryDialog({ value, customer, onSave, onClose, onPickCustomer }) {
  const [f, setF] = useState(() => ({
    name: value.name || (customer ? customer.name : ''), phone: value.phone || (customer ? customer.phone || '' : ''), address: value.address || ''
  }));
  const ok = f.name.trim() && f.phone.trim() && f.address.trim();
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog tl-dialog" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (ok) onSave({ name: f.name.trim(), phone: f.phone.trim(), address: f.address.trim() }); }}>
        <span className="tl-dialog-ico is-delivery" aria-hidden="true"><Icon name="send" /></span>
        <h2>{tr('Delivery')}</h2>
        <p className="dk-muted">{tr('Who it is for, a number to reach them, and where to take it. All three are needed.')}</p>
        <div className="tl-form-grid">
          <div className="field">
            <label htmlFor="tl-d-name">{tr('Customer name')}</label>
            <input id="tl-d-name" className="input" autoFocus={!f.name} maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="tl-d-phone">{tr('Phone or contact')}</label>
            <input id="tl-d-phone" className="input" type="tel" maxLength={40} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="024 000 0000" />
          </div>
          <div className="field tl-span">
            <label htmlFor="tl-d-addr">{tr('Location')}</label>
            <textarea id="tl-d-addr" className="input" rows={3} autoFocus={!!f.name} maxLength={300} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })}
              placeholder={tr('Area, street, a landmark, the house — what the rider needs')} />
          </div>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onPickCustomer}>{customer ? tr('Another customer') : tr('Pick a customer')}</button>
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={!ok}>{tr('Save delivery')}</button>
        </div>
      </form>
    </div>
  );
}

// Before an order goes to the kitchen: what goes now, for whom and where.
// What went before (an open order's earlier rounds) is listed apart, and a
// dish taken off is called out — the kitchen stops it.
export function SendConfirmDialog({ cart, sent, fulfillment, where, customer, waiter, delivery, kitchenNote, busy, error, onConfirm, onClose }) {
  const before = new Map((sent || []).map((l) => [lineKey(l), l.qty]));
  const now = new Map(cart.map((l) => [lineKey(l), l]));
  const going = [];
  cart.forEach((l) => { const more = l.qty - (before.get(lineKey(l)) || 0); if (more > 0) going.push({ ...l, qty: more }); });
  const off = [];
  (sent || []).forEach((l) => { const left = now.get(lineKey(l)); const less = l.qty - (left ? left.qty : 0); if (less > 0) off.push({ ...l, qty: less }); });
  const already = (sent || []).reduce((n, l) => n + Math.min(l.qty, (now.get(lineKey(l)) || { qty: 0 }).qty), 0);
  const total = cart.reduce((s, l) => s + l.price * l.qty, 0);
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
              <li key={lineKey(l)}><b>{l.qty}×</b><span>{l.name}{l.custom && <em className="tl-badge">{tr('not on the menu')}</em>}{l.note && <small>✎ {l.note}</small>}</span></li>
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
