import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import './ToolRoomPage.css';

// Tool room inventory: tools, equipment and materials — separate from the
// finished-goods Products & Inventory module. Tools/equipment can be
// checked out to an employee; materials are tracked by quantity like
// Products, just scoped to this module instead.

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

  if (loading) return <div className="eyebrow">Loading…</div>;

  const visibleItems = items.filter((it) => matchesQuery(search, it.code, it.name, it.category, it.checkedOutToName));

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="toolroom-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search tools, equipment, materials…" />
        {canManage && <button type="button" className="btn btn-primary" onClick={openNew}>Add item</button>}
      </div>

      <table className="table">
        <thead>
          <tr><th>Code</th><th>Name</th><th>Kind</th><th>Category</th><th>Qty</th><th>Condition</th><th>Status</th><th>Checked out to</th><th /></tr>
        </thead>
        <tbody>
          {visibleItems.map((it) => (
            <tr key={it.id}>
              <td style={{ fontWeight: 600 }}>{it.code}</td>
              <td>{it.name}</td>
              <td>{KIND_LABELS[it.kind]}</td>
              <td>{it.category || '—'}</td>
              <td>{it.quantityOnHand}{it.unit !== 'each' ? ' ' + it.unit : ''} {it.lowStock && <span className="tag tag-accent toolroom-lowstock">Low</span>}</td>
              <td style={{ textTransform: 'capitalize' }}>{it.condition.replace('_', ' ')}</td>
              <td><span className={'tag ' + tagClass(it.status)}>{it.status.replace('_', ' ')}</span></td>
              <td>{it.checkedOutToName || '—'}</td>
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
      {!items.length && <p className="table-empty">No tool room items yet.</p>}
      {!!items.length && !visibleItems.length && <p className="table-empty">No items match "{search}".</p>}

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

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
