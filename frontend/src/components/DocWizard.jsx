import { useState } from 'react';
import DocItemsEditor from './DocItemsEditor';
import DocPreview from './DocPreview';
import { money } from '../lib/currency';
import { groupPackageItems } from '../lib/packages';
import './DocWizard.css';

// Shared 3-step create flow for Quotations/Estimates/Invoices, modeled on
// Square's own "Details -> Estimate/Invoice -> Finish & update" wizard
// (screenshots the user supplied). Each page still owns its document-
// specific fields (customer, title, valid-until/due-date — passed in as
// `detailsSlot`) and its own submit call; this component only owns the
// steps/navigation shell, the items editor (already carries reorder +
// doc-level discount + shipping/service-charge, see DocItemsEditor.jsx),
// and a lightweight recap on the last step. Sharing (link/WhatsApp) only
// makes sense for a document that already exists, so it lives on the
// existing Preview dialog (DocPreview.jsx) instead of in here — this
// wizard's last step is "review, then create."

const STEPS = ['Details', 'Items & pricing', 'Finish'];

export default function DocWizard({
  title, docKind, detailsSlot, message, onMessageChange, messageLabel,
  items, onItemsChange, catalogOptions, currency,
  docDiscount, onDocDiscountChange, docTaxRate, onDocTaxRateChange,
  paymentSchedule, onPaymentScheduleChange,
  recapBlocks, submitLabel, saving, error, onSubmit, onClose
}) {
  const [step, setStep] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const totals = computeRecapTotals(items, docDiscount, docTaxRate);

  async function handleSubmit(e) {
    e.preventDefault();
    await onSubmit();
  }

  // Draft preview — before anything's been created, so there's no real
  // document id to attach a share link/WhatsApp send to (DocPreview only
  // shows that Communication section when documentType+documentId are
  // both passed, which they deliberately aren't here).
  const customerName = (recapBlocks && recapBlocks[0] && recapBlocks[0].value) || '';
  const secondBlock = (recapBlocks && recapBlocks[1]) || null;
  const kindLabel = docKind ? docKind.charAt(0).toUpperCase() + docKind.slice(1) : 'Document';
  const previewItems = groupPackageItems(items, currency);
  const previewSchedule = (paymentSchedule || []).filter((r) => Number(r.value) > 0).map((r) => ({
    label: r.label || 'Installment',
    dueDate: r.dueDate || '—',
    amount: money(r.type === 'fixed' ? Number(r.value) || 0 : (totals.grandTotal * (Number(r.value) || 0)) / 100, currency)
  }));

  return (
    <>
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog docwizard" onClick={(e) => e.stopPropagation()} onSubmit={step === STEPS.length - 1 ? handleSubmit : (e) => e.preventDefault()}>
        <h2 className="docwizard-title">{title}</h2>
        <div className="docwizard-steps">
          {STEPS.map((label, i) => (
            <button
              type="button" key={label}
              className={'docwizard-step' + (i === step ? ' docwizard-step-active' : '') + (i < step ? ' docwizard-step-done' : '')}
              onClick={() => setStep(i)}
            >
              <span className="docwizard-step-num">{i + 1}</span>{label}
            </button>
          ))}
        </div>

        {error && <div className="error-banner">{error}</div>}

        {step === 0 && (
          <div className="docwizard-panel">
            {detailsSlot}
            <div className="field">
              <label>{messageLabel || 'Message to customer'}</label>
              <textarea className="input" rows={3} value={message} onChange={(e) => onMessageChange(e.target.value)} placeholder="We look forward to working with you." />
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="docwizard-panel">
            <DocItemsEditor
              items={items} onChange={onItemsChange} catalogOptions={catalogOptions} currency={currency}
              docDiscount={docDiscount} onDocDiscountChange={onDocDiscountChange}
              docTaxRate={docTaxRate} onDocTaxRateChange={onDocTaxRateChange}
              paymentSchedule={paymentSchedule} onPaymentScheduleChange={onPaymentScheduleChange}
            />
          </div>
        )}

        {step === 2 && (
          <div className="docwizard-panel">
            <div className="docwizard-recap">
              {(recapBlocks || []).map((b, i) => (
                <div className="docwizard-recap-row" key={i}><span>{b.label}</span><span>{b.value}</span></div>
              ))}
              <div className="docwizard-recap-row"><span>Items</span><span>{items.length}</span></div>
              <div className="docwizard-recap-row"><span>Subtotal</span><span>{money(totals.subtotal, currency)}</span></div>
              <div className="docwizard-recap-row"><span>Discount</span><span>{money(totals.discountTotal, currency)}</span></div>
              <div className="docwizard-recap-row"><span>Tax</span><span>{money(totals.taxTotal, currency)}</span></div>
              <div className="docwizard-recap-row docwizard-recap-total"><span>Total</span><span>{money(totals.grandTotal, currency)}</span></div>
              {message && <div className="docwizard-recap-message">"{message}"</div>}
            </div>
            {previewSchedule.length > 0 && (
              <div className="docwizard-recap">
                <div className="docwizard-recap-row"><span><strong>Payment schedule</strong></span><span></span></div>
                {previewSchedule.map((row, i) => (
                  <div className="docwizard-recap-row" key={i}><span>{row.label} — due {row.dueDate}</span><span>{row.amount}</span></div>
                ))}
              </div>
            )}
            <p className="docwizard-recap-hint">You can generate a share link or send this by WhatsApp once it's created — open it from the list and click Preview.</p>
          </div>
        )}

        <div className="dialog-actions docwizard-actions">
          <div className="docwizard-actions-left">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-secondary" onClick={() => setPreviewOpen(true)}>Preview</button>
          </div>
          <div className="docwizard-actions-right">
            {step > 0 && <button type="button" className="btn btn-secondary" onClick={() => setStep(step - 1)}>Back</button>}
            {step < STEPS.length - 1 && <button type="button" className="btn btn-primary" onClick={() => setStep(step + 1)}>Next</button>}
            {step === STEPS.length - 1 && <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : submitLabel}</button>}
          </div>
        </div>
      </form>
    </div>

    {previewOpen && (
      <DocPreview
        docLabel={title}
        dateLabel="Status"
        dateValue="Draft — not yet created"
        heading={kindLabel + (customerName ? ' for ' + customerName : '')}
        subHeading={secondBlock ? secondBlock.label + ': ' + secondBlock.value : ''}
        blocks={[
          { title: 'Customer', lines: [customerName || '—'] },
          { title: kindLabel + ' Details', lines: [items.length + ' item' + (items.length === 1 ? '' : 's'), money(totals.grandTotal, currency)] },
          secondBlock ? { title: secondBlock.label, lines: [secondBlock.value] } : { title: '', lines: [] }
        ]}
        items={previewItems}
        subtotal={money(totals.subtotal, currency)}
        totalLabel="Grand Total"
        total={money(totals.grandTotal, currency)}
        notesLabel={messageLabel || 'Message to customer'}
        notesValue={message}
        paymentSchedule={previewSchedule}
        onClose={() => setPreviewOpen(false)}
      />
    )}
    </>
  );
}

// Local mirror of DocItemsEditor's computeDocTotals, kept private to this
// file so the recap step doesn't need to import a named export just for
// this one summary.
function computeRecapTotals(items, docDiscount, docTaxRate) {
  let subtotal = 0, discountTotal = 0, taxTotal = 0;
  items.forEach((it) => {
    const qty = Number(it.qty) || 0, price = Number(it.unitPrice) || 0;
    const line = qty * price;
    const disc = it.discountType === 'percent' ? (line * (Number(it.discount) || 0)) / 100 : Number(it.discount) || 0;
    const afterDisc = Math.max(0, line - disc);
    const tax = (afterDisc * (Number(it.taxRate) || 0)) / 100;
    subtotal += line; discountTotal += disc; taxTotal += tax;
  });
  let docDiscountAmt = 0;
  if (docDiscount && docDiscount.value) docDiscountAmt = docDiscount.type === 'percent' ? ((subtotal - discountTotal) * docDiscount.value) / 100 : Number(docDiscount.value) || 0;
  discountTotal += docDiscountAmt;
  const docTaxAmt = docTaxRate ? (Math.max(0, subtotal - discountTotal) * (Number(docTaxRate) || 0)) / 100 : 0;
  taxTotal += docTaxAmt;
  const grandTotal = Math.max(0, subtotal - discountTotal) + taxTotal;
  return { subtotal, discountTotal, taxTotal, grandTotal };
}
