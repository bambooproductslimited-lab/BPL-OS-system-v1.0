import { money } from '../../lib/currency';
import { tr } from '../../lib/i18n.jsx';
import { lineKey, photo, tint } from './onlineShared';

// Catering on the ordering website (backend restaurantOnline cateringOut,
// migration 0194): party trays, each serving a number of people, for an
// event days or weeks ahead. How many guests, then the trays; a bar shows
// how many the trays serve. On to the checkout, for the day and the time.

export default function CateringSheet({ c, basket, setBasket, guests, setGuests, onCheckout, onClose }) {
  const serves = basket.reduce((a, l) => a + l.qty * (l.serves || 0), 0);
  const subtotal = Math.round(basket.reduce((a, l) => a + l.qty * l.price, 0) * 100) / 100;
  const fill = guests > 0 ? Math.min(1, serves / guests) : 0;
  const enoughGuests = guests >= c.minGuests;
  const short = c.minOrder > 0 && subtotal < c.minOrder;
  function qtyOf(it, v) { const l = basket.find((x) => x.id === it.id && (x.variationId || null) === (v ? v.id : null)); return l ? l.qty : 0; }
  function setQty(it, v, qty) {
    const line = { id: it.id, variationId: v ? v.id : null, name: it.name + (v ? ' — ' + v.name : ''), price: v ? v.price : it.price, qty: 1, note: '', modifiers: [], serves: it.serves };
    const k = lineKey(line);
    setBasket((b) => {
      const at = b.findIndex((x) => lineKey(x) === k);
      if (qty <= 0) return b.filter((x) => lineKey(x) !== k);
      if (at < 0) return b.concat([{ ...line, qty }]);
      return b.map((x, i) => (i === at ? { ...x, qty: Math.min(50, qty) } : x));
    });
  }
  const rows = c.items.flatMap((it) => ((it.variations || []).length ? it.variations.map((v) => [it, v]) : [[it, null]]));
  return (
    <div className="on-sheet-back is-checkout" onClick={onClose}>
      <div className="on-sheet ctg" role="dialog" aria-modal="true" aria-labelledby="ctg-title" onClick={(e) => e.stopPropagation()}>
        <div className="on-co-head">
          <button type="button" className="on-x is-plain" onClick={onClose} aria-label={tr('Back')}>←</button>
          <h2 id="ctg-title">🎉 {tr('Catering for your event')}</h2>
        </div>
        <div className="ctg-hero">
          <span className="ctg-art" aria-hidden="true">🍱<i>🎈</i></span>
          <div>
            <strong>{tr('Party trays for {n} guests and more', { n: c.minGuests })}</strong>
            <small>{tr('Order at least {n} days ahead, for {from} to {to}.', { n: c.leadDays, from: c.from, to: c.to })}</small>
            {c.note && <small className="ctg-note">{c.note}</small>}
          </div>
        </div>
        <div className="ctg-guests">
          <span>{tr('How many guests?')}</span>
          <span className="on-qty is-big">
            <button type="button" onClick={() => setGuests(Math.max(1, guests - 5))} aria-label={tr('Five fewer')}>−</button>
            <input className="ctg-guests-in" type="number" inputMode="numeric" min={c.minGuests} max={5000} value={guests || ''} onChange={(e) => setGuests(Math.max(0, Math.min(5000, Math.round(Number(e.target.value) || 0))))} aria-label={tr('Guests')} />
            <button type="button" onClick={() => setGuests(Math.min(5000, guests + 5))} aria-label={tr('Five more')}>+</button>
          </span>
        </div>
        {!enoughGuests && <p className="on-dist is-bad">{tr('Catering is for {n} guests or more.', { n: c.minGuests })}</p>}
        <div className="ctg-meter" style={{ '--fill': fill }} aria-label={tr('Serves {n} of {guests} guests', { n: serves, guests })}>
          <i />
          <span>{serves >= guests && guests > 0 ? '✅ ' + tr('Enough for {guests} guests', { guests }) : tr('Serves {n} of {guests} guests', { n: serves, guests })}</span>
        </div>
        <ul className="ctg-list">
          {rows.map(([it, v], i) => {
            const q = qtyOf(it, v);
            return (
              <li key={it.id + (v ? v.id : '')} className={q ? 'is-in' : ''} style={{ '--i': i }}>
                <span className="ctg-pic" style={{ '--c': tint(it.name) }}>{it.photoFull ? <img src={photo(it.photoFull)} alt="" loading="lazy" /> : <b>{it.name.replace(/^zq\s+/i, '').charAt(0)}</b>}</span>
                <span className="ctg-name">
                  <strong>{it.name}{v ? ' — ' + v.name : ''}</strong>
                  <small>👥 {tr('Serves {n}', { n: it.serves })} · {money(v ? v.price : it.price)}</small>
                  {it.soldOut && <small className="is-bad">{tr('Sold out')}</small>}
                </span>
                <span className="on-qty">
                  <button type="button" onClick={() => setQty(it, v, q - 1)} disabled={!q} aria-label={tr('One less')}>−</button>
                  <b>{q}</b>
                  <button type="button" onClick={() => setQty(it, v, q + 1)} disabled={it.soldOut} aria-label={tr('One more')}>+</button>
                </span>
              </li>
            );
          })}
        </ul>
        <div className="ctg-foot">
          <div><small>{basket.length ? tr('{n} trays', { n: basket.reduce((a, l) => a + l.qty, 0) }) : tr('No trays yet')}</small><strong>{money(subtotal)}</strong></div>
          {short && <p className="on-dist is-bad">{tr('The smallest catering order is {amount}.', { amount: money(c.minOrder) })}</p>}
          <button type="button" className="on-go is-big" disabled={!basket.length || short || !enoughGuests} onClick={onCheckout}>🗓️ {tr('Choose the day and time')}</button>
        </div>
      </div>
    </div>
  );
}

