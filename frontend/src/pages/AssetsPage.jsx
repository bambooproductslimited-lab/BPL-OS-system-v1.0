import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import Photo from '../components/Photo';
import RowMenu from '../components/RowMenu';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { CompanySwitcher, Glossary, Hero, Insights, Section, Status, fmtDate, jump } from '../components/DashKit';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './EmployeesPage.css';
import './AssetsPage.css';

// Assets & maintenance: equipment, machines and vehicles. Same "explains
// itself" layout as the dashboards (components/DashKit.jsx): a company
// switcher (an asset with no company belongs to the whole group), the key
// numbers (in use, services due, in for repair, what maintenance cost this
// year), what stands out (overdue services, warranties ending, poor
// condition, assets costing more to keep than they are worth), what is
// coming up, the assets as cards or a list, and the maintenance log. An
// asset opens with its whole history; work can be logged as done or
// planned for a day and marked done later — a completed service moves the
// next one on by the asset's interval (assets.service.js,
// maintenance.service.js, migration 0087).

const CONDITIONS = [{ key: 'good', label: msg('Good') }, { key: 'fair', label: msg('Fair') }, { key: 'poor', label: msg('Poor') }];
const STATUSES = [{ key: 'in_use', label: msg('In use') }, { key: 'in_repair', label: msg('In for repair') }, { key: 'retired', label: msg('Retired') }];
const EMPTY_ASSET = { category: '', description: '', serialNo: '', companyId: '', purchaseDate: '', purchasePrice: '', assignedEmployeeId: '', location: '', condition: 'good', status: 'in_use', warrantyUntil: '', nextServiceDate: '', serviceIntervalDays: '', notes: '' };
const EMPTY_WORK = { assetId: '', mode: 'done', date: '', technician: '', cost: '', downtimeHours: '', partsReplaced: '', faultReport: '', nextServiceDate: '', notes: '' };
const SOON = 7;

function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function isoDay(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function daysUntil(iso) {
  if (!iso) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((new Date(String(iso).slice(0, 10) + 'T00:00') - t) / 86400000);
}
function statusLabel(s) { return tr((STATUSES.find((x) => x.key === s) || STATUSES[0]).label); }
function conditionLabel(c) { return tr((CONDITIONS.find((x) => x.key === c) || CONDITIONS[0]).label); }
function serviceText(a) {
  const d = daysUntil(a.nextServiceDate);
  if (d === null) return null;
  if (d < 0) return { tone: 'bad', text: tr('Service overdue by {n} days', { n: -d }) };
  if (d === 0) return { tone: 'bad', text: tr('Service due today') };
  if (d <= SOON) return { tone: 'warn', text: tr('Service in {n} days', { n: d }) };
  return { tone: 'muted', text: tr('Next service {date}', { date: fmtDate(a.nextServiceDate) }) };
}

const CATEGORY_ICON = {
  vehicle: <path d="M3 16V9.5L5.5 5h9l3 4.5H21V16M3 16h18M3 16v2h3v-2M18 16v2h3v-2M7 12.5h.01M17 12.5h.01" />,
  machine: <><circle cx="12" cy="12" r="3.2" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></>,
  computer: <><rect x="3.5" y="4.5" width="17" height="11" rx="1.5" /><path d="M8 19.5h8M12 15.5v4" /></>,
  other: <path d="M14.7 5.3a4.3 4.3 0 0 1-5.6 5.6L4.5 15.5l3 3 4.6-4.6a4.3 4.3 0 0 1 5.6-5.6l-2.6 2.6-2.4-2.4 2.6-2.6Z" />
};
function iconFor(category) {
  const c = String(category || '').toLowerCase();
  if (/vehic|truck|car|van|bike|motor|forklift/.test(c)) return 'vehicle';
  if (/comput|laptop|it|print|electron/.test(c)) return 'computer';
  if (/mach|equip|saw|plan|press|genera|tool/.test(c)) return 'machine';
  return 'other';
}
function Badge({ a, size = 44 }) {
  return (
    <span className={'as-badge is-' + iconFor(a.category)} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{CATEGORY_ICON[iconFor(a.category)]}</svg>
    </span>
  );
}

export default function AssetsPage() {
  const { can } = useAuth();
  const canManage = can('asset.manage');

  const [assets, setAssets] = useState([]);
  const [records, setRecords] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [companyCode, setCompanyCode] = useState(() => readPref('bos.assetsCompany', 'ALL'));
  const [chip, setChip] = useState('active');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [view, setView] = useState(() => readPref('bos.assetsView', 'cards'));
  const [logChip, setLogChip] = useState('recent');

  const [detail, setDetail] = useState(null); // asset id
  const [assetDialog, setAssetDialog] = useState(null); // { id? }
  const [assetForm, setAssetForm] = useState(EMPTY_ASSET);
  const [work, setWork] = useState(null); // { id? (a planned record being completed) }
  const [workForm, setWorkForm] = useState(EMPTY_WORK);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [a, m] = await Promise.all([api.get('/assets'), api.get('/maintenance')]);
      setAssets(a);
      setRecords(m);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/departments').then(setDepartments).catch(() => {});
    if (canManage) api.get('/employees').then(setEmployees).catch(() => {});
  }, [canManage]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const companies = useMemo(() => {
    const seen = new Map();
    departments.forEach((d) => { if (!seen.has(d.companyId)) seen.set(d.companyId, { id: d.companyId, name: d.companyName, code: d.companyCode || d.companyId }); });
    assets.forEach((a) => { if (a.companyId && !seen.has(a.companyId)) seen.set(a.companyId, { id: a.companyId, name: a.companyName, code: a.companyCode }); });
    return Array.from(seen.values()).sort((x, y) => (x.code === 'BPL' ? -1 : y.code === 'BPL' ? 1 : String(x.name).localeCompare(String(y.name))));
  }, [departments, assets]);
  const currentCompany = companies.find((c) => c.code === companyCode) || null;
  function pickCompany(code) { setCompanyCode(code); writePref('bos.assetsCompany', code); }
  const categories = useMemo(() => Array.from(new Set(assets.map((a) => a.category).filter(Boolean))).sort(), [assets]);

  // ── actions ──────────────────────────────────────────────────────────
  function openNewAsset() {
    setFormError(null);
    setAssetForm({ ...EMPTY_ASSET, companyId: currentCompany ? currentCompany.id : '', category: category || '' });
    setAssetDialog({});
  }
  function openEditAsset(a) {
    setFormError(null);
    const f = {};
    Object.keys(EMPTY_ASSET).forEach((k) => { f[k] = a[k] === null || a[k] === undefined ? '' : String(a[k]); });
    setAssetForm(f);
    setDetail(null);
    setAssetDialog({ id: a.id });
  }
  async function saveAsset(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const r = assetDialog.id ? await api.put('/assets/' + assetDialog.id, assetForm) : await api.post('/assets', assetForm);
      setToast(assetDialog.id ? tr('{no} updated.', { no: r.assetNo }) : tr('Registered {no}.', { no: r.assetNo }));
      setAssetDialog(null);
      await load();
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  }
  async function setStatus(a, status) {
    try {
      await api.put('/assets/' + a.id, { status });
      setToast(status === 'retired' ? tr('{no} retired.', { no: a.assetNo }) : tr('{no} is {status}.', { no: a.assetNo, status: statusLabel(status).toLowerCase() }));
      await load();
    } catch (err) { setError(err.message); }
  }
  function openWork(a, mode) {
    setFormError(null);
    setWorkForm({ ...EMPTY_WORK, assetId: a ? a.id : '', mode, date: mode === 'plan' ? (a && a.nextServiceDate && daysUntil(a.nextServiceDate) >= 0 ? a.nextServiceDate : '') : isoDay(new Date()), faultReport: mode === 'plan' ? tr('Routine service') : '' });
    setWork({});
  }
  function openComplete(r) {
    setFormError(null);
    setWorkForm({ ...EMPTY_WORK, assetId: r.assetId, mode: 'done', date: isoDay(new Date()), technician: r.technician || '', faultReport: r.faultReport, notes: r.notes || '' });
    setWork({ id: r.id, record: r });
  }
  async function saveWork(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      if (work.id) {
        await api.post('/maintenance/' + work.id + '/complete', workForm);
        setToast(tr('Marked done.'));
      } else {
        await api.post('/maintenance', { ...workForm, status: workForm.mode === 'plan' ? 'scheduled' : 'completed' });
        setToast(workForm.mode === 'plan' ? tr('Work planned.') : tr('Maintenance logged.'));
      }
      setWork(null);
      await load();
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  }
  async function dropPlan(r) {
    try { await api.del('/maintenance/' + r.id); setToast(tr('Planned work removed.')); await load(); } catch (err) { setError(err.message); }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const inScope = assets.filter((a) => !currentCompany || !a.companyId || a.companyId === currentCompany.id);
  const scopeIds = new Set(inScope.map((a) => a.id));
  const scopeRecords = records.filter((r) => scopeIds.has(r.assetId));
  const active = inScope.filter((a) => a.status !== 'retired');
  const due = active.filter((a) => a.nextServiceDate && daysUntil(a.nextServiceDate) <= SOON).sort((x, y) => String(x.nextServiceDate).localeCompare(String(y.nextServiceDate)));
  const overdue = due.filter((a) => daysUntil(a.nextServiceDate) < 0);
  const repair = active.filter((a) => a.status === 'in_repair');
  const poor = active.filter((a) => a.condition === 'poor');
  const warranty = active.filter((a) => a.warrantyUntil && daysUntil(a.warrantyUntil) >= 0 && daysUntil(a.warrantyUntil) <= 30);
  const nobody = active.filter((a) => !a.assignedEmployeeId && !a.location);
  const yearCost = active.reduce((s, a) => s + a.yearMaintenanceCost, 0);
  const downtime = scopeRecords.filter((r) => r.status === 'completed' && String(r.date).slice(0, 4) === String(new Date().getFullYear())).reduce((s, r) => s + r.downtimeHours, 0);
  const costly = active.filter((a) => a.purchasePrice > 0 && a.maintenanceCost > a.purchasePrice * 0.5).sort((x, y) => y.maintenanceCost / y.purchasePrice - x.maintenanceCost / x.purchasePrice);
  const planned = scopeRecords.filter((r) => r.status !== 'completed').sort((x, y) => String(x.date).localeCompare(String(y.date)));

  function showOnly(key) { setChip(chip === key ? 'active' : key); jump('as-list'); }
  const stats = [
    { icon: 'drawer', value: String(active.length), label: tr('assets in use'), note: tr('bought for {amount}', { amount: money(active.reduce((s, a) => s + a.purchasePrice, 0)) }), onClick: () => { setChip('active'); jump('as-list'); } },
    { icon: 'calendar', value: String(due.length), label: tr('services due'), note: overdue.length ? tr('{n} overdue', { n: overdue.length }) : tr('in the next {n} days', { n: SOON }), tone: overdue.length ? 'bad' : due.length ? 'alert' : 'good', onClick: () => showOnly('due') },
    { icon: 'warn', value: String(repair.length), label: tr('in for repair'), note: poor.length ? tr('{n} in poor condition', { n: poor.length }) : tr('none in poor condition'), tone: repair.length ? 'alert' : '', onClick: () => showOnly('repair') },
    { icon: 'cash', value: money(yearCost), label: tr('maintenance this year'), note: tr('{n} hours of downtime', { n: Math.round(downtime) }), onClick: () => jump('as-log') }
  ];

  const insights = [];
  if (overdue.length) insights.push({ tone: 'bad', icon: 'calendar', text: overdue.length === 1 ? tr('{no} {name} was due for a service on {date}.', { no: overdue[0].assetNo, name: overdue[0].description, date: fmtDate(overdue[0].nextServiceDate) }) : tr('{n} assets are overdue for a service.', { n: overdue.length }), action: canManage ? { label: tr('Plan it'), run: () => openWork(overdue[0], 'plan') } : { label: tr('Show them'), run: () => showOnly('due') } });
  if (planned.length) {
    const next = planned[0];
    insights.push({ tone: 'info', icon: 'clock', text: planned.length === 1 ? tr('Planned: {what} on {no}, {date}.', { what: next.faultReport, no: next.assetNo, date: fmtDate(next.date) }) : tr('{n} jobs are planned; the next is {what} on {no}, {date}.', { n: planned.length, what: next.faultReport, no: next.assetNo, date: fmtDate(next.date) }), action: { label: tr('Show them'), run: () => { setLogChip('planned'); jump('as-log'); } } });
  }
  if (warranty.length) insights.push({ tone: 'warn', icon: 'doc', text: warranty.length === 1 ? tr('The warranty on {no} {name} ends {date}. Anything to claim, claim now.', { no: warranty[0].assetNo, name: warranty[0].description, date: fmtDate(warranty[0].warrantyUntil) }) : tr('{n} warranties end in the next 30 days.', { n: warranty.length }), action: { label: tr('Show them'), run: () => showOnly('warranty') } });
  if (costly.length) insights.push({ tone: 'warn', icon: 'cash', text: tr('{no} {name} has cost {cost} in maintenance, more than half of the {price} it cost. Worth thinking about replacing it.', { no: costly[0].assetNo, name: costly[0].description, cost: money(costly[0].maintenanceCost), price: money(costly[0].purchasePrice) }), action: { label: tr('Open it'), run: () => setDetail(costly[0].id) } });
  if (poor.length) insights.push({ tone: 'info', icon: 'warn', text: poor.length === 1 ? tr('{no} {name} is in poor condition.', { no: poor[0].assetNo, name: poor[0].description }) : tr('{n} assets are in poor condition.', { n: poor.length }), action: { label: tr('Show them'), run: () => showOnly('poor') } });
  if (nobody.length) insights.push({ tone: 'info', icon: 'people', text: nobody.length === 1 ? tr('{no} {name} has nobody responsible and no location recorded.', { no: nobody[0].assetNo, name: nobody[0].description }) : tr('{n} assets have nobody responsible and no location recorded.', { n: nobody.length }), action: { label: tr('Show them'), run: () => showOnly('nobody') } });
  if (!insights.length && active.length) insights.push({ tone: 'good', icon: 'check', text: tr('Nothing overdue, nothing in for repair.') });

  const chipTest = {
    active: (a) => a.status !== 'retired',
    due: (a) => a.status !== 'retired' && a.nextServiceDate && daysUntil(a.nextServiceDate) <= SOON,
    repair: (a) => a.status === 'in_repair',
    poor: (a) => a.status !== 'retired' && a.condition === 'poor',
    warranty: (a) => warranty.includes(a),
    nobody: (a) => nobody.includes(a),
    retired: (a) => a.status === 'retired'
  };
  const visible = inScope.filter(chipTest[chip] || chipTest.active)
    .filter((a) => !category || a.category === category)
    .filter((a) => matchesQuery(search, a.assetNo, a.description, a.category, a.assigneeName, a.location, a.serialNo, a.notes));
  const chips = [
    ['active', tr('In use'), active.length],
    ['due', tr('Service due'), due.length],
    ['repair', tr('In for repair'), repair.length],
    ['poor', tr('Poor condition'), poor.length],
    ['warranty', tr('Warranty ending'), warranty.length],
    ['nobody', tr('Nobody responsible'), nobody.length],
    ['retired', tr('Retired'), inScope.length - active.length]
  ].filter(([k, , c]) => c > 0 || k === 'active' || k === chip);
  const year = String(new Date().getFullYear());
  const logTest = { recent: (r) => r.status === 'completed', planned: (r) => r.status !== 'completed', year: (r) => r.status === 'completed' && String(r.date).slice(0, 4) === year };
  const log = scopeRecords.filter(logTest[logChip] || logTest.recent).slice(0, logChip === 'year' ? 200 : 25);

  function actionsFor(a) {
    return [
      { label: tr('Open'), onClick: () => setDetail(a.id) },
      canManage && a.status !== 'retired' && { label: tr('Log work done'), onClick: () => openWork(a, 'done') },
      canManage && a.status !== 'retired' && { label: tr('Plan work'), onClick: () => openWork(a, 'plan') },
      canManage && { label: tr('Edit'), onClick: () => openEditAsset(a) },
      canManage && a.status === 'in_use' && { label: tr('Send for repair'), onClick: () => setStatus(a, 'in_repair') },
      canManage && a.status === 'in_repair' && { label: tr('Back in use'), onClick: () => setStatus(a, 'in_use') },
      canManage && (a.status === 'retired' ? { label: tr('Bring back into use'), onClick: () => setStatus(a, 'in_use') } : { label: tr('Retire'), onClick: () => setStatus(a, 'retired'), danger: true })
    ].filter(Boolean);
  }
  const cur = detail ? assets.find((a) => a.id === detail) : null;
  const curRecords = cur ? records.filter((r) => r.assetId === cur.id) : [];
  const showCompany = !currentCompany && companies.length > 1;
  const pickAsset = workForm.assetId ? assets.find((a) => a.id === workForm.assetId) : null;

  return (
    <div className="dk as">
      {error && <div className="error-banner" role="alert">{error}</div>}

      {companies.length > 1 && (
        <CompanySwitcher companies={[{ code: 'ALL', name: tr('All companies') }, ...companies]} company={currentCompany ? currentCompany.code : 'ALL'}
          onPick={pickCompany}
          describe={(co) => {
            const n = assets.filter((a) => a.status !== 'retired' && (co.code === 'ALL' || !a.companyId || a.companyId === co.id)).length;
            return n === 1 ? tr('1 asset') : tr('{n} assets', { n });
          }} />
      )}

      <Hero
        eyebrow={currentCompany ? currentCompany.name : new Date().toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        title={tr('Assets & maintenance')}
        sub={tr('Machines, vehicles and equipment: who has each one, where it is, its condition and when it is next due for a service. Log work as it is done, or plan it for a day. Press a number to show only those.')}
        actions={canManage && (
          <>
            <button type="button" className="btn btn-primary" onClick={openNewAsset}>{tr('Register asset')}</button>
            <button type="button" className="btn btn-secondary" onClick={() => openWork(null, 'done')}>{tr('Log maintenance')}</button>
          </>
        )}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      <Section id="as-list" title={tr('Assets')} sub={tr('Press an asset for everything done to it.')}
        action={(
          <div className="ppl-view" role="radiogroup" aria-label={tr('View')}>
            {[['cards', tr('Cards')], ['list', tr('List')]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? 'is-on' : ''} onClick={() => { setView(k); writePref('bos.assetsView', k); }}>{label}</button>
            ))}
          </div>
        )}>
        <div className="as-tools">
          <div className="as-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search asset, person, location, serial…')} /></div>
          {categories.length > 1 && (
            <select className="input as-select" value={category} onChange={(e) => setCategory(e.target.value)} aria-label={tr('Category')}>
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
          <div className="dk-empty as-empty">
            <p>{assets.length ? tr('Nothing matches. Try another search or filter.') : tr('No assets registered yet.')}</p>
            {canManage && !assets.length && <button type="button" className="btn btn-primary" onClick={openNewAsset}>{tr('Register asset')}</button>}
          </div>
        ) : view === 'cards' ? (
          <div className="as-grid">
            {visible.map((a) => {
              const sv = serviceText(a);
              return (
                <article key={a.id} className={'as-card is-' + a.status + (sv && sv.tone === 'bad' && a.status !== 'retired' ? ' is-overdue' : '')}>
                  <button type="button" className="as-card-open" onClick={() => setDetail(a.id)}>
                    <Badge a={a} />
                    <span className="as-card-head">
                      <span className="dk-muted as-small">{a.assetNo} · {a.category}{showCompany && a.companyCode ? ' · ' + a.companyCode : ''}</span>
                      <span className="as-name">{a.description}</span>
                    </span>
                  </button>
                  <span className="as-menu"><RowMenu actions={actionsFor(a)} /></span>
                  <div className="as-tags">
                    {a.status !== 'in_use' && <Status tone={a.status === 'retired' ? 'muted' : 'warn'}>{statusLabel(a.status)}</Status>}
                    {a.status !== 'retired' && <span className={'as-cond is-' + a.condition}>{conditionLabel(a.condition)}</span>}
                    {a.status !== 'retired' && sv && <Status tone={sv.tone}>{sv.text}</Status>}
                  </div>
                  <div className="as-who">
                    {a.assignedEmployeeId ? <Photo id={a.assignedEmployeeId} name={a.assigneeName} photo={a.assigneePhoto} size={26} /> : <span className="as-nobody" aria-hidden="true">—</span>}
                    <span>{a.assignedEmployeeId ? a.assigneeName : tr('Nobody responsible')}{a.location ? <span className="dk-muted"> · {a.location}</span> : null}</span>
                  </div>
                  <dl className="as-facts">
                    <div><dt>{tr('Maintenance')}</dt><dd>{a.maintenanceCount ? (a.maintenanceCount === 1 ? tr('1 job · {cost}', { cost: money(a.maintenanceCost) }) : tr('{n} jobs · {cost}', { n: a.maintenanceCount, cost: money(a.maintenanceCost) })) : tr('none yet')}</dd></div>
                    <div><dt>{tr('Bought')}</dt><dd>{a.purchasePrice ? money(a.purchasePrice) : '—'}{a.purchaseDate ? <span className="dk-muted"> · {String(a.purchaseDate).slice(0, 4)}</span> : null}</dd></div>
                  </dl>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="as-table-wrap">
            <table className="as-table">
              <thead><tr><th>{tr('Asset')}</th><th>{tr('Responsible')}</th><th>{tr('Condition')}</th><th>{tr('Next service')}</th><th className="is-num">{tr('Maintenance')}</th><th /></tr></thead>
              <tbody>
                {visible.map((a) => {
                  const sv = serviceText(a);
                  return (
                    <tr key={a.id} className={'is-' + a.status}>
                      <td><button type="button" className="as-row-open" onClick={() => setDetail(a.id)}><Badge a={a} size={32} /><span><span className="as-name">{a.description}</span><span className="dk-muted as-small">{a.assetNo} · {a.category}</span></span></button></td>
                      <td>{a.assignedEmployeeId ? a.assigneeName : '—'}{a.location ? <span className="dk-muted as-small"> · {a.location}</span> : null}</td>
                      <td>{a.status === 'retired' ? <Status tone="muted">{statusLabel(a.status)}</Status> : <span className={'as-cond is-' + a.condition}>{conditionLabel(a.condition)}</span>}</td>
                      <td>{a.status !== 'retired' && sv ? <Status tone={sv.tone}>{sv.text}</Status> : '—'}</td>
                      <td className="is-num">{a.maintenanceCost ? money(a.maintenanceCost) : '—'}</td>
                      <td className="as-menu-cell"><RowMenu actions={actionsFor(a)} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section id="as-log" title={tr('Maintenance log')} sub={tr('Services and repairs, newest first; planned work in date order.')}>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {[['recent', tr('Latest'), scopeRecords.filter(logTest.recent).length], ['planned', tr('Planned'), planned.length], ['year', tr('This year'), scopeRecords.filter(logTest.year).length]].map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={logChip === key} className={'ppl-chip' + (logChip === key ? ' is-on' : '')} onClick={() => setLogChip(key)}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
        </div>
        {log.length ? (
          <ul className="as-log">
            {(logChip === 'planned' ? planned : log).map((r) => {
              const d = new Date(String(r.date) + 'T00:00');
              const late = r.status !== 'completed' && daysUntil(r.date) < 0;
              return (
                <li key={r.id} className={'as-log-row' + (r.status !== 'completed' ? ' is-planned' : '') + (late ? ' is-late' : '')}>
                  <span className="as-date" aria-hidden="true"><strong>{d.getDate()}</strong><span>{d.toLocaleDateString(activeIntlLocale(), { month: 'short' })}</span></span>
                  <span className="as-log-main">
                    <span className="as-log-title">{r.faultReport}</span>
                    <span className="dk-muted as-small">
                      <button type="button" className="as-link" onClick={() => setDetail(r.assetId)}>{r.assetNo} {r.assetName}</button>
                      {r.technician ? ' · ' + r.technician : ''}{r.partsReplaced ? ' · ' + tr('parts: {parts}', { parts: r.partsReplaced }) : ''}{r.downtimeHours ? ' · ' + tr('{n} h down', { n: r.downtimeHours }) : ''}
                    </span>
                  </span>
                  <span className="as-log-side">
                    {r.status !== 'completed'
                      ? <Status tone={late ? 'bad' : 'info'}>{late ? tr('Planned, date passed') : tr('Planned')}</Status>
                      : <strong>{r.cost ? money(r.cost) : '—'}</strong>}
                    {canManage && r.status !== 'completed' && (
                      <span className="as-log-acts">
                        <button type="button" className="btn btn-primary as-btn" onClick={() => openComplete(r)}>{tr('Mark done')}</button>
                        <RowMenu actions={[{ label: tr('Remove the plan'), onClick: () => dropPlan(r), danger: true }]} />
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : <p className="dk-muted as-small">{logChip === 'planned' ? tr('Nothing planned.') : tr('No maintenance recorded yet.')}</p>}
      </Section>

      <Glossary items={[
        [tr('Next service'), tr('When the asset is next due for a service. Logging a service moves it on by the asset\'s service interval, if it has one.')],
        [tr('Planned work'), tr('Work booked for a day. Mark it done when it happens, with the cost and the parts.')],
        [tr('In for repair'), tr('Out of use while it is fixed. Logging the repair puts it back in use.')],
        [tr('Downtime'), tr('Hours the asset could not be used because of the work.')],
        [tr('Retired'), tr('No longer used: sold, scrapped or lost. Its history is kept.')]
      ]} />

      {/* ── one asset ── */}
      {cur && (
        <div className="dialog-backdrop" onClick={() => setDetail(null)}>
          <div className="dialog as-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="as-detail-head">
              <Badge a={cur} size={56} />
              <div>
                <span className="dk-muted as-small">{cur.assetNo} · {cur.category}{cur.serialNo ? ' · ' + tr('serial {no}', { no: cur.serialNo }) : ''}</span>
                <h2>{cur.description}</h2>
                <div className="as-tags">
                  <Status tone={cur.status === 'in_use' ? 'good' : cur.status === 'retired' ? 'muted' : 'warn'}>{statusLabel(cur.status)}</Status>
                  <span className={'as-cond is-' + cur.condition}>{conditionLabel(cur.condition)}</span>
                  {cur.status !== 'retired' && serviceText(cur) && <Status tone={serviceText(cur).tone}>{serviceText(cur).text}</Status>}
                </div>
              </div>
              <button type="button" className="as-close" onClick={() => setDetail(null)} aria-label={tr('Close')}>×</button>
            </div>
            <dl className="as-facts as-facts-wide">
              <div><dt>{tr('Responsible')}</dt><dd>{cur.assignedEmployeeId ? cur.assigneeName : '—'}</dd></div>
              <div><dt>{tr('Location')}</dt><dd>{cur.location || '—'}</dd></div>
              <div><dt>{tr('Company')}</dt><dd>{cur.companyName || tr('Whole group')}</dd></div>
              <div><dt>{tr('Bought')}</dt><dd>{cur.purchaseDate ? fmtDate(cur.purchaseDate) : '—'}{cur.purchasePrice ? ' · ' + money(cur.purchasePrice) : ''}</dd></div>
              <div><dt>{tr('Warranty until')}</dt><dd>{cur.warrantyUntil ? fmtDate(cur.warrantyUntil) : '—'}</dd></div>
              <div><dt>{tr('Service every')}</dt><dd>{cur.serviceIntervalDays ? tr('{n} days', { n: cur.serviceIntervalDays }) : '—'}</dd></div>
              <div><dt>{tr('Maintenance, all time')}</dt><dd>{money(cur.maintenanceCost)}{cur.downtimeHours ? ' · ' + tr('{n} h down', { n: cur.downtimeHours }) : ''}</dd></div>
              {cur.retiredOn && <div><dt>{tr('Retired on')}</dt><dd>{fmtDate(cur.retiredOn)}</dd></div>}
            </dl>
            {cur.notes && <p className="as-notes">{cur.notes}</p>}
            <h3 className="as-h3">{tr('History')}</h3>
            {curRecords.length ? (
              <ul className="as-log">
                {curRecords.map((r) => (
                  <li key={r.id} className={'as-log-row' + (r.status !== 'completed' ? ' is-planned' : '')}>
                    <span className="as-date" aria-hidden="true"><strong>{new Date(r.date + 'T00:00').getDate()}</strong><span>{new Date(r.date + 'T00:00').toLocaleDateString(activeIntlLocale(), { month: 'short', year: '2-digit' })}</span></span>
                    <span className="as-log-main">
                      <span className="as-log-title">{r.faultReport}</span>
                      <span className="dk-muted as-small">{[r.technician, r.partsReplaced && tr('parts: {parts}', { parts: r.partsReplaced }), r.downtimeHours ? tr('{n} h down', { n: r.downtimeHours }) : null, r.loggedBy && tr('logged by {name}', { name: r.loggedBy })].filter(Boolean).join(' · ')}</span>
                    </span>
                    <span className="as-log-side">{r.status !== 'completed' ? <Status tone="info">{tr('Planned')}</Status> : <strong>{r.cost ? money(r.cost) : '—'}</strong>}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="dk-muted as-small">{tr('No maintenance recorded yet.')}</p>}
            <div className="dialog-actions as-actions">
              {canManage && cur.status !== 'retired' && <button type="button" className="btn btn-secondary" onClick={() => { setDetail(null); openWork(cur, 'plan'); }}>{tr('Plan work')}</button>}
              {canManage && <button type="button" className="btn btn-secondary" onClick={() => openEditAsset(cur)}>{tr('Edit')}</button>}
              {canManage && cur.status !== 'retired' && <button type="button" className="btn btn-primary" onClick={() => { setDetail(null); openWork(cur, 'done'); }}>{tr('Log work done')}</button>}
              {!canManage && <button type="button" className="btn btn-primary" onClick={() => setDetail(null)}>{tr('Close')}</button>}
            </div>
          </div>
        </div>
      )}

      {/* ── register / edit ── */}
      {assetDialog && (
        <div className="dialog-backdrop" onClick={() => !saving && setAssetDialog(null)}>
          <form className="dialog as-dialog" onClick={(e) => e.stopPropagation()} onSubmit={saveAsset}>
            <h2>{assetDialog.id ? tr('Edit asset') : tr('Register asset')}</h2>
            <div className="as-form">
              <div className="field as-span">
                <label htmlFor="as-desc">{tr('What is it')}</label>
                <input id="as-desc" className="input" maxLength={120} value={assetForm.description} onChange={(e) => setAssetForm({ ...assetForm, description: e.target.value })} placeholder={tr('e.g. Toyota Hilux GT-1234-20')} required />
              </div>
              <div className="field">
                <label htmlFor="as-category">{tr('Category')}</label>
                <input id="as-category" className="input" list="as-categories" maxLength={40} value={assetForm.category} onChange={(e) => setAssetForm({ ...assetForm, category: e.target.value })} placeholder={tr('Vehicle, Machine, Computer…')} required />
                <datalist id="as-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
              </div>
              <div className="field">
                <label htmlFor="as-serial">{tr('Serial or registration no. (optional)')}</label>
                <input id="as-serial" className="input" maxLength={80} value={assetForm.serialNo} onChange={(e) => setAssetForm({ ...assetForm, serialNo: e.target.value })} />
              </div>
              {companies.length > 1 && (
                <div className="field">
                  <label htmlFor="as-company">{tr('Company')}</label>
                  <select id="as-company" className="input" value={assetForm.companyId} onChange={(e) => setAssetForm({ ...assetForm, companyId: e.target.value })}>
                    <option value="">{tr('Whole group')}</option>
                    {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              )}
              <div className="field">
                <label htmlFor="as-assignee">{tr('Responsible')}</label>
                <select id="as-assignee" className="input" value={assetForm.assignedEmployeeId} onChange={(e) => setAssetForm({ ...assetForm, assignedEmployeeId: e.target.value })}>
                  <option value="">{tr('Nobody')}</option>
                  {employees.map((em) => <option key={em.id} value={em.id}>{em.firstName} {em.lastName}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="as-location">{tr('Location')}</label>
                <input id="as-location" className="input" maxLength={120} value={assetForm.location} onChange={(e) => setAssetForm({ ...assetForm, location: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="as-date">{tr('Purchase date')}</label>
                <input id="as-date" className="input" type="date" value={assetForm.purchaseDate} onChange={(e) => setAssetForm({ ...assetForm, purchaseDate: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="as-price">{tr('Purchase price (GHS)')}</label>
                <input id="as-price" className="input" type="number" min="0" step="any" value={assetForm.purchasePrice} onChange={(e) => setAssetForm({ ...assetForm, purchasePrice: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="as-warranty">{tr('Warranty until (optional)')}</label>
                <input id="as-warranty" className="input" type="date" value={assetForm.warrantyUntil} onChange={(e) => setAssetForm({ ...assetForm, warrantyUntil: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="as-interval">{tr('Service every (days, optional)')}</label>
                <input id="as-interval" className="input" type="number" min="1" step="1" value={assetForm.serviceIntervalDays} onChange={(e) => setAssetForm({ ...assetForm, serviceIntervalDays: e.target.value })} placeholder="90" />
              </div>
              <div className="field">
                <label htmlFor="as-next">{tr('Next service (optional)')}</label>
                <input id="as-next" className="input" type="date" value={assetForm.nextServiceDate} onChange={(e) => setAssetForm({ ...assetForm, nextServiceDate: e.target.value })} />
              </div>
              <div className="field as-span">
                <span className="as-label">{tr('Condition')}</span>
                <div className="as-seg" role="radiogroup" aria-label={tr('Condition')}>
                  {CONDITIONS.map((c) => <button key={c.key} type="button" role="radio" aria-checked={assetForm.condition === c.key} className={'as-seg-btn is-' + c.key + (assetForm.condition === c.key ? ' is-on' : '')} onClick={() => setAssetForm({ ...assetForm, condition: c.key })}>{tr(c.label)}</button>)}
                </div>
              </div>
              {assetDialog.id && (
                <div className="field as-span">
                  <span className="as-label">{tr('Status')}</span>
                  <div className="as-seg" role="radiogroup" aria-label={tr('Status')}>
                    {STATUSES.map((c) => <button key={c.key} type="button" role="radio" aria-checked={assetForm.status === c.key} className={'as-seg-btn' + (assetForm.status === c.key ? ' is-on' : '')} onClick={() => setAssetForm({ ...assetForm, status: c.key })}>{tr(c.label)}</button>)}
                  </div>
                </div>
              )}
              <div className="field as-span">
                <label htmlFor="as-notes">{tr('Notes (optional)')}</label>
                <textarea id="as-notes" className="input as-textarea" maxLength={1000} value={assetForm.notes} onChange={(e) => setAssetForm({ ...assetForm, notes: e.target.value })} />
              </div>
            </div>
            {formError && <div className="error-banner">{formError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setAssetDialog(null)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : assetDialog.id ? tr('Save changes') : tr('Register asset')}</button>
            </div>
          </form>
        </div>
      )}

      {/* ── log / plan / complete work ── */}
      {work && (
        <div className="dialog-backdrop" onClick={() => !saving && setWork(null)}>
          <form className="dialog as-dialog" onClick={(e) => e.stopPropagation()} onSubmit={saveWork}>
            <h2>{work.id ? tr('Mark done: {what}', { what: work.record.faultReport }) : workForm.mode === 'plan' ? tr('Plan work') : tr('Log maintenance')}</h2>
            {!work.id && (
              <div className="as-seg" role="radiogroup" aria-label={tr('Done or planned')}>
                <button type="button" role="radio" aria-checked={workForm.mode === 'done'} className={'as-seg-btn' + (workForm.mode === 'done' ? ' is-on' : '')} onClick={() => setWorkForm({ ...workForm, mode: 'done', date: isoDay(new Date()) })}>{tr('Done')}</button>
                <button type="button" role="radio" aria-checked={workForm.mode === 'plan'} className={'as-seg-btn' + (workForm.mode === 'plan' ? ' is-on' : '')} onClick={() => setWorkForm({ ...workForm, mode: 'plan', date: '' })}>{tr('Planned for a day')}</button>
              </div>
            )}
            <div className="as-form">
              {!work.id && (
                <div className="field as-span">
                  <label htmlFor="mt-asset">{tr('Asset')}</label>
                  <select id="mt-asset" className="input" value={workForm.assetId} onChange={(e) => setWorkForm({ ...workForm, assetId: e.target.value })} required>
                    <option value="" disabled>{tr('Choose an asset')}</option>
                    {assets.filter((a) => a.status !== 'retired').map((a) => <option key={a.id} value={a.id}>{a.assetNo} — {a.description}</option>)}
                  </select>
                </div>
              )}
              <div className="field as-span">
                <label htmlFor="mt-fault">{workForm.mode === 'plan' ? tr('What needs doing') : tr('What was done, or the fault')}</label>
                <input id="mt-fault" className="input" maxLength={300} value={workForm.faultReport} onChange={(e) => setWorkForm({ ...workForm, faultReport: e.target.value })} required />
              </div>
              <div className="field">
                <label htmlFor="mt-date">{workForm.mode === 'plan' ? tr('Planned for') : tr('Date')}</label>
                <input id="mt-date" className="input" type="date" value={workForm.date} max={workForm.mode === 'plan' ? undefined : isoDay(new Date())} onChange={(e) => setWorkForm({ ...workForm, date: e.target.value })} required />
              </div>
              <div className="field">
                <label htmlFor="mt-tech">{tr('Technician or garage')}{workForm.mode === 'plan' ? ' ' + tr('(optional)') : ''}</label>
                <input id="mt-tech" className="input" maxLength={60} value={workForm.technician} onChange={(e) => setWorkForm({ ...workForm, technician: e.target.value })} required={workForm.mode !== 'plan'} />
              </div>
              {workForm.mode !== 'plan' && (
                <>
                  <div className="field">
                    <label htmlFor="mt-cost">{tr('Cost (GHS)')}</label>
                    <input id="mt-cost" className="input" type="number" min="0" step="any" value={workForm.cost} onChange={(e) => setWorkForm({ ...workForm, cost: e.target.value })} />
                  </div>
                  <div className="field">
                    <label htmlFor="mt-downtime">{tr('Downtime (hours)')}</label>
                    <input id="mt-downtime" className="input" type="number" min="0" step="any" value={workForm.downtimeHours} onChange={(e) => setWorkForm({ ...workForm, downtimeHours: e.target.value })} />
                  </div>
                  <div className="field as-span">
                    <label htmlFor="mt-parts">{tr('Parts replaced')}</label>
                    <input id="mt-parts" className="input" value={workForm.partsReplaced} onChange={(e) => setWorkForm({ ...workForm, partsReplaced: e.target.value })} />
                  </div>
                  <div className="field as-span">
                    <label htmlFor="mt-next">{tr('Next service (optional)')}</label>
                    <input id="mt-next" className="input" type="date" value={workForm.nextServiceDate} onChange={(e) => setWorkForm({ ...workForm, nextServiceDate: e.target.value })} />
                    <span className="dk-muted as-small">{pickAsset && pickAsset.serviceIntervalDays ? tr('Leave blank and it is set {n} days after this service.', { n: pickAsset.serviceIntervalDays }) : tr('Leave blank to keep the current date.')}</span>
                  </div>
                </>
              )}
            </div>
            {formError && <div className="error-banner">{formError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setWork(null)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : work.id ? tr('Mark done') : workForm.mode === 'plan' ? tr('Plan it') : tr('Log it')}</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
