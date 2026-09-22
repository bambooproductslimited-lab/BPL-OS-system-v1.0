import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import EmployeeIdDocsDialog from '../components/EmployeeIdDocsDialog';
import EmployeeProfileDialog from '../components/EmployeeProfileDialog';
import FaceCapture from '../components/FaceCapture';
import './EmployeesPage.css';
import RowMenu from '../components/RowMenu';

import { tr } from '../lib/i18n.jsx';
// Ported from Bamboo OS.dc.html's employee directory screen (screens.people
// block) — search/department filter, show-terminated toggle, the
// add/edit employee dialog, and the terminate + purge-terminated
// confirmation dialogs. The directory list itself is redesigned around the
// avatar/icon language established for Messages/Login/Dashboard; every
// dialog (add/edit, terminate, purge, kiosk PIN, TimeStation sync) is
// left as-is — this page is complex enough already that reskinning the
// list view is the highest-value, lowest-risk change.

function tagClass(status) {
  if (status === 'terminated') return 'tag-accent';
  if (status === 'active') return 'tag-neutral';
  return 'tag-outline';
}

const AVATAR_COLORS = ['#3f7d3b', '#2f5f2c', '#7d5c3f', '#3f5a7d', '#7d3f5c', '#5c3f7d', '#7d6b3f', '#3f7d6b'];
function initials(first, last) { return ((first ? first[0] : '') + (last ? last[0] : '')).toUpperCase(); }
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function avatarColor(name) { return AVATAR_COLORS[hashStr(name) % AVATAR_COLORS.length]; }

// Length of a shift in hours, from HH:MM start/end (overnight shifts wrap
// past midnight) — used only to turn a Daily rate into an Hourly rate, the
// same "span of the shift" convention as hoursBetween() in
// AttendancePage.jsx's report builder.
function shiftSpanHours(startStr, endStr) {
  if (!startStr || !endStr) return null;
  const [sh, sm] = startStr.split(':').map(Number);
  const [eh, em] = endStr.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60;
  return mins / 60;
}

// Prefers the picked shift template's own hours, then the per-employee
// manual override, then a standard 8-hour day when neither is set.
function effectiveShiftHours(form, shifts) {
  const tpl = form.shiftId ? shifts.find((s) => s.id === form.shiftId) : null;
  const hrs = tpl ? shiftSpanHours(tpl.startTime, tpl.endTime) : shiftSpanHours(form.shiftStart, form.shiftEnd);
  return hrs || 8;
}


const EMPLOYMENT_TYPES = [
  { value: 'permanent', label: 'Permanent' },
  { value: 'contract', label: 'Contract' },
  { value: 'casual', label: 'Casual' },
  { value: 'day_rate', label: 'By day' }
];

const EMPTY_EMPLOYEE_FORM = {
  firstName: '', lastName: '', email: '', phone: '', positionTitle: '',
  companyId: '', departmentId: '', shiftId: '', managerId: '', hireDate: new Date().toISOString().slice(0, 10),
  employmentType: 'permanent', status: 'active', roleId: '', payCycle: 'monthly', dailyRate: 0, hourlyRate: '',
  shiftStart: '', shiftEnd: ''
};

export default function EmployeesPage() {
  const { session, can } = useAuth();
  const canWrite = can('employee.write');
  const canPurge = can('role.manage');
  const canManagePayroll = can('payroll.manage');
  const canSync = canWrite && can('department.manage');

  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [managers, setManagers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [companyFilter, setCompanyFilter] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [showTerminated, setShowTerminated] = useState(false);

  // Companies aren't fetched separately here — every department already
  // carries its companyId/companyName (departments.service.js#list), so the
  // company filter and the add/edit dialog's company→department cascade are
  // both derived from the one /departments response instead of a second call.
  const companies = useMemo(() => {
    const seen = new Map();
    departments.forEach((d) => { if (!seen.has(d.companyId)) seen.set(d.companyId, { id: d.companyId, name: d.companyName }); });
    return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [departments]);

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
  const [kioskFaceTarget, setKioskFaceTarget] = useState(null);
  const [kioskFaceStatus, setKioskFaceStatus] = useState(null); // { enrolled, enrolledAt }
  const [kioskFaceCapturing, setKioskFaceCapturing] = useState(false);
  const [faceLinkExpiryDays, setFaceLinkExpiryDays] = useState('3');
  const [faceLinkUrl, setFaceLinkUrl] = useState(null);
  const [faceLinkGenerating, setFaceLinkGenerating] = useState(false);
  const [faceLinkError, setFaceLinkError] = useState(null);
  const [faceLinkCopied, setFaceLinkCopied] = useState(false);
  const [faceLinkWaSending, setFaceLinkWaSending] = useState(false);
  const [faceLinkWaResult, setFaceLinkWaResult] = useState(null);

  const [syncOpen, setSyncOpen] = useState(false);
  const [syncPreview, setSyncPreview] = useState(null);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncError, setSyncError] = useState(null);
  const [syncCommitting, setSyncCommitting] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [syncEmailEdits, setSyncEmailEdits] = useState({});

  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importPreview, setImportPreview] = useState(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState(null);
  const [importCommitting, setImportCommitting] = useState(false);
  const [importResult, setImportResult] = useState(null);

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
        const [mgrs, roleList, shiftList] = await Promise.all([api.get('/employees'), api.get('/roles'), api.get('/shifts')]);
        setManagers(mgrs.map((e) => ({ id: e.id, name: e.firstName + ' ' + e.lastName })));
        setRoles(roleList);
        setShifts(shiftList);
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
  function companyNameOf(departmentId) {
    const d = departments.find((x) => x.id === departmentId);
    return d ? d.companyName : '—';
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
    const dept = departments.find((d) => d.id === emp.departmentId);
    setForm({
      firstName: emp.firstName, lastName: emp.lastName, email: emp.email, phone: emp.phone,
      positionTitle: emp.positionTitle, companyId: dept ? dept.companyId : '', departmentId: emp.departmentId,
      shiftId: emp.shiftId || '', managerId: emp.managerId || '',
      hireDate: emp.hireDate, employmentType: emp.employmentType, status: emp.status === 'terminated' ? 'active' : emp.status,
      roleId: '', payCycle: emp.payCycle || 'monthly', dailyRate: emp.dailyRate || 0,
      hourlyRate: emp.hourlyRate == null ? '' : emp.hourlyRate,
      shiftStart: emp.shiftStart || '', shiftEnd: emp.shiftEnd || ''
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
          positionTitle: form.positionTitle, departmentId: form.departmentId, shiftId: form.shiftId || null, managerId: form.managerId || null,
          employmentType: form.employmentType, status: form.status,
          shiftStart: form.shiftStart, shiftEnd: form.shiftEnd
        };
        if (canManagePayroll) {
          body.payCycle = form.payCycle;
          body.dailyRate = form.dailyRate;
          body.hourlyRate = form.hourlyRate === '' ? null : form.hourlyRate;
        }
        const updated = await api.patch('/employees/' + editId, body);
        setToast('Updated ' + updated.firstName + ' ' + updated.lastName + '.');
      } else {
        const created = await api.post('/employees', {
          firstName: form.firstName, lastName: form.lastName, email: form.email, phone: form.phone,
          positionTitle: form.positionTitle, departmentId: form.departmentId, shiftId: form.shiftId || null, managerId: form.managerId || null,
          hireDate: form.hireDate, employmentType: form.employmentType,
          shiftStart: form.shiftStart, shiftEnd: form.shiftEnd,
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

  async function openKioskFace(emp) {
    setDialogError(null);
    setKioskFaceCapturing(false);
    setKioskFaceTarget(emp);
    setKioskFaceStatus(null);
    setFaceLinkUrl(null);
    setFaceLinkError(null);
    setFaceLinkCopied(false);
    setFaceLinkWaResult(null);
    setDialog('kioskFace');
    try {
      setKioskFaceStatus(await api.get('/employees/' + emp.id + '/kiosk-face'));
    } catch (err) {
      setDialogError(err.message);
    }
  }

  async function submitKioskFace(descriptors) {
    setSaving(true);
    setDialogError(null);
    try {
      await api.post('/employees/' + kioskFaceTarget.id + '/kiosk-face', { descriptors });
      setToast('Face enrolled for ' + kioskFaceTarget.firstName + ' ' + kioskFaceTarget.lastName + '.');
      setKioskFaceCapturing(false);
      setKioskFaceStatus(await api.get('/employees/' + kioskFaceTarget.id + '/kiosk-face'));
    } catch (err) {
      setDialogError(err.message);
      setKioskFaceCapturing(false);
    } finally {
      setSaving(false);
    }
  }

  async function clearKioskFace() {
    setSaving(true);
    setDialogError(null);
    try {
      await api.del('/employees/' + kioskFaceTarget.id + '/kiosk-face');
      setToast('Kiosk face cleared for ' + kioskFaceTarget.firstName + ' ' + kioskFaceTarget.lastName + '.');
      setKioskFaceStatus({ enrolled: false, enrolledAt: null });
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function generateFaceLink() {
    setFaceLinkError(null);
    setFaceLinkGenerating(true);
    setFaceLinkCopied(false);
    setFaceLinkWaResult(null);
    try {
      const res = await api.post('/employees/' + kioskFaceTarget.id + '/kiosk-face-link', { expiresInDays: faceLinkExpiryDays });
      setFaceLinkUrl(window.location.origin + '/enroll-face/' + res.token);
    } catch (err) {
      setFaceLinkError(err.message);
    } finally {
      setFaceLinkGenerating(false);
    }
  }

  async function copyFaceLink() {
    try {
      await navigator.clipboard.writeText(faceLinkUrl);
      setFaceLinkCopied(true);
      setTimeout(() => setFaceLinkCopied(false), 2000);
    } catch { /* clipboard permission denied — link is still selectable text */ }
  }

  async function sendFaceLinkWhatsApp() {
    setFaceLinkWaResult(null);
    setFaceLinkWaSending(true);
    try {
      let url = faceLinkUrl;
      if (!url) {
        const res = await api.post('/employees/' + kioskFaceTarget.id + '/kiosk-face-link', { expiresInDays: faceLinkExpiryDays });
        url = window.location.origin + '/enroll-face/' + res.token;
        setFaceLinkUrl(url);
      }
      await api.post('/employees/' + kioskFaceTarget.id + '/kiosk-face-link/whatsapp', { url });
      setFaceLinkWaResult({ ok: true, message: 'Sent via WhatsApp.' });
    } catch (err) {
      setFaceLinkWaResult({ ok: false, message: err.message });
    } finally {
      setFaceLinkWaSending(false);
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
      setToast('Imported ' + result.created + ' employee(s)' + (result.linked ? ', linked ' + result.linked : '') + ' from TimeStation.');
      await load();
    } catch (err) {
      setSyncError(err.message);
    } finally {
      setSyncCommitting(false);
    }
  }

  function openImport() {
    setImportError(null);
    setImportFile(null);
    setImportPreview(null);
    setImportResult(null);
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
      setImportPreview(await api.upload('/employees/import/preview', fd));
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
      const result = await api.post('/employees/import/commit', { rows: importPreview.rows });
      setImportResult(result);
      setToast('Imported ' + result.created + ' employee(s)' + (result.skipped ? ', skipped ' + result.skipped : '') + (result.failed.length ? ', ' + result.failed.length + ' failed' : '') + ' from spreadsheet.');
      await load();
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImportCommitting(false);
    }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  const terminatedCount = employees.filter((e) => e.status === 'terminated').length;
  const footer = employees.length + ' record(s) visible to your role' +
    (can('employee.read.all') ? ' — company-wide access.' : ' — limited to your group and reporting line.');

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="employees-toolbar">
        <div className="field employees-search">
          <label htmlFor="emp-q">{tr('Search name, code, job title')}</label>
          <div className="search-input-wrap">
            <svg className="search-input-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <circle cx="9" cy="9" r="6.5" stroke="currentColor" strokeWidth="1.6" />
              <path d="M18 18L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <input id="emp-q" className="input search-input" value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder={tr('e.g. operator')} />
            {qInput && <button type="button" className="search-input-clear" aria-label={tr('Clear search')} onClick={() => setQInput('')}>×</button>}
          </div>
        </div>
        <div className="field employees-dept-filter">
          <label htmlFor="emp-company-filter">{tr('Company')}</label>
          <select id="emp-company-filter" className="input" value={companyFilter} onChange={(e) => { setCompanyFilter(e.target.value); setDeptFilter(''); }}>
            <option value="">{tr('All companies')}</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="field employees-dept-filter">
          <label htmlFor="emp-dept">{tr('Department')}</label>
          <select id="emp-dept" className="input" value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)}>
            <option value="">{tr('All departments')}</option>
            {departments.filter((d) => !companyFilter || d.companyId === companyFilter).map((d) => (
              <option key={d.id} value={d.id}>{companyFilter ? d.name : d.name + ' — ' + d.companyName}</option>
            ))}
          </select>
        </div>
        {canSync && <button type="button" className="btn btn-secondary employees-add-btn" onClick={openSync}>{tr('Sync from TimeStation')}</button>}
        {canWrite && <button type="button" className="btn btn-secondary employees-add-btn" onClick={openImport}>{tr('Import from sheet')}</button>}
        {canWrite && <button type="button" className="btn btn-primary employees-add-btn" onClick={openNew}>{tr('Add employee')}</button>}
      </div>

      <div className="employees-options">
        <label className="employees-checkbox">
          <input type="checkbox" checked={showTerminated} onChange={(e) => setShowTerminated(e.target.checked)} />
          {tr('Show terminated employees')}
        </label>
        {canPurge && terminatedCount > 0 && (
          <button type="button" className="btn btn-secondary" style={{ fontSize: 12 }} onClick={() => { setDialogError(null); setDialog('purge'); }}>
            {tr('Remove all deleted employees (')}{terminatedCount})
          </button>
        )}
      </div>

      <table className="table">
        <thead>
          <tr><th>{tr('Code')}</th><th>{tr('Name')}</th><th>{tr('Job title')}</th><th>{tr('Company')}</th><th>{tr('Department')}</th><th>{tr('Reports to')}</th><th>{tr('Shift')}</th><th>{tr('Status')}</th><th /></tr>
        </thead>
        <tbody>
          {employees.map((p) => {
            const canDelete = canWrite && p.status !== 'terminated' && p.id !== (session && session.employee && session.employee.id);
            const menuItems = [
              { label: tr('View'), onClick: () => setProfileTarget(p.id) },
              canWrite && { label: tr('Edit'), onClick: () => openEdit(p) },
              canWrite && { label: tr('ID docs'), onClick: () => setIdDocsTarget(p) },
              canWrite && { label: tr('Kiosk PIN'), onClick: () => openKioskPin(p) },
              canWrite && { label: tr('Kiosk Face'), onClick: () => openKioskFace(p) },
              canDelete && { label: tr('Delete'), onClick: () => openTerminate(p), danger: true }
            ].filter(Boolean);
            return (
              <tr key={p.id}>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{p.code}</td>
                <td>
                  <div className="employees-name-cell">
                    <span className="employees-avatar" style={{ background: avatarColor(p.firstName + ' ' + p.lastName) }}>
                      {initials(p.firstName, p.lastName)}
                    </span>
                    <span style={{ fontWeight: 600 }}>{p.firstName} {p.lastName}</span>
                  </div>
                </td>
                <td>{p.positionTitle}</td>
                <td>{companyNameOf(p.departmentId)}</td>
                <td>{deptName(p.departmentId)}</td>
                <td>{p.managerId ? empName(p.managerId) : '—'}</td>
                <td className="employees-shift">{p.shift}</td>
                <td><span className={'tag ' + tagClass(p.status)}>{p.status}</span></td>
                <td className="table-actions" onClick={(e) => e.stopPropagation()}>
                  <RowMenu actions={menuItems} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!employees.length && (
        <div className="employees-empty-state">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="employees-empty-icon">
            <circle cx="12" cy="8" r="3.4" stroke="currentColor" strokeWidth="1.6" />
            <path d="M4.5 20c0-4.1 3.4-7 7.5-7s7.5 2.9 7.5 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <p className="employees-empty-title">{tr('No employees match this filter')}</p>
          <p className="employees-empty-sub">{tr('Try a different search or group.')}</p>
        </div>
      )}
      <p className="employees-footer">{footer}</p>

      {dialog === 'employee' && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <form className="dialog employees-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitEmployee}>
            <h2 className="employees-dialog-title">{editId ? tr('Edit employee') : tr('Add employee')}</h2>

            <div className="field"><label htmlFor="emp-fn">{tr('First name')}</label>
              <input id="emp-fn" className="input" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} required />
            </div>
            <div className="field"><label htmlFor="emp-ln">{tr('Last name')}</label>
              <input id="emp-ln" className="input" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} required />
            </div>
            <div className="field"><label htmlFor="emp-em">{tr('Work email')}</label>
              <input id="emp-em" className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            </div>
            <div className="field"><label htmlFor="emp-ph">{tr('Phone')}</label>
              <input id="emp-ph" className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div className="field"><label htmlFor="emp-jt">{tr('Job title')}</label>
              <input id="emp-jt" className="input" value={form.positionTitle} onChange={(e) => setForm({ ...form, positionTitle: e.target.value })} required />
            </div>
            <div className="field"><label htmlFor="emp-company-sel">{tr('Company')}</label>
              <select
                id="emp-company-sel" className="input" value={form.companyId}
                onChange={(e) => setForm({ ...form, companyId: e.target.value, departmentId: '', shiftId: '' })}
                required
              >
                <option value="" disabled>{tr('Choose a company')}</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="field"><label htmlFor="emp-dept-sel">{tr('Department')}</label>
              <select
                id="emp-dept-sel" className="input" value={form.departmentId} disabled={!form.companyId}
                onChange={(e) => setForm({ ...form, departmentId: e.target.value, shiftId: '' })}
                required
              >
                <option value="" disabled>{form.companyId ? tr('Choose a department') : tr('Choose a company first')}</option>
                {departments.filter((d) => d.companyId === form.companyId).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div className="field"><label htmlFor="emp-shift-sel">{tr('Shift')}</label>
              <select
                id="emp-shift-sel" className="input" value={form.shiftId} disabled={!form.departmentId}
                onChange={(e) => setForm({ ...form, shiftId: e.target.value })}
              >
                <option value="">{tr('No shift assigned')}</option>
                {shifts.filter((s) => s.departmentId === form.departmentId).map((s) => (
                  <option key={s.id} value={s.id}>{s.name} ({s.startTime}–{s.endTime})</option>
                ))}
              </select>
            </div>
            <div className="field"><label htmlFor="emp-mgr">{tr('Reports to')}</label>
              <select id="emp-mgr" className="input" value={form.managerId} onChange={(e) => setForm({ ...form, managerId: e.target.value })}>
                <option value="">{tr('Unassigned')}</option>
                {managers.filter((m) => m.id !== editId).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
            {!editId && (
              <div className="field"><label htmlFor="emp-hire">{tr('Hire date')}</label>
                <input id="emp-hire" className="input" type="date" value={form.hireDate} onChange={(e) => setForm({ ...form, hireDate: e.target.value })} required />
              </div>
            )}
            <div className="field"><label htmlFor="emp-type">{tr('Employment type')}</label>
              <select id="emp-type" className="input" value={form.employmentType} onChange={(e) => setForm({ ...form, employmentType: e.target.value })}>
                {EMPLOYMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div className="field"><label htmlFor="emp-shift-start">{tr('Shift start')}</label>
              <input id="emp-shift-start" className="input" type="time" value={form.shiftStart} onChange={(e) => setForm({ ...form, shiftStart: e.target.value })} />
            </div>
            <div className="field"><label htmlFor="emp-shift-end">{tr('Shift end')}</label>
              <input id="emp-shift-end" className="input" type="time" value={form.shiftEnd} onChange={(e) => setForm({ ...form, shiftEnd: e.target.value })} />
            </div>
            <p className="employees-dialog-span" style={{ fontSize: 12, color: 'var(--color-text-muted, #667085)', margin: '-8px 0 4px' }}>
              {tr('These are a manual override only — leave blank if the shift picked above already covers it. Attendance uses (in order) the assigned shift\'s start time, then this manual override, then the company default, always with a 20-minute grace period, to decide who\'s marked late.')}
            </p>
            {editId && (
              <div className="field"><label htmlFor="emp-status">{tr('Status')}</label>
                <select id="emp-status" className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                  <option value="active">{tr('Active')}</option>
                  <option value="inactive">{tr('Inactive')}</option>
                </select>
              </div>
            )}
            {!editId && (
              <div className="field"><label htmlFor="emp-role">{tr('Create a login with role')}</label>
                <select id="emp-role" className="input" value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })}>
                  <option value="">{tr('No system access')}</option>
                  {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
            )}
            {editId && canManagePayroll && (
              <>
                <div className="field"><label htmlFor="emp-pay-cycle">{tr('Pay cycle')}</label>
                  <select id="emp-pay-cycle" className="input" value={form.payCycle} onChange={(e) => setForm({ ...form, payCycle: e.target.value })}>
                    <option value="monthly">{tr('Monthly (5th)')}</option>
                    <option value="biweekly">{tr('Biweekly')}</option>
                    <option value="daily">{tr('Daily')}</option>
                  </select>
                </div>
                <div className="field"><label htmlFor="emp-daily-rate">{tr('Daily rate (GHS)')}</label>
                  <input
                    id="emp-daily-rate" className="input" type="number" min="0" step="0.01" value={form.dailyRate}
                    onChange={(e) => {
                      const dailyRate = e.target.value;
                      const hrs = effectiveShiftHours(form, shifts);
                      const hourlyRate = dailyRate === '' ? '' : Math.round((Number(dailyRate) / hrs) * 100) / 100;
                      setForm({ ...form, dailyRate, hourlyRate });
                    }}
                  />
                </div>
                <div className="field">
                  <label htmlFor="emp-hourly-rate">{tr('Hourly rate (GHS)')}</label>
                  <input
                    id="emp-hourly-rate" className="input" type="number" min="0" step="0.01" placeholder={tr('Not set')}
                    value={form.hourlyRate} onChange={(e) => setForm({ ...form, hourlyRate: e.target.value })}
                  />
                  <p style={{ fontSize: 12, color: 'var(--color-text-muted, #667085)', margin: '4px 0 0' }}>
                    {tr('Auto-filled from Daily rate ÷ shift hours (')}{effectiveShiftHours(form, shifts)}{tr('h/day) — edit it directly to override.')}
                  </p>
                </div>
              </>
            )}

            {dialogError && <div className="error-banner employees-dialog-span">{dialogError}</div>}

            <div className="dialog-actions employees-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? tr('Saving…') : (editId ? tr('Save changes') : tr('Create'))}
              </button>
            </div>
          </form>
        </div>
      )}

      {dialog === 'terminate' && terminateTarget && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={confirmTerminate}>
            <h2>{tr('Delete employee')}</h2>
            <p className="dialog-body">
              {tr('This marks')} <strong>{terminateTarget.firstName} {terminateTarget.lastName}</strong> {tr('as terminated and disables their login. Their history (attendance, leave, tasks, documents) is kept for records — this does not permanently erase them.')}
            </p>
            <div className="field">
              <label htmlFor="term-reason">{tr('Reason (kept in the audit log)')}</label>
              <input id="term-reason" className="input" value={termReason} onChange={(e) => setTermReason(e.target.value)} placeholder={tr('Resignation, end of contract…')} />
            </div>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Delete employee')}</button>
            </div>
          </form>
        </div>
      )}

      {dialog === 'purge' && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Remove all deleted employees')}</h2>
            <p className="dialog-body">
              {tr('This permanently removes all')} {terminatedCount} {tr('terminated employee record(s) and their logins. Unlike deleting a single employee, this cannot be undone — their attendance, leave and task history will remain but will no longer show a name.')}
            </p>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={saving} onClick={confirmPurge}>
                {saving ? tr('Removing…') : tr('Remove permanently')}
              </button>
            </div>
          </div>
        </div>
      )}

      {dialog === 'kioskPin' && kioskPinTarget && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitKioskPin}>
            <h2>{tr('Kiosk PIN —')} {kioskPinTarget.firstName} {kioskPinTarget.lastName}</h2>
            <p className="dialog-body">
              {tr('This 4-digit PIN is what')} {kioskPinTarget.firstName} {tr('taps in at the clock-in/out kiosk — no name or employee code is entered there, the PIN alone identifies them, so it must be unique across everyone.')}
            </p>
            <div className="field">
              <label htmlFor="kiosk-pin-input">{tr('New PIN (4 digits)')}</label>
              <input
                id="kiosk-pin-input" className="input" inputMode="numeric" pattern="\d{4}" maxLength={4}
                value={kioskPinValue}
                onChange={(e) => setKioskPinValue(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder={tr('e.g. 4471')} required
              />
            </div>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={clearKioskPin} disabled={saving}>{tr('Clear PIN')}</button>
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving || kioskPinValue.length !== 4}>
                {saving ? tr('Saving…') : tr('Save PIN')}
              </button>
            </div>
          </form>
        </div>
      )}

      {dialog === 'kioskFace' && kioskFaceTarget && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Kiosk face match —')} {kioskFaceTarget.firstName} {kioskFaceTarget.lastName}</h2>
            <p className="dialog-body">
              {tr('Once enrolled,')} {kioskFaceTarget.firstName} {tr('has to look at the kiosk\'s camera to confirm it\'s them every time they tap their PIN — the PIN alone stops being enough. Nothing is stored except the measurements the camera captures right now; no photo is kept.')}
            </p>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            {!kioskFaceCapturing && (
              <>
                <p className="dialog-body">
                  {kioskFaceStatus === null && tr('Loading…')}
                  {kioskFaceStatus && !kioskFaceStatus.enrolled && tr('Not enrolled — the PIN alone still clocks them in and out.')}
                  {kioskFaceStatus && kioskFaceStatus.enrolled && (
                    tr('Enrolled') + (kioskFaceStatus.enrolledAt ? tr(' on ') + new Date(kioskFaceStatus.enrolledAt).toLocaleDateString() : '') + '.'
                  )}
                </p>
                <div className="dialog-actions">
                  {kioskFaceStatus && kioskFaceStatus.enrolled && (
                    <button type="button" className="btn btn-secondary" onClick={clearKioskFace} disabled={saving}>
                      {saving ? tr('Clearing…') : tr('Clear')}
                    </button>
                  )}
                  <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>{tr('Close')}</button>
                  <button type="button" className="btn btn-primary" disabled={kioskFaceStatus === null} onClick={() => setKioskFaceCapturing(true)}>
                    {kioskFaceStatus && kioskFaceStatus.enrolled ? tr('Re-enroll') : tr('Enroll face')}
                  </button>
                </div>

                <div className="employees-face-link">
                  <div className="employees-face-link-head">{tr('Or, send')} {kioskFaceTarget.firstName} {tr('a link to do this themselves')}</div>
                  <p className="dialog-body">
                    {tr('Opens on their own phone and walks them through the same camera steps — no need to hand them this device. The link only works once and expires on its own.')}
                  </p>
                  <div className="employees-face-link-row">
                    <label htmlFor="face-link-expiry">{tr('Expires in')}</label>
                    <select id="face-link-expiry" className="input" value={faceLinkExpiryDays} onChange={(e) => { setFaceLinkExpiryDays(e.target.value); setFaceLinkUrl(null); }}>
                      <option value="1">{tr('1 day')}</option>
                      <option value="3">{tr('3 days')}</option>
                      <option value="7">{tr('7 days')}</option>
                    </select>
                    <button type="button" className="btn btn-secondary" disabled={faceLinkGenerating} onClick={generateFaceLink}>
                      {faceLinkGenerating ? tr('Generating…') : faceLinkUrl ? tr('Regenerate link') : tr('Generate link')}
                    </button>
                    <button type="button" className="btn btn-secondary" disabled={faceLinkWaSending} onClick={sendFaceLinkWhatsApp}>
                      {faceLinkWaSending ? tr('Sending…') : tr('Send via WhatsApp')}
                    </button>
                  </div>
                  {faceLinkError && <div className="error-banner">{faceLinkError}</div>}
                  {faceLinkUrl && (
                    <div className="employees-face-link-url">
                      <input className="input" readOnly value={faceLinkUrl} onFocus={(e) => e.target.select()} />
                      <button type="button" className="btn btn-secondary" onClick={copyFaceLink}>{faceLinkCopied ? tr('Copied!') : tr('Copy')}</button>
                    </div>
                  )}
                  {faceLinkWaResult && <div className={faceLinkWaResult.ok ? 'employees-face-link-wa-ok' : 'error-banner'}>{faceLinkWaResult.message}</div>}
                </div>
              </>
            )}
            {kioskFaceCapturing && (
              <>
                <FaceCapture
                  mode="enroll"
                  title={tr('Look at the camera')}
                  subtitle={tr('Have ') + kioskFaceTarget.firstName + tr(' look straight at the camera, then click Capture — it walks through a few head angles (straight, left, right, up, down), about 10 seconds, to build a reference that holds up at whatever angle they happen to be at the kiosk.')}
                  onCapture={submitKioskFace}
                  onCancel={() => setKioskFaceCapturing(false)}
                />
                {saving && <p className="dialog-body">{tr('Saving…')}</p>}
              </>
            )}
          </div>
        </div>
      )}

      {syncOpen && (
        <div className="dialog-backdrop" onClick={() => setSyncOpen(false)}>
          <div className="dialog employees-dialog" style={{ gridTemplateColumns: '1fr', maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
            <h2 className="employees-dialog-title">{tr('Sync from TimeStation')}</h2>
            <p className="dialog-body">
              {tr('Pulls your live employee list from TimeStation (name, title, group, email, hourly rate, kiosk PIN). Groups that don\'t already exist here are created automatically. Records with no email on TimeStation are shown with a blank field below — type one in to import that person, use "Fill in all missing emails" to import everyone at once with a placeholder address, or leave a field blank to skip just that person. Hourly rate is imported as-is (used by the Attendance report\'s pay column) — HR still sets the real daily rate for Payroll separately. TimeStation\'s PIN is imported as the kiosk PIN automatically; if it clashes with one already in use here, that employee is still created with the PIN left unset for HR to assign manually. Live clock in/out status isn\'t imported — it\'s a snapshot, not an employment status.')}
            </p>
            {syncError && <div className="error-banner">{syncError}</div>}

            {syncLoading && <p className="eyebrow">{tr('Fetching from TimeStation…')}</p>}

            {!syncLoading && syncPreview && !syncResult && (() => {
              const effRows = syncEffectiveRows();
              const toCreate = effRows.filter((r) => !r.willSkip).length;
              const toLink = effRows.filter((r) => r.willSkip && r.willLink).length;
              const toSkip = effRows.length - toCreate - toLink;
              const missingCount = syncPreview.rows.filter((r, i) => r.skipReason === 'no_email' && !(syncEmailEdits[i] || '').trim()).length;
              return (
                <>
                  <p className="itdevices-import-summary">
                    {effRows.length} {tr('employee(s) found on TimeStation —')}
                    {' '}{toCreate} {tr('will be created,')}
                    {toLink > 0 && <>{' '}{toLink} {tr('already imported (will just link for the attendance sync),')}</>}
                    {' '}{toSkip} {tr('will be skipped.')}
                    {missingCount > 0 && (
                      <>
                        {' '}<button type="button" className="btn btn-secondary" style={{ fontSize: 12, marginLeft: 8 }} onClick={autoFillMissingEmails}>
                          {tr('Fill in all')} {missingCount} {tr('missing email(s) with placeholders')}
                        </button>
                      </>
                    )}
                  </p>
                  <div className="itdevices-import-scroll">
                    <table className="table itdevices-import-table">
                      <thead>
                        <tr><th>{tr('Name')}</th><th>{tr('Title')}</th><th>{tr('Group')}</th><th>{tr('Email')}</th><th>{tr('Rate (ref.)')}</th><th>{tr('Notes')}</th></tr>
                      </thead>
                      <tbody>
                        {effRows.map((r, i) => (
                          <tr key={i} className={r.willSkip ? 'itdevices-import-row-skip' : ''}>
                            <td style={{ fontWeight: 600 }}>{r.firstName} {r.lastName}</td>
                            <td>{r.positionTitle || '—'}</td>
                            <td>{r.departmentName}{r.departmentWillCreate ? tr(' (new)') : ''}</td>
                            <td>
                              {syncPreview.rows[i].skipReason === 'no_email' ? (
                                <input
                                  type="email" className="input" style={{ minWidth: 190 }}
                                  value={syncEmailEdits[i] || ''}
                                  onChange={(e) => setSyncEmailEdits({ ...syncEmailEdits, [i]: e.target.value })}
                                  placeholder={tr('Enter email to import…')}
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
                    <button type="button" className="btn btn-secondary" onClick={() => setSyncOpen(false)}>{tr('Cancel')}</button>
                    <button type="button" className="btn btn-primary" disabled={syncCommitting || (!toCreate && !toLink)} onClick={commitSync}>
                      {syncCommitting ? tr('Working…') : toCreate
                        ? tr('Import ') + toCreate + tr(' employee(s)') + (toLink ? tr(' + link ') + toLink : '')
                        : toLink ? tr('Link ') + toLink + tr(' employee(s)') : tr('Nothing to do')}
                    </button>
                  </div>
                </>
              );
            })()}

            {syncResult && (
              <>
                <p className="itdevices-import-summary">
                  {tr('Imported')} {syncResult.created} {tr('employee(s)')}{syncResult.skipped ? tr(', skipped ') + syncResult.skipped : ''}
                  {syncResult.linked ? tr(', linked ') + syncResult.linked + tr(' already-imported record(s) to TimeStation') : ''}
                  {syncResult.failed.length ? ', ' + syncResult.failed.length + tr(' failed') : ''}.
                </p>
                {syncResult.failed.length > 0 && (
                  <ul>
                    {syncResult.failed.map((f, i) => <li key={i}>{f.name || tr('Unnamed record')} — {f.reason}</li>)}
                  </ul>
                )}
                {syncResult.pinIssues && syncResult.pinIssues.length > 0 && (
                  <>
                    <p className="itdevices-import-summary">{tr('Kiosk PIN not set for')} {syncResult.pinIssues.length} {tr('employee(s) — set these manually via the Kiosk PIN button:')}</p>
                    <ul>
                      {syncResult.pinIssues.map((f, i) => <li key={i}>{f.name || tr('Unnamed record')} — {f.reason}</li>)}
                    </ul>
                  </>
                )}
                <div className="dialog-actions">
                  <button type="button" className="btn btn-primary" onClick={() => setSyncOpen(false)}>{tr('Done')}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {importOpen && (
        <div className="dialog-backdrop" onClick={() => setImportOpen(false)}>
          <div className="dialog employees-dialog" style={{ gridTemplateColumns: '1fr', maxWidth: 780 }} onClick={(e) => e.stopPropagation()}>
            <h2 className="employees-dialog-title">{tr('Import from spreadsheet')}</h2>
            <p className="dialog-body">
              {tr('Export an HR sheet as CSV (File → Download → Comma-separated values) with columns for name (or first/ last name), email, job title, company, department and hire date, and upload it here. A row\'s Company column disambiguates department names shared across companies (e.g. every company\'s own "Kitchen"); without it, a department name that exists in more than one company is skipped for you to fix. Unknown departments are never auto-created — create the department first from the Companies screen if it\'s missing.')}
            </p>
            {importError && <div className="error-banner">{importError}</div>}

            {!importPreview && (
              <>
                <div className="field">
                  <label htmlFor="emp-import-file">{tr('CSV file')}</label>
                  <input id="emp-import-file" className="input" type="file" accept=".csv,text/csv" onChange={(e) => setImportFile(e.target.files[0] || null)} />
                </div>
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setImportOpen(false)}>{tr('Cancel')}</button>
                  <button type="button" className="btn btn-primary" disabled={!importFile || importLoading} onClick={runImportPreview}>
                    {importLoading ? tr('Reading…') : tr('Preview import')}
                  </button>
                </div>
              </>
            )}

            {importPreview && !importResult && (() => {
              const toCreate = importPreview.rows.filter((r) => !r.willSkip).length;
              const toSkip = importPreview.rows.length - toCreate;
              return (
                <>
                  <p className="itdevices-import-summary">
                    {importPreview.rows.length} {tr('row(s) found —')} {toCreate} {tr('will be created,')} {toSkip} {tr('will be skipped.')}
                  </p>
                  <div className="itdevices-import-scroll">
                    <table className="table itdevices-import-table">
                      <thead>
                        <tr><th>{tr('Name')}</th><th>{tr('Title')}</th><th>{tr('Company')}</th><th>{tr('Department')}</th><th>{tr('Email')}</th><th>{tr('Notes')}</th></tr>
                      </thead>
                      <tbody>
                        {importPreview.rows.map((r, i) => (
                          <tr key={i} className={r.willSkip ? 'itdevices-import-row-skip' : ''}>
                            <td style={{ fontWeight: 600 }}>{r.firstName} {r.lastName}</td>
                            <td>{r.positionTitle || '—'}</td>
                            <td>{r.companyName || '—'}</td>
                            <td>{r.departmentName || '—'}</td>
                            <td>{r.email || '—'}</td>
                            <td className="itdevices-import-warnings">
                              {r.warnings.map((w, wi) => <div key={wi}>{w}</div>)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="dialog-actions">
                    <button type="button" className="btn btn-secondary" onClick={() => setImportPreview(null)}>{tr('Back')}</button>
                    <button type="button" className="btn btn-secondary" onClick={() => setImportOpen(false)}>{tr('Cancel')}</button>
                    <button type="button" className="btn btn-primary" disabled={importCommitting || !toCreate} onClick={commitImport}>
                      {importCommitting ? tr('Importing…') : toCreate ? tr('Import ') + toCreate + tr(' employee(s)') : tr('Nothing to import')}
                    </button>
                  </div>
                </>
              );
            })()}

            {importResult && (
              <>
                <p className="itdevices-import-summary">
                  {tr('Imported')} {importResult.created} {tr('employee(s)')}{importResult.skipped ? tr(', skipped ') + importResult.skipped : ''}
                  {importResult.failed.length ? ', ' + importResult.failed.length + tr(' failed') : ''}.
                </p>
                {importResult.failed.length > 0 && (
                  <ul>
                    {importResult.failed.map((f, i) => <li key={i}>{f.name || tr('Unnamed record')} — {f.reason}</li>)}
                  </ul>
                )}
                <div className="dialog-actions">
                  <button type="button" className="btn btn-primary" onClick={() => setImportOpen(false)}>{tr('Done')}</button>
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
