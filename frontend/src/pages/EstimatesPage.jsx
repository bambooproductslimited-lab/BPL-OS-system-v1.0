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
import { tr } from '../lib/i18n.jsx';
import './EstimatesPage.css';

// Ported from Bamboo OS.dc.html's estimates screen (screens.estimates block,
// dialog.estimate / dialog.estimateEdit / dialog.estimatePreview, and the
// estimates computed values around its render()).
//
// Deliberate deviation: the prototype's `canFinalize` (Finalize button) has
// no permission check at all, unlike every sibling action on the same row
// (canConvert/canEdit/canDelete all check can('quotation.manage')). Gated it
// the same way here for consistency with this app's pattern and the
// backend's actual enforcement (estimates.setStatus requires
// quotation.manage) — literal fidelity would show a Finalize button to
// quotation.read-only viewers that always 403s on click.
//
// Second deviation, same shape as CatalogPage's tax-rate gap: creating an
// estimate requires picking a customer, but nothing guarantees a
// quotation.manage holder also has customer.read (this app's seed data
// happens to always pair them, but the code shouldn't assume that). "New
// estimate" is gated on customer.read too so the dialog is never opened in
// a state where the customer picker has no way to be populated.
//
// Redesigned around the icon language established elsewhere: a
// status-toned document badge per row (mirrors Documents' file-type
// tone-mix treatment), an icon'd empty state. The new/edit dialog and
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

function estimateBucket(status) {
  return status === 'converted' ? 'approved' : status === 'archived' ? 'rejected' : 'pending';
}
function estimateTagClass(status) { return docTagClass(estimateBucket(status)); }

const EMPTY_FORM = { customerId: '', validUntil: '', internalNotes: '', clientNotes: '', currency: '' };

export default function EstimatesPage() {
  const { can } = useAuth();
  const canManage = can('quotation.manage');
  const canSeeCustomers = can('customer.read');
  const canSeeCatalog = can('catalog.read');
  const canOpenNew = canManage && canSeeCustomers;

  const [estimates, setEstimates] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [currencies, setCurrencies] = useState(['GHS']);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [items, setItems] = useState([blankDocItem()]);
  const [docDiscount, setDocDiscount] = useState({ value: 0, type: 'fixed' });
  const [docTaxRate, setDocTaxRate] = useState(0);
  const [paymentSchedule, setPaymentSchedule] = useState([]);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [detail, setDetail] = useState(null);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [previewEs, setPreviewEs] = useState(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [es, cust, cat] = await Promise.all([
        api.get('/estimates'),
        canSeeCustomers ? api.get('/customers') : Promise.resolve([]),
        canSeeCatalog ? api.get('/catalog') : Promise.resolve([])
      ]);
      setEstimates(es);
      setCustomers(cust);
      setCatalog(cat);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
    try {
      const settings = await api.get('/settings');
      if (settings.commercial && settings.commercial.currencies) setCurrencies(settings.commercial.currencies);
    } catch (err) { /* ignore — falls back to GHS only, see QuotationsPage's identical comment */ }
  }, [canSeeCustomers, canSeeCatalog]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  function openNew() {
    setDialogError(null);
    setEditId(null);
    setForm(EMPTY_FORM);
    setItems([blankDocItem()]);
    setDocDiscount({ value: 0, type: 'fixed' });
    setDocTaxRate(0);
    setPaymentSchedule([]);
    setDialogOpen(true);
  }

  function openEdit(es) {
    setDialogError(null);
    setEditId(es.id);
    setForm({ customerId: es.customerId, validUntil: es.validUntil, internalNotes: es.internalNotes || '', clientNotes: es.clientNotes || '', currency: es.currency || '' });
    setItems(es.items.map((it) => ({ ...it })));
    setDocDiscount(es.discount || { value: 0, type: 'fixed' });
    setDocTaxRate(es.taxRate || 0);
    setPaymentSchedule((es.paymentSchedule || []).map((r) => ({ label: r.label, type: r.type, value: r.value, dueDate: r.dueDate || '' })));
    setDialogOpen(true);
  }

  async function handleSubmit() {
    setSaving(true);
    setDialogError(null);
    try {
      const payload = {
        customerId: form.customerId, items, validUntil: form.validUntil, internalNotes: form.internalNotes, clientNotes: form.clientNotes,
        currency: form.currency || undefined, discount: docDiscount, taxRate: docTaxRate, paymentSchedule
      };
      if (editId) await api.put('/estimates/' + editId, payload);
      else await api.post('/estimates', payload);
      setToast(editId ? 'Estimate updated.' : 'Estimate created.');
      setDialogOpen(false);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function finalize(es) {
    setBusyId(es.id);
    setError(null);
    try {
      await api.post('/estimates/' + es.id + '/status', { status: 'finalized' });
      setToast(es.estimateNo + ' finalized.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function convert(es) {
    setBusyId(es.id);
    setError(null);
    try {
      const q = await api.post('/estimates/' + es.id + '/convert', {});
      setToast(q.quoteNo + ' created from estimate.');
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
      await api.del('/estimates/' + deleteTarget.id);
      setToast(deleteTarget.estimateNo + ' deleted.');
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  function openPreview(es) {
    const cust = customers.find((c) => c.id === es.customerId) || {};
    setPreviewEs({ ...es, customerName: cust.name || es.customerName, customerEmail: cust.email || '' });
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  const visibleEstimates = estimates.filter((es) => matchesQuery(search, es.estimateNo, es.customerName));

  // Shared by the row menu and the record panel so the two cannot drift.
  function rowActions(es) {
    return [
      { label: 'Preview', onClick: () => openPreview(es) },
      { label: 'Finalize', onClick: () => finalize(es), hidden: !(es.status === 'draft' && canManage) },
      { label: 'Convert to quotation', onClick: () => convert(es), hidden: !(es.status === 'finalized' && canManage) },
      { label: 'Edit', onClick: () => openEdit(es), hidden: !(es.status === 'draft' && canManage) },
      { label: 'Delete', onClick: () => setDeleteTarget(es), danger: true, hidden: !(es.status !== 'converted' && canManage) },
    ];
  }

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="estimates-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder={tr('Search estimates…')} />
        {canOpenNew && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('New estimate')}</button>}
      </div>

      <table className="table table-clickable">
        <thead>
          <tr><th>{tr('Estimate')}</th><th>{tr('Customer')}</th><th className="col-wide">{tr('Items')}</th><th>{tr('Total')}</th><th className="col-mid">{tr('Valid until')}</th><th>{tr('Status')}</th><th></th></tr>
        </thead>
        <tbody>
          {visibleEstimates.map((es) => {
            return (
              <tr
                key={es.id}
                tabIndex={0}
                onClick={() => setDetail(es)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetail(es); } }}
              >
                <td>
                  <div className="estimates-no-cell">
                    <span className={'estimates-badge estimates-badge-' + statusTone(estimateBucket(es.status))}><DocIcon /></span>
                    <span style={{ fontWeight: 600 }}>{es.estimateNo}</span>
                  </div>
                </td>
                <td>{es.customerName}</td>
                <td className="estimates-items-line col-wide">{es.items.map((i) => i.description + ' × ' + i.qty).join(', ')}</td>
                <td>{money(es.grandTotal, es.currency)}</td>
                <td className="col-mid">{fmtDate(es.validUntil)}</td>
                <td><span className={'tag ' + estimateTagClass(es.status)}>{es.status}</span></td>
                <td className="table-actions" onClick={(e) => e.stopPropagation()}>
                  <RowMenu disabled={busyId === es.id} actions={rowActions(es)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!estimates.length && (
        <div className="estimates-empty-state">
          <span className="estimates-empty-icon"><DocIcon /></span>
          <p className="estimates-empty-title">{tr('No estimates yet')}</p>
        </div>
      )}
      {!!estimates.length && !visibleEstimates.length && (
        <div className="estimates-empty-state">
          <span className="estimates-empty-icon"><DocIcon /></span>
          <p className="estimates-empty-title">{tr('No estimates match "')}{search}"</p>
        </div>
      )}

      {dialogOpen && (
        <DocWizard
          title={editId ? 'Edit estimate' : 'New estimate'} docKind="estimate"
          detailsSlot={
            <div className="estimates-dialog-fields">
              <div className="field">
                <label htmlFor="es-customer">{tr('Customer')}</label>
                <CustomerPicker id="es-customer" customers={customers} value={form.customerId} onChange={(id) => setForm({ ...form, customerId: id })} required />
              </div>
              <div className="field">
                <label htmlFor="es-currency">{tr('Currency')}</label>
                <select id="es-currency" className="input" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                  <option value="">{tr('Customer\'s default')}</option>
                  {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="es-valid">{tr('Valid until')}</label>
                <input id="es-valid" className="input" type="date" value={form.validUntil} onChange={(e) => setForm({ ...form, validUntil: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="es-internal">{tr('Internal notes')}</label>
                <textarea id="es-internal" className="input" value={form.internalNotes} onChange={(e) => setForm({ ...form, internalNotes: e.target.value })} placeholder={tr('Not shown to the customer')} />
              </div>
            </div>
          }
          message={form.clientNotes} onMessageChange={(v) => setForm({ ...form, clientNotes: v })} messageLabel="Message to customer"
          items={items} onItemsChange={setItems} catalogOptions={catalog}
          currency={form.currency || (customers.find((c) => c.id === form.customerId) || {}).preferredCurrency || 'GHS'}
          docDiscount={docDiscount} onDocDiscountChange={setDocDiscount}
          docTaxRate={docTaxRate} onDocTaxRateChange={setDocTaxRate}
          paymentSchedule={paymentSchedule} onPaymentScheduleChange={setPaymentSchedule}
          recapBlocks={[
            { label: 'Customer', value: (customers.find((c) => c.id === form.customerId) || {}).name || '—' },
            { label: 'Valid until', value: fmtDate(form.validUntil) }
          ]}
          submitLabel={editId ? 'Save changes' : 'Create estimate'} saving={saving} error={dialogError}
          onSubmit={handleSubmit} onClose={() => setDialogOpen(false)}
        />
      )}

      {deleteTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Delete')} {deleteTarget.estimateNo}</h2>
            <p className="dialog-body">{tr('This cannot be undone.')}</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={confirmDelete}>{deleting ? 'Deleting…' : 'Delete'}</button>
            </div>
          </div>
        </div>
      )}

      {detail && (
        <RecordDialog
          title={detail.estimateNo}
          subtitle={detail.customerName}
          tag={<span className={'tag ' + estimateTagClass(detail.status)}>{detail.status}</span>}
          actions={rowActions(detail)}
          onClose={() => setDetail(null)}
          items={itemsForDialog(detail.items, detail.currency)}
          totals={totalsForDialog(detail, detail.currency)}
          fields={[
            { label: 'Valid until', value: fmtDate(detail.validUntil) },
            { label: 'Currency', value: detail.currency },
            { label: 'Title', value: detail.title, wide: true },
            { label: 'Notes', value: detail.notes, wide: true },
            { label: 'Terms', value: detail.terms, wide: true },
          ]}
        />
      )}

      {previewEs && (
        <DocPreview
          documentType="estimate" documentId={previewEs.id}
          docLabel={'Estimate #' + previewEs.estimateNo}
          dateLabel="Issue date"
          dateValue={fmtDate(previewEs.createdAt)}
          heading={'Estimate for ' + previewEs.customerName}
          subHeading={'Valid until ' + fmtDate(previewEs.validUntil)}
          blocks={[
            { title: 'Customer', lines: [previewEs.customerName, previewEs.customerEmail] },
            { title: 'Estimate Details', lines: ['Created ' + fmtDate(previewEs.createdAt), money(previewEs.grandTotal, previewEs.currency)] },
            { title: 'Validity', lines: ['Valid until ' + fmtDate(previewEs.validUntil), money(previewEs.grandTotal, previewEs.currency)] }
          ]}
          items={groupPackageItems(previewEs.items, previewEs.currency)}
          subtotal={money(previewEs.subtotal, previewEs.currency)}
          discountRows={adjustmentRows(previewEs, previewEs.currency).discountRows}
          taxRows={adjustmentRows(previewEs, previewEs.currency).taxRows}
          totalLabel="Grand Total"
          total={money(previewEs.grandTotal, previewEs.currency)}
          notesLabel="Notes"
          notesValue={previewEs.clientNotes}
          termsLabel="Terms & conditions"
          termsValue={previewEs.terms}
          paymentSchedule={formatPaymentSchedule(previewEs.paymentSchedule, previewEs.currency)}
          onClose={() => setPreviewEs(null)}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
