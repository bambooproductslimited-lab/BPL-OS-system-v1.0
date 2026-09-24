import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { tr, activeIntlLocale } from '../lib/i18n.jsx';
import { rowsToCsv, downloadCsv } from '../lib/csvExport';
import './StockSummaryPage.css';

// The monthly summary: the "2026 Sept" tab of the Finish Inventory sheet,
// worked out from the daily stock sheet (backend stockSheet.service.js
// month()). Each product's closing figure on every day that was filled in,
// then the month's received, transferred, breakage and sold. A marked cell
// is a day where the physical count differed from the expected figure.
//
// Across the top, every month since the first one on record, with how many
// of its days are in the OS — so earlier months are one click away, and a
// month with gaps says so and offers the whole-workbook import to fill them.

function thisMonth() { return new Date().toISOString().slice(0, 7); }
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
  const [params, setParams] = useSearchParams();
  const month = params.get('month') || thisMonth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [allDays, setAllDays] = useState(false);
  const [months, setMonths] = useState([]);

  useEffect(() => {
    api.get('/stock-sheet/months').then(setMonths).catch(() => setMonths([]));
  }, []);
  const monthInfo = months.find((x) => x.month === month);
  const missing = monthInfo ? Math.max(0, monthInfo.daysSoFar - monthInfo.daysFilled) : 0;

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

  function goTo(m) { setParams(m === thisMonth() ? {} : { month: m }); }

  const days = data ? data.days.filter((d) => allDays || d.hasLines) : [];
  const categories = useMemo(() => Array.from(new Set((data ? data.rows : []).map((r) => r.category).filter(Boolean))).sort(), [data]);
  const rows = (data ? data.rows : []).filter((r) =>
    (!category || r.category === category) && matchesQuery(search, r.name, r.sku, r.category));
  const filledDays = data ? data.days.filter((d) => d.hasLines).length : 0;

  function exportCsv() {
    const head = [tr('SKU'), tr('Item'), tr('Category'), tr('Unit'), tr('Opening stock')]
      .concat(days.map((d) => d.date))
      .concat([tr('Received'), tr('Transferred'), tr('Breakage'), tr('Sold'), tr('Closing')]);
    const body = rows.map((r) => [r.sku, r.name, r.category, r.unit, r.opening === null ? '' : r.opening]
      .concat(days.map((d) => (r.cells[d.date] ? r.cells[d.date].closing : '')))
      .concat([r.totals.received, r.totals.transferred, r.totals.breakage, r.totals.sold, r.closing === null ? '' : r.closing]));
    downloadCsv('stock-summary-' + month + '.csv', rowsToCsv([head].concat(body)));
  }

  return (
    <div>
      <p className="stocksummary-intro">
        {tr('Each product\'s closing stock on every day of the month that was filled in on the daily stock sheet, then the month\'s movements. A marked figure is a day where the physical count differed from the expected closing — hover it to see both. Click a day to open that day\'s sheet.')}
      </p>

      <div className="stocksummary-toolbar">
        <div className="stocksummary-monthpicker">
          <button type="button" className="btn btn-secondary" onClick={() => goTo(shiftMonth(month, -1))} aria-label={tr('Previous month')}>‹</button>
          <input className="input" type="month" value={month} max={thisMonth()} onChange={(e) => e.target.value && goTo(e.target.value)} aria-label={tr('Month')} />
          <button type="button" className="btn btn-secondary" onClick={() => goTo(shiftMonth(month, 1))} disabled={month >= thisMonth()} aria-label={tr('Next month')}>›</button>
        </div>
        <SearchInput value={search} onChange={setSearch} placeholder={tr('Search products…')} />
        <select className="input stocksummary-category" value={category} onChange={(e) => setCategory(e.target.value)} aria-label={tr('Category')}>
          <option value="">{tr('All categories')}</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <label className="stocksummary-check">
          <input type="checkbox" checked={allDays} onChange={(e) => setAllDays(e.target.checked)} /> {tr('Show every day')}
        </label>
        <button type="button" className="btn btn-secondary" onClick={exportCsv} disabled={!data || !rows.length}>{tr('Export CSV')}</button>
      </div>

      {months.length > 0 && (
        <nav className="stocksummary-months" aria-label={tr('Months')}>
          {months.map((mo) => {
            const full = mo.daysFilled >= mo.daysSoFar;
            const pct = mo.daysSoFar ? Math.min(100, Math.round((mo.daysFilled / mo.daysSoFar) * 100)) : 0;
            return (
              <button
                type="button"
                key={mo.month}
                className={'stocksummary-month' + (mo.month === month ? ' is-current' : '') + (mo.daysFilled === 0 ? ' is-empty' : full ? ' is-full' : '')}
                onClick={() => goTo(mo.month)}
                aria-current={mo.month === month ? 'true' : undefined}
                title={tr('{n} of {total} days filled in', { n: mo.daysFilled, total: mo.daysSoFar })}
              >
                <span className="stocksummary-month-name">{monthShort(mo.month)} {mo.month.slice(2, 4)}</span>
                <span className="stocksummary-month-days">{mo.daysFilled}/{mo.daysSoFar}</span>
                <span className="stocksummary-month-bar" aria-hidden="true"><span style={{ width: pct + '%' }} /></span>
              </button>
            );
          })}
        </nav>
      )}

      {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}

      {missing > 0 && (
        <div className="stocksummary-gap">
          <div>
            <strong>{tr('{n} of {total} days of {month} are in the OS.', { n: monthInfo.daysFilled, total: monthInfo.daysSoFar, month: monthLabel(month) })}</strong>{' '}
            {tr('To fill in the rest, import that month\'s Finish Inventory workbook (the .xlsx with the day tabs 1, 2, 3 …) — every day comes in at once. Do the oldest month first.')}
          </div>
          <Link className="btn btn-primary" to="/inventory?import=workbook">{tr('Import a month\'s workbook')}</Link>
        </div>
      )}

      {data && (
        <div className="stocksummary-status">
          <strong>{monthLabel(month)}</strong> · {tr('Days filled in: {n}', { n: filledDays })}
        </div>
      )}

      {loading && !data ? (
        <p className="stocksummary-note">{tr('Loading…')}</p>
      ) : data && (
        filledDays === 0 && !allDays ? (
          <div className="stocksummary-empty">
            <p>{tr('Nothing was entered on the daily stock sheet this month yet.')}</p>
            <Link className="btn btn-primary" to="/stocksheet">{tr('Open the daily stock sheet')}</Link>
          </div>
        ) : (
          <div className="stocksummary-scroll">
            <table className="table stocksummary-table">
              <thead>
                <tr>
                  <th className="stocksummary-item">{tr('Item')}</th>
                  <th className="stocksummary-num">{tr('Opening')}</th>
                  {days.map((d) => (
                    <th key={d.date} className={'stocksummary-num stocksummary-day' + (d.hasLines ? '' : ' is-empty')}>
                      <Link to={'/stocksheet?date=' + d.date}>{Number(d.date.slice(8))}</Link>
                    </th>
                  ))}
                  <th className="stocksummary-num stocksummary-total">{tr('Received')}</th>
                  <th className="stocksummary-num stocksummary-total">{tr('Transferred')}</th>
                  <th className="stocksummary-num stocksummary-total">{tr('Breakage')}</th>
                  <th className="stocksummary-num stocksummary-total">{tr('Sold')}</th>
                  <th className="stocksummary-num stocksummary-total">{tr('Closing')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.productId}>
                    <td className="stocksummary-item">
                      <div className="stocksummary-name">{r.name}</div>
                      <div className="stocksummary-meta">{r.sku} · {r.unit}</div>
                    </td>
                    <td className="stocksummary-num">{fmt(r.opening)}</td>
                    {days.map((d) => {
                      const c = r.cells[d.date];
                      if (!c) return <td key={d.date} className="stocksummary-num stocksummary-blank" />;
                      const off = c.variance !== null && c.variance !== 0;
                      return (
                        <td
                          key={d.date}
                          className={'stocksummary-num' + (off ? ' has-variance' : '')}
                          title={off ? tr('Counted {counted}, expected {expected}', { counted: fmt(c.physical), expected: fmt(c.expected) }) : undefined}
                        >
                          {fmt(c.closing)}
                        </td>
                      );
                    })}
                    <td className="stocksummary-num stocksummary-total">{fmt(r.totals.received)}</td>
                    <td className="stocksummary-num stocksummary-total">{fmt(r.totals.transferred)}</td>
                    <td className="stocksummary-num stocksummary-total">{fmt(r.totals.breakage)}</td>
                    <td className="stocksummary-num stocksummary-total">{fmt(r.totals.sold)}</td>
                    <td className="stocksummary-num stocksummary-total"><strong>{fmt(r.closing)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && <p className="stocksummary-note">{tr('No products match "{search}"', { search })}</p>}
          </div>
        )
      )}
    </div>
  );
}
