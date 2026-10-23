import { useEffect, useMemo, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { activeIntlLocale, msg, tr } from '../../lib/i18n.jsx';
import './growth.css';

// The reports Square has that the sales report did not (back office →
// Reports → Insights; backend restaurantTillInsights): sales by category,
// by area (Square's revenue centers: the floor's areas, the counter,
// takeaway, the website, the kiosk, each delivery app), by time of day and
// by hour of each weekday (a heatmap), what was voided, the staff's hours
// and their cost against the sales — each against the period before or the
// same days a year ago. One blue series ("now") and a grey tick for
// "before"; sales and labour cost share one cedi axis (blue and orange,
// validated for colour-blind readers).

function iso(d) { return d.toISOString().slice(0, 10); }
function addDays(s, n) { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
const RANGES = [['today', msg('Today')], ['yesterday', msg('Yesterday')], ['7', msg('Last 7 days')], ['30', msg('Last 30 days')], ['month', msg('This month')], ['lastMonth', msg('Last month')]];
function rangeOf(k) {
  const t = iso(new Date());
  if (k === 'today') return { from: t, to: t };
  if (k === 'yesterday') return { from: addDays(t, -1), to: addDays(t, -1) };
  if (k === '30') return { from: addDays(t, -29), to: t };
  if (k === 'month') return { from: t.slice(0, 8) + '01', to: t };
  if (k === 'lastMonth') { const end = addDays(t.slice(0, 8) + '01', -1); return { from: end.slice(0, 8) + '01', to: end }; }
  return { from: addDays(t, -6), to: t };
}
const COMPARE = [['previous', msg('The period before')], ['year', msg('A year ago')], ['none', msg('Nothing')]];
const PART = { breakfast: msg('Breakfast'), lunch: msg('Lunch'), afternoon: msg('Afternoon'), dinner: msg('Dinner'), late: msg('Late night') };
// The server's names for the areas that are not the floor's or an app's, in the reader's language.
const AREA_NAME = { takeaway: msg('Takeaway'), counter: msg('Counter'), delivery: msg('Delivery'), kiosk: msg('Kiosk'), website: msg('Website') };
const CATEGORY_NAME = { 'Not on the menu': msg('Not on the menu'), Other: msg('Other') };
const AREA_ICO = { floor: '🪑', counter: '🧾', takeaway: '🥡', delivery: '🛵', website: '🌐', kiosk: '🖥️', app: '📱', square: '◼️' };
function dayName(d) { return new Date(Date.UTC(2024, 0, 7 + d)).toLocaleDateString(activeIntlLocale(), { weekday: 'short', timeZone: 'UTC' }); }
function short(s) { return new Date(s + 'T12:00:00').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' }); }
// A short amount for a label above a bar: whole cedis.
function short$(n) { return 'GHS ' + Math.round(n).toLocaleString(activeIntlLocale()); }
function pct(a, b) { return b > 0 ? Math.round((a - b) / b * 1000) / 10 : null; }

function Delta({ now, before, invert }) {
  const p = pct(now, before);
  if (p === null) return <small className="in-delta is-flat">{before === 0 && now > 0 ? tr('new') : '—'}</small>;
  const up = p > 0;
  const good = invert ? !up : up;
  return <small className={'in-delta ' + (p === 0 ? 'is-flat' : good ? 'is-good' : 'is-bad')}><span aria-hidden="true">{p === 0 ? '→' : up ? '▲' : '▼'}</span> {up ? '+' : ''}{p}%</small>;
}

// A hover card for a mark: what it is, exactly.
function useTip() {
  const [tip, setTip] = useState(null);
  const on = (text) => ({
    onPointerEnter: (e) => setTip({ text, x: e.clientX, y: e.clientY }),
    onPointerMove: (e) => setTip({ text, x: e.clientX, y: e.clientY }),
    onPointerLeave: () => setTip(null),
    onFocus: (e) => { const r = e.currentTarget.getBoundingClientRect(); setTip({ text, x: r.left + r.width / 2, y: r.top }); },
    onBlur: () => setTip(null),
    tabIndex: 0, 'aria-label': text
  });
  const node = tip ? <div className="in-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div> : null;
  return [on, node];
}

// Horizontal bars, now, with a grey tick where it stood before.
function Bars({ rows, before, tipOn, unit }) {
  const max = Math.max(1, ...rows.map((r) => r.amount), ...rows.map((r) => (before && before[r.name] ? before[r.name] : 0)));
  const total = rows.reduce((a, r) => a + r.amount, 0);
  return (
    <ul className="in-bars is-plain">
      {rows.map((r) => {
        const b = before ? before[r.name] || 0 : null;
        const words = (r.label || r.name) + ': ' + money(r.amount) + (unit ? ' · ' + unit(r) : '') + (b !== null ? ' · ' + tr('before {amount}', { amount: money(b) }) : '');
        return (
          <li key={r.name}>
            <span className="in-bar-name">{r.ico ? <span aria-hidden="true">{r.ico} </span> : null}{r.label || r.name}</span>
            <span className="in-bar-track" {...tipOn(words)}>
              <span className="in-bar" style={{ width: Math.max(1.5, r.amount / max * 100) + '%' }} />
              {b !== null && b > 0 && <span className="in-tick" style={{ left: 'calc(' + (b / max * 100) + '% - 1px)' }} />}
            </span>
            <span className="in-bar-val">{money(r.amount)}<small>{total > 0 ? Math.round(r.amount / total * 100) + '%' : ''}{b !== null ? <Delta now={r.amount} before={b} /> : null}</small></span>
          </li>
        );
      })}
    </ul>
  );
}

export default function Insights({ token, pin, onFail }) {
  const [range, setRange] = useState('7');
  const [compare, setCompare] = useState('previous');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [asTable, setAsTable] = useState(false);
  const [tipOn, tipNode] = useTip();
  useEffect(() => {
    let live = true;
    setBusy(true);
    const r = rangeOf(range);
    posFetch('POST', '/pos/settings/insights', token, { managerPin: pin || undefined, from: r.from, to: r.to, compare })
      .then((d) => { if (live) setData(d); }).catch(onFail).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [range, compare, token, pin, onFail]);

  const heat = useMemo(() => {
    if (!data) return null;
    const max = Math.max(0, ...data.time.grid.flat().map((c) => c.amount));
    // Hours anyone sold in, so the grid is not mostly empty night.
    let lo = 23, hi = 0;
    data.time.grid.forEach((row) => row.forEach((c, h) => { if (c.orders) { lo = Math.min(lo, h); hi = Math.max(hi, h); } }));
    if (lo > hi) { lo = 8; hi = 22; }
    let peak = null;
    data.time.grid.forEach((row, d) => row.forEach((c, h) => { if (!peak || c.amount > peak.amount) peak = { d, h, ...c }; }));
    return { max, hours: Array.from({ length: hi - lo + 1 }, (_, i) => lo + i), peak };
  }, [data]);

  if (!data) return <section className="ts-sec"><p className="dk-muted">{busy ? tr('Loading…') : ''}</p></section>;
  const t = data.totals, b = data.before ? data.before.totals : null;
  const beforeOf = (list) => (list ? Object.fromEntries(list.map((x) => [x.name, x.amount])) : null);
  const partsBefore = data.before ? Object.fromEntries(data.before.dayparts.map((p) => [p.key, p.amount])) : null;
  const partMax = Math.max(1, ...data.time.dayparts.map((p) => p.amount), ...(partsBefore ? Object.values(partsBefore) : [0]));
  const L = data.labour;
  const labourMax = Math.max(1, ...L.days.map((d) => Math.max(d.sales, d.cost)));
  const v = data.voids;
  const step = (amount) => (heat.max > 0 && amount > 0 ? Math.min(6, Math.ceil(amount / heat.max * 6)) : 0);
  const KPIS = [
    ['💰', tr('Net sales'), money(t.net), t.net, b && b.net],
    ['🧾', tr('Orders'), t.orders, t.orders, b && b.orders],
    ['🎯', tr('Average order'), money(t.average), t.average, b && b.average],
    ['👥', tr('Guests'), t.guests, t.guests, b && b.guests],
    ['💛', tr('Tips'), money(t.tips), t.tips, b && b.tips],
    ['🏷️', tr('Discounts'), money(t.discounts), t.discounts, b && b.discounts, true]
  ];

  return (
    <section className={'ts-sec in' + (busy ? ' is-busy' : '')}>
      <div className="in-filters">
        <div className="ts-chips" role="radiogroup" aria-label={tr('When')}>
          {RANGES.map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={range === k} className={range === k ? 'is-on' : ''} onClick={() => setRange(k)}>{tr(label)}</button>)}
        </div>
        <label className="in-compare"><span>{tr('Against')}</span>
          <select className="input" value={compare} onChange={(e) => setCompare(e.target.value)}>{COMPARE.map(([k, label]) => <option key={k} value={k}>{tr(label)}</option>)}</select>
        </label>
        <button type="button" className={'ts-chip in-table-btn' + (asTable ? ' is-on' : '')} aria-pressed={asTable} onClick={() => setAsTable(!asTable)}>📋 {tr('As tables')}</button>
      </div>
      <p className="in-period">
        {data.period.from === data.period.to ? short(data.period.from) : tr('{from} to {to}', { from: short(data.period.from), to: short(data.period.to) })}
        {data.compare && <small> · {tr('against {from} to {to}', { from: short(data.compare.from), to: short(data.compare.to) })}</small>}
      </p>

      <div className="in-kpis">
        {KPIS.map(([ico, label, shown, now, before, invert]) => (
          <div key={label} className="in-kpi">
            <span className="in-kpi-ico" aria-hidden="true">{ico}</span>
            <span className="in-kpi-label">{label}</span>
            <strong>{shown}</strong>
            {b && <Delta now={now} before={before} invert={invert} />}
          </div>
        ))}
      </div>

      {data.compare && !asTable && (
        <p className="in-legend"><span><i className="in-key is-now" aria-hidden="true" />{tr('This period')}</span><span><i className="in-key is-before" aria-hidden="true" />{data.compare.kind === 'year' ? tr('A year ago') : tr('The period before')}</span></p>
      )}

      <div className="in-grid">
        <article className="in-card">
          <h3>{tr('By category')}</h3>
          {!data.categories.length ? <p className="dk-muted">{tr('No sales in these days.')}</p> : asTable ? (
            <table className="ga-table"><thead><tr><th>{tr('Category')}</th><th className="is-num">{tr('Sold')}</th><th className="is-num">{tr('Orders')}</th><th className="is-num">{tr('Amount')}</th>{data.before && <th className="is-num">{tr('Before')}</th>}</tr></thead>
              <tbody>{data.categories.map((c) => <tr key={c.name}><td>{CATEGORY_NAME[c.name] ? tr(CATEGORY_NAME[c.name]) : c.name}</td><td className="is-num">{c.qty}</td><td className="is-num">{c.orders}</td><td className="is-num">{money(c.amount)}</td>{data.before && <td className="is-num">{money(beforeOf(data.before.categories)[c.name] || 0)}</td>}</tr>)}</tbody></table>
          ) : <Bars rows={data.categories.map((c) => ({ ...c, label: CATEGORY_NAME[c.name] ? tr(CATEGORY_NAME[c.name]) : null }))} before={data.before && beforeOf(data.before.categories)} tipOn={tipOn} unit={(r) => tr('{n} sold', { n: r.qty })} />}
        </article>

        <article className="in-card">
          <h3>{tr('By area')}<small>{tr('Where the money came from')}</small></h3>
          {!data.areas.length ? <p className="dk-muted">{tr('No sales in these days.')}</p> : asTable ? (
            <table className="ga-table"><thead><tr><th>{tr('Area')}</th><th className="is-num">{tr('Orders')}</th><th className="is-num">{tr('Amount')}</th>{data.before && <th className="is-num">{tr('Before')}</th>}</tr></thead>
              <tbody>{data.areas.map((a) => <tr key={a.name}><td>{AREA_ICO[a.kind]} {AREA_NAME[a.kind] ? tr(AREA_NAME[a.kind]) : a.name}</td><td className="is-num">{a.orders}</td><td className="is-num">{money(a.amount)}</td>{data.before && <td className="is-num">{money(beforeOf(data.before.areas)[a.name] || 0)}</td>}</tr>)}</tbody></table>
          ) : <Bars rows={data.areas.map((a) => ({ ...a, ico: AREA_ICO[a.kind], label: AREA_NAME[a.kind] ? tr(AREA_NAME[a.kind]) : null }))} before={data.before && beforeOf(data.before.areas)} tipOn={tipOn} unit={(r) => tr('{n} orders', { n: r.orders })} />}
        </article>

        <article className="in-card">
          <h3>{tr('By time of day')}</h3>
          <div className="in-parts">
            {data.time.dayparts.map((p) => {
              const was = partsBefore ? partsBefore[p.key] || 0 : null;
              const words = tr(PART[p.key]) + ' (' + String(p.from).padStart(2, '0') + ':00–' + String(p.to).padStart(2, '0') + ':00): ' + money(p.amount) + ' · ' + tr('{n} orders', { n: p.orders }) + (was !== null ? ' · ' + tr('before {amount}', { amount: money(was) }) : '');
              return (
                <div key={p.key} className="in-part" {...tipOn(words)}>
                  <span className="in-part-val">{short$(p.amount)}</span>
                  <span className="in-part-col"><span className="in-part-bar" style={{ height: Math.max(2, p.amount / partMax * 100) + '%' }} />{was ? <span className="in-part-tick" style={{ bottom: (was / partMax * 100) + '%' }} /> : null}</span>
                  <span className="in-part-name">{tr(PART[p.key])}<small>{String(p.from).padStart(2, '0')}–{String(p.to).padStart(2, '0')}h</small></span>
                </div>
              );
            })}
          </div>
        </article>

        <article className="in-card in-heat-card">
          <h3>{tr('Busiest hours')}<small>{heat.peak && heat.peak.amount > 0 ? tr('Busiest: {day} at {hour}:00, {amount}', { day: dayName(heat.peak.d), hour: heat.peak.h, amount: money(heat.peak.amount) }) : tr('No sales in these days.')}</small></h3>
          <div className="in-heat" style={{ gridTemplateColumns: 'auto repeat(' + heat.hours.length + ', minmax(0, 1fr))' }}>
            <span />
            {heat.hours.map((h) => <span key={h} className="in-heat-h">{h % 2 === 0 ? h : ''}</span>)}
            {[1, 2, 3, 4, 5, 6, 0].map((d) => (
              <div key={d} className="in-heat-row" style={{ display: 'contents' }}>
                <span className="in-heat-d">{dayName(d)}</span>
                {heat.hours.map((h) => {
                  const c = data.time.grid[d][h];
                  return <span key={h} className={'in-cell is-' + step(c.amount)} {...tipOn(dayName(d) + ' ' + h + ':00–' + (h + 1) + ':00 · ' + money(c.amount) + ' · ' + tr('{n} orders', { n: c.orders }))} />;
                })}
              </div>
            ))}
          </div>
          <p className="in-scale"><span>{tr('Less')}</span>{[1, 2, 3, 4, 5, 6].map((s) => <i key={s} className={'in-cell is-' + s} aria-hidden="true" />)}<span>{tr('More')}</span></p>
        </article>

        <article className="in-card">
          <h3>{tr('Voids and removals')}</h3>
          <div className="in-mini">
            <div><b>{v.sales.count}</b><span>{tr('sales voided')}</span><small>{money(v.sales.amount)}</small></div>
            <div><b>{v.removed.count}</b><span>{tr('open orders removed unpaid')}</span></div>
            <div><b>{v.dishes.qty}</b><span>{tr('dishes taken off after the kitchen had them')}</span><small>{money(v.dishes.value)}</small></div>
          </div>
          {(v.sales.list.length > 0 || v.dishes.list.length > 0 || v.removed.list.length > 0) && (
            <ul className="in-voids is-plain">
              {v.sales.list.slice(0, 5).map((s) => <li key={s.orderNo}><span>🚫 {s.orderNo}{s.cashier ? ' · ' + s.cashier : ''}</span><b>{money(s.amount)}</b></li>)}
              {v.dishes.list.slice(0, 5).map((s) => <li key={s.name}><span>🍽️ {s.qty}× {s.name}</span><b>{money(s.value)}</b></li>)}
              {v.removed.list.slice(0, 5).map((s, i) => <li key={i}><span>🗑️ {s.summary}</span><small>{s.by || ''}</small></li>)}
            </ul>
          )}
        </article>

        <article className="in-card in-labour">
          <h3>{tr('Staff hours against sales')}<small>{tr('From the clock-ins, and each person\'s pay rate')}</small></h3>
          <div className="in-mini">
            <div><b>{L.hours}</b><span>{tr('hours worked')}</span><small>{tr('{n} people', { n: L.people })}</small></div>
            <div><b>{money(L.cost)}</b><span>{tr('labour cost')}</span></div>
            <div className={L.share != null && L.share > 35 ? 'is-warn' : ''}><b>{L.share != null ? L.share + '%' : '—'}</b><span>{tr('of sales')}</span>{L.share != null && L.share > 35 && <small>⚠️ {tr('high')}</small>}</div>
            <div><b>{L.salesPerHour != null ? money(L.salesPerHour) : '—'}</b><span>{tr('sales per hour worked')}</span></div>
          </div>
          {L.noRate > 0 && <p className="cm-warn">{tr('{n} shifts have no pay rate in the OS: their cost is not counted.', { n: L.noRate })}</p>}
          {L.days.length > 1 && L.days.length <= 62 && !asTable && (
            <>
              <p className="in-legend"><span><i className="in-key is-now" aria-hidden="true" />{tr('Sales')}</span><span><i className="in-key is-cost" aria-hidden="true" />{tr('Labour cost')}</span></p>
              <div className="in-days">
                {L.days.map((d) => (
                  <div key={d.day} className="in-day" {...tipOn(short(d.day) + ' · ' + tr('Sales') + ' ' + money(d.sales) + ' · ' + tr('Labour cost') + ' ' + money(d.cost) + ' · ' + tr('{n} h', { n: d.hours }))}>
                    <span className="in-day-col"><span className="in-day-bar is-sales" style={{ height: (d.sales / labourMax * 100) + '%' }} /><span className="in-day-bar is-cost" style={{ height: (d.cost / labourMax * 100) + '%' }} /></span>
                    <small>{L.days.length <= 14 ? short(d.day) : new Date(d.day + 'T12:00:00').getDate()}</small>
                  </div>
                ))}
              </div>
            </>
          )}
          {asTable && L.days.length > 0 && (
            <table className="ga-table"><thead><tr><th>{tr('Day')}</th><th className="is-num">{tr('Hours')}</th><th className="is-num">{tr('Labour cost')}</th><th className="is-num">{tr('Sales')}</th></tr></thead>
              <tbody>{L.days.map((d) => <tr key={d.day}><td>{short(d.day)}</td><td className="is-num">{d.hours}</td><td className="is-num">{money(d.cost)}</td><td className="is-num">{money(d.sales)}</td></tr>)}</tbody></table>
          )}
        </article>
      </div>
      {tipNode}
    </section>
  );
}
