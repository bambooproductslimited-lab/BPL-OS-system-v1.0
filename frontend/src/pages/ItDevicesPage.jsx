import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import './ItDevicesPage.css';

// IT device inventory: company laptops/desktops/phones/monitors/etc, owned
// and tracked by IT specifically — separate from the general Assets &
// Maintenance module.

const EMPTY_FORM = {
  deviceTag: '', category: '', brand: '', model: '', serialNumber: '', assignedEmployeeId: '', departmentId: '',
  location: '', purchaseDate: '', purchasePrice: '', warrantyUntil: '', condition: 'good', status: 'in_use', notes: ''
};

function tagClass(status) {
  if (status === 'in_use') return 'tag-neutral';
  if (status === 'in_storage') return 'tag-outline';
  if (status === 'lost' || status === 'retired') return 'tag-accent';
  return 'tag-outline';
}

export default function ItDevicesPage() {
  const { can } = useAuth();
  const canManage = can('itdevice.manage');

  const [devices, setDevices] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
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
  const [importIncludeCreds, setImportIncludeCreds] = useState(false);
  const [importPreview, setImportPreview] = useState(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState(null);
  const [importCommitting, setImportCommitting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [rows, emps, depts] = await Promise.all([
        api.get('/it-devices'),
        can('employee.read') ? api.get('/employees') : Promise.resolve([]),
        api.get('/departments')
      ]);
      setDevices(rows);
      setEmployees(emps);
      setDepartments(depts);
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

  function openEdit(d) {
    setDialogError(null);
    setEditId(d.id);
    setForm({
      deviceTag: d.deviceTag, category: d.category, brand: d.brand || '', model: d.model || '', serialNumber: d.serialNumber || '',
      assignedEmployeeId: d.assignedEmployeeId || '', departmentId: d.departmentId || '', location: d.location || '',
      purchaseDate: d.purchaseDate || '', purchasePrice: d.purchasePrice || '', warrantyUntil: d.warrantyUntil || '',
      condition: d.condition, status: d.status, notes: d.notes || ''
    });
    setDialogOpen(true);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      const body = { ...form, assignedEmployeeId: form.assignedEmployeeId || null, departmentId: form.departmentId || null };
      if (editId) await api.put('/it-devices/' + editId, body);
      else await api.post('/it-devices', body);
      setToast(editId ? 'Device updated.' : 'Device registered.');
      setDialogOpen(false);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function openImport() {
    setImportError(null);
    setImportFile(null);
    setImportPreview(null);
    setImportIncludeCreds(false);
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
      fd.append('includeCredentials', importIncludeCreds ? 'true' : 'false');
      setImportPreview(await api.upload('/it-devices/import/preview', fd));
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
      const result = await api.post('/it-devices/import/commit', { rows: importPreview.rows });
      setToast('Imported ' + result.created + ' device(s)' + (result.skipped ? ' (' + result.skipped + ' already existed, skipped).' : '.'));
      setImportOpen(false);
      await load();
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImportCommitting(false);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const visibleDevices = devices.filter((d) => matchesQuery(search, d.deviceTag, d.category, d.brand, d.model, d.serialNumber, d.assigneeName));

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="itdevices-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search devices…" />
        {canManage && (
          <div className="itdevices-toolbar-actions">
            <button type="button" className="btn btn-secondary" onClick={openImport}>Import from sheet</button>
            <button type="button" className="btn btn-primary" onClick={openNew}>Register device</button>
          </div>
        )}
      </div>

      <table className="table">
        <thead>
          <tr><th>Tag</th><th>Category</th><th>Brand / model</th><th>Serial</th><th>Assigned to</th><th>Condition</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {visibleDevices.map((d) => (
            <tr key={d.id}>
              <td style={{ fontWeight: 600 }}>{d.deviceTag}</td>
              <td>{d.category}</td>
              <td>{(d.brand + ' ' + d.model).trim() || '—'}</td>
              <td className="itdevices-serial">{d.serialNumber || '—'}</td>
              <td>{d.assigneeName}</td>
              <td style={{ textTransform: 'capitalize' }}>{d.condition}</td>
              <td><span className={'tag ' + tagClass(d.status)}>{d.status.replace('_', ' ')}</span></td>
              <td className="table-actions">
                {canManage && <button type="button" className="btn btn-secondary itdevices-row-btn" onClick={() => openEdit(d)}>Edit</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!devices.length && <p className="table-empty">No devices registered yet.</p>}
      {!!devices.length && !visibleDevices.length && <p className="table-empty">No devices match "{search}".</p>}

      {dialogOpen && (
        <div className="dialog-backdrop" onClick={() => setDialogOpen(false)}>
          <form className="dialog itdevices-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2 className="itdevices-dialog-title">{editId ? 'Edit device' : 'Register device'}</h2>
            {dialogError && <div className="error-banner itdevices-dialog-span">{dialogError}</div>}
            <div className="field">
              <label htmlFor="it-tag">Device tag</label>
              <input id="it-tag" className="input" value={form.deviceTag} onChange={(e) => setForm({ ...form, deviceTag: e.target.value })} placeholder="Auto-generated if left blank" disabled={!!editId} />
            </div>
            <div className="field">
              <label htmlFor="it-category">Category</label>
              <input id="it-category" className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Laptop, Phone, Printer…" required />
            </div>
            <div className="field">
              <label htmlFor="it-brand">Brand</label>
              <input id="it-brand" className="input" value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="it-model">Model</label>
              <input id="it-model" className="input" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="it-serial">Serial number</label>
              <input id="it-serial" className="input" value={form.serialNumber} onChange={(e) => setForm({ ...form, serialNumber: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="it-location">Location</label>
              <input id="it-location" className="input" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="it-assignee">Assigned to</label>
              <select id="it-assignee" className="input" value={form.assignedEmployeeId} onChange={(e) => setForm({ ...form, assignedEmployeeId: e.target.value })}>
                <option value="">Unassigned</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="it-department">Department</label>
              <select id="it-department" className="input" value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })}>
                <option value="">Unassigned</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="it-purchase-date">Purchase date</label>
              <input id="it-purchase-date" className="input" type="date" value={form.purchaseDate} onChange={(e) => setForm({ ...form, purchaseDate: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="it-purchase-price">Purchase price (GHS)</label>
              <input id="it-purchase-price" className="input" type="number" min="0" step="0.01" value={form.purchasePrice} onChange={(e) => setForm({ ...form, purchasePrice: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="it-warranty">Warranty until</label>
              <input id="it-warranty" className="input" type="date" value={form.warrantyUntil} onChange={(e) => setForm({ ...form, warrantyUntil: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="it-condition">Condition</label>
              <select id="it-condition" className="input" value={form.condition} onChange={(e) => setForm({ ...form, condition: e.target.value })}>
                <option value="good">Good</option>
                <option value="fair">Fair</option>
                <option value="poor">Poor</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="it-status">Status</label>
              <select id="it-status" className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                <option value="in_use">In use</option>
                <option value="in_storage">In storage</option>
                <option value="under_repair">Under repair</option>
                <option value="retired">Retired</option>
                <option value="lost">Lost</option>
              </select>
            </div>
            <div className="field itdevices-dialog-span">
              <label htmlFor="it-notes">Notes</label>
              <textarea id="it-notes" className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            <div className="dialog-actions itdevices-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{editId ? 'Save changes' : 'Register device'}</button>
            </div>
          </form>
        </div>
      )}

      {importOpen && (
        <div className="dialog-backdrop" onClick={() => setImportOpen(false)}>
          <div className="dialog itdevices-import-dialog" onClick={(e) => e.stopPropagation()}>
            <h2 className="itdevices-dialog-title">Import from IT inventory sheet</h2>
            <p className="dialog-body">
              Export the sheet as CSV (File → Download → Comma-separated values) and upload it here. A sheet row
              with a Total greater than 1 becomes that many individual devices, all sharing the same brand/model.
            </p>
            {importError && <div className="error-banner">{importError}</div>}

            {!importPreview && (
              <>
                <div className="field">
                  <label htmlFor="it-import-file">CSV file</label>
                  <input id="it-import-file" className="input" type="file" accept=".csv,text/csv" onChange={(e) => setImportFile(e.target.files[0] || null)} />
                </div>
                <label className="checkbox-field">
                  <input type="checkbox" checked={importIncludeCreds} onChange={(e) => setImportIncludeCreds(e.target.checked)} />
                  Include device usernames/passcodes from the sheet in notes (not recommended — stored as plain text)
                </label>
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
                <p className="itdevices-import-summary">
                  {importPreview.rows.length} device row(s) found —
                  {' '}{importPreview.rows.filter((r) => !r.willSkip).length} will be created,
                  {' '}{importPreview.rows.filter((r) => r.willSkip).length} already exist and will be skipped.
                </p>
                <div className="itdevices-import-scroll">
                  <table className="table itdevices-import-table">
                    <thead>
                      <tr><th>Tag</th><th>Brand / model</th><th>Status</th><th>Assigned / location</th><th>Notes</th></tr>
                    </thead>
                    <tbody>
                      {importPreview.rows.map((r, i) => (
                        <tr key={i} className={r.willSkip ? 'itdevices-import-row-skip' : ''}>
                          <td style={{ fontWeight: 600 }}>{r.deviceTag}</td>
                          <td>{(r.brand + ' ' + r.model).trim() || '—'}</td>
                          <td style={{ textTransform: 'capitalize' }}>{r.status.replace('_', ' ')}</td>
                          <td>{r.location || (r.assignedEmployeeId ? 'Matched employee' : '—')}</td>
                          <td className="itdevices-import-warnings">
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
                    {importCommitting ? 'Importing…' : 'Import ' + importPreview.rows.filter((r) => !r.willSkip).length + ' device(s)'}
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
