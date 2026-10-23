import { API_ORIGIN } from '../../api/client';

// Shared by the ordering website (OnlineShop) and a table's QR menu
// (TableShop): a dish's photo, the colour of a dish without one, and what
// makes two basket lines the same (with the same add-ons).
export function photo(u) { return u ? API_ORIGIN + u : null; }
const PALETTE = ['#f97316', '#ef4444', '#10b981', '#2563eb', '#8b5cf6', '#ec4899', '#eab308', '#14b8a6'];
export function tint(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; }
// A happy hour on now: a percentage off the dish (backend restaurantTillTimes
// applyHappy puts it on the order the same way).
const r2 = (n) => Math.round(n * 100) / 100;
export function happyPrice(price, happy) { return happy ? r2(price - r2(price * happy.percent / 100)) : price; }
export function happyOff(l) { return l.happy ? r2(r2(l.price * l.qty) * l.happy.percent / 100) : 0; }
// What the basket's happy hours take off.
export function happySaved(basket) { return r2(basket.reduce((a, l) => a + happyOff(l), 0)); }
export function lineKey(l) { return l.id + ':' + (l.variationId || '') + ':' + (l.modifiers || []).map((m) => m.id).sort().join(',') + ':' + (l.note || ''); }

// A customer's own account on this phone (AccountSheet.jsx; backend
// restaurantCustomerAccounts): { token, account }, or null when signed out.
const ACCOUNT_KEY = 'bamboo.online.account';
export function loadAccount() { try { const a = JSON.parse(localStorage.getItem(ACCOUNT_KEY) || 'null'); return a && a.token ? a : null; } catch { return null; } }
export function saveAccount(a) { try { if (a) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(a)); else localStorage.removeItem(ACCOUNT_KEY); } catch { /* this phone only */ } }
