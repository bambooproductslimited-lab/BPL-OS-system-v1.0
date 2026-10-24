// Reading an estimate Square made into a PDF (or its text pasted from
// Square's page), for bringing it into Estimates (EstimatesPage.jsx →
// backend squareEstimates.service.js). Square has no way for another app to
// read its estimates, so this works from what the customer was sent: the
// estimate's number, dates, who it is for, its items and its totals. What
// it finds is shown to be checked and corrected before anything is saved,
// so a layout it reads wrongly costs a correction, not a wrong estimate.
//
// rows: the document's lines, top to bottom; cells within a line separated
// by a tab where there was a wide gap (pdfRows below makes them).
// Pure: no imports, so the backend's tests read it too.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONEY = /^-?\(?(?:GH₵|GH¢|GHS|GHC|₵|US\$|USD|\$)?\s*-?[\d,]*\d(?:\.\d{1,2})?\)?$/i;
const HAS_CURRENCY = /GH₵|GH¢|GHS|GHC|₵|\$|USD/i;

function clean(s) { return String(s == null ? '' : s).replace(/[   ]/g, ' ').replace(/[ ]{2,}/g, ' ').trim(); }
export function moneyOf(s) {
  const t = clean(s);
  if (!MONEY.test(t)) return null;
  const neg = /^-|\(.*\)$|-\s*\d/.test(t);
  const n = Number(t.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}
function isMoneyCell(s) { return moneyOf(s) !== null && (HAS_CURRENCY.test(s) || /\.\d{2}\)?$/.test(clean(s))); }
function pad(n) { return String(n).padStart(2, '0'); }
function monthOf(word) { const w = String(word).toLowerCase(); return MONTHS[w.slice(0, 4)] || MONTHS[w.slice(0, 3)] || 0; }

// A date as Square prints it: "Oct 1, 2026", "1 October 2026", "10/01/2026", "2026-10-01".
export function dateOf(s) {
  const t = clean(s).replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
  let m = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = t.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (m && monthOf(m[1])) return m[3] + '-' + pad(monthOf(m[1])) + '-' + pad(m[2]);
  m = t.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/);
  if (m && monthOf(m[2])) return m[3] + '-' + pad(monthOf(m[2])) + '-' + pad(m[1]);
  m = t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (m) {
    // Square in Ghana writes day/month; a first number over 12 can only be a day.
    let d = Number(m[1]), mo = Number(m[2]);
    if (mo > 12 && d <= 12) { const x = d; d = mo; mo = x; }
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return m[3] + '-' + pad(mo) + '-' + pad(d);
  }
  return null;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE = /(?:\+?233|0)[\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{4}|\+?\d[\d\s-]{8,14}\d/;
const TO_HEAD = /^(bill(?:ed)?\s+to|prepared\s+for|customer|client|estimate\s+for|recipient|to)\s*:?\s*/i;
const ITEMS_HEAD = /\b(items?|description|services?|products?)\b/i;
const COLS_HEAD = /\b(qty|quantity|price|rate|amount|total)\b/i;
const TOTAL_ROW = /^(sub\s*-?total|discounts?|tax|vat|nhil|getfund|levy|covid|service\s+charge|total|grand\s+total|amount\s+due|deposit|balance|estimate\s+total)\b/i;

function cells(row) { return String(row).split('\t').map(clean).filter(Boolean); }
function joined(row) { return cells(row).join(' '); }

export function parseSquareEstimate(rows) {
  const lines = rows.map((r) => String(r)).filter((r) => clean(r));
  const flat = lines.map(joined);
  const out = { squareNo: '', date: null, validUntil: null, customer: { name: '', email: '', phone: '', address: '' }, items: [], subtotal: null, discount: 0, tax: 0, total: null, notes: '', currency: 'GHS', warnings: [] };

  // The estimate's number.
  for (const t of flat) {
    const m = t.match(/estimate\s*(?:#|no\.?|number)\s*:?\s*([A-Za-z0-9-]{2,})/i) || t.match(/^#\s?([0-9]{3,}[A-Za-z0-9-]*)$/);
    if (m) { out.squareNo = m[1]; break; }
  }
  // Its dates: said on the line, or on the next one.
  flat.forEach((t, i) => {
    const next = flat[i + 1] || '';
    if (!out.validUntil && /expir|valid\s+(until|through|till)|expires|due\s+(date|on)/i.test(t)) out.validUntil = dateOf(t) || dateOf(next);
    else if (!out.date && /(estimate\s+date|date\s+of\s+issue|issue(d)?\s+(date|on)|date\s+sent|sent\s+on|created|^date\b)/i.test(t)) out.date = dateOf(t) || dateOf(next);
  });
  if (!out.date) { for (const t of flat) { const d = dateOf(t); if (d) { out.date = d; break; } } }

  // Who it is for: the lines under "Bill to" / "Prepared for" / "Customer".
  const toAt = flat.findIndex((t) => TO_HEAD.test(t) && !/estimate\s*#/i.test(t));
  if (toAt >= 0) {
    // Square may set the dates beside it, in a second column: only the
    // cells that are not a date or its label count.
    const own = (row) => cells(row).filter((c) => !dateOf(c) && !/^(estimate\s+date|date|expir\w*(\s+date)?|expires|valid\s+until|due(\s+date)?|issued|date\s+of\s+issue)\s*:?$/i.test(c)).join(' ');
    const first = clean(own(lines[toAt].replace(TO_HEAD, '')).replace(TO_HEAD, ''));
    const block = (first ? [first] : []).concat(lines.slice(toAt + 1, toAt + 6).map(own));
    for (const t of block) {
      if (!t) continue;
      if (ITEMS_HEAD.test(t) && COLS_HEAD.test(t)) break;
      const em = t.match(EMAIL), ph = t.match(PHONE);
      if (em && !out.customer.email) { out.customer.email = em[0]; continue; }
      if (ph && !out.customer.phone && ph[0].replace(/\D/g, '').length >= 9) { out.customer.phone = clean(ph[0]); continue; }
      if (!out.customer.name) out.customer.name = t;
      else if (!out.customer.address && !TOTAL_ROW.test(t)) out.customer.address = t;
    }
  }

  // The items: from the row naming the columns down to the subtotal.
  let start = flat.findIndex((t) => ITEMS_HEAD.test(t) && COLS_HEAD.test(t));
  let end = flat.findIndex((t, i) => i > start && TOTAL_ROW.test(t));
  if (start < 0) start = toAt >= 0 ? toAt + 1 : 0;
  if (end < 0) end = lines.length;
  let cur = null, pending = '';
  for (let i = start + (start >= 0 && ITEMS_HEAD.test(flat[start]) && COLS_HEAD.test(flat[start]) ? 1 : 0); i < end; i++) {
    const cs = cells(lines[i]);
    const money = [];
    while (cs.length && isMoneyCell(cs[cs.length - 1])) money.unshift(moneyOf(cs.pop()));
    let qty = null;
    // "2 × GH₵100.00" or "2 x 100.00" as one cell, or a quantity cell before the money.
    const times = cs.length ? cs[cs.length - 1].match(/^(\d+(?:\.\d+)?)\s*[×xX*]\s*(.+)$/) : null;
    if (times && moneyOf(times[2]) !== null) { qty = Number(times[1]); money.unshift(moneyOf(times[2])); cs.pop(); }
    else if (cs.length && /^\d+(\.\d+)?$/.test(cs[cs.length - 1]) && money.length) qty = Number(cs.pop());
    else if (cs.length && /^(qty|quantity)\s*:?\s*(\d+(?:\.\d+)?)$/i.test(cs[cs.length - 1])) qty = Number(cs.pop().replace(/\D+/g, ' ').trim());
    const words = cs.join(' ');
    if (!money.length) {
      // A line of words: the next item's name, or the last item's details.
      if (cur && cur.done) cur.notes = clean((cur.notes ? cur.notes + ' · ' : '') + words);
      else pending = clean((pending ? pending + ' ' : '') + words);
      continue;
    }
    const amount = money[money.length - 1];
    const price = money.length >= 2 ? money[0] : null;
    if (words || pending || !cur || cur.done) {
      cur = { description: clean(words || pending), notes: '', qty: 1, unitPrice: 0, discount: 0, done: false };
      out.items.push(cur);
      pending = '';
    }
    cur.qty = qty || (price && amount && Math.abs(amount / price - Math.round(amount / price)) < 0.001 ? Math.round(amount / price) : 1);
    cur.unitPrice = price != null ? price : Math.round((amount / cur.qty) * 100) / 100;
    const gross = Math.round(cur.qty * cur.unitPrice * 100) / 100;
    cur.discount = gross - amount > 0.009 ? Math.round((gross - amount) * 100) / 100 : 0;
    cur.amount = amount;
    cur.done = true;
  }
  out.items = out.items.filter((it) => it.description).map((it) => { const o = { ...it }; delete o.done; return o; });

  // The totals.
  for (let i = Math.max(0, end); i < flat.length; i++) {
    const cs = cells(lines[i]);
    const last = cs.length ? moneyOf(cs[cs.length - 1]) : null;
    if (last === null) continue;
    const label = flat[i].toLowerCase();
    if (/^sub\s*-?total/.test(label)) out.subtotal = last;
    else if (/^discount/.test(label)) out.discount += Math.abs(last);
    else if (/^(tax|vat|nhil|getfund|levy|covid)/.test(label)) out.tax += last;
    else if (/^(total|grand\s+total|estimate\s+total)/.test(label) && out.total == null) out.total = last;
  }
  const notesAt = flat.findIndex((t) => /^(message|notes?|memo)\b/i.test(t));
  if (notesAt >= 0) out.notes = flat.slice(notesAt, notesAt + 4).join(' ').replace(/^(message|notes?|memo)\s*:?\s*/i, '').slice(0, 1000);
  if (/\$|USD/.test(flat.join(' ')) && !/GH₵|GH¢|GHS|₵/.test(flat.join(' '))) out.currency = 'GHS'; // the account shows $ for cedis

  // What to check.
  const itemsTotal = Math.round(out.items.reduce((a, it) => a + it.qty * it.unitPrice - it.discount, 0) * 100) / 100;
  if (!out.squareNo) out.warnings.push('number');
  if (!out.customer.name) out.warnings.push('customer');
  if (!out.items.length) out.warnings.push('items');
  if (out.subtotal != null && Math.abs(out.subtotal - itemsTotal) > 0.02) out.warnings.push('subtotal');
  out.taxRate = out.tax > 0 && itemsTotal - out.discount > 0 ? Math.round((out.tax / (itemsTotal - out.discount)) * 10000) / 100 : 0;
  out.itemsTotal = itemsTotal;
  return out;
}

// Pasted text: lines, with two or more spaces (or a tab) between cells.
export function textRows(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.replace(/\t+/g, '\t').replace(/ {2,}/g, '\t')).filter((l) => clean(l));
}

// A PDF's text as lines (pdf.js text items: str and transform [.., .., .., .., x, y]),
// a tab where the gap between two pieces is wide.
export function pdfRows(items) {
  const rows = [];
  items.filter((it) => clean(it.str)).forEach((it) => {
    const x = it.transform[4], y = it.transform[5], w = it.width || 0;
    let row = rows.find((r) => Math.abs(r.y - y) < 3);
    if (!row) { row = { y, parts: [] }; rows.push(row); }
    row.parts.push({ x, w, s: it.str });
  });
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => {
    r.parts.sort((a, b) => a.x - b.x);
    let out = '', end = null;
    r.parts.forEach((p) => {
      out += end == null ? p.s : (p.x - end > 12 ? '\t' : (p.x - end > 1.5 ? ' ' : '')) + p.s;
      end = p.x + p.w;
    });
    return out;
  });
}
