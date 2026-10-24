import { useEffect, useMemo, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { msg, tr } from '../../lib/i18n.jsx';
import { dealWords, isOpen } from './promos';
import './sixth.css';

// Deals and promo codes, in the till settings (Setup → Deals; backend
// restaurantPromos.service.js): discounts that go on a bill by themselves
// when it qualifies, or with the deal's code — on the till, the kiosk, the
// website — one per bill, the best for the customer; and a large party's
// service charge at a table. Each deal is a coupon card; tapped, it opens
// to be changed. Saved with the settings.

const DAYS = [msg('Sun'), msg('Mon'), msg('Tue'), msg('Wed'), msg('Thu'), msg('Fri'), msg('Sat')];
const KINDS = [['percent', msg('% off')], ['amount', msg('Money off')], ['buyget', msg('Buy and get')]];
const WHERE = [['till', msg('Till'), '🧾'], ['kiosk', msg('Kiosk'), '🖥️'], ['online', msg('Website'), '🌐']];
function newId() { return 'promo-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function blank(over) {
  return { id: newId(), name: '', on: true, kind: 'percent', value: 10, buy: 0, get: 0, categories: [], items: [], minSpend: 0, code: '', days: [], from: '', to: '', startsOn: '', endsOn: '', where: { till: true, kiosk: true, online: true }, ...over };
}
const IDEAS = [
  ['☀️', msg('Lunch 10% off'), () => blank({ name: tr('Lunch 10% off'), value: 10, days: [1, 2, 3, 4, 5], from: '12:00', to: '15:00' })],
  ['🎁', msg('Buy 2, get 1 free'), () => blank({ name: tr('Buy 2, get 1 free'), kind: 'buyget', buy: 2, get: 1, value: 100 })],
  ['💸', msg('GHS 20 off a bill of 200'), () => blank({ name: tr('GHS 20 off a bill of 200'), kind: 'amount', value: 20, minSpend: 200 })],
  ['🎟️', msg('A promo code'), () => blank({ name: tr('Promo code 15% off'), value: 15, code: 'WELCOME15', where: { till: true, kiosk: true, online: true } })]
];

// When a deal is on, in words: "Mon–Fri · 12:00–15:00 · until 30 Nov".
function whenWords(p) {
  const parts = [];
  if (p.days && p.days.length && p.days.length < 7) parts.push(p.days.map((d) => tr(DAYS[d])).join(' '));
  parts.push(p.from && p.to ? p.from + '–' + p.to : tr('All day'));
  if (p.startsOn) parts.push(tr('from {date}', { date: p.startsOn }));
  if (p.endsOn) parts.push(tr('until {date}', { date: p.endsOn }));
  return parts.join(' · ');
}
function stampOf(p) {
  if (p.kind === 'buyget') return [tr('Buy {n}', { n: p.buy || '?' }), p.value >= 100 ? tr('get {n} free', { n: p.get || '?' }) : tr('get {n} −{pct}%', { n: p.get || '?', pct: p.value })];
  if (p.kind === 'amount') return [money(p.value), tr('off')];
  return [p.value + '%', tr('off')];
}

function DealCard({ p, k, open, onOpen, dishes }) {
  const live = p.on && isOpen(p, { channel: 'till', code: p.code });
  const [big, small] = stampOf(p);
  const scope = (p.categories || []).concat((p.items || []).map((id) => (dishes.get(id) || {}).name).filter(Boolean));
  return (
    <button type="button" className={'dz-card' + (p.on ? '' : ' is-off') + (open ? ' is-open' : '')} style={{ '--i': k }} onClick={onOpen} aria-expanded={open}>
      <span className="dz-stamp"><b>{big}</b><small>{small}</small></span>
      <span className="dz-perf" aria-hidden="true" />
      <span className="dz-card-main">
        <strong>{p.name || tr('A new deal')}</strong>
        <small>{scope.length ? tr('On {things}', { things: scope.slice(0, 4).join(', ') + (scope.length > 4 ? '…' : '') }) : tr('On the whole bill')}{p.minSpend > 0 ? ' · ' + tr('from {amount}', { amount: money(p.minSpend) }) : ''}</small>
        <small>{whenWords(p)}</small>
        <span className="dz-tags">
          {p.code ? <span className="dz-code">🎟️ {p.code}</span> : <span className="dz-auto">⚡ {tr('By itself')}</span>}
          {WHERE.filter(([w]) => p.where[w]).map(([w, label, icon]) => <span key={w} className="dz-where">{icon} {tr(label)}</span>)}
          {!p.on ? <span className="dz-state is-off">{tr('Off')}</span> : live ? <span className="dz-state is-live">● {tr('On now')}</span> : <span className="dz-state">{tr('Not now')}</span>}
        </span>
      </span>
    </button>
  );
}

function DealEditor({ p, onChange, onRemove, categories, dishList }) {
  const [q, setQ] = useState('');
  const set = (patch) => onChange({ ...p, ...patch });
  const found = q.trim() ? dishList.filter((d) => d.name.toLowerCase().includes(q.trim().toLowerCase()) && !p.items.includes(d.id)).slice(0, 8) : [];
  const allDay = !p.from && !p.to;
  return (
    <div className="dz-edit">
      <div className="dz-row">
        <div className="field dz-grow"><label htmlFor={'dz-n-' + p.id}>{tr('Name')}</label><input id={'dz-n-' + p.id} className="input" maxLength={60} value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder={tr('e.g. Lunch 10% off')} /></div>
        <button type="button" role="switch" aria-checked={p.on} className="dz-on" onClick={() => set({ on: !p.on })}>
          <span className={'ts-switch' + (p.on ? ' is-on' : '')} aria-hidden="true"><i /></span>{p.on ? tr('On') : tr('Off')}
        </button>
      </div>
      <div className="ts-chips" role="radiogroup" aria-label={tr('Kind of deal')}>
        {KINDS.map(([k, label]) => (
          <button key={k} type="button" role="radio" aria-checked={p.kind === k} className={p.kind === k ? 'is-on' : ''}
            onClick={() => set(k === 'buyget' ? { kind: k, buy: p.buy || 2, get: p.get || 1, value: 100 } : { kind: k, value: k === 'amount' ? 20 : 10 })}>{tr(label)}</button>
        ))}
      </div>
      <div className="dz-row">
        {p.kind === 'buyget' ? (
          <>
            <label className="dz-num"><span>{tr('Buy')}</span><input className="input" type="number" min="1" max="20" value={p.buy} onChange={(e) => set({ buy: Number(e.target.value) })} /></label>
            <label className="dz-num"><span>{tr('get')}</span><input className="input" type="number" min="1" max="20" value={p.get} onChange={(e) => set({ get: Number(e.target.value) })} /></label>
            <label className="dz-num"><span>{tr('at')}</span><input className="input" type="number" min="1" max="100" value={p.value} onChange={(e) => set({ value: Number(e.target.value) })} /><span>{tr('% off')}</span></label>
            <button type="button" className={'ts-chip' + (p.value >= 100 ? ' is-on' : '')} onClick={() => set({ value: 100 })}>{tr('Free')}</button>
          </>
        ) : (
          <label className="dz-num"><span>{p.kind === 'amount' ? 'GHS' : '%'}</span><input className="input" type="number" min="0" step={p.kind === 'amount' ? '0.01' : '1'} value={p.value} onChange={(e) => set({ value: Number(e.target.value) })} aria-label={tr('How much off')} /><span>{tr('off')}</span></label>
        )}
        <label className="dz-num"><span>{tr('Bill of at least')}</span><input className="input" type="number" min="0" step="0.01" value={p.minSpend || ''} placeholder="0" onChange={(e) => set({ minSpend: Number(e.target.value) || 0 })} /></label>
      </div>
      <p className="dz-say">{tr('Customers see: {words}', { words: dealWords(p, tr, money) + (p.minSpend > 0 ? ' · ' + tr('on a bill of {amount} or more', { amount: money(p.minSpend) }) : '') })}</p>

      <span className="ts-label">{tr('On')}</span>
      <div className="ts-chips">
        <button type="button" className={'ts-chip' + (!p.categories.length && !p.items.length ? ' is-on' : '')} onClick={() => set({ categories: [], items: [] })}>{tr('Everything')}</button>
        {categories.map((c) => {
          const on = p.categories.includes(c);
          return <button key={c} type="button" aria-pressed={on} className={'ts-chip' + (on ? ' is-on' : '')} onClick={() => set({ categories: on ? p.categories.filter((x) => x !== c) : p.categories.concat([c]) })}>{c}</button>;
        })}
      </div>
      <div className="dz-dishes">
        {p.items.map((id) => {
          const d = dishList.find((x) => x.id === id);
          return <span key={id} className="dz-dish">{d ? d.name : '—'}<button type="button" onClick={() => set({ items: p.items.filter((x) => x !== id) })} aria-label={tr('Take {name} off', { name: d ? d.name : '' })}>×</button></span>;
        })}
        <input className="input dz-find" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Or pick dishes…')} aria-label={tr('Or pick dishes…')} />
        {found.length > 0 && (
          <div className="dz-found">
            {found.map((d) => <button key={d.id} type="button" onClick={() => { set({ items: p.items.concat([d.id]) }); setQ(''); }}>{d.name}<small>{d.category}</small></button>)}
          </div>
        )}
      </div>

      <span className="ts-label">{tr('When')}</span>
      <div className="ts-chips">
        {DAYS.map((d, i) => {
          const on = p.days.includes(i);
          return <button key={i} type="button" aria-pressed={on} className={'ts-chip' + (on ? ' is-on' : '')} onClick={() => set({ days: on ? p.days.filter((x) => x !== i) : p.days.concat([i]).sort() })}>{tr(d)}</button>;
        })}
        <small className="dk-muted dz-hint">{p.days.length ? '' : tr('No day picked: every day.')}</small>
      </div>
      <div className="dz-row">
        <button type="button" className={'ts-chip' + (allDay ? ' is-on' : '')} onClick={() => set(allDay ? { from: '12:00', to: '15:00' } : { from: '', to: '' })}>{tr('All day')}</button>
        {!allDay && (
          <>
            <label className="dz-num"><span>{tr('From')}</span><input className="input" type="time" value={p.from} onChange={(e) => set({ from: e.target.value })} /></label>
            <label className="dz-num"><span>{tr('to')}</span><input className="input" type="time" value={p.to} onChange={(e) => set({ to: e.target.value })} /></label>
          </>
        )}
        <label className="dz-num"><span>{tr('Starts')}</span><input className="input" type="date" value={p.startsOn} onChange={(e) => set({ startsOn: e.target.value })} /></label>
        <label className="dz-num"><span>{tr('Ends')}</span><input className="input" type="date" value={p.endsOn} onChange={(e) => set({ endsOn: e.target.value })} /></label>
      </div>

      <span className="ts-label">{tr('Where, and how')}</span>
      <div className="dz-row">
        {WHERE.map(([w, label, icon]) => (
          <button key={w} type="button" role="switch" aria-checked={!!p.where[w]} className={'dz-where-btn' + (p.where[w] ? ' is-on' : '')} onClick={() => set({ where: { ...p.where, [w]: !p.where[w] } })}>
            <span aria-hidden="true">{icon}</span>{tr(label)}
          </button>
        ))}
        <div className="field dz-code-field">
          <label htmlFor={'dz-c-' + p.id}>{tr('Promo code (optional)')}</label>
          <input id={'dz-c-' + p.id} className="input" maxLength={24} value={p.code} onChange={(e) => set({ code: e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '') })} placeholder={tr('None: it goes on by itself')} />
        </div>
      </div>
      <div className="dz-edit-foot">
        <button type="button" className="pos-link is-bad" onClick={onRemove}>{tr('Remove this deal')}</button>
      </div>
    </div>
  );
}

export default function DealsSettings({ draft, set, categories, token }) {
  const list = draft.promotions || [];
  const [open, setOpen] = useState(null);
  const [dishList, setDishes] = useState([]);
  // The menu's dishes, to put a deal on some of them.
  useEffect(() => { posFetch('GET', '/pos/menu', token).then((t) => setDishes(t.map((d) => ({ id: d.id, name: d.name, category: d.category })))).catch(() => {}); }, [token]);
  const dishes = useMemo(() => new Map(dishList.map((d) => [d.id, d])), [dishList]);
  const party = draft.partyService || { on: false, minGuests: 8, rate: 10, name: '' };
  function change(i, p) { set(['promotions'], list.map((x, k) => (k === i ? p : x))); }
  function add(p) { set(['promotions'], list.concat([p])); setOpen(p.id); }
  return (
    <section className="ts-sec dz">
      <div className="dz-hero">
        <span className="dz-hero-art" aria-hidden="true">🎟️</span>
        <div>
          <strong>{tr('Deals that work by themselves')}</strong>
          <p>{tr('A deal goes on the bill by itself when the order fits — the right dishes, day and time — or when the customer gives its code. One deal per bill: the one that saves them most. A dish given its own discount gets no deal on top.')}</p>
        </div>
      </div>
      {list.length > 0 && (
        <div className="dz-list">
          {list.map((p, i) => (
            <div key={p.id} className="dz-item">
              <DealCard p={p} k={i} open={open === p.id} onOpen={() => setOpen(open === p.id ? null : p.id)} dishes={dishes} />
              {open === p.id && <DealEditor p={p} categories={categories || []} dishList={dishList} onChange={(x) => change(i, x)} onRemove={() => { set(['promotions'], list.filter((x, k) => k !== i)); setOpen(null); }} />}
            </div>
          ))}
        </div>
      )}
      <div className="dz-ideas">
        <span className="ts-label">{list.length ? tr('Add another') : tr('Start with one of these')}</span>
        <div className="dz-idea-row">
          {IDEAS.map(([icon, label, make]) => <button key={label} type="button" className="dz-idea" onClick={() => add(make())}><span aria-hidden="true">{icon}</span>{tr(label)}</button>)}
          <button type="button" className="dz-idea is-blank" onClick={() => add(blank({ name: '' }))}>＋ {tr('Your own')}</button>
        </div>
      </div>

      <div className={'dz-party' + (party.on ? ' is-on' : '')}>
        <span className="dz-party-art" aria-hidden="true">👨‍👩‍👧‍👦</span>
        <div className="dz-party-main">
          <button type="button" role="switch" aria-checked={party.on} className="ts-toggle-row" onClick={() => set(['partyService'], { ...party, on: !party.on })}>
            <span><strong>{tr('Service charge for large parties')}</strong><small>{tr('A table with this many guests or more pays it on its own bill, in place of the usual service charge when it is larger. The cashier can still take it off with the right.')}</small></span>
            <span className={'ts-switch' + (party.on ? ' is-on' : '')} aria-hidden="true"><i /></span>
          </button>
          {party.on && (
            <div className="dz-row">
              <label className="dz-num"><span>{tr('From')}</span><input className="input" type="number" min="2" max="200" value={party.minGuests} onChange={(e) => set(['partyService'], { ...party, minGuests: Number(e.target.value) })} /><span>{tr('guests')}</span></label>
              <label className="dz-num"><input className="input" type="number" min="1" max="30" step="0.5" value={party.rate} onChange={(e) => set(['partyService'], { ...party, rate: Number(e.target.value) })} /><span>%</span></label>
              <div className="field dz-grow"><label htmlFor="dz-party-name">{tr('Name on the bill')}</label><input id="dz-party-name" className="input" maxLength={40} value={party.name} onChange={(e) => set(['partyService'], { ...party, name: e.target.value })} placeholder={tr('Large party service')} /></div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
