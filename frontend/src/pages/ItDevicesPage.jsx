import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import ContactButtons from '../components/ContactButtons';
import Photo from '../components/Photo';
import RowMenu from '../components/RowMenu';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { CompanySwitcher, Glossary, Hero, Insights, RankList, Section, Status, fmtDate, jump } from '../components/DashKit';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import './EmployeesPage.css';
import './ToolRoomPage.css';
import './ItDevicesPage.css';

// IT device inventory: company laptops, desktops, phones, monitors and the
// like, owned and tracked by IT — separate from the general Assets &
// Maintenance module. Same "explains itself" layout as the dashboards
// (components/DashKit.jsx): a company switcher (a device belongs to the
// company of its group, or of the person who has it), the key numbers (in
// use, spare in storage, in for repair, not checked by IT for six months),
// what stands out (devices still with people who have left, warranties
// ending, devices getting old), what kinds of devices there are and where,
// and the devices as cards or a list. A device is handed to someone, passed
// on, taken back into storage and checked by IT; every step is in its
// history (itDevices.service.js, migration 0089). The cards and dialogs use
// the tool room's pieces (ToolRoomPage.css). The sheet import is unchanged.

const STATUSES = [
  { key: 'in_use', label: msg('In use') }, { key: 'in_storage', label: msg('In storage') }, { key: 'under_repair', label: msg('Under repair') },
  { key: 'retired', label: msg('Retired') }, { key: 'lost', label: msg('Lost') }
];
const CONDITIONS = [{ key: 'good', label: msg('Good') }, { key: 'fair', label: msg('Fair') }, { key: 'poor', label: msg('Poor') }];
const EMPTY_FORM = {
  deviceTag: '', category: '', brand: '', model: '', serialNumber: '', assignedEmployeeId: '', departmentId: '',
  location: '', purchaseDate: '', purchasePrice: '', warrantyUntil: '', condition: 'good', status: 'in_use', notes: ''
};
const CHECK_DAYS = 180;
const OLD_YEARS = 4;

function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function daysUntil(iso) {
  if (!iso) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((new Date(String(iso).slice(0, 10) + 'T00:00') - t) / 86400000);
}
function yearsSince(iso) { return iso ? -daysUntil(iso) / 365.25 : null; }
function statusLabel(s) { return tr((STATUSES.find((x) => x.key === s) || STATUSES[0]).label); }
function conditionLabel(c) { return tr((CONDITIONS.find((x) => x.key === c) || CONDITIONS[0]).label); }
function isLive(d) { return d.status !== 'retired' && d.status !== 'lost'; }
function modelOf(d) { return (String(d.brand || '') + ' ' + String(d.model || '')).trim(); }
function titleOf(d) { return modelOf(d) || d.category; }
function unchecked(d) { return isLive(d) && (!d.lastCheckedOn || -daysUntil(d.lastCheckedOn) > CHECK_DAYS); }
function warrantyEnding(d) { const w = daysUntil(d.warrantyUntil); return isLive(d) && w !== null && w >= 0 && w <= 60; }
function isOld(d) { return isLive(d) && yearsSince(d.purchaseDate) >= OLD_YEARS; }
function statusTone(s) { return s === 'in_use' ? 'good' : s === 'in_storage' ? 'info' : s === 'lost' ? 'bad' : s === 'retired' ? 'muted' : 'warn'; }

const KIND_ICON = {
  laptop: <><rect x="4.5" y="5" width="15" height="10" rx="1.2" /><path d="M2.5 18.5h19l-1.5-3.5H4z" /></>,
  desktop: <><rect x="3" y="4" width="18" height="12" rx="1.3" /><path d="M9 20h6M12 16v4" /></>,
  phone: <><rect x="7" y="2.8" width="10" height="18.4" rx="2" /><path d="M11 18h2" /></>,
  tablet: <><rect x="4.5" y="3" width="15" height="18" rx="2" /><path d="M11 18h2" /></>,
  printer: <><path d="M7 8V3.5h10V8M7 17H4.5v-7a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v7H17" /><rect x="7" y="14" width="10" height="6.5" rx="0.8" /></>,
  network: <><rect x="3" y="13" width="18" height="6" rx="1.3" /><path d="M7 16h.01M11 16h.01M8.5 9.5a5 5 0 0 1 7 0M6 7a8.5 8.5 0 0 1 12 0" /></>,
  other: <><rect x="5" y="5" width="14" height="14" rx="2" /><path d="M9 2.5v2.5M15 2.5v2.5M9 19v2.5M15 19v2.5M2.5 9h2.5M2.5 15h2.5M19 9h2.5M19 15h2.5" /></>
};
function kindOf(category) {
  const c = String(category || '').toLowerCase();
  if (/laptop|notebook|macbook|chromebook/.test(c)) return 'laptop';
  if (/tablet|ipad|smart device/.test(c)) return 'tablet';
  if (/phone|mobile|smartphone|handset/.test(c)) return 'phone';
  if (/print|scan|copier/.test(c)) return 'printer';
  if (/router|switch|network|wifi|wi-fi|modem|access point/.test(c)) return 'network';
  if (/desktop|pc|computer|monitor|screen|display|tv|imac/.test(c)) return 'desktop';
  return 'other';
}
function Badge({ d, size = 44 }) {
  const k = kindOf(d.category);
  return (
    <span className={'itd-badge is-' + k} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{KIND_ICON[k]}</svg>
    </span>
  );
}

const EVENT_LABELS = { assign: msg('Handed over'), return: msg('Handed back'), status: msg('Status changed'), check: msg('Checked by IT') };

export default function ItDevicesPage() {
  const { can } = useAuth();
  const canManage = can('itdevice.manage');

  const [devices, setDevices] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [companyCode, setCompanyCode] = useState(() => readPref('bos.itDevicesCompany', 'ALL'));
  const [chip, setChip] = useState('live');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [view, setView] = useState(() => readPref('bos.itDevicesView', 'cards'));

  const [detail, setDetail] = useState(null); // device id
  const [events, setEvents] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [act, setAct] = useState(null); // { mode: give|back|check, device }
  const [actForm, setActForm] = useState({});

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
      setDevices(await api.get('/it-devices'));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/departments').then(setDepartments).catch(() => {});
    if (can('employee.read')) api.get('/employees').then(setEmployees).catch(() => {});
  }, [can]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    setEvents(null);
    if (!detail) return;
    api.get('/it-devices/' + detail + '/history').then(setEvents).catch(() => setEvents([]));
  }, [detail, devices]);

  const companies = useMemo(() => {
    const seen = new Map();
    departments.forEach((d) => { if (!seen.has(d.companyId)) seen.set(d.companyId, { id: d.companyId, name: d.companyName, code: d.companyCode || d.companyId }); });
    devices.forEach((d) => { if (d.companyId && !seen.has(d.companyId)) seen.set(d.companyId, { id: d.companyId, name: d.companyName, code: d.companyCode }); });
    return Array.from(seen.values()).sort((x, y) => (x.code === 'BPL' ? -1 : y.code === 'BPL' ? 1 : String(x.name).localeCompare(String(y.name))));
  }, [departments, devices]);
  const currentCompany = companies.find((c) => c.code === companyCode) || null;
  function pickCompany(code) { setCompanyCode(code); writePref('bos.itDevicesCompany', code); }
  const categories = useMemo(() => Array.from(new Set(devices.map((d) => d.category).filter(Boolean))).sort(), [devices]);
  const staff = useMemo(() => employees.filter((e) => e.status !== 'terminated'), [employees]);

  // ── actions ──────────────────────────────────────────────────────────
  function openNew() {
    setDialogError(null);
    setEditId(null);
    setForm({ ...EMPTY_FORM, category: category || '' });
    setDialogOpen(true);
  }
  function openEdit(d) {
    setDialogError(null);
    setEditId(d.id);
    const f = {};
    Object.keys(EMPTY_FORM).forEach((k) => { f[k] = d[k] === null || d[k] === undefined ? '' : String(d[k]); });
    setForm(f);
    setDetail(null);
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
      setToast(editId ? tr('Device updated.') : tr('Device registered.'));
      setDialogOpen(false);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }
  function openAct(d, mode) {
    setDialogError(null);
    setActForm(mode === 'give' ? { employeeId: '', note: '' } : mode === 'back' ? { condition: d.condition, location: d.location || tr('IT store'), note: '' } : { condition: d.condition, note: '' });
    setDetail(null);
    setAct({ mode, device: d });
  }
  async function saveAct(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    const { mode, device } = act;
    try {
      if (mode === 'check') await api.post('/it-devices/' + device.id + '/check', actForm);
      else await api.post('/it-devices/' + device.id + '/assign', mode === 'back' ? { ...actForm, employeeId: null } : actForm);
      const who = staff.find((s) => s.id === actForm.employeeId);
      setToast(mode === 'check' ? tr('{tag} checked.', { tag: device.deviceTag })
        : mode === 'back' ? tr('{tag} is back with IT.', { tag: device.deviceTag })
          : tr('{tag} handed to {name}.', { tag: device.deviceTag, name: who ? who.firstName + ' ' + who.lastName : '' }));
      setAct(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }
  async function setStatus(d, status) {
    try {
      await api.post('/it-devices/' + d.id + '/status', { status });
      setToast(tr('{tag} is now {status}.', { tag: d.deviceTag, status: statusLabel(status).toLowerCase() }));
      await load();
    } catch (err) { setError(err.message); }
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
      setToast(result.skipped
        ? tr('Imported {n} device(s) ({skipped} already existed, skipped).', { n: result.created, skipped: result.skipped })
        : tr('Imported {n} device(s).', { n: result.created }));
      setImportOpen(false);
      await load();
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImportCommitting(false);
    }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const inScope = devices.filter((d) => !currentCompany || !d.companyId || d.companyId === currentCompany.id);
  const live = inScope.filter(isLive);
  const inUse = live.filter((d) => d.status === 'in_use');
  const storage = live.filter((d) => d.status === 'in_storage');
  const repair = live.filter((d) => d.status === 'under_repair');
  const poor = live.filter((d) => d.condition === 'poor');
  const leavers = live.filter((d) => d.assigneeLeft);
  const lost = inScope.filter((d) => d.status === 'lost');
  const warranty = live.filter(warrantyEnding).sort((x, y) => String(x.warrantyUntil).localeCompare(String(y.warrantyUntil)));
  const old = live.filter(isOld);
  const notChecked = live.filter(unchecked);
  const neverChecked = notChecked.filter((d) => !d.lastCheckedOn);
  const inUseNobody = inUse.filter((d) => !d.assignedEmployeeId && !d.location);

  function showOnly(key) { setChip(chip === key ? 'live' : key); jump('itd-list'); }
  const stats = [
    { icon: 'people', value: String(inUse.length), label: tr('devices in use'), note: tr('bought for {amount}', { amount: money(live.reduce((s, d) => s + d.purchasePrice, 0)) }), onClick: () => showOnly('in_use') },
    { icon: 'drawer', value: String(storage.length), label: tr('spare in storage'), note: storage.length ? tr('ready to hand out') : tr('none spare'), onClick: () => showOnly('in_storage') },
    { icon: 'warn', value: String(repair.length), label: tr('in for repair'), note: !poor.length ? tr('none in poor condition') : poor.length === 1 ? tr('1 in poor condition') : tr('{n} in poor condition', { n: poor.length }), tone: repair.length || poor.length ? 'alert' : '', onClick: () => showOnly(repair.length ? 'under_repair' : 'poor') },
    { icon: 'check', value: String(notChecked.length), label: tr('not checked in 6 months'), note: neverChecked.length ? tr('{n} never checked', { n: neverChecked.length }) : tr('every device seen recently'), tone: notChecked.length ? 'alert' : 'good', onClick: () => showOnly('unchecked') }
  ];

  const insights = [];
  if (leavers.length) {
    const d = leavers[0];
    insights.push({
      tone: 'bad', icon: 'people',
      text: leavers.length === 1 ? tr('{name} has left the company but still has {tag} ({model}).', { name: d.assigneeName, tag: d.deviceTag, model: titleOf(d) }) : tr('{n} devices are still with people who have left the company.', { n: leavers.length }),
      action: leavers.length === 1 && canManage ? { label: tr('Take it back'), run: () => openAct(d, 'back') } : { label: tr('Show them'), run: () => showOnly('left') }
    });
  }
  if (warranty.length) insights.push({ tone: 'warn', icon: 'doc', text: warranty.length === 1 ? tr('The warranty on {tag} ({model}) ends {date}. Anything to claim, claim now.', { tag: warranty[0].deviceTag, model: titleOf(warranty[0]), date: fmtDate(warranty[0].warrantyUntil) }) : tr('{n} warranties end in the next 60 days.', { n: warranty.length }), action: { label: tr('Show them'), run: () => showOnly('warranty') } });
  if (lost.length) insights.push({ tone: 'warn', icon: 'warn', text: lost.length === 1 ? tr('{tag} ({model}) is marked lost.', { tag: lost[0].deviceTag, model: titleOf(lost[0]) }) : tr('{n} devices are marked lost.', { n: lost.length }), action: { label: tr('Show them'), run: () => showOnly('lost') } });
  if (old.length) insights.push({ tone: 'info', icon: 'calendar', text: old.length === 1 ? tr('{tag} ({model}) is more than {n} years old. Worth planning its replacement.', { tag: old[0].deviceTag, model: titleOf(old[0]), n: OLD_YEARS }) : tr('{count} devices are more than {n} years old. Worth planning replacements.', { count: old.length, n: OLD_YEARS }), action: { label: tr('Show them'), run: () => showOnly('old') } });
  if (storage.length && inUseNobody.length === 0) insights.push({ tone: 'info', icon: 'drawer', text: storage.length === 1 ? tr('1 device is spare in storage. Hand it out before buying another.') : tr('{n} devices are spare in storage. Hand them out before buying more.', { n: storage.length }), action: { label: tr('Show them'), run: () => showOnly('in_storage') } });
  if (notChecked.length) insights.push({ tone: 'info', icon: 'check', text: notChecked.length === 1 ? tr('{tag} has not been checked by IT in the last 6 months.', { tag: notChecked[0].deviceTag }) : tr('{n} devices have not been checked by IT in the last 6 months.', { n: notChecked.length }), action: { label: tr('Show them'), run: () => showOnly('unchecked') } });
  if (!insights.length && live.length) insights.push({ tone: 'good', icon: 'check', text: tr('Every device is with someone who works here, checked recently and under control.') });

  const chipTest = {
    live: isLive,
    in_use: (d) => d.status === 'in_use',
    in_storage: (d) => d.status === 'in_storage',
    under_repair: (d) => d.status === 'under_repair',
    poor: (d) => isLive(d) && d.condition === 'poor',
    left: (d) => isLive(d) && d.assigneeLeft,
    warranty: warrantyEnding,
    old: isOld,
    unchecked,
    lost: (d) => d.status === 'lost',
    retired: (d) => d.status === 'retired'
  };
  const visible = inScope.filter(chipTest[chip] || chipTest.live)
    .filter((d) => !category || d.category === category)
    .filter((d) => matchesQuery(search, d.deviceTag, d.category, d.brand, d.model, d.serialNumber, d.assigneeName, d.location, d.departmentName, d.notes));
  const chips = [
    ['live', tr('All'), live.length],
    ['in_use', tr('In use'), inUse.length],
    ['in_storage', tr('In storage'), storage.length],
    ['under_repair', tr('Under repair'), repair.length],
    ['poor', tr('Poor condition'), poor.length],
    ['left', tr('With people who left'), leavers.length],
    ['warranty', tr('Warranty ending'), warranty.length],
    ['old', tr('Over {n} years old', { n: OLD_YEARS }), old.length],
    ['unchecked', tr('Not checked'), notChecked.length],
    ['lost', tr('Lost'), lost.length],
    ['retired', tr('Retired'), inScope.filter(chipTest.retired).length]
  ].filter(([k, , c]) => c > 0 || k === 'live' || k === chip);

  const byCategory = {};
  live.forEach((d) => {
    const k = d.category || tr('Other');
    byCategory[k] = byCategory[k] || { name: k, total: 0, use: 0, spare: 0 };
    byCategory[k].total++;
    if (d.status === 'in_use') byCategory[k].use++;
    if (d.status === 'in_storage') byCategory[k].spare++;
  });
  const categoryRows = Object.values(byCategory).sort((x, y) => y.total - x.total).slice(0, 8).map((c) => ({
    key: c.name, name: c.name, value: c.total, amount: String(c.total),
    meta: c.spare ? tr('{use} in use · {spare} spare', { use: c.use, spare: c.spare }) : tr('{use} in use', { use: c.use })
  }));
  const byDept = {};
  inUse.forEach((d) => {
    const k = d.departmentName || tr('No group');
    byDept[k] = (byDept[k] || 0) + 1;
  });
  const deptRows = Object.entries(byDept).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([name, n]) => ({ key: name, name, value: n, amount: String(n) }));

  function actionsFor(d) {
    const liveNow = isLive(d);
    return [
      { label: tr('Open'), onClick: () => setDetail(d.id) },
      canManage && liveNow && { label: d.assignedEmployeeId ? tr('Pass to someone else') : tr('Hand over'), onClick: () => openAct(d, 'give') },
      canManage && liveNow && d.assignedEmployeeId && { label: tr('Take back into storage'), onClick: () => openAct(d, 'back') },
      canManage && liveNow && { label: tr('Mark as checked'), onClick: () => openAct(d, 'check') },
      canManage && { label: tr('Edit'), onClick: () => openEdit(d) },
      canManage && d.status !== 'under_repair' && liveNow && { label: tr('Send for repair'), onClick: () => setStatus(d, 'under_repair') },
      canManage && d.status === 'under_repair' && { label: d.assignedEmployeeId ? tr('Back in use') : tr('Back in storage'), onClick: () => setStatus(d, d.assignedEmployeeId ? 'in_use' : 'in_storage') },
      canManage && !liveNow && { label: tr('Back in storage'), onClick: () => setStatus(d, 'in_storage') },
      canManage && liveNow && { label: tr('Mark as lost'), onClick: () => setStatus(d, 'lost'), danger: true },
      canManage && liveNow && { label: tr('Retire'), onClick: () => setStatus(d, 'retired'), danger: true }
    ].filter(Boolean);
  }
  function whoOf(d, size) {
    if (d.assignedEmployeeId) {
      return (
        <div className="tl-who">
          <Photo id={d.assignedEmployeeId} name={d.assigneeName} photo={d.assigneePhoto} size={size} />
          <span>{d.assigneeName}{d.assigneeLeft ? <span className="itd-left"> · {tr('has left')}</span> : d.departmentName ? <span className="dk-muted"> · {d.departmentName}</span> : null}</span>
        </div>
      );
    }
    return <div className="tl-who dk-muted"><span className="tl-place" aria-hidden="true">⌂</span><span>{d.location || (d.status === 'in_storage' ? tr('IT store') : tr('Nobody and nowhere recorded'))}</span></div>;
  }

  const cur = detail ? devices.find((d) => d.id === detail) : null;
  const showCompany = !currentCompany && companies.length > 1;
  const age = cur && cur.purchaseDate ? yearsSince(cur.purchaseDate) : null;

  return (
    <div className="dk tl itd">
      {error && <div className="error-banner" role="alert">{error}</div>}

      {companies.length > 1 && (
        <CompanySwitcher companies={[{ code: 'ALL', name: tr('All companies') }, ...companies]} company={currentCompany ? currentCompany.code : 'ALL'}
          onPick={pickCompany}
          describe={(co) => {
            const n = devices.filter((d) => isLive(d) && (co.code === 'ALL' || !d.companyId || d.companyId === co.id)).length;
            return n === 1 ? tr('1 device') : tr('{n} devices', { n });
          }} />
      )}

      <Hero
        eyebrow={currentCompany ? currentCompany.name : new Date().toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        title={tr('IT devices')}
        sub={tr('Laptops, phones, tablets, printers and the rest: who has each one, what is spare, what needs looking at. Hand a device over, take it back and mark it checked, and its history keeps itself. Press a number to show only those.')}
        actions={canManage && (
          <>
            <button type="button" className="btn btn-primary" onClick={openNew}>{tr('Register device')}</button>
            <button type="button" className="btn btn-secondary" onClick={openImport}>{tr('Import from sheet')}</button>
          </>
        )}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      {live.length > 0 && (
        <div className="dk-two">
          <Section id="itd-kinds" title={tr('What there is')} sub={tr('Devices by kind, and how many are spare.')}>
            <RankList rows={categoryRows} />
          </Section>
          <Section id="itd-where" title={tr('Where they are used')} sub={tr('Devices in use, by group.')}>
            {deptRows.length ? <RankList rows={deptRows} /> : <p className="dk-muted tl-small">{tr('Nothing in use yet.')}</p>}
          </Section>
        </div>
      )}

      <Section id="itd-list" title={tr('Devices')} sub={tr('Press a device for everyone who has had it.')}
        action={(
          <div className="ppl-view" role="radiogroup" aria-label={tr('View')}>
            {[['cards', tr('Cards')], ['list', tr('List')]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? 'is-on' : ''} onClick={() => { setView(k); writePref('bos.itDevicesView', k); }}>{label}</button>
            ))}
          </div>
        )}>
        <div className="tl-tools">
          <div className="tl-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search tag, model, serial, person…')} /></div>
          {categories.length > 1 && (
            <select className="input tl-select" value={category} onChange={(e) => setCategory(e.target.value)} aria-label={tr('Category')}>
              <option value="">{tr('All categories')}</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
        </div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
        </div>
        {!visible.length ? (
          <div className="dk-empty tl-empty">
            <p>{devices.length ? tr('Nothing matches. Try another search or filter.') : tr('No devices registered yet')}</p>
            {canManage && !devices.length && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('Register device')}</button>}
          </div>
        ) : view === 'cards' ? (
          <div className="tl-grid">
            {visible.map((d) => (
              <article key={d.id} className={'tl-card' + (isLive(d) ? '' : ' st-retired') + (d.assigneeLeft || d.status === 'lost' ? ' st-late' : d.status === 'under_repair' ? ' st-low' : '')}>
                <button type="button" className="tl-card-open" onClick={() => setDetail(d.id)}>
                  <Badge d={d} />
                  <span className="tl-card-head">
                    <span className="dk-muted tl-small">{d.deviceTag} · {d.category}{showCompany && d.companyCode ? ' · ' + d.companyCode : ''}</span>
                    <span className="tl-name">{titleOf(d)}</span>
                  </span>
                </button>
                <span className="tl-menu"><RowMenu actions={actionsFor(d)} /></span>
                <div className="tl-tags">
                  {d.status !== 'in_use' && <Status tone={statusTone(d.status)}>{statusLabel(d.status)}</Status>}
                  {isLive(d) && <span className={'tl-cond is-' + d.condition}>{conditionLabel(d.condition)}</span>}
                  {warrantyEnding(d) && <Status tone="warn">{tr('Warranty ends {date}', { date: fmtDate(d.warrantyUntil) })}</Status>}
                </div>
                {whoOf(d, 26)}
                <div className="tl-foot">
                  <span className="dk-muted tl-small">
                    {d.lastCheckedOn ? tr('Checked {date}', { date: fmtDate(d.lastCheckedOn) }) : tr('Never checked')}
                    {d.purchaseDate ? ' · ' + tr('bought {year}', { year: String(d.purchaseDate).slice(0, 4) }) : ''}
                  </span>
                  {canManage && isLive(d) && (d.assigneeLeft
                    ? <button type="button" className="btn btn-secondary tl-btn" onClick={() => openAct(d, 'back')}>{tr('Take back')}</button>
                    : !d.assignedEmployeeId && d.status === 'in_storage' ? <button type="button" className="btn btn-secondary tl-btn" onClick={() => openAct(d, 'give')}>{tr('Hand over')}</button> : null)}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="tl-table-wrap">
            <table className="tl-table">
              <thead><tr><th>{tr('Device')}</th><th>{tr('With')}</th><th>{tr('Status')}</th><th>{tr('Serial')}</th><th>{tr('Last checked')}</th><th /></tr></thead>
              <tbody>
                {visible.map((d) => (
                  <tr key={d.id} className={isLive(d) ? '' : 'st-retired'}>
                    <td><button type="button" className="tl-row-open" onClick={() => setDetail(d.id)}><Badge d={d} size={32} /><span><span className="tl-name">{titleOf(d)}</span><span className="dk-muted tl-small">{d.deviceTag} · {d.category}</span></span></button></td>
                    <td>{d.assignedEmployeeId ? <span>{d.assigneeName}{d.assigneeLeft && <span className="itd-left"> · {tr('has left')}</span>}</span> : <span className="dk-muted">{d.location || '—'}</span>}</td>
                    <td><span className="tl-cell-stack"><Status tone={statusTone(d.status)}>{statusLabel(d.status)}</Status>{isLive(d) && d.condition !== 'good' && <span className={'tl-cond is-' + d.condition}>{conditionLabel(d.condition)}</span>}</span></td>
                    <td className="itd-serial">{d.serialNumber || '—'}</td>
                    <td className={unchecked(d) ? 'tl-low' : ''}>{d.lastCheckedOn ? fmtDate(d.lastCheckedOn) : tr('Never')}</td>
                    <td className="tl-menu-cell"><RowMenu actions={actionsFor(d)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Glossary items={[
        [tr('Hand over / hand back'), tr('A device given to someone to use, and given back to IT. Both are kept in the device\'s history, so you can see everyone who had it.')],
        [tr('In storage'), tr('Spare: with IT, ready to hand out.')],
        [tr('Checked by IT'), tr('Someone from IT saw the device and it works. Worth doing for every device at least twice a year.')],
        [tr('With people who left'), tr('The person holding it no longer works here. Get it back before it is forgotten.')],
        [tr('Lost / retired'), tr('No longer in use: lost, stolen, broken beyond repair or given away. Its history is kept.')]
      ]} />

      {/* ── one device ── */}
      {cur && (
        <div className="dialog-backdrop" onClick={() => setDetail(null)}>
          <div className="dialog tl-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="tl-detail-head">
              <Badge d={cur} size={56} />
              <div>
                <span className="dk-muted tl-small">{cur.deviceTag} · {cur.category}{cur.serialNumber ? ' · ' + tr('serial {no}', { no: cur.serialNumber }) : ''}</span>
                <h2>{titleOf(cur)}</h2>
                <div className="tl-tags">
                  <Status tone={statusTone(cur.status)}>{statusLabel(cur.status)}</Status>
                  {isLive(cur) && <span className={'tl-cond is-' + cur.condition}>{conditionLabel(cur.condition)}</span>}
                </div>
              </div>
              <button type="button" className="tl-close" onClick={() => setDetail(null)} aria-label={tr('Close')}>×</button>
            </div>
            {cur.assignedEmployeeId && (
              <div className="tl-holder is-inline">
                <div className="tl-holder-head">
                  <Photo id={cur.assignedEmployeeId} name={cur.assigneeName} photo={cur.assigneePhoto} size={36} />
                  <span className="tl-holder-name">
                    <strong>{cur.assigneeName}</strong>
                    <span className="dk-muted tl-small">{cur.assigneeLeft ? <span className="itd-left">{tr('has left the company')}</span> : cur.assignedAt ? tr('has it since {date}', { date: fmtDate(cur.assignedAt) }) : cur.departmentName}</span>
                  </span>
                  <ContactButtons name={cur.assigneeName} phone={cur.assigneePhone} />
                </div>
              </div>
            )}
            <dl className="tl-facts">
              <div><dt>{tr('Group')}</dt><dd>{cur.departmentName || '—'}</dd></div>
              <div><dt>{tr('Location')}</dt><dd>{cur.location || '—'}</dd></div>
              <div><dt>{tr('Bought')}</dt><dd>{cur.purchaseDate ? fmtDate(cur.purchaseDate) : '—'}{cur.purchasePrice ? ' · ' + money(cur.purchasePrice) : ''}</dd></div>
              <div><dt>{tr('Age')}</dt><dd>{age === null ? '—' : age < 1 ? tr('under a year') : Math.floor(age) === 1 ? tr('1 year') : tr('{n} years', { n: Math.floor(age) })}</dd></div>
              <div><dt>{tr('Warranty until')}</dt><dd>{cur.warrantyUntil ? fmtDate(cur.warrantyUntil) : '—'}</dd></div>
              <div><dt>{tr('Last checked')}</dt><dd className={unchecked(cur) ? 'tl-low' : ''}>{cur.lastCheckedOn ? fmtDate(cur.lastCheckedOn) : tr('Never')}</dd></div>
              {cur.companyName && <div><dt>{tr('Company')}</dt><dd>{cur.companyName}</dd></div>}
            </dl>
            {cur.notes && <p className="tl-notes">{cur.notes}</p>}
            <h3 className="tl-h3">{tr('History')}</h3>
            {events === null ? <p className="dk-muted tl-small">{tr('Loading…')}</p> : events.length ? (
              <ul className="tl-log">
                {events.map((ev) => {
                  const dt = new Date(ev.at);
                  return (
                    <li key={ev.id} className={'tl-log-row is-' + ({ assign: 'checkout', return: 'checkin', status: 'retire', check: 'restock' }[ev.kind])}>
                      <span className="tl-date" aria-hidden="true"><strong>{dt.getDate()}</strong><span>{dt.toLocaleDateString(activeIntlLocale(), { month: 'short', year: '2-digit' })}</span></span>
                      <span className="tl-log-main">
                        <span className="tl-log-title">
                          {tr(EVENT_LABELS[ev.kind])}
                          {ev.kind === 'assign' && ev.employeeName ? ' · ' + tr('to {name}', { name: ev.employeeName }) : ''}
                          {ev.kind === 'return' && ev.employeeName ? ' · ' + tr('from {name}', { name: ev.employeeName }) : ''}
                          {ev.kind === 'status' && ev.status ? ' · ' + statusLabel(ev.status) : ''}
                        </span>
                        <span className="dk-muted tl-small">{[
                          ev.condition && (ev.kind === 'check' ? conditionLabel(ev.condition) : tr('came back {condition}', { condition: conditionLabel(ev.condition).toLowerCase() })),
                          ev.note,
                          ev.byName && tr('by {name}', { name: ev.byName })
                        ].filter(Boolean).join(' · ')}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="dk-muted tl-small">{tr('Nothing recorded yet.')}</p>}
            <div className="dialog-actions tl-actions">
              {canManage && <button type="button" className="btn btn-secondary" onClick={() => openEdit(cur)}>{tr('Edit')}</button>}
              {canManage && isLive(cur) && <button type="button" className="btn btn-secondary" onClick={() => openAct(cur, 'check')}>{tr('Mark as checked')}</button>}
              {canManage && isLive(cur) && cur.assignedEmployeeId && <button type="button" className="btn btn-secondary" onClick={() => openAct(cur, 'back')}>{tr('Take back')}</button>}
              {canManage && isLive(cur) && <button type="button" className="btn btn-primary" onClick={() => openAct(cur, 'give')}>{cur.assignedEmployeeId ? tr('Pass to someone else') : tr('Hand over')}</button>}
              {canManage && !isLive(cur) && <button type="button" className="btn btn-primary" onClick={() => { setDetail(null); setStatus(cur, 'in_storage'); }}>{tr('Back in storage')}</button>}
              {!canManage && <button type="button" className="btn btn-primary" onClick={() => setDetail(null)}>{tr('Close')}</button>}
            </div>
          </div>
        </div>
      )}

      {/* ── hand over, take back, check ── */}
      {act && (
        <div className="dialog-backdrop" onClick={() => !saving && setAct(null)}>
          <form className="dialog tl-dialog" onClick={(e) => e.stopPropagation()} onSubmit={saveAct}>
            <h2>{{ give: tr('Hand over {tag}', { tag: act.device.deviceTag }), back: tr('Take back {tag}', { tag: act.device.deviceTag }), check: tr('Check {tag}', { tag: act.device.deviceTag }) }[act.mode]}</h2>
            <p className="dk-muted tl-small">{titleOf(act.device)}{act.device.assignedEmployeeId ? ' · ' + tr('now with {name}', { name: act.device.assigneeName }) : ''}</p>
            <div className="tl-form">
              {act.mode === 'give' && (
                <div className="field tl-span">
                  <label htmlFor="itd-emp">{tr('Who gets it')}</label>
                  <select id="itd-emp" className="input" value={actForm.employeeId} onChange={(e) => setActForm({ ...actForm, employeeId: e.target.value })} required autoFocus>
                    <option value="" disabled>{tr('Select an employee…')}</option>
                    {staff.filter((s) => s.id !== act.device.assignedEmployeeId).map((s) => <option key={s.id} value={s.id}>{s.firstName} {s.lastName}</option>)}
                  </select>
                </div>
              )}
              {act.mode !== 'give' && (
                <div className="field tl-span">
                  <span className="tl-label">{act.mode === 'back' ? tr('What condition did it come back in?') : tr('What condition is it in?')}</span>
                  <div className="tl-seg" role="radiogroup" aria-label={tr('Condition')}>
                    {CONDITIONS.map((c) => <button key={c.key} type="button" role="radio" aria-checked={actForm.condition === c.key} className={'tl-seg-btn is-' + c.key + (actForm.condition === c.key ? ' is-on' : '')} onClick={() => setActForm({ ...actForm, condition: c.key })}>{tr(c.label)}</button>)}
                  </div>
                </div>
              )}
              {act.mode === 'back' && (
                <div className="field tl-span">
                  <label htmlFor="itd-loc">{tr('Where it is kept now')}</label>
                  <input id="itd-loc" className="input" maxLength={120} value={actForm.location} onChange={(e) => setActForm({ ...actForm, location: e.target.value })} />
                </div>
              )}
              <div className="field tl-span">
                <label htmlFor="itd-note">{tr('Note (optional)')}</label>
                <input id="itd-note" className="input" maxLength={300} value={actForm.note} onChange={(e) => setActForm({ ...actForm, note: e.target.value })}
                  placeholder={{ give: tr('Charger and bag included…'), back: tr('Anything missing or wrong…'), check: tr('Updates done, battery…') }[act.mode]} />
              </div>
            </div>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setAct(null)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : { give: tr('Hand over'), back: tr('Take back'), check: tr('Mark as checked') }[act.mode]}</button>
            </div>
          </form>
        </div>
      )}

      {/* ── register / edit ── */}
      {dialogOpen && (
        <div className="dialog-backdrop" onClick={() => !saving && setDialogOpen(false)}>
          <form className="dialog tl-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2>{editId ? tr('Edit device') : tr('Register device')}</h2>
            <div className="tl-form">
              <div className="field">
                <label htmlFor="it-category">{tr('Category')}</label>
                <input id="it-category" className="input" list="itd-categories" maxLength={40} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder={tr('Laptop, Phone, Printer…')} required />
                <datalist id="itd-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
              </div>
              <div className="field">
                <label htmlFor="it-tag">{tr('Device tag')}</label>
                <input id="it-tag" className="input" maxLength={30} value={form.deviceTag} onChange={(e) => setForm({ ...form, deviceTag: e.target.value })} placeholder={tr('Auto-generated if left blank')} disabled={!!editId} />
              </div>
              <div className="field">
                <label htmlFor="it-brand">{tr('Brand')}</label>
                <input id="it-brand" className="input" maxLength={60} value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="it-model">{tr('Model')}</label>
                <input id="it-model" className="input" maxLength={100} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="it-serial">{tr('Serial number')}</label>
                <input id="it-serial" className="input" maxLength={100} value={form.serialNumber} onChange={(e) => setForm({ ...form, serialNumber: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="it-location">{tr('Location')}</label>
                <input id="it-location" className="input" maxLength={120} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="it-assignee">{tr('Assigned to')}</label>
                <select id="it-assignee" className="input" value={form.assignedEmployeeId} onChange={(e) => setForm({ ...form, assignedEmployeeId: e.target.value })}>
                  <option value="">{tr('Unassigned')}</option>
                  {employees.filter((e) => e.status !== 'terminated' || e.id === form.assignedEmployeeId).map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="it-department">{tr('Group')}</label>
                <select id="it-department" className="input" value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })}>
                  <option value="">{tr('Unassigned')}</option>
                  {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="it-purchase-date">{tr('Purchase date')}</label>
                <input id="it-purchase-date" className="input" type="date" value={form.purchaseDate} onChange={(e) => setForm({ ...form, purchaseDate: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="it-purchase-price">{tr('Purchase price (GHS)')}</label>
                <input id="it-purchase-price" className="input" type="number" min="0" step="0.01" value={form.purchasePrice} onChange={(e) => setForm({ ...form, purchasePrice: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="it-warranty">{tr('Warranty until')}</label>
                <input id="it-warranty" className="input" type="date" value={form.warrantyUntil} onChange={(e) => setForm({ ...form, warrantyUntil: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="it-status">{tr('Status')}</label>
                <select id="it-status" className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                  {STATUSES.map((s) => <option key={s.key} value={s.key}>{tr(s.label)}</option>)}
                </select>
              </div>
              <div className="field tl-span">
                <span className="tl-label">{tr('Condition')}</span>
                <div className="tl-seg" role="radiogroup" aria-label={tr('Condition')}>
                  {CONDITIONS.map((c) => <button key={c.key} type="button" role="radio" aria-checked={form.condition === c.key} className={'tl-seg-btn is-' + c.key + (form.condition === c.key ? ' is-on' : '')} onClick={() => setForm({ ...form, condition: c.key })}>{tr(c.label)}</button>)}
                </div>
              </div>
              <div className="field tl-span">
                <label htmlFor="it-notes">{tr('Notes (optional)')}</label>
                <textarea id="it-notes" className="input tl-textarea" maxLength={2000} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </div>
            </div>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialogOpen(false)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : editId ? tr('Save changes') : tr('Register device')}</button>
            </div>
          </form>
        </div>
      )}

      {importOpen && (
        <div className="dialog-backdrop" onClick={() => setImportOpen(false)}>
          <div className="dialog itdevices-import-dialog" onClick={(e) => e.stopPropagation()}>
            <h2 className="itdevices-dialog-title">{tr('Import from IT inventory sheet')}</h2>
            <p className="dialog-body">
              {tr('Export the sheet as CSV (File → Download → Comma-separated values) and upload it here. A sheet row with a Total greater than 1 becomes that many individual devices, all sharing the same brand/model.')}
            </p>
            {importError && <div className="error-banner">{importError}</div>}

            {!importPreview && (
              <>
                <div className="field">
                  <label htmlFor="it-import-file">{tr('CSV file')}</label>
                  <input id="it-import-file" className="input" type="file" accept=".csv,text/csv" onChange={(e) => setImportFile(e.target.files[0] || null)} />
                </div>
                <label className="checkbox-field">
                  <input type="checkbox" checked={importIncludeCreds} onChange={(e) => setImportIncludeCreds(e.target.checked)} />
                  {tr('Include device usernames/passcodes from the sheet in notes (not recommended — stored as plain text)')}
                </label>
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setImportOpen(false)}>{tr('Cancel')}</button>
                  <button type="button" className="btn btn-primary" disabled={!importFile || importLoading} onClick={runImportPreview}>
                    {importLoading ? tr('Reading…') : tr('Preview import')}
                  </button>
                </div>
              </>
            )}

            {importPreview && (
              <>
                <p className="itdevices-import-summary">
                  {tr('{n} device row(s) found — {n2} will be created, {n3} already exist and will be skipped.', { n: importPreview.rows.length, n2: importPreview.rows.filter((r) => !r.willSkip).length, n3: importPreview.rows.filter((r) => r.willSkip).length })}
                </p>
                <div className="itdevices-import-scroll">
                  <table className="table itdevices-import-table">
                    <thead>
                      <tr><th>{tr('Tag')}</th><th>{tr('Brand / model')}</th><th>{tr('Status')}</th><th>{tr('Assigned / location')}</th><th>{tr('Notes')}</th></tr>
                    </thead>
                    <tbody>
                      {importPreview.rows.map((r, i) => (
                        <tr key={i} className={r.willSkip ? 'itdevices-import-row-skip' : ''}>
                          <td style={{ fontWeight: 600 }}>{r.deviceTag}</td>
                          <td>{(r.brand + ' ' + r.model).trim() || '—'}</td>
                          <td>{codeLabel(r.status)}</td>
                          <td>{r.location || (r.assignedEmployeeId ? tr('Matched employee') : '—')}</td>
                          <td className="itdevices-import-warnings">
                            {r.willSkip && <div>{tr('Already exists — will be skipped.')}</div>}
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
                  <button type="button" className="btn btn-primary" disabled={importCommitting} onClick={commitImport}>
                    {importCommitting ? tr('Importing…') : tr('Import {n} device(s)', { n: importPreview.rows.filter((r) => !r.willSkip).length })}
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
