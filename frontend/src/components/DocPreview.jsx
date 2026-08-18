import './DocPreview.css';

// Shared print-style preview modal for Estimates/Quotations/Invoices,
// ported from Bamboo OS.dc.html's dialog.estimatePreview / .quotationPreview
// / .invoicePreview blocks (nearly identical white-page layouts, only the
// label text and the third detail column differ per document kind).

export default function DocPreview({ docLabel, dateLabel, dateValue, heading, subHeading, blocks, items, subtotal, isPartial, amountPaid, totalLabel, total, notesLabel, notesValue, termsLabel, termsValue, onClose }) {
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="doc-preview" onClick={(e) => e.stopPropagation()}>
        <div className="doc-preview-head">
          <div className="doc-preview-brand">
            <div className="doc-preview-brand-name">Bamboo Products Limited</div>
          </div>
          <div className="doc-preview-headright">
            <div className="doc-preview-docno">{docLabel}</div>
            <div className="doc-preview-datelabel">{dateLabel}</div>
            <div className="doc-preview-datevalue">{dateValue}</div>
          </div>
        </div>
        <div className="doc-preview-rule" />
        <h1 className="doc-preview-heading">{heading}</h1>
        <div className="doc-preview-subheading">{subHeading}</div>
        <div className="doc-preview-blocks">
          {blocks.map((b, i) => (
            <div key={i}>
              <div className="doc-preview-block-title">{b.title}</div>
              {b.lines.map((line, j) => <div key={j} className="doc-preview-block-line">{line}</div>)}
            </div>
          ))}
        </div>
        <table className="doc-preview-table">
          <thead><tr><th>Items</th><th className="doc-preview-num">Quantity</th><th className="doc-preview-num">Price</th><th className="doc-preview-num">Amount</th></tr></thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i}><td className="doc-preview-desc">{it.description}</td><td className="doc-preview-num">{it.qty}</td><td className="doc-preview-num">{it.unitPrice}</td><td className="doc-preview-num">{it.lineTotal}</td></tr>
            ))}
          </tbody>
        </table>
        <div className="doc-preview-row">
          <div>Subtotal</div><div>{subtotal}</div>
        </div>
        {isPartial && (
          <div className="doc-preview-row">
            <div>Amount paid</div><div>{amountPaid}</div>
          </div>
        )}
        <div className="doc-preview-grand-row">
          <div>{totalLabel}</div><div>{total}</div>
        </div>
        {notesValue && (
          <div className="doc-preview-notes">
            <div className="doc-preview-notes-label">{notesLabel}</div>
            <p className="doc-preview-notes-body">{notesValue}</p>
          </div>
        )}
        {termsValue && (
          <div className="doc-preview-notes">
            <div className="doc-preview-notes-label">{termsLabel}</div>
            <p className="doc-preview-terms-body">{termsValue}</p>
          </div>
        )}
        <div className="doc-preview-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
