import { money } from '../../lib/currency';
import { tr } from '../../lib/i18n.jsx';
import { allergenIcon, allergenWords } from '../till/tillService';
import { happyOff, happyPrice } from './onlineShared';

// What a dish card on the ordering website (OnlineShop) and a table's QR
// menu (TableShop) shows besides its name: its price (less a happy hour on
// now), a happy-hour badge, the time its menu is served from when it is not
// now (breakfast in the afternoon), and its allergen signs (backend
// restaurantOnline menuItems).

export function DishPrice({ item }) {
  const from = item.variations.length ? Math.min(...item.variations.map((v) => v.price)) : item.price;
  const now = happyPrice(from, item.happy);
  const words = (p) => (item.variations.length ? tr('from {price}', { price: money(p) }) : money(p));
  return item.happy ? <span className="on-dish-price is-happy"><s>{money(from)}</s> {words(now)}</span> : <span className="on-dish-price">{words(from)}</span>;
}

// On the dish's picture.
export function DishFlags({ item }) {
  return (
    <>
      {item.happy && !item.soldOut && !item.notNow && <span className="on-happy">🍹 −{item.happy.percent}%</span>}
      {item.notNow && !item.soldOut && <span className="on-sold is-later">🕘 {tr('From {time}', { time: item.hours.from })}</span>}
    </>
  );
}

export function DishAllergens({ item }) {
  const list = item.allergens || [];
  if (!list.length) return null;
  const words = tr('Contains: {list}', { list: list.map((a) => allergenWords(a, tr)).join(', ') });
  return <small className="on-dish-allergens" role="img" title={words} aria-label={words}>{list.map((a) => <i key={a}>{allergenIcon(a)}</i>)}</small>;
}

// A basket line's amount, less its happy hour.
export function LineAmount({ line }) {
  const gross = Math.round(line.qty * line.price * 100) / 100;
  const off = happyOff(line);
  return <i className={off ? 'is-happy' : ''}>{off ? <><s>{money(gross)}</s> {money(gross - off)}</> : money(gross)}</i>;
}
