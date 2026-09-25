import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import EmployeeIdDocsDialog from '../components/EmployeeIdDocsDialog';
import EmployeeProfileDialog from '../components/EmployeeProfileDialog';
import FaceCapture from '../components/FaceCapture';
import Photo, { forgetBlob } from '../components/Photo';
import PhotoDialog from '../components/PhotoDialog';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { CompanySwitcher, Glossary, Hero, Insights, Section, Status, fmtDate, jump } from '../components/DashKit';
import './EmployeesPage.css';
import RowMenu from '../components/RowMenu';

import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
// The employee directory. Same "explains itself" layout as the dashboards
// (components/DashKit.jsx): a company switcher, a header with the key
// numbers (press one to show only those people), what stands out, the
// groups at a glance, then everyone — as cards with their photo and
// one-tap call / WhatsApp / email / message, or as a compact list. Every
// HR dialog (add/edit, import, TimeStation sync, kiosk PIN and face, ID
// docs, delete, purge) works as before.

const PPL_PATHS = {
  phone: <path d="M6.5 4h3l1.5 4-2 1.2a10 10 0 0 0 5.8 5.8L16 13l4 1.5v3a2 2 0 0 1-2.2 2A15.5 15.5 0 0 1 4.5 6.2 2 2 0 0 1 6.5 4z" />,
  mail: <><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="m4 7 8 6 8-6" /></>,
  chat: <path d="M4.5 18.5 5.6 15A7 7 0 1 1 8.9 17.6z" />,
  whatsapp: <><path d="M4 20l1.2-4.1A8 8 0 1 1 8.3 19z" /><path d="M9 8.6c0 3.3 3 6.4 6.4 6.4l1-1.6-2-1-1 .9a4.4 4.4 0 0 1-2.7-2.7l.9-1-1-2z" /></>,
  grid: <><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></>,
  list: <path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5v.1M4.5 12v.1M4.5 17.5v.1" />
};
function PIcon({ name }) {
  return (
    <svg className="dk-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PPL_PATHS[name]}
    </svg>
  );
}

const NEW_DAYS = 30;
function daysSince(iso) {
  if (!iso) return null;
  const d = new Date(String(iso).slice(0, 10) + 'T00:00');
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((new Date(new Date().toDateString()) - d) / 86400000);
}
// A Ghanaian number as WhatsApp wants it (233…), or null when it cannot be
// read as a full number.
function waNumber(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = '233' + d.slice(1);
  else if (d.length === 9) d = '233' + d;
  return d.length >= 11 ? d : null;
}
function realEmail(email) { return email && !/@no-email\.placeholder$/i.test(email) ? email : null; }
function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }

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
  { value: 'permanent', label: msg('Permanent') },
  { value: 'contract', label: msg('Contract') },
  { value: 'casual', label: msg('Casual') },
  { value: 'day_rate', label: msg('By day') }
];

const EMPTY_EMPLOYEE_FORM = {
  firstName: '', lastName: '', email: '', phone: '', positionTitle: '',
  companyId: '', departmentId: '', shiftId: '', managerId: '', hireDate: new Date().toISOString().slice(0, 10),
  employmentType: 'permanent', status: 'active', roleId: '', payCycle: 'monthly', dailyRate: 0, hourlyRate: '',
  shiftStart: '', shiftEnd: ''
};

// "Imported 12 employee(s) (3 skipped, 1 failed)." — the count and each
// extra as whole phrases, so every language can word them its own way.
function importSummary(created, extras) {
  const details = extras.filter(Boolean);
  return details.length
    ? tr('Imported {n} employee(s) ({details}).', { n: created, details: details.join(', ') })
    : tr('Imported {n} employee(s).', { n: created });
}

export default function EmployeesPage() {
  const { session, can } = useAuth();
  const navigate = useNavigate();
  const myId = session && session.employee ? session.employee.id : null;
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

  const [q, setQ] = useState('');
  const [companyCode, setCompanyCode] = useState(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('company');
    return fromUrl ? fromUrl.toUpperCase() : readPref('bos.peopleCompany', 'ALL');
  });
  const [deptFilter, setDeptFilter] = useState('');
  const [chip, setChip] = useState(''); // '' | 'leave' | 'new' | 'incomplete' | 'nologin' | 'inactive'
  const [sort, setSort] = useState(() => readPref('bos.peopleSort', 'name'));
  const [view, setView] = useState(() => readPref('bos.peopleView', 'cards'));
  const [showTerminated, setShowTerminated] = useState(false);
  const [photoTarget, setPhotoTarget] = useState(null);

  // Companies aren't fetched separately here — every department already
  // carries its companyId/companyName (departments.service.js#list), so the
  // company filter and the add/edit dialog's company→department cascade are
  // both derived from the one /departments response instead of a second call.
  const companies = useMemo(() => {
    const seen = new Map();
    departments.forEach((d) => { if (!seen.has(d.companyId)) seen.set(d.companyId, { id: d.companyId, name: d.companyName, code: d.companyCode || d.companyId }); });
    // Bamboo Products first, then the rest by name, as on the dashboards.
    return Array.from(seen.values()).sort((a, b) => (a.code === 'BPL' ? -1 : b.code === 'BPL' ? 1 : a.name.localeCompare(b.name)));
  }, [departments]);
  const currentCompany = companies.find((c) => c.code === companyCode) || null;
  const companyFilter = currentCompany ? currentCompany.id : '';
  function pickCompany(code) {
    setCompanyCode(code);
    setDeptFilter('');
    writePref('bos.peopleCompany', code);
    window.history.replaceState({}, '', window.location.pathname + (code !== 'ALL' ? '?company=' + code : ''));
  }

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
  }, [showTerminated, canWrite]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

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
        setToast(tr('Updated {firstName} {lastName}.', { firstName: updated.firstName, lastName: updated.lastName }));
      } else {
        const created = await api.post('/employees', {
          firstName: form.firstName, lastName: form.lastName, email: form.email, phone: form.phone,
          positionTitle: form.positionTitle, departmentId: form.departmentId, shiftId: form.shiftId || null, managerId: form.managerId || null,
          hireDate: form.hireDate, employmentType: form.employmentType,
          shiftStart: form.shiftStart, shiftEnd: form.shiftEnd,
          createAccount: !!form.roleId, roleId: form.roleId || null
        });
        setToast(tr('{code} — {firstName} {lastName} added.', { code: created.code, firstName: created.firstName, lastName: created.lastName }));
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
      setToast(tr('{firstName} {lastName} has been terminated.', { firstName: terminateTarget.firstName, lastName: terminateTarget.lastName }));
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
      setToast(tr('Kiosk PIN set for {firstName} {lastName}.', { firstName: kioskPinTarget.firstName, lastName: kioskPinTarget.lastName }));
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
      setToast(tr('Kiosk PIN cleared for {firstName} {lastName}.', { firstName: kioskPinTarget.firstName, lastName: kioskPinTarget.lastName }));
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
      setToast(tr('Face enrolled for {firstName} {lastName}.', { firstName: kioskFaceTarget.firstName, lastName: kioskFaceTarget.lastName }));
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
      setToast(tr('Kiosk face cleared for {firstName} {lastName}.', { firstName: kioskFaceTarget.firstName, lastName: kioskFaceTarget.lastName }));
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
      setFaceLinkWaResult({ ok: true, message: tr('Sent via WhatsApp.') });
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
      setToast(tr('Permanently removed {removed} employee record(s).', { removed: result.removed }));
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
      setToast(result.linked
        ? tr('Imported {n} employee(s) from TimeStation and linked {linked} already-imported record(s).', { n: result.created, linked: result.linked })
        : tr('Imported {n} employee(s) from TimeStation.', { n: result.created }));
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
      setToast(importSummary(result.created, [
        result.skipped && tr('{n} skipped', { n: result.skipped }),
        result.failed.length && tr('{n} failed', { n: result.failed.length })
      ]));
      await load();
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImportCommitting(false);
    }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const deptById = Object.fromEntries(departments.map((d) => [d.id, d]));
  const byId = Object.fromEntries(employees.map((e) => [e.id, e]));
  const fullName = (e) => e.firstName + ' ' + e.lastName;
  const showCompany = !companyFilter && companies.length > 1;
  const scopeName = currentCompany ? currentCompany.name : tr('all companies');
  const scoped = employees.filter((e) => !companyFilter || (deptById[e.departmentId] && deptById[e.departmentId].companyId === companyFilter));
  const current = scoped.filter((e) => e.status !== 'terminated');
  const isNew = (e) => { const d = daysSince(e.hireDate); return d !== null && d >= 0 && d <= NEW_DAYS; };
  const isIncomplete = (e) => !e.phone || !e.managerId;
  const noLogin = (e) => canWrite && e.status === 'active' && !e.login;
  const onLeave = current.filter((e) => e.onLeaveUntil);
  const joiners = current.filter(isNew).sort((a, b) => String(b.hireDate).localeCompare(String(a.hireDate)));
  const incomplete = current.filter(isIncomplete);
  const withoutLogin = current.filter(noLogin);
  const inactive = current.filter((e) => e.status === 'inactive');
  const chipTest = { leave: (e) => !!e.onLeaveUntil, new: isNew, incomplete: isIncomplete, nologin: noLogin, inactive: (e) => e.status === 'inactive' };

  // Groups, biggest first.
  const groupMap = new Map();
  current.forEach((e) => {
    const d = deptById[e.departmentId];
    const key = e.departmentId || 'none';
    if (!groupMap.has(key)) groupMap.set(key, { key, id: e.departmentId, name: d ? d.name : tr('No group'), company: d ? d.companyName : '', people: [], away: 0 });
    const g = groupMap.get(key);
    g.people.push(e);
    if (e.onLeaveUntil) g.away += 1;
  });
  const groups = Array.from(groupMap.values()).sort((a, b) => b.people.length - a.people.length || a.name.localeCompare(b.name));

  const visible = scoped
    .filter((e) => !deptFilter || e.departmentId === deptFilter)
    .filter((e) => !chip || (chipTest[chip] && chipTest[chip](e)))
    .filter((e) => {
      const d = deptById[e.departmentId];
      return matchesQuery(q, fullName(e), e.code, e.positionTitle, e.email, e.phone, d && d.name, d && d.companyName);
    })
    .sort((a, b) => {
      if (sort === 'newest') return String(b.hireDate).localeCompare(String(a.hireDate));
      if (sort === 'code') return String(a.code).localeCompare(String(b.code), undefined, { numeric: true });
      if (sort === 'group') {
        const ga = deptById[a.departmentId] ? deptById[a.departmentId].name : '';
        const gb = deptById[b.departmentId] ? deptById[b.departmentId].name : '';
        return ga.localeCompare(gb) || fullName(a).localeCompare(fullName(b));
      }
      return fullName(a).localeCompare(fullName(b));
    });

  function showOnly(key) { setChip(chip === key ? '' : key); jump('emp-list'); }
  function pickView(v) { setView(v); writePref('bos.peopleView', v); }
  function pickSort(v) { setSort(v); writePref('bos.peopleSort', v); }

  const stats = [
    { icon: 'people', value: String(current.length), label: tr('people'), note: inactive.length ? tr('{a} active · {i} inactive', { a: current.length - inactive.length, i: inactive.length }) : tr('in {n} groups', { n: groups.length }), onClick: () => { setChip(''); setDeptFilter(''); jump('emp-list'); } },
    { icon: 'calendar', value: String(onLeave.length), label: tr('on leave today'), note: tr('approved leave'), onClick: () => showOnly('leave') },
    { icon: 'spark', value: String(joiners.length), label: tr('joined recently'), note: tr('in the last {n} days', { n: NEW_DAYS }), tone: joiners.length ? 'good' : '', onClick: () => showOnly('new') },
    canWrite
      ? { icon: 'warn', value: String(incomplete.length), label: tr('missing details'), note: tr('no phone or no manager'), tone: incomplete.length ? 'alert' : '', onClick: () => showOnly('incomplete') }
      : { icon: 'doc', value: String(groups.length), label: tr('groups'), note: scopeName }
  ];

  // What stands out.
  const insights = [];
  const listNames = (arr) => (arr.length <= 3 ? arr.map(fullName).join(', ') : tr('{names} and {n} more', { names: arr.slice(0, 2).map(fullName).join(', '), n: arr.length - 2 }));
  if (joiners.length) insights.push({ tone: 'good', icon: 'spark', text: joiners.length === 1 ? tr('{names} joined on {date}. Say hello!', { names: fullName(joiners[0]), date: fmtDate(joiners[0].hireDate) }) : tr('{names} joined in the last {n} days.', { names: listNames(joiners), n: NEW_DAYS }), action: { label: tr('Show them'), run: () => showOnly('new') } });
  if (onLeave.length) {
    const soonest = onLeave.slice().sort((a, b) => a.onLeaveUntil.localeCompare(b.onLeaveUntil))[0];
    insights.push({ tone: 'info', icon: 'calendar', text: onLeave.length === 1 ? tr('{name} is on leave until {date}.', { name: fullName(soonest), date: fmtDate(soonest.onLeaveUntil) }) : tr('{n} people are on leave today. {name} is the first back, after {date}.', { n: onLeave.length, name: fullName(soonest), date: fmtDate(soonest.onLeaveUntil) }), action: { label: tr('Show them'), run: () => showOnly('leave') } });
  }
  const noPhone = current.filter((e) => !e.phone);
  if (noPhone.length) insights.push({ tone: 'warn', icon: 'phone', text: noPhone.length === 1 ? tr('{name} has no phone number on record, so they cannot be called or sent an SMS from the OS.', { name: fullName(noPhone[0]) }) : tr('{n} people have no phone number on record, so they cannot be called or sent an SMS from the OS.', { n: noPhone.length }), action: canWrite ? { label: tr('Show them'), run: () => showOnly('incomplete') } : null });
  const noManager = current.filter((e) => !e.managerId);
  if (canWrite && noManager.length && noManager.length < current.length) insights.push({ tone: 'warn', icon: 'people', text: noManager.length === 1 ? tr('{name} does not report to anyone yet, so their leave and expense requests have no manager to approve them.', { name: fullName(noManager[0]) }) : tr('{n} people do not report to anyone yet, so their leave and expense requests have no manager to approve them.', { n: noManager.length }), action: { label: tr('Show them'), run: () => showOnly('incomplete') } });
  if (withoutLogin.length) insights.push({ tone: 'info', icon: 'card', text: withoutLogin.length === 1 ? tr('{name} cannot sign in to the OS. That is fine for staff who only clock in at the kiosk.', { name: fullName(withoutLogin[0]) }) : tr('{n} active people cannot sign in to the OS. That is fine for staff who only clock in at the kiosk.', { n: withoutLogin.length }), action: { label: tr('Show them'), run: () => showOnly('nologin') } });
  const neverSigned = canWrite ? current.filter((e) => e.status === 'active' && e.login && !e.login.lastLoginAt) : [];
  if (neverSigned.length) insights.push({ tone: 'info', icon: 'info', text: neverSigned.length === 1 ? tr('{name} has a login but has never signed in.', { name: fullName(neverSigned[0]) }) : tr('{n} people have a login but have never signed in.', { n: neverSigned.length }) });
  if (groups.length > 1 && current.length) {
    const g = groups[0];
    insights.push({ tone: 'info', icon: 'people', text: tr('{group} is the biggest group, with {n} of the {total} people.', { group: g.name + (showCompany && g.company ? ' (' + g.company + ')' : ''), n: g.people.length, total: current.length }) });
  }
  const types = { permanent: 0, contract: 0, casual: 0, day_rate: 0 };
  current.forEach((e) => { if (types[e.employmentType] !== undefined) types[e.employmentType] += 1; });
  if (current.length && (types.contract || types.casual || types.day_rate)) {
    insights.push({ tone: 'info', icon: 'doc', text: tr('{p} permanent, {c} on contract, {ca} casual and {d} paid by the day.', { p: types.permanent, c: types.contract, ca: types.casual, d: types.day_rate }) });
  }

  const terminatedCount = employees.filter((e) => e.status === 'terminated').length;
  const footer = can('employee.read.all')
    ? tr('{n} record(s) visible to your role — company-wide access.', { n: employees.length })
    : tr('{n} record(s) visible to your role — limited to your group and reporting line.', { n: employees.length });

  const chips = [
    ['', tr('Everyone'), scoped.length],
    ['leave', tr('On leave'), onLeave.length],
    ['new', tr('New'), joiners.length],
    canWrite && ['incomplete', tr('Missing details'), incomplete.length],
    canWrite && ['nologin', tr('No sign-in'), withoutLogin.length],
    inactive.length > 0 && ['inactive', tr('Inactive'), inactive.length]
  ].filter(Boolean);

  function menuFor(p) {
    const canDelete = canWrite && p.status !== 'terminated' && p.id !== myId;
    return [
      { label: tr('View profile'), onClick: () => setProfileTarget(p.id) },
      canWrite && { label: tr('Edit'), onClick: () => openEdit(p) },
      canWrite && { label: tr('Change photo'), onClick: () => setPhotoTarget(p) },
      canWrite && { label: tr('ID docs'), onClick: () => setIdDocsTarget(p) },
      canWrite && { label: tr('Kiosk PIN'), onClick: () => openKioskPin(p) },
      canWrite && { label: tr('Kiosk Face'), onClick: () => openKioskFace(p) },
      canDelete && { label: tr('Delete'), onClick: () => openTerminate(p), danger: true }
    ].filter(Boolean);
  }
  function tagsFor(p) {
    return (
      <>
        {p.status === 'terminated' && <Status tone="bad">{tr('Terminated')}</Status>}
        {p.status === 'inactive' && <Status tone="muted">{tr('Inactive')}</Status>}
        {p.onLeaveUntil && <Status tone="warn">{tr('On leave until {date}', { date: fmtDate(p.onLeaveUntil) })}</Status>}
        {isNew(p) && p.status !== 'terminated' && <Status tone="good">{tr('New')}</Status>}
        {noLogin(p) && <Status tone="muted">{tr('No sign-in')}</Status>}
      </>
    );
  }
  function contactsFor(p) {
    const wa = waNumber(p.phone);
    const email = realEmail(p.email);
    const name = fullName(p);
    return (
      <>
        {p.phone && <a className="ppl-act" href={'tel:' + p.phone.replace(/\s+/g, '')} title={tr('Call {name}', { name })} aria-label={tr('Call {name}', { name })}><PIcon name="phone" /></a>}
        {wa && <a className="ppl-act is-wa" href={'https://wa.me/' + wa} target="_blank" rel="noopener noreferrer" title={tr('WhatsApp {name}', { name })} aria-label={tr('WhatsApp {name}', { name })}><PIcon name="whatsapp" /></a>}
        {email && <a className="ppl-act is-mail" href={'mailto:' + email} title={tr('Email {name}', { name })} aria-label={tr('Email {name}', { name })}><PIcon name="mail" /></a>}
        {p.id !== myId && p.status === 'active' && (
          <button type="button" className="ppl-act" onClick={() => navigate('/messages?peer=' + p.id)} title={tr('Message {name} in the OS', { name })} aria-label={tr('Message {name} in the OS', { name })}><PIcon name="chat" /></button>
        )}
      </>
    );
  }
  const managerName = (p) => (p.managerId && byId[p.managerId] ? fullName(byId[p.managerId]) : null);
  const groupLine = (p) => {
    const d = deptById[p.departmentId];
    return d ? d.name + (showCompany ? ' · ' + d.companyName : '') : '—';
  };

  return (
    <div className="dk ppl">
      {error && <div className="error-banner" role="alert">{error}</div>}

      {companies.length > 1 && (
        <CompanySwitcher companies={[{ code: 'ALL', name: tr('All companies') }, ...companies]} company={currentCompany ? currentCompany.code : 'ALL'}
          onPick={pickCompany}
          describe={(co) => {
            const n = co.code === 'ALL'
              ? employees.filter((e) => e.status !== 'terminated').length
              : employees.filter((e) => e.status !== 'terminated' && deptById[e.departmentId] && deptById[e.departmentId].companyId === co.id).length;
            return tr('{n} people', { n });
          }} />
      )}

      <Hero
        eyebrow={currentCompany ? currentCompany.name : tr('All companies')}
        title={tr('Employee directory')}
        sub={tr('Everyone who works at {scope}: find a colleague, call, WhatsApp or message them, and see who is away or new. Press a number to show only those people.', { scope: scopeName })}
        actions={(canWrite || canSync) && <>
          {canWrite && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('Add employee')}</button>}
          {canWrite && <button type="button" className="btn btn-secondary" onClick={openImport}>{tr('Import from sheet')}</button>}
          {canSync && <button type="button" className="btn btn-secondary" onClick={openSync}>{tr('Sync from TimeStation')}</button>}
        </>}
        stats={stats} />

      <Insights items={insights.slice(0, 6)} />

      {groups.length > 1 && (
        <Section title={tr('Groups')} sub={tr('How many people are in each group. Press one to see its people.')}>
          <div className="ppl-groups">
            {groups.map((g) => (
              <button key={g.key} type="button" className={'ppl-group' + (deptFilter && deptFilter === g.id ? ' is-on' : '')}
                onClick={() => { setDeptFilter(deptFilter === g.id ? '' : g.id || ''); setChip(''); jump('emp-list'); }}>
                <span className="ppl-group-top">
                  <span className="ppl-group-name">{g.name}{showCompany && g.company && <span className="ppl-group-co">{g.company}</span>}</span>
                  <strong className="ppl-group-count">{g.people.length}</strong>
                </span>
                <span className="ppl-faces" aria-hidden="true">
                  {g.people.slice(0, 5).map((p) => <Photo key={p.id} id={p.id} name={fullName(p)} photo={p.photo} size={28} />)}
                  {g.people.length > 5 && <span className="ppl-faces-more">+{g.people.length - 5}</span>}
                </span>
                <span className="dk-muted ppl-group-meta">{g.away ? tr('{n} on leave today', { n: g.away }) : tr('Everyone is in')}</span>
              </button>
            ))}
          </div>
        </Section>
      )}

      <Section id="emp-list" title={deptFilter && deptById[deptFilter] ? deptById[deptFilter].name : tr('Everyone')}
        sub={tr('{shown} of {total} shown. Press a person to see their profile.', { shown: visible.length, total: scoped.length })}
        action={
          <div className="ppl-view" role="radiogroup" aria-label={tr('Show as')}>
            <button type="button" role="radio" aria-checked={view === 'cards'} className={view === 'cards' ? 'is-on' : ''} onClick={() => pickView('cards')} title={tr('Cards')} aria-label={tr('Cards')}><PIcon name="grid" /></button>
            <button type="button" role="radio" aria-checked={view === 'list'} className={view === 'list' ? 'is-on' : ''} onClick={() => pickView('list')} title={tr('List')} aria-label={tr('List')}><PIcon name="list" /></button>
          </div>
        }>
        <div className="ppl-tools">
          <div className="ppl-search"><SearchInput value={q} onChange={setQ} placeholder={tr('Search name, job, code or phone…')} /></div>
          <select className="input ppl-select" value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} aria-label={tr('Group')}>
            <option value="">{tr('All groups')}</option>
            {departments.filter((d) => !companyFilter || d.companyId === companyFilter).map((d) => (
              <option key={d.id} value={d.id}>{companyFilter ? d.name : d.name + ' — ' + d.companyName}</option>
            ))}
          </select>
          <select className="input ppl-select" value={sort} onChange={(e) => pickSort(e.target.value)} aria-label={tr('Sort by')}>
            <option value="name">{tr('Name A–Z')}</option>
            <option value="newest">{tr('Newest first')}</option>
            <option value="group">{tr('Group')}</option>
            <option value="code">{tr('Employee code')}</option>
          </select>
        </div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, n]) => (
            <button key={key || 'all'} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
              {label} <span className="ppl-chip-n">{n}</span>
            </button>
          ))}
        </div>

        {view === 'cards' ? (
          <div className="ppl-cards">
            {visible.map((p) => (
              <article key={p.id} className={'ppl-card' + (p.status === 'terminated' ? ' is-gone' : '')}>
                <div className="ppl-card-menu"><RowMenu actions={menuFor(p)} /></div>
                <button type="button" className="ppl-card-main" onClick={() => setProfileTarget(p.id)}>
                  <Photo id={p.id} name={fullName(p)} photo={p.photo} size={72} />
                  <span className="ppl-card-name">{fullName(p)}{p.id === myId && <span className="ppl-you">{tr('You')}</span>}</span>
                  <span className="ppl-card-title">{p.positionTitle || '—'}</span>
                  <span className="dk-muted ppl-card-group">{groupLine(p)}</span>
                </button>
                <div className="ppl-card-tags">{tagsFor(p)}</div>
                <div className="ppl-card-foot">
                  <span className="ppl-code">{p.code}</span>
                  <span className="ppl-acts">{contactsFor(p)}</span>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <ul className="ppl-list">
            {visible.map((p) => (
              <li key={p.id} className={'ppl-line' + (p.status === 'terminated' ? ' is-gone' : '')}>
                <button type="button" className="ppl-line-who" onClick={() => setProfileTarget(p.id)}>
                  <Photo id={p.id} name={fullName(p)} photo={p.photo} size={40} />
                  <span className="ppl-line-text">
                    <span className="ppl-line-name">{fullName(p)}{p.id === myId && <span className="ppl-you">{tr('You')}</span>}</span>
                    <span className="dk-muted">{p.positionTitle || '—'} · {p.code}</span>
                  </span>
                </button>
                <span className="ppl-line-col">
                  <span>{groupLine(p)}</span>
                  <span className="dk-muted">{managerName(p) ? tr('Reports to {name}', { name: managerName(p) }) : tr('No manager set')}</span>
                </span>
                <span className="ppl-line-col ppl-line-shift">
                  <span>{p.phone || '—'}</span>
                  <span className="dk-muted">{p.shift || '—'}</span>
                </span>
                <span className="ppl-line-tags">{tagsFor(p)}</span>
                <span className="ppl-acts">{contactsFor(p)}<RowMenu actions={menuFor(p)} /></span>
              </li>
            ))}
          </ul>
        )}

        {!visible.length && (
          <div className="dk-empty">
            <p>{scoped.length ? tr('No one matches. Try another search, group or filter.') : tr('No employees here yet.')}</p>
            {(q || chip || deptFilter) && <button type="button" className="btn btn-secondary" onClick={() => { setQ(''); setChip(''); setDeptFilter(''); }}>{tr('Clear filters')}</button>}
          </div>
        )}

        <div className="ppl-bottom">
          <label className="employees-checkbox">
            <input type="checkbox" checked={showTerminated} onChange={(e) => setShowTerminated(e.target.checked)} />
            {tr('Show terminated employees')}
          </label>
          {canPurge && terminatedCount > 0 && (
            <button type="button" className="btn btn-secondary ppl-small-btn" onClick={() => { setDialogError(null); setDialog('purge'); }}>
              {tr('Remove all deleted employees (')}{terminatedCount})
            </button>
          )}
          <span className="dk-muted ppl-footer">{footer}</span>
        </div>
      </Section>

      <Glossary items={[
        [tr('Group'), tr('The department someone works in. Each group belongs to one company.')],
        [tr('Reports to'), tr('Their manager, who approves their leave and expense requests.')],
        [tr('Permanent, contract, casual, by day'), tr('How someone is employed. "By day" means they are paid a daily rate for the days they work.')],
        [tr('Inactive'), tr('Still on the books but not working at the moment. They cannot sign in.')],
        [tr('Terminated'), tr('Has left. Their history is kept for records; turn on "Show terminated employees" to see them.')],
        [tr('No sign-in'), tr('Has no login for the OS. They can still clock in and out at the kiosk with their PIN.')],
        [tr('Kiosk PIN and face'), tr('What someone uses to clock in and out at the attendance kiosk.')]
      ]} />

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
                {EMPLOYMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{tr(t.label)}</option>)}
              </select>
            </div>
            <div className="field"><label htmlFor="emp-shift-start">{tr('Shift start')}</label>
              <input id="emp-shift-start" className="input" type="time" value={form.shiftStart} onChange={(e) => setForm({ ...form, shiftStart: e.target.value })} />
            </div>
            <div className="field"><label htmlFor="emp-shift-end">{tr('Shift end')}</label>
              <input id="emp-shift-end" className="input" type="time" value={form.shiftEnd} onChange={(e) => setForm({ ...form, shiftEnd: e.target.value })} />
            </div>
            <p className="employees-dialog-span" style={{ fontSize: 12, color: 'var(--color-text-muted, #667085)', margin: '-8px 0 4px' }}>
              {tr('These are a manual override only — leave blank if the shift picked above already covers it. Attendance uses (in order) the assigned shift\'s start time, then this manual override, then the company default, with the grace period set in Company settings, to decide who\'s marked late.')}
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
                    {tr('Auto-filled from Daily rate ÷ shift hours ({hours}h/day) — edit it directly to override.', { hours: effectiveShiftHours(form, shifts) })}
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
              {tr('This permanently removes all {terminatedCount} terminated employee record(s) and their logins. Unlike deleting a single employee, this cannot be undone — their attendance, leave and task history will remain but will no longer show a name.', { terminatedCount })}
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
              {tr('This 4-digit PIN is what {firstName} taps in at the clock-in/out kiosk — no name or employee code is entered there, the PIN alone identifies them, so it must be unique across everyone.', { firstName: kioskPinTarget.firstName })}
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
              {tr("Once enrolled, {firstName} has to look at the kiosk's camera to confirm it's them every time they tap their PIN — the PIN alone stops being enough. Nothing is stored except the measurements the camera captures right now; no photo is kept.", { firstName: kioskFaceTarget.firstName })}
            </p>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            {!kioskFaceCapturing && (
              <>
                <p className="dialog-body">
                  {kioskFaceStatus === null && tr('Loading…')}
                  {kioskFaceStatus && !kioskFaceStatus.enrolled && tr('Not enrolled — the PIN alone still clocks them in and out.')}
                  {kioskFaceStatus && kioskFaceStatus.enrolled && (
                    kioskFaceStatus.enrolledAt
                      ? tr('Enrolled on {date}.', { date: new Date(kioskFaceStatus.enrolledAt).toLocaleDateString(activeIntlLocale()) })
                      : tr('Enrolled.')
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
                  <div className="employees-face-link-head">{tr('Or, send {firstName} a link to do this themselves', { firstName: kioskFaceTarget.firstName })}</div>
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
                  subtitle={tr('Have {firstName} look straight at the camera, then click Capture — it walks through a few head angles (straight, left, right, up, down), about 10 seconds, to build a reference that holds up at whatever angle they happen to be at the kiosk.', { firstName: kioskFaceTarget.firstName })}
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
                    {toLink > 0
                      ? tr('{found} employee(s) found on TimeStation — {toCreate} will be created, {toLink} already imported (will just link for the attendance sync), {toSkip} will be skipped.', { found: effRows.length, toCreate, toLink, toSkip })
                      : tr('{found} employee(s) found on TimeStation — {toCreate} will be created, {toSkip} will be skipped.', { found: effRows.length, toCreate, toSkip })}
                    {missingCount > 0 && (
                      <>
                        {' '}<button type="button" className="btn btn-secondary" style={{ fontSize: 12, marginLeft: 8 }} onClick={autoFillMissingEmails}>
                          {tr('Fill in all {missingCount} missing email(s) with placeholders', { missingCount })}
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
                            <td>{r.hourlyRate ? tr('{rate}/hr', { rate: r.hourlyRate }) : '—'}</td>
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
                        ? (toLink ? tr('Import {toCreate} employee(s) + link {toLink}', { toCreate, toLink }) : tr('Import {toCreate} employee(s)', { toCreate }))
                        : toLink ? tr('Link {toLink} employee(s)', { toLink }) : tr('Nothing to do')}
                    </button>
                  </div>
                </>
              );
            })()}

            {syncResult && (
              <>
                <p className="itdevices-import-summary">
                  {importSummary(syncResult.created, [
                    syncResult.skipped && tr('{n} skipped', { n: syncResult.skipped }),
                    syncResult.linked && tr('{n} already-imported record(s) linked to TimeStation', { n: syncResult.linked }),
                    syncResult.failed.length && tr('{n} failed', { n: syncResult.failed.length })
                  ])}
                </p>
                {syncResult.failed.length > 0 && (
                  <ul>
                    {syncResult.failed.map((f, i) => <li key={i}>{f.name || tr('Unnamed record')} — {f.reason}</li>)}
                  </ul>
                )}
                {syncResult.pinIssues && syncResult.pinIssues.length > 0 && (
                  <>
                    <p className="itdevices-import-summary">{tr('Kiosk PIN not set for {n} employee(s) — set these manually via the Kiosk PIN button:', { n: syncResult.pinIssues.length })}</p>
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
                    {tr('{n} row(s) found — {toCreate} will be created, {toSkip} will be skipped.', { n: importPreview.rows.length, toCreate, toSkip })}
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
                      {importCommitting ? tr('Importing…') : toCreate ? tr('Import {toCreate} employee(s)', { toCreate }) : tr('Nothing to import')}
                    </button>
                  </div>
                </>
              );
            })()}

            {importResult && (
              <>
                <p className="itdevices-import-summary">
                  {importSummary(importResult.created, [
                    importResult.skipped && tr('{n} skipped', { n: importResult.skipped }),
                    importResult.failed.length && tr('{n} failed', { n: importResult.failed.length })
                  ])}
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
      {photoTarget && (
        <PhotoDialog title={tr('Photo of {name}', { name: photoTarget.firstName + ' ' + photoTarget.lastName })} kind="person"
          id={photoTarget.id} name={photoTarget.firstName + ' ' + photoTarget.lastName} photo={photoTarget.photo}
          uploadPath={'/messages/people/' + photoTarget.id + '/photo'}
          onDone={(v) => {
            forgetBlob('/messages/people/' + photoTarget.id + '/photo');
            setEmployees((list) => list.map((e) => (e.id === photoTarget.id ? { ...e, photo: v } : e)));
            setPhotoTarget(null);
          }}
          onClose={() => setPhotoTarget(null)} />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
