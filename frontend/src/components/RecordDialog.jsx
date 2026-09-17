import { useEffect, useRef } from 'react';
import RowMenu from './RowMenu';
import './RecordDialog.css';

// The panel that opens when a table row is clicked.
//
// Rows carried their detail across a wide spread of columns, which is what
// made the tables too wide to fit a screen. Moving the detail here lets the
// table show only what you scan by — reference, who, amount, status — and
// puts everything else one click away, without scrolling anywhere.
//
// `fields` is [{ label, value, wide?, hidden? }]. A null/undefined value is
// dropped rather than rendered as an empty row, so callers can pass optional
// fields inline without guarding each one.
export default function RecordDialog({ title, subtitle, tag, fields, actions, footer, onClose }) {
  const closeRef = useRef(null);

  useEffect(() => {
    closeRef.current?.focus();
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shown = (fields || []).filter(
    (f) => f && !f.hidden && f.value !== null && f.value !== undefined && f.value !== ''
  );

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog record-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="record-dialog-head">
          <div className="record-dialog-heading">
            <h2>{title}</h2>
            {subtitle && <p className="record-dialog-subtitle">{subtitle}</p>}
          </div>
          <div className="record-dialog-head-right">
            {tag}
            {actions && actions.length > 0 && <RowMenu actions={actions} label="Actions" />}
            <button type="button" ref={closeRef} className="record-dialog-close" onClick={onClose} aria-label="Close">
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>

        <dl className="record-dialog-fields">
          {shown.map((f) => (
            <div key={f.label} className={'record-dialog-field' + (f.wide ? ' record-dialog-field-wide' : '')}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>

        {footer}
      </div>
    </div>
  );
}
