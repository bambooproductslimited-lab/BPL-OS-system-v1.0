import { useEffect, useRef } from 'react';

// Barcodes at the till (till/Barcode.jsx): a scanner heard wherever the
// cashier is, and a code's dish on the menu.

// A scanner types a whole code in well under a second; a person does not.
const GAP_MS = 45;
const MIN_LEN = 4;
function typingInABox(el) {
  if (!el) return false;
  const tag = el.tagName;
  return (tag === 'INPUT' && el.type !== 'checkbox' && el.type !== 'radio' && el.type !== 'button') || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
export function useBarcodeWedge(onCode, enabled) {
  const buf = useRef({ text: '', at: 0 });
  const cb = useRef(onCode);
  cb.current = onCode;
  useEffect(() => {
    if (!enabled) return undefined;
    function key(e) {
      if (e.ctrlKey || e.metaKey || e.altKey || typingInABox(e.target)) return;
      const now = performance.now();
      const b = buf.current;
      if (now - b.at > GAP_MS * 3) b.text = '';
      b.at = now;
      if (e.key === 'Enter') {
        if (b.text.length >= MIN_LEN) { e.preventDefault(); cb.current(b.text); }
        b.text = '';
        return;
      }
      if (e.key.length === 1) b.text += e.key;
    }
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [enabled]);
}

// The dish a code is: { item, variation } or null (any case).
export function dishByCode(menu, code) {
  const c = String(code || '').trim().toLowerCase();
  if (!c) return null;
  for (const m of menu) {
    if (m.sku && m.sku.toLowerCase() === c) return { item: m, variation: null };
    const v = (m.variations || []).find((x) => x.sku && x.sku.toLowerCase() === c);
    if (v) return { item: m, variation: v };
  }
  return null;
}

// Whether this browser can read barcodes with the camera.
export const cameraCanScan = typeof window !== 'undefined' && 'BarcodeDetector' in window && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

