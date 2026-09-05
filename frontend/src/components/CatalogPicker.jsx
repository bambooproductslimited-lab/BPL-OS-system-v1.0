import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './CatalogPicker.css';

// Combined search-or-type-custom item field, used by DocItemsEditor
// (Quotations/Estimates/Invoices) and WaybillsPage in place of what used
// to be two separate inputs: a "From catalogue…" <select> plus a second
// plain text box for a custom line. This is fully controlled — `value` is
// the actual description text for the line, typed or picked — so there's
// nothing extra to reset: type a name/code to see matching catalogue
// items and click one to fill in its price/unit too, or just keep typing
// your own text for a one-off item that isn't in the catalogue at all.
//
// The results panel is rendered through a portal into document.body,
// positioned with fixed coordinates from the input's own
// getBoundingClientRect(), rather than as a normal absolutely-positioned
// child. Every current call site sits inside a horizontally-scrollable
// table wrapper (and/or a dialog with its own scrolling body) — an
// overflow:auto ancestor clips any descendant that visually extends past
// its box, which a plain `position: absolute` dropdown would do for any
// row near the bottom of the table. Portaling to body sidesteps that
// clipping entirely.

function normalize(v) { return (v == null ? '' : String(v)).toLowerCase().trim(); }

export default function CatalogPicker({ value, onChange, onPickOption, options, placeholder, renderOption, required }) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [rect, setRect] = useState(null);
  const wrapRef = useRef(null);
  const panelRef = useRef(null);

  function openPanel() {
    if (wrapRef.current) setRect(wrapRef.current.getBoundingClientRect());
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return undefined;
    function onDocMouseDown(e) {
      if (wrapRef.current && wrapRef.current.contains(e.target)) return;
      if (panelRef.current && panelRef.current.contains(e.target)) return;
      setOpen(false);
    }
    // Reposition (rather than close) on scroll/resize while open — the
    // panel itself is new content appended to the end of <body>, and just
    // inserting it can trigger a native scroll adjustment (browser scroll
    // anchoring, or a test-automation actionability re-scroll) in the same
    // tick it opens. Closing on that self-inflicted scroll made the panel
    // flash open then instantly vanish; capture:true still lets this catch
    // scrolling on any ancestor, including a dialog's own scrolling body.
    function reposition() { if (wrapRef.current) setRect(wrapRef.current.getBoundingClientRect()); }
    document.addEventListener('mousedown', onDocMouseDown);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open]);

  const q = normalize(value);
  const list = options || [];
  // An exact match (the field already holds a picked item's own display
  // name) has nothing useful left to suggest — only show the panel for
  // partial/prefix-style matches, so re-focusing an already-filled line
  // doesn't immediately reopen a single-option dropdown.
  const filtered = !q ? [] : list.filter((c) => (normalize(c.name).includes(q) || normalize(c.code).includes(q)) && normalize(c.name) !== q);

  function pick(item) {
    onPickOption(item);
    setOpen(false);
    setHighlight(0);
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) openPanel(); setHighlight((h) => Math.min(h + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { if (open && filtered[highlight]) { e.preventDefault(); pick(filtered[highlight]); } }
    else if (e.key === 'Escape') { setOpen(false); }
  }

  return (
    <div className="catpick-wrap" ref={wrapRef}>
      <div className="catpick-input-wrap">
        <svg className="catpick-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <circle cx="9" cy="9" r="6.5" stroke="currentColor" strokeWidth="1.6" />
          <path d="M18 18L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <input
          type="text"
          className="input catpick-input"
          value={value}
          required={required}
          placeholder={placeholder || 'Search catalogue or type a custom item…'}
          onFocus={openPanel}
          onChange={(e) => { onChange(e.target.value); if (!open) openPanel(); setHighlight(0); }}
          onKeyDown={onKeyDown}
        />
      </div>
      {open && rect && filtered.length > 0 && createPortal(
        <div
          className="catpick-panel"
          ref={panelRef}
          style={{ top: rect.bottom + 3, left: rect.left, minWidth: rect.width }}
        >
          {filtered.map((c, i) => (
            <button
              type="button"
              key={c.id}
              className={'catpick-option' + (i === highlight ? ' catpick-option-active' : '')}
              onMouseDown={(e) => { e.preventDefault(); pick(c); }}
              onMouseEnter={() => setHighlight(i)}
            >
              {renderOption ? renderOption(c) : (c.name + (c.code ? ' (' + c.code + ')' : ''))}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
