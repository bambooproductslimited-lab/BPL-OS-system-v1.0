import { useCallback, useEffect, useRef, useState } from 'react';
import { posFetch } from '../../lib/posApi';

// The till's side of the screen that faces the customer (CustomerScreen.jsx,
// backend restaurantDisplays): this browser's device id, where the screen
// opens, and useCustomerDisplay — the order sent as it changes, and the tip
// the customer taps read back while paying.

const DEVICE_KEY = 'bamboo.till.device';
export function tillDevice() {
  try {
    let d = localStorage.getItem(DEVICE_KEY);
    if (!d || !/^[A-Za-z0-9_-]{8,64}$/.test(d)) {
      d = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9_-]/g, '');
      localStorage.setItem(DEVICE_KEY, d);
    }
    return d;
  } catch { return 'till-' + Date.now().toString(36); }
}
// Where the screen opens: the till's own website has /display; the OS, /customer-display.
export function displayUrl() {
  const site = import.meta.env.VITE_SITE;
  return window.location.origin + (site === 'pos' ? '/display' : '/customer-display');
}

// Where the self-order kiosk opens (till/Kiosks.jsx): /self-order on either site.
export function kioskUrl() { return window.location.origin + '/self-order'; }

export function useCustomerDisplay({ token, state }) {
  const device = useRef(tillDevice()).current;
  const [displays, setDisplays] = useState([]);
  const [tip, setTipNow] = useState(null);
  // The same tip read again is not a new one (or the cashier's own change would be undone).
  const setTip = useCallback((next) => setTipNow((old) => (old && next && old.at === next.at && old.ref === next.ref ? old : next)), []);
  const json = JSON.stringify(state);
  const reload = useCallback(async () => {
    if (!token) return;
    try { setDisplays((await posFetch('GET', '/pos/displays?device=' + device, token)).displays); } catch { /* no screen then */ }
  }, [token, device]);
  useEffect(() => { reload(); }, [reload]);
  // The order to the screens, a moment after it changes.
  useEffect(() => {
    if (!token || !displays.length) return undefined;
    const t = setTimeout(() => {
      posFetch('POST', '/pos/displays/push', token, { device, state: JSON.parse(json) }).then((r) => setTip(r.tip || null)).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [json, token, displays.length, device, setTip]);
  // While paying: the tip the customer taps.
  const paying = state && state.phase === 'pay' && state.tip && state.tip.ask;
  const ref = state && state.ref;
  useEffect(() => {
    if (!paying || !displays.length) { setTip(null); return undefined; }
    const t = setInterval(() => {
      posFetch('GET', '/pos/displays/tip?device=' + device + '&ref=' + encodeURIComponent(ref), token).then((r) => setTip(r.tip || null)).catch(() => {});
    }, 1500);
    return () => clearInterval(t);
  }, [paying, ref, displays.length, token, device, setTip]);
  return { device, displays, reload, tip };
}

// Where the ready-for-pickup board opens (till/ReadyBoards.jsx): /ready-board on either site.
export function boardUrl() { return window.location.origin + '/ready-board'; }

// Where a menu board opens (till/MenuBoards.jsx): /menu-board on either site.
export function menuBoardUrl() { return window.location.origin + '/menu-board'; }
