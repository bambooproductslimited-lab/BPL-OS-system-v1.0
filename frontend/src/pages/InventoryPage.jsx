import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import Photo from '../components/Photo';
import PhotoDialog from '../components/PhotoDialog';
import RowMenu from '../components/RowMenu';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { CountImportDialog, DriveImportDialog } from '../components/InventoryImport';
import { Glossary, Hero, Insights, Section, Status, fmtDate, jump } from '../components/DashKit';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './EmployeesPage.css';
import './InventoryPage.css';

// Products & inventory. Same "explains itself" layout as the dashboards
// (components/DashKit.jsx): the key numbers (products, what the stock is
// worth, what is out of stock or low, what sold in the last 30 days), what
// stands out (out of stock, running out at the current rate of sales,
// products with no price or reorder level, not counted lately), then the
// products as cards or a list. A product opens in a window with its figures,
// 60 days of stock and its history; a count, a delivery, breakage or a sale
// recorded there goes onto today's line of the daily stock sheet, so the two
// never disagree (products.service.js). Products no longer made are
// archived. Counts come in from the Finish Inventory sheets through the
// imports in components/InventoryImport.jsx.

const COUNT_DAYS = 30;
const SOON_DAYS = 14;
const MODES = [
  { key: 'count', label: msg('Counted on the shelf'), note: msg('The number you counted becomes the stock.') },
  { key: 'received', label: msg('Received'), note: msg('From production, a supplier or a return.') },
  { key: 'sold', label: msg('Sold'), note: msg('Taken out of stock for a sale.') },
  { key: 'breakage', label: msg('Broken or damaged'), note: msg('Taken out of stock as a loss.') }
];
const SORTS = [
  { key: 'sheet', label: msg('As on the stock sheet') },
  { key: 'name', label: msg('Name A–Z') },
  { key: 'stock', label: msg('Least stock first') },
  { key: 'sold', label: msg('Best sellers first') },
  { key: 'value', label: msg('Highest value first') }
];
const EMPTY_FORM = { sku: '', name: '', category: '', unit: '', costPrice: '', sellingPrice: '', currentStock: '', reorderLevel: '', description: '' };

function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function n(v, digits = 1) { return Number(v || 0).toLocaleString(activeIntlLocale(), { maximumFractionDigits: digits }); }
function daysSince(iso) {
  if (!iso) return null;
  const today = new Date();
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return Math.round((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(y, m - 1, d)) / 86400000);
}

// What the page works out for each product.
function facts(p) {
  const perDay = p.sold30 > 0 ? p.sold30 / 30 : 0;
  const daysLeft = perDay > 0 ? Math.floor(p.currentStock / perDay) : null;
  const state = p.currentStock <= 0 ? 'out' : p.reorderLevel > 0 && p.currentStock <= p.reorderLevel ? 'low' : daysLeft !== null && daysLeft <= SOON_DAYS ? 'soon' : 'ok';
  const margin = p.sellingPrice > 0 && p.costPrice > 0 ? Math.round(((p.sellingPrice - p.costPrice) / p.sellingPrice) * 1000) / 10 : null;
  const uncounted = daysSince(p.lastCountedOn);
  return { daysLeft, state, margin, value: p.currentStock * p.costPrice, uncounted: uncounted === null || uncounted > COUNT_DAYS };
}
function stateTone(s) { return s === 'out' ? 'bad' : s === 'low' || s === 'soon' ? 'warn' : 'good'; }
function stateText(p, f) {
  if (f.state === 'out') return tr('Out of stock');
  if (f.state === 'low') return tr('Low: reorder at {n}', { n: n(p.reorderLevel) });
  if (f.state === 'soon') return f.daysLeft <= 1 ? tr('Runs out in about a day') : tr('Runs out in about {n} days', { n: f.daysLeft });
  return tr('In stock');
}

// 60 days of closing stock as a small line chart.
function StockLine({ lines, reorder }) {
  const pts = lines.slice().reverse();
  if (pts.length < 2) return <p className="dk-muted inv-small">{tr('Not enough days on the stock sheet to draw the last 60 days yet.')}</p>;
  const w = 600, h = 120, pad = 6;
  const max = Math.max(1, reorder || 0, ...pts.map((l) => l.closing));
  const x = (i) => pad + (i / (pts.length - 1)) * (w - pad * 2);
  const y = (v) => h - pad - (v / max) * (h - pad * 2);
  const d = pts.map((l, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(l.closing).toFixed(1)).join(' ');
  return (
    <figure className="inv-chart">
      <svg viewBox={'0 0 ' + w + ' ' + h} preserveAspectRatio="none" role="img"
        aria-label={tr('Stock from {from} to {to}: {a} to {b}', { from: fmtDate(pts[0].date), to: fmtDate(pts[pts.length - 1].date), a: n(pts[0].closing), b: n(pts[pts.length - 1].closing) })}>
        {reorder > 0 && <line className="inv-chart-reorder" x1={pad} x2={w - pad} y1={y(reorder)} y2={y(reorder)} />}
        <path className="inv-chart-area" d={d + ' L' + x(pts.length - 1).toFixed(1) + ' ' + (h - pad) + ' L' + pad + ' ' + (h - pad) + ' Z'} />
        <path className="inv-chart-line" d={d} />
      </svg>
      <figcaption className="dk-muted inv-small">
        <span>{fmtDate(pts[0].date)}</span>
        {reorder > 0 && <span className="inv-chart-key">{tr('dashed line: reorder level')}</span>}
        <span>{fmtDate(pts[pts.length - 1].date)}</span>
      </figcaption>
    </figure>
  );
}

export default function InventoryPage() {
  const { can } = useAuth();
  const canManage = can('inventory.manage');
  const navigate = useNavigate();

  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [chip, setChip] = useState('all');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState(() => readPref('bos.inventorySort', 'sheet'));
  const [view, setView] = useState(() => readPref('bos.inventoryView', 'cards'));

  const [detail, setDetail] = useState(null); // { id, history }
  const [dialog, setDialog] = useState(null); // { id? }
  const [form, setForm] = useState(EMPTY_FORM);
  const [adjust, setAdjust] = useState(null); // { p, mode, qty, reason }
  const [photoFor, setPhotoFor] = useState(null);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [driveOpen, setDriveOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try { setProducts(await api.get('/products')); } catch (err) { setError(err.message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // /inventory?import=workbook|drive (from the stock summary) opens the import.
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (params.get('import') && canManage) {
      if (params.get('import') === 'drive') setDriveOpen(true); else setImportOpen(true);
      setParams({}, { replace: true });
    }
  }, [params, setParams, canManage]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const categories = useMemo(() => Array.from(new Set(products.map((p) => p.category).filter(Boolean))).sort((a, b) => a.localeCompare(b)), [products]);
  const units = useMemo(() => Array.from(new Set(products.map((p) => p.unit).filter(Boolean))).sort(), [products]);

  // ── actions ──────────────────────────────────────────────────────────
  async function openDetail(p) {
    setFormError(null);
    setDetail({ id: p.id, history: null });
    try {
      const history = await api.get('/products/' + p.id + '/history');
      setDetail((cur) => (cur && cur.id === p.id ? { ...cur, history } : cur));
    } catch (err) { setDetail((cur) => (cur && cur.id === p.id ? { ...cur, history: { lines: [], production: [], error: err.message } } : cur)); }
  }
  function openNew() {
    setFormError(null);
    setForm({ ...EMPTY_FORM, category: category || '' });
    setDialog({});
  }
  function openEdit(p) {
    setFormError(null);
    setForm({ sku: p.sku, name: p.name, category: p.category, unit: p.unit, costPrice: p.costPrice || '', sellingPrice: p.sellingPrice || '', currentStock: p.currentStock, reorderLevel: p.reorderLevel || '', description: p.description || '' });
    setDialog({ id: p.id });
  }
  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const r = dialog.id ? await api.put('/products/' + dialog.id, form) : await api.post('/products', form);
      setToast(dialog.id ? tr('Product {sku} updated.', { sku: r.sku }) : tr('Product {sku} added.', { sku: r.sku }));
      setDialog(null);
      await load();
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  }
  function openAdjust(p, mode) {
    setFormError(null);
    setAdjust({ p, mode: mode || 'count', qty: '', reason: '' });
  }
  async function saveAdjust(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const r = await api.post('/products/' + adjust.p.id + '/stock', { mode: adjust.mode, qty: adjust.qty, reason: adjust.reason });
      setToast(tr('{name}: stock {from} → {to}. Recorded on today\'s stock sheet.', { name: r.name, from: n(r.stockBefore), to: n(r.currentStock) }));
      setAdjust(null);
      await load();
      if (detail && detail.id === r.id) openDetail(r);
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  }
  async function setArchived(p, archived) {
    try {
      await api.post('/products/' + p.id + '/archive', { archived });
      setToast(archived ? tr('{name} archived. It is off the stock sheet; its history is kept.', { name: p.name }) : tr('{name} is back on the stock sheet.', { name: p.name }));
      setDetail(null);
      await load();
    } catch (err) { setError(err.message); }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const active = products.filter((p) => p.active);
  const withFacts = products.map((p) => ({ p, f: facts(p) }));
  const live = withFacts.filter((x) => x.p.active);
  const out = live.filter((x) => x.f.state === 'out');
  const low = live.filter((x) => x.f.state === 'low');
  const soon = live.filter((x) => x.f.state === 'soon');
  const noPrice = live.filter((x) => !x.p.sellingPrice);
  const noCost = live.filter((x) => !x.p.costPrice);
  const noReorder = live.filter((x) => !x.p.reorderLevel);
  const uncounted = live.filter((x) => x.f.uncounted);
  const valueCost = live.reduce((s, x) => s + x.f.value, 0);
  const valueSell = live.reduce((s, x) => s + x.p.currentStock * x.p.sellingPrice, 0);
  const sold30 = live.reduce((s, x) => s + x.p.sold30, 0);
  const sold30Value = live.reduce((s, x) => s + x.p.sold30 * x.p.sellingPrice, 0);
  const catsInUse = new Set(active.map((p) => p.category));

  function showOnly(key) { setChip(chip === key ? 'all' : key); setCategory(''); jump('inv-list'); }

  const stats = [
    { icon: 'bag', value: n(active.length, 0), label: tr('products'), note: catsInUse.size === 1 ? tr('in 1 category') : tr('in {n} categories', { n: catsInUse.size }), onClick: () => { setChip('all'); setCategory(''); jump('inv-list'); } },
    { icon: 'cash', value: money(valueCost), label: tr('stock value at cost'), note: noCost.length ? (noCost.length === 1 ? tr('1 product has no cost price yet') : tr('{n} products have no cost price yet', { n: noCost.length })) : tr('{amount} at selling prices', { amount: money(valueSell) }), onClick: noCost.length ? () => showOnly('noprice') : undefined },
    { icon: 'warn', value: n(out.length, 0), label: tr('out of stock'), note: low.length ? (low.length === 1 ? tr('1 more at or below its reorder level') : tr('{n} more at or below their reorder level', { n: low.length })) : tr('none below its reorder level'), tone: out.length ? 'bad' : 'good', onClick: () => showOnly(out.length ? 'out' : 'low') },
    { icon: 'down', value: n(sold30, 0), label: tr('sold in the last 30 days'), note: sold30Value ? tr('worth {amount}', { amount: money(sold30Value) }) : tr('from the daily stock sheet'), onClick: () => { setSort('sold'); setChip('all'); jump('inv-list'); } }
  ];

  const insights = [];
  if (out.length) insights.push({ tone: 'bad', icon: 'warn', text: out.length === 1 ? tr('{name} is out of stock.', { name: out[0].p.name }) : tr('{n} products are out of stock, including {name}.', { n: out.length, name: out[0].p.name }), action: { label: out.length === 1 ? tr('Open it') : tr('Show them'), run: () => (out.length === 1 ? openDetail(out[0].p) : showOnly('out')) } });
  const nextOut = soon.concat(low).filter((x) => x.f.daysLeft !== null).sort((a, b) => a.f.daysLeft - b.f.daysLeft)[0];
  if (nextOut) insights.push({ tone: 'warn', icon: 'clock', text: tr('{name} will run out in about {d} days at the rate it has been selling ({sold} in 30 days).', { name: nextOut.p.name, d: Math.max(1, nextOut.f.daysLeft), sold: n(nextOut.p.sold30) + ' ' + nextOut.p.unit }), action: { label: tr('Open it'), run: () => openDetail(nextOut.p) } });
  else if (low.length) insights.push({ tone: 'warn', icon: 'down', text: low.length === 1 ? tr('{name} is at or below its reorder level.', { name: low[0].p.name }) : tr('{n} products are at or below their reorder level.', { n: low.length }), action: { label: tr('Show them'), run: () => showOnly('low') } });
  if (canManage && noReorder.length) insights.push({ tone: 'info', icon: 'info', text: noReorder.length === active.length ? tr('No product has a reorder level yet, so the OS cannot warn before stock runs low. Set one on the products that matter most.') : noReorder.length === 1 ? tr('{name} has no reorder level, so the OS cannot warn before it runs low.', { name: noReorder[0].p.name }) : tr('{n} products have no reorder level, so the OS cannot warn before they run low.', { n: noReorder.length }), action: { label: tr('Show them'), run: () => showOnly('noreorder') } });
  if (canManage && noPrice.length) insights.push({ tone: 'info', icon: 'cash', text: noPrice.length === 1 ? tr('{name} has no selling price, so the stock value and quotes leave it out.', { name: noPrice[0].p.name }) : tr('{n} products have no selling price, so the stock value and quotes leave them out.', { n: noPrice.length }), action: { label: tr('Show them'), run: () => showOnly('noprice') } });
  if (uncounted.length && uncounted.length < active.length) insights.push({ tone: 'info', icon: 'calendar', text: uncounted.length === 1 ? tr('{name} has not been counted in the last {d} days.', { name: uncounted[0].p.name, d: COUNT_DAYS }) : tr('{n} products have not been counted in the last {d} days.', { n: uncounted.length, d: COUNT_DAYS }), action: { label: tr('Show them'), run: () => showOnly('uncounted') } });
  if (!out.length && !low.length && !soon.length && active.length) insights.push({ tone: 'good', icon: 'check', text: tr('Nothing is out of stock or running low.') });

  const chipTest = {
    all: (x) => x.p.active,
    out: (x) => x.p.active && x.f.state === 'out',
    low: (x) => x.p.active && (x.f.state === 'low' || x.f.state === 'soon'),
    noprice: (x) => x.p.active && (!x.p.sellingPrice || !x.p.costPrice),
    noreorder: (x) => x.p.active && !x.p.reorderLevel,
    uncounted: (x) => x.p.active && x.f.uncounted,
    archived: (x) => !x.p.active
  };
  const sorters = {
    sheet: (a, b) => (a.p.sheetOrder ?? 1e9) - (b.p.sheetOrder ?? 1e9) || a.p.sku.localeCompare(b.p.sku),
    name: (a, b) => a.p.name.localeCompare(b.p.name),
    stock: (a, b) => a.p.currentStock - b.p.currentStock,
    sold: (a, b) => b.p.sold30 - a.p.sold30,
    value: (a, b) => b.f.value - a.f.value
  };
  const visible = withFacts
    .filter(chipTest[chip] || chipTest.all)
    .filter((x) => !category || x.p.category === category)
    .filter((x) => matchesQuery(search, x.p.sku, x.p.name, x.p.category, x.p.description))
    .sort(sorters[sort] || sorters.sheet);
  const chips = [
    ['all', tr('All'), active.length],
    ['out', tr('Out of stock'), out.length],
    ['low', tr('Low or running out'), low.length + soon.length],
    ['noprice', tr('Missing a price'), live.filter(chipTest.noprice).length],
    ['noreorder', tr('No reorder level'), noReorder.length],
    ['uncounted', tr('Not counted in {n} days', { n: COUNT_DAYS }), uncounted.length],
    ['archived', tr('Archived'), products.length - active.length]
  ].filter(([k, , c]) => c > 0 || k === 'all' || k === chip);

  function menu(p) {
    return [
      { label: tr('Open'), onClick: () => openDetail(p) },
      canManage && p.active && { label: tr('Record a count'), onClick: () => openAdjust(p, 'count') },
      canManage && p.active && { label: tr('Record received, sold or broken'), onClick: () => openAdjust(p, 'received') },
      canManage && { label: tr('Edit details'), onClick: () => openEdit(p) },
      canManage && { label: tr('Change photo'), onClick: () => setPhotoFor(p) },
      canManage && (p.active ? { label: tr('Archive'), onClick: () => setArchived(p, true), danger: true } : { label: tr('Bring back'), onClick: () => setArchived(p, false) })
    ].filter(Boolean);
  }

  const cur = detail ? products.find((p) => p.id === detail.id) : null;
  const curF = cur ? facts(cur) : null;
  const adjPreview = adjust && adjust.qty !== '' ? (() => {
    const q = Number(adjust.qty) || 0;
    const s = adjust.p.currentStock;
    return adjust.mode === 'count' ? q : adjust.mode === 'received' ? s + q : s - q;
  })() : null;
  const formMargin = Number(form.sellingPrice) > 0 && Number(form.costPrice) > 0 ? ((Number(form.sellingPrice) - Number(form.costPrice)) / Number(form.sellingPrice)) * 100 : null;

  return (
    <div className="dk inv">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={new Date().toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        title={tr('Products & inventory')}
        sub={tr('Every finished product, what is in stock and what it is worth. The stock follows the daily stock sheet: a count, a delivery, a sale or breakage recorded here goes onto today\'s sheet. Press a number to show only those.')}
        actions={(
          <>
            {canManage && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('Add product')}</button>}
            <button type="button" className="btn btn-secondary" onClick={() => navigate('/stocksheet')}>{tr('Daily stock sheet')}</button>
            {canManage && (
              <RowMenu label={tr('Import')} actions={[
                { label: tr('Import count sheet'), onClick: () => setImportOpen(true) },
                { label: tr('Import from Google Drive'), onClick: () => setDriveOpen(true) },
                { label: tr('Stock summary'), onClick: () => navigate('/stocksummary') }
              ]} />
            )}
          </>
        )}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      <Section id="inv-list" title={tr('Products')} sub={tr('Press a product for its stock history, or to record a count, a delivery, a sale or breakage.')}
        action={(
          <div className="ppl-view" role="radiogroup" aria-label={tr('View')}>
            {[['cards', tr('Cards')], ['list', tr('List')]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? 'is-on' : ''} onClick={() => { setView(k); writePref('bos.inventoryView', k); }}>{label}</button>
            ))}
          </div>
        )}>
        <div className="inv-tools">
          <div className="inv-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search products…')} /></div>
          <select className="input inv-select" value={category} onChange={(e) => setCategory(e.target.value)} aria-label={tr('Category')}>
            <option value="">{tr('All categories')}</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="input inv-select" value={sort} onChange={(e) => { setSort(e.target.value); writePref('bos.inventorySort', e.target.value); }} aria-label={tr('Sort')}>
            {SORTS.map((s) => <option key={s.key} value={s.key}>{tr(s.label)}</option>)}
          </select>
        </div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
        </div>

        {!visible.length ? (
          <div className="dk-empty inv-empty">
            <p>{products.length ? tr('Nothing matches. Try another search or filter.') : tr('No products in the catalogue yet')}</p>
            {(search || category || chip !== 'all') && products.length > 0 && <button type="button" className="btn btn-secondary" onClick={() => { setSearch(''); setCategory(''); setChip('all'); }}>{tr('Show all')}</button>}
            {canManage && !products.length && <button type="button" className="btn btn-primary" onClick={() => setImportOpen(true)}>{tr('Import count sheet')}</button>}
          </div>
        ) : view === 'cards' ? (
          <div className="inv-grid">
            {visible.map(({ p, f }) => (
              <article key={p.id} className={'inv-card st-' + f.state + (p.active ? '' : ' is-archived')}>
                <button type="button" className="inv-card-open" onClick={() => openDetail(p)}>
                  <Photo kind="product" id={p.id} name={p.name} photo={p.photo} size={52} />
                  <span className="inv-card-head">
                    <span className="inv-name">{p.name}</span>
                    <span className="dk-muted inv-small">{p.sku} · {p.category}</span>
                  </span>
                </button>
                <span className="inv-menu"><RowMenu actions={menu(p)} /></span>
                <div className="inv-stock">
                  <strong>{n(p.currentStock)}</strong> <span className="dk-muted">{p.unit}</span>
                </div>
                {p.reorderLevel > 0 && (
                  <span className={'inv-bar st-' + f.state} role="img" aria-label={tr('{stock} in stock, reorder at {level}', { stock: n(p.currentStock), level: n(p.reorderLevel) })}>
                    <span style={{ width: Math.min(100, (p.currentStock / (p.reorderLevel * 3)) * 100) + '%' }} />
                    <i style={{ left: '33.3%' }} />
                  </span>
                )}
                <div className="inv-card-tags">
                  {p.active ? <Status tone={stateTone(f.state)}>{stateText(p, f)}</Status> : <Status tone="muted">{tr('Archived')}</Status>}
                </div>
                <dl className="inv-facts">
                  <div><dt>{tr('Price')}</dt><dd>{p.sellingPrice ? money(p.sellingPrice) : <span className="dk-muted">{tr('not set')}</span>}</dd></div>
                  <div><dt>{tr('Sold, 30 days')}</dt><dd>{p.sold30 ? n(p.sold30) : '—'}{f.daysLeft !== null && f.state !== 'out' ? <span className="dk-muted"> · {tr('~{n} days left', { n: f.daysLeft })}</span> : null}</dd></div>
                </dl>
              </article>
            ))}
          </div>
        ) : (
          <div className="inv-table-wrap">
            <table className="inv-table">
              <thead>
                <tr><th>{tr('Product')}</th><th className="is-num">{tr('Stock')}</th><th className="is-num">{tr('Reorder at')}</th><th className="is-num">{tr('Price')}</th><th className="is-num">{tr('Sold, 30 days')}</th><th>{tr('Status')}</th><th /></tr>
              </thead>
              <tbody>
                {visible.map(({ p, f }) => (
                  <tr key={p.id} className={'st-' + f.state + (p.active ? '' : ' is-archived')}>
                    <td>
                      <button type="button" className="inv-row-open" onClick={() => openDetail(p)}>
                        <Photo kind="product" id={p.id} name={p.name} photo={p.photo} size={34} />
                        <span><span className="inv-name">{p.name}</span><span className="dk-muted inv-small">{p.sku} · {p.category}</span></span>
                      </button>
                    </td>
                    <td className="is-num"><strong>{n(p.currentStock)}</strong> <span className="dk-muted">{p.unit}</span></td>
                    <td className="is-num">{p.reorderLevel ? n(p.reorderLevel) : '—'}</td>
                    <td className="is-num">{p.sellingPrice ? money(p.sellingPrice) : '—'}</td>
                    <td className="is-num">{p.sold30 ? n(p.sold30) : '—'}</td>
                    <td>{p.active ? <Status tone={stateTone(f.state)}>{stateText(p, f)}</Status> : <Status tone="muted">{tr('Archived')}</Status>}</td>
                    <td className="inv-menu-cell"><RowMenu actions={menu(p)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Glossary items={[
        [tr('Stock'), tr('What is on the shelf now. It follows the daily stock sheet: each day opens at the day before\'s closing, adds what was received and takes off what was sold, moved or broken; a count replaces the expected figure.')],
        [tr('Reorder level'), tr('When the stock falls to this, the product shows as low and the morning summary mentions it. 0 means no warning.')],
        [tr('Runs out in about'), tr('The stock divided by the average sold per day over the last 30 days.')],
        [tr('Stock value at cost'), tr('Stock times cost price, for products that have one.')],
        [tr('Margin'), tr('Selling price minus cost price, as a share of the selling price.')],
        [tr('Archived'), tr('No longer made or sold. Off this page and the daily stock sheet; its history is kept and it can be brought back.')]
      ]} />

      {/* ── one product ── */}
      {cur && (
        <div className="dialog-backdrop" onClick={() => setDetail(null)}>
          <div className="dialog inv-dialog inv-detail" onClick={(e) => e.stopPropagation()}>
            <div className="inv-detail-head">
              {canManage ? (
                <button type="button" className="inv-photo-btn" onClick={() => setPhotoFor(cur)} aria-label={tr('Change photo')}>
                  <Photo kind="product" id={cur.id} name={cur.name} photo={cur.photo} size={72} />
                </button>
              ) : <Photo kind="product" id={cur.id} name={cur.name} photo={cur.photo} size={72} />}
              <div>
                <h2>{cur.name}</h2>
                <span className="dk-muted">{cur.sku} · {cur.category} · {tr('sold by the {unit}', { unit: cur.unit })}</span>
                <span>{cur.active ? <Status tone={stateTone(curF.state)}>{stateText(cur, curF)}</Status> : <Status tone="muted">{tr('Archived')}</Status>}</span>
              </div>
              <button type="button" className="inv-close" onClick={() => setDetail(null)} aria-label={tr('Close')}>×</button>
            </div>
            {cur.description && <p className="inv-desc">{cur.description}</p>}
            <dl className="inv-facts inv-facts-wide">
              <div><dt>{tr('In stock')}</dt><dd><strong>{n(cur.currentStock)}</strong> {cur.unit}</dd></div>
              <div><dt>{tr('Reorder level')}</dt><dd>{cur.reorderLevel ? n(cur.reorderLevel) : tr('not set')}</dd></div>
              <div><dt>{tr('Selling price')}</dt><dd>{cur.sellingPrice ? money(cur.sellingPrice) : tr('not set')}</dd></div>
              <div><dt>{tr('Cost price')}</dt><dd>{cur.costPrice ? money(cur.costPrice) : tr('not set')}{curF.margin !== null ? <span className="dk-muted"> · {tr('{pct}% margin', { pct: n(curF.margin) })}</span> : null}</dd></div>
              <div><dt>{tr('Stock value at cost')}</dt><dd>{cur.costPrice ? money(curF.value) : '—'}</dd></div>
              <div><dt>{tr('Last 30 days')}</dt><dd>{tr('{sold} sold · {received} received', { sold: n(cur.sold30), received: n(cur.received30) })}{cur.breakage30 ? ' · ' + tr('{n} broken', { n: n(cur.breakage30) }) : ''}{cur.made30 ? ' · ' + tr('{n} made', { n: n(cur.made30) }) : ''}</dd></div>
              <div><dt>{tr('Runs out in about')}</dt><dd>{curF.daysLeft === null ? tr('no sales in 30 days') : curF.daysLeft <= 1 ? tr('a day') : tr('{n} days', { n: curF.daysLeft })}</dd></div>
              <div><dt>{tr('Last counted')}</dt><dd>{cur.lastCountedOn ? fmtDate(cur.lastCountedOn) : tr('never')}</dd></div>
            </dl>

            <h3 className="inv-h3">{tr('Last 60 days')}</h3>
            {!detail.history ? <p className="dk-muted inv-small">{tr('Loading…')}</p> : (
              <>
                {detail.history.error && <div className="error-banner">{detail.history.error}</div>}
                <StockLine lines={detail.history.lines} reorder={cur.reorderLevel} />
                {detail.history.lines.length > 0 && (
                  <div className="inv-table-wrap">
                    <table className="inv-table inv-history">
                      <thead><tr><th>{tr('Day')}</th><th className="is-num">{tr('In')}</th><th className="is-num">{tr('Out')}</th><th className="is-num">{tr('Counted')}</th><th className="is-num">{tr('Closing')}</th><th>{tr('Note')}</th></tr></thead>
                      <tbody>
                        {detail.history.lines.slice(0, 12).map((l) => (
                          <tr key={l.date}>
                            <td>{fmtDate(l.date)}</td>
                            <td className="is-num">{l.received ? '+' + n(l.received) : ''}</td>
                            <td className="is-num">{l.sold + l.breakage + l.transferred ? '−' + n(l.sold + l.breakage + l.transferred) : ''}</td>
                            <td className="is-num">{l.physical === null ? '' : n(l.physical)}{l.variance ? <span className={'inv-var' + (l.variance > 0 ? ' is-short' : '')}> ({l.variance > 0 ? '−' : '+'}{n(Math.abs(l.variance))})</span> : null}</td>
                            <td className="is-num"><strong>{n(l.closing)}</strong></td>
                            <td className="dk-muted inv-note">{[l.note, l.by].filter(Boolean).join(' · ')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {detail.history.production.length > 0 && (
                  <p className="dk-muted inv-small">
                    {tr('Made recently:')} {detail.history.production.slice(0, 5).map((b) => fmtDate(b.date) + ' ' + n(b.qty) + ' (' + b.batchNo + ')').join(' · ')}
                  </p>
                )}
              </>
            )}
            <div className="dialog-actions inv-actions">
              {canManage && (cur.active
                ? <button type="button" className="btn btn-secondary" onClick={() => setArchived(cur, true)}>{tr('Archive')}</button>
                : <button type="button" className="btn btn-secondary" onClick={() => setArchived(cur, false)}>{tr('Bring back')}</button>)}
              {canManage && <button type="button" className="btn btn-secondary" onClick={() => { setDetail(null); openEdit(cur); }}>{tr('Edit details')}</button>}
              {canManage && cur.active && <button type="button" className="btn btn-primary" onClick={() => openAdjust(cur, 'count')}>{tr('Record stock')}</button>}
              {!canManage && <button type="button" className="btn btn-primary" onClick={() => setDetail(null)}>{tr('Close')}</button>}
            </div>
          </div>
        </div>
      )}

      {/* ── record a count, a delivery, a sale or breakage ── */}
      {adjust && (
        <div className="dialog-backdrop inv-over" onClick={() => !saving && setAdjust(null)}>
          <form className="dialog inv-dialog" onClick={(e) => e.stopPropagation()} onSubmit={saveAdjust}>
            <h2>{tr('Record stock: {name}', { name: adjust.p.name })}</h2>
            <p className="dk-muted inv-small">{tr('{n} {unit} in stock now. This goes onto today\'s line of the daily stock sheet.', { n: n(adjust.p.currentStock), unit: adjust.p.unit })}</p>
            <div className="inv-modes" role="radiogroup" aria-label={tr('What happened?')}>
              {MODES.map((m) => (
                <button key={m.key} type="button" role="radio" aria-checked={adjust.mode === m.key} className={'inv-mode is-' + m.key + (adjust.mode === m.key ? ' is-on' : '')} onClick={() => setAdjust({ ...adjust, mode: m.key })}>
                  <strong>{tr(m.label)}</strong><span>{tr(m.note)}</span>
                </button>
              ))}
            </div>
            <div className="inv-form">
              <div className="field">
                <label htmlFor="adj-qty">{adjust.mode === 'count' ? tr('How many are there?') : tr('How many?')} ({adjust.p.unit})</label>
                <input id="adj-qty" className="input" type="number" min="0" step="any" value={adjust.qty} onChange={(e) => setAdjust({ ...adjust, qty: e.target.value })} required autoFocus />
              </div>
              <div className="field">
                <label htmlFor="adj-reason">{tr('Note (optional)')}</label>
                <input id="adj-reason" className="input" maxLength={200} value={adjust.reason} onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })} placeholder={adjust.mode === 'sold' ? tr('e.g. Invoice 1043') : adjust.mode === 'breakage' ? tr('e.g. Dropped in the store') : tr('e.g. Monthly count')} />
              </div>
            </div>
            {adjPreview !== null && (
              <div className={'inv-preview' + (adjPreview < 0 ? ' is-bad' : '')}>
                {adjPreview < 0 ? tr('Only {n} are in stock.', { n: n(adjust.p.currentStock) }) : tr('Stock {from} → {to} {unit}', { from: n(adjust.p.currentStock), to: n(adjPreview), unit: adjust.p.unit })}
              </div>
            )}
            {formError && <div className="error-banner">{formError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setAdjust(null)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving || (adjPreview !== null && adjPreview < 0)}>{saving ? tr('Saving…') : tr('Record')}</button>
            </div>
          </form>
        </div>
      )}

      {/* ── add / edit ── */}
      {dialog && (
        <div className="dialog-backdrop" onClick={() => !saving && setDialog(null)}>
          <form className="dialog inv-dialog" onClick={(e) => e.stopPropagation()} onSubmit={save}>
            <h2>{dialog.id ? tr('Edit product') : tr('Add product')}</h2>
            <div className="inv-form">
              <div className="field inv-span">
                <label htmlFor="prod-name">{tr('Name')}</label>
                <input id="prod-name" className="input" value={form.name} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
              </div>
              <div className="field">
                <label htmlFor="prod-sku">SKU</label>
                <input id="prod-sku" className="input" value={form.sku} maxLength={30} onChange={(e) => setForm({ ...form, sku: e.target.value.toUpperCase() })} required />
              </div>
              <div className="field">
                <label htmlFor="prod-category">{tr('Category')}</label>
                <input id="prod-category" className="input" list="prod-categories" value={form.category} maxLength={40} onChange={(e) => setForm({ ...form, category: e.target.value })} required />
                <datalist id="prod-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
              </div>
              <div className="field">
                <label htmlFor="prod-unit">{tr('Unit')}</label>
                <input id="prod-unit" className="input" list="prod-units" value={form.unit} maxLength={20} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder={tr('piece, plank, pack')} />
                <datalist id="prod-units">{units.map((u) => <option key={u} value={u} />)}</datalist>
              </div>
              <div className="field">
                <label htmlFor="prod-reorder">{tr('Reorder level')}</label>
                <input id="prod-reorder" className="input" type="number" min="0" step="any" value={form.reorderLevel} onChange={(e) => setForm({ ...form, reorderLevel: e.target.value })} />
                <span className="dk-muted inv-small">{tr('Shows as low at or below this. Leave 0 for no warning.')}</span>
              </div>
              <div className="field">
                <label htmlFor="prod-cost">{tr('Cost price')}</label>
                <input id="prod-cost" className="input" type="number" min="0" step="any" value={form.costPrice} onChange={(e) => setForm({ ...form, costPrice: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="prod-price">{tr('Selling price')}</label>
                <input id="prod-price" className="input" type="number" min="0" step="any" value={form.sellingPrice} onChange={(e) => setForm({ ...form, sellingPrice: e.target.value })} />
                {formMargin !== null && <span className={'inv-small ' + (formMargin < 0 ? 'inv-bad' : 'dk-muted')}>{tr('{pct}% margin', { pct: n(formMargin) })}</span>}
              </div>
              {!dialog.id && (
                <div className="field">
                  <label htmlFor="prod-stock">{tr('Opening stock')}</label>
                  <input id="prod-stock" className="input" type="number" min="0" step="any" value={form.currentStock} onChange={(e) => setForm({ ...form, currentStock: e.target.value })} />
                </div>
              )}
              <div className="field inv-span">
                <label htmlFor="prod-desc">{tr('Description (optional)')}</label>
                <textarea id="prod-desc" className="input inv-textarea" maxLength={1000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder={tr('Size, finish, what it is used for…')} />
              </div>
            </div>
            {dialog.id && <p className="dk-muted inv-small">{tr('To change the stock, use "Record stock" on the product: it goes onto the daily stock sheet.')}</p>}
            {formError && <div className="error-banner">{formError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : dialog.id ? tr('Save changes') : tr('Add product')}</button>
            </div>
          </form>
        </div>
      )}

      {photoFor && (
        <div className="inv-over-wrap">
          <PhotoDialog title={tr('Photo of {name}', { name: photoFor.name })} kind="product" id={photoFor.id} name={photoFor.name} photo={photoFor.photo}
            uploadPath={'/products/' + photoFor.id + '/photo'} note={tr('The photo is cropped to a square. Everyone who can see the stock sees it.')}
            onDone={(v) => { setPhotoFor({ ...photoFor, photo: v }); load(); }}
            onClose={() => setPhotoFor(null)} />
        </div>
      )}

      {importOpen && <CountImportDialog onClose={() => setImportOpen(false)} onImported={(m) => { setToast(m); load(); }} onDrive={() => { setImportOpen(false); setDriveOpen(true); }} />}
      {driveOpen && <DriveImportDialog onClose={() => setDriveOpen(false)} onImported={() => { setToast(tr('Workbook imported from Google Drive.')); load(); }} />}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
