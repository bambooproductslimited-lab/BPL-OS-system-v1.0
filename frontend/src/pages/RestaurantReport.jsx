import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { Glossary, Insights, Section, jump } from '../components/DashKit';
import { money } from '../lib/currency';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';

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
  useEffect(() => { setMonth(''); setItemGroup(''); }, [companyId]);
  // month tables open on their right end, where the chosen month is
  useEffect(() => {
    if (data) document.querySelectorAll('.rr-scroll.is-months').forEach((el) => { el.scrollLeft = el.scrollWidth; });
  }, [data, measure]);

  if (error) return <div className="error-banner" role="alert">{error}</div>;
  if (!data) return <p className="dk-muted tl-small">{tr('Loading the report…')}</p>;

  const sel = data.month;
  const prev = prevMonth(sel);
  const hasPrev = data.months.includes(prev);
  const tot = data.totals[sel] || { net: 0, qty: 0, orders: 0, lines: 0 };
  const totPrev = hasPrev ? data.totals[prev] : null;
  const change = totPrev && totPrev.net > 0 ? ((tot.net - totPrev.net) / totPrev.net) * 100 : null;
  const groupName = (g) => (g === data.notOnMenu ? tr('Not on the menu') : g);
  const cell = (g, k) => g.byMonth[k] || { net: 0, qty: 0 };
  const share = (g, k) => (data.totals[k] && data.totals[k].lines > 0 ? (cell(g, k).net / data.totals[k].lines) * 100 : 0);
  const choices = data.first ? monthsBetween(data.first < data.months[0] ? data.first : data.months[0], data.last || sel) : data.months.slice().reverse();
  if (!choices.includes(sel)) choices.unshift(sel);
  const empty = tot.orders === 0 && tot.qty === 0;

  // what stands out in the chosen month
  const insights = [];
  if (!empty) {
    const byNet = data.groups.filter((g) => cell(g, sel).net > 0);
    if (byNet[0]) insights.push({ tone: 'info', icon: 'spark', text: tr('{group} brought in {share} of sales in {month} ({amount}).', { group: groupName(byNet[0].group), share: pct(share(byNet[0], sel)), month: monthLabel(sel, true), amount: money(cell(byNet[0], sel).net) }) });
    if (hasPrev) {
      const moves = data.groups.map((g) => ({ g, d: cell(g, sel).net - cell(g, prev).net })).filter((m) => Math.abs(m.d) >= 1).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
      const up = moves.find((m) => m.d > 0);
      const down = moves.find((m) => m.d < 0);
      if (down) insights.push({ tone: 'warn', icon: 'down', text: tr('{group} took {amount} less than in {month}.', { group: groupName(down.g.group), amount: money(-down.d), month: monthLabel(prev, true) }), action: { label: tr('See its items'), run: () => { setItemGroup(down.g.group); jump('rr-items'); } } });
      if (up) insights.push({ tone: 'good', icon: 'up', text: tr('{group} took {amount} more than in {month}.', { group: groupName(up.g.group), amount: money(up.d), month: monthLabel(prev, true) }), action: { label: tr('See its items'), run: () => { setItemGroup(up.g.group); jump('rr-items'); } } });
    }
    const busiest = data.shifts.slice().sort((a, b) => (cell(b, sel).net || 0) - (cell(a, sel).net || 0))[0];
    if (busiest && tot.net > 0 && cell(busiest, sel).net > 0) insights.push({ tone: 'info', icon: 'clock', text: tr('The {shift} shift made {share} of the month\'s sales.', { shift: busiest.name, share: pct((cell(busiest, sel).net / tot.net) * 100) }), action: { label: tr('Show the hours'), run: () => jump('rr-shifts') } });
    if (data.bonus.total > 0) insights.push({ tone: 'info', icon: 'cash', text: tr('Kitchen bonus for {month}: {amount} across {n} dishes.', { month: monthLabel(sel, true), amount: money(data.bonus.total), n: data.bonus.rows.filter((r) => r.bonus > 0).length }), action: { label: tr('Show the bonus'), run: () => jump('rr-bonus') } });
    const unsure = data.categories.filter((c) => !c.set && c.guess === 'Other' && c.active > 0);
    if (canManage && unsure.length) insights.push({ tone: 'warn', icon: 'info', text: unsure.length === 1 ? tr('The menu category {name} matched no kitchen, so it counts as Other. Set its group.', { name: unsure[0].category }) : tr('{n} menu categories matched no kitchen, so they count as Other. Set their groups.', { n: unsure.length }), action: { label: tr('Set groups'), run: () => openSettings() } });
  }

  // ── by group ──
  const groupRows = data.groups.filter((g) => data.months.some((k) => cell(g, k).net || cell(g, k).qty));
  function show(g, k) {
    const c = cell(g, k);
    if (measure === 'sales') return c.net ? whole(c.net) : '';
    if (measure === 'qty') return c.qty ? whole(c.qty) : '';
    if (measure === 'share') return c.net ? pct(share(g, k)) : '';
    const i = data.months.indexOf(k);
    if (i === 0) return '';
    return signed(c.net - cell(g, data.months[i - 1]).net);
  }
  function tone(g, k) {
    if (measure !== 'change') return '';
    const i = data.months.indexOf(k);
    if (i === 0) return '';
    const d = cell(g, k).net - cell(g, data.months[i - 1]).net;
    return d > 0 ? ' is-up' : d < 0 ? ' is-down' : '';
  }
  const totalRow = { byMonth: Object.fromEntries(data.months.map((k) => [k, { net: data.totals[k].lines, qty: data.totals[k].qty }])) };

  // ── the month's items ──
  const itemGroups = Array.from(new Set(data.items.map((i) => i.group)));
  const items = data.items.filter((i) => !itemGroup || i.group === itemGroup);
  const itemsShown = allItems ? items : items.slice(0, 15);

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
      <Section id="rr-top" title={tr('Monthly report')}
        sub={tr('Sales by kitchen group, shifts and hours, the best-selling items and the kitchen bonus, month by month. Everything the Square spreadsheet worked out, from the till\'s own sales.')}
        action={(
          <span className="rr-head-tools">
            <label className="tl-label" htmlFor="rr-month">{tr('Month')}</label>
            <select id="rr-month" className="input" value={sel} onChange={(e) => { setMonth(e.target.value); setAllItems(false); }}>
              {choices.map((k) => <option key={k} value={k}>{monthLabel(k, true)}</option>)}
            </select>
            {canManage && <button type="button" className="btn btn-secondary" onClick={() => openSettings()}>{tr('Report settings')}</button>}
          </span>
        )}>
        <dl className="dk-sum rr-sum">
          <div><dt>{tr('Sales')}</dt><dd>{money(tot.net)}</dd></div>
          <div><dt>{tr('On the month before')}</dt><dd className={change === null ? '' : change >= 0 ? 'is-good' : 'is-bad'}>{change === null ? '—' : (change >= 0 ? '+' : '−') + pct(Math.abs(change))}</dd></div>
          <div><dt>{tr('Orders')}</dt><dd>{whole(tot.orders)}</dd></div>
          <div><dt>{tr('Items sold')}</dt><dd>{whole(tot.qty)}</dd></div>
          <div><dt>{tr('Average order')}</dt><dd>{tot.orders ? money(tot.net / tot.orders) : '—'}</dd></div>
          <div><dt>{tr('Kitchen bonus')}</dt><dd>{money(data.bonus.total)}</dd></div>
        </dl>
      </Section>

      {empty ? (
        <p className="dk-muted tl-small">{tr('No sales in {month}. Pick another month, or import the sales from Square.', { month: monthLabel(sel, true) })}</p>
      ) : (
        <>
          <Insights items={insights.slice(0, 5)} />

          <Section id="rr-groups" card title={tr('Sales by kitchen group')}
            sub={tr('The last 12 months up to {month}, in cedis. Press a group for its best-selling items.', { month: monthLabel(sel, true) })}>
            <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
              {MEASURES.map((k) => (
                <button key={k} type="button" role="radio" aria-checked={measure === k} className={'ppl-chip' + (measure === k ? ' is-on' : '')} onClick={() => setMeasure(k)}>
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
                      <th scope="row"><button type="button" className="rr-link" onClick={() => { setItemGroup(g.group); setAllItems(false); jump('rr-items'); }}>{groupName(g.group)}</button></th>
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
          </Section>

          <Section id="rr-shifts" card title={tr('Shifts and hours')}
            sub={tr('What each shift took in {month}, hour by hour, and its share of the day over the last 12 months.', { month: monthLabel(sel, true) })}
            action={canManage && <button type="button" className="btn btn-secondary tl-btn" onClick={() => openSettings('shifts')}>{tr('Change the shifts')}</button>}>
            <div className="rr-shifts">
              {data.shifts.map((s) => {
                const c = cell(s, sel);
                const p = hasPrev ? cell(s, prev) : null;
                const max = Math.max(1, ...s.hours.map((h) => h.net));
                const last = s.hours[s.hours.length - 1].hour;
                return (
                  <div key={s.name} className="rr-shift">
                    <div className="rr-shift-head">
                      <strong>{s.name}</strong>
                      <span className="dk-muted tl-small">{tr('{from} to {to}', { from: hourText(s.start), to: hourText((last + 1) % 24) })}</span>
                    </div>
                    <div className="rr-shift-nums">
                      <strong>{money(c.net || 0)}</strong>
                      <span className="dk-muted tl-small">
                        {tot.net > 0 ? tr('{share} of sales', { share: pct(((c.net || 0) / tot.net) * 100) }) : ''}
                        {p && p.net > 0 ? ' · ' + ((c.net || 0) >= p.net ? tr('{n}% up', { n: Math.round((((c.net || 0) - p.net) / p.net) * 100) }) : tr('{n}% down', { n: Math.round(((p.net - (c.net || 0)) / p.net) * 100) })) : ''}
                      </span>
                    </div>
                    <ul className="rr-hours">
                      {s.hours.map((h) => (
                        <li key={h.hour}>
                          <span className="rr-hour">{hourText(h.hour)}</span>
                          <span className="rr-hour-bar"><span style={{ width: (h.net ? Math.max(2, Math.round((h.net / max) * 100)) : 0) + '%' }} /></span>
                          <span className="rr-hour-amt">{h.net ? whole(h.net) : '—'}</span>
                          <span className="dk-muted rr-hour-n">{h.orders ? (h.orders === 1 ? tr('1 order') : tr('{n} orders', { n: h.orders })) : ''}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
            <h4 className="rr-sub">{tr('Share of sales by shift')}</h4>
            <div className="rr-scroll is-months">
              <table className="rr-table">
                <thead>
                  <tr><th scope="col">{tr('Shift')}</th>{data.months.map((k) => <th key={k} scope="col" className={k === sel ? 'is-sel' : ''}>{monthLabel(k)}</th>)}</tr>
                </thead>
                <tbody>
                  {data.shifts.map((s) => (
                    <tr key={s.name}>
                      <th scope="row">{s.name}</th>
                      {data.months.map((k) => <td key={k} className={k === sel ? 'is-sel' : ''}>{data.totals[k].net > 0 ? pct(((cell(s, k).net || 0) / data.totals[k].net) * 100) : ''}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section id="rr-items" card title={tr('Best-selling items')}
            sub={tr('{month}, by how many sold. Gross is before discounts; sales is what was taken.', { month: monthLabel(sel, true) })}>
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
            {items.length ? (
              <div className="rr-scroll">
                <table className="rr-table rr-items">
                  <thead>
                    <tr><th scope="col">#</th><th scope="col">{tr('Item')}</th><th scope="col">{tr('Sold')}</th><th scope="col">{tr('Gross')}</th><th scope="col">{tr('Sales')}</th></tr>
                  </thead>
                  <tbody>
                    {itemsShown.map((it, i) => (
                      <tr key={it.key}>
                        <td className="rr-rank">{i + 1}</td>
                        <th scope="row"><span className="rr-item-name">{it.name}</span><span className="dk-muted tl-small">{[it.category, !itemGroup ? groupName(it.group) : null].filter(Boolean).join(' · ')}</span></th>
                        <td>{whole(it.qty)}</td>
                        <td>{whole(it.gross)}</td>
                        <td>{whole(it.net)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="dk-muted tl-small">{tr('Nothing sold from this group in {month}.', { month: monthLabel(sel, true) })}</p>}
            {items.length > 15 && (
              <button type="button" className="btn btn-secondary tl-btn rr-more" onClick={() => setAllItems(!allItems)}>
                {allItems ? tr('Show the top 15') : tr('Show all {n}', { n: items.length })}
              </button>
            )}
          </Section>

          <Section id="rr-bonus" card title={tr('Kitchen bonus')}
            sub={rule.groups.length
              ? tr('The top {n} dishes of {month} by gross sales from {groups} earn {rate}% of their gross sales for the kitchen that makes them.', { n: rule.top, month: monthLabel(sel, true), groups: rule.groups.join(', '), rate: rule.rate })
              : tr('No kitchen is chosen for the bonus yet.')}
            action={(
              <span className="rr-head-tools">
                {data.bonus.rows.length > 0 && <button type="button" className="btn btn-secondary tl-btn" onClick={downloadBonus}>{tr('Download CSV')}</button>}
                {canManage && <button type="button" className="btn btn-secondary tl-btn" onClick={() => openSettings('bonus')}>{tr('Change the rule')}</button>}
              </span>
            )}>
            {data.bonus.kitchens.length > 0 && (
              <dl className="dk-sum rr-kitchens">
                {data.bonus.kitchens.map((k) => (
                  <div key={k.kitchen}>
                    <dt>{k.kitchen}</dt>
                    <dd>{money(k.bonus)}</dd>
                    <span className="dk-muted tl-small">{k.items === 1 ? tr('1 dish') : tr('{n} dishes', { n: k.items })}</span>
                  </div>
                ))}
                <div className="is-total"><dt>{tr('Total')}</dt><dd>{money(data.bonus.total)}</dd></div>
              </dl>
            )}
            {data.bonus.rows.length ? (
              <div className="rr-scroll">
                <table className="rr-table rr-items">
                  <thead>
                    <tr><th scope="col">#</th><th scope="col">{tr('Dish')}</th><th scope="col">{tr('Sold')}</th><th scope="col">{tr('Gross')}</th><th scope="col">{tr('Rate')}</th><th scope="col">{tr('Bonus')}</th></tr>
                  </thead>
                  <tbody>
                    {data.bonus.rows.map((r) => (
                      <tr key={r.key} className={r.bonus > 0 ? '' : 'is-missed'}>
                        <td className="rr-rank">{r.rank}</td>
                        <th scope="row"><span className="rr-item-name">{r.name}</span><span className="dk-muted tl-small">{r.kitchen}{r.bonus > 0 ? '' : ' · ' + tr('just outside the top {n}', { n: rule.top })}</span></th>
                        <td>{whole(r.qty)}</td>
                        <td>{whole(r.gross)}</td>
                        <td>{r.rate}%</td>
                        <td className="rr-total">{r.bonus ? money(r.bonus) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="dk-muted tl-small">{tr('No dishes from the bonus kitchens sold in {month}.', { month: monthLabel(sel, true) })}</p>}
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
