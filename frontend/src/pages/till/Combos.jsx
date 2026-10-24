import { useMemo, useState } from 'react';
import { money } from '../../lib/currency';
import { msg, tr } from '../../lib/i18n.jsx';
import './sixth.css';

// A combo or meal deal (backend restaurantTillMenu saveCombo): a dish sold
// at its own price for one of each part's choices — a main, a side, a
// drink — each choice another dish on the menu (or one of its sizes), with
// what it adds to the price. On the till, the website and the kiosk the
// parts are picked like add-ons; each dish picked comes off the stock and
// counts for the food cost. Used in the menu editor (till/MenuStock.jsx).

const IDEAS = [['🍛', msg('Main')], ['🍟', msg('Side')], ['🥤', msg('Drink')], ['🍰', msg('Dessert')]];

export default function ComboEditor({ slots, onChange, items, selfId, price }) {
  const [adding, setAdding] = useState(null); // the part a dish is being added to
  const [q, setQ] = useState('');
  // Dishes that can be a choice: not a combo themselves, not this one.
  const choosable = useMemo(() => items.filter((i) => i.id !== selfId && !(i.combo || []).length), [items, selfId]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const on = slots.length > 0;
  function setSlot(k, patch) { onChange(slots.map((s, i) => (i === k ? { ...s, ...patch } : s))); }
  function addSlot(name) { onChange(slots.concat([{ name: name ? tr(name) : '', minPick: 1, maxPick: 1, options: [] }])); }
  function addOption(k, item, variationId) {
    const s = slots[k];
    if (s.options.some((o) => o.menuItemId === item.id && (o.variationId || null) === (variationId || null))) return;
    setSlot(k, { options: s.options.concat([{ menuItemId: item.id, variationId: variationId || null, extra: '' }]) });
  }
  function nameOf(o) {
    const it = byId.get(o.menuItemId);
    if (!it) return '—';
    const v = o.variationId && (it.variations || []).find((x) => x.id === o.variationId);
    return v ? it.name + ' — ' + v.name : it.name;
  }
  // The combo's price, cheapest to dearest choices.
  const range = useMemo(() => {
    let lo = Number(price) || 0, hi = Number(price) || 0;
    slots.forEach((s) => {
      const extras = s.options.map((o) => Number(o.extra) || 0).sort((a, b) => a - b);
      if (!extras.length) return;
      const min = Number(s.minPick) || 0, max = Number(s.maxPick) || 1;
      lo += extras.slice(0, min).reduce((a, b) => a + b, 0);
      hi += extras.slice(-max).reduce((a, b) => a + b, 0);
    });
    return [lo, hi];
  }, [slots, price]);
  const shown = choosable.filter((i) => !q.trim() || i.name.toLowerCase().includes(q.trim().toLowerCase()) || (i.category || '').toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div className={'cb' + (on ? ' is-on' : '')}>
      <div className="cb-head">
        <span className="cb-badge" aria-hidden="true">🍱</span>
        <span className="cb-head-text">
          <strong>{tr('Combo or meal deal')}</strong>
          <small>{on ? tr('Sold at its own price for a choice from each part. Each dish picked comes off the stock.') : tr('Make this a combo: a main, a side and a drink for one price, each picked from the menu.')}</small>
        </span>
        {on && <span className="cb-price">{range[0] === range[1] ? money(range[0]) : money(range[0]) + ' – ' + money(range[1])}</span>}
      </div>
      {slots.map((s, k) => (
        <div key={k} className="cb-slot" style={{ '--i': k }}>
          <div className="cb-slot-head">
            <span className="cb-n" aria-hidden="true">{k + 1}</span>
            <input className="input cb-slot-name" maxLength={40} value={s.name} onChange={(e) => setSlot(k, { name: e.target.value })} placeholder={tr('Part, e.g. Main')} aria-label={tr('Name of part {n}', { n: k + 1 })} />
            <label className="cb-pick">
              <span>{tr('Pick')}</span>
              <select className="input" value={s.minPick} onChange={(e) => setSlot(k, { minPick: Number(e.target.value), maxPick: Math.max(Number(e.target.value), s.maxPick) })} aria-label={tr('At least')}>
                {[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>{n === 0 ? tr('optional') : n}</option>)}
              </select>
              <span>{tr('to')}</span>
              <select className="input" value={s.maxPick} onChange={(e) => setSlot(k, { maxPick: Number(e.target.value), minPick: Math.min(s.minPick, Number(e.target.value)) })} aria-label={tr('At most')}>
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <button type="button" className="pos-link is-bad" onClick={() => onChange(slots.filter((x, i) => i !== k))}>{tr('Remove')}</button>
          </div>
          <ul className="cb-opts">
            {s.options.map((o, j) => (
              <li key={o.menuItemId + (o.variationId || '')} className="cb-opt">
                <span className="cb-opt-name">{nameOf(o)}</span>
                <label className="cb-extra">
                  <span>+</span>
                  <input className="input" type="number" min="0" step="0.01" inputMode="decimal" value={o.extra} placeholder="0.00"
                    onChange={(e) => setSlot(k, { options: s.options.map((x, i) => (i === j ? { ...x, extra: e.target.value } : x)) })} aria-label={tr('What {name} adds to the price', { name: nameOf(o) })} />
                </label>
                <button type="button" className="cb-x" onClick={() => setSlot(k, { options: s.options.filter((x, i) => i !== j) })} aria-label={tr('Take {name} off', { name: nameOf(o) })}>×</button>
              </li>
            ))}
            <li>
              <button type="button" className="cb-add" onClick={() => { setAdding(adding === k ? null : k); setQ(''); }}>＋ {tr('Add a dish to pick')}</button>
            </li>
          </ul>
          {adding === k && (
            <div className="cb-picker">
              <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Find a dish…')} aria-label={tr('Find a dish…')} />
              <div className="cb-picker-list">
                {shown.slice(0, 60).map((i) => (
                  <div key={i.id} className="cb-picker-row">
                    <span><b>{i.name}</b><small>{i.category}</small></span>
                    {(i.variations || []).length ? (
                      <span className="cb-sizes">
                        {i.variations.map((v) => <button key={v.id} type="button" className="cb-chip" onClick={() => addOption(k, i, v.id)}>{v.name}</button>)}
                      </span>
                    ) : <button type="button" className="cb-chip" onClick={() => addOption(k, i, null)}>{tr('Add')}</button>}
                  </div>
                ))}
                {!shown.length && <p className="dk-muted">{tr('No dish matches.')}</p>}
              </div>
            </div>
          )}
        </div>
      ))}
      <div className="cb-ideas">
        {IDEAS.filter(([, n]) => !slots.some((s) => s.name.toLowerCase() === tr(n).toLowerCase())).map(([icon, n]) => (
          <button key={n} type="button" className="cb-chip is-idea" onClick={() => addSlot(n)}><span aria-hidden="true">{icon}</span> {tr('+ {part}', { part: tr(n) })}</button>
        ))}
        <button type="button" className="cb-chip is-idea" onClick={() => addSlot('')}>＋ {tr('Another part')}</button>
      </div>
    </div>
  );
}
