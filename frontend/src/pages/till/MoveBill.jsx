import { useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { tr } from '../../lib/i18n.jsx';
import { modsWords } from './tillBill';

// An open order moved about (RestaurantPosPage.jsx's Open orders; backend
// restaurantPos moveTab, mergeTabs, moveDishes): to another table, joined
// to another order, some of its dishes to another order (or a new one at a
// free table, or under a name), or to another waiter. The kitchen keeps
// cooking what moved, and is told where it goes now.

const WAYS = [
  ['table', '🪑', () => tr('Another table')],
  ['join', '🔗', () => tr('Join another order')],
  ['dishes', '🍽', () => tr('Some dishes')],
  ['waiter', '🙋', () => tr('Another waiter')]
];

export default function MoveBill({ token, tab, tabs, tables, waiters, name, onDone, onClose }) {
  const [way, setWay] = useState('table');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [pick, setPick] = useState({});
  const [dest, setDest] = useState(null); // { tabId } | { tableId } | { label }
  const [label, setLabel] = useState('');
  const whole = (t) => !t.delivery && !t.onlineRef && !String(t.id).startsWith('local:');
  const others = tabs.filter((t) => t.id !== tab.id && whole(t));
  const free = tables.filter((tb) => !tabs.some((t) => t.tableId === tb.id));
  const lines = tab.lines.filter((l) => !l.fee).map((l, i) => ({ ...l, key: i }));
  const chosen = lines.filter((l) => pick[l.key] > 0).map((l) => ({ ...l, qty: pick[l.key] }));

  async function go(path, body, text) {
    setBusy(true); setError(null);
    try { await posFetch('POST', '/pos/tabs/' + tab.id + path, token, body); onDone(text); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  function moveDishes() {
    const target = dest && dest.label !== undefined ? { toLabel: label.trim() } : dest;
    const where = dest && dest.tabId ? name(tabs.find((t) => t.id === dest.tabId)) : dest && dest.tableId ? (tables.find((x) => x.id === dest.tableId) || {}).name : label.trim();
    go('/move-dishes', { lines: chosen, ...target }, tr('{n} moved to {where}.', { n: chosen.reduce((a, l) => a + l.qty, 0) === 1 ? tr('1 dish') : tr('{n} dishes', { n: chosen.reduce((a, l) => a + l.qty, 0) }), where }));
  }

  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog tl-dialog tl-move" role="dialog" aria-modal="true" aria-labelledby="tl-move-title" onClick={(e) => e.stopPropagation()}>
        <span className="tl-dialog-ico is-move" aria-hidden="true">⇄</span>
        <h2 id="tl-move-title">{tr('Move {name}', { name: name(tab) })}</h2>
        <p className="dk-muted">{tr('{n} items · {amount}. The kitchen keeps cooking and is told where the food goes.', { n: tab.lines.reduce((a, l) => a + l.qty, 0), amount: money(tab.total) })}</p>
        <div className="tl-move-ways" role="radiogroup" aria-label={tr('Move it how')}>
          {WAYS.map(([k, ico, label0]) => (
            <button key={k} type="button" role="radio" aria-checked={way === k} className={'tl-move-way' + (way === k ? ' is-on' : '')}
              disabled={(k === 'table' && (tab.fulfillment || 'dine_in') !== 'dine_in') || (k === 'join' && !others.length)}
              onClick={() => { setWay(k); setError(null); setDest(null); }}>
              <span aria-hidden="true">{ico}</span>{label0()}
            </button>
          ))}
        </div>

        {way === 'table' && (
          free.length ? (
            <div className="tl-move-chips">
              {free.map((tb) => <button key={tb.id} type="button" className={'tl-chip' + (dest && dest.tableId === tb.id ? ' is-on' : '')} onClick={() => setDest({ tableId: tb.id })}>{tb.name}</button>)}
            </div>
          ) : <p className="dk-muted">{tr('Every table has an open order: join it to one of them instead.')}</p>
        )}
        {way === 'join' && (
          <ul className="tl-move-list is-plain">
            {others.map((t) => (
              <li key={t.id}><button type="button" className={dest && dest.tabId === t.id ? 'is-on' : ''} onClick={() => setDest({ tabId: t.id })}>
                <strong>{name(t)}</strong><span>{t.lines.reduce((a, l) => a + l.qty, 0)} · {money(t.total)}</span></button></li>
            ))}
          </ul>
        )}
        {way === 'dishes' && (
          <>
            <ul className="tl-bydish-list is-plain">
              {lines.map((l) => {
                const n = pick[l.key] || 0;
                return (
                  <li key={l.key} className={n ? 'is-on' : ''}>
                    <button type="button" className="tl-bydish-name" onClick={() => setPick({ ...pick, [l.key]: n ? 0 : l.qty })}>
                      <b>{l.qty}×</b><span>{l.name}{(l.modifiers || []).length > 0 && <small>{modsWords(l.modifiers, tr)}</small>}</span>
                    </button>
                    <div className="pos-stepper">
                      <button type="button" disabled={!n} onClick={() => setPick({ ...pick, [l.key]: n - 1 })} aria-label={tr('Decrease')}>−</button>
                      <span>{n}</span>
                      <button type="button" disabled={n >= l.qty} onClick={() => setPick({ ...pick, [l.key]: n + 1 })} aria-label={tr('Increase')}>+</button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <h3 className="tl-send-h">{tr('To')}</h3>
            <div className="tl-move-chips">
              {others.map((t) => <button key={t.id} type="button" className={'tl-chip' + (dest && dest.tabId === t.id ? ' is-on' : '')} onClick={() => setDest({ tabId: t.id })}>{name(t)}</button>)}
              {free.map((tb) => <button key={tb.id} type="button" className={'tl-chip is-free' + (dest && dest.tableId === tb.id ? ' is-on' : '')} onClick={() => setDest({ tableId: tb.id })}>{tb.name} · {tr('free')}</button>)}
              <button type="button" className={'tl-chip' + (dest && dest.label !== undefined ? ' is-on' : '')} onClick={() => setDest({ label: '' })}>✎ {tr('A new order with a name')}</button>
            </div>
            {dest && dest.label !== undefined && <input className="input" autoFocus maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={tr('e.g. Kofi at the bar')} aria-label={tr('Name of the new order')} />}
          </>
        )}
        {way === 'waiter' && (
          <div className="tl-move-chips">
            {waiters.map((w) => <button key={w.id} type="button" className={'tl-chip' + (dest && dest.waiterId === w.id ? ' is-on' : '') + (w.id === tab.waiterId ? ' is-now' : '')} onClick={() => setDest({ waiterId: w.id })}>{w.name}</button>)}
          </div>
        )}

        {error && <div className="error-banner">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
          {way === 'table' && <button type="button" className="btn btn-primary" disabled={busy || !(dest && dest.tableId)} onClick={() => go('/move', { tableId: dest.tableId }, tr('{name} moved to {table}.', { name: name(tab), table: (tables.find((x) => x.id === dest.tableId) || {}).name }))}>{tr('Move it')}</button>}
          {way === 'join' && <button type="button" className="btn btn-primary" disabled={busy || !(dest && dest.tabId)} onClick={() => go('/join', { intoTabId: dest.tabId }, tr('{name} joined to {other}.', { name: name(tab), other: name(tabs.find((t) => t.id === dest.tabId)) }))}>{tr('Join them')}</button>}
          {way === 'dishes' && <button type="button" className="btn btn-primary" disabled={busy || !chosen.length || !dest || (dest.label !== undefined && !label.trim())} onClick={moveDishes}>{tr('Move the dishes')}</button>}
          {way === 'waiter' && <button type="button" className="btn btn-primary" disabled={busy || !(dest && dest.waiterId)} onClick={() => go('/move', { waiterId: dest.waiterId }, tr('{name} is {waiter}\'s now.', { name: name(tab), waiter: (waiters.find((w) => w.id === dest.waiterId) || {}).name }))}>{tr('Give it to them')}</button>}
        </div>
      </div>
    </div>
  );
}
