import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import './AssetsPage.css';

// Ported from Bamboo OS.dc.html's assets screen (screens.assets block +
// the assets/maintenance computed values, and the "Register asset" /
// "Log maintenance" dialogs around its render()). Assets are register-only
// here — the prototype's asset rows have no edit/delete action, only the
// two toolbar buttons.

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const EMPTY_ASSET_FORM = { category: '', description: '', purchaseDate: '', purchasePrice: '', assignedEmployeeId: '', location: '' };
const EMPTY_MAINT_FORM = { assetId: '', technician: '', cost: '', downtimeHours: '', partsReplaced: '', faultReport: '' };

export default function AssetsPage() {
  const { can } = useAuth();
  const canManage = can('asset.manage');

  const [assets, setAssets] = useState([]);
  const [maintenance, setMaintenance] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [assetDialogOpen, setAssetDialogOpen] = useState(false);
  const [assetForm, setAssetForm] = useState(EMPTY_ASSET_FORM);
  const [assetDialogError, setAssetDialogError] = useState(null);
  const [savingAsset, setSavingAsset] = useState(false);

  const [maintDialogOpen, setMaintDialogOpen] = useState(false);
  const [maintForm, setMaintForm] = useState(EMPTY_MAINT_FORM);
  const [maintDialogError, setMaintDialogError] = useState(null);
  const [savingMaint, setSavingMaint] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [assetRows, maintRows] = await Promise.all([api.get('/assets'), api.get('/maintenance')]);
      setAssets(assetRows);
      setMaintenance(maintRows);
      if (canManage) setEmployees(await api.get('/employees'));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [canManage]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  function openNewAsset() {
    setAssetDialogError(null);
    setAssetForm(EMPTY_ASSET_FORM);
    setAssetDialogOpen(true);
  }

  async function handleCreateAsset(e) {
    e.preventDefault();
    setSavingAsset(true);
    setAssetDialogError(null);
    try {
      await api.post('/assets', { ...assetForm, assignedEmployeeId: assetForm.assignedEmployeeId || null });
      setToast('Asset registered.');
      setAssetDialogOpen(false);
      await load();
    } catch (err) {
      setAssetDialogError(err.message);
    } finally {
      setSavingAsset(false);
    }
  }

  function openNewMaintenance() {
    setMaintDialogError(null);
    setMaintForm({ ...EMPTY_MAINT_FORM, assetId: (assets[0] && assets[0].id) || '' });
    setMaintDialogOpen(true);
  }

  async function handleLogMaintenance(e) {
    e.preventDefault();
    setSavingMaint(true);
    setMaintDialogError(null);
    try {
      await api.post('/maintenance', maintForm);
      setToast('Maintenance record saved.');
      setMaintDialogOpen(false);
      await load();
    } catch (err) {
      setMaintDialogError(err.message);
    } finally {
      setSavingMaint(false);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      {canManage && (
        <div className="assets-toolbar">
          <button type="button" className="btn btn-secondary" onClick={openNewMaintenance}>Log maintenance</button>
          <button type="button" className="btn btn-primary" onClick={openNewAsset}>Register asset</button>
        </div>
      )}

      <table className="table">
        <thead>
          <tr><th>Asset</th><th>Category</th><th>Description</th><th>Assigned to</th><th>Location</th><th>Condition</th><th>Next service</th><th /></tr>
        </thead>
        <tbody>
          {assets.map((a) => (
            <tr key={a.id}>
              <td style={{ fontVariantNumeric: 'tabular-nums' }}>{a.assetNo}</td>
              <td>{a.category}</td>
              <td>{a.description}</td>
              <td>{a.assigneeName}</td>
              <td style={{ fontSize: 12 }}>{a.location}</td>
              <td>{a.condition}</td>
              <td>{fmtDate(a.nextServiceDate)}</td>
              <td><span className={'tag ' + (a.serviceDue ? 'tag-accent' : 'tag-neutral')}>{a.serviceDue ? 'Service due' : 'OK'}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
      {!assets.length && <p className="table-empty">No assets registered yet.</p>}

      <h2 className="assets-section-title">Maintenance history</h2>
      <table className="table">
        <thead>
          <tr><th>Asset</th><th>Date</th><th>Technician</th><th>Cost</th><th>Fault</th><th>Downtime</th><th>Parts</th></tr>
        </thead>
        <tbody>
          {maintenance.map((m) => (
            <tr key={m.id}>
              <td>{m.assetLabel}</td>
              <td>{fmtDate(m.date)}</td>
              <td>{m.technician}</td>
              <td>GHS {m.cost.toLocaleString()}</td>
              <td style={{ fontSize: 13 }}>{m.faultReport}</td>
              <td>{m.downtimeHours}h</td>
              <td>{m.partsReplaced || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!maintenance.length && <p className="table-empty">No maintenance logged yet.</p>}

      {assetDialogOpen && (
        <div className="dialog-backdrop" onClick={() => setAssetDialogOpen(false)}>
          <form className="dialog assets-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleCreateAsset}>
            <h2 className="assets-dialog-title">Register asset</h2>
            {assetDialogError && <div className="error-banner assets-dialog-span">{assetDialogError}</div>}
            <div className="field">
              <label htmlFor="as-category">Category</label>
              <input id="as-category" className="input" value={assetForm.category} onChange={(e) => setAssetForm({ ...assetForm, category: e.target.value })} placeholder="Machinery, Vehicle, Computer…" required />
            </div>
            <div className="field">
              <label htmlFor="as-desc">Description</label>
              <input id="as-desc" className="input" value={assetForm.description} onChange={(e) => setAssetForm({ ...assetForm, description: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="as-date">Purchase date</label>
              <input id="as-date" className="input" type="date" value={assetForm.purchaseDate} onChange={(e) => setAssetForm({ ...assetForm, purchaseDate: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="as-price">Purchase price</label>
              <input id="as-price" className="input" type="number" value={assetForm.purchasePrice} onChange={(e) => setAssetForm({ ...assetForm, purchasePrice: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="as-assignee">Assigned to</label>
              <select id="as-assignee" className="input" value={assetForm.assignedEmployeeId} onChange={(e) => setAssetForm({ ...assetForm, assignedEmployeeId: e.target.value })}>
                <option value="">Unassigned</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="as-location">Location</label>
              <input id="as-location" className="input" value={assetForm.location} onChange={(e) => setAssetForm({ ...assetForm, location: e.target.value })} />
            </div>
            <div className="dialog-actions assets-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setAssetDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={savingAsset}>Register</button>
            </div>
          </form>
        </div>
      )}

      {maintDialogOpen && (
        <div className="dialog-backdrop" onClick={() => setMaintDialogOpen(false)}>
          <form className="dialog assets-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleLogMaintenance}>
            <h2 className="assets-dialog-title">Log maintenance</h2>
            {maintDialogError && <div className="error-banner assets-dialog-span">{maintDialogError}</div>}
            <div className="field assets-dialog-span">
              <label htmlFor="mt-asset">Asset</label>
              <select id="mt-asset" className="input" value={maintForm.assetId} onChange={(e) => setMaintForm({ ...maintForm, assetId: e.target.value })} required>
                {assets.map((a) => <option key={a.id} value={a.id}>{a.assetNo} — {a.description}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="mt-tech">Technician</label>
              <input id="mt-tech" className="input" value={maintForm.technician} onChange={(e) => setMaintForm({ ...maintForm, technician: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="mt-cost">Cost (GHS)</label>
              <input id="mt-cost" className="input" type="number" value={maintForm.cost} onChange={(e) => setMaintForm({ ...maintForm, cost: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="mt-downtime">Downtime (hours)</label>
              <input id="mt-downtime" className="input" type="number" value={maintForm.downtimeHours} onChange={(e) => setMaintForm({ ...maintForm, downtimeHours: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="mt-parts">Parts replaced</label>
              <input id="mt-parts" className="input" value={maintForm.partsReplaced} onChange={(e) => setMaintForm({ ...maintForm, partsReplaced: e.target.value })} />
            </div>
            <div className="field assets-dialog-span">
              <label htmlFor="mt-fault">Fault report</label>
              <textarea id="mt-fault" className="input" value={maintForm.faultReport} onChange={(e) => setMaintForm({ ...maintForm, faultReport: e.target.value })} required />
            </div>
            <div className="dialog-actions assets-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setMaintDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={savingMaint}>Save record</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
