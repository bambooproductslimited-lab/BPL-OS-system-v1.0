import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { money } from '../lib/currency';
import './RestaurantsPage.css';

// Restaurant module, Phase 1: each restaurant company (Star Bar Restaurant,
// Bamboo Garden — see migration 0032) gets its own sellable menu plus two
// separate stock trackers: general supplies (glassware, napkins — no
// expiry) and food ingredients (does expire). A company switcher up top
// scopes all three tabs to one restaurant at a time, same "pick a company,
// everything below scopes to it" pattern as Attendance/Payroll's company
// filters, just as the primary navigation here instead of a secondary
// filter, since unlike those screens nothing here is ever meant to show
// both restaurants blended together.
//
// Menu items are the foundation Phase 2 (POS) and Phase 4 (per-restaurant
// Square import) both build on — a menu item is what a POS sale rings up,
// and what a Square catalogue sync would upsert into.
//
// Phase 2 added the "Sales" tab and the "Open till (POS)" link: this page
// only ever reads orders (list + void) — they're created exclusively by
// the till itself (RestaurantPosPage.jsx, at /pos), which authenticates
// with its own PIN-based session, not a login here.

const EMPTY_MENU_FORM = { name: '', category: '', price: '' };
const EMPTY_SUPPLY_FORM = { name: '', category: '', unit: 'each', stockQty: '', reorderLevel: '', unitCost: '' };
const EMPTY_INGREDIENT_FORM = { name: '', unit: 'kg', stockQty: '', reorderLevel: '', unitCost: '', expiryDate: '' };

function UtensilsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 2.5v8M4 2.5v5a2 2 0 0 0 2 2h0a2 2 0 0 0 2-2v-5M6 12.5V21.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M18 2.5c-2 0-3 2-3 5s1 4 3 4v10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function RestaurantsPage() {
  const { can } = useAuth();
  const canManage = can('restaurant.manage');

  const [departments, setDepartments] = useState([]);
  const [companyId, setCompanyId] = useState('');
  const [tab, setTab] = useState('menu'); // 'menu' | 'supplies' | 'ingredients' | 'sales'
  const [search, setSearch] = useState('');

  const [menuItems, setMenuItems] = useState([]);
  const [supplies, setSupplies] = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const [squareBusy, setSquareBusy] = useState(false);
  const [squareResult, setSquareResult] = useState(null);
  const [squareError, setSquareError] = useState(null);

  const [menuDialogOpen, setMenuDialogOpen] = useState(false);
  const [menuEditId, setMenuEditId] = useState(null);
  const [menuForm, setMenuForm] = useState(EMPTY_MENU_FORM);
  const [menuDialogError, setMenuDialogError] = useState(null);
  const [menuSaving, setMenuSaving] = useState(false);

  const [supplyDialogOpen, setSupplyDialogOpen] = useState(false);
  const [supplyEditId, setSupplyEditId] = useState(null);
  const [supplyForm, setSupplyForm] = useState(EMPTY_SUPPLY_FORM);
  const [supplyDialogError, setSupplyDialogError] = useState(null);
  const [supplySaving, setSupplySaving] = useState(false);

  const [ingredientDialogOpen, setIngredientDialogOpen] = useState(false);
  const [ingredientEditId, setIngredientEditId] = useState(null);
  const [ingredientForm, setIngredientForm] = useState(EMPTY_INGREDIENT_FORM);
  const [ingredientDialogError, setIngredientDialogError] = useState(null);
  const [ingredientSaving, setIngredientSaving] = useState(false);

  // { kind: 'supply'|'ingredient', id, name, stockQty, delta, note }
  const [stockDialog, setStockDialog] = useState(null);
  const [stockDialogError, setStockDialogError] = useState(null);
  const [stockSaving, setStockSaving] = useState(false);

  // Same "derive companies from departments" pattern already used by
  // Tasks/Attendance/Payroll/Leave's company filters.
  const companies = useMemo(() => {
    const seen = new Map();
    departments.forEach((d) => { if (!seen.has(d.companyId)) seen.set(d.companyId, { id: d.companyId, name: d.companyName }); });
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [departments]);

  const load = useCallback(async (forCompanyId) => {
    setError(null);
    try {
      const qs = forCompanyId ? '?companyId=' + forCompanyId : '';
      const [menu, sup, ing] = await Promise.all([
        api.get('/restaurant/menu-items' + qs),
        api.get('/restaurant/supplies' + qs),
        api.get('/restaurant/ingredients' + qs)
      ]);
      setMenuItems(menu);
      setSupplies(sup);
      setIngredients(ing);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Sales is server-paginated separately from the other tabs: the Square
  // historical import (Phase 4) can leave tens of thousands of orders for
  // one restaurant, far more than a plain <table> (or the other tabs'
  // load-everything-then-filter-client-side pattern) can handle.
  const ORDERS_PAGE_SIZE = 50;
  const [ordersOffset, setOrdersOffset] = useState(0);
  const [ordersTotal, setOrdersTotal] = useState(0);
  const [ordersFrom, setOrdersFrom] = useState('');
  const [ordersTo, setOrdersTo] = useState('');
  const [ordersLoading, setOrdersLoading] = useState(false);

  const loadOrders = useCallback(async (forCompanyId, offset, from, to) => {
    if (!forCompanyId) return;
    setOrdersLoading(true);
    try {
      const params = new URLSearchParams({ companyId: forCompanyId, limit: ORDERS_PAGE_SIZE, offset });
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const res = await api.get('/restaurant/orders?' + params.toString());
      setOrders(res.orders);
      setOrdersTotal(res.total);
    } catch (err) {
      setError(err.message);
    } finally {
      setOrdersLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const depts = await api.get('/departments');
        setDepartments(depts);
      } catch (err) {
        setError(err.message);
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!companyId && companies.length) { setCompanyId(companies[0].id); return; }
    if (companyId) load(companyId);
    setSquareResult(null);
    setSquareError(null);
    setOrdersOffset(0);
  }, [companyId, companies, load]);

  useEffect(() => {
    if (tab === 'sales' && companyId) loadOrders(companyId, ordersOffset, ordersFrom, ordersTo);
  }, [tab, companyId, ordersOffset, ordersFrom, ordersTo, loadOrders]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // ── menu items ──────────────────────────────────────────────────────
  function openNewMenuItem() {
    setMenuDialogError(null);
    setMenuEditId(null);
    setMenuForm(EMPTY_MENU_FORM);
    setMenuDialogOpen(true);
  }
  function openEditMenuItem(m) {
    setMenuDialogError(null);
    setMenuEditId(m.id);
    setMenuForm({ name: m.name, category: m.category, price: m.price });
    setMenuDialogOpen(true);
  }
  async function submitMenuForm(e) {
    e.preventDefault();
    setMenuSaving(true);
    setMenuDialogError(null);
    try {
      if (menuEditId) await api.put('/restaurant/menu-items/' + menuEditId, menuForm);
      else await api.post('/restaurant/menu-items', { ...menuForm, companyId });
      setToast(menuEditId ? 'Menu item updated.' : 'Menu item added.');
      setMenuDialogOpen(false);
      await load(companyId);
    } catch (err) {
      setMenuDialogError(err.message);
    } finally {
      setMenuSaving(false);
    }
  }
  async function toggleMenuActive(m) {
    setBusyId(m.id);
    try {
      await api.post('/restaurant/menu-items/' + m.id + '/active', { active: !m.active });
      await load(companyId);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }
  async function deleteMenuItem(m) {
    setBusyId(m.id);
    try {
      await api.del('/restaurant/menu-items/' + m.id);
      setToast('Menu item removed.');
      await load(companyId);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  // ── supplies ────────────────────────────────────────────────────────
  function openNewSupply() {
    setSupplyDialogError(null);
    setSupplyEditId(null);
    setSupplyForm(EMPTY_SUPPLY_FORM);
    setSupplyDialogOpen(true);
  }
  function openEditSupply(s) {
    setSupplyDialogError(null);
    setSupplyEditId(s.id);
    setSupplyForm({ name: s.name, category: s.category, unit: s.unit, stockQty: s.stockQty, reorderLevel: s.reorderLevel, unitCost: s.unitCost });
    setSupplyDialogOpen(true);
  }
  async function submitSupplyForm(e) {
    e.preventDefault();
    setSupplySaving(true);
    setSupplyDialogError(null);
    try {
      if (supplyEditId) await api.put('/restaurant/supplies/' + supplyEditId, supplyForm);
      else await api.post('/restaurant/supplies', { ...supplyForm, companyId });
      setToast(supplyEditId ? 'Supply item updated.' : 'Supply item added.');
      setSupplyDialogOpen(false);
      await load(companyId);
    } catch (err) {
      setSupplyDialogError(err.message);
    } finally {
      setSupplySaving(false);
    }
  }
  async function deleteSupply(s) {
    setBusyId(s.id);
    try {
      await api.del('/restaurant/supplies/' + s.id);
      setToast('Supply item removed.');
      await load(companyId);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  // ── ingredients ─────────────────────────────────────────────────────
  function openNewIngredient() {
    setIngredientDialogError(null);
    setIngredientEditId(null);
    setIngredientForm(EMPTY_INGREDIENT_FORM);
    setIngredientDialogOpen(true);
  }
  function openEditIngredient(i) {
    setIngredientDialogError(null);
    setIngredientEditId(i.id);
    setIngredientForm({ name: i.name, unit: i.unit, stockQty: i.stockQty, reorderLevel: i.reorderLevel, unitCost: i.unitCost, expiryDate: i.expiryDate ? i.expiryDate.slice(0, 10) : '' });
    setIngredientDialogOpen(true);
  }
  async function submitIngredientForm(e) {
    e.preventDefault();
    setIngredientSaving(true);
    setIngredientDialogError(null);
    try {
      if (ingredientEditId) await api.put('/restaurant/ingredients/' + ingredientEditId, ingredientForm);
      else await api.post('/restaurant/ingredients', { ...ingredientForm, companyId });
      setToast(ingredientEditId ? 'Ingredient updated.' : 'Ingredient added.');
      setIngredientDialogOpen(false);
      await load(companyId);
    } catch (err) {
      setIngredientDialogError(err.message);
    } finally {
      setIngredientSaving(false);
    }
  }
  async function deleteIngredient(i) {
    setBusyId(i.id);
    try {
      await api.del('/restaurant/ingredients/' + i.id);
      setToast('Ingredient removed.');
      await load(companyId);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  // ── sales (POS orders, read-only here — the till itself creates them) ──
  async function voidOrderAction(o) {
    setBusyId(o.id);
    try {
      await api.post('/restaurant/orders/' + o.id + '/void');
      setToast('Order voided.');
      await loadOrders(companyId, ordersOffset, ordersFrom, ordersTo);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  // ── Square import (Phase 4): one-time historical pull from this
  // restaurant's own Square account into its menu + sales — see
  // restaurantSquareImport.service.js. Scoped to whichever company the
  // segmented control above has selected, same as every other action here.
  async function runSquareImport() {
    setSquareBusy(true);
    setSquareError(null);
    setSquareResult(null);
    try {
      const result = await api.post('/restaurant/square-import', { companyId });
      setSquareResult(result);
      await load(companyId);
    } catch (err) {
      setSquareError(err.message);
    } finally {
      setSquareBusy(false);
    }
  }

  // ── shared stock-adjust dialog (supplies + ingredients) ────────────
  function openStockDialog(kind, item) {
    setStockDialogError(null);
    setStockDialog({ kind: kind, id: item.id, name: item.name, stockQty: item.stockQty, delta: '', note: '' });
  }
  async function submitStockDialog(e) {
    e.preventDefault();
    setStockSaving(true);
    setStockDialogError(null);
    try {
      const path = stockDialog.kind === 'supply' ? '/restaurant/supplies/' : '/restaurant/ingredients/';
      await api.post(path + stockDialog.id + '/stock', { delta: stockDialog.delta, note: stockDialog.note });
      setToast('Stock updated.');
      setStockDialog(null);
      await load(companyId);
    } catch (err) {
      setStockDialogError(err.message);
    } finally {
      setStockSaving(false);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const visibleMenuItems = menuItems.filter((m) => matchesQuery(search, m.name, m.category));
  const visibleSupplies = supplies.filter((s) => matchesQuery(search, s.name, s.category));
  const visibleIngredients = ingredients.filter((i) => matchesQuery(search, i.name));

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      {!companies.length ? (
        <div className="restaurants-empty-state">
          <span className="restaurants-empty-icon"><UtensilsIcon /></span>
          <p className="restaurants-empty-title">No companies found</p>
        </div>
      ) : (
        <>
          <div className="seg restaurants-company-seg">
            {companies.map((c) => (
              <label className="seg-opt" key={c.id}>
                <input type="radio" name="restaurant-company" checked={companyId === c.id} onChange={() => setCompanyId(c.id)} />
                <span>{c.name}</span>
              </label>
            ))}
          </div>

          <div className="restaurants-toolbar">
            <div className="seg">
              {[{ key: 'menu', label: 'Menu' }, { key: 'supplies', label: 'Supplies' }, { key: 'ingredients', label: 'Food' }, { key: 'sales', label: 'Sales' }].map((opt) => (
                <label className="seg-opt" key={opt.key}>
                  <input type="radio" name="restaurant-tab" checked={tab === opt.key} onChange={() => setTab(opt.key)} />
                  <span>{opt.label}</span>
                </label>
              ))}
            </div>
            {tab !== 'sales' && (
              <SearchInput value={search} onChange={setSearch} placeholder={'Search ' + (tab === 'ingredients' ? 'food' : tab) + '…'} />
            )}
            {tab === 'sales' && (
              <div className="restaurants-date-filter">
                <input type="date" className="input" value={ordersFrom} onChange={(e) => { setOrdersFrom(e.target.value); setOrdersOffset(0); }} aria-label="From date" />
                <span>to</span>
                <input type="date" className="input" value={ordersTo} onChange={(e) => { setOrdersTo(e.target.value); setOrdersOffset(0); }} aria-label="To date" />
                {(ordersFrom || ordersTo) && (
                  <button type="button" className="btn btn-secondary restaurants-row-btn" onClick={() => { setOrdersFrom(''); setOrdersTo(''); setOrdersOffset(0); }}>Clear</button>
                )}
              </div>
            )}
            {canManage && tab === 'menu' && <button type="button" className="btn btn-primary" onClick={openNewMenuItem}>Add menu item</button>}
            {canManage && tab === 'supplies' && <button type="button" className="btn btn-primary" onClick={openNewSupply}>Add supply</button>}
            {canManage && tab === 'ingredients' && <button type="button" className="btn btn-primary" onClick={openNewIngredient}>Add ingredient</button>}
            <a className="btn btn-secondary" href="/pos" target="_blank" rel="noreferrer">Open till (POS) ↗</a>
            {canManage && (
              <button type="button" className="btn btn-secondary" disabled={squareBusy} onClick={runSquareImport}>
                {squareBusy ? 'Importing from Square…' : 'Import from Square'}
              </button>
            )}
          </div>

          {squareError && <div className="error-banner" style={{ marginBottom: 16 }}>{squareError}</div>}
          {squareResult && (
            <div className="restaurants-square-result">
              Menu items {squareResult.menuItems.imported} imported ({squareResult.menuItems.skipped} skipped) · Orders {squareResult.orders.imported} imported ({squareResult.orders.skipped} skipped)
              {squareResult.errors.length > 0 && <> — {squareResult.errors.length} record(s) had errors; see server logs / audit trail.</>}
            </div>
          )}

          {tab === 'menu' && (
            <table className="table">
              <thead><tr><th>Name</th><th>Category</th><th>Price</th><th>Status</th><th /></tr></thead>
              <tbody>
                {visibleMenuItems.map((m) => (
                  <tr key={m.id}>
                    <td style={{ fontWeight: 600 }}>{m.name}</td>
                    <td>{m.category}</td>
                    <td>{money(m.price)}</td>
                    <td><span className={'tag ' + (m.active ? 'tag-neutral' : 'tag-outline')}>{m.active ? 'Active' : 'Disabled'}</span></td>
                    <td className="table-actions">
                      {canManage && <button type="button" className="btn btn-secondary restaurants-row-btn" onClick={() => openEditMenuItem(m)}>Edit</button>}
                      {canManage && <button type="button" className="btn btn-secondary restaurants-row-btn" disabled={busyId === m.id} onClick={() => toggleMenuActive(m)}>{m.active ? 'Disable' : 'Enable'}</button>}
                      {canManage && <button type="button" className="btn btn-secondary restaurants-row-btn" disabled={busyId === m.id} onClick={() => deleteMenuItem(m)}>Delete</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {tab === 'supplies' && (
            <table className="table">
              <thead><tr><th>Name</th><th>Category</th><th>Stock</th><th>Reorder level</th><th>Unit cost</th><th /></tr></thead>
              <tbody>
                {visibleSupplies.map((s) => (
                  <tr key={s.id}>
                    <td style={{ fontWeight: 600 }}>{s.name}</td>
                    <td>{s.category}</td>
                    <td>{s.stockQty} {s.unit} {s.lowStock && <span className="tag tag-accent restaurants-lowstock">Low</span>}</td>
                    <td>{s.reorderLevel} {s.unit}</td>
                    <td>{money(s.unitCost)}</td>
                    <td className="table-actions">
                      {canManage && <button type="button" className="btn btn-secondary restaurants-row-btn" onClick={() => openStockDialog('supply', s)}>Adjust stock</button>}
                      {canManage && <button type="button" className="btn btn-secondary restaurants-row-btn" onClick={() => openEditSupply(s)}>Edit</button>}
                      {canManage && <button type="button" className="btn btn-secondary restaurants-row-btn" disabled={busyId === s.id} onClick={() => deleteSupply(s)}>Delete</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {tab === 'ingredients' && (
            <table className="table">
              <thead><tr><th>Name</th><th>Stock</th><th>Reorder level</th><th>Unit cost</th><th>Expiry</th><th /></tr></thead>
              <tbody>
                {visibleIngredients.map((i) => (
                  <tr key={i.id}>
                    <td style={{ fontWeight: 600 }}>{i.name}</td>
                    <td>{i.stockQty} {i.unit} {i.lowStock && <span className="tag tag-accent restaurants-lowstock">Low</span>}</td>
                    <td>{i.reorderLevel} {i.unit}</td>
                    <td>{money(i.unitCost)}</td>
                    <td>
                      {i.expiryDate ? i.expiryDate.slice(0, 10) : '—'}
                      {i.expiringSoon && <span className="tag tag-accent restaurants-lowstock">Expiring soon</span>}
                    </td>
                    <td className="table-actions">
                      {canManage && <button type="button" className="btn btn-secondary restaurants-row-btn" onClick={() => openStockDialog('ingredient', i)}>Adjust stock</button>}
                      {canManage && <button type="button" className="btn btn-secondary restaurants-row-btn" onClick={() => openEditIngredient(i)}>Edit</button>}
                      {canManage && <button type="button" className="btn btn-secondary restaurants-row-btn" disabled={busyId === i.id} onClick={() => deleteIngredient(i)}>Delete</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {tab === 'sales' && (
            <>
              <table className="table" style={{ opacity: ordersLoading ? 0.6 : 1 }}>
                <thead><tr><th>Order</th><th>Cashier</th><th>Total</th><th>Payment</th><th>Status</th><th>Time</th><th /></tr></thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id}>
                      <td style={{ fontWeight: 600 }}>{o.orderNo}</td>
                      <td>{o.cashierName}</td>
                      <td>{money(o.total)}</td>
                      <td style={{ textTransform: 'capitalize' }}>{o.paymentMethod.replace('_', ' ')}</td>
                      <td><span className={'tag ' + (o.status === 'voided' ? 'tag-accent' : 'tag-neutral')}>{o.status}</span></td>
                      <td>{new Date(o.createdAt).toLocaleString()}</td>
                      <td className="table-actions">
                        {canManage && o.status === 'completed' && (
                          <button type="button" className="btn btn-secondary restaurants-row-btn" disabled={busyId === o.id} onClick={() => voidOrderAction(o)}>Void</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {ordersTotal > 0 && (
                <div className="restaurants-pager">
                  <span>{ordersOffset + 1}–{Math.min(ordersOffset + ORDERS_PAGE_SIZE, ordersTotal)} of {ordersTotal.toLocaleString()}</span>
                  <button type="button" className="btn btn-secondary restaurants-row-btn" disabled={ordersOffset === 0 || ordersLoading} onClick={() => setOrdersOffset(Math.max(0, ordersOffset - ORDERS_PAGE_SIZE))}>Previous</button>
                  <button type="button" className="btn btn-secondary restaurants-row-btn" disabled={ordersOffset + ORDERS_PAGE_SIZE >= ordersTotal || ordersLoading} onClick={() => setOrdersOffset(ordersOffset + ORDERS_PAGE_SIZE)}>Next</button>
                </div>
              )}
            </>
          )}

          {tab === 'menu' && !menuItems.length && (
            <div className="restaurants-empty-state"><span className="restaurants-empty-icon"><UtensilsIcon /></span><p className="restaurants-empty-title">No menu items yet</p></div>
          )}
          {tab === 'menu' && !!menuItems.length && !visibleMenuItems.length && (
            <div className="restaurants-empty-state"><span className="restaurants-empty-icon"><UtensilsIcon /></span><p className="restaurants-empty-title">No menu items match "{search}"</p></div>
          )}
          {tab === 'supplies' && !supplies.length && (
            <div className="restaurants-empty-state"><span className="restaurants-empty-icon"><UtensilsIcon /></span><p className="restaurants-empty-title">No supplies tracked yet</p></div>
          )}
          {tab === 'supplies' && !!supplies.length && !visibleSupplies.length && (
            <div className="restaurants-empty-state"><span className="restaurants-empty-icon"><UtensilsIcon /></span><p className="restaurants-empty-title">No supplies match "{search}"</p></div>
          )}
          {tab === 'ingredients' && !ingredients.length && (
            <div className="restaurants-empty-state"><span className="restaurants-empty-icon"><UtensilsIcon /></span><p className="restaurants-empty-title">No food ingredients tracked yet</p></div>
          )}
          {tab === 'ingredients' && !!ingredients.length && !visibleIngredients.length && (
            <div className="restaurants-empty-state"><span className="restaurants-empty-icon"><UtensilsIcon /></span><p className="restaurants-empty-title">No ingredients match "{search}"</p></div>
          )}
          {tab === 'sales' && !ordersLoading && !orders.length && (ordersFrom || ordersTo) && (
            <div className="restaurants-empty-state"><span className="restaurants-empty-icon"><UtensilsIcon /></span><p className="restaurants-empty-title">No sales in that date range</p></div>
          )}
          {tab === 'sales' && !ordersLoading && !orders.length && !ordersFrom && !ordersTo && (
            <div className="restaurants-empty-state"><span className="restaurants-empty-icon"><UtensilsIcon /></span><p className="restaurants-empty-title">No sales yet — rung-up orders from the till will show here</p></div>
          )}
        </>
      )}

      {menuDialogOpen && (
        <div className="dialog-backdrop" onClick={() => setMenuDialogOpen(false)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitMenuForm}>
            <h2>{menuEditId ? 'Edit menu item' : 'Add menu item'}</h2>
            {menuDialogError && <div className="error-banner">{menuDialogError}</div>}
            <div className="field">
              <label htmlFor="rm-name">Name</label>
              <input id="rm-name" className="input" value={menuForm.name} onChange={(e) => setMenuForm({ ...menuForm, name: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="rm-category">Category</label>
              <input id="rm-category" className="input" value={menuForm.category} onChange={(e) => setMenuForm({ ...menuForm, category: e.target.value })} placeholder="Mains, Drinks, Starters…" />
            </div>
            <div className="field">
              <label htmlFor="rm-price">Price</label>
              <input id="rm-price" className="input" type="number" min="0" step="0.01" value={menuForm.price} onChange={(e) => setMenuForm({ ...menuForm, price: e.target.value })} required />
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setMenuDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={menuSaving}>{menuEditId ? 'Save changes' : 'Add item'}</button>
            </div>
          </form>
        </div>
      )}

      {supplyDialogOpen && (
        <div className="dialog-backdrop" onClick={() => setSupplyDialogOpen(false)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitSupplyForm}>
            <h2>{supplyEditId ? 'Edit supply item' : 'Add supply item'}</h2>
            {supplyDialogError && <div className="error-banner">{supplyDialogError}</div>}
            <div className="field">
              <label htmlFor="rs-name">Name</label>
              <input id="rs-name" className="input" value={supplyForm.name} onChange={(e) => setSupplyForm({ ...supplyForm, name: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="rs-category">Category</label>
              <input id="rs-category" className="input" value={supplyForm.category} onChange={(e) => setSupplyForm({ ...supplyForm, category: e.target.value })} placeholder="Disposables, Cleaning, Glassware…" />
            </div>
            <div className="field">
              <label htmlFor="rs-unit">Unit</label>
              <input id="rs-unit" className="input" value={supplyForm.unit} onChange={(e) => setSupplyForm({ ...supplyForm, unit: e.target.value })} placeholder="each, pack, box…" />
            </div>
            {!supplyEditId && (
              <div className="field">
                <label htmlFor="rs-qty">Starting stock</label>
                <input id="rs-qty" className="input" type="number" min="0" step="0.01" value={supplyForm.stockQty} onChange={(e) => setSupplyForm({ ...supplyForm, stockQty: e.target.value })} required />
              </div>
            )}
            <div className="field">
              <label htmlFor="rs-reorder">Reorder level</label>
              <input id="rs-reorder" className="input" type="number" min="0" step="0.01" value={supplyForm.reorderLevel} onChange={(e) => setSupplyForm({ ...supplyForm, reorderLevel: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="rs-cost">Unit cost</label>
              <input id="rs-cost" className="input" type="number" min="0" step="0.01" value={supplyForm.unitCost} onChange={(e) => setSupplyForm({ ...supplyForm, unitCost: e.target.value })} />
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setSupplyDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={supplySaving}>{supplyEditId ? 'Save changes' : 'Add item'}</button>
            </div>
          </form>
        </div>
      )}

      {ingredientDialogOpen && (
        <div className="dialog-backdrop" onClick={() => setIngredientDialogOpen(false)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitIngredientForm}>
            <h2>{ingredientEditId ? 'Edit ingredient' : 'Add ingredient'}</h2>
            {ingredientDialogError && <div className="error-banner">{ingredientDialogError}</div>}
            <div className="field">
              <label htmlFor="ri-name">Name</label>
              <input id="ri-name" className="input" value={ingredientForm.name} onChange={(e) => setIngredientForm({ ...ingredientForm, name: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="ri-unit">Unit</label>
              <input id="ri-unit" className="input" value={ingredientForm.unit} onChange={(e) => setIngredientForm({ ...ingredientForm, unit: e.target.value })} placeholder="kg, litre, dozen…" />
            </div>
            {!ingredientEditId && (
              <div className="field">
                <label htmlFor="ri-qty">Starting stock</label>
                <input id="ri-qty" className="input" type="number" min="0" step="0.01" value={ingredientForm.stockQty} onChange={(e) => setIngredientForm({ ...ingredientForm, stockQty: e.target.value })} required />
              </div>
            )}
            <div className="field">
              <label htmlFor="ri-reorder">Reorder level</label>
              <input id="ri-reorder" className="input" type="number" min="0" step="0.01" value={ingredientForm.reorderLevel} onChange={(e) => setIngredientForm({ ...ingredientForm, reorderLevel: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="ri-cost">Unit cost</label>
              <input id="ri-cost" className="input" type="number" min="0" step="0.01" value={ingredientForm.unitCost} onChange={(e) => setIngredientForm({ ...ingredientForm, unitCost: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="ri-expiry">Expiry date</label>
              <input id="ri-expiry" className="input" type="date" value={ingredientForm.expiryDate} onChange={(e) => setIngredientForm({ ...ingredientForm, expiryDate: e.target.value })} />
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setIngredientDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={ingredientSaving}>{ingredientEditId ? 'Save changes' : 'Add item'}</button>
            </div>
          </form>
        </div>
      )}

      {stockDialog && (
        <div className="dialog-backdrop" onClick={() => setStockDialog(null)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitStockDialog}>
            <h2>Adjust stock — {stockDialog.name}</h2>
            {stockDialogError && <div className="error-banner">{stockDialogError}</div>}
            <p className="restaurants-stock-current">Currently in stock: <strong>{Number(stockDialog.stockQty).toLocaleString()}</strong></p>
            <div className="field">
              <label htmlFor="rst-delta">Change (+ to add, − to remove)</label>
              <input id="rst-delta" className="input" type="number" step="0.01" value={stockDialog.delta} onChange={(e) => setStockDialog({ ...stockDialog, delta: e.target.value })} placeholder="e.g. 20 or -5" required autoFocus />
            </div>
            <div className="field">
              <label htmlFor="rst-note">Note (optional)</label>
              <input id="rst-note" className="input" value={stockDialog.note} onChange={(e) => setStockDialog({ ...stockDialog, note: e.target.value })} placeholder="e.g. Delivery received, stocktake correction" />
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setStockDialog(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={stockSaving}>{stockSaving ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
