import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import './PayrollPage.css';

// Payroll: employees are paid a daily rate on one of three cycles (monthly,
// paid on the 5th; biweekly; or daily, for staff paid per day worked). A
// pay run auto-computes each employee's
// days worked from Attendance and their SSNIT/PAYE deductions — see
// backend/src/services/payroll.service.js. Days worked stays editable
// while the run is a draft (e.g. to correct for unpaid leave not yet
// reflected in Attendance), then locks once approved.

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtMoney(n) { return 'GHS ' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function todayISO() { return new Date().toISOString().slice(0, 10); }

function tagClass(status) {
  if (status === 'paid') return 'tag-neutral';
  if (status === 'approved') return 'tag-outline';
  return 'tag-outline';
}

const EMPTY_FORM = { cycle: 'monthly', periodStart: '', periodEnd: '', payDate: todayISO() };

export default function PayrollPage() {
  const { can } = useAuth();
  const canManage = can('payroll.manage');

  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);

  const [activeRun, setActiveRun] = useState(null);
  const [runError, setRunError] = useState(null);
  const [runBusy, setRunBusy] = useState(false);
  const [editingSlip, setEditingSlip] = useState(null);
  const [editDays, setEditDays] = useState('');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      setRuns(await api.get('/payroll/runs'));
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
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      const created = await api.post('/payroll/runs', form);
      setToast(created.runNo + ' created with ' + created.payslips.length + ' payslip(s).');
      setDialogOpen(false);
      await load();
      setActiveRun(created);
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function openRun(r) {
    setRunError(null);
    try {
      setActiveRun(await api.get('/payroll/runs/' + r.id));
    } catch (err) {
      setError(err.message);
    }
  }

  function startEditSlip(slip) {
    setRunError(null);
    setEditingSlip(slip.employeeId);
    setEditDays(String(slip.daysWorked));
  }

  async function saveSlipEdit(employeeId) {
    setRunBusy(true);
    setRunError(null);
    try {
      const updated = await api.put('/payroll/runs/' + activeRun.id + '/payslips/' + employeeId, { daysWorked: editDays });
      setActiveRun(updated);
      setEditingSlip(null);
      await load();
    } catch (err) {
      setRunError(err.message);
    } finally {
      setRunBusy(false);
    }
  }

  async function approveRun() {
    setRunBusy(true);
    setRunError(null);
    try {
      const updated = await api.post('/payroll/runs/' + activeRun.id + '/approve');
      setActiveRun(updated);
      setToast(updated.runNo + ' approved.');
      await load();
    } catch (err) {
      setRunError(err.message);
    } finally {
      setRunBusy(false);
    }
  }

  async function markPaid() {
    setRunBusy(true);
    setRunError(null);
    try {
      const updated = await api.post('/payroll/runs/' + activeRun.id + '/paid');
      setActiveRun(updated);
      setToast(updated.runNo + ' marked paid.');
      await load();
    } catch (err) {
      setRunError(err.message);
    } finally {
      setRunBusy(false);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const visibleRuns = runs.filter((r) => matchesQuery(search, r.runNo, r.cycle, r.status));

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      {canManage && (
        <div className="payroll-toolbar">
          <button type="button" className="btn btn-primary" onClick={openNew}>New pay run</button>
        </div>
      )}

      <SearchInput value={search} onChange={setSearch} placeholder="Search pay runs…" />

      <table className="table" style={{ marginTop: 16 }}>
        <thead>
          <tr><th>Run</th><th>Cycle</th><th>Period</th><th>Pay date</th><th>Employees</th><th>Total net</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {visibleRuns.map((r) => (
            <tr key={r.id}>
              <td style={{ fontWeight: 600 }}>{r.runNo}</td>
              <td style={{ textTransform: 'capitalize' }}>{r.cycle}</td>
              <td>{fmtDate(r.periodStart)} – {fmtDate(r.periodEnd)}</td>
              <td>{fmtDate(r.payDate)}</td>
              <td>{r.employeeCount}</td>
              <td>{fmtMoney(r.totalNet)}</td>
              <td><span className={'tag ' + tagClass(r.status)}>{r.status}</span></td>
              <td className="table-actions">
                <button type="button" className="btn btn-secondary payroll-row-btn" onClick={() => openRun(r)}>View</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!runs.length && <p className="table-empty">No pay runs yet.</p>}
      {!!runs.length && !visibleRuns.length && <p className="table-empty">No pay runs match "{search}".</p>}

      {dialogOpen && (
        <div className="dialog-backdrop" onClick={() => setDialogOpen(false)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2>New pay run</h2>
            <p className="dialog-body">Generates one payslip per active employee on the chosen cycle, with days worked pulled automatically from Attendance for the period.</p>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="field">
              <label htmlFor="pr-cycle">Cycle</label>
              <select id="pr-cycle" className="input" value={form.cycle} onChange={(e) => setForm({ ...form, cycle: e.target.value })}>
                <option value="monthly">Monthly</option>
                <option value="biweekly">Biweekly</option>
                <option value="daily">Daily</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="pr-start">Period start</label>
              <input id="pr-start" className="input" type="date" value={form.periodStart} onChange={(e) => setForm({ ...form, periodStart: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="pr-end">Period end</label>
              <input id="pr-end" className="input" type="date" value={form.periodEnd} onChange={(e) => setForm({ ...form, periodEnd: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="pr-paydate">Pay date</label>
              <input id="pr-paydate" className="input" type="date" value={form.payDate} onChange={(e) => setForm({ ...form, payDate: e.target.value })} required />
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Generating…' : 'Generate pay run'}</button>
            </div>
          </form>
        </div>
      )}

      {activeRun && (
        <div className="dialog-backdrop" onClick={() => setActiveRun(null)}>
          <div className="dialog payroll-run-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="payroll-run-head">
              <div>
                <h2 className="payroll-run-title">{activeRun.runNo}</h2>
                <div className="payroll-run-sub">
                  {activeRun.cycle} · {fmtDate(activeRun.periodStart)} – {fmtDate(activeRun.periodEnd)} · Pay date {fmtDate(activeRun.payDate)}
                </div>
              </div>
              <span className={'tag ' + tagClass(activeRun.status)}>{activeRun.status}</span>
            </div>

            {runError && <div className="error-banner">{runError}</div>}

            <table className="table payroll-slip-table">
              <thead>
                <tr><th>Employee</th><th>Days</th><th>Rate</th><th>Gross</th><th>SSNIT</th><th>PAYE</th><th>Net</th><th /></tr>
              </thead>
              <tbody>
                {activeRun.payslips.map((s) => (
                  <tr key={s.employeeId}>
                    <td>{s.employeeName}<div className="payroll-slip-code">{s.employeeCode}</div></td>
                    <td>
                      {editingSlip === s.employeeId ? (
                        <input className="input payroll-days-input" type="number" min="0" step="0.5" value={editDays} onChange={(e) => setEditDays(e.target.value)} />
                      ) : s.daysWorked}
                    </td>
                    <td>{fmtMoney(s.dailyRate)}</td>
                    <td>{fmtMoney(s.grossPay)}</td>
                    <td>{fmtMoney(s.ssnitEmployee)}</td>
                    <td>{fmtMoney(s.payeTax)}</td>
                    <td style={{ fontWeight: 600 }}>{fmtMoney(s.netPay)}</td>
                    <td className="table-actions">
                      {canManage && activeRun.status === 'draft' && (
                        editingSlip === s.employeeId ? (
                          <button type="button" className="btn btn-secondary payroll-row-btn" disabled={runBusy} onClick={() => saveSlipEdit(s.employeeId)}>Save</button>
                        ) : (
                          <button type="button" className="btn btn-secondary payroll-row-btn" onClick={() => startEditSlip(s)}>Edit</button>
                        )
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setActiveRun(null)}>Close</button>
              {canManage && activeRun.status === 'draft' && (
                <button type="button" className="btn btn-primary" disabled={runBusy} onClick={approveRun}>{runBusy ? 'Approving…' : 'Approve'}</button>
              )}
              {canManage && activeRun.status === 'approved' && (
                <button type="button" className="btn btn-primary" disabled={runBusy} onClick={markPaid}>{runBusy ? 'Saving…' : 'Mark paid'}</button>
              )}
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
