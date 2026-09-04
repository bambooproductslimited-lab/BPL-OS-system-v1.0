import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import DocItemsEditor, { blankDocItem } from '../components/DocItemsEditor';
import DocPreview from '../components/DocPreview';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { money } from '../lib/currency';
import './InvoicesPage.css';

// Ported from Bamboo OS.dc.html's invoices screen (screens.invoices block,
// dialog.invoiceManual / dialog.invoiceEdit / dialog.payment /
// dialog.invoicePreview, and the invoices computed values).
//
// Deviations, same shape as CatalogPage's tax-rate gap and EstimatesPage's
// customer.read gap: this app's seed has invoice.manage roles
// (finance_manager, finance_hr_manager) that lack customer.read and
// sales.read, unlike quotation.manage roles which always carry
// customer.read. So, unlike Estimates/Quotations:
//  - "New manual invoice" needs its own customer.read gate (canOpenManual)
//    rather than being safe to assume from invoice.manage alone.
//  - The "issue invoice for a sales order" form is additionally gated on
//    sales.read, since its dropdown is populated from GET /sales-orders.
// Both degrade to the button/form simply not rendering for a role that
// can't populate the picker it needs, rather than showing a dead control.
//
// Redesigned around the icon language established elsewhere: a
// status-toned document badge per row (mirrors Documents' file-type
// tone-mix treatment), an icon'd empty state. All dialogs and the
// printed preview are untouched.

function DocIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="3.5" width="14" height="17" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
function statusTone(bucket) {
  if (bucket === 'approved') return 'people';
  if (bucket === 'rejected') return 'danger';
  return 'warning';
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function docTagClass(bucket) {
  if (bucket === 'approved') return 'tag-neutral';
  if (bucket === 'rejected') return 'tag-accent';
  return 'tag-outline';
}

function invoiceBucket(inv) {
  return inv.status === 'paid' ? 'approved' : (inv.overdue || inv.status === 'void') ? 'rejected' : 'pending';
}
function invoiceTagClass(inv) { return docTagClass(invoiceBucket(inv)); }

const EMPTY_FORM = { customerId: '', dueDate: '', poReference: '', currency: '' };
const EMPTY_PAY = { amount: '', method: 'cash', date: new Date().toISOString().slice(0, 10), reference: '', notes: '' };
const EMPTY_EDIT = { dueDate: '', poReference: '' };

export default function InvoicesPage() {
  const { can } = useAuth();
  const canManage = can('invoice.manage');
  const canSeeCustomers = can('customer.read');
  const canSeeCatalog = can('catalog.read');
  const canSeeSalesOrders = can('sales.read');
  const canOpenManual = canManage && canSeeCustomers;

  const [invoices, setInvoices] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [orders, setOrders] = useState([]);
  const [currencies, setCurrencies] = useState(['GHS']);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [items, setItems] = useState([blankDocItem()]);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const [orderId, setOrderId] = useState('');
  const [orderBusy, setOrderBusy] = useState(false);

  const [payTarget, setPayTarget] = useState(null);
  const [payForm, setPayForm] = useState(EMPTY_PAY);
  const [payError, setPayError] = useState(null);
  const [paying, setPaying] = useState(false);

  const [editTarget, setEditTarget] = useState(null);
  const [editForm, setEditForm] = useState(EMPTY_EDIT);
  const [editError, setEditError] = useState(null);
  const [editSaving, setEditSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [previewInv, setPreviewInv] = useState(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [inv, cust, cat, ord] = await Promise.all([
        api.get('/invoices'),
        canSeeCustomers ? api.get('/customers') : Promise.resolve([]),
        canSeeCatalog ? api.get('/catalog') : Promise.resolve([]),
        canSeeSalesOrders ? api.get('/sales-orders') : Promise.resolve([])
      ]);
      setInvoices(inv);
      setCustomers(cust);
      setCatalog(cat);
      setOrders(ord);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
    try {
      const settings = await api.get('/settings');
      if (settings.commercial && settings.commercial.currencies) setCurrencies(settings.commercial.currencies);
    } catch (err) { /* ignore — falls back to GHS only, see QuotationsPage's identical comment */ }
  }, [canSeeCustomers, canSeeCatalog, canSeeSalesOrders]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  function openNew() {
    setDialogError(null);
    setForm(EMPTY_FORM);
    setItems([blankDocItem()]);
    setDialogOpen(true);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      await api.post('/invoices', { customerId: form.customerId, items, dueDate: form.dueDate, poReference: form.poReference, currency: form.currency || undefined });
      setToast('Invoice created.');
      setDialogOpen(false);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function createFromOrder(e) {
    e.preventDefault();
    if (!orderId) return;
    setOrderBusy(true);
    setError(null);
    try {
      const inv = await api.post('/invoices/from-order', { salesOrderId: orderId });
      setToast(inv.invoiceNo + ' issued for the order.');
      setOrderId('');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setOrderBusy(false);
    }
  }

  async function voidInvoice(inv) {
    setBusyId(inv.id);
    setError(null);
    try {
      await api.post('/invoices/' + inv.id + '/void', {});
      setToast(inv.invoiceNo + ' voided.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete() {
    setDeleting(true);
    try {
      await api.del('/invoices/' + deleteTarget.id);
      setToast(deleteTarget.invoiceNo + ' deleted.');
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  function openPay(inv) {
    setPayError(null);
    setPayTarget(inv);
    setPayForm({ ...EMPTY_PAY, amount: inv.balanceDue });
  }

  async function submitPayment(e) {
    e.preventDefault();
    setPaying(true);
    setPayError(null);
    try {
      const r = await api.post('/invoices/' + payTarget.id + '/payments', payForm);
      setToast('Payment recorded — receipt ' + r.receipt.receiptNo + ' generated.');
      setPayTarget(null);
      await load();
    } catch (err) {
      setPayError(err.message);
    } finally {
      setPaying(false);
    }
  }

  function openEdit(inv) {
    setEditError(null);
    setEditTarget(inv);
    setEditForm({ dueDate: inv.dueDate, poReference: inv.poReference || '' });
  }

  async function submitEdit(e) {
    e.preventDefault();
    setEditSaving(true);
    setEditError(null);
    try {
      const updated = await api.patch('/invoices/' + editTarget.id, editForm);
      setToast(updated.invoiceNo + ' updated.');
      setEditTarget(null);
      await load();
    } catch (err) {
      setEditError(err.message);
    } finally {
      setEditSaving(false);
    }
  }

  function openPreview(inv) {
    const cust = customers.find((c) => c.id === inv.customerId) || {};
    setPreviewInv({ ...inv, customerName: cust.name || inv.customerName, customerEmail: cust.email || '' });
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const visibleInvoices = invoices.filter((inv) => matchesQuery(search, inv.invoiceNo, inv.customerName));

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="invoices-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search invoices…" />
        {canOpenManual && <button type="button" className="btn btn-primary" onClick={openNew}>New manual invoice</button>}
      </div>

      {canManage && canSeeSalesOrders && (
        <form className="invoices-order-form" onSubmit={createFromOrder}>
          <div className="field">
            <label htmlFor="iv-order">Issue invoice for a sales order</label>
            <select id="iv-order" className="input" value={orderId} onChange={(e) => setOrderId(e.target.value)}>
              <option value="">Choose a sales order</option>
              {orders.map((o) => <option key={o.id} value={o.id}>{o.orderNo} — {o.customerName}</option>)}
            </select>
          </div>
          <button className="btn btn-primary" type="submit" disabled={!orderId || orderBusy}>Issue invoice</button>
        </form>
      )}

      <table className="table">
        <thead>
          <tr><th>Invoice</th><th>Customer</th><th>Total</th><th>Paid</th><th>Balance</th><th>Due</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
          {visibleInvoices.map((inv) => {
            const canRecordPayment = inv.status !== 'paid' && inv.status !== 'void';
            const canVoid = inv.status === 'unpaid' && canManage;
            const canDelete = inv.status === 'unpaid' && canManage;
            return (
              <tr key={inv.id}>
                <td>
                  <div className="invoices-no-cell">
                    <span className={'invoices-badge invoices-badge-' + statusTone(invoiceBucket(inv))}><DocIcon /></span>
                    <span style={{ fontWeight: 600 }}>{inv.invoiceNo}</span>
                  </div>
                </td>
                <td>{inv.customerName}</td>
                <td>{money(inv.grandTotal, inv.currency)}</td>
                <td>{money(inv.amountPaid, inv.currency)}</td>
                <td style={{ fontWeight: 600 }}>{money(inv.balanceDue, inv.currency)}</td>
                <td>{fmtDate(inv.dueDate)}</td>
                <td><span className={'tag ' + invoiceTagClass(inv)}>{inv.overdue ? 'overdue' : inv.status}</span></td>
                <td className="table-actions">
                  <button type="button" className="btn btn-secondary invoices-row-btn" disabled={busyId === inv.id} onClick={() => openPreview(inv)}>Preview</button>
                  {canRecordPayment && canManage && <button type="button" className="btn btn-secondary invoices-row-btn" disabled={busyId === inv.id} onClick={() => openPay(inv)}>Record payment</button>}
                  {canManage && <button type="button" className="btn btn-secondary invoices-row-btn" disabled={busyId === inv.id} onClick={() => openEdit(inv)}>Edit</button>}
                  {canVoid && <button type="button" className="btn btn-secondary invoices-row-btn" disabled={busyId === inv.id} onClick={() => voidInvoice(inv)}>Void</button>}
                  {canDelete && <button type="button" className="btn btn-secondary invoices-row-btn" disabled={busyId === inv.id} onClick={() => setDeleteTarget(inv)}>Delete</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!invoices.length && (
        <div className="invoices-empty-state">
          <span className="invoices-empty-icon"><DocIcon /></span>
          <p className="invoices-empty-title">No invoices yet</p>
        </div>
      )}
      {!!invoices.length && !visibleInvoices.length && (
        <div className="invoices-empty-state">
          <span className="invoices-empty-icon"><DocIcon /></span>
          <p className="invoices-empty-title">No invoices match "{search}"</p>
        </div>
      )}

      {dialogOpen && (
        <div className="dialog-backdrop" onClick={() => setDialogOpen(false)}>
          <form className="dialog invoices-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2 className="invoices-dialog-title">New manual invoice</h2>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="invoices-dialog-fields">
              <div className="field">
                <label htmlFor="iv-customer">Customer</label>
                <select id="iv-customer" className="input" value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })} required>
                  <option value="">Choose a customer</option>
                  {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="iv-currency">Currency</label>
                <select id="iv-currency" className="input" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                  <option value="">Customer's default</option>
                  {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="iv-due">Due date</label>
                <input id="iv-due" className="input" type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="iv-po">PO / reference</label>
                <input id="iv-po" className="input" value={form.poReference} onChange={(e) => setForm({ ...form, poReference: e.target.value })} />
              </div>
            </div>
            <DocItemsEditor
              items={items} onChange={setItems} catalogOptions={catalog}
              currency={form.currency || (customers.find((c) => c.id === form.customerId) || {}).preferredCurrency || 'GHS'}
            />
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>Create invoice</button>
            </div>
          </form>
        </div>
      )}

      {payTarget && (
        <div className="dialog-backdrop" onClick={() => setPayTarget(null)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitPayment}>
            <h2>Record payment</h2>
            <p className="dialog-body">Outstanding balance: {money(payTarget.balanceDue, payTarget.currency)}</p>
            {payError && <div className="error-banner">{payError}</div>}
            <div className="field">
              <label htmlFor="pay-amount">Amount ({payTarget.currency})</label>
              <input id="pay-amount" className="input" type="number" value={payForm.amount} onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })} />
            </div>
            <div className="invoices-pay-grid">
              <div className="field">
                <label htmlFor="pay-method">Method</label>
                <select id="pay-method" className="input" value={payForm.method} onChange={(e) => setPayForm({ ...payForm, method: e.target.value })}>
                  <option value="cash">Cash</option><option value="bank_transfer">Bank transfer</option><option value="mobile_money">Mobile Money</option><option value="card">Card</option><option value="cheque">Cheque</option><option value="other">Other</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="pay-date">Date</label>
                <input id="pay-date" className="input" type="date" value={payForm.date} onChange={(e) => setPayForm({ ...payForm, date: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="pay-ref">Transaction / reference</label>
              <input id="pay-ref" className="input" value={payForm.reference} onChange={(e) => setPayForm({ ...payForm, reference: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="pay-notes">Notes</label>
              <input id="pay-notes" className="input" value={payForm.notes} onChange={(e) => setPayForm({ ...payForm, notes: e.target.value })} />
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setPayTarget(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={paying}>Record payment</button>
            </div>
          </form>
        </div>
      )}

      {editTarget && (
        <div className="dialog-backdrop" onClick={() => setEditTarget(null)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitEdit}>
            <h2>Edit invoice</h2>
            {editError && <div className="error-banner">{editError}</div>}
            <div className="field">
              <label htmlFor="ivedit-due">Due date</label>
              <input id="ivedit-due" className="input" type="date" value={editForm.dueDate} onChange={(e) => setEditForm({ ...editForm, dueDate: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="ivedit-po">PO / reference</label>
              <input id="ivedit-po" className="input" value={editForm.poReference} onChange={(e) => setEditForm({ ...editForm, poReference: e.target.value })} />
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setEditTarget(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={editSaving}>Save changes</button>
            </div>
          </form>
        </div>
      )}

      {deleteTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Delete {deleteTarget.invoiceNo}</h2>
            <p className="dialog-body">This cannot be undone.</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={confirmDelete}>{deleting ? 'Deleting…' : 'Delete'}</button>
            </div>
          </div>
        </div>
      )}

      {previewInv && (
        <DocPreview
          docLabel={'Invoice #' + previewInv.invoiceNo}
          dateLabel="Issue date"
          dateValue={fmtDate(previewInv.issuedAt)}
          heading={'Invoice for ' + previewInv.customerName}
          subHeading={'Due ' + fmtDate(previewInv.dueDate)}
          blocks={[
            { title: 'Customer', lines: [previewInv.customerName, previewInv.customerEmail] },
            { title: 'Invoice Details', lines: ['Issued ' + fmtDate(previewInv.issuedAt), money(previewInv.grandTotal, previewInv.currency)] },
            { title: 'Payment', lines: ['Due ' + fmtDate(previewInv.dueDate), money(previewInv.balanceDue, previewInv.currency)] }
          ]}
          items={previewInv.items.map((i) => ({ description: i.description, qty: i.qty, unitPrice: money(i.unitPrice, previewInv.currency), lineTotal: money(Math.max(0, i.qty * i.unitPrice - (i.discountType === 'percent' ? (i.qty * i.unitPrice * (i.discount || 0)) / 100 : i.discount || 0)), previewInv.currency) }))}
          subtotal={money(previewInv.subtotal, previewInv.currency)}
          isPartial={previewInv.amountPaid > 0 && previewInv.balanceDue > 0}
          amountPaid={money(previewInv.amountPaid, previewInv.currency)}
          totalLabel="Total Due"
          total={money(previewInv.balanceDue, previewInv.currency)}
          notesLabel="Payment instructions"
          notesValue={previewInv.bankInstructions}
          onClose={() => setPreviewInv(null)}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
