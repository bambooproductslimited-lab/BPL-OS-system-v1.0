import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { tr } from '../lib/i18n.jsx';
import './CustomerPicker.css';

// Search-or-browse customer field for the Quotations/Estimates/Invoices
// wizard's Details step, replacing a plain <select> that made finding one
// customer among dozens (this app's customer list runs well past what a
// dropdown can browse comfortably) painful. Unlike CatalogPicker, the
// submitted value here has to be a real customer id (not free text), so
// this keeps its own "are we searching or showing the selection" state
// rather than making the input's value the thing that gets submitted.
//
// Portaled to document.body for the same reason as CatalogPicker: every
// call site sits inside a dialog with its own scrolling body, and a plain
// position:absolute dropdown would get clipped by that overflow.

function normalize(v) { return (v == null ? '' : String(v)).toLowerCase().trim(); }

export default function CustomerPicker({ customers, value, onChange, placeholder, required, id }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [rect, setRect] = useState(null);
  const wrapRef = useRef(null);
  const panelRef = useRef(null);

  const selected = (customers || []).find((c) => c.id === value) || null;
  const displayValue = open ? query : (selected ? selected.name : '');

  function openPanel() {
    setQuery('');
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

  const q = normalize(query);
  const list = customers || [];
  const filtered = !q ? list : list.filter((c) => normalize(c.name).includes(q) || normalize(c.email).includes(q) || normalize(c.phone).includes(q));

  function pick(c) {
    onChange(c.id);
    setOpen(false);
    setQuery('');
    setHighlight(0);
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) openPanel(); setHighlight((h) => Math.min(h + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { if (open && filtered[highlight]) { e.preventDefault(); pick(filtered[highlight]); } }
    else if (e.key === 'Escape') { setOpen(false); }
  }

  return (
    <div className="custpick-wrap" ref={wrapRef}>
      <div className="custpick-input-wrap">
        <svg className="custpick-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <circle cx="9" cy="9" r="6.5" stroke="currentColor" strokeWidth="1.6" />
          <path d="M18 18L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <input
          id={id}
          type="text"
          className="input custpick-input"
          required={required}
          value={displayValue}
          placeholder={placeholder || 'Search customers…'}
          onFocus={openPanel}
          onChange={(e) => { setQuery(e.target.value); if (!open) setOpen(true); setHighlight(0); }}
          onKeyDown={onKeyDown}
        />
      </div>
      {open && rect && createPortal(
        <div className="custpick-panel" ref={panelRef} style={{ top: rect.bottom + 3, left: rect.left, minWidth: rect.width }}>
          {filtered.length === 0 && <div className="custpick-empty">{tr('No matching customers')}</div>}
          {filtered.map((c, i) => (
            <button
              type="button"
              key={c.id}
              className={'custpick-option' + (i === highlight ? ' custpick-option-active' : '')}
              onMouseDown={(e) => { e.preventDefault(); pick(c); }}
              onMouseEnter={() => setHighlight(i)}
            >
              <span className="custpick-option-name">{c.name}</span>
              {(c.email || c.phone) && <span className="custpick-option-sub">{c.email || c.phone}</span>}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
