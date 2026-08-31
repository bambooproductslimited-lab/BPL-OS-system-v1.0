import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import './ToolRoomPage.css';

// Tool room inventory: tools, equipment and materials — separate from the
// finished-goods Products & Inventory module. Tools/equipment can be
// checked out to an employee; materials are tracked by quantity like
// Products, just scoped to this module instead.
//
// Redesigned around the icon language established elsewhere: a
// category-colored badge per item (wrench for tools/equipment, box for
// materials — mirroring Assets and Inventory respectively), an avatar for
// whoever it's checked out to, icon'd empty states. The add/edit and
// checkout dialogs are untouched.

const AVATAR_COLORS = ['#3f7d3b', '#2f5f2c', '#7d5c3f', '#3f5a7d', '#7d3f5c', '#5c3f7d', '#7d6b3f', '#3f7d6b'];
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return ((parts[0] ? parts[0][0] : '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function avatarColor(name) { return AVATAR_COLORS[hashStr(name || '') % AVATAR_COLORS.length]; }
function badgeColor(name) { return AVATAR_COLORS[hashStr(name || '') % AVATAR_COLORS.length]; }

function WrenchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M14.7 9.3a4 4 0 0 1-5.2 5.2L4 20l-1.5-1.5 5.5-5.5a4 4 0 0 1 5.2-5.2l-2.3 2.3 1.5 1.5 2.3-2.3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}
function BoxIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3.5 20 8 12 12.5 4 8 12 3.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M4 8v8l8 4.5 8-4.5V8" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M12 12.5V21" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
function kindIcon(kind) { return kind === 'material' ? <BoxIcon /> : <WrenchIcon />; }

const KIND_LABELS = { tool: 'Tool', equipment: 'Equipment', material: 'Material' };
const EMPTY_FORM = { code: '', name: '', kind: 'tool', category: '', unit: 'each', quantityOnHand: '', reorderLevel: '', condition: 'good', location: 'Tool room', notes: '' };

function tagClass(status) {
  if (status === 'checked_out') return 'tag-outline';
  if (status === 'retired') return 'tag-accent';
  return 'tag-neutral';
}

export default function ToolRoomPage() {
  const { can } = useAuth();
  const canManage = can('toolroom.manage');

  const [items, setItems] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);

  const [checkoutTarget, setCheckoutTarget] = useState(null);
  const [checkoutEmployeeId, setCheckoutEmployeeId] = useState('');
  const [checkoutError, setCheckoutError] = useState(null);
  const [checkingOut, setCheckingOut] = useState(false);
  const [search, setSearch] = useState('');

  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importPreview, setImportPreview] = useState(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState(null);
  const [importCommitting, setImportCommitting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [rows, emps] = await Promise.all([api.get('/tool-room'), can('employee.read') ? api.get('/employees') : Promise.resolve([])]);
      setItems(rows);
      setEmployees(emps);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [can]);

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

  function openEdit(it) {
    setDialogError(null);
    setEditId(it.id);
    setForm({
      code: it.code, name: it.name, kind: it.kind, category: it.category || '', unit: it.unit,
      quantityOnHand: it.quantityOnHand, reorderLevel: it.reorderLevel, condition: it.condition,
      location: it.location, notes: it.notes || ''
    });
    setDialogOpen(true);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      if (editId) await api.put('/tool-room/' + editId, form);
      else await api.post('/tool-room', form);
      setToast(editId ? 'Item updated.' : 'Item added.');
      setDialogOpen(false);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function openCheckout(it) {
    setCheckoutError(null);
    setCheckoutEmployeeId('');
    setCheckoutTarget(it);
  }

  async function handleCheckout(e) {
    e.preventDefault();
    setCheckingOut(true);
    setCheckoutError(null);
    try {
      await api.post('/tool-room/' + checkoutTarget.id + '/checkout', { employeeId: checkoutEmployeeId });
      setToast(checkoutTarget.name + ' checked out.');
      setCheckoutTarget(null);
      await load();
    } catch (err) {
      setCheckoutError(err.message);
    } finally {
      setCheckingOut(false);
    }
  }

  async function handleCheckIn(it) {
    setBusyId(it.id);
    try {
      await api.post('/tool-room/' + it.id + '/checkout', { employeeId: null });
      setToast(it.name + ' checked in.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  function openImport() {
    setImportError(null);
    setImportFile(null);
    setImportPreview(null);
    setImportOpen(true);
  }

  async function runImportPreview() {
    if (!importFile) return;
    setImportLoading(true);
    setImportError(null);
    setImportPreview(null);
    try {
      const fd = new FormData();
      fd.append('file', importFile);
      setImportPreview(await api.upload('/tool-room/import/preview', fd));
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
      const result = await api.post('/tool-room/import/commit', { rows: importPreview.rows });
      setToast('Imported ' + result.created + ' item(s)' + (result.skipped ? ' (' + result.skipped + ' already existed, skipped).' : '.'));
      setImportOpen(false);
      await load();
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImportCommitting(false);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const visibleItems = items.filter((it) => matchesQuery(search, it.code, it.name, it.category, it.checkedOutToName));

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="toolroom-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search tools, equipment, materials…" />
        {canManage && (
          <div className="toolroom-toolbar-actions">
            <button type="button" className="btn btn-secondary" onClick={openImport}>Import from sheet</button>
            <button type="button" className="btn btn-primary" onClick={openNew}>Add item</button>
          </div>
        )}
      </div>

      <table className="table">
        <thead>
          <tr><th>Code</th><th>Name</th><th>Kind</th><th>Category</th><th>Qty</th><th>Condition</th><th>Status</th><th>Checked out to</th><th /></tr>
        </thead>
        <tbody>
          {visibleItems.map((it) => (
            <tr key={it.id}>
              <td>
                <div className="toolroom-name-cell">
                  <span className="toolroom-badge" style={{ background: badgeColor(it.category || it.kind) }}>{kindIcon(it.kind)}</span>
                  <span style={{ fontWeight: 600 }}>{it.code}</span>
                </div>
              </td>
              <td>{it.name}</td>
              <td>{KIND_LABELS[it.kind]}</td>
              <td>{it.category || '—'}</td>
              <td>{it.quantityOnHand}{it.unit !== 'each' ? ' ' + it.unit : ''} {it.lowStock && <span className="tag tag-accent toolroom-lowstock">Low</span>}</td>
              <td style={{ textTransform: 'capitalize' }}>{it.condition.replace('_', ' ')}</td>
              <td><span className={'tag ' + tagClass(it.status)}>{it.status.replace('_', ' ')}</span></td>
              <td>
                {it.checkedOutToName ? (
                  <div className="toolroom-driver-cell">
                    <span className="toolroom-avatar" style={{ background: avatarColor(it.checkedOutToName) }}>{initials(it.checkedOutToName)}</span>
                    {it.checkedOutToName}
                  </div>
                ) : '—'}
              </td>
              <td className="table-actions">
                {canManage && <button type="button" className="btn btn-secondary toolroom-row-btn" onClick={() => openEdit(it)}>Edit</button>}
                {canManage && it.kind !== 'material' && it.status === 'available' && (
                  <button type="button" className="btn btn-secondary toolroom-row-btn" onClick={() => openCheckout(it)}>Check out</button>
                )}
                {canManage && it.kind !== 'material' && it.status === 'checked_out' && (
                  <button type="button" className="btn btn-secondary toolroom-row-btn" disabled={busyId === it.id} onClick={() => handleCheckIn(it)}>Check in</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!items.length && (
        <div className="toolroom-empty-state">
          <span className="toolroom-empty-icon"><WrenchIcon /></span>
          <p className="toolroom-empty-title">No tool room items yet</p>
        </div>
      )}
      {!!items.length && !visibleItems.length && (
        <div className="toolroom-empty-state">
          <span className="toolroom-empty-icon"><WrenchIcon /></span>
          <p className="toolroom-empty-title">No items match "{search}"</p>
        </div>
      )}

      {dialogOpen && (
        <div className="dialog-backdrop" onClick={() => setDialogOpen(false)}>
          <form className="dialog toolroom-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2 className="toolroom-dialog-title">{editId ? 'Edit item' : 'Add item'}</h2>
            {dialogError && <div className="error-banner toolroom-dialog-span">{dialogError}</div>}
            <div className="field">
              <label htmlFor="tr-code">Code</label>
              <input id="tr-code" className="input" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} disabled={!!editId} placeholder="TR-001" required />
            </div>
            <div className="field">
              <label htmlFor="tr-name">Name</label>
              <input id="tr-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="tr-kind">Kind</label>
              <select id="tr-kind" className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} disabled={!!editId}>
                <option value="tool">Tool</option>
                <option value="equipment">Equipment</option>
                <option value="material">Material</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="tr-category">Category</label>
              <input id="tr-category" className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Power tools, Fasteners…" />
            </div>
            <div className="field">
              <label htmlFor="tr-unit">Unit</label>
              <input id="tr-unit" className="input" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="each, litre, box…" />
            </div>
            <div className="field">
              <label htmlFor="tr-qty">Quantity on hand</label>
              <input id="tr-qty" className="input" type="number" min="0" step="0.01" value={form.quantityOnHand} onChange={(e) => setForm({ ...form, quantityOnHand: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="tr-reorder">Reorder level</label>
              <input id="tr-reorder" className="input" type="number" min="0" step="0.01" value={form.reorderLevel} onChange={(e) => setForm({ ...form, reorderLevel: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="tr-condition">Condition</label>
              <select id="tr-condition" className="input" value={form.condition} onChange={(e) => setForm({ ...form, condition: e.target.value })}>
                <option value="good">Good</option>
                <option value="fair">Fair</option>
                <option value="poor">Poor</option>
                <option value="under_repair">Under repair</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="tr-location">Location</label>
              <input id="tr-location" className="input" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
            </div>
            <div className="field toolroom-dialog-span">
              <label htmlFor="tr-notes">Notes</label>
              <textarea id="tr-notes" className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            <div className="dialog-actions toolroom-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{editId ? 'Save changes' : 'Add item'}</button>
            </div>
          </form>
        </div>
      )}

      {checkoutTarget && (
        <div className="dialog-backdrop" onClick={() => setCheckoutTarget(null)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleCheckout}>
            <h2>Check out {checkoutTarget.name}</h2>
            {checkoutError && <div className="error-banner">{checkoutError}</div>}
            <div className="field">
              <label htmlFor="tr-checkout-emp">Employee</label>
              <select id="tr-checkout-emp" className="input" value={checkoutEmployeeId} onChange={(e) => setCheckoutEmployeeId(e.target.value)} required>
                <option value="" disabled>Select an employee…</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
              </select>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setCheckoutTarget(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={checkingOut}>{checkingOut ? 'Checking out…' : 'Check out'}</button>
            </div>
          </form>
        </div>
      )}

      {importOpen && (
        <div className="dialog-backdrop" onClick={() => setImportOpen(false)}>
          <div className="dialog toolroom-import-dialog" onClick={(e) => e.stopPropagation()}>
            <h2 className="toolroom-dialog-title">Import from tool room sheet</h2>
            <p className="dialog-body">
              Export the sheet as CSV (File → Download → Comma-separated values) and upload it here. Rows without a
              code get one generated automatically; rows whose code already exists are skipped, not overwritten.
            </p>
            {importError && <div className="error-banner">{importError}</div>}

            {!importPreview && (
              <>
                <div className="field">
                  <label htmlFor="tr-import-file">CSV file</label>
                  <input id="tr-import-file" className="input" type="file" accept=".csv,text/csv" onChange={(e) => setImportFile(e.target.files[0] || null)} />
                </div>
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setImportOpen(false)}>Cancel</button>
                  <button type="button" className="btn btn-primary" disabled={!importFile || importLoading} onClick={runImportPreview}>
                    {importLoading ? 'Reading…' : 'Preview import'}
                  </button>
                </div>
              </>
            )}

            {importPreview && (
              <>
                <p className="toolroom-import-summary">
                  {importPreview.rows.length} item row(s) found —
                  {' '}{importPreview.rows.filter((r) => !r.willSkip).length} will be created,
                  {' '}{importPreview.rows.filter((r) => r.willSkip).length} already exist and will be skipped.
                </p>
                <div className="toolroom-import-scroll">
                  <table className="table toolroom-import-table">
                    <thead>
                      <tr><th>Code</th><th>Name</th><th>Kind</th><th>Qty</th><th>Condition</th><th>Notes</th></tr>
                    </thead>
                    <tbody>
                      {importPreview.rows.map((r, i) => (
                        <tr key={i} className={r.willSkip ? 'toolroom-import-row-skip' : ''}>
                          <td style={{ fontWeight: 600 }}>{r.code}</td>
                          <td>{r.name}</td>
                          <td>{KIND_LABELS[r.kind]}</td>
                          <td>{r.quantityOnHand}{r.unit !== 'each' ? ' ' + r.unit : ''}</td>
                          <td style={{ textTransform: 'capitalize' }}>{r.condition.replace('_', ' ')}</td>
                          <td className="toolroom-import-warnings">
                            {r.willSkip && <div>Already exists — will be skipped.</div>}
                            {r.warnings.map((w, wi) => <div key={wi}>{w}</div>)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setImportPreview(null)}>Back</button>
                  <button type="button" className="btn btn-secondary" onClick={() => setImportOpen(false)}>Cancel</button>
                  <button type="button" className="btn btn-primary" disabled={importCommitting} onClick={commitImport}>
                    {importCommitting ? 'Importing…' : 'Import ' + importPreview.rows.filter((r) => !r.willSkip).length + ' item(s)'}
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
