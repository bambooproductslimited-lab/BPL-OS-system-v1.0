import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, API_ORIGIN } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import ContactButtons from '../components/ContactButtons';
import RowMenu from '../components/RowMenu';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { CompanySwitcher, Glossary, Hero, Insights, RankList, Section, Status, fmtDate, jump } from '../components/DashKit';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import RestaurantReport from './RestaurantReport';
import Bars from './RestaurantBars';
import './EmployeesPage.css';
import './ToolRoomPage.css';
import './RestaurantsPage.css';

// Restaurants: Star Bar Restaurant, Bamboo Garden and any other company
// that runs a till. Same "explains itself" layout as the dashboards
// (components/DashKit.jsx): pick the restaurant, then the key numbers
// (sales today against the same day last week, this month against the same
// days last month, stock to reorder, cash drawers), what stands out (food
// expiring, a drawer counted short, voids, what sells and what does not)
// and six views:
//   Sales — each of the last 35 days, best sellers, the busy hours, how
//     people pay, who sells, and every order (paged — a Square import can
//     leave tens of thousands);
//   Report — the monthly analysis by kitchen group, shift and hour, the
//     best-selling items and the kitchen bonus (RestaurantReport.jsx);
//   Menu — what the till sells, with what each item sold in 30 days;
//   Stock — food and supplies together: record a delivery, what was used,
//     thrown away or counted, and each item's history (migration 0090);
//   Cash drawers — each shift's count against what should be in the drawer;
//   Tables & guests.
// Orders are only ever created by the till (RestaurantPosPage.jsx, /pos);
// this page reads them and can void one. Figures come from
// restaurantOverview.service.js. The cards and dialogs use the tool room's
// pieces (ToolRoomPage.css).

const VIEWS = ['sales', 'report', 'menu', 'stock', 'drawers', 'tables'];
const STOCK_KINDS = [
  { key: 'received', label: msg('Delivery received') }, { key: 'used', label: msg('Used') },
  { key: 'wasted', label: msg('Thrown away') }, { key: 'count', label: msg('Counted') }
];
const MOVE_LABELS = { received: msg('Received'), used: msg('Used'), wasted: msg('Thrown away'), count: msg('Counted') };
const EMPTY_MENU_FORM = { name: '', category: '', price: '' };
const EMPTY_STOCK_FORM = { name: '', category: '', unit: '', stockQty: '', reorderLevel: '', unitCost: '', expiryDate: '' };
function fmtDateTime(ts) { return ts ? new Date(ts).toLocaleString(activeIntlLocale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''; }
const ORDERS_PAGE = 25;
const DRAWER_PAGE = 20;
const SOON = 3;

function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function daysUntil(iso) {
  if (!iso) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((new Date(String(iso).slice(0, 10) + 'T00:00') - t) / 86400000);
}
function qtyText(n, unit) {
  const v = Number(n).toLocaleString(activeIntlLocale(), { maximumFractionDigits: 2 });
  return unit && unit !== 'each' ? v + ' ' + unit : v;
}
function when(iso) { return new Date(iso).toLocaleString(activeIntlLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
function hourLabel(h) { return new Date(2000, 0, 1, h).toLocaleTimeString(activeIntlLocale(), { hour: 'numeric' }); }
function pctChange(now, before) { return before > 0 ? Math.round(((now - before) / before) * 100) : null; }
function expiryOf(i) {
  if (i.type !== 'ingredient' || !i.expiryDate) return null;
  const d = daysUntil(i.expiryDate);
  if (d < 0) return { tone: 'bad', text: -d === 1 ? tr('Expired yesterday') : tr('Expired {n} days ago', { n: -d }) };
  if (d === 0) return { tone: 'bad', text: tr('Expires today') };
  if (d <= SOON) return { tone: 'warn', text: d === 1 ? tr('Expires tomorrow') : tr('Expires in {n} days', { n: d }) };
  return { tone: 'muted', text: tr('Use by {date}', { date: fmtDate(i.expiryDate) }) };
}
function drawerState(s) {
  if (s.status === 'open') return { tone: 'info', text: tr('Open') };
  if (s.difference === null || s.difference === undefined) return { tone: 'muted', text: tr('Closed') };
  if (Math.abs(s.difference) < 0.01) return { tone: 'good', text: tr('Exact') };
  return s.difference < 0 ? { tone: 'bad', text: tr('Short {amount}', { amount: money(-s.difference) }) } : { tone: 'warn', text: tr('Over {amount}', { amount: money(s.difference) }) };
}

// One series of bars: a day or an hour each. The height is the value; the
// highlighted bar is today. Hover (or focus) shows the figures.
function Plate({ m, size = 56 }) {
  if (m.photoUrl) return <img className="rs-plate" src={API_ORIGIN + m.photoUrl} alt="" loading="lazy" style={{ width: size, height: size }} />;
  return <span className="rs-plate is-empty" style={{ width: size, height: size }} aria-hidden="true">{String(m.name || '?').trim().charAt(0).toUpperCase()}</span>;
}

export default function RestaurantsPage() {
  const { can } = useAuth();
  const canManage = can('restaurant.manage');

  const [companies, setCompanies] = useState([]);
  const [companyCode, setCompanyCode] = useState(() => readPref('bos.restaurantCompany', ''));
  const [view, setView] = useState(() => { const v = readPref('bos.restaurantView', 'sales'); return VIEWS.includes(v) ? v : 'sales'; });
  const [ov, setOv] = useState(null);
  const [menuItems, setMenuItems] = useState([]);
  const [supplies, setSupplies] = useState([]);
  const [ingredients, setIngredients] = useState([]);
  const [tables, setTables] = useState([]);
  const [guests, setGuests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [menuChip, setMenuChip] = useState('active');
  const [menuCategory, setMenuCategory] = useState('');
  const [menuSearch, setMenuSearch] = useState('');
  const [stockChip, setStockChip] = useState('all');
  const [stockSearch, setStockSearch] = useState('');
  const [guestSearch, setGuestSearch] = useState('');

  const [orders, setOrders] = useState({ orders: [], total: 0, revenueTotal: 0, voidedCount: 0 });
  const [ordersOffset, setOrdersOffset] = useState(0);
  const [ordersFrom, setOrdersFrom] = useState('');
  const [ordersTo, setOrdersTo] = useState('');
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [drawers, setDrawers] = useState({ sessions: [], total: 0 });
  const [drawersOffset, setDrawersOffset] = useState(0);
  const [drawersLoading, setDrawersLoading] = useState(false);

  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [menuDialog, setMenuDialog] = useState(null); // { id? }
  const [menuForm, setMenuForm] = useState(EMPTY_MENU_FORM);
  const [photo, setPhoto] = useState({ file: null, preview: null, removed: false });
  const [variation, setVariation] = useState({ id: null, name: '', price: '', error: null, saving: false });
  const [stockDialog, setStockDialog] = useState(null); // { type, id? }
  const [stockForm, setStockForm] = useState(EMPTY_STOCK_FORM);
  const [moveDialog, setMoveDialog] = useState(null); // { item }
  const [moveForm, setMoveForm] = useState({});
  const [stockDetail, setStockDetail] = useState(null); // { type, id }
  const [stockMoves, setStockMoves] = useState(null);
  const [tableDialog, setTableDialog] = useState(null); // { id?, name }
  const [guestDialog, setGuestDialog] = useState(null); // { id?, name, phone, notes }
  const [orderDetail, setOrderDetail] = useState(null); // { loading, data, error }
  const [drawerDetail, setDrawerDetail] = useState(null);
  // The Square import runs in the background on the server
  // (restaurantSquareImport.service.js): starting it answers at once, and
  // the page checks the job every few seconds while it runs.
  const [squareJob, setSquareJob] = useState(null);
  const [squareError, setSquareError] = useState(null);
  const [squareStarting, setSquareStarting] = useState(false);
  const squareRunning = !!(squareJob && squareJob.status === 'running');

  // ── loading ─────────────────────────────────────────────────────────
  useEffect(() => {
    api.get('/restaurant/companies').then((list) => {
      setCompanies(list);
      if (!list.length) setLoading(false);
    }).catch((err) => { setError(err.message); setLoading(false); });
  }, []);
  const shown = useMemo(() => {
    const running = companies.filter((c) => c.menuItems > 0 || c.orders30 > 0);
    return (running.length ? running : companies).slice().sort((x, y) => y.orders30 - x.orders30 || String(x.name).localeCompare(String(y.name)));
  }, [companies]);
  // a company with no menu or sales yet can be picked to set it up
  const current = companies.find((c) => c.code === companyCode) || shown[0] || null;
  const switcher = current && !shown.includes(current) ? [...shown, current] : shown;
  const others = companies.filter((c) => !switcher.includes(c));
  const companyId = current ? current.id : null;
  function pickCompany(code) { setCompanyCode(code); writePref('bos.restaurantCompany', code); setOrdersOffset(0); setDrawersOffset(0); setSquareJob(null); setSquareError(null); }
  function pickView(v, scroll = true) {
    setView(v);
    writePref('bos.restaurantView', v);
    if (scroll) setTimeout(() => jump('rs-views'), 0);
  }

  const load = useCallback(async () => {
    if (!companyId) return;
    setError(null);
    const qs = '?companyId=' + companyId;
    try {
      const [o, menu, sup, ing, tbl, gst] = await Promise.all([
        api.get('/restaurant/overview' + qs), api.get('/restaurant/menu-items' + qs), api.get('/restaurant/supplies' + qs),
        api.get('/restaurant/ingredients' + qs), api.get('/restaurant/tables' + qs), api.get('/restaurant/guests' + qs)
      ]);
      setOv(o); setMenuItems(menu); setSupplies(sup); setIngredients(ing); setTables(tbl); setGuests(gst);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [companyId]);
  useEffect(() => { setOv(null); load(); }, [load]);

  useEffect(() => {
    if (!companyId || !canManage) return undefined;
    let live = true;
    api.get('/restaurant/square-import?companyId=' + companyId).then((j) => { if (live) setSquareJob(j); }).catch(() => {});
    return () => { live = false; };
  }, [companyId, canManage]);
  useEffect(() => {
    if (!squareRunning) return undefined;
    const t = setTimeout(async () => {
      try {
        const j = await api.get('/restaurant/square-import?companyId=' + squareJob.companyId);
        setSquareJob(j);
        if (j && j.status !== 'running') load();
      } catch { /* try again on the next tick */ setSquareJob({ ...squareJob }); }
    }, 3000);
    return () => clearTimeout(t);
  }, [squareJob, squareRunning, load]);

  const loadOrders = useCallback(async () => {
    if (!companyId) return;
    setOrdersLoading(true);
    try {
      const params = new URLSearchParams({ companyId, limit: ORDERS_PAGE, offset: ordersOffset });
      if (ordersFrom) params.set('from', ordersFrom);
      if (ordersTo) params.set('to', ordersTo);
      setOrders(await api.get('/restaurant/orders?' + params.toString()));
    } catch (err) { setError(err.message); } finally { setOrdersLoading(false); }
  }, [companyId, ordersOffset, ordersFrom, ordersTo]);
  useEffect(() => { if (view === 'sales') loadOrders(); }, [view, loadOrders]);

  const loadDrawers = useCallback(async () => {
    if (!companyId) return;
    setDrawersLoading(true);
    try {
      setDrawers(await api.get('/restaurant/drawer-sessions?' + new URLSearchParams({ companyId, limit: DRAWER_PAGE, offset: drawersOffset }).toString()));
    } catch (err) { setError(err.message); } finally { setDrawersLoading(false); }
  }, [companyId, drawersOffset]);
  useEffect(() => { if (view === 'drawers') loadDrawers(); }, [view, loadDrawers]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    setStockMoves(null);
    if (!stockDetail) return;
    api.get('/restaurant/' + (stockDetail.type === 'supply' ? 'supplies/' : 'ingredients/') + stockDetail.id + '/history').then(setStockMoves).catch(() => setStockMoves([]));
  }, [stockDetail, supplies, ingredients]);

  async function run(fn, okText) {
    try { await fn(); if (okText) setToast(okText); await load(); } catch (err) { setError(err.message); }
  }

  // ── menu ────────────────────────────────────────────────────────────
  function openMenu(m) {
    setFormError(null);
    setMenuForm(m ? { name: m.name, category: m.category, price: m.price } : { ...EMPTY_MENU_FORM, category: menuCategory });
    setPhoto({ file: null, preview: m && m.photoUrl ? API_ORIGIN + m.photoUrl : null, removed: false });
    setVariation({ id: null, name: '', price: '', error: null, saving: false });
    setMenuDialog(m ? { id: m.id } : {});
  }
  async function saveMenu(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const saved = menuDialog.id ? await api.put('/restaurant/menu-items/' + menuDialog.id, menuForm) : await api.post('/restaurant/menu-items', { ...menuForm, companyId });
      if (photo.file) {
        const body = new FormData();
        body.append('file', photo.file);
        await api.upload('/restaurant/menu-items/' + saved.id + '/photo', body);
      } else if (photo.removed && menuDialog.id) {
        await api.del('/restaurant/menu-items/' + saved.id + '/photo');
      }
      setToast(menuDialog.id ? tr('Menu item updated.') : tr('Menu item added.'));
      setMenuDialog(null);
      await load();
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  }
  async function saveVariation() {
    if (!variation.name.trim()) { setVariation({ ...variation, error: tr('Name a variation before adding it.') }); return; }
    setVariation({ ...variation, saving: true, error: null });
    try {
      const body = { name: variation.name, price: variation.price };
      if (variation.id) await api.put('/restaurant/menu-items/' + menuDialog.id + '/variations/' + variation.id, body);
      else await api.post('/restaurant/menu-items/' + menuDialog.id + '/variations', body);
      setVariation({ id: null, name: '', price: '', error: null, saving: false });
      await load();
    } catch (err) { setVariation((v) => ({ ...v, saving: false, error: err.message })); }
  }
  async function dropVariation(v) {
    try { await api.del('/restaurant/menu-items/' + menuDialog.id + '/variations/' + v.id); await load(); } catch (err) { setVariation((x) => ({ ...x, error: err.message })); }
  }

  // ── stock ───────────────────────────────────────────────────────────
  function openStockItem(type, item) {
    setFormError(null);
    setStockForm(item
      ? { name: item.name, category: item.category || '', unit: item.unit, stockQty: item.stockQty, reorderLevel: item.reorderLevel, unitCost: item.unitCost, expiryDate: item.expiryDate ? String(item.expiryDate).slice(0, 10) : '' }
      : { ...EMPTY_STOCK_FORM, unit: type === 'supply' ? 'each' : 'kg' });
    setStockDetail(null);
    setStockDialog({ type, id: item ? item.id : null });
  }
  async function saveStockItem(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    const path = stockDialog.type === 'supply' ? '/restaurant/supplies' : '/restaurant/ingredients';
    try {
      if (stockDialog.id) await api.put(path + '/' + stockDialog.id, stockForm);
      else await api.post(path, { ...stockForm, companyId });
      setToast(stockDialog.id ? tr('Saved.') : tr('{name} added.', { name: stockForm.name }));
      setStockDialog(null);
      await load();
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  }
  function openMove(item, kind) {
    setFormError(null);
    setMoveForm({ kind: kind || 'received', qty: '', unitCost: item.unitCost || '', expiryDate: '', note: '' });
    setStockDetail(null);
    setMoveDialog({ item });
  }
  async function saveMove(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    const it = moveDialog.item;
    try {
      await api.post('/restaurant/' + (it.type === 'supply' ? 'supplies/' : 'ingredients/') + it.id + '/stock', moveForm);
      setToast(tr('{name}: stock updated.', { name: it.name }));
      setMoveDialog(null);
      await load();
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  }
  function removeStockItem(it) {
    run(() => api.del('/restaurant/' + (it.type === 'supply' ? 'supplies/' : 'ingredients/') + it.id), tr('{name} removed.', { name: it.name }));
  }

  // ── tables & guests ─────────────────────────────────────────────────
  async function saveTable(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      if (tableDialog.id) await api.put('/restaurant/tables/' + tableDialog.id, { name: tableDialog.name });
      else await api.post('/restaurant/tables', { name: tableDialog.name, companyId });
      setToast(tableDialog.id ? tr('Table updated.') : tr('Table added.'));
      setTableDialog(null);
      await load();
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  }
  async function saveGuest(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    const body = { name: guestDialog.name, phone: guestDialog.phone, notes: guestDialog.notes };
    try {
      if (guestDialog.id) await api.put('/restaurant/guests/' + guestDialog.id, body);
      else await api.post('/restaurant/guests', { ...body, companyId });
      setToast(guestDialog.id ? tr('Guest updated.') : tr('Guest added.'));
      setGuestDialog(null);
      await load();
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  }

  // ── orders, drawers, Square ─────────────────────────────────────────
  async function openOrder(id) {
    setOrderDetail({ loading: true });
    try { setOrderDetail({ data: await api.get('/restaurant/orders/' + id) }); } catch (err) { setOrderDetail({ error: err.message }); }
  }
  async function voidOrder(o) {
    try {
      await api.post('/restaurant/orders/' + o.id + '/void');
      setToast(tr('Order voided.'));
      setOrderDetail(null);
      await Promise.all([loadOrders(), load()]);
    } catch (err) { setError(err.message); }
  }
  async function openDrawer(id) {
    setDrawerDetail({ loading: true });
    try { setDrawerDetail({ data: await api.get('/restaurant/drawer-sessions/' + id) }); } catch (err) { setDrawerDetail({ error: err.message }); }
  }
  async function runSquareImport(full) {
    setSquareStarting(true);
    setSquareError(null);
    try {
      setSquareJob(await api.post('/restaurant/square-import', { companyId, full: !!full }));
    } catch (err) { setSquareError(err.message); } finally { setSquareStarting(false); }
  }
  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;
  if (!current) return <div className="dk"><div className="dk-empty"><p>{tr('No companies found')}</p></div></div>;

  // ── what the page shows ────────────────────────────────────────────
  const days = ov ? ov.days : [];
  const todayRow = days[days.length - 1] || { sales: 0, orders: 0 };
  const lastWeekRow = days[days.length - 8] || { sales: 0, orders: 0 };
  const weekday = new Date().toLocaleDateString(activeIntlLocale(), { weekday: 'long' });
  const month = ov ? ov.month : { sales: 0, orders: 0 };
  const prevMonth = ov ? ov.previousMonth : { sales: 0, orders: 0 };
  const monthPct = pctChange(month.sales, prevMonth.sales);
  const sold = new Map((ov ? ov.items : []).filter((i) => i.menuItemId).map((i) => [i.menuItemId, i]));
  const usage = new Map((ov ? ov.stock.perItem : []).map((p) => [p.type + ':' + p.id, p]));
  const hasSales = days.some((d) => d.orders > 0) || (ov && ov.items.length > 0);

  const stock = [
    ...ingredients.map((i) => ({ ...i, type: 'ingredient', category: tr('Food') })),
    ...supplies.map((s) => ({ ...s, type: 'supply' }))
  ].map((it) => {
    const u = usage.get(it.type + ':' + it.id) || { used30: 0, wasted30: 0 };
    return { ...it, used30: u.used30 || 0, wasted30: u.wasted30 || 0, value: it.stockQty * it.unitCost, daysLeft: u.used30 > 0 ? Math.floor(it.stockQty / (u.used30 / 30)) : null };
  });
  const low = stock.filter((it) => it.lowStock);
  const expiring = stock.filter((it) => it.type === 'ingredient' && it.expiryDate && it.stockQty > 0 && daysUntil(it.expiryDate) <= SOON).sort((x, y) => String(x.expiryDate).localeCompare(String(y.expiryDate)));
  const expired = expiring.filter((it) => daysUntil(it.expiryDate) < 0);
  const runningOut = stock.filter((it) => !it.lowStock && it.daysLeft !== null && it.daysLeft <= 7).sort((x, y) => x.daysLeft - y.daysLeft);

  const activeMenu = menuItems.filter((m) => m.active);
  const unsold = hasSales ? activeMenu.filter((m) => !sold.has(m.id)) : [];
  const noPhoto = activeMenu.filter((m) => !m.photoUrl);
  const allDrawers = ov ? ov.drawers : [];
  const openDrawers = allDrawers.filter((d) => d.status === 'open');
  const lastClosed = allDrawers.find((d) => d.status === 'closed' && d.difference !== null && d.difference !== undefined);
  const recentShort = allDrawers.filter((d) => d.status === 'closed' && d.difference !== null && d.difference < -1);
  const best = ov && ov.items[0];

  const stats = [
    { icon: 'cash', value: money(todayRow.sales), label: tr('sales today'), note: (todayRow.orders === 1 ? tr('1 order') : tr('{n} orders', { n: todayRow.orders })) + ' · ' + tr('{amount} last {day}', { amount: money(lastWeekRow.sales), day: weekday }), onClick: () => pickView('sales') },
    { icon: 'up', value: money(month.sales), label: tr('sales this month'), note: monthPct === null ? tr('nothing to compare with last month') : monthPct >= 0 ? tr('{n}% up on the same days last month', { n: monthPct }) : tr('{n}% down on the same days last month', { n: -monthPct }), tone: monthPct !== null && monthPct < -10 ? 'alert' : monthPct !== null && monthPct > 0 ? 'good' : '', onClick: () => pickView('sales') },
    { icon: 'warn', value: String(low.length), label: tr('stock items to reorder'), note: expiring.length ? (expiring.length === 1 ? tr('1 food item expiring') : tr('{n} food items expiring', { n: expiring.length })) : tr('nothing expiring'), tone: expired.length ? 'bad' : low.length || expiring.length ? 'alert' : '', onClick: () => { setStockChip(low.length ? 'low' : 'all'); pickView('stock'); } },
    { icon: 'drawer', value: String(openDrawers.length), label: tr('cash drawers open'), note: !lastClosed ? tr('no drawer counted yet') : Math.abs(lastClosed.difference) < 0.01 ? tr('last count was exact') : lastClosed.difference < 0 ? tr('last count short by {amount}', { amount: money(-lastClosed.difference) }) : tr('last count over by {amount}', { amount: money(lastClosed.difference) }), tone: lastClosed && lastClosed.difference < -1 ? 'bad' : '', onClick: () => pickView('drawers') }
  ];

  const insights = [];
  if (expired.length) insights.push({ tone: 'bad', icon: 'warn', text: expired.length === 1 ? tr('{name} has passed its use-by date ({qty} left). Throw it away and record it.', { name: expired[0].name, qty: qtyText(expired[0].stockQty, expired[0].unit) }) : tr('{n} food items have passed their use-by date.', { n: expired.length }), action: canManage && expired.length === 1 ? { label: tr('Record it'), run: () => openMove(expired[0], 'wasted') } : { label: tr('Show them'), run: () => { setStockChip('expiring'); pickView('stock'); } } });
  else if (expiring.length) insights.push({ tone: 'warn', icon: 'clock', text: expiring.length === 1 ? tr('{name} expires {date}; use it first.', { name: expiring[0].name, date: fmtDate(expiring[0].expiryDate) }) : tr('{n} food items expire in the next {d} days; use them first.', { n: expiring.length, d: SOON }), action: { label: tr('Show them'), run: () => { setStockChip('expiring'); pickView('stock'); } } });
  if (recentShort.length) insights.push({ tone: 'bad', icon: 'drawer', text: tr('{name}\'s drawer was counted {amount} short on {date}.', { name: recentShort[0].cashierName, amount: money(-recentShort[0].difference), date: fmtDate(recentShort[0].closedAt) }), action: { label: tr('Open it'), run: () => openDrawer(recentShort[0].id) } });
  if (low.length) insights.push({ tone: 'warn', icon: 'warn', text: low.length === 1 ? tr('{name} is down to {qty}; time to reorder.', { name: low[0].name, qty: qtyText(low[0].stockQty, low[0].unit) }) : tr('{n} stock items are at or below their reorder level.', { n: low.length }), action: canManage && low.length === 1 ? { label: tr('Record a delivery'), run: () => openMove(low[0], 'received') } : { label: tr('Show them'), run: () => { setStockChip('low'); pickView('stock'); } } });
  else if (runningOut.length) insights.push({ tone: 'info', icon: 'calendar', text: tr('At the rate it is used, {name} runs out in about {n} days.', { name: runningOut[0].name, n: runningOut[0].daysLeft }), action: { label: tr('Show stock'), run: () => pickView('stock') } });
  if (ov && ov.voided7.orders) insights.push({ tone: 'warn', icon: 'void', text: ov.voided7.orders === 1 ? tr('1 order worth {amount} was voided in the last 7 days.', { amount: money(ov.voided7.total) }) : tr('{n} orders worth {amount} were voided in the last 7 days.', { n: ov.voided7.orders, amount: money(ov.voided7.total) }), action: { label: tr('See the orders'), run: () => pickView('sales') } });
  if (ov && ov.stock.wasted30 > 0) insights.push({ tone: 'info', icon: 'cash', text: tr('{amount} of stock was thrown away in the last 30 days.', { amount: money(ov.stock.wasted30) }), action: { label: tr('Show stock'), run: () => pickView('stock') } });
  if (best) insights.push({ tone: 'good', icon: 'spark', text: tr('Best seller over 30 days: {name}, {qty} sold for {amount}.', { name: best.name, qty: qtyText(best.qty), amount: money(best.revenue) }), action: { label: tr('Show the menu'), run: () => pickView('menu') } });
  if (unsold.length) insights.push({ tone: 'info', icon: 'bag', text: unsold.length === 1 ? tr('{name} is on the menu but has not sold in 30 days.', { name: unsold[0].name }) : tr('{n} items on the menu have not sold in 30 days.', { n: unsold.length }), action: { label: tr('Show them'), run: () => { setMenuChip('unsold'); pickView('menu'); } } });
  if (noPhoto.length && noPhoto.length < activeMenu.length) insights.push({ tone: 'info', icon: 'info', text: noPhoto.length === 1 ? tr('{name} has no photo, so the till shows it as a plain tile.', { name: noPhoto[0].name }) : tr('{n} menu items have no photo, so the till shows them as plain tiles.', { n: noPhoto.length }), action: { label: tr('Show them'), run: () => { setMenuChip('nophoto'); pickView('menu'); } } });
  if (!insights.length) insights.push({ tone: 'good', icon: 'check', text: tr('Nothing needs attention: stock is fine and the drawers add up.') });

  const menuCategories = Array.from(new Set(menuItems.map((m) => m.category))).sort();
  const menuTest = {
    active: (m) => m.active, unsold: (m) => unsold.includes(m), nophoto: (m) => m.active && !m.photoUrl, disabled: (m) => !m.active
  };
  const menuVisible = menuItems.filter(menuTest[menuChip] || menuTest.active)
    .filter((m) => !menuCategory || m.category === menuCategory)
    .filter((m) => matchesQuery(menuSearch, m.name, m.category));
  const menuGroups = [];
  menuVisible.forEach((m) => {
    let g = menuGroups.find((x) => x.category === m.category);
    if (!g) { g = { category: m.category, items: [] }; menuGroups.push(g); }
    g.items.push(m);
  });

  const stockTest = {
    all: () => true, food: (it) => it.type === 'ingredient', supplies: (it) => it.type === 'supply',
    low: (it) => it.lowStock, expiring: (it) => expiring.includes(it)
  };
  const stockVisible = stock.filter(stockTest[stockChip] || stockTest.all)
    .filter((it) => matchesQuery(stockSearch, it.name, it.category))
    .sort((x, y) => Number(y.lowStock) - Number(x.lowStock) || String(x.name).localeCompare(String(y.name)));

  const views = [
    ['sales', tr('Sales'), null],
    ['report', tr('Report'), null],
    ['menu', tr('Menu'), activeMenu.length],
    ['stock', tr('Stock'), low.length + expiring.length || null],
    ['drawers', tr('Cash drawers'), openDrawers.length || null],
    ['tables', tr('Tables & guests'), null]
  ];
  const dayRows = days.map((d, i) => {
    const date = new Date(d.day + 'T00:00');
    return {
      key: d.day, value: d.sales, current: i === days.length - 1,
      label: i % 7 === days.length % 7 || i === days.length - 1 ? date.toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' }) : '',
      tip: date.toLocaleDateString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short' }) + ': ' + money(d.sales) + ' · ' + (d.orders === 1 ? tr('1 order') : tr('{n} orders', { n: d.orders }))
    };
  });
  const hours = ov ? ov.hours : [];
  const hourRows = hours.length ? Array.from({ length: Math.max(...hours.map((h) => h.hour)) - Math.min(...hours.map((h) => h.hour)) + 1 }, (_, i) => {
    const h = Math.min(...hours.map((x) => x.hour)) + i;
    const r = hours.find((x) => x.hour === h) || { orders: 0, sales: 0 };
    return { key: String(h), value: r.orders, label: hourLabel(h), tip: hourLabel(h) + ': ' + (r.orders === 1 ? tr('1 order') : tr('{n} orders', { n: r.orders })) + ' · ' + money(r.sales) };
  }) : [];
  const busiest = hours.length ? hours.slice().sort((x, y) => y.orders - x.orders)[0] : null;
  const itemRows = (ov ? ov.items : []).slice(0, 8).map((i) => ({ key: i.key, name: i.name, value: i.revenue, amount: money(i.revenue), meta: tr('{qty} sold', { qty: qtyText(i.qty) }) }));
  const payRows = (ov ? ov.payments : []).map((p) => ({ key: p.method, name: codeLabel(p.method), value: p.sales, amount: money(p.sales), meta: p.orders === 1 ? tr('1 order') : tr('{n} orders', { n: p.orders }) }));
  const staffRows = (ov ? ov.staff : []).map((s) => ({ key: s.id, name: s.name, value: s.sales, amount: money(s.sales), meta: s.orders === 1 ? tr('1 order') : tr('{n} orders', { n: s.orders }) }));
  const visibleGuests = guests.filter((g) => matchesQuery(guestSearch, g.name, g.phone, g.notes));
  const editingItem = menuDialog && menuDialog.id ? menuItems.find((m) => m.id === menuDialog.id) : null;
  const detailItem = stockDetail ? stock.find((it) => it.type === stockDetail.type && it.id === stockDetail.id) : null;
  const moveItem = moveDialog ? stock.find((it) => it.type === moveDialog.item.type && it.id === moveDialog.item.id) || moveDialog.item : null;
  const moveAfter = moveItem && moveForm.qty !== '' && Number.isFinite(Number(moveForm.qty))
    ? (moveForm.kind === 'count' ? Number(moveForm.qty) : moveItem.stockQty + (moveForm.kind === 'received' ? 1 : -1) * Number(moveForm.qty)) : null;

  return (
    <div className="dk tl rs">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <CompanySwitcher companies={switcher} company={current.code} onPick={pickCompany}
        describe={(co) => (co.salesToday ? tr('{amount} today', { amount: money(co.salesToday) }) : co.menuItems === 1 ? tr('1 item on the menu') : tr('{n} items on the menu', { n: co.menuItems }))} />
      {canManage && others.length > 0 && (
        <div className="rs-other">
          <select className="input" value="" onChange={(e) => e.target.value && pickCompany(e.target.value)} aria-label={tr('Set up another company\'s restaurant')}>
            <option value="">{tr('Set up another company\'s restaurant…')}</option>
            {others.map((c) => <option key={c.id} value={c.code}>{c.name}</option>)}
          </select>
        </div>
      )}

      <Hero
        eyebrow={new Date().toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        title={current.name}
        sub={tr('How the restaurant is selling, what is on the menu, the food and supplies in stock, and whether the cash drawers add up. Sales come from the till. Press a number to go to it.')}
        actions={(
          <>
            <a className="btn btn-primary" href="/pos" target="_blank" rel="noreferrer">{tr('Open till (POS) ↗')}</a>
            {canManage && <button type="button" className="btn btn-secondary" disabled={squareStarting || squareRunning} onClick={() => runSquareImport(false)}>{squareRunning ? tr('Importing from Square…') : tr('Import from Square')}</button>}
          </>
        )}
        stats={stats} />

      {squareError && <div className="error-banner">{squareError}</div>}
      {canManage && squareJob && (squareRunning || Date.now() - new Date(squareJob.finishedAt || squareJob.startedAt).getTime() < 7 * 86400000) && (
        <div className={'rs-square is-' + squareJob.status} role="status">
          <div className="rs-square-head">
            <strong>
              {squareRunning ? tr('Importing from Square…') : squareJob.status === 'done' ? tr('Square import finished') : squareJob.status === 'interrupted' ? tr('Square import stopped') : tr('Square import failed')}
            </strong>
            <span className="dk-muted tl-small">
              {squareRunning
                ? (squareJob.phase === 'menu' || squareJob.phase === 'starting' ? tr('Reading the menu…') : tr('Saving orders, page {n}…', { n: squareJob.pagesDone + 1 }))
                : fmtDateTime(squareJob.finishedAt || squareJob.heartbeatAt)}
            </span>
          </div>
          <div className="rs-square-nums">
            {tr('Menu items {imported} imported ({skipped} skipped)', squareJob.menuItems)} · {tr('Orders {imported} imported ({skipped} skipped)', squareJob.orders)}
            {squareJob.lastOrderAt && <> · {tr('up to {date}', { date: fmtDate(squareJob.lastOrderAt) })}</>}
            {squareJob.ordersSince && <> · {tr('only orders from {date} on', { date: fmtDate(squareJob.ordersSince) })}</>}
          </div>
          {squareRunning && <p className="dk-muted tl-small">{tr('This runs on the server — you can leave this page and come back; it keeps going.')}</p>}
          {squareJob.status === 'failed' && squareJob.message && <p className="rs-square-err">{squareJob.message}</p>}
          {squareJob.status === 'interrupted' && <p className="dk-muted tl-small">{tr('The server restarted while it was running. Press Import from Square to carry on from the last order saved — nothing is imported twice.')}</p>}
          {squareJob.errorCount > 0 && <p className="dk-muted tl-small">{tr('{n} record(s) could not be imported; the first was: {msg}', { n: squareJob.errorCount, msg: (squareJob.errors[0] || {}).message || '—' })}</p>}
          {!squareRunning && squareJob.status === 'done' && (
            <p className="dk-muted tl-small">
              {tr('Next time, only newer orders are fetched.')}{' '}
              <button type="button" className="rs-square-link" disabled={squareStarting} onClick={() => runSquareImport(true)}>{tr('Re-import everything')}</button>
            </p>
          )}
        </div>
      )}

      <Insights items={insights.slice(0, 5)} />

      <div id="rs-views" className="rs-views" role="tablist" aria-label={tr('Show')}>
        {views.map(([k, label, n]) => (
          <button key={k} type="button" role="tab" aria-selected={view === k} className={'rs-view' + (view === k ? ' is-on' : '')} onClick={() => pickView(k, false)}>
            {label}{n ? <span className="ppl-chip-n">{n}</span> : null}
          </button>
        ))}
      </div>

      {/* ── sales ── */}
      {view === 'sales' && (
        <>
          <Section id="rs-days" title={tr('Sales, day by day')} sub={tr('The last 35 days; today on the right. Point at a day for its figures.')} card>
            {hasSales ? <Bars rows={dayRows} format={money} label={tr('Sales, day by day')} className="is-days" /> : <p className="dk-muted tl-small">{tr('No sales in the last 35 days. Sales rung up on the till show here.')}</p>}
          </Section>
          {hasSales && (
            <div className="dk-two">
              <Section title={tr('Best sellers')} sub={tr('The last 30 days, by what they brought in.')} card>
                {itemRows.length ? <RankList rows={itemRows} /> : <p className="dk-muted tl-small">{tr('Nothing sold in 30 days.')}</p>}
              </Section>
              <Section title={tr('When it is busy')} sub={busiest ? tr('Orders by hour over 30 days; busiest at {hour}.', { hour: hourLabel(busiest.hour) }) : tr('Orders by hour over 30 days.')} card>
                {hourRows.length ? <Bars rows={hourRows} format={(v) => String(v)} label={tr('When it is busy')} /> : <p className="dk-muted tl-small">{tr('Nothing sold in 30 days.')}</p>}
              </Section>
              <Section title={tr('How people pay')} sub={tr('The last 30 days.')} card>
                {payRows.length ? <RankList rows={payRows} /> : <p className="dk-muted tl-small">{tr('Nothing sold in 30 days.')}</p>}
              </Section>
              <Section title={tr('Who sells')} sub={tr('By waiter, or the cashier when no waiter was picked. The last 30 days.')} card>
                {staffRows.length ? <RankList rows={staffRows} /> : <p className="dk-muted tl-small">{tr('Nothing sold in 30 days.')}</p>}
              </Section>
            </div>
          )}
          <Section id="rs-orders" title={tr('Orders')} sub={tr('Newest first. Press an order for what was on it.')}>
            <div className="rs-filter">
              <label className="tl-label" htmlFor="rs-from">{tr('From')}</label>
              <input id="rs-from" type="date" className="input" value={ordersFrom} onChange={(e) => { setOrdersFrom(e.target.value); setOrdersOffset(0); }} />
              <label className="tl-label" htmlFor="rs-to">{tr('to')}</label>
              <input id="rs-to" type="date" className="input" value={ordersTo} onChange={(e) => { setOrdersTo(e.target.value); setOrdersOffset(0); }} />
              {(ordersFrom || ordersTo) && <button type="button" className="btn btn-secondary tl-btn" onClick={() => { setOrdersFrom(''); setOrdersTo(''); setOrdersOffset(0); }}>{tr('Clear')}</button>}
              {orders.total > 0 && (
                <span className="dk-muted tl-small rs-filter-sum">
                  {(orders.total === 1 ? tr('1 order') : tr('{n} orders', { n: orders.total.toLocaleString(activeIntlLocale()) })) + ' · ' + money(orders.revenueTotal)}
                  {orders.voidedCount ? ' · ' + tr('{n} voided', { n: orders.voidedCount }) : ''}
                </span>
              )}
            </div>
            {orders.orders.length ? (
              <ul className="rs-list" style={{ opacity: ordersLoading ? 0.6 : 1 }}>
                {orders.orders.map((o) => (
                  <li key={o.id} className={'rs-row' + (o.status === 'voided' ? ' is-void' : '')}>
                    <button type="button" className="rs-row-open" onClick={() => openOrder(o.id)}>
                      <span className="rs-row-main">
                        <strong>{o.orderNo}</strong>
                        <span className="dk-muted tl-small">{[when(o.createdAt), o.tableName, o.waiterName || o.cashierName, o.guestName].filter(Boolean).join(' · ')}</span>
                      </span>
                      <span className="rs-row-side">
                        <strong className="rs-amount">{money(o.total)}</strong>
                        {o.status === 'voided' ? <Status tone="bad">{tr('Voided')}</Status> : <span className="dk-muted tl-small">{codeLabel(o.paymentMethod)}</span>}
                      </span>
                    </button>
                    {canManage && o.status === 'completed' && <span className="rs-row-menu"><RowMenu actions={[{ label: tr('Void'), onClick: () => voidOrder(o), danger: true }]} /></span>}
                  </li>
                ))}
              </ul>
            ) : !ordersLoading && <p className="dk-muted tl-small">{ordersFrom || ordersTo ? tr('No sales in that date range') : tr('No sales yet — rung-up orders from the till will show here')}</p>}
            {orders.total > ORDERS_PAGE && (
              <div className="rs-pager">
                <span className="dk-muted tl-small">{tr('{n}–{n2} of {total}', { n: ordersOffset + 1, n2: Math.min(ordersOffset + ORDERS_PAGE, orders.total), total: orders.total.toLocaleString(activeIntlLocale()) })}</span>
                <button type="button" className="btn btn-secondary tl-btn" disabled={ordersOffset === 0 || ordersLoading} onClick={() => setOrdersOffset(Math.max(0, ordersOffset - ORDERS_PAGE))}>{tr('Previous')}</button>
                <button type="button" className="btn btn-secondary tl-btn" disabled={ordersOffset + ORDERS_PAGE >= orders.total || ordersLoading} onClick={() => setOrdersOffset(ordersOffset + ORDERS_PAGE)}>{tr('Next')}</button>
              </div>
            )}
          </Section>
        </>
      )}

      {/* ── the monthly report ── */}
      {view === 'report' && <RestaurantReport companyId={companyId} companyName={current.name} canManage={canManage} onToast={setToast} />}

      {/* ── menu ── */}
      {view === 'menu' && (
        <Section id="rs-menu" title={tr('Menu')} sub={tr('What the till sells, with what each item sold in the last 30 days.')}
          action={canManage && <button type="button" className="btn btn-primary" onClick={() => openMenu(null)}>{tr('Add menu item')}</button>}>
          <div className="tl-tools">
            <div className="tl-search"><SearchInput value={menuSearch} onChange={setMenuSearch} placeholder={tr('Search menu…')} /></div>
            {menuCategories.length > 1 && (
              <select className="input tl-select" value={menuCategory} onChange={(e) => setMenuCategory(e.target.value)} aria-label={tr('Category')}>
                <option value="">{tr('All categories')}</option>
                {menuCategories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            )}
          </div>
          <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
            {[['active', tr('On the menu'), activeMenu.length], ['unsold', tr('Not sold in 30 days'), unsold.length], ['nophoto', tr('No photo'), noPhoto.length], ['disabled', tr('Disabled'), menuItems.length - activeMenu.length]]
              .filter(([k, , c]) => c > 0 || k === 'active' || k === menuChip)
              .map(([key, label, c]) => (
                <button key={key} type="button" role="radio" aria-checked={menuChip === key} className={'ppl-chip' + (menuChip === key ? ' is-on' : '')} onClick={() => setMenuChip(key)}>
                  {label} <span className="ppl-chip-n">{c}</span>
                </button>
              ))}
          </div>
          {!menuGroups.length ? (
            <div className="dk-empty tl-empty">
              <p>{menuItems.length ? tr('Nothing matches. Try another search or filter.') : tr('No menu items yet')}</p>
              {canManage && !menuItems.length && <button type="button" className="btn btn-primary" onClick={() => openMenu(null)}>{tr('Add menu item')}</button>}
            </div>
          ) : menuGroups.map((g) => (
            <div key={g.category} className="rs-group">
              <h3 className="rs-group-title">{g.category} <span className="ppl-chip-n">{g.items.length}</span></h3>
              <div className="rs-menu-grid">
                {g.items.map((m) => {
                  const s = sold.get(m.id);
                  const prices = m.variations.length ? m.variations.map((v) => Number(v.price)) : [Number(m.price)];
                  const lo = Math.min(...prices), hi = Math.max(...prices);
                  return (
                    <article key={m.id} className={'rs-dish' + (m.active ? '' : ' is-off')}>
                      <Plate m={m} />
                      <div className="rs-dish-main">
                        <span className="rs-dish-name">{m.name}</span>
                        <span className="rs-dish-price">{lo === hi ? money(lo) : tr('{from} to {to}', { from: money(lo), to: money(hi) })}</span>
                        {m.variations.length > 0 && <span className="dk-muted tl-small rs-dish-vars">{m.variations.slice(0, 3).map((v) => v.name).join(' · ')}{m.variations.length > 3 ? ' +' + (m.variations.length - 3) : ''}</span>}
                        <span className={'tl-small ' + (s ? 'rs-sold' : 'dk-muted')}>{!m.active ? tr('Disabled — not on the till') : s ? tr('{qty} sold · {amount} in 30 days', { qty: qtyText(s.qty), amount: money(s.revenue) }) : hasSales ? tr('Not sold in 30 days') : ''}</span>
                      </div>
                      {canManage && (
                        <span className="rs-dish-menu">
                          <RowMenu actions={[
                            { label: tr('Edit'), onClick: () => openMenu(m) },
                            { label: m.active ? tr('Disable') : tr('Enable'), onClick: () => run(() => api.post('/restaurant/menu-items/' + m.id + '/active', { active: !m.active }), m.active ? tr('{name} is off the till.', { name: m.name }) : tr('{name} is back on the till.', { name: m.name })) },
                            { label: tr('Delete'), onClick: () => run(() => api.del('/restaurant/menu-items/' + m.id), tr('Menu item removed.')), danger: true }
                          ]} />
                        </span>
                      )}
                    </article>
                  );
                })}
              </div>
            </div>
          ))}
        </Section>
      )}

      {/* ── stock ── */}
      {view === 'stock' && (
        <Section id="rs-stock" title={tr('Stock')} sub={ov ? tr('Food and supplies worth {amount} on the shelves. In the last 30 days: {bought} bought, {wasted} thrown away.', { amount: money(ov.stock.foodValue + ov.stock.suppliesValue), bought: money(ov.stock.bought30), wasted: money(ov.stock.wasted30) }) : ''}
          action={canManage && (
            <span className="rs-actions">
              <button type="button" className="btn btn-primary" onClick={() => openStockItem('ingredient', null)}>{tr('Add food item')}</button>
              <button type="button" className="btn btn-secondary" onClick={() => openStockItem('supply', null)}>{tr('Add supply')}</button>
            </span>
          )}>
          <div className="tl-tools"><div className="tl-search"><SearchInput value={stockSearch} onChange={setStockSearch} placeholder={tr('Search stock…')} /></div></div>
          <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
            {[['all', tr('All'), stock.length], ['food', tr('Food'), ingredients.length], ['supplies', tr('Supplies'), supplies.length], ['low', tr('To reorder'), low.length], ['expiring', tr('Expiring'), expiring.length]]
              .filter(([k, , c]) => c > 0 || k === 'all' || k === stockChip)
              .map(([key, label, c]) => (
                <button key={key} type="button" role="radio" aria-checked={stockChip === key} className={'ppl-chip' + (stockChip === key ? ' is-on' : '')} onClick={() => setStockChip(key)}>
                  {label} <span className="ppl-chip-n">{c}</span>
                </button>
              ))}
          </div>
          {!stockVisible.length ? (
            <div className="dk-empty tl-empty"><p>{stock.length ? tr('Nothing matches. Try another search or filter.') : tr('No stock tracked yet. Add the food and supplies you want to keep an eye on.')}</p></div>
          ) : (
            <div className="tl-grid">
              {stockVisible.map((it) => {
                const ex = expiryOf(it);
                const full = Math.max(it.reorderLevel * 2, it.stockQty, 1);
                return (
                  <article key={it.type + it.id} className={'tl-card' + (ex && ex.tone === 'bad' ? ' st-late' : it.lowStock ? ' st-low' : '')}>
                    <button type="button" className="tl-card-open" onClick={() => setStockDetail({ type: it.type, id: it.id })}>
                      <span className={'tl-badge ' + (it.type === 'ingredient' ? 'is-food' : 'is-material')} style={{ width: 44, height: 44 }} aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                          {it.type === 'ingredient' ? <><path d="M4 12h16a8 8 0 0 1-16 0Z" /><path d="M8 8c0-1.5 1-2 1-3.5M12 8c0-1.5 1-2 1-3.5M16 8c0-1.5 1-2 1-3.5" /></> : <><path d="M12 3.5 20 8 12 12.5 4 8 12 3.5Z" /><path d="M4 8v8l8 4.5 8-4.5V8M12 12.5V21" /></>}
                        </svg>
                      </span>
                      <span className="tl-card-head">
                        <span className="dk-muted tl-small">{it.type === 'ingredient' ? tr('Food') : tr('Supply') + (it.category ? ' · ' + it.category : '')}</span>
                        <span className="tl-name">{it.name}</span>
                      </span>
                    </button>
                    {canManage && <span className="tl-menu"><RowMenu actions={[
                      { label: tr('Record a delivery'), onClick: () => openMove(it, 'received') },
                      { label: tr('Record what was used'), onClick: () => openMove(it, 'used') },
                      { label: tr('Record what was thrown away'), onClick: () => openMove(it, 'wasted') },
                      { label: tr('Count it'), onClick: () => openMove(it, 'count') },
                      { label: tr('History'), onClick: () => setStockDetail({ type: it.type, id: it.id }) },
                      { label: tr('Edit'), onClick: () => openStockItem(it.type, it) },
                      { label: tr('Delete'), onClick: () => removeStockItem(it), danger: true }
                    ]} /></span>}
                    {(it.lowStock || ex) && (
                      <div className="tl-tags">
                        {it.lowStock && <Status tone="warn">{tr('Reorder')}</Status>}
                        {ex && <Status tone={ex.tone}>{ex.text}</Status>}
                      </div>
                    )}
                    <span className={'tl-stock' + (it.lowStock ? ' is-low' : '')}>
                      <span className="tl-stock-row"><strong>{qtyText(it.stockQty, it.unit)}</strong>{it.reorderLevel > 0 && <span className="dk-muted">{tr('reorder at {n}', { n: qtyText(it.reorderLevel) })}</span>}</span>
                      <span className="tl-stock-bar" aria-hidden="true"><span style={{ width: Math.min(100, Math.round((it.stockQty / full) * 100)) + '%' }} /></span>
                    </span>
                    <div className="tl-foot">
                      <span className="dk-muted tl-small">
                        {[money(it.value), it.used30 ? tr('{qty} used in 30 days', { qty: qtyText(it.used30, it.unit) }) : null, it.wasted30 ? tr('{qty} thrown away', { qty: qtyText(it.wasted30, it.unit) }) : null].filter(Boolean).join(' · ')}
                      </span>
                      {canManage && <button type="button" className="btn btn-secondary tl-btn" onClick={() => openMove(it, it.lowStock ? 'received' : 'used')}>{tr('Record')}</button>}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </Section>
      )}

      {/* ── cash drawers ── */}
      {view === 'drawers' && (
        <Section id="rs-drawers" title={tr('Cash drawers')} sub={tr('Each shift on the till: the cash that should be in the drawer against what was counted when it closed.')}>
          {drawers.sessions.length ? (
            <ul className="rs-list" style={{ opacity: drawersLoading ? 0.6 : 1 }}>
              {drawers.sessions.map((s) => {
                const st = drawerState({ status: s.session.status, difference: s.difference });
                return (
                  <li key={s.session.id} className={'rs-row' + (st.tone === 'bad' ? ' is-short' : '')}>
                    <button type="button" className="rs-row-open" onClick={() => openDrawer(s.session.id)}>
                      <span className="rs-row-main">
                        <strong>{s.cashierName}</strong>
                        <span className="dk-muted tl-small">{when(s.session.openedAt)}{s.session.closedAt ? ' – ' + when(s.session.closedAt) : ' · ' + tr('still open')}</span>
                      </span>
                      <span className="rs-row-side">
                        <span className="rs-amount">{tr('expected {amount}', { amount: money(s.expected) })}</span>
                        <Status tone={st.tone}>{st.text}</Status>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : !drawersLoading && <p className="dk-muted tl-small">{tr('No drawer sessions yet — opened/closed on the till, they\'ll show here')}</p>}
          {drawers.total > DRAWER_PAGE && (
            <div className="rs-pager">
              <span className="dk-muted tl-small">{tr('{n}–{n2} of {total}', { n: drawersOffset + 1, n2: Math.min(drawersOffset + DRAWER_PAGE, drawers.total), total: drawers.total })}</span>
              <button type="button" className="btn btn-secondary tl-btn" disabled={drawersOffset === 0 || drawersLoading} onClick={() => setDrawersOffset(Math.max(0, drawersOffset - DRAWER_PAGE))}>{tr('Previous')}</button>
              <button type="button" className="btn btn-secondary tl-btn" disabled={drawersOffset + DRAWER_PAGE >= drawers.total || drawersLoading} onClick={() => setDrawersOffset(drawersOffset + DRAWER_PAGE)}>{tr('Next')}</button>
            </div>
          )}
        </Section>
      )}

      {/* ── tables & guests ── */}
      {view === 'tables' && (
        <div className="dk-two">
          <Section id="rs-tables" title={tr('Tables')} sub={tr('The tables a waiter can pick on the till.')} card
            action={canManage && <button type="button" className="btn btn-secondary tl-btn" onClick={() => { setFormError(null); setTableDialog({ name: '' }); }}>{tr('Add table')}</button>}>
            {tables.length ? (
              <div className="rs-tables">
                {tables.map((t) => (
                  <span key={t.id} className={'rs-table' + (t.status === 'active' ? '' : ' is-off')}>
                    <strong>{t.name}</strong>
                    {t.status !== 'active' && <span className="dk-muted tl-small">{tr('Archived')}</span>}
                    {canManage && <RowMenu actions={[
                      { label: tr('Rename'), onClick: () => { setFormError(null); setTableDialog({ id: t.id, name: t.name }); } },
                      { label: t.status === 'active' ? tr('Archive') : tr('Reactivate'), onClick: () => run(() => api.post('/restaurant/tables/' + t.id + '/active', { active: t.status !== 'active' }), t.status === 'active' ? tr('Table archived.') : tr('Table reactivated.')) },
                      { label: tr('Delete'), onClick: () => run(() => api.del('/restaurant/tables/' + t.id), tr('Table removed.')), danger: true }
                    ]} />}
                  </span>
                ))}
              </div>
            ) : <p className="dk-muted tl-small">{tr('No tables set up yet')}</p>}
          </Section>
          <Section id="rs-guests" title={tr('Guests')} sub={tr('Regulars saved on the till, with their phone and anything to remember.')} card
            action={canManage && <button type="button" className="btn btn-secondary tl-btn" onClick={() => { setFormError(null); setGuestDialog({ name: '', phone: '', notes: '' }); }}>{tr('Add guest')}</button>}>
            {guests.length > 6 && <div className="tl-search rs-guest-search"><SearchInput value={guestSearch} onChange={setGuestSearch} placeholder={tr('Search guests…')} /></div>}
            {visibleGuests.length ? (
              <ul className="rs-guests">
                {visibleGuests.map((g) => (
                  <li key={g.id}>
                    <span className="rs-guest-main"><strong>{g.name}</strong>{(g.phone || g.notes) && <span className="dk-muted tl-small">{[g.phone, g.notes].filter(Boolean).join(' · ')}</span>}</span>
                    <ContactButtons name={g.name} phone={g.phone} />
                    {canManage && <RowMenu actions={[
                      { label: tr('Edit'), onClick: () => { setFormError(null); setGuestDialog({ id: g.id, name: g.name, phone: g.phone || '', notes: g.notes || '' }); } },
                      { label: tr('Delete'), onClick: () => run(() => api.del('/restaurant/guests/' + g.id), tr('Guest removed.')), danger: true }
                    ]} />}
                  </li>
                ))}
              </ul>
            ) : <p className="dk-muted tl-small">{guests.length ? tr('Nothing matches. Try another search or filter.') : tr('No guests saved yet')}</p>}
          </Section>
        </div>
      )}

      <Glossary items={[
        [tr('Sales'), tr('Orders completed on the till. A voided order is not counted.')],
        [tr('Void'), tr('Cancelling an order after it was rung up — a mistake on the till. It stays on the list, marked voided.')],
        [tr('Variation'), tr('One menu item at different prices, like a small and a large. The till asks which one.')],
        [tr('Delivery received / used / thrown away / counted'), tr('The four ways stock changes. A count sets the stock to what is really on the shelf; the difference is kept in the history.')],
        [tr('Reorder level'), tr('When an item gets down to this, it is time to buy more.')],
        [tr('Cash drawer'), tr('The starting cash, plus cash sales, plus cash paid in, minus cash paid out, is what should be in the drawer. Short means less was counted.')]
      ]} />

      {/* ── menu item ── */}
      {menuDialog && (
        <div className="dialog-backdrop" onClick={() => !saving && setMenuDialog(null)}>
          <form className="dialog tl-dialog" onClick={(e) => e.stopPropagation()} onSubmit={saveMenu}>
            <h2>{menuDialog.id ? tr('Edit menu item') : tr('Add menu item')}</h2>
            <div className="tl-form">
              <div className="field tl-span">
                <label htmlFor="rm-name">{tr('Name')}</label>
                <input id="rm-name" className="input" maxLength={100} value={menuForm.name} onChange={(e) => setMenuForm({ ...menuForm, name: e.target.value })} required />
              </div>
              <div className="field">
                <label htmlFor="rm-category">{tr('Category')}</label>
                <input id="rm-category" className="input" list="rm-categories" maxLength={40} value={menuForm.category} onChange={(e) => setMenuForm({ ...menuForm, category: e.target.value })} placeholder={tr('Mains, Drinks, Starters…')} />
                <datalist id="rm-categories">{menuCategories.map((c) => <option key={c} value={c} />)}</datalist>
              </div>
              <div className="field">
                <label htmlFor="rm-price">{tr('Price')}</label>
                <input id="rm-price" className="input" type="number" min="0" step="0.01" value={menuForm.price} onChange={(e) => setMenuForm({ ...menuForm, price: e.target.value })} required />
                {editingItem && editingItem.variations.length > 0 && <span className="dk-muted tl-small">{tr('The till charges the variation picked, not this price.')}</span>}
              </div>
              <div className="field tl-span">
                <span className="tl-label">{tr('Photo (shown on the POS till)')}</span>
                <div className="rs-photo">
                  {photo.preview ? <img src={photo.preview} alt="" /> : <span className="rs-plate is-empty" aria-hidden="true">{String(menuForm.name || '?').charAt(0).toUpperCase()}</span>}
                  <span className="rs-photo-acts">
                    <input id="rm-photo" type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => { const f = e.target.files[0]; if (f) setPhoto({ file: f, preview: URL.createObjectURL(f), removed: false }); }} />
                    {photo.preview && <button type="button" className="btn btn-secondary tl-btn" onClick={() => setPhoto({ file: null, preview: null, removed: true })}>{tr('Remove photo')}</button>}
                  </span>
                </div>
              </div>
              {menuDialog.id ? (
                <div className="field tl-span">
                  <span className="tl-label">{tr('Price variations (optional — e.g. "M" ₵98 vs "Jellyfish" ₵238)')}</span>
                  {editingItem && editingItem.variations.length > 0 && (
                    <ul className="rs-vars">
                      {editingItem.variations.map((v) => (
                        <li key={v.id}>
                          <span>{v.name}</span><strong>{money(v.price)}</strong>
                          <button type="button" className="btn btn-secondary tl-btn" onClick={() => setVariation({ id: v.id, name: v.name, price: v.price, error: null, saving: false })}>{tr('Edit')}</button>
                          <button type="button" className="btn btn-secondary tl-btn" onClick={() => dropVariation(v)}>{tr('Remove')}</button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="rs-var-add">
                    <input className="input" aria-label={tr('Variation name')} placeholder={tr('Name (e.g. M, Large, Jellyfish…)')} value={variation.name} onChange={(e) => setVariation({ ...variation, name: e.target.value })} />
                    <input className="input" aria-label={tr('Variation price')} type="number" min="0" step="0.01" placeholder={tr('Price')} value={variation.price} onChange={(e) => setVariation({ ...variation, price: e.target.value })} />
                    <button type="button" className="btn btn-secondary tl-btn" disabled={variation.saving} onClick={saveVariation}>{variation.id ? tr('Save') : tr('Add')}</button>
                    {variation.id && <button type="button" className="btn btn-secondary tl-btn" onClick={() => setVariation({ id: null, name: '', price: '', error: null, saving: false })}>{tr('Cancel')}</button>}
                  </div>
                  {variation.error && <div className="error-banner">{variation.error}</div>}
                </div>
              ) : <p className="dk-muted tl-small tl-span">{tr('Save this item first, then reopen it here to add price variations.')}</p>}
            </div>
            {formError && <div className="error-banner">{formError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setMenuDialog(null)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : menuDialog.id ? tr('Save changes') : tr('Add item')}</button>
            </div>
          </form>
        </div>
      )}

      {/* ── food / supply item ── */}
      {stockDialog && (
        <div className="dialog-backdrop" onClick={() => !saving && setStockDialog(null)}>
          <form className="dialog tl-dialog" onClick={(e) => e.stopPropagation()} onSubmit={saveStockItem}>
            <h2>{stockDialog.type === 'supply' ? (stockDialog.id ? tr('Edit supply item') : tr('Add supply item')) : (stockDialog.id ? tr('Edit ingredient') : tr('Add food item'))}</h2>
            <div className="tl-form">
              <div className="field tl-span">
                <label htmlFor="rsi-name">{tr('Name')}</label>
                <input id="rsi-name" className="input" maxLength={100} value={stockForm.name} onChange={(e) => setStockForm({ ...stockForm, name: e.target.value })} required />
              </div>
              {stockDialog.type === 'supply' && (
                <div className="field">
                  <label htmlFor="rsi-cat">{tr('Category')}</label>
                  <input id="rsi-cat" className="input" maxLength={40} value={stockForm.category} onChange={(e) => setStockForm({ ...stockForm, category: e.target.value })} placeholder={tr('Disposables, Cleaning, Glassware…')} />
                </div>
              )}
              <div className="field">
                <label htmlFor="rsi-unit">{tr('Unit')}</label>
                <input id="rsi-unit" className="input" maxLength={20} value={stockForm.unit} onChange={(e) => setStockForm({ ...stockForm, unit: e.target.value })} placeholder={stockDialog.type === 'supply' ? tr('each, pack, box…') : tr('kg, litre, dozen…')} />
              </div>
              {!stockDialog.id && (
                <div className="field">
                  <label htmlFor="rsi-qty">{tr('Starting stock')}</label>
                  <input id="rsi-qty" className="input" type="number" min="0" step="any" value={stockForm.stockQty} onChange={(e) => setStockForm({ ...stockForm, stockQty: e.target.value })} required />
                </div>
              )}
              <div className="field">
                <label htmlFor="rsi-reorder">{tr('Reorder level')}</label>
                <input id="rsi-reorder" className="input" type="number" min="0" step="any" value={stockForm.reorderLevel} onChange={(e) => setStockForm({ ...stockForm, reorderLevel: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="rsi-cost">{tr('Unit cost')}</label>
                <input id="rsi-cost" className="input" type="number" min="0" step="any" value={stockForm.unitCost} onChange={(e) => setStockForm({ ...stockForm, unitCost: e.target.value })} />
              </div>
              {stockDialog.type === 'ingredient' && (
                <div className="field">
                  <label htmlFor="rsi-exp">{tr('Use by (optional)')}</label>
                  <input id="rsi-exp" className="input" type="date" value={stockForm.expiryDate} onChange={(e) => setStockForm({ ...stockForm, expiryDate: e.target.value })} />
                </div>
              )}
              {stockDialog.id && <p className="dk-muted tl-small tl-span">{tr('To change how much is in stock, record a delivery, what was used or a count, so the history stays right.')}</p>}
            </div>
            {formError && <div className="error-banner">{formError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setStockDialog(null)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : stockDialog.id ? tr('Save changes') : tr('Add item')}</button>
            </div>
          </form>
        </div>
      )}

      {/* ── record a stock movement ── */}
      {moveDialog && moveItem && (
        <div className="dialog-backdrop" onClick={() => !saving && setMoveDialog(null)}>
          <form className="dialog tl-dialog" onClick={(e) => e.stopPropagation()} onSubmit={saveMove}>
            <h2>{moveItem.name}</h2>
            <p className="dk-muted tl-small">{tr('{qty} in stock now.', { qty: qtyText(moveItem.stockQty, moveItem.unit) })}</p>
            <div className="tl-seg" role="radiogroup" aria-label={tr('What happened')}>
              {STOCK_KINDS.map((k) => <button key={k.key} type="button" role="radio" aria-checked={moveForm.kind === k.key} className={'tl-seg-btn' + (k.key === 'wasted' ? ' is-poor' : '') + (moveForm.kind === k.key ? ' is-on' : '')} onClick={() => setMoveForm({ ...moveForm, kind: k.key })}>{tr(k.label)}</button>)}
            </div>
            <div className="tl-form">
              <div className="field">
                <label htmlFor="rmv-qty">{moveForm.kind === 'count' ? tr('How much is on the shelf') : tr('How much')}{moveItem.unit && moveItem.unit !== 'each' ? ' (' + moveItem.unit + ')' : ''}</label>
                <input id="rmv-qty" className="input" type="number" min="0" step="any" value={moveForm.qty} onChange={(e) => setMoveForm({ ...moveForm, qty: e.target.value })} required autoFocus />
                {moveAfter !== null && <span className={'tl-small ' + (moveAfter < 0 ? 'tl-low' : 'dk-muted')}>{moveAfter < 0 ? tr('That is more than is in stock.') : tr('After this: {qty}', { qty: qtyText(moveAfter, moveItem.unit) })}</span>}
              </div>
              {moveForm.kind === 'received' && (
                <div className="field">
                  <label htmlFor="rmv-cost">{tr('Cost per {unit}', { unit: moveItem.unit || tr('item') })}</label>
                  <input id="rmv-cost" className="input" type="number" min="0" step="any" value={moveForm.unitCost} onChange={(e) => setMoveForm({ ...moveForm, unitCost: e.target.value })} />
                </div>
              )}
              {moveForm.kind === 'received' && moveItem.type === 'ingredient' && (
                <div className="field">
                  <label htmlFor="rmv-exp">{tr('Use by (optional)')}</label>
                  <input id="rmv-exp" className="input" type="date" value={moveForm.expiryDate} onChange={(e) => setMoveForm({ ...moveForm, expiryDate: e.target.value })} />
                </div>
              )}
              <div className="field tl-span">
                <label htmlFor="rmv-note">{tr('Note (optional)')}</label>
                <input id="rmv-note" className="input" maxLength={200} value={moveForm.note} onChange={(e) => setMoveForm({ ...moveForm, note: e.target.value })}
                  placeholder={{ received: tr('Supplier, invoice number…'), used: tr('What it was for…'), wasted: tr('Why — spoiled, broken, dropped…'), count: tr('Who counted…') }[moveForm.kind]} />
              </div>
            </div>
            {formError && <div className="error-banner">{formError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setMoveDialog(null)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Record it')}</button>
            </div>
          </form>
        </div>
      )}

      {/* ── a stock item's history ── */}
      {detailItem && (
        <div className="dialog-backdrop" onClick={() => setStockDetail(null)}>
          <div className="dialog tl-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="tl-detail-head">
              <div>
                <span className="dk-muted tl-small">{detailItem.type === 'ingredient' ? tr('Food') : tr('Supply') + (detailItem.category ? ' · ' + detailItem.category : '')}</span>
                <h2>{detailItem.name}</h2>
                <div className="tl-tags">
                  {detailItem.lowStock && <Status tone="warn">{tr('Reorder')}</Status>}
                  {expiryOf(detailItem) && <Status tone={expiryOf(detailItem).tone}>{expiryOf(detailItem).text}</Status>}
                </div>
              </div>
              <button type="button" className="tl-close" onClick={() => setStockDetail(null)} aria-label={tr('Close')}>×</button>
            </div>
            <dl className="tl-facts">
              <div><dt>{tr('In stock')}</dt><dd>{qtyText(detailItem.stockQty, detailItem.unit)}</dd></div>
              <div><dt>{tr('Reorder level')}</dt><dd>{detailItem.reorderLevel ? qtyText(detailItem.reorderLevel, detailItem.unit) : '—'}</dd></div>
              <div><dt>{tr('Unit cost')}</dt><dd>{money(detailItem.unitCost)}</dd></div>
              <div><dt>{tr('Worth')}</dt><dd>{money(detailItem.value)}</dd></div>
              <div><dt>{tr('Used in 30 days')}</dt><dd>{qtyText(detailItem.used30, detailItem.unit)}</dd></div>
              <div><dt>{tr('Runs out in')}</dt><dd>{detailItem.daysLeft === null ? '—' : detailItem.daysLeft === 1 ? tr('about 1 day') : tr('about {n} days', { n: detailItem.daysLeft })}</dd></div>
            </dl>
            <h3 className="tl-h3">{tr('History')}</h3>
            {stockMoves === null ? <p className="dk-muted tl-small">{tr('Loading…')}</p> : stockMoves.length ? (
              <ul className="tl-log">
                {stockMoves.map((m) => {
                  const d = new Date(m.at);
                  return (
                    <li key={m.id} className={'tl-log-row is-' + ({ received: 'restock', used: 'issue', wasted: 'retire', count: 'count' }[m.kind])}>
                      <span className="tl-date" aria-hidden="true"><strong>{d.getDate()}</strong><span>{d.toLocaleDateString(activeIntlLocale(), { month: 'short', year: '2-digit' })}</span></span>
                      <span className="tl-log-main">
                        <span className="tl-log-title">{tr(MOVE_LABELS[m.kind])} · {m.kind === 'count' ? qtyText(m.qtyAfter, detailItem.unit) : (m.delta > 0 ? '+' : '−') + qtyText(Math.abs(m.delta), detailItem.unit)}</span>
                        <span className="dk-muted tl-small">{[
                          m.kind === 'count' && m.delta ? tr('{diff} against the book', { diff: (m.delta > 0 ? '+' : '−') + qtyText(Math.abs(m.delta)) }) : null,
                          m.kind !== 'count' ? tr('{qty} left', { qty: qtyText(m.qtyAfter) }) : null,
                          m.kind === 'received' && m.unitCost ? tr('{amount} each', { amount: money(m.unitCost) }) : null,
                          m.note, m.byName && tr('by {name}', { name: m.byName })
                        ].filter(Boolean).join(' · ')}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="dk-muted tl-small">{tr('Nothing recorded yet.')}</p>}
            <div className="dialog-actions tl-actions">
              {canManage && <button type="button" className="btn btn-secondary" onClick={() => openStockItem(detailItem.type, detailItem)}>{tr('Edit')}</button>}
              {canManage && <button type="button" className="btn btn-secondary" onClick={() => openMove(detailItem, 'count')}>{tr('Count it')}</button>}
              {canManage && <button type="button" className="btn btn-primary" onClick={() => openMove(detailItem, 'received')}>{tr('Record a delivery')}</button>}
              {!canManage && <button type="button" className="btn btn-primary" onClick={() => setStockDetail(null)}>{tr('Close')}</button>}
            </div>
          </div>
        </div>
      )}

      {/* ── table / guest ── */}
      {tableDialog && (
        <div className="dialog-backdrop" onClick={() => !saving && setTableDialog(null)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={saveTable}>
            <h2>{tableDialog.id ? tr('Rename table') : tr('Add table')}</h2>
            <div className="field">
              <label htmlFor="rt-name">{tr('Name')}</label>
              <input id="rt-name" className="input" maxLength={40} value={tableDialog.name} onChange={(e) => setTableDialog({ ...tableDialog, name: e.target.value })} placeholder={tr('Table 5, Bar, Patio 3…')} required autoFocus />
            </div>
            {formError && <div className="error-banner">{formError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setTableDialog(null)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{tableDialog.id ? tr('Save changes') : tr('Add table')}</button>
            </div>
          </form>
        </div>
      )}
      {guestDialog && (
        <div className="dialog-backdrop" onClick={() => !saving && setGuestDialog(null)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={saveGuest}>
            <h2>{guestDialog.id ? tr('Edit guest') : tr('Add guest')}</h2>
            <div className="field">
              <label htmlFor="rg-name">{tr('Name')}</label>
              <input id="rg-name" className="input" maxLength={100} value={guestDialog.name} onChange={(e) => setGuestDialog({ ...guestDialog, name: e.target.value })} required autoFocus />
            </div>
            <div className="field">
              <label htmlFor="rg-phone">{tr('Phone')}</label>
              <input id="rg-phone" className="input" value={guestDialog.phone} onChange={(e) => setGuestDialog({ ...guestDialog, phone: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="rg-notes">{tr('Notes')}</label>
              <input id="rg-notes" className="input" value={guestDialog.notes} onChange={(e) => setGuestDialog({ ...guestDialog, notes: e.target.value })} placeholder={tr('Allergies, preferences…')} />
            </div>
            {formError && <div className="error-banner">{formError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setGuestDialog(null)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{guestDialog.id ? tr('Save changes') : tr('Add guest')}</button>
            </div>
          </form>
        </div>
      )}

      {/* ── one order ── */}
      {orderDetail && (
        <div className="dialog-backdrop" onClick={() => setOrderDetail(null)}>
          <div className="dialog tl-dialog rs-receipt" onClick={(e) => e.stopPropagation()}>
            {orderDetail.loading && <p className="dk-muted">{tr('Loading…')}</p>}
            {orderDetail.error && <div className="error-banner">{orderDetail.error}</div>}
            {orderDetail.data && (() => {
              const o = orderDetail.data;
              return (
                <>
                  <div className="tl-detail-head">
                    <div>
                      <span className="dk-muted tl-small">{when(o.createdAt)} · {o.cashierName}</span>
                      <h2>{o.orderNo}</h2>
                      <div className="tl-tags">{o.status === 'voided' ? <Status tone="bad">{tr('Voided')}</Status> : <Status tone="good">{tr('Paid by {method}', { method: codeLabel(o.paymentMethod).toLowerCase() })}</Status>}</div>
                    </div>
                    <button type="button" className="tl-close" onClick={() => setOrderDetail(null)} aria-label={tr('Close')}>×</button>
                  </div>
                  <ul className="rs-lines">
                    {o.items.map((it, i) => <li key={i}><span className="rs-qty">{qtyText(it.qty)}×</span><span>{it.name}</span><strong>{money(it.lineTotal)}</strong></li>)}
                    <li className="rs-total"><span /><span>{tr('Total')}</span><strong>{money(o.total)}</strong></li>
                  </ul>
                  {(o.tableName || o.waiterName || o.guestName) && (
                    <dl className="tl-facts">
                      {o.tableName && <div><dt>{tr('Table')}</dt><dd>{o.tableName}</dd></div>}
                      {o.waiterName && <div><dt>{tr('Waiter')}</dt><dd>{o.waiterName}</dd></div>}
                      {o.guestName && <div><dt>{tr('Guest')}</dt><dd>{o.guestName}{o.guestPhone ? ' · ' + o.guestPhone : ''}</dd></div>}
                    </dl>
                  )}
                  <div className="dialog-actions">
                    {canManage && o.status === 'completed' && <button type="button" className="btn btn-secondary rs-danger" onClick={() => voidOrder(o)}>{tr('Void this order')}</button>}
                    <button type="button" className="btn btn-primary" onClick={() => setOrderDetail(null)}>{tr('Close')}</button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* ── one drawer ── */}
      {drawerDetail && (
        <div className="dialog-backdrop" onClick={() => setDrawerDetail(null)}>
          <div className="dialog tl-dialog rs-receipt" onClick={(e) => e.stopPropagation()}>
            {drawerDetail.loading && <p className="dk-muted">{tr('Loading…')}</p>}
            {drawerDetail.error && <div className="error-banner">{drawerDetail.error}</div>}
            {drawerDetail.data && (() => {
              const d = drawerDetail.data;
              const st = drawerState({ status: d.session.status, difference: d.difference });
              return (
                <>
                  <div className="tl-detail-head">
                    <div>
                      <span className="dk-muted tl-small">{when(d.session.openedAt)}{d.session.closedAt ? ' – ' + when(d.session.closedAt) : ' · ' + tr('still open')}</span>
                      <h2>{tr('Drawer Report:')} {d.cashierName}</h2>
                      <div className="tl-tags"><Status tone={st.tone}>{st.text}</Status></div>
                    </div>
                    <button type="button" className="tl-close" onClick={() => setDrawerDetail(null)} aria-label={tr('Close')}>×</button>
                  </div>
                  <ul className="rs-lines">
                    <li><span /><span>{tr('Starting Cash')}</span><strong>{money(d.startingCash)}</strong></li>
                    <li><span>+</span><span>{tr('Cash Sales')}</span><strong>{money(d.cashSales)}</strong></li>
                    <li><span>−</span><span>{tr('Cash Refunds')}</span><strong>{money(d.cashRefunds)}</strong></li>
                    <li><span>±</span><span>{tr('Paid In/Out')}</span><strong>{d.netPaidInOut < 0 ? '−' : ''}{money(Math.abs(d.netPaidInOut))}</strong></li>
                    <li className="rs-total"><span>=</span><span>{tr('Expected in Drawer')}</span><strong>{money(d.expected)}</strong></li>
                    <li><span /><span>{tr('Counted')}</span><strong>{d.actual === null ? '—' : money(d.actual)}</strong></li>
                  </ul>
                  {d.session.closingNote && <p className="tl-notes">{d.session.closingNote}</p>}
                  {d.movements.length > 0 && (
                    <>
                      <h3 className="tl-h3">{tr('Paid In/Out')}</h3>
                      <ul className="rs-lines">
                        {d.movements.map((m) => (
                          <li key={m.id}><span>{m.direction === 'in' ? '+' : '−'}</span><span>{new Date(m.createdAt).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' })}{m.note ? ' — ' + m.note : ''}</span><strong>{money(m.amount)}</strong></li>
                        ))}
                      </ul>
                    </>
                  )}
                  <div className="dialog-actions"><button type="button" className="btn btn-primary" onClick={() => setDrawerDetail(null)}>{tr('Close')}</button></div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
