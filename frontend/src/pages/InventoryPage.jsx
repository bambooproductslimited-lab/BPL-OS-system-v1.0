import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import './InventoryPage.css';
import RowMenu from '../components/RowMenu';

import { tr, trNodes, activeIntlLocale } from '../lib/i18n.jsx';
import { SetupSteps } from '../components/SmsSettings';
import { formatDate } from '../lib/dates';
// Ported from Bamboo OS.dc.html's inventory screen (screens.inventory
// block + the products computed values, and the shared "product"
// create/edit dialog around its render()).
//
// Redesigned around the icon language established elsewhere: a
// category-colored box badge per product, an icon'd empty state.

const BADGE_COLORS = ['#3f7d3b', '#2f5f2c', '#7d5c3f', '#3f5a7d', '#7d3f5c', '#5c3f7d', '#7d6b3f', '#3f7d6b'];
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function badgeColor(name) { return BADGE_COLORS[hashStr(name || '') % BADGE_COLORS.length]; }

function BoxIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3.5 20 8 12 12.5 4 8 12 3.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M4 8v8l8 4.5 8-4.5V8" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M12 12.5V21" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

// The importer reports problems as codes with figures, worded here so they
// follow the reader's language.
function lineWarning(w) {
  switch (w.code) {
    case 'variance': return tr('Counted {counted}, the sheet expected {expected} — the count is what gets imported.', w);
    case 'no_count': return tr('No physical count on this line — the expected closing figure ({expected}) is used.', w);
    case 'negative': return tr('Counted {counted} — stock can\'t be negative, so it is imported as 0.', w);
    case 'no_stock': return tr('No stock figure on this line — it is skipped.');
    case 'count_differs': return tr('The summary says {figure} for that day, but {counted} was counted — the count is kept.', w);
    default: return w.code;
  }
}

const isWorkbook = (file) => !!file && /\.xlsx$/i.test(file.name);

// The whole-month workbook's preview: one row per day tab, what it holds,
// and where stock will end up.
function WorkbookPreview({ preview, month, onMonth, mappings, onMap }) {
  const days = preview.days || [];
  const unmatched = preview.unmatched || [];
  const overwrite = days.filter((d) => d.alreadyInOs > 0);
  return (
    <>
      <div className="field inventory-import-date">
        <label htmlFor="inv-workbook-month">{tr('Month of this workbook')}</label>
        <input id="inv-workbook-month" className="input" type="month" value={month} onChange={(e) => onMonth(e.target.value)} required />
      </div>
      {!preview.month ? (
        <div className="inventory-import-note">{tr('Choose the month this workbook is for — the file name doesn\'t say.')}</div>
      ) : (
        <>
          <div className="inventory-import-summary">
            <div>
              {tr('{n} day tabs, {from} to {to}', { n: days.length, from: formatDate(days[0].date), to: formatDate(preview.lastDate) })}
              {' · '}{tr('{n} new', { n: preview.newProducts })}
            </div>
            <div className="inventory-import-warncount">
              {preview.laterInOs
                ? tr('The daily stock sheet already has {date}, so stock stays as it is — these days are added as history.', { date: formatDate(preview.laterInOs) })
                : tr('Stock will be set from {date}: {n} products change.', { date: formatDate(preview.lastDate), n: preview.stockChanges })}
            </div>
          </div>
          {overwrite.length > 0 && (
            <div className="inventory-import-note">
              {tr('{n} of these days are already on the daily stock sheet. Importing replaces those days with the workbook\'s figures.', { n: overwrite.length })}
            </div>
          )}
          {unmatched.length > 0 && (
            <div className="inventory-workbook-unmatched">
              <div className="inventory-workbook-unmatched-title">{tr('Not found in the OS ({n})', { n: unmatched.length })}</div>
              <p className="inventory-import-meta">
                {tr('Lines were sometimes renamed or mistyped on the sheet. If one of these is a product the OS already has, choose it — the OS remembers, so the next import finds it by itself.')}
              </p>
              {unmatched.map((u) => (
                <div key={u.sku} className="inventory-workbook-unmatched-row">
                  <div>
                    <div className="inventory-workbook-unmatched-name">{u.name}</div>
                    <div className="inventory-import-meta">
                      {u.sku} · {u.dayCount === 1
                        ? tr('on {date}', { date: formatDate(u.firstDay) })
                        : tr('{n} days, {from} to {to}', { n: u.dayCount, from: formatDate(u.firstDay), to: formatDate(u.lastDay) })}
                    </div>
                  </div>
                  <select className="input" value={mappings[u.sku] || 'new'} onChange={(e) => onMap(u.sku, e.target.value)} aria-label={u.name}>
                    <option value="new">{tr('Add as a new product')}</option>
                    {u.candidates.map((c) => <option key={c.id} value={c.id}>{tr('Same as: {name}', { name: c.name + ' (' + c.sku + ')' })}</option>)}
                  </select>
                </div>
              ))}
            </div>
          )}
          <div className="inventory-import-list">
            <table className="table inventory-workbook-days">
              <thead>
                <tr><th>{tr('Day')}</th><th>{tr('Items')}</th><th>{tr('Counted')}</th><th>{tr('Differences')}</th><th /></tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <tr key={d.sheet}>
                    <td>{formatDate(d.date)}</td>
                    <td>{d.items}</td>
                    <td>{d.counted}</td>
                    <td className={d.differences ? 'inventory-workbook-diff' : undefined}>{d.differences}</td>
                    <td className="inventory-import-meta">{d.alreadyInOs ? tr('Already in the OS — replaced') : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {!!(preview.skippedTabs || []).length && (
        <p className="inventory-import-meta" style={{ marginTop: 8 }}>
          {tr('Left out: {tabs} — the OS works out the monthly summary itself.', { tabs: preview.skippedTabs.map((t) => '"' + t.sheet + '"').join(', ') })}
        </p>
      )}
    </>
  );
}

function monthName(m) {
  return m ? new Date(m + '-01T00:00:00').toLocaleDateString(activeIntlLocale(), { month: 'long', year: 'numeric' }) : '';
}

// Import from Google Drive (backend googleDrive.service.js): the Finish
// Inventory sheets shared with the OS's Google service account, newest
// first, each with how much of its month is already in the OS. Picking one
// fetches it from Drive and shows the same preview as an uploaded workbook;
// after importing, the list comes back so the next month is one click away.
function DriveImportDialog({ onClose, onImported }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [all, setAll] = useState(false);
  const [file, setFile] = useState(null); // { id, name }
  const [preview, setPreview] = useState(null);
  const [month, setMonth] = useState('');
  const [mappings, setMappings] = useState({});
  const [busy, setBusy] = useState(null); // file id being previewed, or 'commit'
  const [done, setDone] = useState(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try { setData(await api.get('/products/import/drive' + (all ? '?all=1' : ''))); } catch (err) { setError(err.message); setData({ configured: true, files: [] }); }
  }, [all]);
  useEffect(() => { load(); }, [load]);

  async function openPreview(f, m) {
    setBusy(f.id);
    setError(null);
    setDone(null);
    try {
      const p = await api.post('/products/import/drive/' + f.id + '/preview', { month: m || undefined });
      setFile(f);
      setPreview(p);
      setMonth(p.month || m || '');
      if (!m) setMappings({});
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    setBusy('commit');
    setError(null);
    try {
      const r = await api.post('/products/import/drive/' + file.id + '/commit', { month, mappings });
      setDone(tr('Imported {month}: {days} days, {created} products added.', { month: monthName(month), days: r.days, created: r.created }));
      setPreview(null);
      setFile(null);
      onImported();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function copyEmail() {
    try { await navigator.clipboard.writeText(data.serviceAccountEmail); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* the address is on screen to copy by hand */ }
  }

  const days = preview && preview.month ? (preview.days || []).length : 0;

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog inventory-import-dialog inventory-drive-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="inventory-drive-head">
          <span className="inventory-drive-logo" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><path d="M8.5 3.5h7l6 10.5-3.5 6H6L2.5 14l6-10.5Z" /><path d="M8.5 3.5 15 14.5M15.5 3.5 9 14.5M2.5 14h19" /></svg>
          </span>
          <div>
            <h2>{preview ? file.name : tr('Import from Google Drive')}</h2>
            <p className="inventory-import-meta">{preview ? tr('From Google Drive') : tr('The Finish Inventory sheets, read straight from Drive — no downloading.')}</p>
          </div>
        </div>

        {error && <div className="error-banner">{error}</div>}
        {done && <div className="inventory-drive-done" role="status">{done}</div>}

        {!data ? (
          <p className="inventory-import-meta">{tr('Loading…')}</p>
        ) : !data.configured ? (
          <>
            {data.jsonInvalid && <div className="error-banner">{tr('GOOGLE_SERVICE_ACCOUNT_JSON on the server isn\'t valid JSON. Paste the whole key file again, from { to }.')}</div>}
            <p className="dialog-body">{tr('Google Drive isn\'t connected yet. An administrator does this once:')}</p>
            <SetupSteps
              steps={[
                tr('In Google Cloud (console.cloud.google.com), choose or create a project, then APIs & Services → Library → Google Drive API → Enable.'),
                tr('IAM & Admin → Service accounts → Create service account (e.g. "bamboo-os"). Open it → Keys → Add key → Create new key → JSON. A .json file downloads.'),
                tr('In Render, open the backend service → Environment, add GOOGLE_SERVICE_ACCOUNT_JSON and paste the whole contents of that file. Save — the server restarts by itself.'),
                tr('In Google Drive, share the Finish Inventory sheets — or better, the folder they are kept in — with the service account\'s email (it ends in iam.gserviceaccount.com), as Viewer.')
              ]}
              footnote={tr('Keep the key file private — never send it in a chat or email. The OS can only read what is shared with that email, and can\'t change anything in Drive.')}
            />
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button></div>
          </>
        ) : preview ? (
          <>
            <WorkbookPreview
              preview={preview}
              month={month}
              onMonth={(m) => { setMonth(m); if (m) openPreview(file, m); }}
              mappings={mappings}
              onMap={(sku, value) => setMappings((prev) => ({ ...prev, [sku]: value }))}
            />
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => { setPreview(null); setFile(null); }}>{tr('Back')}</button>
              <button type="button" className="btn btn-primary" disabled={!!busy || !days} onClick={commit}>
                {busy === 'commit' ? tr('Importing…') : tr('Import {n} days', { n: days })}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="inventory-drive-share">
              <span>{tr('The OS sees what is shared with')} <code>{data.serviceAccountEmail}</code></span>
              <button type="button" className="btn btn-secondary inventory-drive-copy" onClick={copyEmail}>{copied ? tr('Copied!') : tr('Copy')}</button>
            </div>
            <label className="inventory-drive-all">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> {tr('Show every spreadsheet, not just Finish Inventory')}
            </label>
            {!data.files.length ? (
              <div className="inventory-drive-empty">
                <p><strong>{tr('Nothing shared with the OS yet.')}</strong></p>
                <p className="inventory-import-meta">{tr('In Google Drive, share the Finish Inventory sheets (or their folder) with the address above as Viewer, then open this again.')}</p>
              </div>
            ) : (
              <ul className="inventory-drive-list">
                {data.files.map((f) => (
                  <li key={f.id} className="inventory-drive-row">
                    <span className="inventory-drive-file" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M4 9h16M4 15h16M10 9v12" /></svg>
                    </span>
                    <div className="inventory-drive-text">
                      <div className="inventory-drive-name">{f.name}</div>
                      <div className="inventory-import-meta">
                        {tr('Updated {date}', { date: formatDate(String(f.modifiedTime).slice(0, 10)) })}{f.owner ? ' · ' + f.owner : ''}
                      </div>
                    </div>
                    <div className="inventory-drive-status">
                      {f.month ? <span className="inventory-drive-month">{monthName(f.month)}</span> : null}
                      {f.month && (f.daysInOs
                        ? <span className="inventory-drive-pill is-in">{tr('{n} days in the OS', { n: f.daysInOs })}</span>
                        : <span className="inventory-drive-pill">{tr('Not in the OS yet')}</span>)}
                    </div>
                    <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => openPreview(f)}>
                      {busy === f.id ? tr('Reading…') : tr('Preview')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={load}>{tr('Refresh')}</button>
              <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const IMPORT_ORDER = { create: 1, update: 1, unchanged: 2, kept: 2, skip: 3 };

const EMPTY_FORM = { sku: '', name: '', category: '', unit: '', costPrice: '', sellingPrice: '', currentStock: '', reorderLevel: '' };

export default function InventoryPage() {
  const { can } = useAuth();
  const canManage = can('inventory.manage');

  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');

  const [importOpen, setImportOpen] = useState(false);
  const [driveOpen, setDriveOpen] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importPreview, setImportPreview] = useState(null);
  const [countDate, setCountDate] = useState('');
  const [workbookMonth, setWorkbookMonth] = useState('');
  const [workbookMappings, setWorkbookMappings] = useState({});
  const [importError, setImportError] = useState(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importCommitting, setImportCommitting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setProducts(await api.get('/products'));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // /inventory?import=workbook (from the stock summary's "Import a month's
  // workbook") opens the import straight away.
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (params.get('import') && can('inventory.manage')) {
      if (params.get('import') === 'drive') {
        setDriveOpen(true);
      } else {
        setImportFile(null);
        setImportPreview(null);
        setImportError(null);
        setImportOpen(true);
      }
      setParams({}, { replace: true });
    }
  }, [params, setParams, can]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  function openNew() {
    setDialogError(null);
    setEditId(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(p) {
    setDialogError(null);
    setEditId(p.id);
    setForm({
      sku: p.sku, name: p.name, category: p.category, unit: p.unit,
      costPrice: p.costPrice, sellingPrice: p.sellingPrice, currentStock: p.currentStock, reorderLevel: p.reorderLevel
    });
    setDialogOpen(true);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      if (editId) await api.put('/products/' + editId, form);
      else await api.post('/products', form);
      setToast(editId ? tr('Product updated.') : tr('Product added.'));
      setDialogOpen(false);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function openImport() {
    setImportFile(null);
    setImportPreview(null);
    setImportError(null);
    setImportOpen(true);
  }

  async function runImportPreview(month) {
    setImportLoading(true);
    setImportError(null);
    try {
      const fd = new FormData();
      fd.append('file', importFile);
      if (isWorkbook(importFile)) {
        if (month) fd.append('month', month);
        const preview = await api.upload('/products/import/workbook/preview', fd);
        setImportPreview(preview);
        setWorkbookMonth(preview.month || month || '');
        setWorkbookMappings({});
        return;
      }
      const preview = await api.upload('/products/import/preview', fd);
      setImportPreview(preview);
      setCountDate(preview.countDate || new Date().toISOString().slice(0, 10));
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
      if (importPreview.source === 'workbook') {
        const fd = new FormData();
        fd.append('file', importFile);
        fd.append('month', workbookMonth);
        fd.append('mappings', JSON.stringify(workbookMappings));
        const result = await api.upload('/products/import/workbook/commit', fd);
        setImportOpen(false);
        setToast(tr('Workbook imported: {days} days, {created} products added.', result));
        await load();
        return;
      }
      const summaryTab = importPreview.source === 'summary';
      // A day's count sends its unchanged lines too, so the OS records that
      // they were counted that day (a later monthly summary won't replace them).
      const lines = importPreview.lines.filter((l) => (summaryTab ? l.action === 'create' || l.action === 'update' : l.action !== 'skip'));
      const result = await api.post('/products/import/commit', { lines, countDate, source: importPreview.source });
      setImportOpen(false);
      setToast(summaryTab
        ? tr('Monthly summary imported: {created} products added, {updated} updated.', result)
        : tr('Stock count imported: {created} products added, {updated} stock figures changed.', result));
      await load();
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImportCommitting(false);
    }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  const visibleProducts = products.filter((p) => matchesQuery(search, p.sku, p.name, p.category));
  const previewLines = importPreview && importPreview.lines
    ? importPreview.lines.slice().sort((a, b) =>
      (b.warnings.length > 0) - (a.warnings.length > 0) || IMPORT_ORDER[a.action] - IMPORT_ORDER[b.action] || a.sheetRow - b.sheetRow)
    : [];
  const toWrite = importPreview && importPreview.summary ? importPreview.summary.create + importPreview.summary.update : 0;
  const isSummary = !!importPreview && importPreview.source === 'summary';
  const isWorkbookPreview = !!importPreview && importPreview.source === 'workbook';
  const workbookDays = isWorkbookPreview && importPreview.month ? importPreview.days.length : 0;
  const canConfirmCount = !!importPreview && importPreview.source === 'count' && importPreview.summary.unchanged > 0;

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="inventory-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder={tr('Search products…')} />
        {canManage && (
          <div className="inventory-toolbar-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setDriveOpen(true)}>{tr('Import from Google Drive')}</button>
            <button type="button" className="btn btn-secondary" onClick={openImport}>{tr('Import count sheet')}</button>
            <button type="button" className="btn btn-primary" onClick={openNew}>{tr('Add product')}</button>
          </div>
        )}
      </div>

      <table className="table">
        <thead>
          <tr><th>SKU</th><th>{tr('Product')}</th><th>{tr('Category')}</th><th>{tr('Cost')}</th><th>{tr('Selling price')}</th><th>{tr('Stock')}</th><th>{tr('Reorder level')}</th><th /><th /></tr>
        </thead>
        <tbody>
          {visibleProducts.map((p) => (
            <tr key={p.id}>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{p.sku}</td>
              <td>
                <div className="inventory-name-cell">
                  <span className="inventory-badge" style={{ background: badgeColor(p.category) }}><BoxIcon /></span>
                  <span style={{ fontWeight: 600 }}>{p.name}</span>
                </div>
              </td>
              <td>{p.category}</td>
              <td>{p.costPrice}</td>
              <td>{p.sellingPrice}</td>
              <td>{p.currentStock} {p.unit}</td>
              <td>{p.reorderLevel}</td>
              <td><span className={'tag ' + (p.lowStock ? 'tag-accent' : 'tag-neutral')}>{p.lowStock ? tr('Low stock') : tr('OK')}</span></td>
              <td className="table-actions" onClick={(e) => e.stopPropagation()}>
                <RowMenu actions={[
                  { label: tr('Edit'), onClick: () => openEdit(p), hidden: !(canManage) },
                ]} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!products.length && (
        <div className="inventory-empty-state">
          <span className="inventory-empty-icon"><BoxIcon /></span>
          <p className="inventory-empty-title">{tr('No products in the catalogue yet')}</p>
        </div>
      )}
      {!!products.length && !visibleProducts.length && (
        <div className="inventory-empty-state">
          <span className="inventory-empty-icon"><BoxIcon /></span>
          <p className="inventory-empty-title">{tr('No products match "{search}"', { search })}</p>
        </div>
      )}

      {dialogOpen && (
        <div className="dialog-backdrop" onClick={() => setDialogOpen(false)}>
          <form className="dialog inventory-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2 className="inventory-dialog-title">{editId ? tr('Edit product') : tr('Add product')}</h2>
            {dialogError && <div className="error-banner inventory-dialog-span">{dialogError}</div>}
            <div className="field">
              <label htmlFor="prod-sku">SKU</label>
              <input id="prod-sku" className="input" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="prod-name">{tr('Name')}</label>
              <input id="prod-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="prod-category">{tr('Category')}</label>
              <input id="prod-category" className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="prod-unit">{tr('Unit')}</label>
              <input id="prod-unit" className="input" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder={tr('piece, plank, pack')} />
            </div>
            <div className="field">
              <label htmlFor="prod-cost">{tr('Cost price')}</label>
              <input id="prod-cost" className="input" type="number" value={form.costPrice} onChange={(e) => setForm({ ...form, costPrice: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="prod-price">{tr('Selling price')}</label>
              <input id="prod-price" className="input" type="number" value={form.sellingPrice} onChange={(e) => setForm({ ...form, sellingPrice: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="prod-stock">{tr('Opening stock')}</label>
              <input id="prod-stock" className="input" type="number" value={form.currentStock} onChange={(e) => setForm({ ...form, currentStock: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="prod-reorder">{tr('Reorder level')}</label>
              <input id="prod-reorder" className="input" type="number" value={form.reorderLevel} onChange={(e) => setForm({ ...form, reorderLevel: e.target.value })} />
            </div>
            <div className="dialog-actions inventory-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setDialogOpen(false)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{editId ? tr('Save changes') : tr('Add product')}</button>
            </div>
          </form>
        </div>
      )}

      {driveOpen && (
        <DriveImportDialog
          onClose={() => setDriveOpen(false)}
          onImported={() => { setToast(tr('Workbook imported from Google Drive.')); load(); }}
        />
      )}

      {importOpen && (
        <div className="dialog-backdrop" onClick={() => setImportOpen(false)}>
          <div className="dialog inventory-import-dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Import a stock count')}</h2>
            <p className="dialog-body">
              {tr('In the Finish Inventory sheet, open the tab for the day you counted (the tabs named 1, 2, 3 …), then File → Download → Comma-separated values, and upload that file here. Each item and variation becomes a product, with its Physical Count as the stock. Uploading a later day\'s tab updates the stock figures only — prices, reorder levels and names you changed here are kept.')}
            </p>
            <p className="dialog-body">
              {tr('You can also upload the monthly summary tab (e.g. "2026 Sept"): it brings in each day\'s figure as stock history, and its latest day as the stock.')}
            </p>
            <p className="dialog-body">
              {tr('Or bring in a whole month at once: File → Download → Microsoft Excel (.xlsx), and upload that. Every day tab goes onto the daily stock sheet, oldest first.')}
            </p>
            {importError && <div className="error-banner">{importError}</div>}

            {!importPreview && (
              <button type="button" className="inventory-drive-switch" onClick={() => { setImportOpen(false); setDriveOpen(true); }}>
                {tr('Or pick the workbook straight from Google Drive →')}
              </button>
            )}

            {!importPreview && (
              <>
                <div className="field">
                  <label htmlFor="inv-import-file">{tr('CSV file')}</label>
                  <input id="inv-import-file" className="input" type="file" accept=".csv,text/csv,.xlsx" onChange={(e) => setImportFile(e.target.files[0] || null)} />
                </div>
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setImportOpen(false)}>{tr('Cancel')}</button>
                  <button type="button" className="btn btn-primary" disabled={!importFile || importLoading} onClick={() => runImportPreview()}>
                    {importLoading ? tr('Reading…') : tr('Preview import')}
                  </button>
                </div>
              </>
            )}

            {isWorkbookPreview && (
              <>
                <WorkbookPreview
                  preview={importPreview}
                  month={workbookMonth}
                  onMonth={(m) => { setWorkbookMonth(m); if (m) runImportPreview(m); }}
                  mappings={workbookMappings}
                  onMap={(sku, value) => setWorkbookMappings((prev) => ({ ...prev, [sku]: value }))}
                />
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setImportPreview(null)}>{tr('Back')}</button>
                  <button type="button" className="btn btn-secondary" onClick={() => setImportOpen(false)}>{tr('Cancel')}</button>
                  <button type="button" className="btn btn-primary" disabled={importCommitting || importLoading || !workbookDays} onClick={commitImport}>
                    {importCommitting ? tr('Importing…') : tr('Import {n} days', { n: workbookDays })}
                  </button>
                </div>
              </>
            )}

            {importPreview && !isWorkbookPreview && (
              <>
                <div className="inventory-import-summary">
                  <div>
                    {tr('{n} new', { n: importPreview.summary.create })} · {tr('{n} updated', { n: importPreview.summary.update })} · {tr('{n} unchanged', { n: importPreview.summary.unchanged })}
                    {!!importPreview.summary.kept && <> · {tr('{n} kept at their count', { n: importPreview.summary.kept })}</>}
                    {!!importPreview.summary.skipped && <> · {tr('{n} skipped', { n: importPreview.summary.skipped })}</>}
                  </div>
                  {!!importPreview.summary.withWarnings && (
                    <div className="inventory-import-warncount">{tr('{n} need a look — listed first below.', { n: importPreview.summary.withWarnings })}</div>
                  )}
                </div>
                {isSummary ? (
                  <div className="inventory-import-note">
                    {tr('Monthly summary, {from} to {to}. Its figures are the sheet\'s expected closing stock, not a physical count: the stock becomes the {to} figure, each day\'s change goes into the stock history, and products counted on or after {to} keep their count.', { from: formatDate(importPreview.firstDate), to: formatDate(importPreview.countDate) })}
                  </div>
                ) : (
                  <div className="field inventory-import-date">
                    <label htmlFor="inv-count-date">{tr('Count date')}</label>
                    <input id="inv-count-date" className="input" type="date" value={countDate} onChange={(e) => setCountDate(e.target.value)} required />
                  </div>
                )}
                <div className="inventory-import-list">
                  {previewLines.map((l) => (
                    <div key={l.sheetRow} className={'inventory-import-row inventory-import-' + l.action}>
                      <div className="inventory-import-head">
                        <strong>{l.name}</strong>
                        <span className="inventory-import-meta">{l.existingSku || l.sku} · {l.category} · {tr('sheet row {row}', { row: l.sheetRow })}</span>
                        <span className={'tag ' + (l.action === 'create' ? 'tag-neutral' : l.action === 'update' ? 'tag-accent' : 'tag-outline')}>
                          {l.action === 'create' ? tr('New') : l.action === 'update' ? tr('Update') : l.action === 'skip' ? tr('Skipped') : l.action === 'kept' ? tr('Kept') : tr('Unchanged')}
                        </span>
                      </div>
                      {l.stock !== null && (
                        <div className="inventory-import-stock">
                          {l.action === 'kept'
                            ? tr('Counted {n} {unit} on {date}', { n: l.stock, unit: l.unit, date: formatDate(l.countedOn) })
                            : l.action === 'update' && l.stock !== l.previousStock
                              ? trNodes('Stock {from} → {to} {unit}', { from: l.previousStock, to: <strong>{l.stock}</strong>, unit: l.unit })
                              : tr('Stock {n} {unit}', { n: l.stock, unit: l.unit })}
                          {isSummary && !!l.historyDays && (l.action === 'create' || l.action === 'update') && (
                            <span className="inventory-import-history"> · {tr('{n} daily figures added to the stock history', { n: l.historyDays })}</span>
                          )}
                        </div>
                      )}
                      {l.warnings.map((w, wi) => <div key={wi} className="inventory-import-warning">{lineWarning(w)}</div>)}
                    </div>
                  ))}
                </div>
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setImportPreview(null)}>{tr('Back')}</button>
                  <button type="button" className="btn btn-secondary" onClick={() => setImportOpen(false)}>{tr('Cancel')}</button>
                  <button type="button" className="btn btn-primary" disabled={importCommitting || (!toWrite && !canConfirmCount) || !countDate} onClick={commitImport}>
                    {importCommitting ? tr('Importing…') : toWrite ? tr('Import {n} products', { n: toWrite }) : canConfirmCount ? tr('Record the count') : tr('Nothing to import')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
