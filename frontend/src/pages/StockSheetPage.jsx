import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import Photo from '../components/Photo';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { Glossary, Hero, Insights, Section, fmtDate, jump } from '../components/DashKit';
import { money } from '../lib/currency';
import { tr, msg, activeIntlLocale } from '../lib/i18n.jsx';
import './EmployeesPage.css';
import './StockSheetPage.css';

// The daily stock sheet: the "BPL Finish Inventory" day tab, filled in here
// (backend stockSheet.service.js). Same columns as the sheet — opening,
// received, transferred, breakage and sold are typed in; total, expected
// closing and variance are worked out as you type. Leave Counted blank when
// nobody counted: the day then closes at the expected figure, as the
// sheet's formula does.
//
// Around the grid, the same "explains itself" layout as the dashboards
// (components/DashKit.jsx): the day's key numbers, what stands out (lines
// not entered yet, counts that don't match, more going out than was there,
// skipped days), a strip of the last two weeks, and filters. A line saves
// when you leave it (Tab/Enter or click away); Enter moves down the column.
// "Save the rest as shown" stores every line nobody touched, for days when
// most products didn't move. On a phone each product is a small card.

const INPUTS = ['opening', 'received', 'transferred', 'breakage', 'sold', 'physical'];
const COLUMN_LABELS = {
  opening: msg('Opening stock'), received: msg('Received'), transferred: msg('Transferred'),
  breakage: msg('Breakage'), sold: msg('Sold'), physical: msg('Counted')
};
const STRIP_DAYS = 14;

function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function shiftDay(date, days) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }
function fmt(n) {
  return n === null || n === undefined || Number.isNaN(n) ? '' : Number(n).toLocaleString(activeIntlLocale(), { maximumFractionDigits: 2 });
}
function numOr0(v) { const x = Number(v); return v === '' || !Number.isFinite(x) ? 0 : x; }

// The sheet's formulas, for the figures shown while typing.
function work(v) {
  const total = numOr0(v.opening) + numOr0(v.received);
  const expected = total - numOr0(v.transferred) - numOr0(v.breakage) - numOr0(v.sold);
  const physical = v.physical === '' ? null : numOr0(v.physical);
  return { total, expected, physical, variance: physical === null ? null : expected - physical, closing: physical === null ? expected : physical };
}

export default function StockSheetPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const date = params.get('date') || today();
  const isFuture = date > today();
  const canEdit = can('inventory.manage') && !isFuture;

  const [day, setDay] = useState(null);
  const [strip, setStrip] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [chip, setChip] = useState('all');
  const [drafts, setDrafts] = useState({});
  const [rowState, setRowState] = useState({});
  const [savingRest, setSavingRest] = useState(false);
  const [toast, setToast] = useState(null);

  // The strip ends today while the chosen day is within it, else on that day.
  const stripEnd = daysBetween(date, today()) < STRIP_DAYS && !isFuture ? today() : date;
  const loadStrip = useCallback(async () => {
    try { setStrip(await api.get('/stock-sheet/days?to=' + stripEnd + '&n=' + STRIP_DAYS)); } catch { setStrip(null); }
  }, [stripEnd]);

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
  useEffect(() => { loadStrip(); }, [loadStrip]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  function goTo(d) { setChip('all'); setParams(d === today() ? {} : { date: d }); }

  const categories = useMemo(() => Array.from(new Set((day ? day.lines : []).map((l) => l.category).filter(Boolean))).sort(), [day]);

  function valuesOf(line) {
    const d = drafts[line.productId] || {};
    const out = {};
    INPUTS.forEach((f) => {
      out[f] = d[f] !== undefined ? d[f] : line[f] === null ? '' : String(line[f]);
    });
    out.note = d.note !== undefined ? d.note : line.note || '';
    return out;
  }

  function edit(productId, field, value) {
    setDrafts((prev) => ({ ...prev, [productId]: { ...(prev[productId] || {}), [field]: value } }));
    setRowState((prev) => ({ ...prev, [productId]: null }));
  }

  function replaceLine(updated) {
    setDay((prev) => ({ ...prev, lines: prev.lines.map((l) => (l.productId === updated.productId ? { ...l, ...updated } : l)) }));
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
      loadStrip();
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
  // Enter moves down the column, like a spreadsheet.
  function onKey(e, index, field) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const next = document.querySelector('[data-cell="' + (index + (e.shiftKey ? -1 : 1)) + '-' + field + '"]');
    if (next) { next.focus(); next.select(); } else e.currentTarget.blur();
  }

  const lines = day ? day.lines : [];
  const unsaved = lines.filter((l) => !l.saved || drafts[l.productId]);

  async function saveRest() {
    setSavingRest(true);
    setError(null);
    try {
      const toSave = unsaved.map((l) => ({ productId: l.productId, ...valuesOf(l) }));
      setDay(await api.put('/stock-sheet/day/' + date, { lines: toSave }));
      setDrafts({});
      setRowState({});
      setToast(tr('Saved {n} lines for {date}.', { n: toSave.length, date: fmtDate(date) }));
      loadStrip();
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingRest(false);
    }
  }

  // ── what the page shows ────────────────────────────────────────────
  const rows = lines.map((line) => {
    const v = valuesOf(line);
    const w = work(v);
    const moved = numOr0(v.received) + numOr0(v.transferred) + numOr0(v.breakage) + numOr0(v.sold) > 0;
    const openingDiffers = line.previousClosing !== null && numOr0(v.opening) !== line.previousClosing;
    return { line, v, w, moved, openingDiffers, dirty: !!drafts[line.productId], problem: w.expected < 0 || (line.saved && openingDiffers) };
  });
  const sold = rows.reduce((s, r) => s + numOr0(r.v.sold), 0);
  const soldValue = rows.reduce((s, r) => s + numOr0(r.v.sold) * (r.line.sellingPrice || 0), 0);
  const received = rows.reduce((s, r) => s + numOr0(r.v.received), 0);
  const produced = rows.filter((r) => r.line.producedToday > 0);
  const counted = rows.filter((r) => r.w.physical !== null);
  const mismatched = counted.filter((r) => r.w.variance).sort((a, b) => Math.abs(b.w.variance) - Math.abs(a.w.variance));
  const negative = rows.filter((r) => r.w.expected < 0);
  const openingOff = rows.filter((r) => r.line.saved && r.openingDiffers);
  const breakage = rows.reduce((s, r) => s + numOr0(r.v.breakage), 0);
  const savedCount = lines.filter((l) => l.saved).length;

  function showOnly(key) { setChip(chip === key ? 'all' : key); jump('ss-sheet'); }
  const stats = [
    { icon: 'doc', value: savedCount + ' / ' + lines.length, label: tr('lines entered'), note: unsaved.length ? tr('{n} still to enter or save', { n: unsaved.length }) : tr('the whole day is in'), tone: unsaved.length ? (date < today() ? 'alert' : '') : 'good', onClick: () => showOnly('todo') },
    { icon: 'up', value: fmt(sold), label: tr('sold'), note: soldValue ? tr('worth {amount}', { amount: money(soldValue) }) : tr('items, all products'), onClick: () => showOnly('moved') },
    { icon: 'down', value: fmt(received), label: tr('received'), note: produced.length ? tr('{n} products from production', { n: produced.length }) : breakage ? tr('{n} broken', { n: fmt(breakage) }) : tr('items, all products'), onClick: () => showOnly('moved') },
    { icon: 'scale', value: String(mismatched.length), label: tr('counts that don\'t match'), note: counted.length === 1 ? tr('of 1 product counted') : tr('of {n} products counted', { n: counted.length }), tone: mismatched.length ? 'bad' : counted.length ? 'good' : '', onClick: () => showOnly(mismatched.length ? 'variance' : 'counted') }
  ];

  const insights = [];
  if (day && day.lastFilledBefore && daysBetween(day.lastFilledBefore, date) > 1) {
    const gap = daysBetween(day.lastFilledBefore, date) - 1;
    insights.push({ tone: 'warn', icon: 'calendar', text: gap === 1 ? tr('Nothing was entered for {date}, the day before this one.', { date: fmtDate(shiftDay(date, -1)) }) : tr('Nothing was entered for the {n} days before this one (the last was {date}). Each day opens at the last day entered.', { n: gap, date: fmtDate(day.lastFilledBefore) }), action: { label: tr('Go to {date}', { date: fmtDate(shiftDay(day.lastFilledBefore, 1)) }), run: () => goTo(shiftDay(day.lastFilledBefore, 1)) } });
  }
  if (negative.length) insights.push({ tone: 'bad', icon: 'warn', text: negative.length === 1 ? tr('{name}: more went out than was in stock (expected {n}). Check the figures.', { name: negative[0].line.name, n: fmt(negative[0].w.expected) }) : tr('{n} lines have more going out than was in stock. Check the figures.', { n: negative.length }), action: { label: tr('Show them'), run: () => showOnly('check') } });
  if (mismatched.length) {
    const top = mismatched[0];
    insights.push({ tone: 'warn', icon: 'scale', text: top.w.variance > 0 ? tr('{name} was counted {n} short of what the sheet expected.', { name: top.line.name, n: fmt(top.w.variance) }) : tr('{name} was counted {n} over what the sheet expected.', { name: top.line.name, n: fmt(-top.w.variance) }), action: { label: mismatched.length === 1 ? tr('Show it') : tr('Show all {n}', { n: mismatched.length }), run: () => showOnly('variance') } });
  }
  if (openingOff.length) insights.push({ tone: 'info', icon: 'info', text: openingOff.length === 1 ? tr('{name} opens at a different figure from the day before\'s closing.', { name: openingOff[0].line.name }) : tr('{n} lines open at a different figure from the day before\'s closing.', { n: openingOff.length }), action: { label: tr('Show them'), run: () => showOnly('check') } });
  if (canEdit && unsaved.length && unsaved.length < lines.length) insights.push({ tone: 'info', icon: 'doc', text: tr('{n} lines are not saved yet. If nothing else moved, save them as shown and the day is complete.', { n: unsaved.length }), action: { label: tr('Save the rest'), run: saveRest } });
  if (produced.length) insights.push({ tone: 'info', icon: 'spark', text: produced.length === 1 ? tr('{name}: {n} from production are already in Received.', { name: produced[0].line.name, n: fmt(produced[0].line.producedToday) }) : tr('Production made {n} products this day; they are already in Received.', { n: produced.length }) });
  if (day && !unsaved.length && !mismatched.length && !negative.length && lines.length) insights.push({ tone: 'good', icon: 'check', text: tr('The whole day is entered and every count matches.') });

  const chipTest = {
    all: () => true,
    todo: (r) => !r.line.saved || r.dirty,
    moved: (r) => r.moved,
    counted: (r) => r.w.physical !== null,
    variance: (r) => !!r.w.variance,
    check: (r) => r.problem
  };
  const visible = rows
    .filter(chipTest[chip] || chipTest.all)
    .filter((r) => (!category || r.line.category === category) && matchesQuery(search, r.line.name, r.line.sku, r.line.category, r.v.note));
  const chips = [
    ['all', tr('All'), rows.length],
    ['todo', tr('Still to enter'), unsaved.length],
    ['moved', tr('Moved this day'), rows.filter(chipTest.moved).length],
    ['counted', tr('Counted'), counted.length],
    ['variance', tr('Count doesn\'t match'), mismatched.length],
    ['check', tr('Needs checking'), rows.filter(chipTest.check).length]
  ].filter(([k, , c]) => c > 0 || k === 'all' || k === chip);

  const longDate = new Date(date + 'T00:00:00').toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <div className="dk ss">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={longDate}
        title={tr('Daily stock sheet')}
        sub={tr('The Finish Inventory day tab, filled in here. Type what was received, transferred, broken and sold; the expected closing works itself out. Enter a count only when someone counted. Each line saves when you leave it, and Enter moves down the column.')}
        actions={(
          <div className="ss-daypicker">
            <button type="button" className="btn btn-secondary" onClick={() => goTo(shiftDay(date, -1))} aria-label={tr('Previous day')}>‹</button>
            <input className="input" type="date" value={date} max={today()} onChange={(e) => e.target.value && goTo(e.target.value)} aria-label={tr('Day')} />
            <button type="button" className="btn btn-secondary" onClick={() => goTo(shiftDay(date, 1))} disabled={date >= today()} aria-label={tr('Next day')}>›</button>
            {date !== today() && <button type="button" className="btn btn-secondary" onClick={() => goTo(today())}>{tr('Today')}</button>}
            <Link className="btn btn-secondary" to={'/stocksummary?month=' + date.slice(0, 7)}>{tr('Month summary')}</Link>
          </div>
        )}
        stats={day ? stats : []} />

      {strip && (
        <div className="ss-strip" role="list" aria-label={tr('The last {n} days', { n: STRIP_DAYS })}>
          {strip.days.map((d) => {
            const dt = new Date(d.date + 'T00:00:00');
            const full = strip.products > 0 && d.lines >= strip.products;
            const cls = 'ss-day' + (d.date === date ? ' is-current' : '') + (d.date > today() ? ' is-future' : '') + (full ? ' is-full' : d.lines ? ' is-part' : ' is-empty') + (d.variances ? ' has-variance' : '');
            return (
              <button key={d.date} type="button" role="listitem" className={cls} onClick={() => goTo(d.date)} disabled={d.date > today()}
                title={tr('{date}: {lines} of {total} lines entered, {sold} sold, {received} received', { date: fmtDate(d.date), lines: d.lines, total: strip.products, sold: fmt(d.sold), received: fmt(d.received) }) + (d.variances ? ' · ' + tr('{n} counts don\'t match', { n: d.variances }) : '')}>
                <span className="ss-day-wd">{dt.toLocaleDateString(activeIntlLocale(), { weekday: 'short' })}</span>
                <strong>{dt.getDate()}</strong>
                <span className="ss-day-bar" aria-hidden="true"><span style={{ width: (strip.products ? Math.min(100, (d.lines / strip.products) * 100) : 0) + '%' }} /></span>
                <span className="ss-day-note">{full ? tr('done') : d.lines ? tr('{n} lines', { n: d.lines }) : d.date === today() ? tr('today') : tr('empty')}</span>
              </button>
            );
          })}
        </div>
      )}

      {day && <Insights items={insights.slice(0, 5)} />}

      <Section id="ss-sheet" title={longDate} sub={isFuture ? tr('This day hasn\'t happened yet — nothing can be entered.') : canEdit ? tr('Grey figures are worked out. A line not saved yet shows what it would be if nothing moved.') : tr('You can see the sheet; people who manage the stock fill it in.')}>
        <div className="ss-tools">
          <div className="ss-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search products…')} /></div>
          <select className="input ss-select" value={category} onChange={(e) => setCategory(e.target.value)} aria-label={tr('Category')}>
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

        {loading && !day ? (
          <p className="dk-muted">{tr('Loading…')}</p>
        ) : day && (
          <div className="ss-scroll">
            <table className="ss-table">
              <thead>
                <tr>
                  <th className="ss-item">{tr('Item')}</th>
                  <th>{tr('Opening stock')}</th>
                  <th>{tr('Received')}</th>
                  <th className="ss-calc">{tr('Total stock')}</th>
                  <th>{tr('Transferred')}</th>
                  <th>{tr('Breakage')}</th>
                  <th>{tr('Sold')}</th>
                  <th className="ss-calc">{tr('Expected closing')}</th>
                  <th>{tr('Counted')}</th>
                  <th className="ss-calc">{tr('Variance')}</th>
                  <th className="ss-note-col">{tr('Note')}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r, index) => {
                  const { line, v, w } = r;
                  const state = rowState[line.productId];
                  return (
                    <tr
                      key={line.productId}
                      className={'ss-row' + (line.saved ? ' is-saved' : '') + (r.dirty ? ' is-dirty' : '') + (state && state.error ? ' has-error' : '') + (r.problem ? ' is-problem' : '')}
                      onBlur={canEdit ? (e) => onRowBlur(e, line) : undefined}
                    >
                      <td className="ss-item">
                        <div className="ss-item-main">
                          <Photo kind="product" id={line.productId} name={line.name} photo={line.photo} size={30} />
                          <div className="ss-item-text">
                            <div className="ss-name">{line.name}</div>
                            <div className="ss-meta">
                              {line.sku} · {line.unit}
                              {state === 'saving' && <> · {tr('Saving…')}</>}
                              {state === 'saved' && <span className="ss-ok"> · {tr('Saved')}</span>}
                              {!state && !line.saved && !r.dirty && <> · {tr('not saved yet')}</>}
                              {!state && r.dirty && <span className="ss-warn"> · {tr('not saved')}</span>}
                            </div>
                          </div>
                        </div>
                        {state && state.error && <div className="ss-error">{state.error}</div>}
                        {r.openingDiffers && line.saved && (
                          <div className="ss-hint">
                            {tr('{date} closed at {n}', { date: fmtDate(line.previousDate), n: fmt(line.previousClosing) })}
                            {canEdit && <> · <button type="button" className="ss-link" onClick={() => edit(line.productId, 'opening', String(line.previousClosing))}>{tr('Use it')}</button></>}
                          </div>
                        )}
                        {!line.saved && line.producedToday > 0 && (
                          <div className="ss-hint is-info">{tr('Received includes {n} from production that day.', { n: fmt(line.producedToday) })}</div>
                        )}
                      </td>
                      {INPUTS.map((f) => {
                        const cell = canEdit ? (
                          <input
                            className="input ss-input"
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="any"
                            value={v[f]}
                            data-cell={index + '-' + f}
                            placeholder={f === 'physical' ? fmt(w.expected) : '0'}
                            onChange={(e) => edit(line.productId, f, e.target.value)}
                            onKeyDown={(e) => onKey(e, index, f)}
                            aria-label={line.name + ' — ' + tr(COLUMN_LABELS[f])}
                          />
                        ) : (
                          <span>{f === 'physical' && v[f] === '' ? '—' : fmt(numOr0(v[f]))}</span>
                        );
                        const calcAfter = f === 'received' ? w.total : f === 'sold' ? w.expected : null;
                        return [
                          <td key={f} className={'ss-num ss-f-' + f} data-label={tr(COLUMN_LABELS[f])}>{cell}</td>,
                          calcAfter !== null && (
                            <td key={f + '-calc'} className={'ss-num ss-calc ss-f-' + (f === 'received' ? 'total' : 'expected') + (calcAfter < 0 ? ' is-negative' : '')} data-label={f === 'received' ? tr('Total stock') : tr('Expected closing')}>{fmt(calcAfter)}</td>
                          )
                        ];
                      })}
                      <td className={'ss-num ss-calc ss-f-variance' + (w.variance ? ' has-variance' : '')} data-label={tr('Variance')}>{w.variance === null ? '' : fmt(w.variance)}</td>
                      <td className="ss-note-col ss-f-note" data-label={tr('Note')}>
                        {canEdit ? (
                          <input className="input ss-note" value={v.note} maxLength={300} onChange={(e) => edit(line.productId, 'note', e.target.value)}
                            onKeyDown={(e) => onKey(e, index, 'note')} data-cell={index + '-note'} aria-label={line.name + ' — ' + tr('Note')} />
                        ) : <span className="dk-muted">{v.note}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!visible.length && <p className="dk-muted ss-empty">{lines.length ? tr('Nothing matches. Try another search or filter.') : tr('No products in the catalogue yet')}</p>}
          </div>
        )}
      </Section>

      {canEdit && unsaved.length > 0 && (
        <div className="ss-savebar" role="status">
          <span>{tr('{n} lines not saved yet', { n: unsaved.length })}</span>
          <button type="button" className="btn btn-primary" disabled={savingRest} onClick={saveRest}>
            {savingRest ? tr('Saving…') : tr('Save the rest as shown ({n})', { n: unsaved.length })}
          </button>
        </div>
      )}

      <Glossary items={[
        [tr('Opening stock'), tr('What was there at the start of the day: the previous day\'s closing, or the product\'s stock before its first day on the sheet.')],
        [tr('Received'), tr('Came into stock: from production (filled in for you), a supplier or a return.')],
        [tr('Transferred'), tr('Moved out to another store or site.')],
        [tr('Expected closing'), tr('Opening + received − transferred − breakage − sold.')],
        [tr('Counted'), tr('What was actually on the shelf, when someone counted. Left blank, the day closes at the expected figure.')],
        [tr('Variance'), tr('Expected minus counted. A positive number means stock is missing.')],
        [tr('Save the rest as shown'), tr('Saves every line nobody touched, for a day when most products did not move.')]
      ]} />

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
