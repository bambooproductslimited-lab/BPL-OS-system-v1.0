import { useEffect, useMemo, useRef, useState } from 'react';
import { API_URL, API_ORIGIN, ApiError } from '../api/client';
import { money } from '../lib/currency';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { restaurantLogoUrl } from '../lib/restaurantLogos';
import {
  buildReceiptBytes, buildDrawerReportBytes, usbSupported, bluetoothSupported,
  requestUsbPrinter, requestBluetoothPrinter, reconnectUsbPrinter, reconnectBluetoothPrinter
} from '../lib/thermalPrinter';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import { Icon, Status } from '../components/DashKit';
import { applyTheme, clearTheme, getInitialTheme, THEME_KEY } from '../lib/theme';
import '../components/DashKit.css';
import './ToolRoomPage.css';
import './RestaurantPosPage.css';
import { codeLabel } from '../lib/codeLabels.js';

// Same "animate a live-data-driven number, not a CSS keyframe" hook as
// RestaurantsPage.jsx's — small enough, and specific enough to each page's
// own values, that a shared component isn't worth it yet.
function useCountUp(target, durationMs) {
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  const rafRef = useRef(null);
  useEffect(() => {
    const from = fromRef.current;
    const to = Number(target) || 0;
    if (from === to) return undefined;
    const start = performance.now();
    const duration = durationMs || 400;
    function tick(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (to - from) * eased);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = to;
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  return display;
}

// The restaurant POS's own till page — a full-screen, standalone page
// meant to be opened on a shared counter device (tablet/PC) at Star Bar
// Restaurant or Bamboo Garden, outside ProtectedRoute/AppShell in App.jsx
// just like /kiosk, since the till itself never logs into the main app as
// anyone. Whoever is working the counter enters their 4-digit kiosk PIN
// (the exact same one used to clock in/out — see restaurantPos.service.js)
// once per shift rather than per sale; the pin pad here reuses KioskPage's
// own CSS classes verbatim so the two "unattended device" experiences look
// like one consistent product, while the menu/cart/checkout below is its
// own layout.
//
// Session persistence: the till-session token restaurantPos.service.js
// issues is good for 12 hours, stored in localStorage so a page reload
// (or the tablet waking from sleep) doesn't force a re-login mid-shift —
// re-validated against /pos/menu on mount, and cleared if that comes back
// 401 (expired or the server restarted, which drops nothing server-side
// since the token is self-contained, but is still worth handling).
var SESSION_KEY = 'bamboo.pos.session';
var PIN_LENGTH = 4;

// The real Square-imported menus (1,600+ items each) have no photos yet —
// uploading one is a per-item, opt-in action from the management page
// (RestaurantsPage.jsx), so most tiles fall back to a flat colour + initial
// rather than a generic placeholder icon; a small fixed palette keeps the
// grid visually varied without pulling in an image for every item.
var TILE_PALETTE = ['#2dd4bf', '#f59e0b', '#f472b6', '#818cf8', '#fb7185', '#34d399', '#60a5fa', '#facc15'];
function tileColor(seed) {
  var s = String(seed || '');
  var hash = 0;
  for (var i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return TILE_PALETTE[hash % TILE_PALETTE.length];
}
function tileInitial(name) {
  var trimmed = String(name || '').trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
}

async function posFetch(method, path, token, body) {
  var headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  var res = await fetch(API_URL + path, { method: method, headers: headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  var text = await res.text();
  var data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  if (!res.ok) {
    var err = data && data.error;
    throw new ApiError(res.status, err ? err.code : 'error', err ? err.message : tr('Something went wrong.'));
  }
  return data;
}

export default function RestaurantPosPage() {
  const [session, setSession] = useState(null); // { token, employeeName, companyId, companyName }
  const [sessionChecked, setSessionChecked] = useState(false);
  const [pin, setPin] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState(null);

  const [menu, setMenu] = useState([]);
  const [menuLoading, setMenuLoading] = useState(false);
  const [menuError, setMenuError] = useState(null);
  const [search, setSearch] = useState('');

  // Quick-access tabs above the menu grid. 'all' is the default landing
  // view (the existing category-grouped grid, unchanged) rather than
  // 'favorites', since a brand-new till has no favorites yet and landing
  // on an empty tab would be a worse first impression than the familiar
  // full grid.
  const [viewTab, setViewTab] = useState('all'); // 'favorites' | 'recent' | 'mostly' | 'all'
  // Items tapped into the cart this shift, most-recent-first and deduped —
  // deliberately session-only (not persisted), unlike favorites: it's a
  // "what was I just doing" shortcut, not a lasting curation, so it
  // resets on logout along with the cart.
  const [recentIds, setRecentIds] = useState([]);
  const [mostlyBought, setMostlyBought] = useState([]);
  const [mostlyBoughtLoading, setMostlyBoughtLoading] = useState(false);

  const [cart, setCart] = useState([]); // [{ menuItemId, variationId, name, price, qty }]
  const [tappedId, setTappedId] = useState(null); // brief tap-feedback flash on the tile just added

  // Variation picker — mirrors the real Square POS's own item-detail modal:
  // tapping an item that has named price variations (e.g. "M" ₵98 vs
  // "Jellyfish" ₵238) opens this instead of adding straight to the cart.
  const [variantPickerItem, setVariantPickerItem] = useState(null); // the menu tile being picked for, or null

  // Table/waiter/guest — all optional, attached to the CURRENT in-progress
  // order only (like the cart itself: reset after each sale, never
  // persisted mid-shift). Cashier ≠ waiter: whoever's logged into the till
  // rings up the payment, but the person actually serving the table is
  // recorded separately (restaurantPos.service.js's createOrder), same
  // split Square's own POS makes.
  const [tables, setTables] = useState([]);
  const [waiters, setWaiters] = useState([]);
  const [selectedTable, setSelectedTable] = useState(null); // { id, name } | null
  const [selectedWaiter, setSelectedWaiter] = useState(null); // { id, name } | null
  const [selectedGuest, setSelectedGuest] = useState(null); // { id, name, phone } | null

  const [tablePickerOpen, setTablePickerOpen] = useState(false);
  const [waiterPickerOpen, setWaiterPickerOpen] = useState(false);
  const [guestPickerOpen, setGuestPickerOpen] = useState(false);
  const [guestSearch, setGuestSearch] = useState('');
  const [guestResults, setGuestResults] = useState([]);
  const [guestSearching, setGuestSearching] = useState(false);
  const [newGuestName, setNewGuestName] = useState('');
  const [newGuestPhone, setNewGuestPhone] = useState('');
  const [addingGuest, setAddingGuest] = useState(false);
  const [guestError, setGuestError] = useState(null);

  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [checkingOut, setCheckingOut] = useState(false);
  const [checkoutError, setCheckoutError] = useState(null);

  const [receipt, setReceipt] = useState(null);

  // Cash drawer session (per cashier — see restaurantPos.service.js's
  // buildReport). drawer is the current open session's live report (or
  // null); drawerChecked gates the till behind an "open your drawer"
  // prompt until we know one way or the other, same pattern as
  // sessionChecked above so there's no flash of the wrong screen.
  const [drawer, setDrawer] = useState(null);
  const [drawerChecked, setDrawerChecked] = useState(false);
  const [openingCash, setOpeningCash] = useState('');
  const [openingDrawer, setOpeningDrawer] = useState(false);
  const [openDrawerError, setOpenDrawerError] = useState(null);

  const [drawerPanelOpen, setDrawerPanelOpen] = useState(false);
  const [movementDirection, setMovementDirection] = useState(null); // 'in' | 'out' | null
  const [movementAmount, setMovementAmount] = useState('');
  const [movementNote, setMovementNote] = useState('');
  const [addingMovement, setAddingMovement] = useState(false);
  const [movementError, setMovementError] = useState(null);

  const [closeDrawerOpen, setCloseDrawerOpen] = useState(false);
  const [closeActualCash, setCloseActualCash] = useState('');
  const [closeNote, setCloseNote] = useState('');
  const [closingDrawer, setClosingDrawer] = useState(false);
  const [closeDrawerError, setCloseDrawerError] = useState(null);
  const [closedReport, setClosedReport] = useState(null); // set once closed — shows the printable report screen

  // Direct thermal-printer output (Phase 3) — set once per till device,
  // then reused for every sale's receipt for the rest of the shift (and
  // silently reconnected on reload, same as the till session itself).
  // Only ever a same-device convenience on top of the always-available
  // "Print receipt" browser-print button below — see thermalPrinter.js's
  // module comment for why WebUSB/WebBluetooth simply don't exist on an
  // iPad in any browser, so this stays optional rather than replacing it.
  const [printer, setPrinter] = useState(null); // { kind, name, write }
  const [printerError, setPrinterError] = useState(null);
  const [pairingKind, setPairingKind] = useState(null); // 'usb' | 'bluetooth' | null
  const [printing, setPrinting] = useState(false);

  // The till follows the OS's light/dark choice on this device, with its
  // own switch in the top bar.
  const [theme, setTheme] = useState(getInitialTheme);
  const [now, setNow] = useState(() => new Date());
  // This cashier's shift so far and the open tables (orders kept to pay
  // later) — restaurantPos.service.js's shiftSummary / listTabs.
  const [shift, setShift] = useState(null);
  const [tabs, setTabs] = useState([]);
  const [tabsOpen, setTabsOpen] = useState(false);
  const [currentTab, setCurrentTab] = useState(null); // the open table being added to, or null
  const [keepDialog, setKeepDialog] = useState(null); // { label } while naming an order to keep open
  const [savingTab, setSavingTab] = useState(false);
  const [tabError, setTabError] = useState(null);
  const [category, setCategory] = useState(''); // '' = every category
  const [cartOpen, setCartOpen] = useState(false); // the order as a full-screen sheet on a phone
  const [cashGiven, setCashGiven] = useState('');
  const [toast, setToast] = useState(null);

  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* remembered for this visit only */ }
  }, [theme]);
  useEffect(() => () => clearTheme(), []);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 20000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    (async () => {
      const usb = await reconnectUsbPrinter();
      if (usb) { setPrinter(usb); return; }
      const bt = await reconnectBluetoothPrinter();
      if (bt) setPrinter(bt);
    })();
  }, []);

  // Own service worker, scoped to /pos only (same pattern as KioskPage.jsx's
  // /kiosk one) — makes a till device's "Add to Home Screen" install open
  // straight into the POS with its own icon/name (pos-manifest.webmanifest,
  // pos.html) instead of landing on the main app's dashboard, and caches
  // the app shell so a till that loses wifi mid-shift still loads.
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/pos-sw.js', { scope: '/pos' }).catch(() => {});
    }
  }, []);

  async function pairUsb() {
    setPrinterError(null);
    setPairingKind('usb');
    try {
      const conn = await requestUsbPrinter();
      setPrinter(conn);
    } catch (err) {
      setPrinterError(err.message);
    } finally {
      setPairingKind(null);
    }
  }
  async function pairBluetooth() {
    setPrinterError(null);
    setPairingKind('bluetooth');
    try {
      const conn = await requestBluetoothPrinter();
      setPrinter(conn);
    } catch (err) {
      setPrinterError(err.message);
    } finally {
      setPairingKind(null);
    }
  }
  async function printToThermalPrinter(order) {
    setPrinting(true);
    setPrinterError(null);
    try {
      const bytes = buildReceiptBytes(order, session.companyName, session.employeeName, { kickDrawer: order.paymentMethod === 'cash' });
      await printer.write(bytes);
    } catch (err) {
      setPrinterError(tr('Could not print: {message}', { message: err.message }));
    } finally {
      setPrinting(false);
    }
  }

  async function loadMenu(token) {
    setMenuLoading(true);
    setMenuError(null);
    try {
      const items = await posFetch('GET', '/pos/menu', token);
      setMenu(items);
      return true;
    } catch (err) {
      if (err.status === 401) { localStorage.removeItem(SESSION_KEY); setSession(null); }
      else setMenuError(err.message);
      return false;
    } finally {
      setMenuLoading(false);
    }
  }

  // Loaded alongside the menu rather than lazily on first tab switch —
  // it's one cheap, already-windowed aggregate query (see
  // restaurantPos.service.js's mostlyBought), and fetching it upfront
  // avoids a loading flicker the first time someone taps the tab.
  async function loadMostlyBought(token) {
    setMostlyBoughtLoading(true);
    try {
      setMostlyBought(await posFetch('GET', '/pos/menu/mostly-bought', token));
    } catch {
      // Non-critical — the tab just shows its empty state if this fails.
    } finally {
      setMostlyBoughtLoading(false);
    }
  }

  // Tables/waiters are per-company catalogues (management-set for tables,
  // any active employee for waiters) — cheap, loaded alongside the menu
  // same as mostlyBought above rather than lazily when a picker opens.
  async function loadTablesAndWaiters(token) {
    try {
      const [t, w] = await Promise.all([
        posFetch('GET', '/pos/tables', token),
        posFetch('GET', '/pos/waiters', token)
      ]);
      setTables(t);
      setWaiters(w);
    } catch {
      // Non-critical — the pickers just show an empty list if this fails.
    }
  }

  async function toggleFavorite(e, item) {
    e.stopPropagation();
    try {
      const res = await posFetch('POST', '/pos/menu-items/' + item.id + '/favorite', session.token);
      setMenu((prev) => prev.map((m) => (m.id === item.id ? { ...m, favorite: res.favorite } : m)));
      setMostlyBought((prev) => prev.map((m) => (m.id === item.id ? { ...m, favorite: res.favorite } : m)));
    } catch (err) {
      if (err.status === 401) { localStorage.removeItem(SESSION_KEY); setSession(null); }
    }
  }

  async function loadShift(token) {
    try { setShift(await posFetch('GET', '/pos/shift', token || session.token)); } catch { /* the shift figures just don't show */ }
  }
  async function loadTabs(token) {
    try { setTabs(await posFetch('GET', '/pos/tabs', token || session.token)); } catch { /* the open tables list just stays as it was */ }
  }

  // The drawer's running figures (cash sales so far), after each sale.
  async function refreshDrawer() {
    try { const d = await posFetch('GET', '/pos/drawer', session.token); if (d) setDrawer(d); } catch { /* keeps the last figures */ }
  }

  async function loadDrawer(token) {
    loadShift(token);
    loadTabs(token);
    try {
      setDrawer(await posFetch('GET', '/pos/drawer', token));
    } catch {
      // Non-critical to the till loading — the open-drawer prompt below
      // just won't have anything to show and the cashier can retry via it.
    } finally {
      setDrawerChecked(true);
    }
  }

  useEffect(() => {
    const saved = localStorage.getItem(SESSION_KEY);
    if (!saved) { setSessionChecked(true); return; }
    let parsed;
    try { parsed = JSON.parse(saved); } catch { localStorage.removeItem(SESSION_KEY); setSessionChecked(true); return; }
    loadMenu(parsed.token).then((ok) => {
      if (ok) { setSession(parsed); loadMostlyBought(parsed.token); loadDrawer(parsed.token); loadTablesAndWaiters(parsed.token); }
      setSessionChecked(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function tapDigit(d) {
    if (loggingIn) return;
    const next = (pin + d).slice(0, PIN_LENGTH);
    setPin(next);
    if (next.length === PIN_LENGTH) handlePinComplete(next);
  }
  function tapClear() { if (!loggingIn) setPin(''); }
  // A till with a keyboard can type the PIN as well as tap it.
  useEffect(() => {
    if (session || !sessionChecked) return undefined;
    function onKey(e) {
      if (/^[0-9]$/.test(e.key)) tapDigit(e.key);
      else if (e.key === 'Backspace') tapBackspace();
      else if (e.key === 'Escape') tapClear();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  function tapBackspace() { if (!loggingIn) setPin(pin.slice(0, -1)); }

  async function handlePinComplete(fullPin) {
    setLoggingIn(true);
    setLoginError(null);
    try {
      const s = await posFetch('POST', '/pos/login', null, { pin: fullPin });
      localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      setSession(s);
      setPin('');
      await loadMenu(s.token);
      loadMostlyBought(s.token);
      loadDrawer(s.token);
      loadTablesAndWaiters(s.token);
    } catch (err) {
      setLoginError(err.message);
      setPin('');
    } finally {
      setLoggingIn(false);
    }
  }

  function logout() {
    localStorage.removeItem(SESSION_KEY);
    setSession(null);
    setCart([]);
    setMenu([]);
    setReceipt(null);
    setRecentIds([]);
    setMostlyBought([]);
    setViewTab('all');
    setDrawer(null);
    setDrawerChecked(false);
    setClosedReport(null);
    setTables([]);
    setWaiters([]);
    setSelectedTable(null);
    setSelectedWaiter(null);
    setSelectedGuest(null);
    setShift(null);
    setTabs([]);
    setCurrentTab(null);
    setCategory('');
    setCartOpen(false);
  }

  async function searchGuests(q) {
    setGuestSearching(true);
    try {
      setGuestResults(await posFetch('GET', '/pos/guests' + (q ? '?q=' + encodeURIComponent(q) : ''), session.token));
    } catch {
      // Non-critical — the picker just shows no results if this fails.
    } finally {
      setGuestSearching(false);
    }
  }

  function openGuestPicker() {
    setGuestError(null);
    setGuestSearch('');
    setNewGuestName('');
    setNewGuestPhone('');
    setGuestPickerOpen(true);
    searchGuests('');
  }

  async function submitNewGuest(e) {
    e.preventDefault();
    setAddingGuest(true);
    setGuestError(null);
    try {
      const g = await posFetch('POST', '/pos/guests', session.token, { name: newGuestName, phone: newGuestPhone });
      setSelectedGuest(g);
      setGuestPickerOpen(false);
    } catch (err) {
      if (err.status === 401) { localStorage.removeItem(SESSION_KEY); setSession(null); }
      else setGuestError(err.message);
    } finally {
      setAddingGuest(false);
    }
  }

  async function submitOpenDrawer(e) {
    e.preventDefault();
    setOpeningDrawer(true);
    setOpenDrawerError(null);
    try {
      setDrawer(await posFetch('POST', '/pos/drawer/open', session.token, { startingCash: openingCash === '' ? 0 : openingCash }));
      setOpeningCash('');
      loadShift();
    } catch (err) {
      if (err.status === 401) { localStorage.removeItem(SESSION_KEY); setSession(null); }
      else setOpenDrawerError(err.message);
    } finally {
      setOpeningDrawer(false);
    }
  }

  function openMovement(direction) {
    setMovementError(null);
    setMovementAmount('');
    setMovementNote('');
    setMovementDirection(direction);
  }

  async function submitMovement(e) {
    e.preventDefault();
    setAddingMovement(true);
    setMovementError(null);
    try {
      setDrawer(await posFetch('POST', '/pos/drawer/movements', session.token, {
        direction: movementDirection, amount: movementAmount, note: movementNote
      }));
      setMovementDirection(null);
      setToast(movementDirection === 'in' ? tr('Cash paid in recorded.') : tr('Cash paid out recorded.'));
    } catch (err) {
      if (err.status === 401) { localStorage.removeItem(SESSION_KEY); setSession(null); }
      else setMovementError(err.message);
    } finally {
      setAddingMovement(false);
    }
  }

  function openCloseDrawer() {
    setCloseDrawerError(null);
    setCloseActualCash('');
    setCloseNote('');
    setCloseDrawerOpen(true);
  }

  async function submitCloseDrawer(e) {
    e.preventDefault();
    setClosingDrawer(true);
    setCloseDrawerError(null);
    try {
      const report = await posFetch('POST', '/pos/drawer/close', session.token, {
        actualCash: closeActualCash === '' ? 0 : closeActualCash, note: closeNote
      });
      setClosedReport(report);
      setDrawer(null);
      setCloseDrawerOpen(false);
      setDrawerPanelOpen(false);
    } catch (err) {
      if (err.status === 401) { localStorage.removeItem(SESSION_KEY); setSession(null); }
      else setCloseDrawerError(err.message);
    } finally {
      setClosingDrawer(false);
    }
  }

  async function printDrawerReportThermal(report) {
    setPrinting(true);
    setPrinterError(null);
    try {
      const bytes = buildDrawerReportBytes(report, session.companyName, session.employeeName);
      await printer.write(bytes);
    } catch (err) {
      setPrinterError(tr('Could not print: {message}', { message: err.message }));
    } finally {
      setPrinting(false);
    }
  }

  var RECENT_LIMIT = 30;
  // A cart line is keyed by menuItemId + variationId so two variations of
  // the same dish ("M" and "Jellyfish") ring up as separate lines with
  // their own price, instead of colliding into one.
  function lineKey(menuItemId, variationId) { return menuItemId + '::' + (variationId || ''); }

  function tapItem(item) {
    if (item.variations && item.variations.length) { setVariantPickerItem(item); return; }
    addToCart(item, null);
  }
  function addToCart(item, variation) {
    const key = lineKey(item.id, variation && variation.id);
    setCart((prev) => {
      const idx = prev.findIndex((l) => lineKey(l.menuItemId, l.variationId) === key);
      if (idx >= 0) return prev.map((l, i) => (i === idx ? { ...l, qty: l.qty + 1 } : l));
      return prev.concat([{
        menuItemId: item.id, variationId: variation ? variation.id : null,
        name: variation ? item.name + ' — ' + variation.name : item.name,
        price: variation ? variation.price : item.price, qty: 1
      }]);
    });
    setRecentIds((prev) => [item.id].concat(prev.filter((id) => id !== item.id)).slice(0, RECENT_LIMIT));
    setTappedId(item.id);
    setTimeout(() => setTappedId((cur) => (cur === item.id ? null : cur)), 260);
    setVariantPickerItem(null);
  }
  function changeQty(menuItemId, variationId, delta) {
    const key = lineKey(menuItemId, variationId);
    setCart((prev) => prev.map((l) => (lineKey(l.menuItemId, l.variationId) === key ? { ...l, qty: Math.max(0, l.qty + delta) } : l)).filter((l) => l.qty > 0));
  }
  function removeLine(menuItemId, variationId) {
    const key = lineKey(menuItemId, variationId);
    setCart((prev) => prev.filter((l) => lineKey(l.menuItemId, l.variationId) !== key));
  }

  const cartTotal = cart.reduce((sum, l) => sum + l.price * l.qty, 0);
  const animatedCartTotal = useCountUp(cartTotal);
  const cartQtyById = useMemo(() => {
    const map = new Map();
    cart.forEach((l) => map.set(l.menuItemId, (map.get(l.menuItemId) || 0) + l.qty));
    return map;
  }, [cart]);

  function openCheckout() {
    setCheckoutError(null);
    setPaymentMethod('cash');
    setCashGiven('');
    setCartOpen(false);
    setCheckoutOpen(true);
  }

  async function submitCheckout() {
    setCheckingOut(true);
    setCheckoutError(null);
    try {
      const order = await posFetch('POST', '/pos/orders', session.token, {
        items: cart.map((l) => ({ menuItemId: l.menuItemId, variationId: l.variationId || undefined, qty: l.qty })),
        paymentMethod: paymentMethod,
        tableId: selectedTable ? selectedTable.id : undefined,
        waiterId: selectedWaiter ? selectedWaiter.id : undefined,
        guestId: selectedGuest ? selectedGuest.id : undefined,
        tabId: currentTab ? currentTab.id : undefined,
        cashTendered: paymentMethod === 'cash' && cashGiven !== '' ? Number(cashGiven) : undefined
      });
      // The order response only carries ids (see restaurantPos.service.js's
      // rowToOrder) — names come from what's already selected here, so the
      // receipt can show them without a second round trip.
      setReceipt({ ...order, tableName: selectedTable && selectedTable.name, waiterName: selectedWaiter && selectedWaiter.name, guestName: selectedGuest && selectedGuest.name });
      setCart([]);
      setSelectedTable(null);
      setSelectedWaiter(null);
      setSelectedGuest(null);
      setCurrentTab(null);
      setCheckoutOpen(false);
      loadShift();
      loadTabs();
      refreshDrawer();
    } catch (err) {
      if (err.status === 401) { localStorage.removeItem(SESSION_KEY); setSession(null); setCheckoutOpen(false); }
      else setCheckoutError(err.message);
    } finally {
      setCheckingOut(false);
    }
  }

  // ── open tables ──
  function clearOrder() {
    setCart([]);
    setSelectedTable(null);
    setSelectedWaiter(null);
    setSelectedGuest(null);
    setCurrentTab(null);
  }
  function keepOpen() {
    setTabError(null);
    if (selectedTable || selectedGuest || currentTab) { saveTab(currentTab ? currentTab.label : ''); return; }
    setKeepDialog({ label: '' });
  }
  async function saveTab(label, table) {
    const tbl = table || selectedTable;
    setSavingTab(true);
    setTabError(null);
    try {
      const saved = await posFetch('POST', '/pos/tabs', session.token, {
        id: currentTab ? currentTab.id : undefined, label: label || '',
        items: cart.map((l) => ({ menuItemId: l.menuItemId, variationId: l.variationId || undefined, qty: l.qty })),
        tableId: tbl ? tbl.id : undefined,
        waiterId: selectedWaiter ? selectedWaiter.id : undefined,
        guestId: selectedGuest ? selectedGuest.id : undefined
      });
      setToast(tr('{name} kept open. Pay it from Open tables.', { name: tabName(saved) }));
      setKeepDialog(null);
      setCartOpen(false);
      clearOrder();
      loadTabs();
      loadShift();
    } catch (err) {
      if (err.status === 401) { localStorage.removeItem(SESSION_KEY); setSession(null); }
      else if (keepDialog) setTabError(err.message);
      else setToast(err.message);
    } finally {
      setSavingTab(false);
    }
  }
  function tabName(t) { return t.tableName || t.label || t.guestName || tr('Order'); }
  function openTab(t, pay) {
    if (cart.length && !(currentTab && currentTab.id === t.id) && !window.confirm(tr('Put the order on the till aside and open {name}?', { name: tabName(t) }))) return;
    setCart(t.lines.map((l) => ({ menuItemId: l.menuItemId, variationId: l.variationId, name: l.name, price: l.unitPrice, qty: l.qty })));
    setSelectedTable(t.tableId ? { id: t.tableId, name: t.tableName } : null);
    setSelectedWaiter(t.waiterId ? { id: t.waiterId, name: t.waiterName } : null);
    setSelectedGuest(t.guestId ? { id: t.guestId, name: t.guestName } : null);
    setCurrentTab({ id: t.id, label: t.label, name: tabName(t), createdAt: t.createdAt });
    setTabsOpen(false);
    if (pay) { setCheckoutError(null); setPaymentMethod('cash'); setCashGiven(''); setCheckoutOpen(true); }
  }
  async function dropTab(t) {
    if (!window.confirm(tr('Remove the open order for {name}? Nothing has been paid for it.', { name: tabName(t) }))) return;
    try {
      await posFetch('DELETE', '/pos/tabs/' + t.id, session.token);
      if (currentTab && currentTab.id === t.id) clearOrder();
      setToast(tr('Open order removed.'));
      loadTabs();
      loadShift();
    } catch (err) { setToast(err.message); }
  }
  async function reprint(orderId) {
    try {
      const r = await posFetch('GET', '/pos/orders/' + orderId + '/receipt', session.token);
      setDrawerPanelOpen(false);
      setReceipt({ ...r, reprint: true });
    } catch (err) { setToast(err.message); }
  }

  // Star Bar's real Square-imported menu runs into the thousands of items —
  // a touch grid that size is unusable without a way to jump straight to
  // an item, so filtering here isn't cosmetic.
  const searchedMenu = useMemo(() => menu.filter((m) => matchesQuery(search, m.name, m.category)), [menu, search]);
  const grouped = useMemo(() => {
    const map = new Map();
    searchedMenu.forEach((m) => {
      if (!map.has(m.category)) map.set(m.category, []);
      map.get(m.category).push(m);
    });
    return Array.from(map.entries());
  }, [searchedMenu]);

  const favoriteItems = useMemo(() => searchedMenu.filter((m) => m.favorite), [searchedMenu]);
  const recentItems = useMemo(() => {
    const byId = new Map(searchedMenu.map((m) => [m.id, m]));
    return recentIds.map((id) => byId.get(id)).filter(Boolean);
  }, [recentIds, searchedMenu]);
  const mostlyBoughtItems = useMemo(() => mostlyBought.filter((m) => matchesQuery(search, m.name, m.category)), [mostlyBought, search]);

  const VIEW_TABS = [
    { key: 'all', label: tr('All items') },
    { key: 'favorites', label: tr('Favorites'), count: favoriteItems.length },
    { key: 'recent', label: tr('Recent'), count: recentItems.length },
    { key: 'mostly', label: tr('Mostly bought') }
  ];

  function tilePriceLabel(m) {
    if (!m.variations || !m.variations.length) return money(m.price);
    return tr('{n} prices', { n: m.variations.length });
  }
  function renderTile(m) {
    const qty = cartQtyById.get(m.id);
    return (
      <button
        key={m.id} type="button"
        className={'pos-tile' + (qty ? ' is-picked' : '') + (tappedId === m.id ? ' is-tapped' : '')}
        onClick={() => tapItem(m)}
      >
        <span className="pos-tile-pic" style={m.photoUrl ? undefined : { '--c': tileColor(m.name) }}>
          {m.photoUrl ? <img src={API_ORIGIN + m.photoUrl} alt="" loading="lazy" /> : <span>{tileInitial(m.name.replace(/^zq\s+/i, ''))}</span>}
        </span>
        <span className="pos-tile-text">
          <span className="pos-tile-name">{m.name}</span>
          <span className="pos-tile-price">{tilePriceLabel(m)}</span>
        </span>
        <span
          role="button" tabIndex={0}
          className={'pos-tile-star' + (m.favorite ? ' is-on' : '')}
          onClick={(e) => toggleFavorite(e, m)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFavorite(e, m); } }}
          aria-label={m.favorite ? tr('Remove from favorites') : tr('Add to favorites')}
          aria-pressed={m.favorite}
        >★</span>
        {!!qty && <span className="pos-tile-qty">{qty}</span>}
      </button>
    );
  }
  const themeButton = (
    <button type="button" className="pos-icon-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? tr('Light mode') : tr('Dark mode')} title={theme === 'dark' ? tr('Light mode') : tr('Dark mode')}>
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
  const firstName = session ? String(session.employeeName || '').split(' ').slice(0, -1).join(' ') || session.employeeName : '';
  const hour = now.getHours();
  const greeting = hour < 12 ? tr('Good morning, {name}', { name: firstName }) : hour < 17 ? tr('Good afternoon, {name}', { name: firstName }) : tr('Good evening, {name}', { name: firstName });
  const clock = now.toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' });
  const today = now.toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long' });
  const timeOf = (iso) => new Date(iso).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' });

  if (!sessionChecked) return null;

  if (!session) {
    return (
      <div className="dk pos-shell pos-gate">
        <div className="pos-gate-top">{themeButton}</div>
        <div className="pos-gate-card">
          <div className="pos-gate-side">
            <p className="dk-eyebrow">{today}</p>
            <div className="pos-clock">{clock}</div>
            <h1 className="pos-gate-title">{tr('Restaurant till')}</h1>
            <p className="dk-muted">{tr('Enter your 4-digit PIN, the same one you clock in with. The till then stays open for your shift on this device.')}</p>
            <div className="pos-gate-logos" aria-hidden="true">
              {['SBR', 'BGN'].map((c) => restaurantLogoUrl(c) && <img key={c} src={restaurantLogoUrl(c)} alt="" />)}
            </div>
          </div>
          <div className="pos-gate-pad">
            <div className={'pos-pin' + (loginError ? ' is-bad' : '')} aria-label={tr('PIN')}>
              {Array.from({ length: PIN_LENGTH }).map((_, i) => <span key={i} className={i < pin.length ? 'is-on' : ''} />)}
            </div>
            <p className={'pos-pin-note' + (loginError ? ' is-bad' : '')} role="status">{loggingIn ? tr('Checking…') : loginError || tr('Tap your PIN or type it.')}</p>
            <div className="pos-keypad">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                <button key={d} type="button" disabled={loggingIn} onClick={() => tapDigit(d)}>{d}</button>
              ))}
              <button type="button" className="is-muted" disabled={loggingIn} onClick={tapClear}>{tr('Clear')}</button>
              <button type="button" disabled={loggingIn} onClick={() => tapDigit('0')}>0</button>
              <button type="button" className="is-muted" disabled={loggingIn} onClick={tapBackspace} aria-label={tr('Backspace')}>⌫</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!drawerChecked) return null;

  // A cashier can't ring anything up until their own drawer is open — same
  // "count starting cash before you sell" step a real POS shift begins
  // with, and what makes the report at close-out complete (see
  // restaurantPos.service.js's buildReport: Cash Sales is summed from
  // this session's own opened_at onward).
  if (!drawer && !closedReport) {
    const last = shift && shift.lastClosed;
    const quick = [0, 100, 200, 500, 1000];
    return (
      <div className="dk pos-shell pos-gate">
        <div className="pos-gate-top">
          {themeButton}
          <button type="button" className="btn btn-secondary tl-btn" onClick={logout}>{tr('Log out')}</button>
        </div>
        <div className="pos-gate-card">
          <div className="pos-gate-side">
            {restaurantLogoUrl(session.companyCode) && <img className="pos-gate-logo" src={restaurantLogoUrl(session.companyCode)} alt="" />}
            <p className="dk-eyebrow">{session.companyName} · {today}</p>
            <h1 className="pos-gate-title">{greeting}</h1>
            <p className="dk-muted">{tr('Count the cash in the drawer before your first sale. At the end of your shift you count it again, and the till shows whether it adds up.')}</p>
            {last && (
              <div className="pos-note">
                <Icon name="info" />
                <span>{tr('The last drawer was closed by {name} on {date} with {amount} counted.', { name: last.cashierName, date: new Date(last.closedAt).toLocaleString(activeIntlLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }), amount: money(last.counted) })}</span>
              </div>
            )}
            {shift && shift.openTabs > 0 && (
              <div className="pos-note is-warn">
                <Icon name="clock" />
                <span>{shift.openTabs === 1 ? tr('1 table is still open from before. You can pay it once your drawer is open.') : tr('{n} tables are still open from before. You can pay them once your drawer is open.', { n: shift.openTabs })}</span>
              </div>
            )}
          </div>
          <form className="pos-gate-pad pos-open-form" onSubmit={submitOpenDrawer}>
            <label htmlFor="opening-cash" className="pos-big-label">{tr('Starting cash in the drawer')}</label>
            <input
              id="opening-cash" className="input pos-big-input" type="number" min="0" step="0.01" inputMode="decimal" autoFocus
              value={openingCash} onChange={(e) => setOpeningCash(e.target.value)} placeholder="0.00"
            />
            <div className="pos-quick">
              {quick.map((q) => <button key={q} type="button" className={Number(openingCash) === q && openingCash !== '' ? 'is-on' : ''} onClick={() => setOpeningCash(String(q))}>{money(q)}</button>)}
              {last && last.counted > 0 && !quick.includes(last.counted) && <button type="button" onClick={() => setOpeningCash(String(last.counted))}>{tr('Last count {amount}', { amount: money(last.counted) })}</button>}
            </div>
            {openDrawerError && <div className="error-banner">{openDrawerError}</div>}
            <button type="submit" className="btn btn-primary pos-big-btn" disabled={openingDrawer}>
              {openingDrawer ? tr('Opening…') : tr('Open drawer and start selling')}
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (closedReport) {
    const r = closedReport;
    const diffTone = r.difference === null ? '' : Math.abs(r.difference) < 0.01 ? 'good' : r.difference < 0 ? 'bad' : 'warn';
    return (
      <div className="dk pos-shell pos-done">
        <div className="pos-receipt-print" id="pos-receipt">
          {restaurantLogoUrl(session.companyCode) && (
            <img className="pos-receipt-logo" src={restaurantLogoUrl(session.companyCode)} alt="" />
          )}
          <div className="pos-receipt-header">{tr('Drawer Report:')} {session.employeeName}</div>
          <div className="pos-receipt-meta">
            {new Date(r.session.openedAt).toLocaleString(activeIntlLocale())} –<br />
            {new Date(r.session.closedAt).toLocaleString(activeIntlLocale())}<br />
            {session.companyName}
          </div>
          <div className="pos-receipt-rule" />
          <div className="pos-receipt-lines">
            <div className="pos-receipt-line"><span>{tr('Starting Cash')}</span><span>{money(r.startingCash)}</span></div>
            <div className="pos-receipt-line"><span>{tr('Cash Sales')}</span><span>{money(r.cashSales)}</span></div>
            <div className="pos-receipt-line"><span>{tr('Cash Refunds')}</span><span>{money(r.cashRefunds)}</span></div>
            <div className="pos-receipt-line"><span>{tr('Paid In/Out')}</span><span>{r.netPaidInOut < 0 ? '-' : ''}{money(Math.abs(r.netPaidInOut))}</span></div>
            <div className="pos-receipt-line"><span>{tr('Expected in Drawer')}</span><span>{money(r.expected)}</span></div>
            <div className="pos-receipt-line"><span>{tr('Actual in Drawer')}</span><span>{money(r.actual)}</span></div>
          </div>
          <div className="pos-receipt-rule" />
          <div className="pos-receipt-total">
            <span>{tr('Difference')}</span><span>{r.difference < 0 ? '-' : ''}{money(Math.abs(r.difference))}</span>
          </div>
          {!!r.movements.length && (
            <>
              <div className="pos-receipt-rule" />
              <div className="pos-receipt-footer" style={{ fontWeight: 700, marginBottom: 6 }}>{tr('PAID IN/OUT')}</div>
              <div className="pos-receipt-lines">
                {r.movements.map((m) => (
                  <div key={m.id} className="pos-receipt-line">
                    <span>{m.direction === 'in' ? tr('Paid in at {time}', { time: timeOf(m.createdAt) }) : tr('Paid out at {time}', { time: timeOf(m.createdAt) })}{m.note ? ' — ' + m.note : ''}</span>
                    <span>{m.direction === 'out' ? '-' : ''}{money(m.amount)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="pos-done-side">
          <span className={'pos-done-mark is-' + (diffTone || 'good')}><Icon name={diffTone === 'bad' || diffTone === 'warn' ? 'warn' : 'check'} /></span>
          <h1 className="pos-gate-title">{tr('Drawer closed')}</h1>
          <p className="pos-done-big">
            {diffTone === 'good' ? tr('The count matches exactly.') : r.difference < 0 ? tr('{amount} short', { amount: money(-r.difference) }) : tr('{amount} over', { amount: money(r.difference) })}
          </p>
          <p className="dk-muted">{tr('Expected {expected}, counted {actual}. Managers see this report under Restaurants → Cash drawers.', { expected: money(r.expected), actual: money(r.actual) })}</p>
          {printerError && <div className="error-banner pos-printer-error">{printerError}</div>}
          <div className="pos-done-actions">
            <button type="button" className="btn btn-secondary" onClick={() => window.print()}>{tr('Print report')}</button>
            {printer && (
              <button type="button" className="btn btn-secondary" disabled={printing} onClick={() => printDrawerReportThermal(closedReport)}>
                {printing ? tr('Printing…') : tr('Print via {name}', { name: printer.name })}
              </button>
            )}
            <button type="button" className="btn btn-primary" onClick={logout}>{tr('Done, log out')}</button>
          </div>
        </div>
      </div>
    );
  }

  if (receipt) {
    return (
      <div className="dk pos-shell pos-done">
        <div className="pos-receipt-print" id="pos-receipt">
          {restaurantLogoUrl(session.companyCode) && (
            <img className="pos-receipt-logo" src={restaurantLogoUrl(session.companyCode)} alt="" />
          )}
          <div className="pos-receipt-header">{session.companyName}</div>
          <div className="pos-receipt-meta">
            {tr('Order {orderNo}', { orderNo: receipt.orderNo })}<br />
            {new Date(receipt.createdAt).toLocaleString(activeIntlLocale())}<br />
            {receipt.tableName
              ? tr('Served by {name} at {table}', { name: receipt.cashierName || session.employeeName, table: receipt.tableName })
              : tr('Served by {name}', { name: receipt.cashierName || session.employeeName })}
            {receipt.waiterName && <><br />{tr('Waiter:')} {receipt.waiterName}</>}
            {receipt.guestName && <><br />{tr('Guest:')} {receipt.guestName}</>}
          </div>
          <div className="pos-receipt-rule" />
          <div className="pos-receipt-lines">
            {receipt.items.map((it, i) => (
              <div key={i} className="pos-receipt-line">
                <span>{it.qty} × {it.name}</span>
                <span>{money(it.lineTotal)}</span>
              </div>
            ))}
          </div>
          <div className="pos-receipt-rule" />
          <div className="pos-receipt-total">
            <span>{tr('Total')}</span><span>{money(receipt.total)}</span>
          </div>
          {receipt.cashTendered != null && (
            <div className="pos-receipt-lines pos-receipt-cash">
              <div className="pos-receipt-line"><span>{tr('Cash')}</span><span>{money(receipt.cashTendered)}</span></div>
              <div className="pos-receipt-line"><span>{tr('Change')}</span><span>{money(receipt.change)}</span></div>
            </div>
          )}
          <div className="pos-receipt-footer">{tr('Paid by')} {codeLabel(receipt.paymentMethod)}</div>
        </div>
        <div className="pos-done-side">
          <span className="pos-done-mark is-good"><Icon name="check" /></span>
          <h1 className="pos-gate-title">{receipt.reprint ? tr('Receipt for {no}', { no: receipt.orderNo }) : tr('Sale complete')}</h1>
          {!receipt.reprint && receipt.change != null && receipt.change > 0 && (
            <p className="pos-done-big">{tr('Give {amount} change', { amount: money(receipt.change) })}</p>
          )}
          {!receipt.reprint && (receipt.change == null || receipt.change === 0) && (
            <p className="pos-done-big">{tr('{amount} paid by {method}', { amount: money(receipt.total), method: codeLabel(receipt.paymentMethod) })}</p>
          )}
          <p className="dk-muted">{receipt.reprint ? tr('A copy of an order from this shift.') : tr('Print the receipt if the guest wants one, then start the next sale.')}</p>
          {printerError && <div className="error-banner pos-printer-error">{printerError}</div>}
          <div className="pos-done-actions">
            <button type="button" className="btn btn-secondary" onClick={() => window.print()}>{tr('Print receipt')}</button>
            {printer && (
              <button type="button" className="btn btn-secondary" disabled={printing} onClick={() => printToThermalPrinter(receipt)}>
                {printing ? tr('Printing…') : tr('Print via {name}', { name: printer.name })}
              </button>
            )}
            <button type="button" className="btn btn-primary" onClick={() => setReceipt(null)} autoFocus>{receipt.reprint ? tr('Back to the till') : tr('New sale')}</button>
          </div>
        </div>
      </div>
    );
  }

  const cartCount = cart.reduce((n, l) => n + l.qty, 0);
  const categories = grouped.map(([c, items]) => [c, items.length]);
  const shownGroups = category ? grouped.filter(([c]) => c === category) : grouped;
  const given = cashGiven === '' ? null : Number(cashGiven);
  const change = given === null ? null : Math.round((given - cartTotal) * 100) / 100;
  // the notes a guest is likely to hand over: the next round figure up
  const roundUps = Array.from(new Set([10, 20, 50, 100, 200].map((step) => { const v = Math.ceil(cartTotal / step) * step; return v > cartTotal ? v : v + step; }))).sort((x, y) => x - y).slice(0, 3);
  const METHODS = [['cash', tr('Cash'), 'cash'], ['mobile_money', tr('Mobile Money'), 'phone'], ['card', tr('Card'), 'card'], ['bank_transfer', tr('Bank transfer'), 'doc'], ['other', tr('Other'), 'info']];
  const avgOrder = shift && shift.orders ? shift.sales / shift.orders : 0;

  const orderPanel = (
    <section className={'pos-order' + (cartOpen ? ' is-open' : '')} aria-label={tr('Current order')}>
      <div className="pos-order-head">
        <div>
          <h2 className="pos-order-title">{currentTab ? currentTab.name : tr('New order')}</h2>
          <p className="dk-muted">
            {currentTab ? tr('Open since {time}. Add to it, keep it open or charge it.', { time: timeOf(currentTab.createdAt) }) : cartCount ? (cartCount === 1 ? tr('1 item') : tr('{n} items', { n: cartCount })) : tr('Tap a dish to start.')}
          </p>
        </div>
        <div className="pos-order-head-tools">
          {(cart.length > 0 || currentTab) && <button type="button" className="pos-link" onClick={clearOrder}>{currentTab ? tr('Put aside') : tr('Clear')}</button>}
          <button type="button" className="pos-icon-btn pos-sheet-close" onClick={() => setCartOpen(false)} aria-label={tr('Close')}>×</button>
        </div>
      </div>
      <div className="pos-order-who">
        <button type="button" className={selectedTable ? 'is-set' : ''} onClick={() => setTablePickerOpen(true)}>
          <small>{tr('Table')}</small><span>{selectedTable ? selectedTable.name : tr('None')}</span>
        </button>
        <button type="button" className={selectedWaiter ? 'is-set' : ''} onClick={() => setWaiterPickerOpen(true)}>
          <small>{tr('Waiter')}</small><span>{selectedWaiter ? selectedWaiter.name : tr('None')}</span>
        </button>
        <button type="button" className={selectedGuest ? 'is-set' : ''} onClick={openGuestPicker}>
          <small>{tr('Guest')}</small><span>{selectedGuest ? selectedGuest.name : tr('None')}</span>
        </button>
      </div>
      <div className="pos-lines">
        {!cart.length && (
          <div className="pos-lines-empty">
            <Icon name="bag" />
            <p>{tr('Nothing on this order yet. Tap dishes on the left; tap again to add another.')}</p>
          </div>
        )}
        {cart.map((l) => (
          <div key={lineKey(l.menuItemId, l.variationId)} className="pos-line">
            <div className="pos-line-main">
              <span className="pos-line-name">{l.name}</span>
              <span className="dk-muted">{money(l.price)}{l.qty > 1 ? ' × ' + l.qty : ''}</span>
            </div>
            <div className="pos-stepper">
              <button type="button" onClick={() => changeQty(l.menuItemId, l.variationId, -1)} aria-label={tr('Decrease')}>−</button>
              <span>{l.qty}</span>
              <button type="button" onClick={() => changeQty(l.menuItemId, l.variationId, 1)} aria-label={tr('Increase')}>+</button>
            </div>
            <span className="pos-line-total">{money(l.price * l.qty)}</span>
            <button type="button" className="pos-line-x" onClick={() => removeLine(l.menuItemId, l.variationId)} aria-label={tr('Remove')}>×</button>
          </div>
        ))}
      </div>
      <div className="pos-order-foot">
        <div className="pos-total"><span>{tr('Total')}</span><strong>{money(animatedCartTotal)}</strong></div>
        <div className="pos-order-actions">
          <button type="button" className="btn btn-secondary" disabled={!cart.length || savingTab} onClick={keepOpen} title={tr('Keep this order open to add to and pay later')}>
            {savingTab ? tr('Saving…') : currentTab ? tr('Update open table') : tr('Keep open')}
          </button>
          <button type="button" className="btn btn-primary pos-charge" disabled={!cart.length} onClick={openCheckout}>{tr('Charge {amount}', { amount: money(cartTotal) })}</button>
        </div>
      </div>
    </section>
  );

  return (
    <div className="dk pos-shell">
      <header className="pos-top">
        <div className="pos-top-who">
          {restaurantLogoUrl(session.companyCode) && <img className="pos-top-logo" src={restaurantLogoUrl(session.companyCode)} alt="" />}
          <div>
            <div className="pos-top-company">{session.companyName}</div>
            <div className="dk-muted">{tr('{name} · {time}', { name: session.employeeName, time: clock })}</div>
          </div>
        </div>
        <div className="pos-top-stats">
          <button type="button" className="pos-stat" onClick={() => { loadShift(); refreshDrawer(); setDrawerPanelOpen(true); }}>
            <small>{tr('Your shift')}</small>
            <strong>{money(shift ? shift.sales : 0)}</strong>
            <span>{shift && shift.orders === 1 ? tr('1 order') : tr('{n} orders', { n: shift ? shift.orders : 0 })}</span>
          </button>
          <button type="button" className="pos-stat" onClick={() => { loadShift(); refreshDrawer(); setDrawerPanelOpen(true); }}>
            <small>{tr('In the drawer')}</small>
            <strong>{money(drawer.expected)}</strong>
            <span>{tr('expected')}</span>
          </button>
          <button type="button" className={'pos-stat' + (tabs.length ? ' is-warn' : '')} onClick={() => { loadTabs(); setTabsOpen(true); }}>
            <small>{tr('Open tables')}</small>
            <strong>{tabs.length}</strong>
            <span>{tabs.length ? money(tabs.reduce((s2, t) => s2 + t.total, 0)) : tr('none waiting')}</span>
          </button>
        </div>
        <div className="pos-top-tools">
          {printer ? (
            <span className="pos-printer" title={printer.name}>🖨 <span>{printer.name}</span></span>
          ) : (
            <>
              {usbSupported() && (
                <button type="button" className="btn btn-secondary tl-btn" disabled={!!pairingKind} onClick={pairUsb}>
                  {pairingKind === 'usb' ? tr('Connecting…') : tr('USB printer')}
                </button>
              )}
              {bluetoothSupported() && (
                <button type="button" className="btn btn-secondary tl-btn" disabled={!!pairingKind} onClick={pairBluetooth}>
                  {pairingKind === 'bluetooth' ? tr('Connecting…') : tr('Bluetooth printer')}
                </button>
              )}
            </>
          )}
          {themeButton}
          <button type="button" className="btn btn-secondary tl-btn" onClick={logout}>{tr('Log out')}</button>
        </div>
      </header>
      {printerError && <div className="error-banner pos-printer-error">{printerError}</div>}

      <div className="pos-body">
        <section className="pos-menu" aria-label={tr('Menu')}>
          <div className="pos-menu-tools">
            <div className="pos-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search the menu…')} /></div>
            <div className="dk-segment" role="radiogroup" aria-label={tr('Show')}>
              {VIEW_TABS.map((t) => (
                <button key={t.key} type="button" role="radio" aria-checked={viewTab === t.key} className={viewTab === t.key ? 'is-on' : ''} onClick={() => setViewTab(t.key)}>
                  {t.label}{typeof t.count === 'number' && t.count > 0 ? ' · ' + t.count : ''}
                </button>
              ))}
            </div>
          </div>
          {viewTab === 'all' && categories.length > 1 && (
            <div className="pos-cats" role="radiogroup" aria-label={tr('Category')}>
              <button type="button" role="radio" aria-checked={!category} className={!category ? 'is-on' : ''} onClick={() => setCategory('')}>{tr('Everything')} <span>{searchedMenu.length}</span></button>
              {categories.map(([c, n]) => (
                <button key={c} type="button" role="radio" aria-checked={category === c} className={category === c ? 'is-on' : ''} onClick={() => setCategory(category === c ? '' : c)}>{c} <span>{n}</span></button>
              ))}
            </div>
          )}
          <div className="pos-menu-scroll">
            {menuError && <div className="error-banner">{menuError}</div>}
            {menuLoading ? (
              <p className="dk-muted">{tr('Loading menu…')}</p>
            ) : viewTab === 'all' ? (
              !shownGroups.length ? (
                <div className="dk-empty"><Icon name="info" /><p>{search ? tr('No items match "{search}"', { search }) : tr('No menu items yet — add some from Restaurants → Menu in the main app.')}</p></div>
              ) : (
                shownGroups.map(([cat, items]) => (
                  <div key={cat} className="pos-group">
                    <h3 className="pos-group-title">{cat} <span>{items.length}</span></h3>
                    <div className="pos-grid">{items.map(renderTile)}</div>
                  </div>
                ))
              )
            ) : viewTab === 'favorites' ? (
              !favoriteItems.length ? (
                <div className="dk-empty"><Icon name="info" /><p>{search ? tr('No favorites match "{search}"', { search }) : tr('No favorites yet — tap the ★ on any item to pin it here.')}</p></div>
              ) : <div className="pos-grid">{favoriteItems.map(renderTile)}</div>
            ) : viewTab === 'recent' ? (
              !recentItems.length ? (
                <div className="dk-empty"><Icon name="info" /><p>{search ? tr('No recent items match "{search}"', { search }) : tr('Nothing added to an order yet this shift.')}</p></div>
              ) : <div className="pos-grid">{recentItems.map(renderTile)}</div>
            ) : mostlyBoughtLoading && !mostlyBoughtItems.length ? (
              <p className="dk-muted">{tr('Loading…')}</p>
            ) : !mostlyBoughtItems.length ? (
              <div className="dk-empty"><Icon name="info" /><p>{search ? tr('No results match "{search}"', { search }) : tr('Not enough sales yet to rank — check back once a few orders have gone through.')}</p></div>
            ) : <div className="pos-grid">{mostlyBoughtItems.map(renderTile)}</div>}
          </div>
        </section>
        {orderPanel}
      </div>

      {!cartOpen && (
        <button type="button" className="pos-phone-bar" onClick={() => setCartOpen(true)}>
          <span>{currentTab ? currentTab.name : tr('Order')} · {cartCount === 1 ? tr('1 item') : tr('{n} items', { n: cartCount })}</span>
          <strong>{money(cartTotal)}</strong>
        </button>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}

      {checkoutOpen && (
        <div className="dialog-backdrop" onClick={() => !checkingOut && setCheckoutOpen(false)}>
          <form className="dialog pos-pay" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); submitCheckout(); }}>
            <h2>{tr('Take payment')}</h2>
            <div className="pos-pay-due"><span>{currentTab ? currentTab.name : tr('To pay')}</span><strong>{money(cartTotal)}</strong></div>
            <div className="pos-methods" role="radiogroup" aria-label={tr('Payment method')}>
              {METHODS.map(([k, label, icon]) => (
                <button key={k} type="button" role="radio" aria-checked={paymentMethod === k} className={paymentMethod === k ? 'is-on' : ''} onClick={() => setPaymentMethod(k)}>
                  <Icon name={icon} /><span>{label}</span>
                </button>
              ))}
            </div>
            {paymentMethod === 'cash' && (
              <div className="pos-cash">
                <label htmlFor="pos-cash-given" className="pos-big-label">{tr('Cash received')}</label>
                <input id="pos-cash-given" className="input pos-big-input" type="number" min="0" step="0.01" inputMode="decimal" autoFocus
                  value={cashGiven} onChange={(e) => setCashGiven(e.target.value)} placeholder={tr('Optional')} />
                <div className="pos-quick">
                  <button type="button" className={given === cartTotal ? 'is-on' : ''} onClick={() => setCashGiven(String(cartTotal))}>{tr('Exact')}</button>
                  {roundUps.map((v) => <button key={v} type="button" className={given === v ? 'is-on' : ''} onClick={() => setCashGiven(String(v))}>{money(v)}</button>)}
                </div>
                {change !== null && (
                  <div className={'pos-change' + (change < 0 ? ' is-bad' : '')}>
                    <span>{change < 0 ? tr('Still to pay') : tr('Change to give')}</span>
                    <strong>{money(Math.abs(change))}</strong>
                  </div>
                )}
              </div>
            )}
            {checkoutError && <div className="error-banner">{checkoutError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setCheckoutOpen(false)} disabled={checkingOut}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={checkingOut || (change !== null && change < 0)}>{checkingOut ? tr('Processing…') : tr('Complete sale')}</button>
            </div>
          </form>
        </div>
      )}

      {keepDialog && (
        <div className="dialog-backdrop" onClick={() => !savingTab && setKeepDialog(null)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); saveTab(keepDialog.label); }}>
            <h2>{tr('Keep this order open')}</h2>
            <p className="dk-muted">{tr('Give it a table or a name so anyone on the till can find it again and pay it later.')}</p>
            {tables.length > 0 && (
              <div className="pos-picker-grid">
                {tables.filter((t) => !tabs.some((x) => x.tableId === t.id)).map((t) => (
                  <button key={t.id} type="button" className="pos-picker-tile" onClick={() => { setSelectedTable(t); saveTab('', t); }}>{t.name}</button>
                ))}
              </div>
            )}
            <div className="field">
              <label htmlFor="pos-keep-name">{tables.length ? tr('Or a name') : tr('Name')}</label>
              <input id="pos-keep-name" className="input" maxLength={60} value={keepDialog.label} onChange={(e) => setKeepDialog({ label: e.target.value })} placeholder={tr('e.g. Bar – Kofi, Takeaway 2')} autoFocus />
            </div>
            {tabError && <div className="error-banner">{tabError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setKeepDialog(null)} disabled={savingTab}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={savingTab || !keepDialog.label.trim()}>{savingTab ? tr('Saving…') : tr('Keep open')}</button>
            </div>
          </form>
        </div>
      )}

      {tabsOpen && (
        <div className="dialog-backdrop" onClick={() => setTabsOpen(false)}>
          <div className="dialog pos-panel" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Open tables')}</h2>
            <p className="dk-muted">{tr('Orders kept open to add to and pay later. They are not sales until they are paid.')}</p>
            {!tabs.length ? (
              <div className="dk-empty"><Icon name="check" /><p>{tr('No open tables. Use Keep open on an order to hold it here.')}</p></div>
            ) : (
              <ul className="dk-rows pos-tabs">
                {tabs.map((t) => (
                  <li key={t.id} className="dk-row">
                    <span className="dk-lead-icon"><Icon name="clock" /></span>
                    <div className="dk-row-main">
                      <div className="dk-row-title">{tabName(t)}</div>
                      <div className="dk-muted dk-row-meta">
                        {[t.lines.reduce((n, l) => n + l.qty, 0) === 1 ? tr('1 item') : tr('{n} items', { n: t.lines.reduce((n, l) => n + l.qty, 0) }), t.waiterName, tr('open since {time}', { time: timeOf(t.createdAt) }), t.openedBy ? tr('by {name}', { name: t.openedBy }) : null].filter(Boolean).join(' · ')}
                      </div>
                      {t.unavailable > 0 && <Status tone="warn">{t.unavailable === 1 ? tr('1 item is off the menu now') : tr('{n} items are off the menu now', { n: t.unavailable })}</Status>}
                    </div>
                    <div className="dk-row-side">
                      <div className="dk-row-amount">{money(t.total)}</div>
                      <div className="pos-tab-actions">
                        <button type="button" className="pos-link is-bad" onClick={() => dropTab(t)}>{tr('Remove')}</button>
                        <button type="button" className="btn btn-secondary tl-btn" onClick={() => openTab(t, false)}>{tr('Open')}</button>
                        <button type="button" className="btn btn-primary tl-btn" onClick={() => openTab(t, true)}>{tr('Pay')}</button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setTabsOpen(false)}>{tr('Close')}</button>
            </div>
          </div>
        </div>
      )}

      {drawerPanelOpen && (
        <div className="dialog-backdrop" onClick={() => setDrawerPanelOpen(false)}>
          <div className="dialog pos-panel" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Your shift')}</h2>
            <p className="dk-muted">{tr('{name} · drawer opened {date}', { name: session.employeeName, date: new Date(drawer.session.openedAt).toLocaleString(activeIntlLocale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' }) })}</p>
            <dl className="dk-sum pos-sum">
              <div><dt>{tr('Sales')}</dt><dd>{money(shift ? shift.sales : 0)}</dd></div>
              <div><dt>{tr('Orders')}</dt><dd>{shift ? shift.orders : 0}</dd></div>
              <div><dt>{tr('Average order')}</dt><dd>{avgOrder ? money(avgOrder) : '—'}</dd></div>
            </dl>
            {shift && shift.byMethod.length > 0 && (
              <div className="pos-methods-sum">
                {shift.byMethod.map((m) => (
                  <div key={m.method}><span>{codeLabel(m.method)}</span><span className="dk-muted">{m.orders === 1 ? tr('1 order') : tr('{n} orders', { n: m.orders })}</span><strong>{money(m.total)}</strong></div>
                ))}
              </div>
            )}
            <h3 className="pos-panel-h">{tr('Cash drawer')}</h3>
            <div className="pos-drawer-lines">
              <div className="pos-drawer-line"><span>{tr('Starting Cash')}</span><span>{money(drawer.startingCash)}</span></div>
              <div className="pos-drawer-line"><span>{tr('Cash Sales')}</span><span>{money(drawer.cashSales)}</span></div>
              <div className="pos-drawer-line"><span>{tr('Paid In/Out')}</span><span>{drawer.netPaidInOut < 0 ? '-' : ''}{money(Math.abs(drawer.netPaidInOut))}</span></div>
              <div className="pos-drawer-line is-total"><span>{tr('Expected in Drawer')}</span><span>{money(drawer.expected)}</span></div>
            </div>
            {!!drawer.movements.length && (
              <div className="pos-drawer-moves">
                {drawer.movements.slice().reverse().map((m) => (
                  <div key={m.id} className="pos-drawer-line">
                    <span>{m.direction === 'in' ? tr('Paid in at {time}', { time: timeOf(m.createdAt) }) : tr('Paid out at {time}', { time: timeOf(m.createdAt) })}{m.note ? ' — ' + m.note : ''}</span>
                    <span>{m.direction === 'out' ? '-' : ''}{money(m.amount)}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="pos-panel-actions">
              <button type="button" className="btn btn-secondary tl-btn" onClick={() => openMovement('in')}>{tr('Paid in…')}</button>
              <button type="button" className="btn btn-secondary tl-btn" onClick={() => openMovement('out')}>{tr('Paid out…')}</button>
            </div>
            {shift && shift.recent.length > 0 && (
              <>
                <h3 className="pos-panel-h">{tr('Latest orders')}</h3>
                <ul className="dk-rows">
                  {shift.recent.map((o) => (
                    <li key={o.id} className="dk-row">
                      <div className="dk-row-main">
                        <div className="dk-row-title">{o.orderNo}</div>
                        <div className="dk-muted dk-row-meta">{[timeOf(o.createdAt), o.tableName, o.items === 1 ? tr('1 item') : tr('{n} items', { n: o.items }), codeLabel(o.paymentMethod)].filter(Boolean).join(' · ')}</div>
                      </div>
                      <div className="dk-row-side">
                        <div className="dk-row-amount">{money(o.total)}</div>
                        <button type="button" className="pos-link" onClick={() => reprint(o.id)}>{tr('Receipt')}</button>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDrawerPanelOpen(false)}>{tr('Close')}</button>
              <button type="button" className="btn btn-primary" onClick={openCloseDrawer}>{tr('End shift: count the drawer…')}</button>
            </div>
          </div>
        </div>
      )}

      {movementDirection && (
        <div className="dialog-backdrop" onClick={() => !addingMovement && setMovementDirection(null)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitMovement}>
            <h2>{movementDirection === 'in' ? tr('Paid in') : tr('Paid out')}</h2>
            {movementError && <div className="error-banner">{movementError}</div>}
            <div className="field">
              <label htmlFor="movement-amount">{tr('Amount')}</label>
              <input
                id="movement-amount" className="input" type="number" min="0.01" step="0.01" autoFocus required
                value={movementAmount} onChange={(e) => setMovementAmount(e.target.value)} placeholder="0.00"
              />
            </div>
            <div className="field">
              <label htmlFor="movement-note">{tr('Note')}</label>
              <input
                id="movement-note" className="input" value={movementNote} onChange={(e) => setMovementNote(e.target.value)}
                placeholder={movementDirection === 'in' ? tr('e.g. Change fund top-up') : tr('e.g. Delivery')}
              />
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setMovementDirection(null)} disabled={addingMovement}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={addingMovement}>{addingMovement ? tr('Saving…') : tr('Save')}</button>
            </div>
          </form>
        </div>
      )}

      {closeDrawerOpen && (
        <div className="dialog-backdrop" onClick={() => !closingDrawer && setCloseDrawerOpen(false)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitCloseDrawer}>
            <h2>{tr('Close drawer')}</h2>
            {closeDrawerError && <div className="error-banner">{closeDrawerError}</div>}
            <p className="pos-checkout-total">{tr('Expected in drawer:')} <strong>{money(drawer.expected)}</strong></p>
            <div className="field">
              <label htmlFor="close-actual">{tr('Actual cash counted')}</label>
              <input
                id="close-actual" className="input" type="number" min="0" step="0.01" autoFocus required
                value={closeActualCash} onChange={(e) => setCloseActualCash(e.target.value)} placeholder="0.00"
              />
            </div>
            <div className="field">
              <label htmlFor="close-note">{tr('Note (optional)')}</label>
              <input id="close-note" className="input" value={closeNote} onChange={(e) => setCloseNote(e.target.value)} />
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setCloseDrawerOpen(false)} disabled={closingDrawer}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={closingDrawer}>{closingDrawer ? tr('Closing…') : tr('Close drawer')}</button>
            </div>
          </form>
        </div>
      )}

      {variantPickerItem && (
        <div className="dialog-backdrop" onClick={() => setVariantPickerItem(null)}>
          <div className="dialog pos-picker-dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{variantPickerItem.name}</h2>
            <div className="pos-picker-list">
              {variantPickerItem.variations.map((v) => (
                <button
                  key={v.id} type="button" className="pos-picker-row"
                  onClick={() => addToCart(variantPickerItem, v)}
                >
                  <span>{v.name}</span>
                  <span>{money(v.price)}</span>
                </button>
              ))}
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setVariantPickerItem(null)}>{tr('Cancel')}</button>
            </div>
          </div>
        </div>
      )}

      {tablePickerOpen && (
        <div className="dialog-backdrop" onClick={() => setTablePickerOpen(false)}>
          <div className="dialog pos-picker-dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Table')}</h2>
            <div className="pos-picker-grid">
              {tables.map((t) => (
                <button
                  key={t.id} type="button"
                  className={'pos-picker-tile' + (selectedTable && selectedTable.id === t.id ? ' pos-picker-tile-selected' : '')}
                  onClick={() => { setSelectedTable(t); setTablePickerOpen(false); }}
                >
                  {t.name}
                </button>
              ))}
              {!tables.length && <div className="pos-empty">{tr('No tables set up yet — add some from Restaurants → Tables in the main app.')}</div>}
            </div>
            <div className="dialog-actions">
              {selectedTable && <button type="button" className="btn btn-secondary" onClick={() => { setSelectedTable(null); setTablePickerOpen(false); }}>{tr('Clear')}</button>}
              <button type="button" className="btn btn-primary" onClick={() => setTablePickerOpen(false)}>{tr('Done')}</button>
            </div>
          </div>
        </div>
      )}

      {waiterPickerOpen && (
        <div className="dialog-backdrop" onClick={() => setWaiterPickerOpen(false)}>
          <div className="dialog pos-picker-dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Waiter')}</h2>
            <div className="pos-picker-list">
              {waiters.map((w) => (
                <button
                  key={w.id} type="button"
                  className={'pos-picker-row' + (selectedWaiter && selectedWaiter.id === w.id ? ' pos-picker-row-selected' : '')}
                  onClick={() => { setSelectedWaiter(w); setWaiterPickerOpen(false); }}
                >
                  {w.name}
                </button>
              ))}
              {!waiters.length && <div className="pos-empty">{tr('No staff found for this company.')}</div>}
            </div>
            <div className="dialog-actions">
              {selectedWaiter && <button type="button" className="btn btn-secondary" onClick={() => { setSelectedWaiter(null); setWaiterPickerOpen(false); }}>{tr('Clear')}</button>}
              <button type="button" className="btn btn-primary" onClick={() => setWaiterPickerOpen(false)}>{tr('Done')}</button>
            </div>
          </div>
        </div>
      )}

      {guestPickerOpen && (
        <div className="dialog-backdrop" onClick={() => setGuestPickerOpen(false)}>
          <div className="dialog pos-picker-dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Guest')}</h2>
            <div className="field">
              <input
                className="input" value={guestSearch} placeholder={tr('Search name or phone…')} autoFocus
                onChange={(e) => { setGuestSearch(e.target.value); searchGuests(e.target.value); }}
              />
            </div>
            <div className="pos-picker-list">
              {guestSearching && <div className="eyebrow">{tr('Searching…')}</div>}
              {!guestSearching && guestResults.map((g) => (
                <button
                  key={g.id} type="button"
                  className={'pos-picker-row' + (selectedGuest && selectedGuest.id === g.id ? ' pos-picker-row-selected' : '')}
                  onClick={() => { setSelectedGuest(g); setGuestPickerOpen(false); }}
                >
                  {g.name}{g.phone ? ' · ' + g.phone : ''}
                </button>
              ))}
              {!guestSearching && !guestResults.length && <div className="pos-empty">{tr('No matching guests.')}</div>}
            </div>
            <div className="pos-picker-divider">{tr('Or add a new guest')}</div>
            {guestError && <div className="error-banner">{guestError}</div>}
            <form onSubmit={submitNewGuest} className="pos-new-guest-form">
              <input className="input" value={newGuestName} onChange={(e) => setNewGuestName(e.target.value)} placeholder={tr('Name')} required />
              <input className="input" value={newGuestPhone} onChange={(e) => setNewGuestPhone(e.target.value)} placeholder={tr('Phone (optional)')} />
              <button type="submit" className="btn btn-primary" disabled={addingGuest}>{addingGuest ? tr('Adding…') : tr('Add & select')}</button>
            </form>
            <div className="dialog-actions">
              {selectedGuest && <button type="button" className="btn btn-secondary" onClick={() => { setSelectedGuest(null); setGuestPickerOpen(false); }}>{tr('Clear')}</button>}
              <button type="button" className="btn btn-secondary" onClick={() => setGuestPickerOpen(false)}>{tr('Close')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
