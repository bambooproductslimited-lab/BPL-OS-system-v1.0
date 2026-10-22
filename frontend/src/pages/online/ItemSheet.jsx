import { useState } from 'react';
import { money } from '../../lib/currency';
import { tr } from '../../lib/i18n.jsx';
import { photo, tint } from './onlineShared';

// A dish on the ordering website (OnlineShop) or a table's QR menu
// (TableShop): its photo, its size, how many, a note for the kitchen.
export default function ItemSheet({ item, onClose, onAdd }) {
  const [variation, setVariation] = useState(item.variations[0] || null);
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const price = variation ? variation.price : item.price;
  return (
    <div className="on-sheet-back" onClick={onClose}>
      <div className="on-sheet" role="dialog" aria-modal="true" aria-label={item.name} onClick={(e) => e.stopPropagation()}>
        <div className="on-sheet-pic" style={{ '--c': tint(item.name) }}>
          {item.photoFull ? <img src={photo(item.photoFull)} alt="" /> : <b>{item.name.replace(/^zq\s+/i, '').charAt(0)}</b>}
          <button type="button" className="on-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        <div className="on-sheet-body">
          <h2>{item.name}</h2>
          <p className="on-price">{money(price)}</p>
          {item.variations.length > 0 && (
            <div className="on-vars" role="radiogroup" aria-label={tr('Choose one')}>
              {item.variations.map((v) => (
                <button key={v.id} type="button" role="radio" aria-checked={variation && variation.id === v.id} className={variation && variation.id === v.id ? 'is-on' : ''} onClick={() => setVariation(v)}>
                  <span>{v.name}</span><b>{money(v.price)}</b>
                </button>
              ))}
            </div>
          )}
          <label className="on-field"><span>{tr('A note for the kitchen')}</span><input className="input" value={note} maxLength={140} onChange={(e) => setNote(e.target.value)} placeholder={tr('e.g. no pepper, extra sauce')} /></label>
          <div className="on-sheet-go">
            <span className="on-qty is-big"><button type="button" onClick={() => setQty(Math.max(1, qty - 1))} aria-label={tr('One less')}>−</button><b>{qty}</b><button type="button" onClick={() => setQty(Math.min(50, qty + 1))} aria-label={tr('One more')}>+</button></span>
            <button type="button" className="on-go" onClick={() => onAdd({ id: item.id, variationId: variation ? variation.id : null, name: item.name + (variation ? ' — ' + variation.name : ''), price, qty, note: note.trim() })}>
              {tr('Add · {amount}', { amount: money(price * qty) })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

