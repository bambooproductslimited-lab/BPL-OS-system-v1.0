import { useEffect, useRef } from 'react';
import RowMenu from './RowMenu';
import { tr } from '../lib/i18n.jsx';
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
//
// `items` are the document's lines — what was actually quoted, invoiced or
// estimated. A record without them is not the record: an invoice panel that
// shows a total but not what the total is for sends you off to Preview for
// the one thing you opened the row to see. `totals` is the money summary
// that goes underneath.
export default function RecordDialog({ title, subtitle, tag, fields, items, totals, actions, footer, onClose }) {
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
            <button type="button" ref={closeRef} className="record-dialog-close" onClick={onClose} aria-label={tr('Close')}>
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

        {items && items.length > 0 && (
          <div className="record-dialog-items">
            <div className="record-dialog-items-head">{tr('Items')}</div>
            <table className="record-dialog-items-table">
              <thead>
                <tr>
                  <th>{tr('Description')}</th>
                  <th className="num">{tr('Qty')}</th>
                  <th className="num">{tr('Unit price')}</th>
                  <th className="num">{tr('Amount')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={i}>
                    <td>
                      {it.description}
                      {it.packageLabel && <span className="record-dialog-item-note">{it.packageLabel}</span>}
                      {it.notes && <span className="record-dialog-item-note">{it.notes}</span>}
                      {(Number(it.discount) > 0 || Number(it.taxRate) > 0) && (
                        <span className="record-dialog-item-note">
                          {Number(it.discount) > 0 && (tr('less ') + it.discount + (it.discountType === 'percent' ? '%' : ''))}
                          {Number(it.discount) > 0 && Number(it.taxRate) > 0 && ' · '}
                          {Number(it.taxRate) > 0 && (tr('tax ') + it.taxRate + '%')}
                        </span>
                      )}
                    </td>
                    <td className="num">{it.qty}{it.unit && it.unit !== 'each' ? ' ' + it.unit : ''}</td>
                    <td className="num">{it.unitPriceText}</td>
                    <td className="num">{it.amountText}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {totals && totals.length > 0 && (
              <dl className="record-dialog-totals">
                {totals.filter((t) => t && t.value !== null && t.value !== undefined).map((t) => (
                  <div key={t.label} className={t.strong ? 'is-strong' : undefined}>
                    <dt>{t.label}</dt><dd>{t.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        )}

        {footer}
      </div>
    </div>
  );
}
