import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import EmployeeIdDocsDialog from '../components/EmployeeIdDocsDialog';
import EmployeeProfileDialog from '../components/EmployeeProfileDialog';
import './EmployeesPage.css';

// Ported from Bamboo OS.dc.html's employee directory screen (screens.people
// block) — search/department filter, show-terminated toggle, the
// add/edit employee dialog, and the terminate + purge-terminated
// confirmation dialogs.

function tagClass(status) {
  if (status === 'terminated') return 'tag-accent';
  if (status === 'active') return 'tag-neutral';
  return 'tag-outline';
}

const EMPLOYMENT_TYPES = [
  { value: 'permanent', label: 'Permanent' },
  { value: 'contract', label: 'Contract' },
  { value: 'casual', label: 'Casual' },
  { value: 'day_rate', label: 'By day' }
];

const EMPTY_EMPLOYEE_FORM = {
  firstName: '', lastName: '', email: '', phone: '', positionTitle: '',
  departmentId: '', managerId: '', hireDate: new Date().toISOString().slice(0, 10),
  employmentType: 'permanent', status: 'active', roleId: '', payCycle: 'monthly', dailyRate: 0
};

export default function EmployeesPage() {
  const { session, can } = useAuth();
  const canWrite = can('employee.write');
  const canPurge = can('role.manage');
  const canManagePayroll = can('payroll.manage');
  const canSync = canWrite && can('department.manage');

  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [managers, setManagers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [showTerminated, setShowTerminated] = useState(false);

  // Debounce the search box so typing doesn't fire a request per keystroke —
  // the prototype's synchronous in-memory kernel had no such cost.
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput), 300);
    return () => clearTimeout(t);
  }, [qInput]);

  const [dialog, setDialog] = useState(null); // 'employee' | 'terminate' | 'purge'
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_EMPLOYEE_FORM);
  const [terminateTarget, setTerminateTarget] = useState(null);
  const [termReason, setTermReason] = useState('');
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [idDocsTarget, setIdDocsTarget] = useState(null);
  const [profileTarget, setProfileTarget] = useState(null);
  const [kioskPinTarget, setKioskPinTarget] = useState(null);
  const [kioskPinValue, setKioskPinValue] = useState('');

  const [syncOpen, setSyncOpen] = useState(false);
  const [syncPreview, setSyncPreview] = useState(null);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncError, setSyncError] = useState(null);
  const [syncCommitting, setSyncCommitting] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [syncEmailEdits, setSyncEmailEdits] = useState({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (deptFilter) params.set('departmentId', deptFilter);
      if (showTerminated) params.set('includeTerminated', 'true');
      const [people, depts] = await Promise.all([
        api.get('/employees?' + params.toString()),
        api.get('/departments')
      ]);
      setEmployees(people);
      setDepartments(depts);
      if (canWrite) {
        const [mgrs, roleList] = await Promise.all([api.get('/employees'), api.get('/roles')]);
        setManagers(mgrs.map((e) => ({ id: e.id, name: e.firstName + ' ' + e.lastName })));
        setRoles(roleList);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [q, deptFilter, showTerminated, canWrite]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  function deptName(id) {
    const d = departments.find((x) => x.id === id);
    return d ? d.name : '—';
  }
  function empName(id) {
    const e = employees.find((x) => x.id === id) || managers.find((x) => x.id === id);
    return e ? (e.name || e.firstName + ' ' + e.lastName) : '—';
  }

  function openNew() {
    setDialogError(null);
    setEditId(null);
    setForm(EMPTY_EMPLOYEE_FORM);
    setDialog('employee');
  }

  function openEdit(emp) {
    setDialogError(null);
    setEditId(emp.id);
    setForm({
      firstName: emp.firstName, lastName: emp.lastName, email: emp.email, phone: emp.phone,
      positionTitle: emp.positionTitle, departmentId: emp.departmentId, managerId: emp.managerId || '',
      hireDate: emp.hireDate, employmentType: emp.employmentType, status: emp.status === 'terminated' ? 'active' : emp.status,
      roleId: '', payCycle: emp.payCycle || 'monthly', dailyRate: emp.dailyRate || 0
    });
    setDialog('employee');
  }

  async function submitEmployee(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      if (editId) {
        const body = {
          firstName: form.firstName, lastName: form.lastName, email: form.email, phone: form.phone,
          positionTitle: form.positionTitle, departmentId: form.departmentId, managerId: form.managerId || null,
          employmentType: form.employmentType, status: form.status
        };
        if (canManagePayroll) {
          body.payCycle = form.payCycle;
          body.dailyRate = form.dailyRate;
        }
        const updated = await api.patch('/employees/' + editId, body);
        setToast('Updated ' + updated.firstName + ' ' + updated.lastName + '.');
      } else {
        const created = await api.post('/employees', {
          firstName: form.firstName, lastName: form.lastName, email: form.email, phone: form.phone,
          positionTitle: form.positionTitle, departmentId: form.departmentId, managerId: form.managerId || null,
          hireDate: form.hireDate, employmentType: form.employmentType,
          createAccount: !!form.roleId, roleId: form.roleId || null
        });
        setToast(created.code + ' — ' + created.firstName + ' ' + created.lastName + ' added.');
      }
      setDialog(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function openTerminate(emp) {
    setDialogError(null);
    setTermReason('');
    setTerminateTarget(emp);
    setDialog('terminate');
  }

  async function confirmTerminate(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      await api.post('/employees/' + terminateTarget.id + '/terminate', { reason: termReason });
      setToast(terminateTarget.firstName + ' ' + terminateTarget.lastName + ' has been terminated.');
      setDialog(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function openKioskPin(emp) {
    setDialogError(null);
    setKioskPinValue('');
    setKioskPinTarget(emp);
    setDialog('kioskPin');
  }

  async function submitKioskPin(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      await api.post('/employees/' + kioskPinTarget.id + '/kiosk-pin', { pin: kioskPinValue });
      setToast('Kiosk PIN set for ' + kioskPinTarget.firstName + ' ' + kioskPinTarget.lastName + '.');
      setDialog(null);
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function clearKioskPin() {
    setSaving(true);
    setDialogError(null);
    try {
      await api.del('/employees/' + kioskPinTarget.id + '/kiosk-pin');
      setToast('Kiosk PIN cleared for ' + kioskPinTarget.firstName + ' ' + kioskPinTarget.lastName + '.');
      setDialog(null);
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function confirmPurge() {
    setSaving(true);
    setDialogError(null);
    try {
      const result = await api.post('/employees/purge-terminated');
      setToast('Permanently removed ' + result.removed + ' employee record(s).');
      setDialog(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function openSync() {
    setSyncError(null);
    setSyncPreview(null);
    setSyncResult(null);
    setSyncEmailEdits({});
    setSyncOpen(true);
    runSyncPreview();
  }

  async function runSyncPreview() {
    setSyncLoading(true);
    setSyncError(null);
    try {
      setSyncPreview(await api.get('/timestation/preview'));
    } catch (err) {
      setSyncError(err.message);
    } finally {
      setSyncLoading(false);
    }
  }

  // A "no email on record" row becomes importable the moment HR types one in
  // here — it's not re-checked against the OS's existing employees until
  // commit, so a typo that collides with someone else still surfaces as a
  // clear per-row failure afterward rather than silently overwriting anyone.
  function syncEffectiveRows() {
    if (!syncPreview) return [];
    return syncPreview.rows.map((r, i) => {
      if (r.skipReason === 'no_email') {
        const edited = (syncEmailEdits[i] || '').trim();
        if (edited) return { ...r, email: edited, willSkip: false, warnings: [] };
      }
      return r;
    });
  }

  // Bulk one-click alternative to typing each address by hand. Uses an
  // obviously-fake domain, never a real one (e.g. @bplghana.com) — this
  // TimeStation account spans several unrelated businesses, so a company
  // domain would be flat-out wrong for most of these people, and nothing in
  // Bamboo OS ever sends real mail to an employee's email address (it's
  // only used as a unique record key), so a placeholder is safe. The
  // TimeStation employee id is folded in so two "John Mensah"s never
  // collide. Only fills rows still blank — anything HR already typed in is
  // left alone.
  function autoFillMissingEmails() {
    if (!syncPreview) return;
    const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const updates = {};
    syncPreview.rows.forEach((r, i) => {
      if (r.skipReason === 'no_email' && !(syncEmailEdits[i] || '').trim()) {
        const idFrag = String(r.timestationEmployeeId || '').replace(/[^a-zA-Z0-9]/g, '').slice(-6).toLowerCase();
        updates[i] = slug(r.firstName) + '.' + slug(r.lastName) + (idFrag ? '.' + idFrag : '.' + i) + '@no-email.placeholder';
      }
    });
    setSyncEmailEdits({ ...syncEmailEdits, ...updates });
  }

  async function commitSync() {
    setSyncCommitting(true);
    setSyncError(null);
    try {
      const result = await api.post('/timestation/commit', { rows: syncEffectiveRows() });
      setSyncResult(result);
      setToast('Imported ' + result.created + ' employee(s) from TimeStation.');
      await load();
    } catch (err) {
      setSyncError(err.message);
    } finally {
      setSyncCommitting(false);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const terminatedCount = employees.filter((e) => e.status === 'terminated').length;
  const footer = employees.length + ' record(s) visible to your role' +
    (can('employee.read.all') ? ' — company-wide access.' : ' — limited to your department and reporting line.');

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="employees-toolbar">
        <div className="field employees-search">
          <label htmlFor="emp-q">Search name, code, job title</label>
          <input id="emp-q" className="input" value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="e.g. operator" />
        </div>
        <div className="field employees-dept-filter">
          <label htmlFor="emp-dept">Department</label>
          <select id="emp-dept" className="input" value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)}>
            <option value="">All departments</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        {canSync && <button type="button" className="btn btn-secondary employees-add-btn" onClick={openSync}>Sync from TimeStation</button>}
        {canWrite && <button type="button" className="btn btn-primary employees-add-btn" onClick={openNew}>Add employee</button>}
      </div>

      <div className="employees-options">
        <label className="employees-checkbox">
          <input type="checkbox" checked={showTerminated} onChange={(e) => setShowTerminated(e.target.checked)} />
          Show terminated employees
        </label>
        {canPurge && terminatedCount > 0 && (
          <button type="button" className="btn btn-secondary" style={{ fontSize: 12 }} onClick={() => { setDialogError(null); setDialog('purge'); }}>
            Remove all deleted employees ({terminatedCount})
          </button>
        )}
      </div>

      <table className="table">
        <thead>
          <tr><th>Code</th><th>Name</th><th>Job title</th><th>Department</th><th>Reports to</th><th>Shift</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {employees.map((p) => {
            const canDelete = canWrite && p.status !== 'terminated' && p.id !== (session && session.employee && session.employee.id);
            return (
              <tr key={p.id}>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{p.code}</td>
                <td style={{ fontWeight: 600 }}>{p.firstName} {p.lastName}</td>
                <td>{p.positionTitle}</td>
                <td>{deptName(p.departmentId)}</td>
                <td>{p.managerId ? empName(p.managerId) : '—'}</td>
                <td className="employees-shift">{p.shift}</td>
                <td><span className={'tag ' + tagClass(p.status)}>{p.status}</span></td>
                <td className="table-actions">
                  <button type="button" className="btn btn-secondary employees-row-btn" onClick={() => setProfileTarget(p.id)}>View</button>
                  {canWrite && <button type="button" className="btn btn-secondary employees-row-btn" onClick={() => openEdit(p)}>Edit</button>}
                  {canWrite && <button type="button" className="btn btn-secondary employees-row-btn" onClick={() => setIdDocsTarget(p)}>ID docs</button>}
                  {canWrite && <button type="button" className="btn btn-secondary employees-row-btn" onClick={() => openKioskPin(p)}>Kiosk PIN</button>}
                  {canDelete && <button type="button" className="btn btn-secondary employees-row-btn" onClick={() => openTerminate(p)}>Delete</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!employees.length && <p className="table-empty">No employees match this filter.</p>}
      <p className="employees-footer">{footer}</p>

      {dialog === 'employee' && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <form className="dialog employees-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitEmployee}>
            <h2 className="employees-dialog-title">{editId ? 'Edit employee' : 'Add employee'}</h2>

            <div className="field"><label htmlFor="emp-fn">First name</label>
              <input id="emp-fn" className="input" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} required />
            </div>
            <div className="field"><label htmlFor="emp-ln">Last name</label>
              <input id="emp-ln" className="input" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} required />
            </div>
            <div className="field"><label htmlFor="emp-em">Work email</label>
              <input id="emp-em" className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            </div>
            <div className="field"><label htmlFor="emp-ph">Phone</label>
              <input id="emp-ph" className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div className="field"><label htmlFor="emp-jt">Job title</label>
              <input id="emp-jt" className="input" value={form.positionTitle} onChange={(e) => setForm({ ...form, positionTitle: e.target.value })} required />
            </div>
            <div className="field"><label htmlFor="emp-dept-sel">Department</label>
              <select id="emp-dept-sel" className="input" value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })} required>
                <option value="" disabled>Choose a department</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div className="field"><label htmlFor="emp-mgr">Reports to</label>
              <select id="emp-mgr" className="input" value={form.managerId} onChange={(e) => setForm({ ...form, managerId: e.target.value })}>
                <option value="">Unassigned</option>
                {managers.filter((m) => m.id !== editId).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
            {!editId && (
              <div className="field"><label htmlFor="emp-hire">Hire date</label>
                <input id="emp-hire" className="input" type="date" value={form.hireDate} onChange={(e) => setForm({ ...form, hireDate: e.target.value })} required />
              </div>
            )}
            <div className="field"><label htmlFor="emp-type">Employment type</label>
              <select id="emp-type" className="input" value={form.employmentType} onChange={(e) => setForm({ ...form, employmentType: e.target.value })}>
                {EMPLOYMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            {editId && (
              <div className="field"><label htmlFor="emp-status">Status</label>
                <select id="emp-status" className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </div>
            )}
            {!editId && (
              <div className="field"><label htmlFor="emp-role">Create a login with role</label>
                <select id="emp-role" className="input" value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })}>
                  <option value="">No system access</option>
                  {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
            )}
            {editId && canManagePayroll && (
              <>
                <div className="field"><label htmlFor="emp-pay-cycle">Pay cycle</label>
                  <select id="emp-pay-cycle" className="input" value={form.payCycle} onChange={(e) => setForm({ ...form, payCycle: e.target.value })}>
                    <option value="monthly">Monthly (5th)</option>
                    <option value="biweekly">Biweekly</option>
                  </select>
                </div>
                <div className="field"><label htmlFor="emp-daily-rate">Daily rate (GHS)</label>
                  <input id="emp-daily-rate" className="input" type="number" min="0" step="0.01" value={form.dailyRate} onChange={(e) => setForm({ ...form, dailyRate: e.target.value })} />
                </div>
              </>
            )}

            {dialogError && <div className="error-banner employees-dialog-span">{dialogError}</div>}

            <div className="dialog-actions employees-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Saving…' : (editId ? 'Save changes' : 'Create')}
              </button>
            </div>
          </form>
        </div>
      )}

      {dialog === 'terminate' && terminateTarget && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={confirmTerminate}>
            <h2>Delete employee</h2>
            <p className="dialog-body">
              This marks <strong>{terminateTarget.firstName} {terminateTarget.lastName}</strong> as terminated and
              disables their login. Their history (attendance, leave, tasks, documents) is kept for records — this
              does not permanently erase them.
            </p>
            <div className="field">
              <label htmlFor="term-reason">Reason (kept in the audit log)</label>
              <input id="term-reason" className="input" value={termReason} onChange={(e) => setTermReason(e.target.value)} placeholder="Resignation, end of contract…" />
            </div>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Delete employee'}</button>
            </div>
          </form>
        </div>
      )}

      {dialog === 'purge' && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Remove all deleted employees</h2>
            <p className="dialog-body">
              This permanently removes all {terminatedCount} terminated employee record(s) and their logins. Unlike
              deleting a single employee, this cannot be undone — their attendance, leave and task history will
              remain but will no longer show a name.
            </p>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={saving} onClick={confirmPurge}>
                {saving ? 'Removing…' : 'Remove permanently'}
              </button>
            </div>
          </div>
        </div>
      )}

      {dialog === 'kioskPin' && kioskPinTarget && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitKioskPin}>
            <h2>Kiosk PIN — {kioskPinTarget.firstName} {kioskPinTarget.lastName}</h2>
            <p className="dialog-body">
              This 4-digit PIN is what {kioskPinTarget.firstName} taps in at the clock-in/out kiosk — no name or
              employee code is entered there, the PIN alone identifies them, so it must be unique across everyone.
            </p>
            <div className="field">
              <label htmlFor="kiosk-pin-input">New PIN (4 digits)</label>
              <input
                id="kiosk-pin-input" className="input" inputMode="numeric" pattern="\d{4}" maxLength={4}
                value={kioskPinValue}
                onChange={(e) => setKioskPinValue(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="e.g. 4471" required
              />
            </div>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={clearKioskPin} disabled={saving}>Clear PIN</button>
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving || kioskPinValue.length !== 4}>
                {saving ? 'Saving…' : 'Save PIN'}
              </button>
            </div>
          </form>
        </div>
      )}

      {syncOpen && (
        <div className="dialog-backdrop" onClick={() => setSyncOpen(false)}>
          <div className="dialog employees-dialog" style={{ gridTemplateColumns: '1fr', maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
            <h2 className="employees-dialog-title">Sync from TimeStation</h2>
            <p className="dialog-body">
              Pulls your live employee list from TimeStation (name, title, department, email, hourly rate, kiosk PIN).
              Departments that don't already exist here are created automatically. Records with no email on
              TimeStation are shown with a blank field below — type one in to import that person, use "Fill in all
              missing emails" to import everyone at once with a placeholder address, or leave a field blank to skip
              just that person. Hourly rate is shown for reference only — HR still sets the real daily rate via
              Payroll. TimeStation's PIN is imported as the kiosk PIN automatically; if it clashes with one already
              in use here, that employee is still created with the PIN left unset for HR to assign manually. Live
              clock in/out status isn't imported — it's a snapshot, not an employment status.
            </p>
            {syncError && <div className="error-banner">{syncError}</div>}

            {syncLoading && <p className="eyebrow">Fetching from TimeStation…</p>}

            {!syncLoading && syncPreview && !syncResult && (() => {
              const effRows = syncEffectiveRows();
              const toCreate = effRows.filter((r) => !r.willSkip).length;
              const missingCount = syncPreview.rows.filter((r, i) => r.skipReason === 'no_email' && !(syncEmailEdits[i] || '').trim()).length;
              return (
                <>
                  <p className="itdevices-import-summary">
                    {effRows.length} employee(s) found on TimeStation —
                    {' '}{toCreate} will be created,
                    {' '}{effRows.length - toCreate} will be skipped.
                    {missingCount > 0 && (
                      <>
                        {' '}<button type="button" className="btn btn-secondary" style={{ fontSize: 12, marginLeft: 8 }} onClick={autoFillMissingEmails}>
                          Fill in all {missingCount} missing email(s) with placeholders
                        </button>
                      </>
                    )}
                  </p>
                  <div className="itdevices-import-scroll">
                    <table className="table itdevices-import-table">
                      <thead>
                        <tr><th>Name</th><th>Title</th><th>Department</th><th>Email</th><th>Rate (ref.)</th><th>Notes</th></tr>
                      </thead>
                      <tbody>
                        {effRows.map((r, i) => (
                          <tr key={i} className={r.willSkip ? 'itdevices-import-row-skip' : ''}>
                            <td style={{ fontWeight: 600 }}>{r.firstName} {r.lastName}</td>
                            <td>{r.positionTitle || '—'}</td>
                            <td>{r.departmentName}{r.departmentWillCreate ? ' (new)' : ''}</td>
                            <td>
                              {syncPreview.rows[i].skipReason === 'no_email' ? (
                                <input
                                  type="email" className="input" style={{ minWidth: 190 }}
                                  value={syncEmailEdits[i] || ''}
                                  onChange={(e) => setSyncEmailEdits({ ...syncEmailEdits, [i]: e.target.value })}
                                  placeholder="Enter email to import…"
                                />
                              ) : (r.email || '—')}
                            </td>
                            <td>{r.hourlyRate ? r.hourlyRate + '/hr' : '—'}</td>
                            <td className="itdevices-import-warnings">
                              {r.warnings.map((w, wi) => <div key={wi}>{w}</div>)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="dialog-actions">
                    <button type="button" className="btn btn-secondary" onClick={() => setSyncOpen(false)}>Cancel</button>
                    <button type="button" className="btn btn-primary" disabled={syncCommitting || !toCreate} onClick={commitSync}>
                      {syncCommitting ? 'Importing…' : 'Import ' + toCreate + ' employee(s)'}
                    </button>
                  </div>
                </>
              );
            })()}

            {syncResult && (
              <>
                <p className="itdevices-import-summary">
                  Imported {syncResult.created} employee(s){syncResult.skipped ? ', skipped ' + syncResult.skipped : ''}
                  {syncResult.failed.length ? ', ' + syncResult.failed.length + ' failed' : ''}.
                </p>
                {syncResult.failed.length > 0 && (
                  <ul>
                    {syncResult.failed.map((f, i) => <li key={i}>{f.name || 'Unnamed record'} — {f.reason}</li>)}
                  </ul>
                )}
                {syncResult.pinIssues && syncResult.pinIssues.length > 0 && (
                  <>
                    <p className="itdevices-import-summary">Kiosk PIN not set for {syncResult.pinIssues.length} employee(s) — set these manually via the Kiosk PIN button:</p>
                    <ul>
                      {syncResult.pinIssues.map((f, i) => <li key={i}>{f.name || 'Unnamed record'} — {f.reason}</li>)}
                    </ul>
                  </>
                )}
                <div className="dialog-actions">
                  <button type="button" className="btn btn-primary" onClick={() => setSyncOpen(false)}>Done</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {idDocsTarget && <EmployeeIdDocsDialog employee={idDocsTarget} onClose={() => setIdDocsTarget(null)} />}
      {profileTarget && <EmployeeProfileDialog employeeId={profileTarget} onClose={() => setProfileTarget(null)} />}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
