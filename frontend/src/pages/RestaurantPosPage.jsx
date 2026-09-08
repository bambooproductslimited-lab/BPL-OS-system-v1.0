import { useEffect, useMemo, useRef, useState } from 'react';
import { API_URL, API_ORIGIN, ApiError } from '../api/client';
import { money } from '../lib/currency';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import {
  buildReceiptBytes, usbSupported, bluetoothSupported,
  requestUsbPrinter, requestBluetoothPrinter, reconnectUsbPrinter, reconnectBluetoothPrinter
} from '../lib/thermalPrinter';
import './KioskPage.css';
import './RestaurantPosPage.css';

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
    throw new ApiError(res.status, err ? err.code : 'error', err ? err.message : 'Something went wrong.');
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

  const [cart, setCart] = useState([]); // [{ menuItemId, name, price, qty }]
  const [tappedId, setTappedId] = useState(null); // brief tap-feedback flash on the tile just added

  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [checkingOut, setCheckingOut] = useState(false);
  const [checkoutError, setCheckoutError] = useState(null);

  const [receipt, setReceipt] = useState(null);

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

  useEffect(() => {
    (async () => {
      const usb = await reconnectUsbPrinter();
      if (usb) { setPrinter(usb); return; }
      const bt = await reconnectBluetoothPrinter();
      if (bt) setPrinter(bt);
    })();
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
      setPrinterError('Could not print: ' + err.message);
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

  useEffect(() => {
    const saved = localStorage.getItem(SESSION_KEY);
    if (!saved) { setSessionChecked(true); return; }
    let parsed;
    try { parsed = JSON.parse(saved); } catch { localStorage.removeItem(SESSION_KEY); setSessionChecked(true); return; }
    loadMenu(parsed.token).then((ok) => {
      if (ok) setSession(parsed);
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
  }

  function addToCart(item) {
    setCart((prev) => {
      const idx = prev.findIndex((l) => l.menuItemId === item.id);
      if (idx >= 0) return prev.map((l, i) => (i === idx ? { ...l, qty: l.qty + 1 } : l));
      return prev.concat([{ menuItemId: item.id, name: item.name, price: item.price, qty: 1 }]);
    });
    setTappedId(item.id);
    setTimeout(() => setTappedId((cur) => (cur === item.id ? null : cur)), 260);
  }
  function changeQty(menuItemId, delta) {
    setCart((prev) => prev.map((l) => (l.menuItemId === menuItemId ? { ...l, qty: Math.max(0, l.qty + delta) } : l)).filter((l) => l.qty > 0));
  }
  function removeLine(menuItemId) {
    setCart((prev) => prev.filter((l) => l.menuItemId !== menuItemId));
  }

  const cartTotal = cart.reduce((sum, l) => sum + l.price * l.qty, 0);
  const animatedCartTotal = useCountUp(cartTotal);
  const cartQtyById = useMemo(() => {
    const map = new Map();
    cart.forEach((l) => map.set(l.menuItemId, l.qty));
    return map;
  }, [cart]);

  function openCheckout() {
    setCheckoutError(null);
    setPaymentMethod('cash');
    setCheckoutOpen(true);
  }

  async function submitCheckout() {
    setCheckingOut(true);
    setCheckoutError(null);
    try {
      const order = await posFetch('POST', '/pos/orders', session.token, {
        items: cart.map((l) => ({ menuItemId: l.menuItemId, qty: l.qty })),
        paymentMethod: paymentMethod
      });
      setReceipt(order);
      setCart([]);
      setCheckoutOpen(false);
    } catch (err) {
      if (err.status === 401) { localStorage.removeItem(SESSION_KEY); setSession(null); setCheckoutOpen(false); }
      else setCheckoutError(err.message);
    } finally {
      setCheckingOut(false);
    }
  }

  // Star Bar's real Square-imported menu runs into the thousands of items —
  // a touch grid that size is unusable without a way to jump straight to
  // an item, so filtering here isn't cosmetic.
  const grouped = useMemo(() => {
    const visible = menu.filter((m) => matchesQuery(search, m.name, m.category));
    const map = new Map();
    visible.forEach((m) => {
      if (!map.has(m.category)) map.set(m.category, []);
      map.get(m.category).push(m);
    });
    return Array.from(map.entries());
  }, [menu, search]);

  if (!sessionChecked) return null;

  if (!session) {
    return (
      <div className="kiosk-root">
        <div className="kiosk-content pos-login-content">
          <div className="kiosk-header">
            <div className="kiosk-brand">RESTAURANT POS</div>
          </div>
          <div className="kiosk-pad-wrap">
            <div className="kiosk-prompt">Enter your PIN to start your till</div>
            {loginError && <div className="error-banner" style={{ marginBottom: 16 }}>{loginError}</div>}
            <div className="kiosk-pin-dots">
              {Array.from({ length: PIN_LENGTH }).map((_, i) => (
                <div key={i} className={'kiosk-pin-dot' + (i < pin.length ? ' kiosk-pin-dot-filled' : '')} />
              ))}
            </div>
            <div className="kiosk-keypad">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                <button key={d} type="button" className="kiosk-key" disabled={loggingIn} onClick={() => tapDigit(d)}>{d}</button>
              ))}
              <button type="button" className="kiosk-key kiosk-key-muted" disabled={loggingIn} onClick={tapClear}>Clear</button>
              <button type="button" className="kiosk-key" disabled={loggingIn} onClick={() => tapDigit('0')}>0</button>
              <button type="button" className="kiosk-key kiosk-key-muted" disabled={loggingIn} onClick={tapBackspace} aria-label="Backspace">⌫</button>
            </div>
            {loggingIn && <div className="kiosk-loading">Checking…</div>}
          </div>
        </div>
      </div>
    );
  }

  if (receipt) {
    return (
      <div className="pos-shell pos-receipt-screen">
        <div className="pos-receipt-print" id="pos-receipt">
          <div className="pos-receipt-header">{session.companyName}</div>
          <div className="pos-receipt-meta">
            Order {receipt.orderNo}<br />
            {new Date(receipt.createdAt).toLocaleString()}<br />
            Served by {session.employeeName}
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
            <span>Total</span><span>{money(receipt.total)}</span>
          </div>
          <div className="pos-receipt-footer">Paid by {receipt.paymentMethod.replace('_', ' ')}</div>
        </div>
        {printerError && <div className="error-banner pos-printer-error">{printerError}</div>}
        <div className="pos-receipt-actions">
          <button type="button" className="btn btn-secondary" onClick={() => window.print()}>Print receipt</button>
          {printer && (
            <button type="button" className="btn btn-secondary" disabled={printing} onClick={() => printToThermalPrinter(receipt)}>
              {printing ? 'Printing…' : 'Print via ' + printer.name}
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => setReceipt(null)}>New sale</button>
        </div>
      </div>
    );
  }

  return (
    <div className="pos-shell">
      <div className="pos-topbar">
        <div>
          <div className="pos-topbar-company">{session.companyName}</div>
          <div className="pos-topbar-cashier">{session.employeeName}</div>
        </div>
        <div className="pos-topbar-actions">
          {printer ? (
            <span className="pos-printer-status" title={printer.name}>🖨 {printer.name}</span>
          ) : (
            <>
              {usbSupported() && (
                <button type="button" className="btn btn-secondary pos-printer-btn" disabled={!!pairingKind} onClick={pairUsb}>
                  {pairingKind === 'usb' ? 'Connecting…' : 'Connect USB printer'}
                </button>
              )}
              {bluetoothSupported() && (
                <button type="button" className="btn btn-secondary pos-printer-btn" disabled={!!pairingKind} onClick={pairBluetooth}>
                  {pairingKind === 'bluetooth' ? 'Connecting…' : 'Connect Bluetooth printer'}
                </button>
              )}
            </>
          )}
          <button type="button" className="btn btn-secondary" onClick={logout}>Log out</button>
        </div>
      </div>
      {printerError && <div className="error-banner pos-printer-error">{printerError}</div>}

      <div className="pos-body">
        <div className="pos-menu">
          <div className="pos-menu-search">
            <SearchInput value={search} onChange={setSearch} placeholder="Search the menu…" />
          </div>
          {menuError && <div className="error-banner">{menuError}</div>}
          {menuLoading ? (
            <div className="eyebrow">Loading menu…</div>
          ) : !grouped.length ? (
            <div className="pos-empty">{search ? 'No items match "' + search + '"' : 'No menu items yet — add some from Restaurants → Menu in the main app.'}</div>
          ) : (
            grouped.map(([category, items]) => (
              <div key={category} className="pos-menu-group">
                <div className="pos-menu-category"><span className="pos-menu-category-pill">{category}<span className="pos-menu-category-count">{items.length}</span></span></div>
                <div className="pos-menu-grid">
                  {items.map((m) => {
                    const qty = cartQtyById.get(m.id);
                    return (
                      <button
                        key={m.id} type="button"
                        className={'pos-menu-tile' + (qty ? ' pos-menu-tile-selected' : '') + (tappedId === m.id ? ' pos-menu-tile-tapped' : '')}
                        onClick={() => addToCart(m)}
                      >
                        <span className="pos-menu-tile-photo" style={m.photoUrl ? undefined : { background: tileColor(m.name) }}>
                          {m.photoUrl ? (
                            <img src={API_ORIGIN + m.photoUrl} alt="" loading="lazy" />
                          ) : (
                            <span className="pos-menu-tile-fallback">{tileInitial(m.name)}</span>
                          )}
                          {!!qty && <span className="pos-menu-tile-badge">{qty}</span>}
                        </span>
                        <span className="pos-menu-tile-body">
                          <span className="pos-menu-tile-name">{m.name}</span>
                          <span className="pos-menu-tile-price">{money(m.price)}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="pos-cart">
          <div className="pos-cart-title">Current order</div>
          {!cart.length && <div className="pos-cart-empty">Tap a menu item to add it</div>}
          <div className="pos-cart-lines">
            {cart.map((l) => (
              <div key={l.menuItemId} className="pos-cart-line">
                <div className="pos-cart-line-name">{l.name}</div>
                <div className="pos-cart-line-controls">
                  <button type="button" className="pos-cart-qty-btn" onClick={() => changeQty(l.menuItemId, -1)} aria-label="Decrease">−</button>
                  <span>{l.qty}</span>
                  <button type="button" className="pos-cart-qty-btn" onClick={() => changeQty(l.menuItemId, 1)} aria-label="Increase">+</button>
                </div>
                <div className="pos-cart-line-total">{money(l.price * l.qty)}</div>
                <button type="button" className="pos-cart-remove" onClick={() => removeLine(l.menuItemId)} aria-label="Remove">×</button>
              </div>
            ))}
          </div>
          <div className="pos-cart-total">
            <span>Total</span>
            <strong>{money(animatedCartTotal)}</strong>
          </div>
          <button type="button" className="btn btn-primary pos-checkout-btn" disabled={!cart.length} onClick={openCheckout}>Charge {money(cartTotal)}</button>
        </div>
      </div>

      {checkoutOpen && (
        <div className="dialog-backdrop" onClick={() => !checkingOut && setCheckoutOpen(false)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); submitCheckout(); }}>
            <h2>Take payment</h2>
            {checkoutError && <div className="error-banner">{checkoutError}</div>}
            <p className="pos-checkout-total">Total due: <strong>{money(cartTotal)}</strong></p>
            <div className="field">
              <label htmlFor="pos-pay-method">Payment method</label>
              <select id="pos-pay-method" className="input" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
                <option value="cash">Cash</option>
                <option value="mobile_money">Mobile Money</option>
                <option value="card">Card</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setCheckoutOpen(false)} disabled={checkingOut}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={checkingOut}>{checkingOut ? 'Processing…' : 'Complete sale'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
