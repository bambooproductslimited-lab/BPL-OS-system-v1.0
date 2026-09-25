import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import Photo from '../components/Photo';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { Glossary, Hero, Insights, PairBars, RankList, Section, jump } from '../components/DashKit';
import { money } from '../lib/currency';
import { tr, activeIntlLocale } from '../lib/i18n.jsx';
import { rowsToCsv, downloadCsv } from '../lib/csvExport';
import './EmployeesPage.css';
import './StockSummaryPage.css';

// The monthly summary: the "2026 Sept" tab of the Finish Inventory sheet,
// worked out from the daily stock sheet (backend stockSheet.service.js
// month()). Same "explains itself" layout as the dashboards
// (components/DashKit.jsx): the month's key numbers against last month,
// what stands out (days missing, best sellers, stock that went missing at
// counts, products that didn't move), the months on record, received and
// sold day by day, the best sellers and the biggest losses, then every
// product's closing figure on each day and the month's movements. A marked
// cell is a day where the count differed from the expected figure.

function thisMonth() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function shiftMonth(m, by) {
  const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}
function fmt(n) {
  return n === null || n === undefined ? '' : Number(n).toLocaleString(activeIntlLocale(), { maximumFractionDigits: 2 });
}
function monthLabel(m) {
  return new Date(m + '-01T00:00:00').toLocaleDateString(activeIntlLocale(), { month: 'long', year: 'numeric' });
}
function monthShort(m) {
  return new Date(m + '-01T00:00:00').toLocaleDateString(activeIntlLocale(), { month: 'short' });
}

export default function StockSummaryPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const month = params.get('month') || thisMonth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [chip, setChip] = useState('all');
  const [allDays, setAllDays] = useState(false);
  const [months, setMonths] = useState([]);

  useEffect(() => {
    api.get('/stock-sheet/months').then(setMonths).catch(() => setMonths([]));
  }, []);
  const monthInfo = months.find((x) => x.month === month);
  const missingDays = monthInfo ? Math.max(0, monthInfo.daysSoFar - monthInfo.daysFilled) : 0;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.get('/stock-sheet/month/' + month));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [month]);
  useEffect(() => { load(); }, [load]);

  function goTo(m) { setChip('all'); setParams(m === thisMonth() ? {} : { month: m }); }

  const categories = useMemo(() => Array.from(new Set((data ? data.rows : []).map((r) => r.category).filter(Boolean))).sort(), [data]);
  const allRows = data ? data.rows : [];
  const filled = data ? data.days.filter((d) => d.hasLines) : [];
  const days = data ? data.days.filter((d) => allDays || d.hasLines) : [];

  // ── the month in numbers ──────────────────────────────────────────
  const sum = (f) => allRows.reduce((s, r) => s + f(r), 0);
  const sold = sum((r) => r.totals.sold);
  const soldValue = sum((r) => r.totals.sold * (r.sellingPrice || 0));
  const received = sum((r) => r.totals.received);
  const breakage = sum((r) => r.totals.breakage);
  const missing = sum((r) => r.missing);
  const missingValue = sum((r) => r.missing * (r.costPrice || 0));
  const short = allRows.filter((r) => r.missing > 0).sort((a, b) => b.missing * (b.costPrice || 1) - a.missing * (a.costPrice || 1));
  const withLines = allRows.filter((r) => Object.keys(r.cells).length > 0);
  const still = withLines.filter((r) => !r.totals.sold && !r.totals.received && !r.totals.transferred && !r.totals.breakage);
  const sellers = allRows.filter((r) => r.totals.sold > 0).sort((a, b) => (b.totals.sold * (b.sellingPrice || 0) || b.totals.sold) - (a.totals.sold * (a.sellingPrice || 0) || a.totals.sold));
  const prev = data ? data.previous : null;
  const perDay = filled.length ? sold / filled.length : 0;
  const prevPerDay = prev && prev.days ? prev.sold / prev.days : 0;
  const change = prevPerDay ? Math.round(((perDay - prevPerDay) / prevPerDay) * 100) : null;

  function showOnly(key) { setChip(chip === key ? 'all' : key); jump('sm-table'); }
  const stats = [
    { icon: 'calendar', value: filled.length + ' / ' + (monthInfo ? monthInfo.daysSoFar : data ? data.days.length : 0), label: tr('days on the sheet'), note: missingDays ? tr('{n} days missing', { n: missingDays }) : tr('every day so far is in'), tone: missingDays ? 'alert' : 'good', onClick: () => jump('sm-months') },
    { icon: 'up', value: fmt(sold), label: tr('sold'), note: change !== null ? (change >= 0 ? tr('{pct}% more per day than {month}', { pct: change, month: monthShort(prev.month) }) : tr('{pct}% less per day than {month}', { pct: -change, month: monthShort(prev.month) })) : soldValue ? tr('worth {amount}', { amount: money(soldValue) }) : tr('items, all products'), tone: change !== null && change < -15 ? 'alert' : '', onClick: () => showOnly('sold') },
    { icon: 'down', value: fmt(received), label: tr('received'), note: breakage ? tr('{n} broken', { n: fmt(breakage) }) : tr('nothing broken'), onClick: () => showOnly('moved') },
    { icon: 'scale', value: fmt(missing), label: tr('missing at counts'), note: missing ? (missingValue ? tr('worth {amount} at cost', { amount: money(missingValue) }) : tr('{n} products counted short', { n: short.length })) : tr('every count matched or was over'), tone: missing ? 'bad' : 'good', onClick: () => showOnly('short') }
  ];

  const insights = [];
  if (missingDays && monthInfo) insights.push({ tone: 'warn', icon: 'calendar', text: tr('{n} of {total} days of {month} are in the OS. Import that month\'s Finish Inventory workbook to fill in the rest.', { n: monthInfo.daysFilled, total: monthInfo.daysSoFar, month: monthLabel(month) }), action: { label: tr('Import from Google Drive'), run: () => navigate('/inventory?import=drive') } });
  if (sellers.length) insights.push({ tone: 'good', icon: 'up', text: sellers[0].totals.sold * (sellers[0].sellingPrice || 0) ? tr('Best seller: {name}, {n} sold ({amount}).', { name: sellers[0].name, n: fmt(sellers[0].totals.sold), amount: money(sellers[0].totals.sold * sellers[0].sellingPrice) }) : tr('Best seller: {name}, {n} sold.', { name: sellers[0].name, n: fmt(sellers[0].totals.sold) }) });
  if (short.length) insights.push({ tone: 'bad', icon: 'scale', text: short.length === 1 ? tr('{name} was counted {n} short over the month.', { name: short[0].name, n: fmt(short[0].missing) }) : tr('{n} products were counted short; the most, {name}, by {m}.', { n: short.length, name: short[0].name, m: fmt(short[0].missing) }), action: { label: tr('Show them'), run: () => showOnly('short') } });
  if (change !== null && Math.abs(change) >= 15) insights.push({ tone: change > 0 ? 'good' : 'warn', icon: change > 0 ? 'up' : 'down', text: change > 0 ? tr('Sales are up {pct}% a day on {month}.', { pct: change, month: monthLabel(prev.month) }) : tr('Sales are down {pct}% a day on {month}.', { pct: -change, month: monthLabel(prev.month) }) });
  if (still.length && filled.length >= 5) insights.push({ tone: 'info', icon: 'info', text: still.length === 1 ? tr('{name} did not move all month.', { name: still[0].name }) : tr('{n} products did not move all month: nothing sold, received or broken.', { n: still.length }), action: { label: tr('Show them'), run: () => showOnly('still') } });
  if (breakage && prev && prev.breakage && breakage > prev.breakage * 1.5) insights.push({ tone: 'warn', icon: 'warn', text: tr('{n} items broken this month, against {m} in {month}.', { n: fmt(breakage), m: fmt(prev.breakage), month: monthLabel(prev.month) }), action: { label: tr('Show them'), run: () => showOnly('broken') } });

  const chipTest = {
    all: () => true,
    sold: (r) => r.totals.sold > 0,
    moved: (r) => r.totals.received > 0,
    still: (r) => Object.keys(r.cells).length > 0 && !r.totals.sold && !r.totals.received && !r.totals.transferred && !r.totals.breakage,
    short: (r) => r.daysWithVariance > 0,
    broken: (r) => r.totals.breakage > 0
  };
  const rows = allRows
    .filter(chipTest[chip] || chipTest.all)
    .filter((r) => (!category || r.category === category) && matchesQuery(search, r.name, r.sku, r.category));
  const chips = [
    ['all', tr('All'), allRows.length],
    ['sold', tr('Sold this month'), allRows.filter(chipTest.sold).length],
    ['moved', tr('Received this month'), allRows.filter(chipTest.moved).length],
    ['short', tr('Count differences'), allRows.filter(chipTest.short).length],
    ['broken', tr('Breakage'), allRows.filter(chipTest.broken).length],
    ['still', tr('Didn\'t move'), still.length]
  ].filter(([k, , c]) => c > 0 || k === 'all' || k === chip);

  const dayBars = filled.map((d) => ({ label: String(Number(d.date.slice(8))), a: d.received, b: d.sold }));
  const top = sellers.slice(0, 8).map((r) => ({ key: r.productId, name: r.name, value: r.totals.sold * (r.sellingPrice || 0) || r.totals.sold, amount: fmt(r.totals.sold) + ' ' + r.unit, meta: r.sellingPrice ? money(r.totals.sold * r.sellingPrice) : undefined }));
  const losses = short.slice(0, 6).map((r) => ({ key: r.productId, name: r.name, value: r.missing * (r.costPrice || 1), amount: fmt(r.missing) + ' ' + r.unit, meta: tr('counted short on {n} of {d} counts', { n: Object.values(r.cells).filter((c) => c.variance > 0).length, d: r.daysCounted }) + (r.costPrice ? ' · ' + tr('{amount} at cost', { amount: money(r.missing * r.costPrice) }) : '') }));
  const totals = rows.reduce((t, r) => ({ received: t.received + r.totals.received, transferred: t.transferred + r.totals.transferred, breakage: t.breakage + r.totals.breakage, sold: t.sold + r.totals.sold, missing: t.missing + r.missing }), { received: 0, transferred: 0, breakage: 0, sold: 0, missing: 0 });

  function exportCsv() {
    const head = [tr('SKU'), tr('Item'), tr('Category'), tr('Unit'), tr('Opening stock')]
      .concat(days.map((d) => d.date))
      .concat([tr('Received'), tr('Transferred'), tr('Breakage'), tr('Sold'), tr('Missing'), tr('Closing')]);
    const body = rows.map((r) => [r.sku, r.name, r.category, r.unit, r.opening === null ? '' : r.opening]
      .concat(days.map((d) => (r.cells[d.date] ? r.cells[d.date].closing : '')))
      .concat([r.totals.received, r.totals.transferred, r.totals.breakage, r.totals.sold, r.missing, r.closing === null ? '' : r.closing]));
    downloadCsv('stock-summary-' + month + '.csv', rowsToCsv([head].concat(body)));
  }

  return (
    <div className="dk sm">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('Finish Inventory · monthly summary')}
        title={monthLabel(month)}
        sub={tr('Every product\'s closing stock on each day of the month that was filled in on the daily stock sheet, then the month\'s movements. Press a number to show only those; press a day to open that day\'s sheet.')}
        actions={(
          <div className="sm-monthpicker">
            <button type="button" className="btn btn-secondary" onClick={() => goTo(shiftMonth(month, -1))} aria-label={tr('Previous month')}>‹</button>
            <input className="input" type="month" value={month} max={thisMonth()} onChange={(e) => e.target.value && goTo(e.target.value)} aria-label={tr('Month')} />
            <button type="button" className="btn btn-secondary" onClick={() => goTo(shiftMonth(month, 1))} disabled={month >= thisMonth()} aria-label={tr('Next month')}>›</button>
            <button type="button" className="btn btn-secondary" onClick={exportCsv} disabled={!data || !rows.length}>{tr('Export CSV')}</button>
          </div>
        )}
        stats={data ? stats : []} />

      {months.length > 0 && (
        <nav id="sm-months" className="sm-months" aria-label={tr('Months')}>
          {months.map((mo) => {
            const full = mo.daysFilled >= mo.daysSoFar;
            const pct = mo.daysSoFar ? Math.min(100, Math.round((mo.daysFilled / mo.daysSoFar) * 100)) : 0;
            return (
              <button
                type="button"
                key={mo.month}
                className={'sm-month' + (mo.month === month ? ' is-current' : '') + (mo.daysFilled === 0 ? ' is-empty' : full ? ' is-full' : ' is-part')}
                onClick={() => goTo(mo.month)}
                aria-current={mo.month === month ? 'true' : undefined}
                title={tr('{n} of {total} days filled in', { n: mo.daysFilled, total: mo.daysSoFar })}
              >
                <span className="sm-month-name">{monthShort(mo.month)} {mo.month.slice(2, 4)}</span>
                <span className="sm-month-bar" aria-hidden="true"><span style={{ width: pct + '%' }} /></span>
                <span className="sm-month-days">{full && mo.daysFilled ? tr('done') : mo.daysFilled + '/' + mo.daysSoFar}</span>
              </button>
            );
          })}
        </nav>
      )}

      {data && <Insights items={insights.slice(0, 5)} />}

      {missingDays > 0 && (
        <div className="sm-gap">
          <p>{tr('To fill in the missing days, import that month\'s Finish Inventory workbook (the .xlsx with the day tabs 1, 2, 3 …): every day comes in at once. Do the oldest month first.')}</p>
          <div className="sm-gap-actions">
            <Link className="btn btn-primary" to="/inventory?import=drive">{tr('Import from Google Drive')}</Link>
            <Link className="btn btn-secondary" to="/inventory?import=workbook">{tr('Upload a workbook')}</Link>
          </div>
        </div>
      )}

      {data && filled.length > 0 && (
        <div className="dk-two sm-charts">
          <Section title={tr('Day by day')} sub={tr('Items received and sold on each day filled in, all products.')} card>
            <PairBars rows={dayBars} aLabel={tr('Received')} bLabel={tr('Sold')} format={(v) => fmt(v)} />
          </Section>
          <Section title={tr('Best sellers')} sub={sellers.some((r) => r.sellingPrice) ? tr('By what they sold for; products with no price by quantity.') : tr('By quantity sold.')} card>
            {top.length ? <RankList rows={top} /> : <p className="dk-muted">{tr('Nothing sold this month yet.')}</p>}
          </Section>
        </div>
      )}
      {losses.length > 0 && (
        <Section title={tr('What went missing')} sub={tr('Products counted short of what the sheet expected, most first. Worth a look before the next count.')} card>
          <RankList rows={losses} barClass="is-bad" />
        </Section>
      )}

      <Section id="sm-table" title={tr('Every product')} sub={tr('The closing figure on each day. A marked figure is a count that differed from the expected closing; hover it to see both.')}
        action={(
          <label className="sm-check">
            <input type="checkbox" checked={allDays} onChange={(e) => setAllDays(e.target.checked)} /> {tr('Show every day')}
          </label>
        )}>
        <div className="sm-tools">
          <div className="sm-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search products…')} /></div>
          <select className="input sm-select" value={category} onChange={(e) => setCategory(e.target.value)} aria-label={tr('Category')}>
            <option value="">{tr('All categories')}</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
        </div>

        {loading && !data ? (
          <p className="dk-muted">{tr('Loading…')}</p>
        ) : data && (
          filled.length === 0 && !allDays ? (
            <div className="dk-empty sm-empty">
              <p>{tr('Nothing was entered on the daily stock sheet this month yet.')}</p>
              <Link className="btn btn-primary" to="/stocksheet">{tr('Open the daily stock sheet')}</Link>
            </div>
          ) : (
            <div className="sm-scroll">
              <table className="sm-table">
                <thead>
                  <tr>
                    <th className="sm-item">{tr('Item')}</th>
                    <th className="sm-num">{tr('Opening')}</th>
                    {days.map((d) => (
                      <th key={d.date} className={'sm-num sm-day' + (d.hasLines ? '' : ' is-empty')}>
                        <Link to={'/stocksheet?date=' + d.date} title={tr('Open {date} on the daily stock sheet', { date: d.date })}>{Number(d.date.slice(8))}</Link>
                      </th>
                    ))}
                    <th className="sm-num sm-total">{tr('Received')}</th>
                    <th className="sm-num sm-total">{tr('Transferred')}</th>
                    <th className="sm-num sm-total">{tr('Breakage')}</th>
                    <th className="sm-num sm-total">{tr('Sold')}</th>
                    <th className="sm-num sm-total">{tr('Missing')}</th>
                    <th className="sm-num sm-total">{tr('Closing')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.productId}>
                      <td className="sm-item">
                        <div className="sm-item-main">
                          <Photo kind="product" id={r.productId} name={r.name} photo={r.photo} size={28} />
                          <div className="sm-item-text">
                            <div className="sm-name">{r.name}</div>
                            <div className="sm-meta">{r.sku} · {r.unit}</div>
                          </div>
                        </div>
                      </td>
                      <td className="sm-num">{fmt(r.opening)}</td>
                      {days.map((d) => {
                        const c = r.cells[d.date];
                        if (!c) return <td key={d.date} className="sm-num sm-blank" />;
                        const off = c.variance !== null && c.variance !== 0;
                        return (
                          <td
                            key={d.date}
                            className={'sm-num' + (off ? (c.variance > 0 ? ' is-short' : ' is-over') : c.physical !== null ? ' is-counted' : '')}
                            title={off ? tr('Counted {counted}, expected {expected}', { counted: fmt(c.physical), expected: fmt(c.expected) }) : c.physical !== null ? tr('Counted') : undefined}
                          >
                            {fmt(c.closing)}
                          </td>
                        );
                      })}
                      <td className="sm-num sm-total">{fmt(r.totals.received)}</td>
                      <td className="sm-num sm-total">{fmt(r.totals.transferred)}</td>
                      <td className="sm-num sm-total">{fmt(r.totals.breakage)}</td>
                      <td className="sm-num sm-total">{fmt(r.totals.sold)}</td>
                      <td className={'sm-num sm-total' + (r.missing ? ' is-short' : '')}>{r.missing ? fmt(r.missing) : ''}</td>
                      <td className="sm-num sm-total"><strong>{fmt(r.closing)}</strong></td>
                    </tr>
                  ))}
                </tbody>
                {rows.length > 1 && (
                  <tfoot>
                    <tr>
                      <td className="sm-item"><strong>{tr('Total, {n} products', { n: rows.length })}</strong></td>
                      <td />
                      {days.map((d) => <td key={d.date} />)}
                      <td className="sm-num sm-total">{fmt(totals.received)}</td>
                      <td className="sm-num sm-total">{fmt(totals.transferred)}</td>
                      <td className="sm-num sm-total">{fmt(totals.breakage)}</td>
                      <td className="sm-num sm-total">{fmt(totals.sold)}</td>
                      <td className={'sm-num sm-total' + (totals.missing ? ' is-short' : '')}>{totals.missing ? fmt(totals.missing) : ''}</td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
              {!rows.length && <p className="dk-muted sm-note">{tr('Nothing matches. Try another search or filter.')}</p>}
            </div>
          )
        )}
      </Section>

      <Glossary items={[
        [tr('Closing'), tr('What was left at the end of the day: the count when someone counted, otherwise the expected figure.')],
        [tr('Missing'), tr('Stock the sheet expected that was not there when counted, added up over the month. It is worth finding out where it went.')],
        [tr('Marked figures'), tr('Red: counted short. Blue: counted more than expected. Underlined: counted and matched.')],
        [tr('Days on the sheet'), tr('Days of the month so far with at least one line entered. A missing day can be filled in on the daily stock sheet or by importing the month\'s workbook.')],
        [tr('Per day'), tr('Sales are compared per day filled in, so a month still in progress compares fairly with a full one.')]
      ]} />
    </div>
  );
}
