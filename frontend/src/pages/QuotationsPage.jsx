import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import DocItemsEditor, { blankDocItem } from '../components/DocItemsEditor';
import DocPreview from '../components/DocPreview';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import './QuotationsPage.css';

// Ported from Bamboo OS.dc.html's quotations screen (screens.quotations
// block, dialog.quotation / dialog.quotationPreview, and the quotations
// computed values). There is no edit/delete for quotations, in the
// prototype or the backend (quotations.service.js only exports
// list/create/setStatus) — once created, a quotation only moves through
// its status lifecycle or gets converted to an invoice.
//
// Same customer.read dependency as EstimatesPage: "New quotation" is gated
// on customer.read in addition to quotation.manage, since the dialog can't
// function without a customer list.

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

function quoteTagClass(status) {
  return docTagClass(status === 'accepted' ? 'approved' : (status === 'rejected' || status === 'expired' || status === 'cancelled') ? 'rejected' : 'pending');
}

const EMPTY_FORM = { customerId: '', title: '', validUntil: '', notes: '' };

export default function QuotationsPage() {
  const { can } = useAuth();
  const canManage = can('quotation.manage');
  const canInvoice = can('invoice.manage');
  const canSeeCustomers = can('customer.read');
  const canSeeCatalog = can('catalog.read');
  const canOpenNew = canManage && canSeeCustomers;

  const [quotations, setQuotations] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [items, setItems] = useState([blankDocItem()]);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [previewQ, setPreviewQ] = useState(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [qs, cust, cat] = await Promise.all([
        api.get('/quotations'),
        canSeeCustomers ? api.get('/customers') : Promise.resolve([]),
        canSeeCatalog ? api.get('/catalog') : Promise.resolve([])
      ]);
      setQuotations(qs);
      setCustomers(cust);
      setCatalog(cat);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [canSeeCustomers, canSeeCatalog]);

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
      await api.post('/quotations', { customerId: form.customerId, title: form.title, items, validUntil: form.validUntil, notes: form.notes });
      setToast('Quotation created.');
      setDialogOpen(false);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(q, status) {
    setBusyId(q.id);
    setError(null);
    try {
      await api.post('/quotations/' + q.id + '/status', { status });
      setToast(q.quoteNo + ' set to ' + status + '.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function convertToInvoice(q) {
    setBusyId(q.id);
    setError(null);
    try {
      const inv = await api.post('/invoices/from-quotation', { quotationId: q.id });
      setToast(inv.invoiceNo + ' issued from quotation.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  function openPreview(q) {
    const cust = customers.find((c) => c.id === q.customerId) || {};
    setPreviewQ({ ...q, customerName: cust.name || q.customerName, customerEmail: cust.email || '' });
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const visibleQuotations = quotations.filter((q) => matchesQuery(search, q.quoteNo, q.customerName, q.title));

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="quotations-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search quotations…" />
        {canOpenNew && <button type="button" className="btn btn-primary" onClick={openNew}>New quotation</button>}
      </div>

      <table className="table">
        <thead>
          <tr><th>Quote</th><th>Customer</th><th>Items</th><th>Total</th><th>Valid until</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
          {visibleQuotations.map((q) => {
            const canSend = q.status === 'draft' && canManage;
            const canAccept = (q.status === 'sent' || q.status === 'viewed') && canManage;
            const canReject = (q.status === 'sent' || q.status === 'draft' || q.status === 'viewed') && canManage;
            const canDoInvoice = q.status === 'accepted' && canInvoice;
            return (
              <tr key={q.id}>
                <td style={{ fontWeight: 600 }}>{q.quoteNo}</td>
                <td>{q.customerName}</td>
                <td className="quotations-items-line">{q.items.map((i) => i.description + ' × ' + i.qty).join(', ')}</td>
                <td>GHS {q.grandTotal.toLocaleString()}</td>
                <td>{fmtDate(q.validUntil)}</td>
                <td><span className={'tag ' + quoteTagClass(q.status)}>{q.status}</span></td>
                <td className="table-actions">
                  <button type="button" className="btn btn-secondary quotations-row-btn" disabled={busyId === q.id} onClick={() => openPreview(q)}>Preview</button>
                  {canSend && <button type="button" className="btn btn-secondary quotations-row-btn" disabled={busyId === q.id} onClick={() => setStatus(q, 'sent')}>Send</button>}
                  {canAccept && <button type="button" className="btn btn-secondary quotations-row-btn" disabled={busyId === q.id} onClick={() => setStatus(q, 'accepted')}>Accept</button>}
                  {canReject && <button type="button" className="btn btn-secondary quotations-row-btn" disabled={busyId === q.id} onClick={() => setStatus(q, 'rejected')}>Reject</button>}
                  {canDoInvoice && <button type="button" className="btn btn-secondary quotations-row-btn" disabled={busyId === q.id} onClick={() => convertToInvoice(q)}>Convert to invoice</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!quotations.length && <p className="table-empty">No quotations yet.</p>}
      {!!quotations.length && !visibleQuotations.length && <p className="table-empty">No quotations match "{search}".</p>}

      {dialogOpen && (
        <div className="dialog-backdrop" onClick={() => setDialogOpen(false)}>
          <form className="dialog quotations-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2 className="quotations-dialog-title">New quotation</h2>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="quotations-dialog-fields">
              <div className="field">
                <label htmlFor="q-customer">Customer</label>
                <select id="q-customer" className="input" value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })} required>
                  <option value="">Choose a customer</option>
                  {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="q-title">Title</label>
                <input id="q-title" className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Quotation for ..." />
              </div>
              <div className="field">
                <label htmlFor="q-valid">Valid until</label>
                <input id="q-valid" className="input" type="date" value={form.validUntil} onChange={(e) => setForm({ ...form, validUntil: e.target.value })} />
              </div>
            </div>
            <DocItemsEditor items={items} onChange={setItems} catalogOptions={catalog} />
            <div className="field">
              <label htmlFor="q-notes">Notes to client</label>
              <textarea id="q-notes" className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>Create quotation</button>
            </div>
          </form>
        </div>
      )}

      {previewQ && (
        <DocPreview
          docLabel={'Quotation #' + previewQ.quoteNo}
          dateLabel="Issue date"
          dateValue={fmtDate(previewQ.createdAt)}
          heading={previewQ.title || ('Quotation for ' + previewQ.customerName)}
          subHeading={'Valid until ' + fmtDate(previewQ.validUntil)}
          blocks={[
            { title: 'Customer', lines: [previewQ.customerName, previewQ.customerEmail] },
            { title: 'Quotation Details', lines: ['Created ' + fmtDate(previewQ.createdAt), 'GHS ' + previewQ.grandTotal.toLocaleString()] },
            { title: 'Validity', lines: ['Valid until ' + fmtDate(previewQ.validUntil), 'GHS ' + previewQ.grandTotal.toLocaleString()] }
          ]}
          items={previewQ.items.map((i) => ({ description: i.description, qty: i.qty, unitPrice: 'GHS ' + i.unitPrice.toLocaleString(), lineTotal: 'GHS ' + Math.max(0, i.qty * i.unitPrice - (i.discountType === 'percent' ? (i.qty * i.unitPrice * (i.discount || 0)) / 100 : i.discount || 0)).toLocaleString() }))}
          subtotal={'GHS ' + previewQ.subtotal.toLocaleString()}
          totalLabel="Grand Total"
          total={'GHS ' + previewQ.grandTotal.toLocaleString()}
          notesLabel="Notes"
          notesValue={previewQ.notes}
          termsLabel="Terms & conditions"
          termsValue={previewQ.terms}
          onClose={() => setPreviewQ(null)}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
