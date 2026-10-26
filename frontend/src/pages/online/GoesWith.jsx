import { money } from '../../lib/currency';
import { tr } from '../../lib/i18n.jsx';
import { happyPrice, needsChoosing, photo, tint } from './onlineShared';

// "Goes well with" (backend restaurantSuggestions.service, migration 0193):
// after a dish goes in the basket, up to three others suggested with it —
// the manager's picks, or what is most often ordered with it. One tap adds
// a plain one; one with sizes or add-ons to choose opens its sheet. Each is
// marked suggested, for the restaurant's report. On the website, the kiosk
// and the table's QR page.

export default function GoesWith({ item, list, onAdd, onOpen, onClose, big }) {
  return (
    <div className="on-sheet-back is-gw" onClick={onClose}>
      <div className={'on-sheet on-gw' + (big ? ' is-big' : '')} role="dialog" aria-modal="true" aria-labelledby="on-gw-title" onClick={(e) => e.stopPropagation()}>
        <div className="on-gw-head">
          <span className="on-gw-tick" aria-hidden="true">✓</span>
          <span><small>{tr('In your basket')}</small><strong>{item.name}</strong></span>
          <button type="button" className="on-x is-plain" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        <h2 id="on-gw-title">✨ {tr('Goes well with it')}</h2>
        <ul className="on-gw-list">
          {list.map((s, i) => {
            const price = happyPrice(s.price, s.happy);
            return (
              <li key={s.id} style={{ '--i': i }}>
                <span className="on-gw-pic" style={{ '--c': tint(s.name) }}>{s.photoUrl ? <img src={photo(s.photoUrl)} alt="" /> : <b>{s.name.replace(/^zq\s+/i, '').charAt(0)}</b>}</span>
                <span className="on-gw-name"><strong>{s.name}</strong><small>{(s.variations || []).length ? tr('from {amount}', { amount: money(Math.min(...s.variations.map((v) => v.price))) }) : money(price)}</small></span>
                <button type="button" className="on-gw-add" onClick={() => (needsChoosing(s) ? onOpen(s)
                  : onAdd({ id: s.id, variationId: null, name: s.name, price: s.price, qty: 1, note: '', modifiers: [], happy: s.happy || null, suggested: true }))}
                  aria-label={tr('Add {name}', { name: s.name })}>{needsChoosing(s) ? tr('Choose') : '＋ ' + tr('Add')}</button>
              </li>
            );
          })}
        </ul>
        <button type="button" className="on-go is-ghost" onClick={onClose}>{tr('No, thanks')}</button>
      </div>
    </div>
  );
}
