import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import RowMenu from '../components/RowMenu';
import RecordDialog from '../components/RecordDialog';
import { money } from '../lib/currency';
import { formatDate } from '../lib/dates';
import './SuppliersPage.css';

import { tr, trNodes } from '../lib/i18n.jsx';
// Ported from Bamboo OS.dc.html's suppliers screen (screens.suppliers
// block + the suppliers computed values, and the shared "supplier"
// create/edit dialog around its render()).
//
// Most of the people on this screen are bamboo farmers rather than
// companies, imported from the sourcing team's "Farmers & Suppliers" sheet
// (see backend supplierImport.service.js). So the table shows what you scan
// a farmer register by — who, where, price per pole, whether their bamboo
// meets spec, and where they are in the pipeline — and everything else
// (second phone, IOU, first contact, the notes the import kept) is one
// click away in the row's detail panel, rather than more columns to scroll
// sideways through.

const BADGE_COLORS = ['#3f7d3b', '#2f5f2c', '#7d5c3f', '#3f5a7d', '#7d3f5c', '#5c3f7d', '#7d6b3f', '#3f7d6b'];
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function badgeColor(name) { return BADGE_COLORS[hashStr(name || '') % BADGE_COLORS.length]; }

function BuildingIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="3" width="9" height="18" stroke="currentColor" strokeWidth="1.6" />
      <rect x="14" y="9" width="6" height="12" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 7h1M8 11h1M8 15h1M11 7h1M11 11h1M11 15h1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

const EMPTY_FORM = {
  name: '', contactPerson: '', phone: '', email: '', address: '', materialsSupplied: '',
  region: '', town: '', district: '', phone2: '', quotedPrice: '', priceUnit: '', assessment: '',
  sourcingStatus: '', expectedQty: '', iouAmount: '', iouNotes: '', firstContactDate: '', notes: ''
};

// Numbers come back as numbers or null; the form edits strings.
function toForm(s) {
  const f = {};
  Object.keys(EMPTY_FORM).forEach((k) => {
    const v = s[k];
    f[k] = v === null || v === undefined ? '' : String(v);
  });
  return f;
}

// Keyed on the importer's dateOrder code rather than translating its English
// sentence, so the explanation reaches the catalogue like any other string.
// A function, not a constant: tr() at module level runs once when the file
// loads and would stay in that language after a switch.
function dateNote(order) {
  switch (order) {
    case 'mdy': return tr('Dates read as month/day (e.g. 5/13/2021 = 13 May 2021).');
    case 'dmy': return tr('Dates read as day/month (e.g. 13/5/2021 = 13 May 2021).');
    case 'mixed': return tr('This sheet mixes month/day and day/month dates — each was read whichever way it could be. Check them after import.');
    default: return tr('No date on this sheet settles whether it is month/day or day/month — read as day/month. Check them after import.');
  }
}

// Town, district and region, without the repeats the sheet is full of —
// the town and district are often the same name ("Mando, Mando, Central").
function place(s) {
  const parts = [];
  [s.town, s.district, s.region].forEach((p) => {
    if (p && !parts.some((q) => q.toLowerCase() === p.toLowerCase())) parts.push(p);
  });
  return parts.join(', ');
}

function priceLabel(s) {
  if (s.quotedPrice === null || s.quotedPrice === undefined) return '—';
  return money(s.quotedPrice, 'GHS') + (s.priceUnit ? ' / ' + s.priceUnit : '');
}

function assessmentTag(a) {
  if (!a) return null;
  const good = /^meets spec$/i.test(a);
  // The assessment is the sourcing team's own wording, so it is shown as
  // written rather than run through the translation catalogue — the
  // interface is translated, the data people entered is not.
  return <span className={'tag ' + (good ? 'tag-neutral' : 'tag-accent')}>{a}</span>;
}

export default function SuppliersPage() {
  const { can } = useAuth();
  const canManage = can('supplier.manage');

  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [search, setSearch] = useState('');
  const [region, setRegion] = useState('');
  const [viewing, setViewing] = useState(null);

  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importPreview, setImportPreview] = useState(null);
  const [importError, setImportError] = useState(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importCommitting, setImportCommitting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSuppliers(await api.get('/suppliers'));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const regions = useMemo(
    () => Array.from(new Set(suppliers.map((s) => s.region).filter(Boolean))).sort(),
    [suppliers]
  );

  function openNew() {
    setDialogError(null);
    setEditId(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(s) {
    setViewing(null);
    setDialogError(null);
    setEditId(s.id);
    setForm(toForm(s));
    setDialogOpen(true);
  }

  function set(k) { return (e) => setForm({ ...form, [k]: e.target.value }); }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      if (editId) await api.put('/suppliers/' + editId, form);
      else await api.post('/suppliers', form);
      setToast(editId ? tr('Supplier updated.') : tr('Supplier added.'));
      setDialogOpen(false);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    setDeleting(true);
    try {
      await api.del('/suppliers/' + deleteTarget.id);
      setToast(tr('{name} deleted.', { name: deleteTarget.name }));
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  function openImport() {
    setImportFile(null);
    setImportPreview(null);
    setImportError(null);
    setImportOpen(true);
  }

  async function runImportPreview() {
    setImportLoading(true);
    setImportError(null);
    try {
      const fd = new FormData();
      fd.append('file', importFile);
      setImportPreview(await api.upload('/suppliers/import/preview', fd));
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImportLoading(false);
    }
  }

  async function commitImport() {
    setImportCommitting(true);
    setImportError(null);
    try {
      const result = await api.post('/suppliers/import/commit', { suppliers: importPreview.suppliers });
      setImportOpen(false);
      setToast(tr('Import finished: {created} added, {updated} updated, {unchanged} unchanged.', result));
      await load();
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImportCommitting(false);
    }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  const visibleSuppliers = suppliers.filter((s) =>
    (!region || s.region === region)
    && matchesQuery(search, s.name, s.contactPerson, s.phone, s.phone2, s.materialsSupplied, s.town, s.district, s.region, s.sourcingStatus, s.assessment));

  const actionsFor = (s) => [
    { label: tr('Edit'), onClick: () => openEdit(s), hidden: !canManage },
    { label: tr('Delete'), onClick: () => { setViewing(null); setDeleteTarget(s); }, danger: true, hidden: !(canManage && s.batchCount === 0) }
  ];

  // Preview rows that need a look go first: the ones with warnings, then
  // updates, then plain new rows — so what matters is at the top of a list
  // of seventy.
  const previewRows = importPreview
    ? importPreview.suppliers.slice().sort((a, b) =>
      (b.warnings.length ? 2 : 0) + (b.action === 'update' ? 1 : 0) - ((a.warnings.length ? 2 : 0) + (a.action === 'update' ? 1 : 0)))
    : [];
  const toWrite = importPreview ? importPreview.summary.create + importPreview.summary.update : 0;

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="suppliers-toolbar">
        <div className="suppliers-filters">
          <SearchInput value={search} onChange={setSearch} placeholder={tr('Search suppliers…')} />
          {regions.length > 1 && (
            <select className="input suppliers-region" value={region} onChange={(e) => setRegion(e.target.value)} aria-label={tr('Region')}>
              <option value="">{tr('All regions')}</option>
              {regions.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          )}
        </div>
        {canManage && (
          <div className="suppliers-actions">
            <button type="button" className="btn btn-secondary" onClick={openImport}>{tr('Import from sheet')}</button>
            <button type="button" className="btn btn-primary" onClick={openNew}>{tr('Add supplier')}</button>
          </div>
        )}
      </div>

      {!!suppliers.length && (
        <p className="suppliers-count">
          {tr('Showing {n} of {total}', { n: visibleSuppliers.length, total: suppliers.length })}
        </p>
      )}

      <table className="table table-clickable suppliers-table">
        <thead>
          <tr><th>{tr('Supplier')}</th><th>{tr('Phone')}</th><th className="suppliers-col-optional">{tr('Price')}</th><th className="suppliers-col-optional suppliers-col-wide">{tr('Assessment')}</th><th className="suppliers-col-optional">{tr('Status')}</th><th className="suppliers-col-optional suppliers-col-wide">{tr('Batches')}</th><th /></tr>
        </thead>
        <tbody>
          {visibleSuppliers.map((s) => (
            <tr key={s.id} onClick={() => setViewing(s)}>
              <td className="suppliers-name-td">
                <div className="suppliers-name-cell">
                  <span className="suppliers-badge" style={{ background: badgeColor(s.name) }}><BuildingIcon /></span>
                  <div>
                    <div style={{ fontWeight: 600 }}>
                      {s.name}
                      {s.status !== 'active' && <span className="tag tag-accent suppliers-inactive">{tr('Inactive')}</span>}
                    </div>
                    <div className="suppliers-sub">{place(s) || s.materialsSupplied}</div>
                  </div>
                </div>
              </td>
              <td className="suppliers-phone">{s.phone || '—'}</td>
              <td className="suppliers-nowrap suppliers-col-optional">{priceLabel(s)}</td>
              <td className="suppliers-col-optional suppliers-col-wide">{assessmentTag(s.assessment) || '—'}</td>
              <td className="suppliers-col-optional">{s.sourcingStatus || '—'}</td>
              <td className="suppliers-col-optional suppliers-col-wide">{s.batchCount}</td>
              <td className="table-actions" onClick={(e) => e.stopPropagation()}>
                <RowMenu actions={actionsFor(s)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!suppliers.length && (
        <div className="suppliers-empty-state">
          <span className="suppliers-empty-icon"><BuildingIcon /></span>
          <p className="suppliers-empty-title">{tr('No suppliers on file yet')}</p>
          {canManage && <p className="dialog-body">{tr('Add one, or import the farmer & supplier sheet.')}</p>}
        </div>
      )}
      {!!suppliers.length && !visibleSuppliers.length && (
        <div className="suppliers-empty-state">
          <span className="suppliers-empty-icon"><BuildingIcon /></span>
          <p className="suppliers-empty-title">{tr('No suppliers match "{search}"', { search })}</p>
        </div>
      )}

      {viewing && (
        <RecordDialog
          title={viewing.name}
          subtitle={place(viewing) || viewing.materialsSupplied}
          tag={viewing.assessment ? assessmentTag(viewing.assessment) : null}
          onClose={() => setViewing(null)}
          actions={actionsFor(viewing)}
          fields={[
            { label: tr('Contact person'), value: viewing.contactPerson !== viewing.name ? viewing.contactPerson : null },
            { label: tr('Phone'), value: viewing.phone },
            { label: tr('Second phone'), value: viewing.phone2 },
            { label: tr('Email'), value: viewing.email },
            { label: tr('Region'), value: viewing.region },
            { label: tr('Town'), value: viewing.town },
            { label: tr('District'), value: viewing.district },
            { label: tr('Address'), value: viewing.address },
            { label: tr('Materials supplied'), value: viewing.materialsSupplied },
            { label: tr('Quoted price'), value: viewing.quotedPrice !== null ? priceLabel(viewing) : null },
            { label: tr('Sourcing status'), value: viewing.sourcingStatus },
            { label: tr('Expected quantity'), value: viewing.expectedQty !== null ? viewing.expectedQty.toLocaleString() : null },
            { label: tr('IOU'), value: viewing.iouAmount !== null ? money(viewing.iouAmount, 'GHS') : null },
            { label: tr('IOU notes'), value: viewing.iouNotes },
            { label: tr('First contact'), value: viewing.firstContactDate ? formatDate(viewing.firstContactDate) : null },
            { label: tr('Payment terms'), value: viewing.paymentTerms },
            { label: tr('Raw material batches'), value: String(viewing.batchCount) },
            { label: tr('Status'), value: viewing.status === 'active' ? tr('Active') : tr('Inactive') },
            { label: tr('Notes'), value: viewing.notes, wide: true }
          ]}
        />
      )}

      {dialogOpen && (
        <div className="dialog-backdrop" onClick={() => setDialogOpen(false)}>
          <form className="dialog suppliers-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2 className="suppliers-dialog-title">{editId ? tr('Edit supplier') : tr('Add supplier')}</h2>
            {dialogError && <div className="error-banner suppliers-dialog-span">{dialogError}</div>}
            <div className="field suppliers-dialog-span">
              <label htmlFor="sup-name">{tr('Supplier name')}</label>
              <input id="sup-name" className="input" value={form.name} onChange={set('name')} required />
            </div>
            <div className="field">
              <label htmlFor="sup-contact">{tr('Contact person')}</label>
              <input id="sup-contact" className="input" value={form.contactPerson} onChange={set('contactPerson')} required />
            </div>
            <div className="field">
              <label htmlFor="sup-phone">{tr('Phone')}</label>
              <input id="sup-phone" className="input" value={form.phone} onChange={set('phone')} />
            </div>
            <div className="field">
              <label htmlFor="sup-phone2">{tr('Second phone')}</label>
              <input id="sup-phone2" className="input" value={form.phone2} onChange={set('phone2')} />
            </div>
            <div className="field">
              <label htmlFor="sup-email">{tr('Email')}</label>
              <input id="sup-email" className="input" type="email" value={form.email} onChange={set('email')} />
            </div>
            <div className="field suppliers-dialog-span">
              <label htmlFor="sup-materials">{tr('Materials supplied')}</label>
              <input id="sup-materials" className="input" value={form.materialsSupplied} onChange={set('materialsSupplied')} placeholder={tr('e.g. Raw bamboo poles')} required />
            </div>

            <h3 className="suppliers-dialog-section">{tr('Location')}</h3>
            <div className="field">
              <label htmlFor="sup-region">{tr('Region')}</label>
              <input id="sup-region" className="input" value={form.region} onChange={set('region')} list="sup-region-list" />
              <datalist id="sup-region-list">{regions.map((r) => <option key={r} value={r} />)}</datalist>
            </div>
            <div className="field">
              <label htmlFor="sup-town">{tr('Town')}</label>
              <input id="sup-town" className="input" value={form.town} onChange={set('town')} />
            </div>
            <div className="field">
              <label htmlFor="sup-district">{tr('District')}</label>
              <input id="sup-district" className="input" value={form.district} onChange={set('district')} />
            </div>
            <div className="field">
              <label htmlFor="sup-address">{tr('Address')}</label>
              <input id="sup-address" className="input" value={form.address} onChange={set('address')} />
            </div>

            <h3 className="suppliers-dialog-section">{tr('Sourcing')}</h3>
            <div className="field">
              <label htmlFor="sup-price">{tr('Quoted price (GHS)')}</label>
              <input id="sup-price" className="input" type="number" min="0" step="0.01" value={form.quotedPrice} onChange={set('quotedPrice')} />
            </div>
            <div className="field">
              <label htmlFor="sup-unit">{tr('Per')}</label>
              <input id="sup-unit" className="input" value={form.priceUnit} onChange={set('priceUnit')} placeholder={tr('pole, kg, litre…')} />
            </div>
            <div className="field">
              <label htmlFor="sup-assessment">{tr('Assessment')}</label>
              <input id="sup-assessment" className="input" value={form.assessment} onChange={set('assessment')} list="sup-assessment-list" />
              <datalist id="sup-assessment-list">
                <option value="Meets spec" /><option value="Does not meet spec" /><option value="Too many rejects" />
              </datalist>
            </div>
            <div className="field">
              <label htmlFor="sup-status">{tr('Sourcing status')}</label>
              <input id="sup-status" className="input" value={form.sourcingStatus} onChange={set('sourcingStatus')} list="sup-status-list" />
              <datalist id="sup-status-list">
                {Array.from(new Set(['Active', 'Cutting', 'Cutting sample', 'Yet to cut', 'Not cutting', 'Schedule for meeting']
                  .concat(suppliers.map((s) => s.sourcingStatus).filter(Boolean)))).map((v) => <option key={v} value={v} />)}
              </datalist>
            </div>
            <div className="field">
              <label htmlFor="sup-qty">{tr('Expected quantity')}</label>
              <input id="sup-qty" className="input" type="number" min="0" step="1" value={form.expectedQty} onChange={set('expectedQty')} />
            </div>
            <div className="field">
              <label htmlFor="sup-first">{tr('First contact')}</label>
              <input id="sup-first" className="input" type="date" value={form.firstContactDate} onChange={set('firstContactDate')} />
            </div>
            <div className="field">
              <label htmlFor="sup-iou">{tr('IOU (GHS)')}</label>
              <input id="sup-iou" className="input" type="number" step="0.01" value={form.iouAmount} onChange={set('iouAmount')} />
            </div>
            <div className="field">
              <label htmlFor="sup-iou-notes">{tr('IOU notes')}</label>
              <input id="sup-iou-notes" className="input" value={form.iouNotes} onChange={set('iouNotes')} />
            </div>
            <div className="field suppliers-dialog-span">
              <label htmlFor="sup-notes">{tr('Notes')}</label>
              <textarea id="sup-notes" className="input" rows={3} value={form.notes} onChange={set('notes')} />
            </div>

            <div className="dialog-actions suppliers-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setDialogOpen(false)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{editId ? tr('Save changes') : tr('Add supplier')}</button>
            </div>
          </form>
        </div>
      )}

      {importOpen && (
        <div className="dialog-backdrop" onClick={() => setImportOpen(false)}>
          <div className="dialog suppliers-import-dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Import from the farmer & supplier sheet')}</h2>
            <p className="dialog-body">
              {tr('In Google Sheets, open the "Farmers & Suppliers" tab, then File → Download → Comma-separated values, and upload that file here. People on the sheet more than once are merged by phone number. Uploading the sheet again later updates price, assessment, status, expected quantity and IOU — it never duplicates anyone or undoes a name you corrected here.')}
            </p>
            {importError && <div className="error-banner">{importError}</div>}

            {!importPreview && (
              <>
                <div className="field">
                  <label htmlFor="sup-import-file">{tr('CSV file')}</label>
                  <input id="sup-import-file" className="input" type="file" accept=".csv,text/csv" onChange={(e) => setImportFile(e.target.files[0] || null)} />
                </div>
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setImportOpen(false)}>{tr('Cancel')}</button>
                  <button type="button" className="btn btn-primary" disabled={!importFile || importLoading} onClick={runImportPreview}>
                    {importLoading ? tr('Reading…') : tr('Preview import')}
                  </button>
                </div>
              </>
            )}

            {importPreview && (
              <>
                <div className="suppliers-import-summary">
                  <div>{trNodes('{rows} sheet rows → {suppliers} suppliers', { rows: <strong>{importPreview.sheetRows}</strong>, suppliers: <strong>{importPreview.suppliers.length}</strong> })}</div>
                  <div>
                    {tr('{n} new', { n: importPreview.summary.create })} · {tr('{n} updated', { n: importPreview.summary.update })} · {tr('{n} unchanged', { n: importPreview.summary.unchanged })}
                    {!!importPreview.summary.merged && <> · {tr('{n} merged from repeated rows', { n: importPreview.summary.merged })}</>}
                  </div>
                  <div className="suppliers-import-datenote">{dateNote(importPreview.dateOrder)}</div>
                  {!!importPreview.summary.withWarnings && (
                    <div className="suppliers-import-warncount">{tr('{n} need a look — listed first below.', { n: importPreview.summary.withWarnings })}</div>
                  )}
                </div>
                <div className="suppliers-import-list">
                  {previewRows.map((c, i) => (
                    <div key={i} className={'suppliers-import-row suppliers-import-' + c.action}>
                      <div className="suppliers-import-head">
                        <strong>{c.name}</strong>
                        <span className="suppliers-import-meta">{c.phone || tr('no phone')} · {place(c) || '—'} · {tr('sheet rows {rows}', { rows: c.sheetRows.join(', ') })}</span>
                        <span className={'tag ' + (c.action === 'create' ? 'tag-neutral' : 'tag-accent')}>
                          {c.action === 'create' ? tr('New') : c.action === 'update' ? tr('Update') : tr('Unchanged')}
                        </span>
                      </div>
                      {c.action === 'update' && c.changes && c.changes.map((x, xi) => <div key={xi} className="suppliers-import-change">{x}</div>)}
                      {c.warnings.map((w, wi) => <div key={wi} className="suppliers-import-warning">{w}</div>)}
                    </div>
                  ))}
                </div>
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setImportPreview(null)}>{tr('Back')}</button>
                  <button type="button" className="btn btn-secondary" onClick={() => setImportOpen(false)}>{tr('Cancel')}</button>
                  <button type="button" className="btn btn-primary" disabled={importCommitting || !toWrite} onClick={commitImport}>
                    {importCommitting ? tr('Importing…') : toWrite ? tr('Import {n} suppliers', { n: toWrite }) : tr('Nothing to import')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Delete supplier')}</h2>
            <p className="dialog-body">{tr('Delete')} <strong>{deleteTarget.name}</strong>{tr('? This cannot be undone.')}</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={confirmDelete}>{deleting ? tr('Deleting…') : tr('Delete')}</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
