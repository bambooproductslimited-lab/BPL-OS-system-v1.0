import { useState } from 'react';
import { money } from '../../lib/currency';
import { tr } from '../../lib/i18n.jsx';
import { allergenWords } from '../till/tillService';
import { happyPrice, photo, tint } from './onlineShared';

// A dish on the ordering website (OnlineShop) or a table's QR menu
// (TableShop): its photo, its size, its add-ons (a side to pick, extras
// that cost more; backend restaurantTillCheck pickMods checks them), how
// many, a note for the kitchen; what is in it that some cannot eat, a happy
// hour on it now, and when it is served if not now.
function ruleWords(g) {
  const min = g.minPick || 0, max = g.maxPick;
  if (min && max && min === max) return min === 1 ? tr('Pick 1') : tr('Pick {n}', { n: min });
  if (min && max) return tr('Pick {a} to {b}', { a: min, b: max });
  if (min) return tr('Pick at least {n}', { n: min });
  if (max) return tr('Up to {n}', { n: max });
  return tr('Optional');
}

export default function ItemSheet({ item, onClose, onAdd }) {
  const [variation, setVariation] = useState(item.variations[0] || null);
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const [picked, setPicked] = useState([]);
  const groups = item.addOns || [];
  const base = variation ? variation.price : item.price;
  const price = Math.round((base + picked.reduce((a, m) => a + m.price, 0)) * 100) / 100;
  const now = happyPrice(price, item.happy);
  const short = groups.find((g) => (g.minPick || 0) > picked.filter((m) => m.groupId === g.id).length);

  function tap(g, o) {
    const mine = picked.filter((m) => m.groupId === g.id);
    if (mine.some((m) => m.id === o.id)) { setPicked(picked.filter((m) => m.id !== o.id)); return; }
    const one = { id: o.id, groupId: g.id, name: o.name, price: o.price };
    // One to pick: the new one takes the old one's place.
    if (g.maxPick === 1) setPicked(picked.filter((m) => m.groupId !== g.id).concat([one]));
    else if (!g.maxPick || mine.length < g.maxPick) setPicked(picked.concat([one]));
  }
  function add() {
    // In the menu's order, as the till and the kitchen show them.
    const order = groups.flatMap((g) => g.options.map((o) => o.id));
    const mods = picked.slice().sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    onAdd({ id: item.id, variationId: variation ? variation.id : null, name: item.name + (variation ? ' — ' + variation.name : ''), price, qty, note: note.trim(), modifiers: mods, happy: item.happy || null });
  }

  return (
    <div className="on-sheet-back" onClick={onClose}>
      <div className="on-sheet" role="dialog" aria-modal="true" aria-label={item.name} onClick={(e) => e.stopPropagation()}>
        <div className="on-sheet-pic" style={{ '--c': tint(item.name) }}>
          {item.photoFull ? <img src={photo(item.photoFull)} alt="" /> : <b>{item.name.replace(/^zq\s+/i, '').charAt(0)}</b>}
          <button type="button" className="on-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        <div className="on-sheet-body">
          <h2>{item.name}</h2>
          {item.happy ? (
            <p className="on-price is-happy"><s>{money(price)}</s> {money(now)}
              <em>🍹 {tr('{name}: {percent}% off until {time}', { name: item.happy.name || tr('Happy hour'), percent: item.happy.percent, time: item.happy.to })}</em></p>
          ) : <p className="on-price">{money(price)}</p>}
          {item.notNow && <p className="on-served">🕘 {tr('Served from {from} to {to}. Not now, sorry.', { from: item.hours.from, to: item.hours.to })}</p>}
          {(item.allergens || []).length > 0 && (
            <div className="on-allergens">
              <span>{tr('Contains')}</span>
              {item.allergens.map((a) => <b key={a}>{allergenWords(a, tr)}</b>)}
              <small>{tr('Allergic? Say so in the note, and the kitchen will be told.')}</small>
            </div>
          )}
          {item.variations.length > 0 && (
            <div className="on-vars" role="radiogroup" aria-label={tr('Choose one')}>
              {item.variations.map((v) => (
                <button key={v.id} type="button" role="radio" aria-checked={variation && variation.id === v.id} className={variation && variation.id === v.id ? 'is-on' : ''} onClick={() => setVariation(v)}>
                  <span>{v.name}</span><b>{money(v.price)}</b>
                </button>
              ))}
            </div>
          )}
          {groups.map((g) => {
            const n = picked.filter((m) => m.groupId === g.id).length;
            const need = (g.minPick || 0) > n;
            return (
              <fieldset key={g.id} className={'on-addons' + (need ? ' is-need' : '')}>
                <legend><span>{g.name}</span><small>{ruleWords(g)}</small></legend>
                <div className="on-addon-opts">
                  {g.options.map((o) => {
                    const on = picked.some((m) => m.id === o.id);
                    const full = !on && g.maxPick > 1 && n >= g.maxPick;
                    return (
                      <button key={o.id} type="button" role={g.maxPick === 1 ? 'radio' : 'checkbox'} aria-checked={on} disabled={full} className={'on-addon' + (on ? ' is-on' : '')} onClick={() => tap(g, o)}>
                        <i aria-hidden="true">{on ? '✓' : '+'}</i><span>{o.name}</span>{o.price > 0 && <b>+{money(o.price)}</b>}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            );
          })}
          <label className="on-field"><span>{tr('A note for the kitchen')}</span><input className="input" value={note} maxLength={140} onChange={(e) => setNote(e.target.value)} placeholder={tr('e.g. no pepper, extra sauce')} /></label>
          {short && <p className="on-hint is-need">{tr('Pick from {group} first.', { group: short.name })}</p>}
          <div className="on-sheet-go">
            <span className="on-qty is-big"><button type="button" onClick={() => setQty(Math.max(1, qty - 1))} aria-label={tr('One less')}>−</button><b>{qty}</b><button type="button" onClick={() => setQty(Math.min(50, qty + 1))} aria-label={tr('One more')}>+</button></span>
            <button type="button" className="on-go" disabled={!!short || !!item.notNow} onClick={add}>
              {tr('Add · {amount}', { amount: money(now * qty) })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
