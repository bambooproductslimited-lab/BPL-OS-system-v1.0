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

  if (loading) return <div className="eyebrow">Loading…</div>;

  const visibleDevices = devices.filter((d) => matchesQuery(search, d.deviceTag, d.category, d.brand, d.model, d.serialNumber, d.assigneeName));

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="itdevices-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search devices…" />
        {canManage && <button type="button" className="btn btn-primary" onClick={openNew}>Register device</button>}
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

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
