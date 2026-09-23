import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { blankDocItem } from '../components/DocItemsEditor';
import DocWizard from '../components/DocWizard';
import CustomerPicker from '../components/CustomerPicker';
import DocPreview from '../components/DocPreview';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import RowMenu from '../components/RowMenu';
import RecordDialog from '../components/RecordDialog';
import { itemsForDialog, totalsForDialog, adjustmentRows } from '../lib/docItems';
import { money } from '../lib/currency';
import { groupPackageItems } from '../lib/packages';
import { formatPaymentSchedule } from '../lib/paymentSchedule';
import { tr, activeIntlLocale, docTr } from '../lib/i18n.jsx';
import { formatDocDate } from '../lib/dates';
import './QuotationsPage.css';
import { codeLabel } from '../lib/codeLabels.js';

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
  return d.toLocaleDateString(activeIntlLocale(), { day: '2-digit', month: 'short', year: 'numeric' });
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

const QUOTATION_STATUS_OPTIONS = ['draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired', 'cancelled'];
function quoteStatusLabel(s) {
  return codeLabel(s);
}

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
  const [docDiscount, setDocDiscount] = useState({ value: 0, type: 'fixed' });
  const [docTaxRate, setDocTaxRate] = useState(0);
  const [paymentSchedule, setPaymentSchedule] = useState([]);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [previewQ, setPreviewQ] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

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
    setDocDiscount({ value: 0, type: 'fixed' });
    setDocTaxRate(0);
    setPaymentSchedule([]);
    setDialogOpen(true);
  }

  async function handleSubmit() {
    setSaving(true);
    setDialogError(null);
    try {
      await api.post('/quotations', {
        customerId: form.customerId, title: form.title, items, validUntil: form.validUntil, notes: form.notes,
        currency: form.currency || undefined, discount: docDiscount, taxRate: docTaxRate, paymentSchedule
      });
      setToast(tr('Quotation created.'));
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
      setToast(tr('{quoteNo} set to {status}.', { quoteNo: q.quoteNo, status: codeLabel(status) }));
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
      setToast(tr('{invoiceNo} issued from quotation.', { invoiceNo: inv.invoiceNo }));
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

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  const visibleQuotations = quotations.filter((q) =>
    matchesQuery(search, q.quoteNo, q.customerName, q.title) && (!statusFilter || q.status === statusFilter)
  );

  // One list of what can be done to a quotation, shared by the row menu and
  // the record panel so the two cannot drift apart.
  function rowActions(q) {
    return [
      { label: tr('Preview'), onClick: () => openPreview(q) },
      { label: tr('Send'), onClick: () => setStatus(q, 'sent'), hidden: !(q.status === 'draft' && canManage) },
      { label: tr('Accept'), onClick: () => setStatus(q, 'accepted'), hidden: !((q.status === 'sent' || q.status === 'viewed') && canManage) },
      { label: tr('Reject'), onClick: () => setStatus(q, 'rejected'), danger: true, hidden: !((q.status === 'sent' || q.status === 'draft' || q.status === 'viewed') && canManage) },
      { label: tr('Convert to invoice'), onClick: () => convertToInvoice(q), hidden: !(q.status === 'accepted' && canInvoice) },
    ];
  }

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="quotations-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder={tr('Search quotations…')} />
        <select className="input quotations-status-filter" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label={tr('Filter by status')}>
          <option value="">{tr('All statuses')}</option>
          {QUOTATION_STATUS_OPTIONS.map((s) => <option key={s} value={s}>{quoteStatusLabel(s)}</option>)}
        </select>
        {canOpenNew && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('New quotation')}</button>}
      </div>

      <table className="table table-clickable">
        <thead>
          <tr><th>{tr('Quote')}</th><th>{tr('Customer')}</th><th className="col-wide">{tr('Items')}</th><th>{tr('Total')}</th><th className="col-mid">{tr('Valid until')}</th><th>{tr('Status')}</th><th></th></tr>
        </thead>
        <tbody>
          {visibleQuotations.map((q) => {
            return (
              <tr
                key={q.id}
                tabIndex={0}
                onClick={() => setDetail(q)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetail(q); } }}
              >
                <td>
                  <div className="quotations-no-cell">
                    <span className={'quotations-badge quotations-badge-' + statusTone(quoteBucket(q.status))}><DocIcon /></span>
                    <span style={{ fontWeight: 600 }}>{q.quoteNo}</span>
                  </div>
                </td>
                <td>{q.customerName}</td>
                <td className="quotations-items-line col-wide">{q.items.map((i) => i.description + ' × ' + i.qty).join(', ')}</td>
                <td>{money(q.grandTotal, q.currency)}</td>
                <td className="col-mid">{fmtDate(q.validUntil)}</td>
                <td><span className={'tag ' + quoteTagClass(q.status)}>{quoteStatusLabel(q.status)}</span></td>
                <td className="table-actions" onClick={(e) => e.stopPropagation()}>
                  <RowMenu disabled={busyId === q.id} actions={rowActions(q)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!quotations.length && (
        <div className="quotations-empty-state">
          <span className="quotations-empty-icon"><DocIcon /></span>
          <p className="quotations-empty-title">{tr('No quotations yet')}</p>
        </div>
      )}
      {!!quotations.length && !visibleQuotations.length && (
        <div className="quotations-empty-state">
          <span className="quotations-empty-icon"><DocIcon /></span>
          <p className="quotations-empty-title">{search ? tr('No quotations match "{search}"', { search }) : tr('No quotations match this filter')}</p>
        </div>
      )}

      {dialogOpen && (
        <DocWizard
          title={tr('New quotation')} docKind="quotation"
          detailsSlot={
            <div className="quotations-dialog-fields">
              <div className="field">
                <label htmlFor="q-customer">{tr('Customer')}</label>
                <CustomerPicker id="q-customer" customers={customers} value={form.customerId} onChange={(id) => setForm({ ...form, customerId: id })} required />
              </div>
              <div className="field">
                <label htmlFor="q-title">{tr('Title')}</label>
                <input id="q-title" className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={tr('Quotation for ...')} />
              </div>
              <div className="field">
                <label htmlFor="q-currency">{tr('Currency')}</label>
                <select id="q-currency" className="input" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                  <option value="">{tr('Customer\'s default')}</option>
                  {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="q-valid">{tr('Valid until')}</label>
                <input id="q-valid" className="input" type="date" value={form.validUntil} onChange={(e) => setForm({ ...form, validUntil: e.target.value })} />
              </div>
            </div>
          }
          message={form.notes} onMessageChange={(v) => setForm({ ...form, notes: v })} messageLabel={tr('Message to customer')}
          items={items} onItemsChange={setItems} catalogOptions={catalog}
          currency={form.currency || (customers.find((c) => c.id === form.customerId) || {}).preferredCurrency || 'GHS'}
          docDiscount={docDiscount} onDocDiscountChange={setDocDiscount}
          docTaxRate={docTaxRate} onDocTaxRateChange={setDocTaxRate}
          paymentSchedule={paymentSchedule} onPaymentScheduleChange={setPaymentSchedule}
          recapBlocks={[
            { label: tr('Customer'), value: (customers.find((c) => c.id === form.customerId) || {}).name || '—' },
            { label: tr('Valid until'), value: fmtDate(form.validUntil) }
          ]}
          submitLabel={tr('Create quotation')} saving={saving} error={dialogError}
          onSubmit={handleSubmit} onClose={() => setDialogOpen(false)}
        />
      )}

      {detail && (
        <RecordDialog
          title={detail.quoteNo}
          subtitle={detail.customerName}
          tag={<span className={'tag ' + quoteTagClass(detail.status)}>{quoteStatusLabel(detail.status)}</span>}
          actions={rowActions(detail)}
          onClose={() => setDetail(null)}
          items={itemsForDialog(detail.items, detail.currency)}
          totals={totalsForDialog(detail, detail.currency)}
          fields={[
            { label: tr('Valid until'), value: fmtDate(detail.validUntil) },
            { label: tr('Created'), value: fmtDate(detail.createdAt) },
            { label: tr('Currency'), value: detail.currency },
            { label: tr('Title'), value: detail.title, wide: true },
            { label: tr('Notes'), value: detail.notes, wide: true },
            { label: tr('Terms'), value: detail.terms, wide: true },
          ]}
        />
      )}

      {previewQ && (
        <DocPreview
          documentType="quotation" documentId={previewQ.id}
          docLabel={docTr('Quotation #{quoteNo}', { quoteNo: previewQ.quoteNo })}
          dateLabel={docTr('Issue date')}
          dateValue={formatDocDate(previewQ.createdAt)}
          heading={previewQ.title || (docTr('Quotation for {customerName}', { customerName: previewQ.customerName }))}
          subHeading={docTr('Valid until {date}', { date: formatDocDate(previewQ.validUntil) })}
          blocks={[
            { title: docTr('Customer'), lines: [previewQ.customerName, previewQ.customerEmail] },
            { title: docTr('Quotation Details'), lines: [docTr('Created {date}', { date: formatDocDate(previewQ.createdAt) }), money(previewQ.grandTotal, previewQ.currency)] },
            { title: docTr('Validity'), lines: [docTr('Valid until {date}', { date: formatDocDate(previewQ.validUntil) }), money(previewQ.grandTotal, previewQ.currency)] }
          ]}
          items={groupPackageItems(previewQ.items, previewQ.currency)}
          subtotal={money(previewQ.subtotal, previewQ.currency)}
          discountRows={adjustmentRows(previewQ, previewQ.currency).discountRows}
          taxRows={adjustmentRows(previewQ, previewQ.currency).taxRows}
          totalLabel={docTr('Grand Total')}
          total={money(previewQ.grandTotal, previewQ.currency)}
          notesLabel={docTr('Notes')}
          notesValue={previewQ.notes}
          termsLabel={docTr('Terms & conditions')}
          termsValue={previewQ.terms}
          paymentSchedule={formatPaymentSchedule(previewQ.paymentSchedule, previewQ.currency)}
          onClose={() => setPreviewQ(null)}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
