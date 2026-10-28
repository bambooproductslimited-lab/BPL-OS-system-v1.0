import '../styles/typeToSearch.css';
import { tr } from './i18n.jsx';

// Type to search, everywhere (Bamboo OS, the till, the kitchen screen, the
// delivery screen and the websites): installed once by each app's entry.
//
// 1. Every dropdown (<select>) opens a list with a search box instead of the
//    browser's own: click it, tap it, or focus it and start typing. Words
//    match anywhere in an option (and its group), in any order, accents and
//    case ignored; the arrow keys and Enter pick, Escape leaves it as it was.
//    The choice goes back through the <select> itself (its change event), so
//    every screen's own onChange runs as before. A dropdown that allows
//    several, is disabled, or sits inside [data-native-select] keeps the
//    browser's own.
// 2. On a screen with a search box, starting to type (letters, with nothing
//    else in focus) types into it. With a pop-up open, only a search box in
//    that pop-up. The keys are held for a moment first: a barcode scanner
//    types a whole code faster than that and keeps its own listener (the
//    till's), and a screen's own shortcut (j/k in the inbox) that takes the
//    key is left alone.

var LIST_GAP = 4;
var MAX_LIST = 380;
var SHEET_WIDTH = 600;
var HOLD_MS = 90;
var SCAN_MS = 30;

var current = null; // the open list: { select, layer, panel, input, list, rows, active, timer, observer }
var touch = null;

function fold(s) { return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim(); }

function takesOver(el) {
  return !!(el && el.tagName === 'SELECT' && !el.multiple && !el.disabled && !(el.size > 1) && !el.closest('[data-native-select]'));
}

function optionsOf(select) {
  var out = [];
  for (var i = 0; i < select.options.length; i++) {
    var o = select.options[i];
    if (o.hidden) continue;
    var group = o.parentElement && o.parentElement.tagName === 'OPTGROUP' ? o.parentElement : null;
    var text = (o.textContent || o.label || '').replace(/\s+/g, ' ').trim();
    out.push({ index: i, text: text, group: group ? group.label : '', disabled: o.disabled || !!(group && group.disabled), key: fold(text), groupKey: group ? fold(group.label) : '' });
  }
  return out;
}

// The options that match every word typed, those starting with it first.
function matching(options, query) {
  var words = fold(query).split(' ').filter(Boolean);
  if (!words.length) return options;
  var hits = [];
  options.forEach(function (o, n) {
    var all = o.key + ' ' + o.groupKey;
    if (!words.every(function (w) { return all.indexOf(w) >= 0; })) return;
    var rank = o.key.indexOf(words[0]) === 0 ? 0 : (' ' + o.key).indexOf(' ' + words[0]) >= 0 ? 1 : o.key.indexOf(words[0]) >= 0 ? 2 : 3;
    hits.push({ o: o, rank: rank, n: n });
  });
  hits.sort(function (a, b) { return a.rank - b.rank || a.n - b.n; });
  return hits.map(function (h) { return h.o; });
}

// The option's words with what was typed marked.
function marked(text, query) {
  var words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  var lower = text.toLowerCase(), spans = [];
  words.forEach(function (w) { var at = lower.indexOf(w); if (at >= 0) spans.push([at, at + w.length]); });
  spans.sort(function (a, b) { return a[0] - b[0]; });
  var frag = document.createDocumentFragment(), pos = 0;
  spans.forEach(function (s) {
    if (s[0] < pos) return;
    if (s[0] > pos) frag.appendChild(document.createTextNode(text.slice(pos, s[0])));
    var m = document.createElement('mark');
    m.textContent = text.slice(s[0], s[1]);
    frag.appendChild(m);
    pos = s[1];
  });
  if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
  return frag;
}

// What the dropdown is for: its aria-label, or its label's words without the
// options of a dropdown inside it.
function labelOf(select) {
  var own = select.getAttribute('aria-label');
  if (own) return own.trim();
  var l = select.labels && select.labels[0];
  if (!l) return '';
  var c = l.cloneNode(true);
  c.querySelectorAll('select, input, textarea, button, small').forEach(function (n) { n.remove(); });
  return c.textContent.replace(/\s+/g, ' ').trim().slice(0, 80);
}

function isSheet() { return window.innerWidth <= SHEET_WIDTH; }

function place() {
  if (!current) return;
  var c = current, r = c.select.getBoundingClientRect();
  if (!c.select.isConnected || (r.width === 0 && r.height === 0)) { close(false); return; }
  if (c.sheet) return;
  var vw = window.innerWidth, vh = window.innerHeight;
  var width = Math.min(Math.max(r.width, 260), 440, vw - 16);
  var left = Math.max(8, Math.min(r.left, vw - width - 8));
  var below = vh - r.bottom - LIST_GAP - 8, above = r.top - LIST_GAP - 8;
  var p = c.panel.style;
  p.left = left + 'px';
  p.width = width + 'px';
  if (below >= Math.min(260, MAX_LIST) || below >= above) {
    p.top = (r.bottom + LIST_GAP) + 'px'; p.bottom = 'auto';
    p.maxHeight = Math.max(160, Math.min(MAX_LIST, below)) + 'px';
  } else {
    p.top = 'auto'; p.bottom = (vh - r.top + LIST_GAP) + 'px';
    p.maxHeight = Math.max(160, Math.min(MAX_LIST, above)) + 'px';
  }
}

function render() {
  var c = current, query = c.input.value;
  var options = matching(optionsOf(c.select), query);
  c.rows = options.filter(function (o) { return !o.disabled; });
  if (c.active >= c.rows.length) c.active = c.rows.length - 1;
  if (c.active < 0 && c.rows.length) c.active = 0;
  c.list.textContent = '';
  var lastGroup = null, chosen = c.select.selectedIndex;
  options.forEach(function (o) {
    if (!query && o.group !== lastGroup && o.group) {
      var g = document.createElement('div');
      g.className = 'tts-group';
      g.setAttribute('role', 'presentation');
      g.textContent = o.group;
      c.list.appendChild(g);
    }
    lastGroup = o.group;
    var row = document.createElement('div');
    var n = c.rows.indexOf(o);
    row.id = 'tts-opt-' + o.index;
    row.className = 'tts-opt' + (o.index === chosen ? ' is-chosen' : '') + (o.disabled ? ' is-off' : '') + (n === c.active ? ' is-active' : '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', o.index === chosen ? 'true' : 'false');
    if (o.disabled) row.setAttribute('aria-disabled', 'true');
    row.dataset.index = String(o.index);
    var label = document.createElement('span');
    label.className = 'tts-label';
    label.appendChild(o.text ? marked(o.text, query) : document.createTextNode('—'));
    row.appendChild(label);
    if (query && o.group) { var tag = document.createElement('small'); tag.textContent = o.group; row.appendChild(tag); }
    c.list.appendChild(row);
  });
  if (!options.length) {
    var none = document.createElement('div');
    none.className = 'tts-none';
    none.textContent = tr('Nothing matches "{q}"', { q: query.trim() });
    c.list.appendChild(none);
  }
  var count = c.panel.querySelector('.tts-count');
  count.textContent = query ? String(c.rows.length) : '';
  markActive(false);
}

function markActive(scroll) {
  var c = current;
  var rows = c.list.querySelectorAll('.tts-opt:not(.is-off)');
  rows.forEach(function (el, n) { el.classList.toggle('is-active', n === c.active); });
  var el = rows[c.active];
  if (el) {
    c.input.setAttribute('aria-activedescendant', el.id);
    if (scroll) el.scrollIntoView({ block: 'nearest' });
  } else c.input.removeAttribute('aria-activedescendant');
}

function pick(index) {
  var select = current.select;
  close(false);
  if (select.selectedIndex !== index) {
    select.selectedIndex = index;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  try { select.focus({ preventScroll: true }); } catch { /* gone */ }
}

function open(select, typed) {
  if (current) close(false);
  var sheet = isSheet();
  var layer = document.createElement('div');
  layer.className = 'tts-layer' + (sheet ? ' is-sheet' : '');
  var panel = document.createElement('div');
  panel.className = 'tts';
  var field = document.createElement('div');
  field.className = 'tts-field';
  field.innerHTML = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="9" cy="9" r="6.5" stroke="currentColor" stroke-width="1.7"/><path d="M18 18l-4-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
  var input = document.createElement('input');
  input.type = 'text';
  input.className = 'tts-input';
  input.placeholder = tr('Type to search…');
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-autocomplete', 'list');
  var label = labelOf(select);
  if (label) input.setAttribute('aria-label', label);
  var count = document.createElement('span');
  count.className = 'tts-count';
  field.appendChild(input);
  field.appendChild(count);
  var list = document.createElement('div');
  list.className = 'tts-list';
  list.id = 'tts-list';
  list.setAttribute('role', 'listbox');
  input.setAttribute('aria-controls', list.id);
  if (sheet && label) { var head = document.createElement('div'); head.className = 'tts-head'; head.textContent = label; panel.appendChild(head); }
  panel.appendChild(field);
  panel.appendChild(list);
  layer.appendChild(panel);
  // Clicks inside stay inside: a menu or pop-up that closes on a click
  // elsewhere (listening on the document) does not see these.
  ['mousedown', 'pointerdown', 'touchstart', 'click'].forEach(function (t) { layer.addEventListener(t, function (e) { e.stopPropagation(); }); });
  layer.addEventListener('mousedown', function (e) { if (e.target === layer) { e.preventDefault(); close(true); } });
  list.addEventListener('mousedown', function (e) { e.preventDefault(); });
  list.addEventListener('click', function (e) {
    var row = e.target.closest('.tts-opt');
    if (row && !row.classList.contains('is-off')) pick(Number(row.dataset.index));
  });
  list.addEventListener('mousemove', function (e) {
    var row = e.target.closest('.tts-opt:not(.is-off)');
    if (!row) return;
    var n = Array.prototype.indexOf.call(list.querySelectorAll('.tts-opt:not(.is-off)'), row);
    if (n >= 0 && n !== current.active) { current.active = n; markActive(false); }
  });
  input.addEventListener('input', function () { current.active = 0; render(); list.scrollTop = 0; });
  input.addEventListener('keydown', onListKey);
  document.body.appendChild(layer);
  // Above everything, a pop-up included, where the browser can.
  if (layer.showPopover) { layer.setAttribute('popover', 'manual'); try { layer.showPopover(); } catch { /* shown as it is */ } }
  current = { select: select, layer: layer, panel: panel, input: input, list: list, rows: [], active: -1, sheet: sheet };
  var opts = optionsOf(select).filter(function (o) { return !o.disabled; });
  current.active = Math.max(0, opts.findIndex(function (o) { return o.index === select.selectedIndex; }));
  if (typed) input.value = typed;
  if (typed) current.active = 0;
  render();
  place();
  var chosen = list.querySelector('.tts-opt.is-active');
  if (chosen) chosen.scrollIntoView({ block: 'center' });
  // On a phone the keyboard waits for a long list: a short one is tapped.
  var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (!coarse || typed || opts.length > 8) input.focus({ preventScroll: true });
  current.observer = new MutationObserver(function () { if (current) render(); });
  current.observer.observe(select, { childList: true, subtree: true, attributes: true, characterData: true });
  current.timer = setInterval(function () { if (current && (!current.select.isConnected || current.select.disabled)) close(false); }, 400);
  select.classList.add('tts-is-open');
}

function close(refocus) {
  if (!current) return;
  var c = current;
  current = null;
  clearInterval(c.timer);
  if (c.observer) c.observer.disconnect();
  c.select.classList.remove('tts-is-open');
  try { if (c.layer.hidePopover && c.layer.matches(':popover-open')) c.layer.hidePopover(); } catch { /* not shown that way */ }
  c.layer.remove();
  if (refocus && c.select.isConnected) { try { c.select.focus({ preventScroll: true }); } catch { /* gone */ } }
}

function onListKey(e) {
  var c = current;
  if (!c) return;
  var n = c.rows.length;
  if (e.key === 'ArrowDown') { e.preventDefault(); if (n) { c.active = (c.active + 1) % n; markActive(true); } }
  else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) { c.active = (c.active - 1 + n) % n; markActive(true); } }
  else if (e.key === 'PageDown') { e.preventDefault(); if (n) { c.active = Math.min(n - 1, c.active + 8); markActive(true); } }
  else if (e.key === 'PageUp') { e.preventDefault(); if (n) { c.active = Math.max(0, c.active - 8); markActive(true); } }
  else if (e.key === 'Enter') { e.preventDefault(); if (c.rows[c.active]) pick(c.rows[c.active].index); }
  else if (e.key === 'Escape') { e.preventDefault(); close(true); }
  else if (e.key === 'Tab') { e.preventDefault(); close(true); }
  else return;
  e.stopPropagation();
}

// ── Opening a dropdown ──
function onMouseDown(e) {
  if (e.button !== 0) return;
  var select = e.target.closest && e.target.closest('select');
  if (current && !current.layer.contains(e.target) && current.select !== select) close(false);
  if (!takesOver(select)) return;
  e.preventDefault();
  if (current && current.select === select) { close(true); return; }
  open(select, '');
}
function onTouchStart(e) {
  var select = e.target.closest && e.target.closest('select');
  if (current && !current.layer.contains(e.target) && current.select !== select) close(false);
  touch = takesOver(select) && e.touches.length === 1 ? { select: select, x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
}
function onTouchEnd(e) {
  var t = touch;
  touch = null;
  if (!t) return;
  var p = e.changedTouches[0];
  if (!p || Math.abs(p.clientX - t.x) > 10 || Math.abs(p.clientY - t.y) > 10) return;
  e.preventDefault();
  if (current && current.select === t.select) { close(true); return; }
  open(t.select, '');
}
function onSelectKey(e) {
  var select = e.target;
  if (current || !takesOver(select)) return;
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'F4' || (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))) { e.preventDefault(); open(select, ''); }
  else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); open(select, e.key); }
}

// ── Typing into a screen's search box ──
var SEARCH_BOXES = 'input.search-input, input[type="search"], input[data-type-to-search]';
var POPUPS = 'dialog[open], [role="dialog"], [aria-modal="true"], .dialog-backdrop';
function shown(el) {
  if (!el.isConnected || el.disabled || el.readOnly) return false;
  var r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  var s = window.getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none';
}
function typingSomewhere(el) {
  if (!el || el === document.body) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.closest('[contenteditable="true"]');
}
function searchBox() {
  var popups = Array.prototype.filter.call(document.querySelectorAll(POPUPS), shown);
  var scope = popups.length ? popups[popups.length - 1] : document;
  var boxes = Array.prototype.filter.call(scope.querySelectorAll(SEARCH_BOXES), function (el) { return shown(el) && !el.closest('[data-no-type-to-search]'); });
  if (!popups.length) boxes = boxes.filter(function (el) { return !el.closest(POPUPS); });
  return boxes[0] || null;
}
var held = null; // { text, events, last, cancelled, timer }
function typeInto(box, text) {
  var set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  box.focus({ preventScroll: false });
  set.call(box, text);
  box.dispatchEvent(new Event('input', { bubbles: true }));
  try { box.setSelectionRange(text.length, text.length); } catch { /* not a text box */ }
}
function release() {
  var h = held;
  held = null;
  if (!h || h.cancelled || h.events.some(function (e) { return e.defaultPrevented; })) return;
  if (typingSomewhere(document.activeElement) || current) return;
  var box = searchBox();
  if (box) typeInto(box, h.text);
}
function onPageKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  var now = Date.now();
  if (held && (e.key === 'Enter' || e.key.length === 1) && (held.cancelled || now - held.last < SCAN_MS)) {
    // Faster than anyone types: a scanner. Its code is not a search.
    held.cancelled = true;
    held.last = now;
    return;
  }
  if (typingSomewhere(e.target) || current) return;
  if (e.key.length !== 1 || !/\p{L}/u.test(e.key)) return;
  if (held) { held.text += e.key; held.events.push(e); held.last = now; clearTimeout(held.timer); held.timer = setTimeout(release, HOLD_MS); return; }
  held = { text: e.key, events: [e], last: now, cancelled: false, timer: setTimeout(release, HOLD_MS) };
}

var installed = false;
export function installTypeToSearch() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  document.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
  document.addEventListener('keydown', onSelectKey, true);
  window.addEventListener('keydown', onPageKey);
  window.addEventListener('resize', function () { if (current) { if (current.sheet !== isSheet()) close(false); else place(); } });
  document.addEventListener('scroll', function (e) { if (current && !current.layer.contains(e.target)) place(); }, true);
}

export const typeToSearchForTests = { matching: matching, fold: fold };
