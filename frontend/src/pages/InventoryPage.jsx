import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import './InventoryPage.css';
import RowMenu from '../components/RowMenu';

import { tr, trNodes } from '../lib/i18n.jsx';
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
  const [importFile, setImportFile] = useState(null);
  const [importPreview, setImportPreview] = useState(null);
  const [countDate, setCountDate] = useState('');
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

  async function runImportPreview() {
    setImportLoading(true);
    setImportError(null);
    try {
      const fd = new FormData();
      fd.append('file', importFile);
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
  const previewLines = importPreview
    ? importPreview.lines.slice().sort((a, b) =>
      (b.warnings.length > 0) - (a.warnings.length > 0) || IMPORT_ORDER[a.action] - IMPORT_ORDER[b.action] || a.sheetRow - b.sheetRow)
    : [];
  const toWrite = importPreview ? importPreview.summary.create + importPreview.summary.update : 0;
  const isSummary = !!importPreview && importPreview.source === 'summary';
  const canConfirmCount = !!importPreview && !isSummary && importPreview.summary.unchanged > 0;

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="inventory-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder={tr('Search products…')} />
        {canManage && (
          <div className="inventory-toolbar-actions">
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
            {importError && <div className="error-banner">{importError}</div>}

            {!importPreview && (
              <>
                <div className="field">
                  <label htmlFor="inv-import-file">{tr('CSV file')}</label>
                  <input id="inv-import-file" className="input" type="file" accept=".csv,text/csv" onChange={(e) => setImportFile(e.target.files[0] || null)} />
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
