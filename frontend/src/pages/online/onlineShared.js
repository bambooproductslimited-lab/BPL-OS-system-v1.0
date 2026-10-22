import { API_ORIGIN } from '../../api/client';

// Shared by the ordering website (OnlineShop) and a table's QR menu
// (TableShop): a dish's photo, the colour of a dish without one, and what
// makes two basket lines the same (with the same add-ons).
export function photo(u) { return u ? API_ORIGIN + u : null; }
const PALETTE = ['#f97316', '#ef4444', '#10b981', '#2563eb', '#8b5cf6', '#ec4899', '#eab308', '#14b8a6'];
export function tint(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; }
export function lineKey(l) { return l.id + ':' + (l.variationId || '') + ':' + (l.modifiers || []).map((m) => m.id).sort().join(',') + ':' + (l.note || ''); }
