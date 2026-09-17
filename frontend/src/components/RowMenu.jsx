import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './RowMenu.css';

// The three-dot actions menu that replaces a row of buttons.
//
// Rows used to carry every action as its own button — Preview, Record
// payment, Edit, Void, Delete — inside a white-space:nowrap cell. Five
// buttons is wider than the column can be, so the table pushed the whole
// document sideways: you scrolled right to reach Delete, and the page had a
// white band down the edge (see lib/theme.js). Collapsing them to one
// button is what stops the table being too wide in the first place.
//
// The menu renders in a portal against the viewport rather than inside the
// cell, because a table cell with overflow is a clipping context — a
// dropdown positioned inside the last row would be cut off by the table's
// own scroll container instead of overlapping it.
//
// `actions` is an array of { label, onClick, danger?, disabled?, hidden? }.
// Hidden entries are dropped rather than shown greyed out, which keeps the
// caller's existing permission checks (canManage && ...) reading the same
// way they did when they guarded whole buttons.
export default function RowMenu({ actions, disabled, label = 'Actions' }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  const items = (actions || []).filter((a) => a && !a.hidden);

  useEffect(() => {
    if (!open) return undefined;
    function onDown(e) {
      if (btnRef.current && btnRef.current.contains(e.target)) return;
      if (menuRef.current && menuRef.current.contains(e.target)) return;
      setOpen(false);
    }
    function onKey(e) { if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus(); } }
    // Capture phase, so a click lands on the backdrop before any row-level
    // click handler can read it as "open this record".
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', () => setOpen(false));
    // Any scroll closes it: the menu is pinned to viewport coordinates
    // taken when it opened, so it would otherwise drift away from its row.
    window.addEventListener('scroll', () => setOpen(false), true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Placed after paint, once the menu has a real height to measure, so it
  // can flip above the button when there is no room below.
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const h = menuRef.current ? menuRef.current.offsetHeight : items.length * 36 + 12;
    const below = window.innerHeight - r.bottom;
    setPos({
      top: below < h + 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6,
      right: Math.max(8, window.innerWidth - r.right),
    });
  }, [open, items.length]);

  if (!items.length) return null;

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        className={'row-menu-btn' + (open ? ' row-menu-btn-open' : '')}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <circle cx="8" cy="3" r="1.5" fill="currentColor" />
          <circle cx="8" cy="8" r="1.5" fill="currentColor" />
          <circle cx="8" cy="13" r="1.5" fill="currentColor" />
        </svg>
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="row-menu"
          role="menu"
          style={{ top: pos.top, right: pos.right }}
          onClick={(e) => e.stopPropagation()}
        >
          {items.map((a) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              className={'row-menu-item' + (a.danger ? ' row-menu-item-danger' : '')}
              disabled={a.disabled}
              onClick={(e) => { e.stopPropagation(); setOpen(false); a.onClick(); }}
            >
              {a.label}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}
