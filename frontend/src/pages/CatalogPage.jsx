import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import RowMenu from '../components/RowMenu';
import { Glossary, Hero, Insights, RankList, Section, Status, avatarColor, fmtDate, jump } from '../components/DashKit';
import { money, moneyBreakdown } from '../lib/currency';
import { tr } from '../lib/i18n.jsx';
import './EmployeesPage.css';
import './ToolRoomPage.css';
import './RestaurantsPage.css';
import './PokiRentals.css';
import './CustomersPage.css';
import './EstimatesPage.css';
import './CatalogPage.css';

// Products & Services — what Bamboo Products sells, at what price and
// margin, and what actually sold. Same "explains itself" layout as the
// dashboards (components/DashKit.jsx): what is on sale, what sold over the
// last twelve months, the average margin, what never sold, what stands out
// (priced below cost, no price, no cost price, sold but out of stock), the
// best sellers, and the items as cards or a list with a window for each
// one listing its variations (catalog.service.js listItems: each
// variation's sales on Bamboo Products' invoices, matched by the product
// code kept on each document line, or by name for older lines).
//
// Square's catalogue shape (migration 0027): an item has one or more
// variations, each a priced, sellable row with its own code and stock.
// Stock only changes through "Adjust stock", so every change is audited.
// Tax rates come from /commercial-settings, which needs settings.manage;
// without it the tax picker is left out rather than shown empty.

function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function BoxIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3.5 20 8 12 12.5 4 8 12 3.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M4 8v8l8 4.5 8-4.5V8" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M12 12.5V21" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
function Mark({ item, size = 44 }) {
  return <span className="pk-avatar cu-mark ct-mark" style={{ width: size, height: size, background: avatarColor(item.categoryId ? item.categoryName : item.name) }} aria-hidden="true"><BoxIcon /></span>;
}
function margin(v) { return v.unitPrice > 0 && v.costPrice > 0 ? Math.round(((v.unitPrice - v.costPrice) / v.unitPrice) * 100) : null; }
function belowCost(v) { return v.costPrice > 0 && v.unitPrice < v.costPrice; }
function ghsSold(v) { return (v.sold.amounts.find((a) => a.currency === 'GHS') || { amount: 0 }).amount; }
function sumSold(vs) {
  const m = {};
  vs.forEach((v) => v.sold.amounts.forEach((a) => { m[a.currency] = (m[a.currency] || 0) + a.amount; }));
  return Object.entries(m).map(([currency, amount]) => ({ currency, amount }));
}
function priceRange(item) {
  const ps = item.variations.filter((v) => v.active || !item.active).map((v) => v.unitPrice);
  if (!ps.length) return '—';
  const lo = Math.min(...ps), hi = Math.max(...ps);
  return lo === hi ? money(lo) : money(lo) + ' – ' + money(hi);
}
const EMPTY_ITEM_FORM = {
  name: '', description: '', categoryId: '', taxRateId: '',
  variationName: '', code: '', unit: '', defaultQty: '', unitPrice: '', costPrice: '', stockQty: ''
};
const EMPTY_VARIATION_FORM = { name: '', code: '', unit: '', defaultQty: '', unitPrice: '', costPrice: '', stockQty: '' };
// The name the document pickers show: the item, plus the variation unless it is just "Regular".
function fullName(v, item) { return v.name && v.name !== 'Regular' ? item.name + ' — ' + v.name : item.name; }
function varLabel(v) { return v.name && v.name !== 'Regular' ? v.name : tr('Regular'); }

export default function CatalogPage() {
  const { can } = useAuth();
  const canManage = can('catalog.manage');
  const canSeeTaxRates = can('settings.manage');

  const [items, setItems] = useState([]);
  const [categories, setCategories] = useState([]);
  const [taxRates, setTaxRates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [chip, setChip] = useState('onsale');
  const [category, setCategory] = useState('');
  const [view, setView] = useState(() => readPref('bos.catalogView', 'cards'));
  const [detail, setDetail] = useState(null);
  const [search, setSearch] = useState('');

  const [itemDialogOpen, setItemDialogOpen] = useState(false);
  const [editItemId, setEditItemId] = useState(null);
  const [itemForm, setItemForm] = useState(EMPTY_ITEM_FORM);
  const [itemDialogError, setItemDialogError] = useState(null);
  const [savingItem, setSavingItem] = useState(false);

  const [varDialog, setVarDialog] = useState(null); // { itemId, editId, form }
  const [varDialogError, setVarDialogError] = useState(null);
  const [savingVar, setSavingVar] = useState(false);

  const [newCategoryName, setNewCategoryName] = useState('');
  const [addingCategory, setAddingCategory] = useState(false);

  const [deleteItemTarget, setDeleteItemTarget] = useState(null);
  const [deleteVarTarget, setDeleteVarTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const [stockDialog, setStockDialog] = useState(null); // { variationId, name, stockQty, delta, note }
  const [stockDialogError, setStockDialogError] = useState(null);
  const [savingStock, setSavingStock] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [itemsRes, categoriesRes] = await Promise.all([api.get('/catalog/items'), api.get('/catalog/categories')]);
      setItems(itemsRes);
      setCategories(categoriesRes);
      if (canSeeTaxRates) {
        const settings = await api.get('/commercial-settings');
        setTaxRates(settings.taxRates || []);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [canSeeTaxRates]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  function openNewItem() {
    setItemDialogError(null);
    setEditItemId(null);
    setItemForm(EMPTY_ITEM_FORM);
    setItemDialogOpen(true);
  }

  function openEditItem(item) {
    setItemDialogError(null);
    setEditItemId(item.id);
    setItemForm({
      ...EMPTY_ITEM_FORM, name: item.name, description: item.description === '—' ? '' : item.description,
      categoryId: item.categoryId || '', taxRateId: item.taxRateId || ''
    });
    setItemDialogOpen(true);
  }

  async function handleItemSubmit(e) {
    e.preventDefault();
    setSavingItem(true);
    setItemDialogError(null);
    try {
      const payload = { name: itemForm.name, description: itemForm.description, categoryId: itemForm.categoryId || undefined, taxRateId: itemForm.taxRateId || undefined };
      if (editItemId) {
        await api.put('/catalog/items/' + editItemId, payload);
        setToast(tr('Item updated.'));
      } else {
        await api.post('/catalog/items', {
          ...payload, name: itemForm.name,
          variationName: itemForm.variationName, code: itemForm.code, unit: itemForm.unit,
          defaultQty: itemForm.defaultQty, unitPrice: itemForm.unitPrice, costPrice: itemForm.costPrice, stockQty: itemForm.stockQty
        });
        setToast(tr('Item added.'));
      }
      setItemDialogOpen(false);
      await load();
    } catch (err) {
      setItemDialogError(err.message);
    } finally {
      setSavingItem(false);
    }
  }

  async function toggleItemActive(item) {
    setBusyId(item.id);
    setError(null);
    try {
      await api.post('/catalog/items/' + item.id + '/active', { active: !item.active });
      setToast(item.active ? tr('{name} archived.', { name: item.name }) : tr('{name} unarchived.', { name: item.name }));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDeleteItem() {
    setDeleting(true);
    try {
      await api.del('/catalog/items/' + deleteItemTarget.id);
      setToast(tr('{name} deleted.', { name: deleteItemTarget.name }));
      setDeleteItemTarget(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  function openNewVariation(itemId) {
    setVarDialogError(null);
    setVarDialog({ itemId, editId: null, form: EMPTY_VARIATION_FORM });
  }
  function openEditVariation(itemId, v) {
    setVarDialogError(null);
    setVarDialog({ itemId, editId: v.id, form: { name: v.name, code: v.code, unit: v.unit, defaultQty: v.defaultQty, unitPrice: v.unitPrice, costPrice: v.costPrice } });
  }

  async function handleVariationSubmit(e) {
    e.preventDefault();
    setSavingVar(true);
    setVarDialogError(null);
    try {
      if (varDialog.editId) await api.put('/catalog/variations/' + varDialog.editId, varDialog.form);
      else await api.post('/catalog/items/' + varDialog.itemId + '/variations', varDialog.form);
      setToast(varDialog.editId ? tr('Variation updated.') : tr('Variation added.'));
      setVarDialog(null);
      await load();
    } catch (err) {
      setVarDialogError(err.message);
    } finally {
      setSavingVar(false);
    }
  }

  async function toggleVariationActive(v) {
    setBusyId(v.id);
    setError(null);
    try {
      await api.post('/catalog/variations/' + v.id + '/active', { active: !v.active });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  function openStockDialog(v) {
    setStockDialogError(null);
    setStockDialog({ variationId: v.id, name: v.name, stockQty: v.stockQty, delta: '', note: '' });
  }

  async function submitStockAdjust(e) {
    e.preventDefault();
    setSavingStock(true);
    setStockDialogError(null);
    try {
      await api.post('/catalog/variations/' + stockDialog.variationId + '/stock', { delta: stockDialog.delta, note: stockDialog.note });
      setToast(tr('Stock updated.'));
      setStockDialog(null);
      await load();
    } catch (err) {
      setStockDialogError(err.message);
    } finally {
      setSavingStock(false);
    }
  }

  async function confirmDeleteVariation() {
    setDeleting(true);
    try {
      await api.del('/catalog/variations/' + deleteVarTarget.id);
      setToast(tr('{name} deleted.', { name: deleteVarTarget.name }));
      setDeleteVarTarget(null);
      await load();
    } catch (err) {
      setError(err.message);
      setDeleteVarTarget(null);
    } finally {
      setDeleting(false);
    }
  }

  async function submitNewCategory(e) {
    e.preventDefault();
    if (!newCategoryName.trim()) return;
    setAddingCategory(true);
    try {
      const created = await api.post('/catalog/categories', { name: newCategoryName.trim() });
      setCategories(categories.concat([created]).sort((a, b) => a.name.localeCompare(b.name)));
      setItemForm({ ...itemForm, categoryId: created.id });
      setNewCategoryName('');
    } catch (err) {
      setError(err.message);
    } finally {
      setAddingCategory(false);
    }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const onSaleItems = items.filter((it) => it.active);
  const liveVars = onSaleItems.flatMap((it) => it.variations.filter((v) => v.active).map((v) => ({ ...v, item: it })));
  const sold = liveVars.filter((v) => v.sold.qty > 0);
  const unsold = liveVars.filter((v) => v.sold.qty === 0);
  const below = liveVars.filter(belowCost);
  const noPrice = liveVars.filter((v) => !(v.unitPrice > 0));
  const noCost = liveVars.filter((v) => v.unitPrice > 0 && !(v.costPrice > 0));
  const soldOut = liveVars.filter((v) => v.sold.qty > 0 && v.stockQty <= 0 && v.item.variations.some((x) => x.stockQty > 0 || x.sold.qty > 0));
  const margins = liveVars.map(margin).filter((m) => m !== null);
  const avgMargin = margins.length ? Math.round(margins.reduce((a, b) => a + b, 0) / margins.length) : null;
  const best = sold.slice().sort((a, b) => ghsSold(b) - ghsSold(a));
  const catCount = new Set(onSaleItems.map((it) => it.categoryId || '')).size;
  const itemIds = (list) => new Set(list.map((v) => v.item.id));

  function showOnly(key) { setCategory(''); setChip(chip === key ? 'onsale' : key); jump('ct-list'); }
  const stats = [
    { icon: 'bag', value: String(liveVars.length), label: tr('products and services on sale'), note: catCount > 1 ? tr('{n} items in {c} categories', { n: onSaleItems.length, c: catCount }) : onSaleItems.length === 1 ? tr('1 item') : tr('{n} items', { n: onSaleItems.length }), onClick: () => showOnly('onsale') },
    { icon: 'cash', value: moneyBreakdown(sumSold(liveVars), money(0)), label: tr('sold in the last 12 months'), note: best.length ? tr('most from {name}', { name: fullName(best[0], best[0].item) }) : tr('nothing sold from the catalogue yet'), tone: sold.length ? 'good' : '', onClick: () => showOnly('selling') },
    { icon: 'percent', value: avgMargin === null ? '—' : avgMargin + '%', label: tr('average margin'), note: noCost.length ? (noCost.length === 1 ? tr('1 has no cost price, so no margin') : tr('{n} have no cost price, so no margin', { n: noCost.length })) : tr('across everything with a cost price'), tone: avgMargin !== null && avgMargin < 15 ? 'warn' : '', onClick: () => showOnly(noCost.length ? 'nocost' : 'onsale') },
    { icon: 'clock', value: String(unsold.length), label: tr('not sold in 12 months'), note: tr('of {n} on sale', { n: liveVars.length }), tone: unsold.length > liveVars.length / 2 ? 'warn' : '', onClick: () => showOnly('unsold') }
  ];

  const insights = [];
  if (below.length) insights.push({ tone: 'bad', icon: 'down', text: below.length === 1 ? tr('{name} sells for {price} but costs {cost}.', { name: fullName(below[0], below[0].item), price: money(below[0].unitPrice), cost: money(below[0].costPrice) }) : tr('{n} products sell for less than they cost.', { n: below.length }), action: { label: tr('Show them'), run: () => showOnly('below') } });
  if (noPrice.length) insights.push({ tone: 'warn', icon: 'warn', text: noPrice.length === 1 ? tr('{name} has no price, so it goes on quotations at zero.', { name: fullName(noPrice[0], noPrice[0].item) }) : tr('{n} products on sale have no price, so they go on quotations at zero.', { n: noPrice.length }), action: { label: tr('Show them'), run: () => showOnly('noprice') } });
  if (soldOut.length) insights.push({ tone: 'warn', icon: 'bag', text: soldOut.length === 1 ? tr('{name} sold recently and has none in stock.', { name: fullName(soldOut[0], soldOut[0].item) }) : tr('{n} products sold recently and have none in stock.', { n: soldOut.length }), action: { label: tr('Show them'), run: () => showOnly('soldout') } });
  if (noCost.length) insights.push({ tone: 'info', icon: 'percent', text: noCost.length === 1 ? tr('{name} has no cost price, so its margin is unknown.', { name: fullName(noCost[0], noCost[0].item) }) : tr('{n} products have no cost price, so their margin is unknown.', { n: noCost.length }), action: { label: tr('Show them'), run: () => showOnly('nocost') } });
  if (best.length) insights.push({ tone: 'good', icon: 'up', text: tr('{name} sold the most over the last 12 months: {amount}.', { name: fullName(best[0], best[0].item), amount: moneyBreakdown(best[0].sold.amounts) }), action: { label: tr('Open'), run: () => setDetail(best[0].item.id) } });

  const chipItems = {
    onsale: onSaleItems, selling: [...itemIds(sold)], unsold: [...itemIds(unsold)], below: [...itemIds(below)], noprice: [...itemIds(noPrice)],
    nocost: [...itemIds(noCost)], soldout: [...itemIds(soldOut)], archived: items.filter((it) => !it.active), all: items
  };
  const inChip = (it) => { const l = chipItems[chip] || chipItems.onsale; return l.length && typeof l[0] === 'string' ? l.includes(it.id) : l.includes(it); };
  const visible = items.filter(inChip)
    .filter((it) => !category || (it.categoryId || 'none') === category)
    .filter((it) => matchesQuery(search, it.name, it.description, it.categoryName) || it.variations.some((v) => matchesQuery(search, v.name, v.code)));
  const chips = [
    ['onsale', tr('On sale'), onSaleItems.length], ['selling', tr('Selling'), itemIds(sold).size], ['unsold', tr('Not sold in 12 months'), itemIds(unsold).size],
    ['below', tr('Below cost'), itemIds(below).size], ['noprice', tr('No price'), itemIds(noPrice).size], ['nocost', tr('No cost price'), itemIds(noCost).size],
    ['soldout', tr('Sold out'), itemIds(soldOut).size], ['archived', tr('Archived'), items.filter((it) => !it.active).length], ['all', tr('All'), items.length]
  ].filter(([k, , c]) => c > 0 || k === 'onsale' || k === chip);

  function stateOf(it) {
    if (!it.active) return { tone: 'muted', text: tr('Archived') };
    const live = it.variations.filter((v) => v.active);
    if (live.some(belowCost)) return { tone: 'bad', text: tr('Below cost') };
    if (live.some((v) => !(v.unitPrice > 0))) return { tone: 'warn', text: tr('No price') };
    const q = live.reduce((s, v) => s + v.sold.qty, 0);
    if (q > 0) return { tone: 'good', text: tr('{n} sold in 12 months', { n: q.toLocaleString() }) };
    return { tone: 'muted', text: tr('Not sold in 12 months') };
  }
  function itemActions(it) {
    return [
      { label: tr('Open'), onClick: () => setDetail(it.id) },
      canManage && { label: tr('Edit'), onClick: () => openEditItem(it) },
      canManage && { label: tr('Add variation'), onClick: () => openNewVariation(it.id) },
      canManage && { label: it.active ? tr('Archive') : tr('Unarchive'), onClick: () => toggleItemActive(it), disabled: busyId === it.id },
      canManage && { label: tr('Delete'), onClick: () => setDeleteItemTarget(it), danger: true }
    ].filter(Boolean);
  }
  function varActions(it, v) {
    return [
      canManage && { label: tr('Adjust stock'), onClick: () => openStockDialog(v) },
      canManage && { label: tr('Edit'), onClick: () => openEditVariation(it.id, v) },
      canManage && { label: v.active ? tr('Archive') : tr('Unarchive'), onClick: () => toggleVariationActive(v), disabled: busyId === v.id },
      canManage && it.variations.length > 1 && { label: tr('Delete'), onClick: () => setDeleteVarTarget(v), danger: true }
    ].filter(Boolean);
  }
  const cur = detail ? items.find((it) => it.id === detail) : null;
  const catChoices = [...new Map(items.map((it) => [it.categoryId || 'none', it.categoryId ? it.categoryName : tr('No category')])).entries()].sort((a, b) => a[1].localeCompare(b[1]));

  return (
    <div className="dk tl pk cu ct">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('Quotations & Invoicing')}
        title={tr('Products & Services')}
        sub={tr('What Bamboo Products sells, at what price and margin, and what actually sold. Quotations, estimates and invoices pick their lines from here. Press a number to show only those.')}
        actions={(
          <>
            {canManage && <button type="button" className="btn btn-primary" onClick={openNewItem}>{tr('Add item')}</button>}
            <Link className="btn btn-secondary" to="/quotations">{tr('Quotations')}</Link>
          </>
        )}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      {best.length > 0 && (
        <Section id="ct-best" title={tr('Best sellers, last 12 months')} sub={tr('Ranked by what was invoiced in cedis; voided invoices left out.')} card>
          <RankList rows={best.slice(0, 8).map((v) => ({ key: v.id, name: fullName(v, v.item), amount: moneyBreakdown(v.sold.amounts) + ' · ' + tr('{n} sold', { n: v.sold.qty.toLocaleString() }), value: ghsSold(v) }))} />
        </Section>
      )}

      <Section id="ct-list" title={tr('Items')} sub={tr('Press an item to see its variations, prices, stock and sales.')}
        action={(
          <div className="ppl-view" role="radiogroup" aria-label={tr('View')}>
            {[['cards', tr('Cards')], ['list', tr('List')]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? 'is-on' : ''} onClick={() => { setView(k); writePref('bos.catalogView', k); }}>{label}</button>
            ))}
          </div>
        )}>
        <div className="tl-tools">
          <div className="tl-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search items, categories, variations…')} /></div>
          {catChoices.length > 1 && (
            <select className="input ct-cat" value={category} onChange={(e) => setCategory(e.target.value)} aria-label={tr('Category')}>
              <option value="">{tr('All categories')}</option>
              {catChoices.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          )}
        </div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
        </div>
        {!visible.length ? (
          <div className="dk-empty tl-empty">
            <p>{items.length ? tr('Nothing matches. Try another search or filter.') : tr('No catalogue items yet')}</p>
            {canManage && !items.length && <button type="button" className="btn btn-primary" onClick={openNewItem}>{tr('Add item')}</button>}
          </div>
        ) : view === 'cards' ? (
          <div className="tl-grid">
            {visible.map((it) => {
              const st = stateOf(it);
              const live = it.variations.filter((v) => v.active || !it.active);
              const ms = live.map(margin).filter((m) => m !== null);
              const stock = live.reduce((s, v) => s + v.stockQty, 0);
              return (
                <article key={it.id} className={'tl-card' + (st.tone === 'bad' ? ' st-late' : '') + (!it.active ? ' st-retired' : '')}>
                  <button type="button" className="tl-card-open" onClick={() => setDetail(it.id)}>
                    <Mark item={it} />
                    <span className="tl-card-head">
                      <span className="dk-muted tl-small">{it.categoryId ? it.categoryName : tr('No category')} · {live.length === 1 ? tr('1 variation') : tr('{n} variations', { n: live.length })}</span>
                      <span className="tl-name">{it.name}</span>
                    </span>
                  </button>
                  <span className="tl-menu"><RowMenu actions={itemActions(it)} /></span>
                  {it.description && <p className="dk-muted tl-small es-items">{it.description}</p>}
                  <div className="tl-tags"><Status tone={st.tone}>{st.text}</Status>{ms.length > 0 && <Status tone="muted">{tr('{pct}% margin', { pct: Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) })}</Status>}</div>
                  <div className="tl-foot">
                    <span className="es-total">{priceRange(it)}</span>
                    <span className="dk-muted tl-small">{stock > 0 ? tr('{n} in stock', { n: stock.toLocaleString() }) : tr('none in stock')}</span>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="tl-table-wrap">
            <table className="tl-table">
              <thead><tr><th>{tr('Item')}</th><th>{tr('Category')}</th><th className="is-num">{tr('Price')}</th><th className="is-num">{tr('Margin')}</th><th className="is-num">{tr('Stock')}</th><th className="is-num">{tr('Sold, 12 months')}</th><th /></tr></thead>
              <tbody>
                {visible.map((it) => {
                  const live = it.variations.filter((v) => v.active || !it.active);
                  const ms = live.map(margin).filter((m) => m !== null);
                  return (
                    <tr key={it.id} className={!it.active ? 'st-retired' : ''}>
                      <td><button type="button" className="tl-row-open" onClick={() => setDetail(it.id)}><Mark item={it} size={32} /><span><span className="tl-name">{it.name}</span><span className="dk-muted tl-small">{live.length === 1 ? live[0].code : tr('{n} variations', { n: live.length })}</span></span></button></td>
                      <td>{it.categoryId ? it.categoryName : '—'}</td>
                      <td className="is-num">{priceRange(it)}</td>
                      <td className={'is-num' + (live.some(belowCost) ? ' pk-owe' : '')}>{ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) + '%' : '—'}</td>
                      <td className="is-num">{live.reduce((s, v) => s + v.stockQty, 0).toLocaleString()}</td>
                      <td className="is-num">{sumSold(live).length ? moneyBreakdown(sumSold(live)) : '—'}</td>
                      <td className="tl-menu-cell"><RowMenu actions={itemActions(it)} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Glossary items={[
        [tr('Item'), tr('A product or service, like a bamboo panel or an installation. It holds one or more variations.')],
        [tr('Variation'), tr('One size, finish or version of an item, with its own code, price, cost and stock. It is what goes on a quotation or invoice line.')],
        [tr('Margin'), tr('What is left of the price after the cost price, as a share of the price.')],
        [tr('Sold'), tr('Invoiced over the last 12 months, voided invoices left out. A line counts when it was picked from here, or carries the same name.')],
        [tr('Archived'), tr('No longer offered: it can\'t be picked for new documents, but past documents keep it.')]
      ]} />

      {/* ── one item ── */}
      {cur && (
        <div className="dialog-backdrop" onClick={() => setDetail(null)}>
          <div className="dialog tl-dialog ct-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="tl-detail-head">
              <Mark item={cur} size={56} />
              <div>
                <span className="dk-muted tl-small">{cur.categoryId ? cur.categoryName : tr('No category')}</span>
                <h2>{cur.name}</h2>
                <div className="tl-tags"><Status tone={stateOf(cur).tone}>{stateOf(cur).text}</Status></div>
              </div>
              <button type="button" className="tl-close" onClick={() => setDetail(null)} aria-label={tr('Close')}>×</button>
            </div>
            {cur.description && <p className="tl-notes">{cur.description}</p>}
            <h3 className="tl-h3">{tr('Variations')}</h3>
            <ul className="rs-list ct-vars">
              {cur.variations.map((v) => {
                const m = margin(v);
                return (
                  <li key={v.id} className={'rs-row' + (!v.active ? ' is-void' : '')}>
                    <div className="rs-row-open ct-var">
                      <span className="rs-row-main">
                        <strong>{varLabel(v)} <span className="dk-muted tl-small">· {v.code}</span></strong>
                        <span className="dk-muted tl-small">
                          {tr('{price} per {unit}', { price: money(v.unitPrice), unit: v.unit })}
                          {v.costPrice > 0 ? ' · ' + tr('cost {cost}', { cost: money(v.costPrice) }) : ''}
                          {' · '}{v.stockQty > 0 ? tr('{n} in stock', { n: v.stockQty.toLocaleString() }) : tr('none in stock')}
                        </span>
                        <span className="dk-muted tl-small">{v.sold.qty > 0 ? tr('{n} sold on {k} invoices, last on {date}', { n: v.sold.qty.toLocaleString(), k: v.sold.invoices, date: fmtDate(v.sold.lastSoldOn) }) : tr('Not sold in 12 months')}</span>
                      </span>
                      <span className="rs-row-side">
                        {m !== null && <Status tone={belowCost(v) ? 'bad' : m < 15 ? 'warn' : 'good'}>{tr('{pct}% margin', { pct: m })}</Status>}
                        {!v.active && <Status tone="muted">{tr('Archived')}</Status>}
                        {v.sold.amounts.length > 0 && <strong className="rs-amount">{moneyBreakdown(v.sold.amounts)}</strong>}
                      </span>
                    </div>
                    {canManage && <span className="rs-row-menu"><RowMenu actions={varActions(cur, v)} /></span>}
                  </li>
                );
              })}
            </ul>
            <div className="dialog-actions tl-actions">
              {canManage && <button type="button" className="btn btn-secondary" onClick={() => { setDetail(null); setDeleteItemTarget(cur); }}>{tr('Delete')}</button>}
              {canManage && <button type="button" className="btn btn-secondary" disabled={busyId === cur.id} onClick={() => toggleItemActive(cur)}>{cur.active ? tr('Archive') : tr('Unarchive')}</button>}
              {canManage && <button type="button" className="btn btn-secondary" onClick={() => { setDetail(null); openEditItem(cur); }}>{tr('Edit')}</button>}
              {canManage && <button type="button" className="btn btn-primary" onClick={() => openNewVariation(cur.id)}>{tr('+ Add variation')}</button>}
            </div>
          </div>
        </div>
      )}

      {itemDialogOpen && (
        <div className="dialog-backdrop" onClick={() => setItemDialogOpen(false)}>
          <form className="dialog catalog-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleItemSubmit}>
            <h2 className="catalog-dialog-title">{editItemId ? tr('Edit item') : tr('Add item')}</h2>
            {itemDialogError && <div className="error-banner catalog-dialog-span">{itemDialogError}</div>}
            <div className="field catalog-dialog-span">
              <label htmlFor="cat-name">{tr('Item name')}</label>
              <input id="cat-name" className="input" value={itemForm.name} onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })} required />
            </div>
            <div className="field catalog-dialog-span">
              <label htmlFor="cat-desc">{tr('Description')}</label>
              <textarea id="cat-desc" className="input" value={itemForm.description} onChange={(e) => setItemForm({ ...itemForm, description: e.target.value })} />
            </div>
            <div className="field catalog-dialog-span">
              <label htmlFor="cat-category">{tr('Category')}</label>
              <div className="catalog-category-row">
                <select id="cat-category" className="input" value={itemForm.categoryId} onChange={(e) => setItemForm({ ...itemForm, categoryId: e.target.value })}>
                  <option value="">{tr('No category')}</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <input className="input" placeholder={tr('New category name')} value={newCategoryName} onChange={(e) => setNewCategoryName(e.target.value)} />
                <button type="button" className="btn btn-secondary" disabled={addingCategory} onClick={submitNewCategory}>{tr('Add')}</button>
              </div>
            </div>
            {canSeeTaxRates && (
              <div className="field catalog-dialog-span">
                <label htmlFor="cat-tax">{tr('Tax rate')}</label>
                <select id="cat-tax" className="input" value={itemForm.taxRateId} onChange={(e) => setItemForm({ ...itemForm, taxRateId: e.target.value })}>
                  <option value="">{tr('Default')}</option>
                  {taxRates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.rate}%)</option>)}
                </select>
              </div>
            )}
            {!editItemId && (
              <>
                <p className="catalog-dialog-span catalog-first-variation-note">{tr('Every item needs at least one variation — add more later from the item\'s row.')}</p>
                <div className="field">
                  <label htmlFor="cat-var-name">{tr('Variation name')}</label>
                  <input id="cat-var-name" className="input" placeholder={tr('Regular')} value={itemForm.variationName} onChange={(e) => setItemForm({ ...itemForm, variationName: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="cat-code">{tr('Code')}</label>
                  <input id="cat-code" className="input" value={itemForm.code} onChange={(e) => setItemForm({ ...itemForm, code: e.target.value })} required />
                </div>
                <div className="field">
                  <label htmlFor="cat-unit">{tr('Unit')}</label>
                  <input id="cat-unit" className="input" value={itemForm.unit} onChange={(e) => setItemForm({ ...itemForm, unit: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="cat-defaultqty">{tr('Default qty')}</label>
                  <input id="cat-defaultqty" className="input" type="number" value={itemForm.defaultQty} onChange={(e) => setItemForm({ ...itemForm, defaultQty: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="cat-unitprice">{tr('Unit price (GHS)')}</label>
                  <input id="cat-unitprice" className="input" type="number" value={itemForm.unitPrice} onChange={(e) => setItemForm({ ...itemForm, unitPrice: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="cat-costprice">{tr('Cost price (GHS)')}</label>
                  <input id="cat-costprice" className="input" type="number" value={itemForm.costPrice} onChange={(e) => setItemForm({ ...itemForm, costPrice: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor="cat-stockqty">{tr('Initial stock')}</label>
                  <input id="cat-stockqty" className="input" type="number" value={itemForm.stockQty} onChange={(e) => setItemForm({ ...itemForm, stockQty: e.target.value })} />
                </div>
              </>
            )}
            <div className="dialog-actions catalog-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setItemDialogOpen(false)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={savingItem}>{editItemId ? tr('Save changes') : tr('Add item')}</button>
            </div>
          </form>
        </div>
      )}

      {varDialog && (
        <div className="dialog-backdrop" onClick={() => setVarDialog(null)}>
          <form className="dialog catalog-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleVariationSubmit}>
            <h2 className="catalog-dialog-title">{varDialog.editId ? tr('Edit variation') : tr('Add variation')}</h2>
            {varDialogError && <div className="error-banner catalog-dialog-span">{varDialogError}</div>}
            <div className="field">
              <label htmlFor="var-name">{tr('Variation name')}</label>
              <input id="var-name" className="input" placeholder={tr('Regular')} value={varDialog.form.name} onChange={(e) => setVarDialog({ ...varDialog, form: { ...varDialog.form, name: e.target.value } })} />
            </div>
            <div className="field">
              <label htmlFor="var-code">{tr('Code')}</label>
              <input id="var-code" className="input" value={varDialog.form.code} onChange={(e) => setVarDialog({ ...varDialog, form: { ...varDialog.form, code: e.target.value } })} required />
            </div>
            <div className="field">
              <label htmlFor="var-unit">{tr('Unit')}</label>
              <input id="var-unit" className="input" value={varDialog.form.unit} onChange={(e) => setVarDialog({ ...varDialog, form: { ...varDialog.form, unit: e.target.value } })} />
            </div>
            <div className="field">
              <label htmlFor="var-defaultqty">{tr('Default qty')}</label>
              <input id="var-defaultqty" className="input" type="number" value={varDialog.form.defaultQty} onChange={(e) => setVarDialog({ ...varDialog, form: { ...varDialog.form, defaultQty: e.target.value } })} />
            </div>
            <div className="field">
              <label htmlFor="var-unitprice">{tr('Unit price (GHS)')}</label>
              <input id="var-unitprice" className="input" type="number" value={varDialog.form.unitPrice} onChange={(e) => setVarDialog({ ...varDialog, form: { ...varDialog.form, unitPrice: e.target.value } })} />
            </div>
            <div className="field">
              <label htmlFor="var-costprice">{tr('Cost price (GHS)')}</label>
              <input id="var-costprice" className="input" type="number" value={varDialog.form.costPrice} onChange={(e) => setVarDialog({ ...varDialog, form: { ...varDialog.form, costPrice: e.target.value } })} />
            </div>
            {!varDialog.editId && (
              <div className="field">
                <label htmlFor="var-stockqty">{tr('Initial stock')}</label>
                <input id="var-stockqty" className="input" type="number" value={varDialog.form.stockQty} onChange={(e) => setVarDialog({ ...varDialog, form: { ...varDialog.form, stockQty: e.target.value } })} />
              </div>
            )}
            <div className="dialog-actions catalog-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setVarDialog(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={savingVar}>{varDialog.editId ? tr('Save changes') : tr('Add variation')}</button>
            </div>
          </form>
        </div>
      )}

      {stockDialog && (
        <div className="dialog-backdrop" onClick={() => setStockDialog(null)}>
          <form className="dialog catalog-stock-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitStockAdjust}>
            <h2 className="catalog-dialog-title">{tr('Adjust stock —')} {stockDialog.name}</h2>
            {stockDialogError && <div className="error-banner">{stockDialogError}</div>}
            <p className="catalog-stock-current">{tr('Currently in stock:')} <strong>{stockDialog.stockQty.toLocaleString()}</strong></p>
            <div className="field">
              <label htmlFor="stock-delta">{tr('Change (use a negative number to remove stock)')}</label>
              <input id="stock-delta" className="input" type="number" value={stockDialog.delta} onChange={(e) => setStockDialog({ ...stockDialog, delta: e.target.value })} placeholder={tr('e.g. 20 or -5')} required autoFocus />
            </div>
            <div className="field">
              <label htmlFor="stock-note">{tr('Reason (optional)')}</label>
              <input id="stock-note" className="input" value={stockDialog.note} onChange={(e) => setStockDialog({ ...stockDialog, note: e.target.value })} placeholder={tr('e.g. Shipment received, stocktake correction')} />
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setStockDialog(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={savingStock}>{savingStock ? tr('Saving…') : tr('Save')}</button>
            </div>
          </form>
        </div>
      )}

      {deleteItemTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteItemTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Delete {name}', { name: deleteItemTarget.name })}</h2>
            <p className="dialog-body">{tr('This deletes the item and all of its variations. This cannot be undone.')}</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteItemTarget(null)}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={confirmDeleteItem}>{deleting ? tr('Deleting…') : tr('Delete')}</button>
            </div>
          </div>
        </div>
      )}

      {deleteVarTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteVarTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Delete {name}', { name: deleteVarTarget.name })}</h2>
            <p className="dialog-body">{tr('This cannot be undone.')}</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteVarTarget(null)}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={confirmDeleteVariation}>{deleting ? tr('Deleting…') : tr('Delete')}</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
