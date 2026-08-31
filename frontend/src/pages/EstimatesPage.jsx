import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import DocItemsEditor, { blankDocItem } from '../components/DocItemsEditor';
import DocPreview from '../components/DocPreview';
import SearchInput, { matchesQuery } from '../components/SearchInput';
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

const EMPTY_FORM = { customerId: '', validUntil: '', internalNotes: '', clientNotes: '' };

export default function EstimatesPage() {
  const { can } = useAuth();
  const canManage = can('quotation.manage');
  const canSeeCustomers = can('customer.read');
  const canSeeCatalog = can('catalog.read');
  const canOpenNew = canManage && canSeeCustomers;

  const [estimates, setEstimates] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [items, setItems] = useState([blankDocItem()]);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);

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
    setDialogOpen(true);
  }

  function openEdit(es) {
    setDialogError(null);
    setEditId(es.id);
    setForm({ customerId: es.customerId, validUntil: es.validUntil, internalNotes: es.internalNotes || '', clientNotes: es.clientNotes || '' });
    setItems(es.items.map((it) => ({ ...it })));
    setDialogOpen(true);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      const payload = { customerId: form.customerId, items, validUntil: form.validUntil, internalNotes: form.internalNotes, clientNotes: form.clientNotes };
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

  if (loading) return <div className="eyebrow">Loading…</div>;

  const visibleEstimates = estimates.filter((es) => matchesQuery(search, es.estimateNo, es.customerName));

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="estimates-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search estimates…" />
        {canOpenNew && <button type="button" className="btn btn-primary" onClick={openNew}>New estimate</button>}
      </div>

      <table className="table">
        <thead>
          <tr><th>Estimate</th><th>Customer</th><th>Items</th><th>Total</th><th>Valid until</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
          {visibleEstimates.map((es) => {
            const canFinalize = es.status === 'draft' && canManage;
            const canConvert = es.status === 'finalized' && canManage;
            const canEdit = es.status === 'draft' && canManage;
            const canDelete = es.status !== 'converted' && canManage;
            return (
              <tr key={es.id}>
                <td>
                  <div className="estimates-no-cell">
                    <span className={'estimates-badge estimates-badge-' + statusTone(estimateBucket(es.status))}><DocIcon /></span>
                    <span style={{ fontWeight: 600 }}>{es.estimateNo}</span>
                  </div>
                </td>
                <td>{es.customerName}</td>
                <td className="estimates-items-line">{es.items.map((i) => i.description + ' × ' + i.qty).join(', ')}</td>
                <td>GHS {es.grandTotal.toLocaleString()}</td>
                <td>{fmtDate(es.validUntil)}</td>
                <td><span className={'tag ' + estimateTagClass(es.status)}>{es.status}</span></td>
                <td className="table-actions">
                  <button type="button" className="btn btn-secondary estimates-row-btn" disabled={busyId === es.id} onClick={() => openPreview(es)}>Preview</button>
                  {canFinalize && <button type="button" className="btn btn-secondary estimates-row-btn" disabled={busyId === es.id} onClick={() => finalize(es)}>Finalize</button>}
                  {canConvert && <button type="button" className="btn btn-secondary estimates-row-btn" disabled={busyId === es.id} onClick={() => convert(es)}>Convert to quotation</button>}
                  {canEdit && <button type="button" className="btn btn-secondary estimates-row-btn" onClick={() => openEdit(es)}>Edit</button>}
                  {canDelete && <button type="button" className="btn btn-secondary estimates-row-btn" onClick={() => setDeleteTarget(es)}>Delete</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!estimates.length && (
        <div className="estimates-empty-state">
          <span className="estimates-empty-icon"><DocIcon /></span>
          <p className="estimates-empty-title">No estimates yet</p>
        </div>
      )}
      {!!estimates.length && !visibleEstimates.length && (
        <div className="estimates-empty-state">
          <span className="estimates-empty-icon"><DocIcon /></span>
          <p className="estimates-empty-title">No estimates match "{search}"</p>
        </div>
      )}

      {dialogOpen && (
        <div className="dialog-backdrop" onClick={() => setDialogOpen(false)}>
          <form className="dialog estimates-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2 className="estimates-dialog-title">{editId ? 'Edit estimate' : 'New estimate'}</h2>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="estimates-dialog-fields">
              <div className="field">
                <label htmlFor="es-customer">Customer</label>
                <select id="es-customer" className="input" value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })} required>
                  <option value="">Choose a customer</option>
                  {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="es-valid">Valid until</label>
                <input id="es-valid" className="input" type="date" value={form.validUntil} onChange={(e) => setForm({ ...form, validUntil: e.target.value })} />
              </div>
            </div>
            <DocItemsEditor items={items} onChange={setItems} catalogOptions={catalog} />
            <div className="estimates-dialog-fields">
              <div className="field">
                <label htmlFor="es-internal">Internal notes</label>
                <textarea id="es-internal" className="input" value={form.internalNotes} onChange={(e) => setForm({ ...form, internalNotes: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="es-client">Client notes</label>
                <textarea id="es-client" className="input" value={form.clientNotes} onChange={(e) => setForm({ ...form, clientNotes: e.target.value })} />
              </div>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{editId ? 'Save changes' : 'Create estimate'}</button>
            </div>
          </form>
        </div>
      )}

      {deleteTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Delete {deleteTarget.estimateNo}</h2>
            <p className="dialog-body">This cannot be undone.</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={confirmDelete}>{deleting ? 'Deleting…' : 'Delete'}</button>
            </div>
          </div>
        </div>
      )}

      {previewEs && (
        <DocPreview
          docLabel={'Estimate #' + previewEs.estimateNo}
          dateLabel="Issue date"
          dateValue={fmtDate(previewEs.createdAt)}
          heading={'Estimate for ' + previewEs.customerName}
          subHeading={'Valid until ' + fmtDate(previewEs.validUntil)}
          blocks={[
            { title: 'Customer', lines: [previewEs.customerName, previewEs.customerEmail] },
            { title: 'Estimate Details', lines: ['Created ' + fmtDate(previewEs.createdAt), 'GHS ' + previewEs.grandTotal.toLocaleString()] },
            { title: 'Validity', lines: ['Valid until ' + fmtDate(previewEs.validUntil), 'GHS ' + previewEs.grandTotal.toLocaleString()] }
          ]}
          items={previewEs.items.map((i) => ({ description: i.description, qty: i.qty, unitPrice: 'GHS ' + i.unitPrice.toLocaleString(), lineTotal: 'GHS ' + Math.max(0, i.qty * i.unitPrice - (i.discountType === 'percent' ? (i.qty * i.unitPrice * (i.discount || 0)) / 100 : i.discount || 0)).toLocaleString() }))}
          subtotal={'GHS ' + previewEs.subtotal.toLocaleString()}
          totalLabel="Grand Total"
          total={'GHS ' + previewEs.grandTotal.toLocaleString()}
          notesLabel="Notes"
          notesValue={previewEs.clientNotes}
          termsLabel="Terms & conditions"
          termsValue={previewEs.terms}
          onClose={() => setPreviewEs(null)}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
