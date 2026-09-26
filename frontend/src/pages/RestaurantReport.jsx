import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { Empty, Glossary, Icon, Insights, RankList, Row, Section, Status, jump } from '../components/DashKit';
import { money } from '../lib/currency';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import Bars from './RestaurantBars';

// The Report view of the Restaurants page: the monthly analysis the
// restaurant used to build by hand from Square exports in a spreadsheet —
// sales and items sold by kitchen group month by month (with the change on
// the month before and each group's share), sales by shift and hour, the
// month's items ranked within each group, and the kitchen bonus on the best
// sellers. The kitchen group of each menu category, the shifts and the
// bonus rule are set in the report settings (restaurant.manage). Figures
// come from restaurantReport.service.js.

const MEASURES = ['sales', 'change', 'share', 'qty'];
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const SHIFT_COLORS = ['var(--dk-warn)', 'var(--dk-info)', 'var(--color-accent)', '#6f63c9', '#c05f8a', '#3d9aa8', '#8a8f98', '#b7791f'];

function monthLabel(key, long) {
  const d = new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1);
  return d.toLocaleDateString(activeIntlLocale(), long ? { month: 'long', year: 'numeric' } : { month: 'short', year: '2-digit' });
}
function prevMonth(key) {
  const d = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 2, 1));
  return d.toISOString().slice(0, 7);
}
function monthsBetween(first, last) {
  const out = [];
  for (let k = last; k >= first && out.length < 120; k = prevMonth(k)) out.push(k);
  return out;
}
function whole(n) { return Math.round(n).toLocaleString(activeIntlLocale()); }
function pct(n) { return (Math.round(n * 10) / 10).toLocaleString(activeIntlLocale()) + '%'; }
function hourText(h) { return new Date(2000, 0, 1, h).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' }); }
function signed(n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + whole(Math.abs(n)); }
function csvCell(v) { const s = String(v === null || v === undefined ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

export default function RestaurantReport({ companyId, companyName, canManage, onToast }) {
  const [month, setMonth] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [measure, setMeasure] = useState('sales');
  const [itemGroup, setItemGroup] = useState('');
  const [allItems, setAllItems] = useState(false);
  const [trendGroup, setTrendGroup] = useState('');
  const [shiftSel, setShiftSel] = useState('');
  const [settings, setSettings] = useState(null); // the settings dialog's form
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true); setError(null);
    try {
      setData(await api.get('/restaurant/report?' + new URLSearchParams({ companyId, ...(month ? { month } : {}) }).toString()));
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }, [companyId, month]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setMonth(''); setItemGroup(''); setTrendGroup(''); setShiftSel(''); }, [companyId]);
  // month tables open on their right end, where the chosen month is
  useEffect(() => {
    if (data) document.querySelectorAll('.rr-scroll.is-months').forEach((el) => { el.scrollLeft = el.scrollWidth; });
  }, [data, measure]);

  if (error) return <div className="error-banner" role="alert">{error}</div>;
  if (!data) return <Empty icon="clock">{tr('Loading the report…')}</Empty>;

  const sel = data.month;
  const prev = prevMonth(sel);
  const hasPrev = data.months.includes(prev);
  const tot = data.totals[sel] || { net: 0, qty: 0, orders: 0, lines: 0 };
  const totPrev = hasPrev ? data.totals[prev] : null;
  const change = totPrev && totPrev.net > 0 ? Math.round(((tot.net - totPrev.net) / totPrev.net) * 100) : null;
  const groupName = (g) => (g === data.notOnMenu ? tr('Not on the menu') : g);
  const cell = (g, k) => g.byMonth[k] || { net: 0, qty: 0 };
  const share = (g, k) => (data.totals[k] && data.totals[k].lines > 0 ? (cell(g, k).net / data.totals[k].lines) * 100 : 0);
  const choices = data.first ? monthsBetween(data.first < data.months[0] ? data.first : data.months[0], data.last || sel) : data.months.slice().reverse();
  if (!choices.includes(sel)) choices.unshift(sel);
  const older = choices[choices.indexOf(sel) + 1];
  const newer = choices[choices.indexOf(sel) - 1];
  const empty = tot.orders === 0 && tot.qty === 0;
  const selLong = monthLabel(sel, true);
  const prevShort = monthLabel(prev, true);

  // ── the key numbers ──
  const topItem = data.items[0];
  const paid = data.bonus.rows.filter((r) => r.bonus > 0);
  const stats = [
    { icon: 'cash', value: money(tot.net), label: tr('sales in {month}', { month: selLong }), tone: change !== null && change < -10 ? 'alert' : '',
      note: change === null ? tr('nothing to compare with the month before') : change >= 0 ? tr('{n}% up on {month}', { n: change, month: prevShort }) : tr('{n}% down on {month}', { n: -change, month: prevShort }), onClick: () => jump('rr-groups') },
    { icon: 'receipt', value: whole(tot.orders), label: tr('orders'), note: tot.orders ? tr('{amount} an order on average', { amount: money(tot.net / tot.orders) }) : '', onClick: () => jump('rr-shifts') },
    { icon: 'bag', value: whole(tot.qty), label: tr('items sold'), note: topItem ? tr('most sold: {name} ({n})', { name: topItem.name, n: whole(topItem.qty) }) : '', onClick: () => jump('rr-items') },
    { icon: 'spark', value: money(data.bonus.total), label: tr('kitchen bonus'), note: paid.length ? (paid.length === 1 ? tr('1 dish') : tr('{n} dishes', { n: paid.length })) + ' · ' + (data.bonus.kitchens.length === 1 ? tr('1 kitchen') : tr('{n} kitchens', { n: data.bonus.kitchens.length })) : tr('no dish earns a bonus'), onClick: () => jump('rr-bonus') }
  ];

  // ── what stands out ──
  const insights = [];
  if (!empty) {
    const byNet = data.groups.filter((g) => cell(g, sel).net > 0);
    if (byNet[0]) insights.push({ tone: 'info', icon: 'spark', text: tr('{group} brought in {share} of sales in {month} ({amount}).', { group: groupName(byNet[0].group), share: pct(share(byNet[0], sel)), month: selLong, amount: money(cell(byNet[0], sel).net) }), action: { label: tr('See its items'), run: () => { setItemGroup(byNet[0].group); jump('rr-items'); } } });
    if (hasPrev) {
      const moves = data.groups.map((g) => ({ g, d: cell(g, sel).net - cell(g, prev).net })).filter((m) => Math.abs(m.d) >= 1).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
      const up = moves.find((m) => m.d > 0);
      const down = moves.find((m) => m.d < 0);
      if (down) insights.push({ tone: 'warn', icon: 'down', text: tr('{group} took {amount} less than in {month}.', { group: groupName(down.g.group), amount: money(-down.d), month: prevShort }), action: { label: tr('See its items'), run: () => { setItemGroup(down.g.group); jump('rr-items'); } } });
      if (up) insights.push({ tone: 'good', icon: 'up', text: tr('{group} took {amount} more than in {month}.', { group: groupName(up.g.group), amount: money(up.d), month: prevShort }), action: { label: tr('See its items'), run: () => { setItemGroup(up.g.group); jump('rr-items'); } } });
    }
    const busiest = data.shifts.slice().sort((a, b) => (cell(b, sel).net || 0) - (cell(a, sel).net || 0))[0];
    if (busiest && tot.net > 0 && cell(busiest, sel).net > 0) insights.push({ tone: 'info', icon: 'clock', text: tr('The {shift} shift made {share} of the month\'s sales.', { shift: busiest.name, share: pct((cell(busiest, sel).net / tot.net) * 100) }), action: { label: tr('Show the hours'), run: () => { setShiftSel(busiest.name); jump('rr-shifts'); } } });
    const unsure = data.categories.filter((c) => !c.set && c.guess === 'Other' && c.active > 0);
    if (canManage && unsure.length) insights.push({ tone: 'warn', icon: 'info', text: unsure.length === 1 ? tr('The menu category {name} matched no kitchen, so it counts as Other. Set its group.', { name: unsure[0].category }) : tr('{n} menu categories matched no kitchen, so they count as Other. Set their groups.', { n: unsure.length }), action: { label: tr('Set groups'), run: () => openSettings() } });
  }

  // ── by kitchen group ──
  const groupRows = data.groups.filter((g) => data.months.some((k) => cell(g, k).net || cell(g, k).qty));
  const rankRows = groupRows.filter((g) => cell(g, sel).net > 0).map((g) => {
    const now = cell(g, sel).net;
    const before = hasPrev ? cell(g, prev).net : 0;
    const d = before > 0 ? Math.round(((now - before) / before) * 100) : null;
    return {
      key: g.group, name: groupName(g.group), value: now, amount: money(now),
      meta: (
        <>
          {tr('{share} of sales · {n} items sold', { share: pct(share(g, sel)), n: whole(cell(g, sel).qty) })}
          {d !== null && d !== 0 && <> · <span className={'dk-change ' + (d > 0 ? 'is-good' : 'is-bad')}><Icon name={d > 0 ? 'up' : 'down'} />{(d > 0 ? '+' : '−') + Math.abs(d) + '%'}</span></>}
        </>
      )
    };
  });
  const trendOf = trendGroup ? groupRows.find((g) => g.group === trendGroup) : null;
  const trendRows = data.months.map((k) => {
    const v = trendOf ? cell(trendOf, k).net : data.totals[k].lines;
    return { key: k, value: v, current: k === sel, label: monthLabel(k).split(' ')[0], tip: monthLabel(k, true) + ': ' + money(v) };
  });
  function show(g, k) {
    const c = cell(g, k);
    if (measure === 'sales') return c.net ? whole(c.net) : '';
    if (measure === 'qty') return c.qty ? whole(c.qty) : '';
    if (measure === 'share') return c.net ? pct(share(g, k)) : '';
    const i = data.months.indexOf(k);
    return i === 0 ? '' : signed(c.net - cell(g, data.months[i - 1]).net);
  }
  function tone(g, k) {
    const i = data.months.indexOf(k);
    if (measure !== 'change' || i === 0) return '';
    const d = cell(g, k).net - cell(g, data.months[i - 1]).net;
    return d > 0 ? ' is-up' : d < 0 ? ' is-down' : '';
  }
  const totalRow = { byMonth: Object.fromEntries(data.months.map((k) => [k, { net: data.totals[k].lines, qty: data.totals[k].qty }])) };

  // ── shifts ──
  const shiftOn = data.shifts.find((s) => s.name === shiftSel) || null;
  const hourList = shiftOn ? shiftOn.hours : data.shifts.flatMap((s) => s.hours);
  const hourRows = hourList.map((h) => ({ key: String(h.hour), value: h.net, label: hourText(h.hour).slice(0, 2), tip: hourText(h.hour) + ': ' + money(h.net) + ' · ' + (h.orders === 1 ? tr('1 order') : tr('{n} orders', { n: h.orders })) }));
  const busiestHour = hourList.slice().sort((a, b) => b.net - a.net)[0];

  // ── the month's items ──
  const itemGroups = Array.from(new Set(data.items.map((i) => i.group)));
  const items = data.items.filter((i) => !itemGroup || i.group === itemGroup);
  const itemRows = (allItems ? items : items.slice(0, 10)).map((it) => ({
    key: it.key, name: it.name, value: it.qty, amount: tr('{n} sold', { n: whole(it.qty) }),
    meta: [it.category, !itemGroup ? groupName(it.group) : null, tr('gross {amount}', { amount: money(it.gross) })].filter(Boolean).join(' · ')
  }));

  // ── the bonus ──
  const rule = data.bonus.rule;
  function downloadBonus() {
    const lines = [[tr('Rank'), tr('Item'), tr('Kitchen'), tr('Sold'), tr('Gross sales'), tr('Rate'), tr('Bonus')].map(csvCell).join(',')];
    data.bonus.rows.forEach((r) => lines.push([r.rank, r.name, r.kitchen, r.qty, r.gross.toFixed(2), r.rate + '%', r.bonus.toFixed(2)].map(csvCell).join(',')));
    lines.push('');
    data.bonus.kitchens.forEach((k) => lines.push([tr('{kitchen} total', { kitchen: k.kitchen }), '', '', '', k.gross.toFixed(2), '', k.bonus.toFixed(2)].map(csvCell).join(',')));
    lines.push([tr('Total'), '', '', '', '', '', data.bonus.total.toFixed(2)].map(csvCell).join(','));
    const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'kitchen-bonus-' + String(companyName || '').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase() + '-' + sel + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ── settings ──
  const allGroups = Array.from(new Set([...data.knownGroups, ...data.groups.map((g) => g.group).filter((g) => g !== data.notOnMenu), ...Object.values(data.settings.groups)]));
  function openSettings(part) {
    setFormError(null);
    setSettings({
      part: part || 'groups',
      groups: Object.fromEntries(data.categories.map((c) => [c.category, data.settings.groups[c.category] || ''])),
      shifts: data.settings.shifts.map((s) => ({ name: s.name, start: s.start })),
      bonus: { groups: rule.groups.slice(), top: String(rule.top), rate: String(rule.rate) }
    });
  }
  async function saveSettings(e) {
    e.preventDefault();
    setSaving(true); setFormError(null);
    try {
      await api.put('/restaurant/report/settings', {
        companyId,
        groups: Object.fromEntries(Object.entries(settings.groups).filter(([, g]) => g.trim())),
        shifts: settings.shifts.map((s) => ({ name: s.name.trim(), start: Number(s.start) })),
        bonus: { groups: settings.bonus.groups, top: Number(settings.bonus.top), rate: Number(settings.bonus.rate) }
      });
      setSettings(null);
      if (onToast) onToast(tr('Report settings saved.'));
      await load();
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  }
  const setShift = (i, patch) => setSettings({ ...settings, shifts: settings.shifts.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  return (
    <div className="rr" style={{ opacity: loading ? 0.6 : 1 }}>
      <Section id="rr-top" title={tr('Report for {month}', { month: selLong })}
        sub={tr('Sales by kitchen group, shifts and hours, the best-selling items and the kitchen bonus. Worked out from the till\'s own sales, the way the Square spreadsheet did. Press a number to go to it.')}
        action={(
          <span className="rr-head-tools">
            <span className="rr-month">
              <button type="button" className="btn btn-secondary tl-btn rr-step" disabled={!older} onClick={() => { setMonth(older); setAllItems(false); }} aria-label={tr('Month before')}>‹</button>
              <select id="rr-month" className="input" value={sel} aria-label={tr('Month')} onChange={(e) => { setMonth(e.target.value); setAllItems(false); }}>
                {choices.map((k) => <option key={k} value={k}>{monthLabel(k, true)}</option>)}
              </select>
              <button type="button" className="btn btn-secondary tl-btn rr-step" disabled={!newer} onClick={() => { setMonth(newer); setAllItems(false); }} aria-label={tr('Month after')}>›</button>
            </span>
            {canManage && <button type="button" className="btn btn-secondary tl-btn" onClick={() => openSettings()}>{tr('Report settings')}</button>}
          </span>
        )}>
        <div className="rr-stats">
          {stats.map((s) => (
            <button key={s.label} type="button" onClick={s.onClick} className={'dk-hero-stat is-link' + (s.tone ? ' is-' + s.tone : '')}>
              <span className="dk-hero-stat-icon"><Icon name={s.icon} /></span>
              <strong>{s.value}</strong>
              <span className="dk-hero-stat-label">{s.label}</span>
              {s.note && <small>{s.note}</small>}
            </button>
          ))}
        </div>
      </Section>

      {empty ? (
        <Empty icon="info">{tr('No sales in {month}. Pick another month, or import the sales from Square.', { month: selLong })}</Empty>
      ) : (
        <>
          <Insights items={insights.slice(0, 5)} />

          <Section id="rr-groups" card title={tr('Sales by kitchen group')} sub={tr('What each kitchen took in {month}, and each month over the last year.', { month: selLong })}>
            <div className="dk-two">
              <div>
                <h4 className="rr-sub">{selLong}</h4>
                <RankList rows={rankRows} />
              </div>
              <div>
                <div className="rr-sub-row">
                  <h4 className="rr-sub">{trendOf ? tr('{group}, month by month', { group: groupName(trendOf.group) }) : tr('All groups, month by month')}</h4>
                  <select className="input rr-mini" value={trendGroup} onChange={(e) => setTrendGroup(e.target.value)} aria-label={tr('Kitchen group')}>
                    <option value="">{tr('All groups')}</option>
                    {groupRows.map((g) => <option key={g.group} value={g.group}>{groupName(g.group)}</option>)}
                  </select>
                </div>
                <Bars rows={trendRows} format={money} label={tr('Sales by month')} className="is-months" />
                <p className="dk-muted tl-small">{tr('Point at a month for its figures; {month} is highlighted.', { month: monthLabel(sel) })}</p>
              </div>
            </div>
            <details className="rr-more-table">
              <summary><Icon name="doc" /> {tr('Month-by-month table')}</summary>
              <div className="dk-segment" role="radiogroup" aria-label={tr('Show')}>
                {MEASURES.map((k) => (
                  <button key={k} type="button" role="radio" aria-checked={measure === k} className={measure === k ? 'is-on' : ''} onClick={() => setMeasure(k)}>
                    {{ sales: tr('Sales'), change: tr('Change on the month before'), share: tr('Share of sales'), qty: tr('Items sold') }[k]}
                  </button>
                ))}
              </div>
              <div className="rr-scroll is-months">
                <table className="rr-table">
                  <thead>
                    <tr>
                      <th scope="col">{tr('Group')}</th>
                      {data.months.map((k) => <th key={k} scope="col" className={k === sel ? 'is-sel' : ''}>{monthLabel(k)}</th>)}
                      {(measure === 'sales' || measure === 'qty') && <th scope="col">{tr('12 months')}</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {groupRows.map((g) => (
                      <tr key={g.group}>
                        <th scope="row">{groupName(g.group)}</th>
                        {data.months.map((k) => <td key={k} className={(k === sel ? 'is-sel' : '') + tone(g, k)}>{show(g, k)}</td>)}
                        {measure === 'sales' && <td className="rr-total">{whole(g.net)}</td>}
                        {measure === 'qty' && <td className="rr-total">{whole(g.qty)}</td>}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">{tr('Total')}</th>
                      {data.months.map((k) => <td key={k} className={(k === sel ? 'is-sel' : '') + tone(totalRow, k)}>{measure === 'share' ? (data.totals[k].lines ? '100%' : '') : show(totalRow, k)}</td>)}
                      {measure === 'sales' && <td className="rr-total">{whole(data.months.reduce((s, k) => s + data.totals[k].lines, 0))}</td>}
                      {measure === 'qty' && <td className="rr-total">{whole(data.months.reduce((s, k) => s + data.totals[k].qty, 0))}</td>}
                    </tr>
                  </tfoot>
                </table>
              </div>
            </details>
          </Section>

          <Section id="rr-shifts" card title={tr('Shifts and hours')}
            sub={tr('What each part of the day took in {month}. Press a shift for its hours.', { month: selLong })}
            action={canManage && <button type="button" className="btn btn-secondary tl-btn" onClick={() => openSettings('shifts')}>{tr('Change the shifts')}</button>}>
            <ul className="dk-flow rr-flow" role="radiogroup" aria-label={tr('Shift')}>
              {data.shifts.map((s, i) => {
                const c = cell(s, sel);
                const p = hasPrev ? cell(s, prev) : null;
                const d = p && p.net > 0 ? Math.round((((c.net || 0) - p.net) / p.net) * 100) : null;
                const last = s.hours[s.hours.length - 1].hour;
                return (
                  <li key={s.name} className={'rr-shift-card' + (shiftSel === s.name ? ' is-on' : '')} style={{ '--s': SHIFT_COLORS[i % SHIFT_COLORS.length] }}>
                    <button type="button" role="radio" aria-checked={shiftSel === s.name} onClick={() => setShiftSel(shiftSel === s.name ? '' : s.name)}>
                      <span className="dk-flow-name">{s.name}</span>
                      <span className="dk-flow-n">{money(c.net || 0)}</span>
                      <span className="dk-flow-value">{tr('{from} to {to}', { from: hourText(s.start), to: hourText((last + 1) % 24) })} · {tot.net > 0 ? tr('{share} of sales', { share: pct(((c.net || 0) / tot.net) * 100) }) : ''}</span>
                      {d === 0 && <span className="dk-change dk-muted">{tr('the same as {label}', { label: monthLabel(prev) })}</span>}
                      {d !== null && d !== 0 && <span className={'dk-change ' + (d > 0 ? 'is-good' : 'is-bad')}><Icon name={d > 0 ? 'up' : 'down'} />{(d > 0 ? '+' : '−') + Math.abs(d) + '%'} <span className="dk-muted">{tr('vs {label}', { label: monthLabel(prev) })}</span></span>}
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="dk-two rr-gap">
              <div>
                <h4 className="rr-sub">{shiftOn ? tr('{shift}, hour by hour', { shift: shiftOn.name }) : tr('The whole day, hour by hour')}</h4>
                <Bars rows={hourRows} format={money} label={tr('Sales by hour')} />
                {busiestHour && busiestHour.net > 0 && <p className="dk-muted tl-small">{tr('Busiest hour: {hour}, with {amount}.', { hour: hourText(busiestHour.hour), amount: money(busiestHour.net) })}</p>}
              </div>
              <div>
                <h4 className="rr-sub">{tr('Share of sales by shift, month by month')}</h4>
                <ul className="rr-stack-list">
                  {data.months.slice().reverse().filter((k) => data.totals[k].net > 0).map((k) => (
                    <li key={k} className={k === sel ? 'is-sel' : ''}>
                      <span className="rr-stack-month">{monthLabel(k)}</span>
                      <span className="dk-stack-bar" title={data.shifts.map((s) => s.name + ': ' + pct(((cell(s, k).net || 0) / data.totals[k].net) * 100)).join('\n')}>
                        {data.shifts.map((s, i) => <span key={s.name} style={{ width: (((cell(s, k).net || 0) / data.totals[k].net) * 100) + '%', background: SHIFT_COLORS[i % SHIFT_COLORS.length] }} />)}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="dk-legend">
                  {data.shifts.map((s, i) => <span key={s.name}><i className="dk-swatch" style={{ background: SHIFT_COLORS[i % SHIFT_COLORS.length] }} />{s.name}</span>)}
                </div>
              </div>
            </div>
          </Section>

          <Section id="rr-items" card title={tr('Best-selling items')} sub={tr('{month}, by how many sold.', { month: selLong })}>
            <div className="ppl-chips" role="radiogroup" aria-label={tr('Kitchen group')}>
              <button type="button" role="radio" aria-checked={!itemGroup} className={'ppl-chip' + (!itemGroup ? ' is-on' : '')} onClick={() => { setItemGroup(''); setAllItems(false); }}>
                {tr('All')} <span className="ppl-chip-n">{data.items.length}</span>
              </button>
              {itemGroups.map((g) => (
                <button key={g} type="button" role="radio" aria-checked={itemGroup === g} className={'ppl-chip' + (itemGroup === g ? ' is-on' : '')} onClick={() => { setItemGroup(g); setAllItems(false); }}>
                  {groupName(g)} <span className="ppl-chip-n">{data.items.filter((i) => i.group === g).length}</span>
                </button>
              ))}
            </div>
            {itemRows.length ? <RankList rows={itemRows} /> : <Empty icon="bag">{tr('Nothing sold from this group in {month}.', { month: selLong })}</Empty>}
            {items.length > 10 && (
              <button type="button" className="btn btn-secondary tl-btn rr-more" onClick={() => setAllItems(!allItems)}>
                {allItems ? tr('Show the top 10') : tr('Show all {n}', { n: items.length })}
              </button>
            )}
          </Section>

          <Section id="rr-bonus" card title={tr('Kitchen bonus')}
            sub={rule.groups.length
              ? tr('The top {n} dishes of {month} by gross sales from {groups} earn {rate}% of their gross sales for the kitchen that makes them.', { n: rule.top, month: selLong, groups: rule.groups.join(', '), rate: rule.rate })
              : tr('No kitchen is chosen for the bonus yet.')}
            action={(
              <span className="rr-head-tools">
                {data.bonus.rows.length > 0 && <button type="button" className="btn btn-secondary tl-btn" onClick={downloadBonus}>{tr('Download CSV')}</button>}
                {canManage && <button type="button" className="btn btn-secondary tl-btn" onClick={() => openSettings('bonus')}>{tr('Change the rule')}</button>}
              </span>
            )}>
            {data.bonus.kitchens.length > 0 && (
              <ul className="dk-flow rr-flow">
                {data.bonus.kitchens.map((k) => (
                  <li key={k.kitchen} className="is-good">
                    <span className="dk-flow-name">{k.kitchen}</span>
                    <span className="dk-flow-n">{money(k.bonus)}</span>
                    <span className="dk-flow-value">{(k.items === 1 ? tr('1 dish') : tr('{n} dishes', { n: k.items })) + ' · ' + tr('gross {amount}', { amount: money(k.gross) })}</span>
                  </li>
                ))}
                <li className="is-info">
                  <span className="dk-flow-name">{tr('Total to pay')}</span>
                  <span className="dk-flow-n">{money(data.bonus.total)}</span>
                  <span className="dk-flow-value">{selLong}</span>
                </li>
              </ul>
            )}
            {data.bonus.rows.length ? (
              <ul className="dk-rows rr-gap">
                {data.bonus.rows.map((r) => (
                  <Row key={r.key}
                    lead={<span className={'dk-rank-n' + (r.rank === 1 ? ' is-first' : '')}>{r.rank}</span>}
                    title={r.name}
                    meta={[r.kitchen, tr('{n} sold', { n: whole(r.qty) }), tr('gross {amount}', { amount: money(r.gross) })].join(' · ')}
                    amount={r.bonus > 0 ? money(r.bonus) : '—'}
                    side={r.bonus > 0 ? <Status tone="good">{tr('{rate}% bonus', { rate: r.rate })}</Status> : <Status>{tr('just outside the top {n}', { n: rule.top })}</Status>} />
                ))}
              </ul>
            ) : <Empty icon="info">{tr('No dishes from the bonus kitchens sold in {month}.', { month: selLong })}</Empty>}
          </Section>
        </>
      )}

      <Glossary items={[
        [tr('Kitchen group'), tr('Where a menu category belongs: Bar, BBQ, Chinese, Thai and so on. Set in the report settings; a category not set yet is guessed from its name.')],
        [tr('Sales'), tr('What was actually taken, after discounts. Voided orders are left out.')],
        [tr('Gross'), tr('What the items sold for before discounts. The ranking of dishes and the kitchen bonus use it.')],
        [tr('Change on the month before'), tr('How much more (+) or less (−) a group took than in the month before, in cedis.')],
        [tr('Share of sales'), tr('A group\'s or shift\'s part of the month\'s sales.')],
        [tr('Shift'), tr('A part of the day, from its start hour to the next shift\'s start. The last shift runs past midnight.')],
        [tr('Kitchen bonus'), tr('A percentage of the gross sales of the month\'s best-selling dishes, paid to the kitchen that makes each one.')],
        [tr('Not on the menu'), tr('Sales of items the till no longer has on its menu, so they have no category.')]
      ]} />

      {settings && (
        <div className="dialog-backdrop" onClick={() => !saving && setSettings(null)}>
          <form className="dialog rr-dialog" onClick={(e) => e.stopPropagation()} onSubmit={saveSettings}>
            <h2>{tr('Report settings')}</h2>
            <div className="ppl-chips" role="tablist" aria-label={tr('Settings')}>
              {[['groups', tr('Kitchen groups')], ['shifts', tr('Shifts')], ['bonus', tr('Kitchen bonus')]].map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={settings.part === k} className={'ppl-chip' + (settings.part === k ? ' is-on' : '')} onClick={() => setSettings({ ...settings, part: k })}>{label}</button>
              ))}
            </div>

            {settings.part === 'groups' && (
              <>
                <p className="dk-muted tl-small">{tr('The kitchen group of each menu category. Leave one empty to use the guess shown. Type a new name to make a new group.')}</p>
                <datalist id="rr-group-list">{allGroups.map((g) => <option key={g} value={g} />)}</datalist>
                <div className="rr-cat-list">
                  {data.categories.map((c) => (
                    <div key={c.category} className="rr-cat">
                      <label htmlFor={'rr-cat-' + c.category}>
                        <span className="rr-item-name">{c.category}</span>
                        <span className="dk-muted tl-small">{c.items === 1 ? tr('1 menu item') : tr('{n} menu items', { n: c.items })}</span>
                      </label>
                      <input id={'rr-cat-' + c.category} className="input" list="rr-group-list" maxLength={40} value={settings.groups[c.category] || ''}
                        placeholder={tr('Guess: {group}', { group: c.guess })} onChange={(e) => setSettings({ ...settings, groups: { ...settings.groups, [c.category]: e.target.value } })} />
                    </div>
                  ))}
                  {!data.categories.length && <p className="dk-muted tl-small">{tr('The menu has no categories yet.')}</p>}
                </div>
              </>
            )}

            {settings.part === 'shifts' && (
              <>
                <p className="dk-muted tl-small">{tr('Each shift runs from its start hour to the next shift\'s start; the last one runs past midnight.')}</p>
                {settings.shifts.map((s, i) => (
                  <div key={i} className="rr-shift-row">
                    <input className="input" maxLength={40} value={s.name} aria-label={tr('Shift name')} onChange={(e) => setShift(i, { name: e.target.value })} required />
                    <select className="input" value={s.start} aria-label={tr('Starts at')} onChange={(e) => setShift(i, { start: Number(e.target.value) })}>
                      {HOURS.map((h) => <option key={h} value={h}>{tr('from {hour}', { hour: hourText(h) })}</option>)}
                    </select>
                    <button type="button" className="btn btn-secondary tl-btn" disabled={settings.shifts.length < 2} onClick={() => setSettings({ ...settings, shifts: settings.shifts.filter((_, j) => j !== i) })}>{tr('Remove')}</button>
                  </div>
                ))}
                {settings.shifts.length < 8 && (
                  <button type="button" className="btn btn-secondary tl-btn" onClick={() => setSettings({ ...settings, shifts: [...settings.shifts, { name: '', start: HOURS.find((h) => !settings.shifts.some((s) => s.start === h)) }] })}>{tr('Add shift')}</button>
                )}
              </>
            )}

            {settings.part === 'bonus' && (
              <>
                <p className="dk-muted tl-small">{tr('The month\'s dishes from the chosen kitchen groups are ranked by gross sales; the top ones earn the rate on what they sold.')}</p>
                <fieldset className="rr-fieldset">
                  <legend className="tl-label">{tr('Kitchen groups that earn a bonus')}</legend>
                  <div className="rr-checks">
                    {allGroups.map((g) => (
                      <label key={g} className="rr-check">
                        <input type="checkbox" checked={settings.bonus.groups.includes(g)}
                          onChange={(e) => setSettings({ ...settings, bonus: { ...settings.bonus, groups: e.target.checked ? [...settings.bonus.groups, g] : settings.bonus.groups.filter((x) => x !== g) } })} />
                        {g}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="rr-two">
                  <div className="field">
                    <label htmlFor="rr-top-n">{tr('Dishes that earn it')}</label>
                    <input id="rr-top-n" className="input" type="number" min="1" max="100" step="1" value={settings.bonus.top} onChange={(e) => setSettings({ ...settings, bonus: { ...settings.bonus, top: e.target.value } })} required />
                  </div>
                  <div className="field">
                    <label htmlFor="rr-rate">{tr('Rate (%)')}</label>
                    <input id="rr-rate" className="input" type="number" min="0" max="100" step="0.5" value={settings.bonus.rate} onChange={(e) => setSettings({ ...settings, bonus: { ...settings.bonus, rate: e.target.value } })} required />
                  </div>
                </div>
              </>
            )}

            {formError && <div className="error-banner">{formError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setSettings(null)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Save settings')}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
