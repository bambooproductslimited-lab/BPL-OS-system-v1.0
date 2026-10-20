import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/DashKit';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { activeIntlLocale, msg, tr } from '../../lib/i18n.jsx';
import { TableMapEditor } from './TableMap';

// The till settings' newer tabs (TillSettings.jsx): the floor map, the
// customers' VIP and IOU accounts, and the activity report of everything
// on the till and the kitchen screen. The map and the accounts are saved
// with the rest of the settings; the report only reads
// (restaurantTillAccess.service.js, restaurantActivity.service.js).

const SHAPES = [['square', msg('Square')], ['round', msg('Round')], ['long', msg('Long')]];

// ── the floor map ──
// tables: the draft, each { key, id?, name, mapX, mapY, shape, seats, area, remove? }.
export function FloorMapTab({ tables, setTables }) {
  const [sel, setSel] = useState(null);
  const shown = tables.filter((t) => !t.remove);
  const cur = shown.find((t) => t.key === sel) || null;
  const areas = Array.from(new Set(shown.map((t) => t.area).filter(Boolean))).sort();
  function patch(key, p) { setTables(tables.map((t) => (t.key === key ? { ...t, ...p } : t))); }
  function add() {
    const n = shown.length + 1;
    let name = tr('Table {n}', { n });
    let i = n;
    while (shown.some((t) => t.name.toLowerCase() === name.toLowerCase())) { i += 1; name = tr('Table {n}', { n: i }); }
    const key = 'new-' + Date.now();
    setTables(tables.concat([{ key, name, mapX: 50, mapY: 45, shape: 'square', seats: 4, area: cur ? cur.area : '' }]));
    setSel(key);
  }
  function remove(t) {
    if (t.id) patch(t.key, { remove: true }); else setTables(tables.filter((x) => x.key !== t.key));
    setSel(null);
  }
  return (
    <section className="ts-sec ts-map">
      <p className="dk-muted">{tr('Draw the restaurant: add each table, drag it to where it stands, and say its shape and seats. The till picks tables on this map and shows which have an open order and where their food is.')}</p>
      <div className="ts-map-grid">
        <TableMapEditor tables={shown} selectedId={sel} onSelect={setSel} onMove={(key, x, y) => patch(key, { mapX: x, mapY: y })} />
        <aside className="ts-map-side">
          <button type="button" className="btn btn-primary" onClick={add}><Icon name="spark" /> {tr('Add a table')}</button>
          {cur ? (
            <div className="ts-map-edit">
              <div className="field">
                <label htmlFor="ts-t-name">{tr('Name')}</label>
                <input id="ts-t-name" className="input" maxLength={40} value={cur.name} onChange={(e) => patch(cur.key, { name: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="ts-t-seats">{tr('Seats')}</label>
                <input id="ts-t-seats" className="input" type="number" min="1" max="40" value={cur.seats} onChange={(e) => patch(cur.key, { seats: Number(e.target.value) || 1 })} />
              </div>
              <div className="field">
                <span className="ts-label">{tr('Shape')}</span>
                <div className="ts-chips" role="radiogroup" aria-label={tr('Shape')}>
                  {SHAPES.map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={cur.shape === k} className={cur.shape === k ? 'is-on' : ''} onClick={() => patch(cur.key, { shape: k })}>{tr(label)}</button>)}
                </div>
              </div>
              <div className="field">
                <label htmlFor="ts-t-area">{tr('Area (optional)')}</label>
                <input id="ts-t-area" className="input" list="ts-areas" maxLength={40} value={cur.area} onChange={(e) => patch(cur.key, { area: e.target.value })} placeholder={tr('e.g. Inside, Terrace, Bar')} />
                <datalist id="ts-areas">{areas.map((a) => <option key={a} value={a} />)}</datalist>
              </div>
              <button type="button" className="pos-link is-bad" onClick={() => remove(cur)}>{tr('Take this table away')}</button>
              {cur.id && <small className="dk-muted">{tr('Past sales at it keep its name.')}</small>}
            </div>
          ) : <p className="ts-hint">{tr('Tap a table on the map to name it, give it seats and a shape.')}</p>}
          <ul className="ts-map-list">
            {shown.map((t) => (
              <li key={t.key}><button type="button" className={sel === t.key ? 'is-on' : ''} onClick={() => setSel(t.key)}>
                <span className={'ts-map-swatch is-' + t.shape} aria-hidden="true" />{t.name}<small>{t.mapX == null ? tr('not placed') : tr('{n} seats', { n: t.seats })}</small>
              </button></li>
            ))}
          </ul>
        </aside>
      </div>
    </section>
  );
}

// ── customers: VIP and IOU accounts ──
// changes: { [id]: { iouAllowed, iouLimit } } kept until saved.
export function CustomersTab({ token, pin, changes, setChange, onFail }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState(null);
  const load = useCallback(async (search) => {
    try { setList(await posFetch('POST', '/pos/settings/customers', token, { managerPin: pin || undefined, q: search })); } catch (err) { onFail(err); }
  }, [token, pin, onFail]);
  useEffect(() => { const t = setTimeout(() => load(q), q ? 250 : 0); return () => clearTimeout(t); }, [q, load]);
  function value(c) { return Object.prototype.hasOwnProperty.call(changes, c.id) ? changes[c.id] : { iouAllowed: c.iouAllowed, iouLimit: c.iouLimit }; }
  return (
    <section className="ts-sec">
      <p className="dk-muted">{tr('A VIP account is opened when a customer puts money down (VIP on the till). An IOU account lets a customer owe: only customers given one here can buy on IOU, up to their limit.')}</p>
      <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Find a customer by name or phone…')} aria-label={tr('Find a customer by name or phone…')} />
      {!list ? <p className="dk-muted">{tr('Loading…')}</p> : !list.length ? (
        <div className="dk-empty"><Icon name="info" /><p>{q ? tr('No customer matches "{search}".', { search: q }) : tr('No customer has a VIP or IOU account yet. Find one to open an IOU account.')}</p></div>
      ) : (
        <ul className="ts-cust">
          {list.map((c) => {
            const v = value(c);
            const changed = Object.prototype.hasOwnProperty.call(changes, c.id);
            return (
              <li key={c.id} className={changed ? 'is-changed' : ''}>
                <span className="ts-person">
                  <strong>{c.name}</strong>
                  <small>{[c.phone, c.owed > 0 ? (c.ious === 1 ? tr('owes {amount} (1 IOU)', { amount: money(c.owed) }) : tr('owes {amount} ({n} IOUs)', { amount: money(c.owed), n: c.ious })) : null].filter(Boolean).join(' · ')}</small>
                </span>
                <span className={'ts-acct is-vip' + (c.vip ? ' is-on' : '')} title={c.vip ? tr('VIP account') : tr('No VIP account: they put money down on the till to open one.')}>
                  {tr('VIP')} {c.vip ? money(c.vipBalance) : '—'}
                </span>
                <button type="button" role="switch" aria-checked={v.iouAllowed} className="ts-acct-switch" onClick={() => setChange(c.id, { ...v, iouAllowed: !v.iouAllowed })}>
                  <span>{tr('IOU account')}</span><span className={'ts-switch' + (v.iouAllowed ? ' is-on' : '')} aria-hidden="true"><i /></span>
                </button>
                <label className="ts-acct-limit">
                  <span>{tr('Limit')}</span>
                  <input className="input" type="number" min="0" step="1" disabled={!v.iouAllowed} value={v.iouLimit == null ? '' : v.iouLimit}
                    onChange={(e) => setChange(c.id, { ...v, iouLimit: e.target.value === '' ? null : Number(e.target.value) })} placeholder={tr('No limit')} />
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ── the activity report ──
const APP_LABEL = { till: msg('Till'), kds: msg('Kitchen screen'), settings: msg('Settings') };
const KIND_ICON = {
  signin: 'key', sale: 'cash', kitchen: 'send', refund: 'void', vip: 'spark', iou_paid: 'owed', removed: 'void', customer: 'people', favorite: 'star',
  drawer_open: 'drawer', drawer_close: 'drawer', paid_in: 'drawer', paid_out: 'drawer', ready: 'check', dish_done: 'check', dish_back: 'clock',
  station_done: 'check', served: 'bag', cleared: 'void', recalled: 'clock', printed: 'receipt', saved: 'key'
};
// What each line is, said in the reader's language (the summary under it
// is the record as written).
const ACTION_LABEL = {
  'till.signin': msg('Signed in'), 'till.sale': msg('Sale'), 'till.kitchen': msg('Sent to the kitchen'), 'till.refund': msg('Refund'), 'till.vip': msg('VIP money put down'),
  'till.iou_paid': msg('IOU paid'), 'till.removed': msg('Open order removed'), 'till.customer': msg('New customer'), 'till.favorite': msg('Favourites changed'),
  'till.drawer_open': msg('Cash drawer opened'), 'till.drawer_close': msg('Cash drawer closed'), 'till.paid_in': msg('Paid in'), 'till.paid_out': msg('Paid out'),
  'till.served': msg('Food served'), 'kds.signin': msg('Signed in'), 'kds.dish_done': msg('Dish done'), 'kds.dish_back': msg('Dish back to cooking'), 'kds.station_done': msg('Station done'),
  'kds.ready': msg('Food ready'), 'kds.served': msg('Food served'), 'kds.cleared': msg('Cancelled'), 'kds.recalled': msg('Brought back'), 'kds.printed': msg('Ticket printed'),
  'settings.saved': msg('Settings changed')
};
const KINDS = [['', msg('Everything')], ['till.sale', msg('Sales')], ['till.kitchen', msg('Sent to the kitchen')], ['till.refund', msg('Refunds')], ['till.drawer', msg('Cash drawer')], ['kds.', msg('Kitchen')], ['settings.', msg('Settings changed')]];
function dayISO(d) { return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }

export function ActivityTab({ token, pin, onFail }) {
  const today = dayISO(new Date());
  const [range, setRange] = useState('today');
  const [day, setDay] = useState(today);
  const [app, setApp] = useState('');
  const [kind, setKind] = useState('');
  const [who, setWho] = useState('');
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const dates = useMemo(() => {
    const d = new Date();
    if (range === 'today') return { from: today, to: today };
    if (range === 'yesterday') { const y = dayISO(new Date(d.getTime() - 86400000)); return { from: y, to: y }; }
    if (range === 'week') return { from: dayISO(new Date(d.getTime() - 6 * 86400000)), to: today };
    return { from: day, to: day };
  }, [range, day, today]);
  const body = useCallback((before) => ({ managerPin: pin || undefined, from: dates.from, to: dates.to, app: app || undefined, kind: kind || undefined, employeeId: who || undefined, q: q || undefined, before }), [pin, dates, app, kind, who, q]);
  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      try { const d = await posFetch('POST', '/pos/settings/activity', token, body()); if (live) setData(d); } catch (err) { if (live) onFail(err); }
    }, q ? 300 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [token, body, q, onFail]);
  async function more() {
    setBusy(true);
    try {
      const d = await posFetch('POST', '/pos/settings/activity', token, body(data.rows[data.rows.length - 1].id));
      setData({ ...data, rows: data.rows.concat(d.rows), more: d.more });
    } catch (err) { onFail(err); } finally { setBusy(false); }
  }
  function download() {
    const head = [tr('When'), tr('Where'), tr('Who'), tr('What'), tr('Details'), tr('Amount')];
    const rows = data.rows.map((r) => [new Date(r.at).toLocaleString(activeIntlLocale()), tr(APP_LABEL[r.app]), r.who || '', ACTION_LABEL[r.action] ? tr(ACTION_LABEL[r.action]) : r.action, r.summary, r.amount == null ? '' : r.amount.toFixed(2)]);
    const csv = [head].concat(rows).map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = 'till-activity-' + dates.from + (dates.to !== dates.from ? '-to-' + dates.to : '') + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  // Rows by day, newest first.
  const groups = useMemo(() => {
    const out = [];
    (data ? data.rows : []).forEach((r) => {
      const d = new Date(r.at).toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long' });
      if (!out.length || out[out.length - 1][0] !== d) out.push([d, []]);
      out[out.length - 1][1].push(r);
    });
    return out;
  }, [data]);
  const t = data && data.totals;
  return (
    <section className="ts-sec ts-act">
      <div className="ts-act-filters">
        <div className="ts-chips" role="radiogroup" aria-label={tr('When')}>
          {[['today', tr('Today')], ['yesterday', tr('Yesterday')], ['week', tr('Last 7 days')], ['day', tr('A day…')]].map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={range === k} className={range === k ? 'is-on' : ''} onClick={() => setRange(k)}>{label}</button>
          ))}
          {range === 'day' && <input className="input ts-act-day" type="date" max={today} value={day} onChange={(e) => e.target.value && setDay(e.target.value)} aria-label={tr('Day')} />}
        </div>
        <div className="ts-act-row">
          <select className="input" value={app} onChange={(e) => setApp(e.target.value)} aria-label={tr('Where')}>
            <option value="">{tr('Till and kitchen')}</option>
            {Object.keys(APP_LABEL).map((k) => <option key={k} value={k}>{tr(APP_LABEL[k])}</option>)}
          </select>
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value)} aria-label={tr('What')}>
            {KINDS.map(([k, label]) => <option key={k} value={k}>{tr(label)}</option>)}
          </select>
          <select className="input" value={who} onChange={(e) => setWho(e.target.value)} aria-label={tr('Who')}>
            <option value="">{tr('Everyone')}</option>
            {(data ? data.staff : []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Search: order, table, customer…')} aria-label={tr('Search')} />
        </div>
      </div>
      {t && (
        <div className="ts-act-sum">
          <span><b>{t.events}</b>{tr('things happened')}</span>
          <span className="is-sales"><b>{t.sales}</b>{tr('sales · {amount}', { amount: money(t.sold) })}</span>
          <span className="is-kitchen"><b>{t.sentToKitchen}</b>{tr('sent to the kitchen')}</span>
          <span className="is-refunds"><b>{t.refunds}</b>{tr('refunds')}</span>
          <span><b>{t.people}</b>{t.people === 1 ? tr('person') : tr('people')}</span>
        </div>
      )}
      {!data ? <p className="dk-muted">{tr('Loading…')}</p> : !data.rows.length ? (
        <div className="dk-empty"><Icon name="info" /><p>{tr('Nothing happened on the till or the kitchen screen for these filters.')}</p></div>
      ) : (
        <div className="ts-act-list">
          {groups.map(([d, rows]) => (
            <div key={d} className="ts-act-day-group">
              <h4>{d}</h4>
              <ol>
                {rows.map((r) => {
                  const k = r.action.split('.')[1] || '';
                  return (
                    <li key={r.id} className={'is-' + r.app + ' is-' + k}>
                      <time>{new Date(r.at).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' })}</time>
                      <span className="ts-act-ico" aria-hidden="true"><Icon name={KIND_ICON[k] || 'info'} /></span>
                      <span className="ts-act-text">
                        <strong>{ACTION_LABEL[r.action] ? tr(ACTION_LABEL[r.action]) : r.action}</strong>
                        <span>{r.summary}</span>
                        <small>{[r.who, tr(APP_LABEL[r.app])].filter(Boolean).join(' · ')}{r.details && r.details.dishes && r.details.dishes.length ? ' · ' + r.details.dishes.slice(0, 4).join(', ') + (r.details.dishes.length > 4 ? '…' : '') : ''}</small>
                      </span>
                      {r.amount != null && <span className="ts-act-amt">{money(r.amount)}</span>}
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}
        </div>
      )}
      <div className="ts-act-foot">
        {data && data.more && <button type="button" className="btn btn-secondary" disabled={busy} onClick={more}>{busy ? tr('Loading…') : tr('Show older')}</button>}
        {data && data.rows.length > 0 && <button type="button" className="btn btn-secondary" onClick={download}>{tr('Download (CSV)')}</button>}
      </div>
    </section>
  );
}
