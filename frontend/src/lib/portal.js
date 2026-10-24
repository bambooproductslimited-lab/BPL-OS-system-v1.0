import { API_URL } from '../api/client';
import { tr } from './i18n.jsx';

// "My account" on Bamboo Products' website (backend portal.service.js),
// shared by the account page, the shop's checkout (filled in for a signed-in
// customer) and an order's own page (where an account asked for at checkout
// is finished once it is paid). The session is kept on this phone; so is an
// account asked for and not yet made.

const KEY = 'bplPortal';
const SIGNUP = 'bplPortalSignup';

export function loadToken() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } }
export function saveToken(t) { try { if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY); } catch { /* signed in for this visit */ } }
export function loadSignup() {
  try { const s = JSON.parse(localStorage.getItem(SIGNUP) || 'null'); return s && s.name ? s : null; } catch { return null; }
}
export function saveSignup(s) { try { if (s) localStorage.setItem(SIGNUP, JSON.stringify(s)); else localStorage.removeItem(SIGNUP); } catch { /* asked again on the account page */ } }

export async function portalCall(method, path, body, token) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['X-Portal-Token'] = token;
  const r = await fetch(API_URL + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error((j.error && j.error.message) || tr('Something went wrong. Please try again.')); e.status = r.status; throw e; }
  return j;
}
