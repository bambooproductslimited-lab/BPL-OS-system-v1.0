import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import DocItemsEditor, { blankDocItem } from '../components/DocItemsEditor';
import DocPreview from '../components/DocPreview';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { money } from '../lib/currency';
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
//
// Redesigned around the icon language established elsewhere: a
// status-toned document badge per row (mirrors Documents' file-type
// tone-mix treatment), an icon'd empty state. The new-quotation dialog
// and printed preview are untouched.

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

function quoteBucket(status) {
  return status === 'accepted' ? 'approved' : (status === 'rejected' || status === 'expired' || status === 'cancelled') ? 'rejected' : 'pending';
}
function quoteTagClass(status) { return docTagClass(quoteBucket(status)); }

const EMPTY_FORM = { customerId: '', title: '', validUntil: '', notes: '', currency: '' };

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
    // Best-effort: the currency picker falls back to just GHS if this
    // fails (e.g. a role without employee.read, which /settings requires
    // since it also carries integration API keys) rather than blocking the
    // whole page over a field that only matters inside the dialog.
    try {
      const settings = await api.get('/settings');
      if (settings.commercial && settings.commercial.currencies) setCurrencies(settings.commercial.currencies);
    } catch (err) { /* ignore */ }
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
      await api.post('/quotations', { customerId: form.customerId, title: form.title, items, validUntil: form.validUntil, notes: form.notes, currency: form.currency || undefined });
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
                <td>
                  <div className="quotations-no-cell">
                    <span className={'quotations-badge quotations-badge-' + statusTone(quoteBucket(q.status))}><DocIcon /></span>
                    <span style={{ fontWeight: 600 }}>{q.quoteNo}</span>
                  </div>
                </td>
                <td>{q.customerName}</td>
                <td className="quotations-items-line">{q.items.map((i) => i.description + ' × ' + i.qty).join(', ')}</td>
                <td>{money(q.grandTotal, q.currency)}</td>
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
      {!quotations.length && (
        <div className="quotations-empty-state">
          <span className="quotations-empty-icon"><DocIcon /></span>
          <p className="quotations-empty-title">No quotations yet</p>
        </div>
      )}
      {!!quotations.length && !visibleQuotations.length && (
        <div className="quotations-empty-state">
          <span className="quotations-empty-icon"><DocIcon /></span>
          <p className="quotations-empty-title">No quotations match "{search}"</p>
        </div>
      )}

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
                <label htmlFor="q-currency">Currency</label>
                <select id="q-currency" className="input" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                  <option value="">Customer's default</option>
                  {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="q-valid">Valid until</label>
                <input id="q-valid" className="input" type="date" value={form.validUntil} onChange={(e) => setForm({ ...form, validUntil: e.target.value })} />
              </div>
            </div>
            <DocItemsEditor
              items={items} onChange={setItems} catalogOptions={catalog}
              currency={form.currency || (customers.find((c) => c.id === form.customerId) || {}).preferredCurrency || 'GHS'}
            />
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
            { title: 'Quotation Details', lines: ['Created ' + fmtDate(previewQ.createdAt), money(previewQ.grandTotal, previewQ.currency)] },
            { title: 'Validity', lines: ['Valid until ' + fmtDate(previewQ.validUntil), money(previewQ.grandTotal, previewQ.currency)] }
          ]}
          items={previewQ.items.map((i) => ({ description: i.description, qty: i.qty, unitPrice: money(i.unitPrice, previewQ.currency), lineTotal: money(Math.max(0, i.qty * i.unitPrice - (i.discountType === 'percent' ? (i.qty * i.unitPrice * (i.discount || 0)) / 100 : i.discount || 0)), previewQ.currency) }))}
          subtotal={money(previewQ.subtotal, previewQ.currency)}
          totalLabel="Grand Total"
          total={money(previewQ.grandTotal, previewQ.currency)}
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
