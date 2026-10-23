import { useRef, useState } from 'react';
import { money } from '../../lib/currency';
import { tr } from '../../lib/i18n.jsx';

// The restaurant's floor as a map: each table where it stands (left and top
// in % of the map, set in the till settings), round, square or long, with
// its seats. On the till (RestaurantPosPage.jsx) a tap picks a table, and a
// table with an open order shows it — its total and where its food is. In
// the settings (TillSettings.jsx) tables are dragged into place.
//
// A table not placed yet is shown in a row along the bottom (on the till)
// or waits in the tray (in the settings) until it is dragged on.

// Where to show a table that has not been placed: along the bottom, in rows.
export function placed(tables) {
  let n = 0;
  return tables.map((t) => {
    if (t.mapX != null && t.mapY != null) return { ...t, x: t.mapX, y: t.mapY, auto: false };
    const i = n++;
    return { ...t, x: 8 + (i % 8) * 12, y: 82 - Math.floor(i / 8) * 14, auto: true };
  });
}

function TableShape({ t, children, className, style, ...rest }) {
  return (
    <div className={'tm-table is-' + (t.shape || 'square') + ' is-seats-' + Math.min(12, t.seats || 4) + (className ? ' ' + className : '')}
      style={{ left: t.x + '%', top: t.y + '%', ...style }} {...rest}>
      {children}
    </div>
  );
}

// On the till: pick a table. tabs: the open orders (to show a table taken);
// booked: the bookings of the next hours by table (a 📅 with the time).
export function TableMapPicker({ tables, tabs, booked, selectedId, onPick }) {
  const byTable = new Map((tabs || []).filter((t) => t.tableId).map((t) => [t.tableId, t]));
  const areas = Array.from(new Set(tables.map((t) => t.area).filter(Boolean)));
  const [area, setArea] = useState('');
  const shown = placed(area ? tables.filter((t) => t.area === area) : tables);
  return (
    <div className="tm">
      {areas.length > 1 && (
        <div className="tm-areas" role="radiogroup" aria-label={tr('Area')}>
          <button type="button" role="radio" aria-checked={!area} className={!area ? 'is-on' : ''} onClick={() => setArea('')}>{tr('Everywhere')}</button>
          {areas.map((a) => <button key={a} type="button" role="radio" aria-checked={area === a} className={area === a ? 'is-on' : ''} onClick={() => setArea(a)}>{a}</button>)}
        </div>
      )}
      <div className="tm-floor" role="listbox" aria-label={tr('Tables')}>
        {shown.map((t) => {
          const tab = byTable.get(t.id);
          const state = tab ? (tab.kitchen && tab.kitchen.state ? tab.kitchen.state : 'open') : 'free';
          const bk = booked ? booked[t.id] : null;
          return (
            <TableShape key={t.id} t={t} role="option" aria-selected={selectedId === t.id} tabIndex={0}
              className={'is-' + state + (selectedId === t.id ? ' is-selected' : '') + (t.auto ? ' is-auto' : '')}
              onClick={() => onPick(t, tab)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(t, tab); } }}
              title={tab ? tr('{table}: open order of {amount}', { table: t.name, amount: money(tab.total) }) : tr('{table}: free · {n} seats', { table: t.name, n: t.seats })}>
              <strong>{t.name}</strong>
              <small>{tab ? money(tab.total) : tr('{n} seats', { n: t.seats })}</small>
              {tab && <i className="tm-dot" aria-hidden="true" />}
              {bk && <em className="tm-booked" title={tr('Booked for {name}, {n} people, at {time}', { name: bk.name, n: bk.party, time: new Date(bk.at).toISOString().slice(11, 16) })}>📅 {new Date(bk.at).toISOString().slice(11, 16)}</em>}
            </TableShape>
          );
        })}
        {!tables.length && <p className="tm-empty">{tr('No tables yet. A manager draws the floor in Till settings → Floor map.')}</p>}
      </div>
      <div className="tm-legend" aria-hidden="true">
        <span className="is-free">{tr('Free')}</span><span className="is-open">{tr('Open order')}</span>
        <span className="is-cooking">{tr('Cooking')}</span><span className="is-ready">{tr('Food ready')}</span><span className="is-served">{tr('Food served')}</span>
        {booked && Object.keys(booked).length > 0 && <span className="is-booked">📅 {tr('Booked soon')}</span>}
      </div>
    </div>
  );
}

// In the settings: drag tables into place; tap one to edit it.
export function TableMapEditor({ tables, selectedId, onSelect, onMove }) {
  const floor = useRef(null);
  const drag = useRef(null);
  const all = placed(tables.filter((t) => !t.remove));
  function pointAt(e) {
    const r = floor.current.getBoundingClientRect();
    return { x: Math.max(4, Math.min(96, ((e.clientX - r.left) / r.width) * 100)), y: Math.max(6, Math.min(94, ((e.clientY - r.top) / r.height) * 100)) };
  }
  function down(e, t) {
    e.preventDefault();
    onSelect(t.key);
    drag.current = { key: t.key, moved: false };
    if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId);
  }
  function move(e) {
    if (!drag.current) return;
    const p = pointAt(e);
    drag.current.moved = true;
    onMove(drag.current.key, Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10);
  }
  function up() { drag.current = null; }
  return (
    <div className="tm tm-edit">
      <div className="tm-floor" ref={floor} onPointerMove={move} onPointerUp={up} onPointerLeave={up}>
        <span className="tm-grid" aria-hidden="true" />
        {all.map((t) => (
          <TableShape key={t.key} t={t} className={(selectedId === t.key ? 'is-selected' : '') + (t.auto ? ' is-auto' : '') + ' is-free'}
            onPointerDown={(e) => down(e, t)} role="button" tabIndex={0} aria-label={tr('{table}: drag to move', { table: t.name })}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 5 : 1;
              const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
              if (d) { e.preventDefault(); onSelect(t.key); onMove(t.key, Math.max(4, Math.min(96, t.x + d[0])), Math.max(6, Math.min(94, t.y + d[1]))); }
            }}>
            <strong>{t.name}</strong>
            <small>{tr('{n} seats', { n: t.seats })}</small>
          </TableShape>
        ))}
        {!all.length && <p className="tm-empty">{tr('No tables yet. Add one, then drag it to where it stands.')}</p>}
      </div>
      <p className="tm-hint">{tr('Drag a table to where it stands (or use the arrow keys). Tables along the bottom are not placed yet.')}</p>
    </div>
  );
}
