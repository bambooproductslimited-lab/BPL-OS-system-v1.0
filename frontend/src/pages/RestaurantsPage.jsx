import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, API_ORIGIN } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { money } from '../lib/currency';
import { restaurantLogoUrl } from '../lib/restaurantLogos';
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
const EMPTY_TABLE_FORM = { name: '' };
const EMPTY_GUEST_FORM = { name: '', phone: '', notes: '' };

function UtensilsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 2.5v8M4 2.5v5a2 2 0 0 0 2 2h0a2 2 0 0 0 2-2v-5M6 12.5V21.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M18 2.5c-2 0-3 2-3 5s1 4 3 4v10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Small stat-tile icon set — same "icon chip + value + label" vocabulary as
// Dashboard's KPI tiles and Projects' summary tiles, reused here rather than
// inventing a new pattern for this one page.
const STAT_ICONS = {
  list: <svg viewBox="0 0 24 24" fill="none"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  check: <svg viewBox="0 0 24 24" fill="none"><path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  tag: <svg viewBox="0 0 24 24" fill="none"><path d="M20.59 13.41 11 3.83A2 2 0 0 0 9.59 3.24H4a1 1 0 0 0-1 1v5.59a2 2 0 0 0 .59 1.41l9.58 9.58a2 2 0 0 0 2.83 0l5.59-5.59a2 2 0 0 0 0-2.82Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><circle cx="7.5" cy="7.5" r="1.2" fill="currentColor" /></svg>,
  alert: <svg viewBox="0 0 24 24" fill="none"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M12 9v4M12 17h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>,
  clock: <svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" /><path d="M12 7v5l3.5 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  money: <svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" /><path d="M12 7.5v9M9.5 9.5a2 2 0 0 1 2-1.5h1a2 2 0 0 1 0 4h-1a2 2 0 0 0 0 4h1a2 2 0 0 0 2-1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  ban: <svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" /><path d="m5.5 5.5 13 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
};
// Animates a number from wherever it last was to `target` — not a CSS
// keyframe (those can't interpolate a value driven by live data), so this
// drives its own requestAnimationFrame loop with an ease-out curve. Reruns
// automatically whenever `target` changes (a new company/tab, a fresh
// Square import, a date-range filter), starting from the previous
// animated value rather than 0 every time.
function useCountUp(target, durationMs) {
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  const rafRef = useRef(null);
  useEffect(() => {
    const from = fromRef.current;
    const to = Number(target) || 0;
    if (from === to) return undefined;
    const start = performance.now();
    const duration = durationMs || 700;
    function tick(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      const current = from + (to - from) * eased;
      setDisplay(current);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = to;
      }
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  return display;
}

function StatTile({ icon, tone, value, label, format }) {
  const animated = useCountUp(value);
  const text = format ? format(animated) : Math.round(animated).toLocaleString();
  return (
    <div className={'restaurants-stat-tile restaurants-stat-tile-' + tone}>
      <span className="restaurants-stat-icon">{STAT_ICONS[icon]}</span>
      <div className="restaurants-stat-text">
        <div className="restaurants-stat-value">{text}</div>
        <div className="restaurants-stat-label">{label}</div>
      </div>
    </div>
  );
}

export default function RestaurantsPage() {
  const { can } = useAuth();
  const canManage = can('restaurant.manage');

  const [departments, setDepartments] = useState([]);
  // companies (departments.service.js) don't carry the company's short
  // code, only its full name — fetched once, separately, just to map the
  // selected company to its restaurantLogos.js logo (SBR/BGN/BPL).
  const [companyCodeById, setCompanyCodeById] = useState({});
  const [companyId, setCompanyId] = useState('');
  const [tab, setTab] = useState('menu'); // 'menu' | 'supplies' | 'ingredients' | 'sales' | 'drawer' | 'tables' | 'guests'
  const [search, setSearch] = useState('');

  const [menuItems, setMenuItems] = useState([]);
  const [supplies, setSupplies] = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [tables, setTables] = useState([]);
  const [guests, setGuests] = useState([]);
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
  // Photo for the POS till grid (Restaurant module photo feature) — a File
  // picked in this dialog, plus whatever should currently preview (the
  // item's existing photoUrl, a fresh object URL for a just-picked file,
  // or null). Uploaded separately from the base fields, after they save,
  // since a brand-new item has no id to attach a photo to until then.
  const [menuPhotoFile, setMenuPhotoFile] = useState(null);
  const [menuPhotoPreview, setMenuPhotoPreview] = useState(null);
  const [menuPhotoRemoved, setMenuPhotoRemoved] = useState(false);

  // Named price variations (Square-style: one dish, several named options
  // each with its own price) — only manageable once the item itself has
  // been saved and has an id, so this mini add/edit form lives inside the
  // same "Edit menu item" dialog rather than its own separate dialog.
  const [variationEditId, setVariationEditId] = useState(null);
  const [variationForm, setVariationForm] = useState({ name: '', price: '' });
  const [variationError, setVariationError] = useState(null);
  const [variationSaving, setVariationSaving] = useState(false);

  const [supplyDialogOpen, setSupplyDialogOpen] = useState(false);
  const [supplyEditId, setSupplyEditId] = useState(null);
  const [supplyForm, setSupplyForm] = useState(EMPTY_SUPPLY_FORM);
  const [supplyDialogError, setSupplyDialogError] = useState(null);
  const [supplySaving, setSupplySaving] = useState(false);

  const [tableDialogOpen, setTableDialogOpen] = useState(false);
  const [tableEditId, setTableEditId] = useState(null);
  const [tableForm, setTableForm] = useState(EMPTY_TABLE_FORM);
  const [tableDialogError, setTableDialogError] = useState(null);
  const [tableSaving, setTableSaving] = useState(false);

  const [guestDialogOpen, setGuestDialogOpen] = useState(false);
  const [guestEditId, setGuestEditId] = useState(null);
  const [guestForm, setGuestForm] = useState(EMPTY_GUEST_FORM);
  const [guestDialogError, setGuestDialogError] = useState(null);
  const [guestSaving, setGuestSaving] = useState(false);

  const [ingredientDialogOpen, setIngredientDialogOpen] = useState(false);
  const [ingredientEditId, setIngredientEditId] = useState(null);
  const [ingredientForm, setIngredientForm] = useState(EMPTY_INGREDIENT_FORM);
  const [ingredientDialogError, setIngredientDialogError] = useState(null);
  const [ingredientSaving, setIngredientSaving] = useState(false);

  // { kind: 'supply'|'ingredient', id, name, stockQty, delta, note }
  const [stockDialog, setStockDialog] = useState(null);
  const [stockDialogError, setStockDialogError] = useState(null);
  const [stockSaving, setStockSaving] = useState(false);

  // Menu category groups collapse/expand (animated — see
  // .restaurants-menu-group-body's grid-template-rows transition in the
  // CSS); open by default so collapsing is an option, not a default that
  // hides items someone expects to see.
  const [collapsedCategories, setCollapsedCategories] = useState(() => new Set());
  function toggleCategory(category) {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category); else next.add(category);
      return next;
    });
  }

  // Flashes a brief highlight on the row/card just edited or voided, so the
  // eye catches what changed instead of a save just silently landing.
  const [flashId, setFlashId] = useState(null);
  function flash(id) {
    setFlashId(id);
    setTimeout(() => setFlashId((cur) => (cur === id ? null : cur)), 1000);
  }

  // Order detail — items are fetched lazily per-order (see getOrder in
  // restaurantPos.service.js), not preloaded for every row in the list:
  // at Square-import scale that would mean fetching line items for
  // thousands of orders nobody ever opens. orderDetailOpen controls the
  // dialog independently of orderDetail so it can show a loading state
  // before the fetch resolves, rather than staying closed until then.
  const [orderDetailOpen, setOrderDetailOpen] = useState(false);
  const [orderDetail, setOrderDetail] = useState(null);
  const [orderDetailLoading, setOrderDetailLoading] = useState(false);
  const [orderDetailError, setOrderDetailError] = useState(null);
  async function openOrderDetail(id) {
    setOrderDetailOpen(true);
    setOrderDetail(null);
    setOrderDetailError(null);
    setOrderDetailLoading(true);
    try {
      setOrderDetail(await api.get('/restaurant/orders/' + id));
    } catch (err) {
      setOrderDetailError(err.message);
    } finally {
      setOrderDetailLoading(false);
    }
  }

  // Same "derive companies from departments" pattern already used by
  // Tasks/Attendance/Payroll/Leave's company filters.
  const companies = useMemo(() => {
    const seen = new Map();
    departments.forEach((d) => { if (!seen.has(d.companyId)) seen.set(d.companyId, { id: d.companyId, name: d.companyName }); });
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [departments]);

  // The menu-item dialog's own variations list always reflects the latest
  // load() response (re-fetched after every add/edit/remove below), not a
  // stale copy grabbed when the dialog opened.
  const editingMenuItemVariations = useMemo(() => {
    const item = menuItems.find((m) => m.id === menuEditId);
    return (item && item.variations) || [];
  }, [menuItems, menuEditId]);

  const load = useCallback(async (forCompanyId) => {
    setError(null);
    try {
      const qs = forCompanyId ? '?companyId=' + forCompanyId : '';
      const [menu, sup, ing, tbl, gst] = await Promise.all([
        api.get('/restaurant/menu-items' + qs),
        api.get('/restaurant/supplies' + qs),
        api.get('/restaurant/ingredients' + qs),
        api.get('/restaurant/tables' + qs),
        api.get('/restaurant/guests' + qs)
      ]);
      setMenuItems(menu);
      setSupplies(sup);
      setIngredients(ing);
      setTables(tbl);
      setGuests(gst);
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
  const [ordersRevenueTotal, setOrdersRevenueTotal] = useState(0);
  const [ordersVoidedCount, setOrdersVoidedCount] = useState(0);
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
      setOrdersRevenueTotal(res.revenueTotal);
      setOrdersVoidedCount(res.voidedCount);
    } catch (err) {
      setError(err.message);
    } finally {
      setOrdersLoading(false);
    }
  }, []);

  // Drawer sessions — same server-paginated, from/to-filtered shape as
  // Sales above (restaurantPos.service.js's listDrawerSessions), just a
  // much smaller table in practice (one row per shift, not per sale).
  const DRAWER_PAGE_SIZE = 50;
  const [drawerSessions, setDrawerSessions] = useState([]);
  const [drawerSessionsOffset, setDrawerSessionsOffset] = useState(0);
  const [drawerSessionsTotal, setDrawerSessionsTotal] = useState(0);
  const [drawerSessionsFrom, setDrawerSessionsFrom] = useState('');
  const [drawerSessionsTo, setDrawerSessionsTo] = useState('');
  const [drawerSessionsLoading, setDrawerSessionsLoading] = useState(false);

  const loadDrawerSessions = useCallback(async (forCompanyId, offset, from, to) => {
    if (!forCompanyId) return;
    setDrawerSessionsLoading(true);
    try {
      const params = new URLSearchParams({ companyId: forCompanyId, limit: DRAWER_PAGE_SIZE, offset });
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const res = await api.get('/restaurant/drawer-sessions?' + params.toString());
      setDrawerSessions(res.sessions);
      setDrawerSessionsTotal(res.total);
    } catch (err) {
      setError(err.message);
    } finally {
      setDrawerSessionsLoading(false);
    }
  }, []);

  const [drawerDetailOpen, setDrawerDetailOpen] = useState(false);
  const [drawerDetail, setDrawerDetail] = useState(null);
  const [drawerDetailLoading, setDrawerDetailLoading] = useState(false);
  const [drawerDetailError, setDrawerDetailError] = useState(null);
  async function openDrawerDetail(id) {
    setDrawerDetailOpen(true);
    setDrawerDetail(null);
    setDrawerDetailError(null);
    setDrawerDetailLoading(true);
    try {
      setDrawerDetail(await api.get('/restaurant/drawer-sessions/' + id));
    } catch (err) {
      setDrawerDetailError(err.message);
    } finally {
      setDrawerDetailLoading(false);
    }
  }

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
    (async () => {
      try {
        const list = await api.get('/companies');
        setCompanyCodeById(Object.fromEntries(list.map((c) => [c.id, c.code])));
      } catch { /* logo is cosmetic — a failed fetch just means no logo shows */ }
    })();
  }, []);

  useEffect(() => {
    if (!companyId && companies.length) { setCompanyId(companies[0].id); return; }
    if (companyId) load(companyId);
    setSquareResult(null);
    setSquareError(null);
    setOrdersOffset(0);
    setDrawerSessionsOffset(0);
  }, [companyId, companies, load]);

  useEffect(() => {
    if (tab === 'sales' && companyId) loadOrders(companyId, ordersOffset, ordersFrom, ordersTo);
  }, [tab, companyId, ordersOffset, ordersFrom, ordersTo, loadOrders]);

  useEffect(() => {
    if (tab === 'drawer' && companyId) loadDrawerSessions(companyId, drawerSessionsOffset, drawerSessionsFrom, drawerSessionsTo);
  }, [tab, companyId, drawerSessionsOffset, drawerSessionsFrom, drawerSessionsTo, loadDrawerSessions]);

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
    setMenuPhotoFile(null);
    setMenuPhotoPreview(null);
    setMenuPhotoRemoved(false);
    setVariationEditId(null);
    setVariationForm({ name: '', price: '' });
    setVariationError(null);
    setMenuDialogOpen(true);
  }
  function openEditMenuItem(m) {
    setMenuDialogError(null);
    setMenuEditId(m.id);
    setMenuForm({ name: m.name, category: m.category, price: m.price });
    setMenuPhotoFile(null);
    setMenuPhotoPreview(m.photoUrl ? API_ORIGIN + m.photoUrl : null);
    setMenuPhotoRemoved(false);
    setVariationEditId(null);
    setVariationForm({ name: '', price: '' });
    setVariationError(null);
    setMenuDialogOpen(true);
  }
  function pickMenuPhoto(file) {
    if (!file) return;
    setMenuPhotoFile(file);
    setMenuPhotoRemoved(false);
    setMenuPhotoPreview(URL.createObjectURL(file));
  }
  function clearMenuPhoto() {
    setMenuPhotoFile(null);
    setMenuPhotoPreview(null);
    setMenuPhotoRemoved(true);
  }
  async function submitMenuForm(e) {
    e.preventDefault();
    setMenuSaving(true);
    setMenuDialogError(null);
    try {
      const saved = menuEditId ? await api.put('/restaurant/menu-items/' + menuEditId, menuForm) : await api.post('/restaurant/menu-items', { ...menuForm, companyId });
      if (menuPhotoFile) {
        const body = new FormData();
        body.append('file', menuPhotoFile);
        await api.upload('/restaurant/menu-items/' + saved.id + '/photo', body);
      } else if (menuPhotoRemoved && menuEditId) {
        await api.del('/restaurant/menu-items/' + saved.id + '/photo');
      }
      setToast(menuEditId ? 'Menu item updated.' : 'Menu item added.');
      setMenuDialogOpen(false);
      await load(companyId);
      flash(saved.id);
    } catch (err) {
      setMenuDialogError(err.message);
    } finally {
      setMenuSaving(false);
    }
  }

  function startAddVariation() {
    setVariationEditId(null);
    setVariationForm({ name: '', price: '' });
    setVariationError(null);
  }
  function startEditVariation(v) {
    setVariationEditId(v.id);
    setVariationForm({ name: v.name, price: v.price });
    setVariationError(null);
  }
  async function submitVariationForm() {
    if (!variationForm.name.trim()) { setVariationError('Name a variation before adding it.'); return; }
    setVariationSaving(true);
    setVariationError(null);
    try {
      if (variationEditId) await api.put('/restaurant/menu-items/' + menuEditId + '/variations/' + variationEditId, variationForm);
      else await api.post('/restaurant/menu-items/' + menuEditId + '/variations', variationForm);
      setVariationEditId(null);
      setVariationForm({ name: '', price: '' });
      await load(companyId);
    } catch (err) {
      setVariationError(err.message);
    } finally {
      setVariationSaving(false);
    }
  }
  async function deleteVariation(v) {
    setBusyId(v.id);
    try {
      await api.del('/restaurant/menu-items/' + menuEditId + '/variations/' + v.id);
      await load(companyId);
    } catch (err) {
      setVariationError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function toggleMenuActive(m) {
    setBusyId(m.id);
    try {
      await api.post('/restaurant/menu-items/' + m.id + '/active', { active: !m.active });
      await load(companyId);
      flash(m.id);
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

  // ── tables ──────────────────────────────────────────────────────────
  function openNewTable() {
    setTableDialogError(null);
    setTableEditId(null);
    setTableForm(EMPTY_TABLE_FORM);
    setTableDialogOpen(true);
  }
  function openEditTable(t) {
    setTableDialogError(null);
    setTableEditId(t.id);
    setTableForm({ name: t.name });
    setTableDialogOpen(true);
  }
  async function submitTableForm(e) {
    e.preventDefault();
    setTableSaving(true);
    setTableDialogError(null);
    try {
      if (tableEditId) await api.put('/restaurant/tables/' + tableEditId, tableForm);
      else await api.post('/restaurant/tables', { ...tableForm, companyId });
      setToast(tableEditId ? 'Table updated.' : 'Table added.');
      setTableDialogOpen(false);
      await load(companyId);
    } catch (err) {
      setTableDialogError(err.message);
    } finally {
      setTableSaving(false);
    }
  }
  async function toggleTableActive(t) {
    setBusyId(t.id);
    try {
      await api.post('/restaurant/tables/' + t.id + '/active', { active: t.status !== 'active' });
      setToast(t.status === 'active' ? 'Table archived.' : 'Table reactivated.');
      await load(companyId);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }
  async function deleteTable(t) {
    setBusyId(t.id);
    try {
      await api.del('/restaurant/tables/' + t.id);
      setToast('Table removed.');
      await load(companyId);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  // ── guests ──────────────────────────────────────────────────────────
  function openNewGuest() {
    setGuestDialogError(null);
    setGuestEditId(null);
    setGuestForm(EMPTY_GUEST_FORM);
    setGuestDialogOpen(true);
  }
  function openEditGuest(g) {
    setGuestDialogError(null);
    setGuestEditId(g.id);
    setGuestForm({ name: g.name, phone: g.phone, notes: g.notes });
    setGuestDialogOpen(true);
  }
  async function submitGuestForm(e) {
    e.preventDefault();
    setGuestSaving(true);
    setGuestDialogError(null);
    try {
      if (guestEditId) await api.put('/restaurant/guests/' + guestEditId, guestForm);
      else await api.post('/restaurant/guests', { ...guestForm, companyId });
      setToast(guestEditId ? 'Guest updated.' : 'Guest added.');
      setGuestDialogOpen(false);
      await load(companyId);
    } catch (err) {
      setGuestDialogError(err.message);
    } finally {
      setGuestSaving(false);
    }
  }
  async function deleteGuest(g) {
    setBusyId(g.id);
    try {
      await api.del('/restaurant/guests/' + g.id);
      setToast('Guest removed.');
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
      flash(o.id);
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
  const visibleTables = tables.filter((t) => matchesQuery(search, t.name));
  const visibleGuests = guests.filter((g) => matchesQuery(search, g.name, g.phone));

  // Menu items already come back sorted by category, name (see
  // restaurant.service.js's listMenuItems) — grouping into a Map preserves
  // that order, so categories appear in the same order the card grid below
  // renders them, no extra client-side sort needed.
  const menuGroups = [];
  const menuGroupIndex = new Map();
  visibleMenuItems.forEach((m) => {
    if (!menuGroupIndex.has(m.category)) { menuGroupIndex.set(m.category, menuGroups.length); menuGroups.push({ category: m.category, items: [] }); }
    menuGroups[menuGroupIndex.get(m.category)].items.push(m);
  });

  const menuStats = { total: menuItems.length, active: menuItems.filter((m) => m.active).length, categories: new Set(menuItems.map((m) => m.category)).size };
  const supplyStats = { total: supplies.length, lowStock: supplies.filter((s) => s.lowStock).length };
  const ingredientStats = { total: ingredients.length, lowStock: ingredients.filter((i) => i.lowStock).length, expiringSoon: ingredients.filter((i) => i.expiringSoon).length };

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
          {restaurantLogoUrl(companyCodeById[companyId]) && (
            <img
              className="restaurants-brand-logo"
              src={restaurantLogoUrl(companyCodeById[companyId])}
              alt={companies.find((c) => c.id === companyId)?.name || ''}
            />
          )}
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
              {[{ key: 'menu', label: 'Menu' }, { key: 'supplies', label: 'Supplies' }, { key: 'ingredients', label: 'Food' }, { key: 'sales', label: 'Sales' }, { key: 'drawer', label: 'Drawer' }, { key: 'tables', label: 'Tables' }, { key: 'guests', label: 'Guests' }].map((opt) => (
                <label className="seg-opt" key={opt.key}>
                  <input type="radio" name="restaurant-tab" checked={tab === opt.key} onChange={() => setTab(opt.key)} />
                  <span>{opt.label}</span>
                </label>
              ))}
            </div>
            {tab !== 'sales' && tab !== 'drawer' && (
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
            {tab === 'drawer' && (
              <div className="restaurants-date-filter">
                <input type="date" className="input" value={drawerSessionsFrom} onChange={(e) => { setDrawerSessionsFrom(e.target.value); setDrawerSessionsOffset(0); }} aria-label="From date" />
                <span>to</span>
                <input type="date" className="input" value={drawerSessionsTo} onChange={(e) => { setDrawerSessionsTo(e.target.value); setDrawerSessionsOffset(0); }} aria-label="To date" />
                {(drawerSessionsFrom || drawerSessionsTo) && (
                  <button type="button" className="btn btn-secondary restaurants-row-btn" onClick={() => { setDrawerSessionsFrom(''); setDrawerSessionsTo(''); setDrawerSessionsOffset(0); }}>Clear</button>
                )}
              </div>
            )}
            {canManage && tab === 'menu' && <button type="button" className="btn btn-primary" onClick={openNewMenuItem}>Add menu item</button>}
            {canManage && tab === 'supplies' && <button type="button" className="btn btn-primary" onClick={openNewSupply}>Add supply</button>}
            {canManage && tab === 'ingredients' && <button type="button" className="btn btn-primary" onClick={openNewIngredient}>Add ingredient</button>}
            {canManage && tab === 'tables' && <button type="button" className="btn btn-primary" onClick={openNewTable}>Add table</button>}
            {canManage && tab === 'guests' && <button type="button" className="btn btn-primary" onClick={openNewGuest}>Add guest</button>}
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

          <div key={tab} className="restaurants-tab-content">
          {tab === 'menu' && (
            <div className="restaurants-stats">
              <StatTile icon="list" tone="people" value={menuStats.total} label="Menu items" />
              <StatTile icon="check" tone="people" value={menuStats.active} label="Active" />
              <StatTile icon="tag" tone="ops" value={menuStats.categories} label="Categories" />
            </div>
          )}
          {tab === 'supplies' && (
            <div className="restaurants-stats">
              <StatTile icon="list" tone="people" value={supplyStats.total} label="Supplies tracked" />
              <StatTile icon="alert" tone="warning" value={supplyStats.lowStock} label="Low stock" />
            </div>
          )}
          {tab === 'ingredients' && (
            <div className="restaurants-stats">
              <StatTile icon="list" tone="people" value={ingredientStats.total} label="Ingredients tracked" />
              <StatTile icon="alert" tone="warning" value={ingredientStats.lowStock} label="Low stock" />
              <StatTile icon="clock" tone="danger" value={ingredientStats.expiringSoon} label="Expiring soon" />
            </div>
          )}
          {tab === 'sales' && ordersTotal > 0 && (
            <div className="restaurants-stats restaurants-stats-wide">
              <StatTile icon="list" tone="people" value={ordersTotal} label={(ordersFrom || ordersTo) ? 'Orders in range' : 'Orders'} />
              <StatTile icon="money" tone="ops" value={ordersRevenueTotal} format={money} label={(ordersFrom || ordersTo) ? 'Revenue in range' : 'Revenue'} />
              <StatTile icon="ban" tone="danger" value={ordersVoidedCount} label="Voided" />
            </div>
          )}
          {tab === 'drawer' && drawerSessionsTotal > 0 && (
            <div className="restaurants-stats restaurants-stats-wide">
              <StatTile icon="list" tone="people" value={drawerSessionsTotal} label={(drawerSessionsFrom || drawerSessionsTo) ? 'Sessions in range' : 'Sessions'} />
              <StatTile icon="clock" tone="ops" value={drawerSessions.filter((s) => s.session.status === 'open').length} label="Open now (this page)" />
              <StatTile icon="ban" tone="danger" value={drawerSessions.filter((s) => s.difference != null && Math.abs(s.difference) > 0.01).length} label="With a discrepancy (this page)" />
            </div>
          )}

          {tab === 'menu' && menuGroups.map((group) => {
            const isCollapsed = collapsedCategories.has(group.category);
            return (
              <div className="restaurants-menu-group" key={group.category}>
                <button type="button" className="restaurants-menu-category" onClick={() => toggleCategory(group.category)} aria-expanded={!isCollapsed}>
                  <svg className={'restaurants-menu-category-chevron' + (isCollapsed ? ' restaurants-menu-category-chevron-collapsed' : '')} viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {group.category}
                  <span className="restaurants-menu-category-count">{group.items.length}</span>
                </button>
                <div className={'restaurants-menu-group-body' + (isCollapsed ? ' restaurants-menu-group-collapsed' : '')}>
                  <div className="restaurants-menu-group-body-inner">
                    <div className="restaurants-menu-grid">
                      {group.items.map((m) => (
                        <div className={'restaurants-menu-card' + (flashId === m.id ? ' restaurants-flash' : '')} key={m.id}>
                          {m.photoUrl && <img className="restaurants-menu-card-photo" src={API_ORIGIN + m.photoUrl} alt="" loading="lazy" />}
                          <div className="restaurants-menu-card-top">
                            <span className="restaurants-menu-card-name">{m.name}</span>
                            <span className={'tag ' + (m.active ? 'tag-neutral' : 'tag-outline')}>{m.active ? 'Active' : 'Disabled'}</span>
                          </div>
                          <div className="restaurants-menu-card-price">{money(m.price)}</div>
                          {canManage && (
                            <div className="restaurants-menu-card-actions">
                              <button type="button" className="btn btn-secondary restaurants-row-btn" onClick={() => openEditMenuItem(m)}>Edit</button>
                              <button type="button" className="btn btn-secondary restaurants-row-btn" disabled={busyId === m.id} onClick={() => toggleMenuActive(m)}>{m.active ? 'Disable' : 'Enable'}</button>
                              <button type="button" className="btn btn-secondary restaurants-row-btn" disabled={busyId === m.id} onClick={() => deleteMenuItem(m)}>Delete</button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}

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

          {tab === 'tables' && (
            <table className="table">
              <thead><tr><th>Name</th><th>Status</th><th /></tr></thead>
              <tbody>
                {visibleTables.map((t) => (
                  <tr key={t.id}>
                    <td style={{ fontWeight: 600 }}>{t.name}</td>
                    <td><span className={'tag ' + (t.status === 'active' ? 'tag-neutral' : 'tag-outline')}>{t.status}</span></td>
                    <td className="table-actions">
                      {canManage && <button type="button" className="btn btn-secondary restaurants-row-btn" onClick={() => openEditTable(t)}>Rename</button>}
                      {canManage && <button type="button" className="btn btn-secondary restaurants-row-btn" disabled={busyId === t.id} onClick={() => toggleTableActive(t)}>{t.status === 'active' ? 'Archive' : 'Reactivate'}</button>}
                      {canManage && <button type="button" className="btn btn-secondary restaurants-row-btn" disabled={busyId === t.id} onClick={() => deleteTable(t)}>Delete</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {tab === 'guests' && (
            <table className="table">
              <thead><tr><th>Name</th><th>Phone</th><th>Notes</th><th /></tr></thead>
              <tbody>
                {visibleGuests.map((g) => (
                  <tr key={g.id}>
                    <td style={{ fontWeight: 600 }}>{g.name}</td>
                    <td>{g.phone || '—'}</td>
                    <td>{g.notes || '—'}</td>
                    <td className="table-actions">
                      {canManage && <button type="button" className="btn btn-secondary restaurants-row-btn" onClick={() => openEditGuest(g)}>Edit</button>}
                      {canManage && <button type="button" className="btn btn-secondary restaurants-row-btn" disabled={busyId === g.id} onClick={() => deleteGuest(g)}>Delete</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {tab === 'sales' && (
            <>
              <table className="table restaurants-sales-table" style={{ opacity: ordersLoading ? 0.6 : 1 }}>
                <thead><tr><th>Order</th><th>Cashier</th><th>Table</th><th>Waiter</th><th className="restaurants-amount-col">Total</th><th>Payment</th><th>Status</th><th>Time</th><th /></tr></thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id} className={'restaurants-sales-row' + (o.status === 'voided' ? ' restaurants-sales-row-voided' : '') + (flashId === o.id ? ' restaurants-flash' : '')} onClick={() => openOrderDetail(o.id)}>
                      <td className="restaurants-order-no">{o.orderNo}</td>
                      <td>{o.cashierName}</td>
                      <td>{o.tableName || '—'}</td>
                      <td>{o.waiterName || '—'}</td>
                      <td className="restaurants-amount-col restaurants-amount">{money(o.total)}</td>
                      <td><span className="tag tag-neutral">{o.paymentMethod.replace('_', ' ')}</span></td>
                      <td><span className={'tag ' + (o.status === 'voided' ? 'tag-accent' : 'tag-neutral')}>{o.status}</span></td>
                      <td className="restaurants-time">{new Date(o.createdAt).toLocaleString()}</td>
                      <td className="table-actions">
                        {canManage && o.status === 'completed' && (
                          <button type="button" className="btn btn-secondary restaurants-row-btn" disabled={busyId === o.id} onClick={(e) => { e.stopPropagation(); voidOrderAction(o); }}>Void</button>
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

          {tab === 'drawer' && (
            <>
              <table className="table restaurants-sales-table" style={{ opacity: drawerSessionsLoading ? 0.6 : 1 }}>
                <thead>
                  <tr>
                    <th>Cashier</th><th>Opened</th><th>Closed</th>
                    <th className="restaurants-amount-col">Starting</th><th className="restaurants-amount-col">Cash Sales</th>
                    <th className="restaurants-amount-col">Paid In/Out</th><th className="restaurants-amount-col">Expected</th>
                    <th className="restaurants-amount-col">Actual</th><th className="restaurants-amount-col">Difference</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {drawerSessions.map((s) => (
                    <tr key={s.session.id} className="restaurants-sales-row" onClick={() => openDrawerDetail(s.session.id)}>
                      <td style={{ fontWeight: 600 }}>{s.cashierName}</td>
                      <td className="restaurants-time">{new Date(s.session.openedAt).toLocaleString()}</td>
                      <td className="restaurants-time">{s.session.closedAt ? new Date(s.session.closedAt).toLocaleString() : '—'}</td>
                      <td className="restaurants-amount-col restaurants-amount">{money(s.startingCash)}</td>
                      <td className="restaurants-amount-col restaurants-amount">{money(s.cashSales)}</td>
                      <td className="restaurants-amount-col restaurants-amount">{s.netPaidInOut < 0 ? '-' : ''}{money(Math.abs(s.netPaidInOut))}</td>
                      <td className="restaurants-amount-col restaurants-amount">{money(s.expected)}</td>
                      <td className="restaurants-amount-col restaurants-amount">{s.actual == null ? '—' : money(s.actual)}</td>
                      <td className="restaurants-amount-col restaurants-amount">
                        {s.difference == null ? '—' : (
                          <span className={Math.abs(s.difference) > 0.01 ? 'tag tag-accent' : ''}>
                            {s.difference < 0 ? '-' : ''}{money(Math.abs(s.difference))}
                          </span>
                        )}
                      </td>
                      <td><span className={'tag ' + (s.session.status === 'open' ? 'tag-outline' : 'tag-neutral')}>{s.session.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {drawerSessionsTotal > 0 && (
                <div className="restaurants-pager">
                  <span>{drawerSessionsOffset + 1}–{Math.min(drawerSessionsOffset + DRAWER_PAGE_SIZE, drawerSessionsTotal)} of {drawerSessionsTotal.toLocaleString()}</span>
                  <button type="button" className="btn btn-secondary restaurants-row-btn" disabled={drawerSessionsOffset === 0 || drawerSessionsLoading} onClick={() => setDrawerSessionsOffset(Math.max(0, drawerSessionsOffset - DRAWER_PAGE_SIZE))}>Previous</button>
                  <button type="button" className="btn btn-secondary restaurants-row-btn" disabled={drawerSessionsOffset + DRAWER_PAGE_SIZE >= drawerSessionsTotal || drawerSessionsLoading} onClick={() => setDrawerSessionsOffset(drawerSessionsOffset + DRAWER_PAGE_SIZE)}>Next</button>
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
          {tab === 'tables' && !tables.length && (
            <div className="restaurants-empty-state"><span className="restaurants-empty-icon"><UtensilsIcon /></span><p className="restaurants-empty-title">No tables set up yet</p></div>
          )}
          {tab === 'tables' && !!tables.length && !visibleTables.length && (
            <div className="restaurants-empty-state"><span className="restaurants-empty-icon"><UtensilsIcon /></span><p className="restaurants-empty-title">No tables match "{search}"</p></div>
          )}
          {tab === 'guests' && !guests.length && (
            <div className="restaurants-empty-state"><span className="restaurants-empty-icon"><UtensilsIcon /></span><p className="restaurants-empty-title">No guests saved yet</p></div>
          )}
          {tab === 'guests' && !!guests.length && !visibleGuests.length && (
            <div className="restaurants-empty-state"><span className="restaurants-empty-icon"><UtensilsIcon /></span><p className="restaurants-empty-title">No guests match "{search}"</p></div>
          )}
          {tab === 'sales' && !ordersLoading && !orders.length && (ordersFrom || ordersTo) && (
            <div className="restaurants-empty-state"><span className="restaurants-empty-icon"><UtensilsIcon /></span><p className="restaurants-empty-title">No sales in that date range</p></div>
          )}
          {tab === 'sales' && !ordersLoading && !orders.length && !ordersFrom && !ordersTo && (
            <div className="restaurants-empty-state"><span className="restaurants-empty-icon"><UtensilsIcon /></span><p className="restaurants-empty-title">No sales yet — rung-up orders from the till will show here</p></div>
          )}
          {tab === 'drawer' && !drawerSessionsLoading && !drawerSessions.length && (drawerSessionsFrom || drawerSessionsTo) && (
            <div className="restaurants-empty-state"><span className="restaurants-empty-icon"><UtensilsIcon /></span><p className="restaurants-empty-title">No drawer sessions in that date range</p></div>
          )}
          {tab === 'drawer' && !drawerSessionsLoading && !drawerSessions.length && !drawerSessionsFrom && !drawerSessionsTo && (
            <div className="restaurants-empty-state"><span className="restaurants-empty-icon"><UtensilsIcon /></span><p className="restaurants-empty-title">No drawer sessions yet — opened/closed on the till, they'll show here</p></div>
          )}
          </div>
        </>
      )}

      {menuDialogOpen && (
        <div className="dialog-backdrop restaurants-dialog-backdrop" onClick={() => setMenuDialogOpen(false)}>
          <form className="dialog restaurants-dialog-pop" onClick={(e) => e.stopPropagation()} onSubmit={submitMenuForm}>
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
              <label htmlFor="rm-price">Price{!!editingMenuItemVariations.length && ' (fallback — sold price comes from the variation below)'}</label>
              <input id="rm-price" className="input" type="number" min="0" step="0.01" value={menuForm.price} onChange={(e) => setMenuForm({ ...menuForm, price: e.target.value })} required />
            </div>
            {menuEditId && (
              <div className="field restaurants-variations-field">
                <label>Price variations (optional — e.g. "M" ₵98 vs "Jellyfish" ₵238)</label>
                {!!editingMenuItemVariations.length && (
                  <div className="restaurants-variations-list">
                    {editingMenuItemVariations.map((v) => (
                      <div key={v.id} className="restaurants-variation-row">
                        <span className="restaurants-variation-name">{v.name}</span>
                        <span className="restaurants-variation-price">{money(v.price)}</span>
                        <button type="button" className="btn btn-secondary restaurants-row-btn" onClick={() => startEditVariation(v)}>Edit</button>
                        <button type="button" className="btn btn-secondary restaurants-row-btn" disabled={busyId === v.id} onClick={() => deleteVariation(v)}>Remove</button>
                      </div>
                    ))}
                  </div>
                )}
                {variationError && <div className="error-banner">{variationError}</div>}
                <div className="restaurants-variation-add">
                  <input className="input" placeholder="Name (e.g. M, Large, Jellyfish…)" value={variationForm.name} onChange={(e) => setVariationForm({ ...variationForm, name: e.target.value })} />
                  <input className="input" type="number" min="0" step="0.01" placeholder="Price" value={variationForm.price} onChange={(e) => setVariationForm({ ...variationForm, price: e.target.value })} />
                  <button type="button" className="btn btn-secondary restaurants-row-btn" disabled={variationSaving} onClick={submitVariationForm}>
                    {variationEditId ? 'Save' : 'Add'}
                  </button>
                  {variationEditId && <button type="button" className="btn btn-secondary restaurants-row-btn" onClick={startAddVariation}>Cancel</button>}
                </div>
              </div>
            )}
            {!menuEditId && (
              <p className="restaurants-variations-hint">Save this item first, then reopen it here to add price variations.</p>
            )}
            <div className="field">
              <label htmlFor="rm-photo">Photo (shown on the POS till)</label>
              {menuPhotoPreview && <img className="restaurants-menu-photo-preview" src={menuPhotoPreview} alt="" />}
              <div className="restaurants-menu-photo-actions">
                <input id="rm-photo" type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => pickMenuPhoto(e.target.files[0])} />
                {menuPhotoPreview && <button type="button" className="btn btn-secondary restaurants-row-btn" onClick={clearMenuPhoto}>Remove photo</button>}
              </div>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setMenuDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={menuSaving}>{menuEditId ? 'Save changes' : 'Add item'}</button>
            </div>
          </form>
        </div>
      )}

      {supplyDialogOpen && (
        <div className="dialog-backdrop restaurants-dialog-backdrop" onClick={() => setSupplyDialogOpen(false)}>
          <form className="dialog restaurants-dialog-pop" onClick={(e) => e.stopPropagation()} onSubmit={submitSupplyForm}>
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

      {tableDialogOpen && (
        <div className="dialog-backdrop restaurants-dialog-backdrop" onClick={() => setTableDialogOpen(false)}>
          <form className="dialog restaurants-dialog-pop" onClick={(e) => e.stopPropagation()} onSubmit={submitTableForm}>
            <h2>{tableEditId ? 'Rename table' : 'Add table'}</h2>
            {tableDialogError && <div className="error-banner">{tableDialogError}</div>}
            <div className="field">
              <label htmlFor="rt-name">Name</label>
              <input id="rt-name" className="input" value={tableForm.name} onChange={(e) => setTableForm({ ...tableForm, name: e.target.value })} placeholder="Table 5, Bar, Patio 3…" required />
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setTableDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={tableSaving}>{tableEditId ? 'Save changes' : 'Add table'}</button>
            </div>
          </form>
        </div>
      )}

      {guestDialogOpen && (
        <div className="dialog-backdrop restaurants-dialog-backdrop" onClick={() => setGuestDialogOpen(false)}>
          <form className="dialog restaurants-dialog-pop" onClick={(e) => e.stopPropagation()} onSubmit={submitGuestForm}>
            <h2>{guestEditId ? 'Edit guest' : 'Add guest'}</h2>
            {guestDialogError && <div className="error-banner">{guestDialogError}</div>}
            <div className="field">
              <label htmlFor="rg-name">Name</label>
              <input id="rg-name" className="input" value={guestForm.name} onChange={(e) => setGuestForm({ ...guestForm, name: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="rg-phone">Phone</label>
              <input id="rg-phone" className="input" value={guestForm.phone} onChange={(e) => setGuestForm({ ...guestForm, phone: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="rg-notes">Notes</label>
              <input id="rg-notes" className="input" value={guestForm.notes} onChange={(e) => setGuestForm({ ...guestForm, notes: e.target.value })} placeholder="Allergies, preferences…" />
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setGuestDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={guestSaving}>{guestEditId ? 'Save changes' : 'Add guest'}</button>
            </div>
          </form>
        </div>
      )}

      {ingredientDialogOpen && (
        <div className="dialog-backdrop restaurants-dialog-backdrop" onClick={() => setIngredientDialogOpen(false)}>
          <form className="dialog restaurants-dialog-pop" onClick={(e) => e.stopPropagation()} onSubmit={submitIngredientForm}>
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
        <div className="dialog-backdrop restaurants-dialog-backdrop" onClick={() => setStockDialog(null)}>
          <form className="dialog restaurants-dialog-pop" onClick={(e) => e.stopPropagation()} onSubmit={submitStockDialog}>
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

      {orderDetailOpen && (
        <div className="dialog-backdrop restaurants-dialog-backdrop" onClick={() => setOrderDetailOpen(false)}>
          <div className="dialog restaurants-order-dialog restaurants-dialog-pop" onClick={(e) => e.stopPropagation()}>
            {orderDetailLoading && <div className="eyebrow">Loading…</div>}
            {orderDetailError && <div className="error-banner">{orderDetailError}</div>}
            {orderDetail && !orderDetailLoading && (
              <>
                <h2>{orderDetail.orderNo}</h2>
                <div className="restaurants-order-dialog-meta">
                  <span>{orderDetail.cashierName}</span>
                  <span>·</span>
                  <span>{new Date(orderDetail.createdAt).toLocaleString()}</span>
                  <span>·</span>
                  <span className={'tag ' + (orderDetail.status === 'voided' ? 'tag-accent' : 'tag-neutral')}>{orderDetail.status}</span>
                </div>
                <div className="restaurants-order-dialog-items">
                  {orderDetail.items.map((it, i) => (
                    <div className="restaurants-order-dialog-item" key={i}>
                      <span className="restaurants-order-dialog-item-qty">{it.qty}×</span>
                      <span className="restaurants-order-dialog-item-name">{it.name}</span>
                      <span className="restaurants-order-dialog-item-total">{money(it.lineTotal)}</span>
                    </div>
                  ))}
                </div>
                <div className="restaurants-order-dialog-total">
                  <span>Total</span>
                  <strong>{money(orderDetail.total)}</strong>
                </div>
                <div className="restaurants-order-dialog-meta">Paid by {orderDetail.paymentMethod.replace('_', ' ')}</div>
                {(orderDetail.tableName || orderDetail.waiterName || orderDetail.guestName) && (
                  <div className="restaurants-order-dialog-meta">
                    {orderDetail.tableName && <>Table: {orderDetail.tableName}</>}
                    {orderDetail.waiterName && <>{orderDetail.tableName ? ' · ' : ''}Waiter: {orderDetail.waiterName}</>}
                    {orderDetail.guestName && <>{(orderDetail.tableName || orderDetail.waiterName) ? ' · ' : ''}Guest: {orderDetail.guestName}{orderDetail.guestPhone ? ' (' + orderDetail.guestPhone + ')' : ''}</>}
                  </div>
                )}
              </>
            )}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setOrderDetailOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {drawerDetailOpen && (
        <div className="dialog-backdrop restaurants-dialog-backdrop" onClick={() => setDrawerDetailOpen(false)}>
          <div className="dialog restaurants-order-dialog restaurants-dialog-pop" onClick={(e) => e.stopPropagation()}>
            {drawerDetailLoading && <div className="eyebrow">Loading…</div>}
            {drawerDetailError && <div className="error-banner">{drawerDetailError}</div>}
            {drawerDetail && !drawerDetailLoading && (
              <>
                <h2>Drawer Report: {drawerDetail.cashierName}</h2>
                <div className="restaurants-order-dialog-meta">
                  <span>{new Date(drawerDetail.session.openedAt).toLocaleString()}</span>
                  <span>–</span>
                  <span>{drawerDetail.session.closedAt ? new Date(drawerDetail.session.closedAt).toLocaleString() : 'still open'}</span>
                  <span>·</span>
                  <span className={'tag ' + (drawerDetail.session.status === 'open' ? 'tag-outline' : 'tag-neutral')}>{drawerDetail.session.status}</span>
                </div>
                <div className="restaurants-order-dialog-items">
                  <div className="restaurants-order-dialog-item"><span className="restaurants-order-dialog-item-name">Starting Cash</span><span className="restaurants-order-dialog-item-total">{money(drawerDetail.startingCash)}</span></div>
                  <div className="restaurants-order-dialog-item"><span className="restaurants-order-dialog-item-name">Cash Sales</span><span className="restaurants-order-dialog-item-total">{money(drawerDetail.cashSales)}</span></div>
                  <div className="restaurants-order-dialog-item"><span className="restaurants-order-dialog-item-name">Cash Refunds</span><span className="restaurants-order-dialog-item-total">{money(drawerDetail.cashRefunds)}</span></div>
                  <div className="restaurants-order-dialog-item"><span className="restaurants-order-dialog-item-name">Paid In/Out</span><span className="restaurants-order-dialog-item-total">{drawerDetail.netPaidInOut < 0 ? '-' : ''}{money(Math.abs(drawerDetail.netPaidInOut))}</span></div>
                </div>
                <div className="restaurants-order-dialog-total">
                  <span>Expected in Drawer</span>
                  <strong>{money(drawerDetail.expected)}</strong>
                </div>
                <div className="restaurants-order-dialog-meta">
                  Actual in Drawer: {drawerDetail.actual == null ? '—' : money(drawerDetail.actual)}
                  {drawerDetail.difference != null && <> · Difference: {drawerDetail.difference < 0 ? '-' : ''}{money(Math.abs(drawerDetail.difference))}</>}
                </div>
                {drawerDetail.session.closingNote && <div className="restaurants-order-dialog-meta">Note: {drawerDetail.session.closingNote}</div>}
                {!!drawerDetail.movements.length && (
                  <>
                    <h3 style={{ fontSize: 13, margin: '14px 0 6px' }}>Paid In/Out</h3>
                    <div className="restaurants-order-dialog-items">
                      {drawerDetail.movements.map((m) => (
                        <div className="restaurants-order-dialog-item" key={m.id}>
                          <span className="restaurants-order-dialog-item-name">
                            {m.direction === 'in' ? 'Paid in' : 'Paid out'} at {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{m.note ? ' — ' + m.note : ''}
                          </span>
                          <span className="restaurants-order-dialog-item-total">{m.direction === 'out' ? '-' : ''}{money(m.amount)}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDrawerDetailOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
