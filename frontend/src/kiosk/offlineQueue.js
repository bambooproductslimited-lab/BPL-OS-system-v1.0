// Local queue for kiosk taps that couldn't reach the server (see
// KioskPage.jsx). localStorage rather than IndexedDB — at most a handful
// of small records ever queue up (one iPad, taps that failed while
// offline), so IndexedDB's extra API surface buys nothing here. Persists
// across a full page reload/device restart, which matters since a kiosk
// left offline overnight is exactly the case this exists for.

const STORAGE_KEY = 'bamboo.kiosk.offlineQueue';

function readAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(items) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Storage full/unavailable (private browsing, etc.) — the tap this
    // session just made simply won't survive a reload; nothing else to do.
  }
}

export function enqueueTap(pin, occurredAt, location) {
  const items = readAll();
  items.push({ tempId: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()), pin, occurredAt, location: location || null });
  writeAll(items);
}

export function peekQueue() {
  return readAll();
}

export function removeFromQueue(tempId) {
  writeAll(readAll().filter((it) => it.tempId !== tempId));
}

export function queueLength() {
  return readAll().length;
}
