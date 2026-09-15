import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import './PokiPages.css';

// Poki's tenant register. Deliberately separate from Bamboo Products'
// client list: a tenant carries things a sales customer doesn't (ID
// document, next of kin, employer) and shouldn't clutter the furniture
// business's customer search. Underneath, a tenant extends a customer row
// scoped to Poki, which is what lets rent invoices work unchanged.

const EMPTY = {
  name: '', tenantType: 'individual', contactPerson: '', email: '', phone: '', address: '',
  idType: 'Ghana Card', idNumber: '', occupation: '', employer: '',
  emergencyContactName: '', emergencyContactPhone: '', nextOfKinName: '', nextOfKinPhone: '',
  status: 'active', notes: ''
};

export default function PokiTenantsPage() {
  const { can } = useAuth();
  const canManage = can('poki.manage');

  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setTenants(await api.get('/poki/tenants'));
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

  function openDialog(t) {
    setDialogError(null);
    setEditId(t ? t.id : null);
    setForm(t ? { ...EMPTY, ...t } : EMPTY);
    setOpen(true);
  }

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      if (editId) await api.patch('/poki/tenants/' + editId, form);
      else await api.post('/poki/tenants', form);
      setToast(editId ? 'Tenant updated.' : 'Tenant added.');
      setOpen(false);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(t) {
    if (!window.confirm('Delete ' + t.name + '? This cannot be undone.')) return;
    try {
      await api.del('/poki/tenants/' + t.id);
      setToast('Tenant deleted.');
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const visible = tenants.filter((t) =>
    matchesQuery(search, t.name, t.email, t.phone, t.unitLabels) && (!statusFilter || t.status === statusFilter)
  );
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="poki-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search tenants…" />
        <select className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          <option value="prospect">Prospect</option>
          <option value="active">Active</option>
          <option value="former">Former</option>
          <option value="blacklisted">Blacklisted</option>
        </select>
        <div className="poki-toolbar-spacer" />
        {canManage && <button type="button" className="btn btn-primary" onClick={() => openDialog(null)}>Add tenant</button>}
      </div>

      {visible.length === 0 ? (
        <div className="poki-empty">
          <p className="poki-empty-title">{tenants.length ? 'No tenants match' : 'No tenants yet'}</p>
          <p className="poki-empty-sub">
            {tenants.length
              ? 'Try a different search or status filter.'
              : 'Add the people and companies renting from Poki. You can then put them on a booking against a unit.'}
          </p>
        </div>
      ) : (
        <div className="poki-table-wrap">
<table className="table">
          <thead>
            <tr><th>Tenant</th><th>Contact</th><th>ID</th><th>Occupies</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {visible.map((t) => (
              <tr key={t.id}>
                <td>
                  <div className="poki-strong">{t.name}</div>
                  <div className="poki-muted" style={{ textTransform: 'capitalize' }}>{t.tenantType}</div>
                </td>
                <td>
                  <div>{t.phone || <span className="poki-muted">no phone</span>}</div>
                  <div className="poki-muted">{t.email}</div>
                </td>
                <td className="poki-muted poki-nowrap">{t.idNumber ? t.idType + ' · ' + t.idNumber : '—'}</td>
                <td className="poki-nowrap">{t.unitLabels || <span className="poki-muted">—</span>}</td>
                <td><span className={'poki-chip poki-chip-' + t.status}>{t.status}</span></td>
                <td className="table-actions">
                  {canManage && <button type="button" className="btn btn-secondary poki-row-btn" onClick={() => openDialog(t)}>Edit</button>}
                  {canManage && !t.activeBookings && (
                    <button type="button" className="btn btn-secondary poki-row-btn" onClick={() => remove(t)}>Delete</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
</div>
      )}

      {open && (
        <div className="dialog-backdrop" onClick={() => setOpen(false)}>
          <form className="dialog poki-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
            <h2 className="poki-dialog-title">{editId ? 'Edit tenant' : 'Add tenant'}</h2>
            {dialogError && <div className="error-banner poki-dialog-span">{dialogError}</div>}

            <div className="field">
              <label htmlFor="pt-name">Name</label>
              <input id="pt-name" className="input" value={form.name} onChange={set('name')} required />
            </div>
            <div className="field">
              <label htmlFor="pt-type">Type</label>
              <select id="pt-type" className="input" value={form.tenantType} onChange={set('tenantType')}>
                <option value="individual">Individual</option>
                <option value="company">Company</option>
              </select>
            </div>
            {form.tenantType === 'company' && (
              <div className="field poki-dialog-span">
                <label htmlFor="pt-contact">Contact person</label>
                <input id="pt-contact" className="input" value={form.contactPerson} onChange={set('contactPerson')} />
              </div>
            )}
            <div className="field">
              <label htmlFor="pt-phone">Phone</label>
              <input id="pt-phone" className="input" value={form.phone} onChange={set('phone')} placeholder="024 000 0000" />
            </div>
            <div className="field">
              <label htmlFor="pt-email">Email</label>
              <input id="pt-email" className="input" type="email" value={form.email} onChange={set('email')} />
            </div>
            <div className="field poki-dialog-span">
              <label htmlFor="pt-address">Address</label>
              <input id="pt-address" className="input" value={form.address} onChange={set('address')} />
            </div>
            <div className="field">
              <label htmlFor="pt-idtype">ID type</label>
              <input id="pt-idtype" className="input" value={form.idType} onChange={set('idType')} placeholder="Ghana Card / TIN / Passport" />
            </div>
            <div className="field">
              <label htmlFor="pt-idnum">ID number</label>
              <input id="pt-idnum" className="input" value={form.idNumber} onChange={set('idNumber')} />
            </div>
            {form.tenantType === 'individual' && (
              <>
                <div className="field">
                  <label htmlFor="pt-occ">Occupation</label>
                  <input id="pt-occ" className="input" value={form.occupation} onChange={set('occupation')} />
                </div>
                <div className="field">
                  <label htmlFor="pt-emp">Employer</label>
                  <input id="pt-emp" className="input" value={form.employer} onChange={set('employer')} />
                </div>
                <div className="field">
                  <label htmlFor="pt-nok">Next of kin</label>
                  <input id="pt-nok" className="input" value={form.nextOfKinName} onChange={set('nextOfKinName')} />
                </div>
                <div className="field">
                  <label htmlFor="pt-nokp">Next of kin phone</label>
                  <input id="pt-nokp" className="input" value={form.nextOfKinPhone} onChange={set('nextOfKinPhone')} />
                </div>
              </>
            )}
            <div className="field">
              <label htmlFor="pt-emg">Emergency contact</label>
              <input id="pt-emg" className="input" value={form.emergencyContactName} onChange={set('emergencyContactName')} />
            </div>
            <div className="field">
              <label htmlFor="pt-emgp">Emergency phone</label>
              <input id="pt-emgp" className="input" value={form.emergencyContactPhone} onChange={set('emergencyContactPhone')} />
            </div>
            <div className="field">
              <label htmlFor="pt-status">Status</label>
              <select id="pt-status" className="input" value={form.status} onChange={set('status')}>
                <option value="prospect">Prospect</option>
                <option value="active">Active</option>
                <option value="former">Former</option>
                <option value="blacklisted">Blacklisted</option>
              </select>
            </div>
            <div className="field poki-dialog-span">
              <label htmlFor="pt-notes">Notes</label>
              <textarea id="pt-notes" className="input" rows={2} value={form.notes} onChange={set('notes')} />
            </div>
            <div className="poki-dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
