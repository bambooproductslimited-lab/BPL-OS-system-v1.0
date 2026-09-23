import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { tr, msg, activeIntlLocale } from '../lib/i18n.jsx';
import { formatDate } from '../lib/dates';
import './StockSheetPage.css';

// The daily stock sheet: the "BPL Finish Inventory" day tab, filled in here
// (backend stockSheet.service.js). Same columns as the sheet — opening,
// received, transferred, breakage and sold are typed in; total, expected
// closing and variance are worked out as you type. Leave Physical count
// blank when nobody counted: the day then closes at the expected figure,
// as the sheet's formula does.
//
// A line saves when you leave it (Tab/Enter or click away). "Save the rest
// as shown" stores every line nobody touched, for days when most products
// didn't move.

const INPUTS = ['opening', 'received', 'transferred', 'breakage', 'sold', 'physical'];

function today() { return new Date().toISOString().slice(0, 10); }
function shiftDay(date, days) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function fmt(n) {
  return n === null || n === undefined || Number.isNaN(n) ? '' : Number(n).toLocaleString(activeIntlLocale(), { maximumFractionDigits: 2 });
}
function numOr0(v) { const x = Number(v); return v === '' || !Number.isFinite(x) ? 0 : x; }

// The sheet's formulas, for the figures shown while typing.
function work(v) {
  const total = numOr0(v.opening) + numOr0(v.received);
  const expected = total - numOr0(v.transferred) - numOr0(v.breakage) - numOr0(v.sold);
  const physical = v.physical === '' ? null : numOr0(v.physical);
  return { total, expected, physical, variance: physical === null ? null : expected - physical };
}

export default function StockSheetPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const date = params.get('date') || today();
  const isFuture = date > today();
  const canEdit = can('inventory.manage') && !isFuture;

  const [day, setDay] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [drafts, setDrafts] = useState({});
  const [rowState, setRowState] = useState({});
  const [savingRest, setSavingRest] = useState(false);
  const [toast, setToast] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDay(await api.get('/stock-sheet/day/' + date));
      setDrafts({});
      setRowState({});
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [date]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  function goTo(d) { setParams(d === today() ? {} : { date: d }); }

  const categories = useMemo(() => Array.from(new Set((day ? day.lines : []).map((l) => l.category).filter(Boolean))).sort(), [day]);
  const visible = (day ? day.lines : []).filter((l) =>
    (!category || l.category === category) && matchesQuery(search, l.name, l.sku, l.category));

  function valuesOf(line) {
    const d = drafts[line.productId] || {};
    const out = {};
    INPUTS.forEach((f) => {
      out[f] = d[f] !== undefined ? d[f] : line[f] === null ? '' : String(line[f]);
    });
    return out;
  }

  function edit(productId, field, value) {
    setDrafts((prev) => ({ ...prev, [productId]: { ...(prev[productId] || {}), [field]: value } }));
    setRowState((prev) => ({ ...prev, [productId]: null }));
  }

  function replaceLine(updated) {
    setDay((prev) => ({ ...prev, lines: prev.lines.map((l) => (l.productId === updated.productId ? updated : l)) }));
  }

  async function saveRow(line) {
    if (!drafts[line.productId]) return;
    const values = valuesOf(line);
    setRowState((prev) => ({ ...prev, [line.productId]: 'saving' }));
    try {
      const updated = await api.put('/stock-sheet/day/' + date + '/lines/' + line.productId, values);
      replaceLine(updated);
      setDrafts((prev) => { const next = { ...prev }; delete next[line.productId]; return next; });
      setRowState((prev) => ({ ...prev, [line.productId]: 'saved' }));
    } catch (err) {
      setRowState((prev) => ({ ...prev, [line.productId]: { error: err.message } }));
    }
  }

  // Saves when focus leaves the row, not on every field — Tab moves along
  // the line without a request per box.
  function onRowBlur(e, line) {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    saveRow(line);
  }

  const unsaved = day ? day.lines.filter((l) => !l.saved || drafts[l.productId]) : [];

  async function saveRest() {
    setSavingRest(true);
    setError(null);
    try {
      const lines = unsaved.map((l) => ({ productId: l.productId, ...valuesOf(l) }));
      setDay(await api.put('/stock-sheet/day/' + date, { lines }));
      setDrafts({});
      setRowState({});
      setToast(tr('Saved {n} lines for {date}.', { n: lines.length, date: formatDate(date) }));
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingRest(false);
    }
  }

  return (
    <div>
      <p className="stocksheet-intro">
        {tr('The Finish Inventory day tab, filled in here. Type Received, Transferred, Breakage and Sold; the expected closing works itself out. Enter a Physical count only when someone counted — left blank, the day closes at the expected figure and the next day opens there. Each line saves when you leave it.')}
      </p>

      <div className="stocksheet-toolbar">
        <div className="stocksheet-daypicker">
          <button type="button" className="btn btn-secondary" onClick={() => goTo(shiftDay(date, -1))} aria-label={tr('Previous day')}>‹</button>
          <input className="input" type="date" value={date} max={today()} onChange={(e) => e.target.value && goTo(e.target.value)} aria-label={tr('Day')} />
          <button type="button" className="btn btn-secondary" onClick={() => goTo(shiftDay(date, 1))} disabled={date >= today()} aria-label={tr('Next day')}>›</button>
          {date !== today() && <button type="button" className="btn btn-secondary" onClick={() => goTo(today())}>{tr('Today')}</button>}
        </div>
        <SearchInput value={search} onChange={setSearch} placeholder={tr('Search products…')} />
        <select className="input stocksheet-category" value={category} onChange={(e) => setCategory(e.target.value)} aria-label={tr('Category')}>
          <option value="">{tr('All categories')}</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <Link className="btn btn-secondary" to={'/stocksummary?month=' + date.slice(0, 7)}>{tr('Month summary')}</Link>
      </div>

      {error && <div className="error-banner" style={{ marginBottom: 12 }}>{error}</div>}

      {day && (
        <div className="stocksheet-status">
          <span>
            <strong>{formatDate(date)}</strong> · {tr('{saved} of {total} lines saved', { saved: day.savedCount, total: day.lines.length })}
          </span>
          {canEdit && unsaved.length > 0 && (
            <button type="button" className="btn btn-primary" disabled={savingRest} onClick={saveRest}>
              {savingRest ? tr('Saving…') : tr('Save the rest as shown ({n})', { n: unsaved.length })}
            </button>
          )}
          {isFuture && <span className="stocksheet-note">{tr('This day hasn\'t happened yet — nothing can be entered.')}</span>}
        </div>
      )}

      {loading && !day ? (
        <p className="stocksheet-note">{tr('Loading…')}</p>
      ) : day && (
        <div className="stocksheet-scroll">
          <table className="table stocksheet-table">
            <thead>
              <tr>
                <th className="stocksheet-item">{tr('Item')}</th>
                <th>{tr('Opening stock')}</th>
                <th>{tr('Received')}</th>
                <th className="stocksheet-calc">{tr('Total stock')}</th>
                <th>{tr('Transferred')}</th>
                <th>{tr('Breakage')}</th>
                <th>{tr('Sold')}</th>
                <th className="stocksheet-calc">{tr('Expected closing')}</th>
                <th>{tr('Physical count')}</th>
                <th className="stocksheet-calc">{tr('Variance')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((line) => {
                const v = valuesOf(line);
                const w = work(v);
                const state = rowState[line.productId];
                const dirty = !!drafts[line.productId];
                const openingDiffers = line.saved && line.previousClosing !== null && numOr0(v.opening) !== line.previousClosing;
                return (
                  <tr
                    key={line.productId}
                    className={'stocksheet-row' + (line.saved ? ' is-saved' : '') + (dirty ? ' is-dirty' : '') + (state && state.error ? ' has-error' : '')}
                    onBlur={canEdit ? (e) => onRowBlur(e, line) : undefined}
                  >
                    <td className="stocksheet-item">
                      <div className="stocksheet-name">{line.name}</div>
                      <div className="stocksheet-meta">
                        {line.sku} · {line.category} · {line.unit}
                        {state === 'saving' && <> · {tr('Saving…')}</>}
                        {state === 'saved' && <span className="stocksheet-ok"> · {tr('Saved')}</span>}
                        {!state && !line.saved && !dirty && <> · {tr('not saved yet')}</>}
                      </div>
                      {state && state.error && <div className="stocksheet-error">{state.error}</div>}
                      {openingDiffers && (
                        <div className="stocksheet-hint">
                          {tr('{date} closed at {n}', { date: formatDate(line.previousDate), n: fmt(line.previousClosing) })}
                          {canEdit && <> · <button type="button" className="stocksheet-link" onClick={() => edit(line.productId, 'opening', String(line.previousClosing))}>{tr('Use it')}</button></>}
                        </div>
                      )}
                      {!line.saved && line.producedToday > 0 && (
                        <div className="stocksheet-hint">{tr('Received includes {n} from production that day.', { n: fmt(line.producedToday) })}</div>
                      )}
                    </td>
                    {INPUTS.map((f) => {
                      const cell = canEdit ? (
                        <input
                          className="input stocksheet-input"
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="any"
                          value={v[f]}
                          placeholder={f === 'physical' ? fmt(w.expected) : '0'}
                          onChange={(e) => edit(line.productId, f, e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                          aria-label={line.name + ' — ' + tr(COLUMN_LABELS[f])}
                        />
                      ) : (
                        <span>{f === 'physical' && v[f] === '' ? '—' : fmt(numOr0(v[f]))}</span>
                      );
                      const calcAfter = f === 'received' ? w.total : f === 'sold' ? w.expected : null;
                      return [
                        <td key={f} className="stocksheet-num">{cell}</td>,
                        calcAfter !== null && (
                          <td key={f + '-calc'} className={'stocksheet-num stocksheet-calc' + (calcAfter < 0 ? ' is-negative' : '')}>{fmt(calcAfter)}</td>
                        )
                      ];
                    })}
                    <td className={'stocksheet-num stocksheet-calc' + (w.variance ? ' has-variance' : '')}>{w.variance === null ? '' : fmt(w.variance)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!visible.length && <p className="stocksheet-note">{day.lines.length ? tr('No products match "{search}"', { search }) : tr('No products in the catalogue yet')}</p>}
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

const COLUMN_LABELS = {
  opening: msg('Opening stock'), received: msg('Received'), transferred: msg('Transferred'),
  breakage: msg('Breakage'), sold: msg('Sold'), physical: msg('Physical count')
};
