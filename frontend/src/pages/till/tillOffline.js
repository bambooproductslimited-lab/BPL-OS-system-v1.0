import { API_URL } from '../../api/client';
import { posFetch } from '../../lib/posApi';

// The till without the internet — a cut, or the power going and the till
// starting again before it is back (RestaurantPosPage):
//
//   cache   what the till last loaded (the menu, tables and waiters, the
//           settings, the drawer, the open orders), kept on this device so
//           it opens and sells without the server;
//   queue   a sale or an order for the kitchen made while the server could
//           not be reached, kept on this device and sent, oldest first,
//           when it can be — each with a reference of its own (clientRef),
//           so the server makes it once however often it is sent (backend
//           restaurantPos, migration 0167). An open order made offline has
//           an id of its own here ('local:…') until the server gives it one;
//   draft   the order being taken, kept as it is taken, so a till that
//           restarts has it back.
//
// The page itself (pos-sw.js) is kept by the till's service worker, so it
// opens without the internet too. localStorage is written at once, so what
// is kept survives the power going off.

const CACHE = 'bamboo.till.cache.';   // + the restaurant's id
const QUEUE = 'bamboo.till.queue';
const IDS = 'bamboo.till.localIds';  // 'local:…' → the open order's id on the server
const DRAFT = 'bamboo.till.draft.';   // + the restaurant's id
// The ways of paying that need nothing from the server at the moment of
// the sale (VIP and IOU look up the customer's account).
export const OFFLINE_METHODS = ['cash', 'mobile_money', 'alipay', 'wechat'];
const TIMEOUT_MS = 12000;

function read(key, dflt) { try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v == null ? dflt : v; } catch { return dflt; } }
function write(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); return true; } catch { return false; } }

export function newRef() {
  const id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 14);
  return 'till-' + id;
}
// No answer from the server at all (no internet, the server unreachable or
// too slow) — not the server saying no.
export function isNetworkError(e) { return !e || !e.status; }
// A call to the server, given up on after a while: a connection that hangs
// is as good as none. (If it went through after all, sending it again with
// the same reference makes nothing new.)
export function fetchOrGiveUp(method, path, token, body, ms) {
  return Promise.race([
    posFetch(method, path, token, body),
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('No answer from the server')), ms || TIMEOUT_MS))
  ]);
}
// Whether the server answers now.
export async function serverAnswers() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    const res = await fetch(API_URL + '/health', { cache: 'no-store', signal: ctl.signal });
    clearTimeout(t);
    return res.ok;
  } catch { return false; }
}

// ── what the till last loaded ──
export function cacheSave(companyId, part, value) {
  if (!companyId) return;
  const c = read(CACHE + companyId, {});
  c[part] = value;
  write(CACHE + companyId, c);
}
export function cacheLoad(companyId, part) { return companyId ? read(CACHE + companyId, {})[part] : undefined; }

// ── what waits to be sent ──
const subs = new Set();
export function queueList() { return read(QUEUE, []); }
function queueSave(list) { write(QUEUE, list); subs.forEach((f) => f(list)); }
export function onQueue(f) { subs.add(f); return () => { subs.delete(f); }; }
// { kind: 'sale' | 'tab', ref, body, localId?, label, total, snapshot? }
export function enqueue(item) { queueSave(queueList().concat([{ ...item, at: Date.now(), failed: false, error: null }])); }
function update(ref, patch) { queueSave(queueList().map((x) => (x.ref === ref ? { ...x, ...patch } : x))); }
export function queueRemove(ref) { queueSave(queueList().filter((x) => x.ref !== ref)); }
export function retry(ref) { update(ref, { failed: false, error: null }); }

// An open order's id as the server knows it, once its first send went.
export function serverId(id) { return id && String(id).startsWith('local:') ? read(IDS, {})[id] || id : id; }
export function isLocal(id) { return !!id && String(id).startsWith('local:') && serverId(id) === id; }
export function resolveIds(body) {
  const b = { ...body };
  if (b.tabId) b.tabId = serverId(b.tabId);
  if (b.id) b.id = serverId(b.id);
  return b;
}

// Sends what waits, oldest first. Stops when the server cannot be reached
// (the rest wait with it) or the till has to be signed in to again; one
// the server refuses is kept with why, for someone to look at — and what
// was made on top of it (paying an open order whose first send was
// refused) waits with it. → { sent, offline?, signIn? }
let running = null;
export function flush(token) {
  if (!running) running = sendAll(token).finally(() => { running = null; });
  return running;
}
async function sendAll(token) {
  let sent = 0;
  for (const item of queueList()) {
    if (item.failed) continue;
    const body = resolveIds(item.body);
    const waitsOn = [body.tabId, body.id].find((id) => isLocal(id));
    if (waitsOn) {
      const maker = queueList().find((x) => x.localId === waitsOn);
      if (!maker || maker.failed) update(item.ref, { failed: true, error: 'The open order it belongs to was not sent.' });
      continue;
    }
    try {
      const res = await fetchOrGiveUp('POST', item.kind === 'sale' ? '/pos/orders' : '/pos/tabs', token, body, 20000);
      if (item.localId && res && res.id) { const ids = read(IDS, {}); ids[item.localId] = res.id; write(IDS, ids); }
      queueRemove(item.ref);
      sent += 1;
    } catch (e) {
      if (isNetworkError(e)) return { sent, offline: true };
      if (e.status === 401) return { sent, signIn: true };
      update(item.ref, { failed: true, error: e.message });
    }
  }
  return { sent };
}

// ── the order being taken ──
export function draftSave(companyId, d) { if (companyId) write(DRAFT + companyId, d); }
export function draftLoad(companyId) { return companyId ? read(DRAFT + companyId, null) : null; }
export function draftClear(companyId) { try { localStorage.removeItem(DRAFT + companyId); } catch { /* nothing kept */ } }
