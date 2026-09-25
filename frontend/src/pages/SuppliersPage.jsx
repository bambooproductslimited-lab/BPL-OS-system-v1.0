import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import ContactButtons from '../components/ContactButtons';
import RowMenu from '../components/RowMenu';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { Glossary, Hero, Insights, Section, Status, avatarColor, fmtDate, initials, jump } from '../components/DashKit';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr, trNodes } from '../lib/i18n.jsx';
import './EmployeesPage.css';
import './SuppliersPage.css';

// Suppliers and bamboo farmers. Most of the people here are farmers,
// imported from the sourcing team's "Farmers & Suppliers" sheet (backend
// supplierImport.service.js). Same "explains itself" layout as the
// dashboards (components/DashKit.jsx): the key numbers (who supplies us,
// what they delivered this year, what is owed either way, how many meet
// spec), what stands out, the sourcing pipeline by status, then everyone as
// cards or a list with one-tap call / WhatsApp. A supplier opens in a window
// with everything on file and every raw bamboo batch they delivered
// (suppliers.service.js deliveries()).

const EMPTY_FORM = {
  name: '', contactPerson: '', phone: '', email: '', address: '', materialsSupplied: '',
  region: '', town: '', district: '', phone2: '', quotedPrice: '', priceUnit: '', assessment: '',
  sourcingStatus: '', expectedQty: '', iouAmount: '', iouNotes: '', firstContactDate: '', notes: ''
};
const NO_STAGE = '\u0000none'; // the pipeline tile for suppliers with no sourcing status
const SORTS = [
  { key: 'name', label: msg('Name A–Z') },
  { key: 'delivered', label: msg('Delivered most this year') },
  { key: 'recent', label: msg('Delivered most recently') },
  { key: 'price', label: msg('Lowest quoted price') }
];

// Numbers come back as numbers or null; the form edits strings.
function toForm(s) {
  const f = {};
  Object.keys(EMPTY_FORM).forEach((k) => {
    const v = s[k];
    f[k] = v === null || v === undefined ? '' : String(v);
  });
  return f;
}
function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function n(v, digits = 1) { return Number(v || 0).toLocaleString(activeIntlLocale(), { maximumFractionDigits: digits }); }
function daysSince(iso) {
  if (!iso) return null;
  const today = new Date();
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return Math.round((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(y, m - 1, d)) / 86400000);
}

// Keyed on the importer's dateOrder code rather than translating its English
// sentence, so the explanation reaches the catalogue like any other string.
function dateNote(order) {
  switch (order) {
    case 'mdy': return tr('Dates read as month/day (e.g. 5/13/2021 = 13 May 2021).');
    case 'dmy': return tr('Dates read as day/month (e.g. 13/5/2021 = 13 May 2021).');
    case 'mixed': return tr('This sheet mixes month/day and day/month dates — each was read whichever way it could be. Check them after import.');
    default: return tr('No date on this sheet settles whether it is month/day or day/month — read as day/month. Check them after import.');
  }
}

// Town, district and region, without the repeats the sheet is full of —
// the town and district are often the same name ("Mando, Mando, Central").
function place(s) {
  const parts = [];
  [s.town, s.district, s.region].forEach((p) => {
    if (p && !parts.some((q) => q.toLowerCase() === p.toLowerCase())) parts.push(p);
  });
  return parts.join(', ');
}
function priceLabel(s) {
  if (s.quotedPrice === null || s.quotedPrice === undefined) return null;
  return money(s.quotedPrice, 'GHS') + (s.priceUnit ? ' / ' + s.priceUnit : '');
}
// The assessment is the sourcing team's own wording, shown as written.
function meetsSpec(s) { return /^meets spec$/i.test(s.assessment || ''); }
function Assessment({ s }) {
  if (!s.assessment) return null;
  return <Status tone={meetsSpec(s) ? 'good' : 'warn'}>{s.assessment}</Status>;
}
function Avatar({ name, size = 44 }) {
  return <span className="sp-avatar" style={{ width: size, height: size, background: avatarColor(name), fontSize: Math.round(size * 0.36) }} aria-hidden="true">{initials(name)}</span>;
}

export default function SuppliersPage() {
  const { can } = useAuth();
  const canManage = can('supplier.manage');

  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [search, setSearch] = useState('');
  const [region, setRegion] = useState('');
  const [chip, setChip] = useState('active');
  const [stage, setStage] = useState('');
  const [sort, setSort] = useState(() => readPref('bos.suppliersSort', 'name'));
  const [view, setView] = useState(() => readPref('bos.suppliersView', 'cards'));
  const [viewing, setViewing] = useState(null); // { s, deliveries }

  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importPreview, setImportPreview] = useState(null);
  const [importError, setImportError] = useState(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importCommitting, setImportCommitting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSuppliers(await api.get('/suppliers'));
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

  const regions = useMemo(() => Array.from(new Set(suppliers.map((s) => s.region).filter(Boolean))).sort(), [suppliers]);

  async function openView(s) {
    setViewing({ s, deliveries: null });
    try {
      const deliveries = await api.get('/suppliers/' + s.id + '/deliveries');
      setViewing((cur) => (cur && cur.s.id === s.id ? { ...cur, deliveries } : cur));
    } catch { setViewing((cur) => (cur && cur.s.id === s.id ? { ...cur, deliveries: [] } : cur)); }
  }
  function openNew() {
    setDialogError(null);
    setEditId(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }
  function openEdit(s) {
    setViewing(null);
    setDialogError(null);
    setEditId(s.id);
    setForm(toForm(s));
    setDialogOpen(true);
  }
  function set(k) { return (e) => setForm({ ...form, [k]: e.target.value }); }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      if (editId) await api.put('/suppliers/' + editId, form);
      else await api.post('/suppliers', form);
      setToast(editId ? tr('Supplier updated.') : tr('Supplier added.'));
      setDialogOpen(false);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }
  async function setActive(s, active) {
    try {
      await api.put('/suppliers/' + s.id, { ...toForm(s), status: active ? 'active' : 'inactive' });
      setToast(active ? tr('{name} is active again.', { name: s.name }) : tr('{name} marked inactive.', { name: s.name }));
      setViewing(null);
      await load();
    } catch (err) { setError(err.message); }
  }
  async function confirmDelete() {
    setDeleting(true);
    try {
      await api.del('/suppliers/' + deleteTarget.id);
      setToast(tr('{name} deleted.', { name: deleteTarget.name }));
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  function openImport() {
    setImportFile(null);
    setImportPreview(null);
    setImportError(null);
    setImportOpen(true);
  }
  async function runImportPreview() {
    setImportLoading(true);
    setImportError(null);
    try {
      const fd = new FormData();
      fd.append('file', importFile);
      setImportPreview(await api.upload('/suppliers/import/preview', fd));
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
      const result = await api.post('/suppliers/import/commit', { suppliers: importPreview.suppliers });
      setImportOpen(false);
      setToast(tr('Import finished: {created} added, {updated} updated, {unchanged} unchanged.', result));
      await load();
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImportCommitting(false);
    }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const active = suppliers.filter((s) => s.status === 'active');
  const year = new Date().getFullYear();
  const deliveredYear = active.filter((s) => s.yearDelivered > 0);
  const unitTotals = new Map();
  suppliers.forEach((s) => { if (s.yearDelivered) unitTotals.set(s.deliveredUnit, (unitTotals.get(s.deliveredUnit) || 0) + s.yearDelivered); });
  const mainUnit = Array.from(unitTotals.entries()).sort((a, b) => b[1] - a[1])[0];
  const yearCost = suppliers.reduce((t, s) => t + (s.yearCost || 0), 0);
  const ious = suppliers.filter((s) => s.iouAmount);
  const iouTotal = ious.reduce((t, s) => t + s.iouAmount, 0);
  const assessed = active.filter((s) => s.assessment);
  const good = assessed.filter(meetsSpec);
  const notGood = assessed.filter((s) => !meetsSpec(s));
  const noPhone = active.filter((s) => !s.phone && !s.phone2);
  const waiting = active.filter((s) => s.expectedQty && !s.batchCount);
  const stages = Array.from(active.reduce((m, s) => m.set(s.sourcingStatus || '', (m.get(s.sourcingStatus || '') || 0) + 1), new Map()).entries())
    .sort((a, b) => (a[0] ? 0 : 1) - (b[0] ? 0 : 1) || b[1] - a[1]);

  function showOnly(key) { setChip(chip === key ? 'active' : key); setStage(''); jump('sp-list'); }
  const stats = [
    { icon: 'people', value: n(active.length, 0), label: tr('active suppliers'), note: regions.length === 1 ? tr('in 1 region') : tr('in {n} regions', { n: regions.length }), onClick: () => { setChip('active'); setStage(''); jump('sp-list'); } },
    { icon: 'bag', value: mainUnit ? n(mainUnit[1], 0) + ' ' + mainUnit[0] : '0', label: tr('delivered in {year}', { year }), note: deliveredYear.length ? tr('by {n} suppliers · {cost}', { n: deliveredYear.length, cost: money(yearCost) }) : tr('no deliveries recorded yet'), onClick: () => showOnly('delivered') },
    { icon: 'owed', value: money(iouTotal), label: tr('IOUs on record'), note: ious.length === 1 ? tr('with 1 supplier') : tr('with {n} suppliers', { n: ious.length }), tone: ious.length ? 'alert' : '', onClick: () => showOnly('iou') },
    { icon: 'check', value: assessed.length ? Math.round((good.length / assessed.length) * 100) + '%' : '—', label: tr('meet spec'), note: tr('{good} of {n} assessed', { good: good.length, n: assessed.length }), tone: notGood.length ? '' : 'good', onClick: () => showOnly('spec') }
  ];

  const insights = [];
  if (ious.length) insights.push({ tone: 'warn', icon: 'owed', text: ious.length === 1 ? tr('{name} has an IOU of {amount} on record.', { name: ious[0].name, amount: money(ious[0].iouAmount) }) : tr('{n} suppliers have IOUs on record, {amount} in all. Settle or update them.', { n: ious.length, amount: money(iouTotal) }), action: { label: tr('Show them'), run: () => showOnly('iou') } });
  const meeting = active.filter((s) => /meeting/i.test(s.sourcingStatus || ''));
  if (meeting.length) insights.push({ tone: 'info', icon: 'calendar', text: meeting.length === 1 ? tr('{name} is waiting for a meeting.', { name: meeting[0].name }) : tr('{n} farmers are waiting for a meeting.', { n: meeting.length }), action: { label: tr('Show them'), run: () => { setChip('active'); setStage(meeting[0].sourcingStatus); jump('sp-list'); } } });
  if (notGood.length) insights.push({ tone: 'warn', icon: 'warn', text: notGood.length === 1 ? tr('{name}: "{assessment}".', { name: notGood[0].name, assessment: notGood[0].assessment }) : tr('{n} suppliers do not meet spec or have too many rejects.', { n: notGood.length }), action: { label: tr('Show them'), run: () => showOnly('notspec') } });
  if (waiting.length) insights.push({ tone: 'info', icon: 'bag', text: waiting.length === 1 ? tr('{name} expects to supply {qty} but has not delivered yet.', { name: waiting[0].name, qty: n(waiting[0].expectedQty, 0) }) : tr('{n} suppliers have an expected quantity but no delivery yet.', { n: waiting.length }), action: { label: tr('Show them'), run: () => showOnly('waiting') } });
  const top = deliveredYear.slice().sort((a, b) => b.yearCost - a.yearCost || b.yearDelivered - a.yearDelivered)[0];
  if (top) insights.push({ tone: 'good', icon: 'up', text: tr('Most delivered in {year}: {name}, {qty} {unit}.', { year, name: top.name, qty: n(top.yearDelivered, 0), unit: top.deliveredUnit }), action: { label: tr('Open it'), run: () => openView(top) } });
  if (noPhone.length) insights.push({ tone: 'info', icon: 'phone', text: noPhone.length === 1 ? tr('{name} has no phone number on file.', { name: noPhone[0].name }) : tr('{n} suppliers have no phone number on file.', { n: noPhone.length }), action: { label: tr('Show them'), run: () => showOnly('nophone') } });

  const chipTest = {
    active: (s) => s.status === 'active',
    delivered: (s) => s.yearDelivered > 0,
    iou: (s) => !!s.iouAmount,
    spec: (s) => s.status === 'active' && meetsSpec(s),
    notspec: (s) => s.status === 'active' && s.assessment && !meetsSpec(s),
    waiting: (s) => s.status === 'active' && s.expectedQty && !s.batchCount,
    nophone: (s) => s.status === 'active' && !s.phone && !s.phone2,
    inactive: (s) => s.status !== 'active'
  };
  const sorters = {
    name: (a, b) => a.name.localeCompare(b.name),
    delivered: (a, b) => b.yearDelivered - a.yearDelivered || a.name.localeCompare(b.name),
    recent: (a, b) => String(b.lastDelivery || '').localeCompare(String(a.lastDelivery || '')),
    price: (a, b) => (a.quotedPrice ?? 1e12) - (b.quotedPrice ?? 1e12)
  };
  const visible = suppliers
    .filter(chipTest[chip] || chipTest.active)
    .filter((s) => (!region || s.region === region) && (!stage || (stage === NO_STAGE ? !s.sourcingStatus : s.sourcingStatus === stage)))
    .filter((s) => matchesQuery(search, s.name, s.contactPerson, s.phone, s.phone2, s.materialsSupplied, s.town, s.district, s.region, s.sourcingStatus, s.assessment, s.notes))
    .sort(sorters[sort] || sorters.name);
  const chips = [
    ['active', tr('Active'), active.length],
    ['delivered', tr('Delivered in {year}', { year }), suppliers.filter(chipTest.delivered).length],
    ['iou', tr('IOU on record'), ious.length],
    ['spec', tr('Meets spec'), good.length],
    ['notspec', tr('Not meeting spec'), notGood.length],
    ['waiting', tr('Expected, not delivered'), waiting.length],
    ['nophone', tr('No phone'), noPhone.length],
    ['inactive', tr('Inactive'), suppliers.length - active.length]
  ].filter(([k, , c]) => c > 0 || k === 'active' || k === chip);

  const actionsFor = (s) => [
    { label: tr('Open'), onClick: () => openView(s) },
    canManage && { label: tr('Edit'), onClick: () => openEdit(s) },
    canManage && (s.status === 'active' ? { label: tr('Mark inactive'), onClick: () => setActive(s, false) } : { label: tr('Mark active'), onClick: () => setActive(s, true) }),
    canManage && s.batchCount === 0 && { label: tr('Delete'), onClick: () => { setViewing(null); setDeleteTarget(s); }, danger: true }
  ].filter(Boolean);

  // Preview rows that need a look go first: the ones with warnings, then
  // updates, then plain new rows — so what matters is at the top of a list
  // of seventy.
  const previewRows = importPreview
    ? importPreview.suppliers.slice().sort((a, b) =>
      (b.warnings.length ? 2 : 0) + (b.action === 'update' ? 1 : 0) - ((a.warnings.length ? 2 : 0) + (a.action === 'update' ? 1 : 0)))
    : [];
  const toWrite = importPreview ? importPreview.summary.create + importPreview.summary.update : 0;
  const v = viewing ? viewing.s : null;

  return (
    <div className="dk sp">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={new Date().toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        title={tr('Suppliers & farmers')}
        sub={tr('Who supplies our bamboo and materials, where they are, what they quoted, whether their bamboo meets spec, and what they have delivered. Press a number to show only those.')}
        actions={canManage && (
          <>
            <button type="button" className="btn btn-primary" onClick={openNew}>{tr('Add supplier')}</button>
            <button type="button" className="btn btn-secondary" onClick={openImport}>{tr('Import from sheet')}</button>
          </>
        )}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      {stages.length > 1 && (
        <Section id="sp-pipeline" title={tr('Sourcing pipeline')} sub={tr('Active suppliers by where they are with us. Press one to show only them.')}>
          <div className="sp-stages">
            {stages.map(([name, count]) => (
              <button key={name || '-'} type="button" className={'sp-stage' + (stage === (name || NO_STAGE) ? ' is-on' : '')} onClick={() => { setChip('active'); setStage(stage === (name || NO_STAGE) ? '' : name || NO_STAGE); jump('sp-list'); }}>
                <strong>{count}</strong>
                <span>{name || tr('No status yet')}</span>
              </button>
            ))}
          </div>
        </Section>
      )}

      <Section id="sp-list" title={stage ? tr('Suppliers: {stage}', { stage: stage === NO_STAGE ? tr('No status yet') : stage }) : tr('Everyone')} sub={tr('Press a supplier for everything on file and every delivery.')}
        action={(
          <div className="ppl-view" role="radiogroup" aria-label={tr('View')}>
            {[['cards', tr('Cards')], ['list', tr('List')]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? 'is-on' : ''} onClick={() => { setView(k); writePref('bos.suppliersView', k); }}>{label}</button>
            ))}
          </div>
        )}>
        <div className="sp-tools">
          <div className="sp-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search suppliers…')} /></div>
          {regions.length > 1 && (
            <select className="input sp-select" value={region} onChange={(e) => setRegion(e.target.value)} aria-label={tr('Region')}>
              <option value="">{tr('All regions')}</option>
              {regions.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          )}
          <select className="input sp-select" value={sort} onChange={(e) => { setSort(e.target.value); writePref('bos.suppliersSort', e.target.value); }} aria-label={tr('Sort')}>
            {SORTS.map((o) => <option key={o.key} value={o.key}>{tr(o.label)}</option>)}
          </select>
        </div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => { setChip(key); setStage(''); }}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
        </div>

        {!visible.length ? (
          <div className="dk-empty sp-empty">
            <p>{suppliers.length ? tr('Nothing matches. Try another search or filter.') : tr('No suppliers on file yet')}</p>
            {(search || region || stage || chip !== 'active') && suppliers.length > 0 && <button type="button" className="btn btn-secondary" onClick={() => { setSearch(''); setRegion(''); setStage(''); setChip('active'); }}>{tr('Show all')}</button>}
            {canManage && !suppliers.length && <button type="button" className="btn btn-primary" onClick={openImport}>{tr('Import from sheet')}</button>}
          </div>
        ) : view === 'cards' ? (
          <div className="sp-grid">
            {visible.map((s) => {
              const since = daysSince(s.lastDelivery);
              return (
                <article key={s.id} className={'sp-card' + (s.status !== 'active' ? ' is-inactive' : '') + (s.iouAmount ? ' has-iou' : '')}>
                  <button type="button" className="sp-card-open" onClick={() => openView(s)}>
                    <Avatar name={s.name} />
                    <span className="sp-card-head">
                      <span className="sp-name">{s.name}</span>
                      <span className="dk-muted sp-small">{place(s) || s.materialsSupplied}</span>
                    </span>
                  </button>
                  <span className="sp-menu"><RowMenu actions={actionsFor(s)} /></span>
                  <div className="sp-tags">
                    {s.sourcingStatus && <span className="sp-tag">{s.sourcingStatus}</span>}
                    <Assessment s={s} />
                    {s.status !== 'active' && <Status tone="muted">{tr('Inactive')}</Status>}
                    {s.iouAmount ? <Status tone="warn">{tr('IOU {amount}', { amount: money(s.iouAmount) })}</Status> : null}
                  </div>
                  <dl className="sp-facts">
                    <div><dt>{tr('Quoted')}</dt><dd>{priceLabel(s) || '—'}</dd></div>
                    <div><dt>{tr('Delivered in {year}', { year })}</dt><dd>{s.yearDelivered ? n(s.yearDelivered, 0) + ' ' + s.deliveredUnit : '—'}</dd></div>
                    <div className="sp-span"><dt>{tr('Last delivery')}</dt><dd>{s.lastDelivery ? fmtDate(s.lastDelivery) + (since !== null ? ' · ' + (since === 0 ? tr('today') : since === 1 ? tr('1 day ago') : tr('{n} days ago', { n: since })) : '') : tr('none yet')}</dd></div>
                  </dl>
                  <div className="sp-card-foot">
                    <span className="dk-muted sp-small">{s.phone || s.phone2 || tr('no phone')}</span>
                    <ContactButtons name={s.name} phone={s.phone || s.phone2} email={s.email} />
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="sp-table-wrap">
            <table className="sp-table">
              <thead>
                <tr><th>{tr('Supplier')}</th><th>{tr('Status')}</th><th className="is-num">{tr('Quoted')}</th><th className="is-num">{tr('Delivered in {year}', { year })}</th><th>{tr('Last delivery')}</th><th>{tr('Contact')}</th><th /></tr>
              </thead>
              <tbody>
                {visible.map((s) => (
                  <tr key={s.id} className={s.status !== 'active' ? 'is-inactive' : ''}>
                    <td>
                      <button type="button" className="sp-row-open" onClick={() => openView(s)}>
                        <Avatar name={s.name} size={32} />
                        <span><span className="sp-name">{s.name}</span><span className="dk-muted sp-small">{place(s) || s.materialsSupplied}</span></span>
                      </button>
                    </td>
                    <td><div className="sp-tags">{s.sourcingStatus && <span className="sp-tag">{s.sourcingStatus}</span>}<Assessment s={s} /></div></td>
                    <td className="is-num">{priceLabel(s) || '—'}</td>
                    <td className="is-num">{s.yearDelivered ? n(s.yearDelivered, 0) + ' ' + s.deliveredUnit : '—'}</td>
                    <td>{s.lastDelivery ? fmtDate(s.lastDelivery) : '—'}</td>
                    <td><ContactButtons name={s.name} phone={s.phone || s.phone2} email={s.email} /></td>
                    <td className="sp-menu-cell"><RowMenu actions={actionsFor(s)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Glossary items={[
        [tr('Sourcing status'), tr('Where a farmer is with us, in the sourcing team\'s own words: waiting for a meeting, cutting a sample, cutting, and so on.')],
        [tr('Assessment'), tr('Whether their bamboo meets our spec, from the last sample or delivery.')],
        [tr('Quoted'), tr('The price they quoted, per pole, kg or whatever unit they sell in.')],
        [tr('IOU'), tr('Money on record between us and the supplier, with the story in the IOU notes.')],
        [tr('Delivered'), tr('Raw bamboo received from them, recorded on Raw bamboo & production.')]
      ]} />

      {v && (
        <div className="dialog-backdrop" onClick={() => setViewing(null)}>
          <div className="dialog sp-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="sp-detail-head">
              <Avatar name={v.name} size={56} />
              <div>
                <h2>{v.name}</h2>
                <span className="dk-muted">{place(v) || v.materialsSupplied}</span>
                <div className="sp-tags">
                  {v.sourcingStatus && <span className="sp-tag">{v.sourcingStatus}</span>}
                  <Assessment s={v} />
                  {v.status !== 'active' && <Status tone="muted">{tr('Inactive')}</Status>}
                </div>
              </div>
              <button type="button" className="sp-close" onClick={() => setViewing(null)} aria-label={tr('Close')}>×</button>
            </div>
            <div className="sp-contact-row">
              <span>{[v.contactPerson !== v.name ? v.contactPerson : null, v.phone, v.phone2, v.email].filter(Boolean).join(' · ') || tr('No contact details on file')}</span>
              <ContactButtons name={v.name} phone={v.phone || v.phone2} email={v.email} />
            </div>
            <dl className="sp-facts sp-facts-wide">
              <div><dt>{tr('Materials supplied')}</dt><dd>{v.materialsSupplied || '—'}</dd></div>
              <div><dt>{tr('Quoted price')}</dt><dd>{priceLabel(v) || '—'}</dd></div>
              <div><dt>{tr('Expected quantity')}</dt><dd>{v.expectedQty !== null && v.expectedQty !== undefined ? n(v.expectedQty, 0) : '—'}</dd></div>
              <div><dt>{tr('Delivered, all time')}</dt><dd>{v.delivered ? n(v.delivered, 0) + ' ' + v.deliveredUnit + ' · ' + money(v.deliveredCost) : '—'}</dd></div>
              <div><dt>{tr('First contact')}</dt><dd>{v.firstContactDate ? fmtDate(v.firstContactDate) : '—'}</dd></div>
              <div><dt>{tr('Payment terms')}</dt><dd>{v.paymentTerms || '—'}</dd></div>
              {v.address && <div><dt>{tr('Address')}</dt><dd>{v.address}</dd></div>}
              {v.iouAmount !== null && v.iouAmount !== undefined && <div><dt>{tr('IOU')}</dt><dd>{money(v.iouAmount)}{v.iouNotes ? ' — ' + v.iouNotes : ''}</dd></div>}
            </dl>
            {v.notes && <p className="sp-notes">{v.notes}</p>}
            <h3 className="sp-h3">{tr('Deliveries')}</h3>
            {!viewing.deliveries ? <p className="dk-muted sp-small">{tr('Loading…')}</p> : viewing.deliveries.length ? (
              <div className="sp-table-wrap">
                <table className="sp-table sp-deliveries">
                  <thead><tr><th>{tr('Date')}</th><th>{tr('Batch')}</th><th className="is-num">{tr('Received')}</th><th>{tr('Grade')}</th><th className="is-num">{tr('Cost')}</th><th>{tr('Warehouse')}</th></tr></thead>
                  <tbody>
                    {viewing.deliveries.map((d) => (
                      <tr key={d.id}>
                        <td>{fmtDate(d.date)}</td>
                        <td>{d.batchNo}<span className="dk-muted sp-small"> · {d.species}</span></td>
                        <td className="is-num">{n(d.received)} {d.unit}{d.left < d.received ? <span className="dk-muted sp-small"> · {tr('{n} left', { n: n(d.left) })}</span> : null}</td>
                        <td>{d.grade || '—'}</td>
                        <td className="is-num">{d.cost ? money(d.cost) : '—'}</td>
                        <td>{d.warehouse || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="dk-muted sp-small">{tr('Nothing delivered yet.')}</p>}
            <div className="dialog-actions sp-actions">
              {canManage && (v.status === 'active'
                ? <button type="button" className="btn btn-secondary" onClick={() => setActive(v, false)}>{tr('Mark inactive')}</button>
                : <button type="button" className="btn btn-secondary" onClick={() => setActive(v, true)}>{tr('Mark active')}</button>)}
              {canManage && v.batchCount === 0 && <button type="button" className="btn btn-secondary" onClick={() => { setViewing(null); setDeleteTarget(v); }}>{tr('Delete')}</button>}
              {canManage && <button type="button" className="btn btn-primary" onClick={() => openEdit(v)}>{tr('Edit')}</button>}
              {!canManage && <button type="button" className="btn btn-primary" onClick={() => setViewing(null)}>{tr('Close')}</button>}
            </div>
          </div>
        </div>
      )}

      {dialogOpen && (
        <div className="dialog-backdrop" onClick={() => setDialogOpen(false)}>
          <form className="dialog suppliers-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleSubmit}>
            <h2 className="suppliers-dialog-title">{editId ? tr('Edit supplier') : tr('Add supplier')}</h2>
            {dialogError && <div className="error-banner suppliers-dialog-span">{dialogError}</div>}
            <div className="field suppliers-dialog-span">
              <label htmlFor="sup-name">{tr('Supplier name')}</label>
              <input id="sup-name" className="input" value={form.name} onChange={set('name')} required />
            </div>
            <div className="field">
              <label htmlFor="sup-contact">{tr('Contact person')}</label>
              <input id="sup-contact" className="input" value={form.contactPerson} onChange={set('contactPerson')} required />
            </div>
            <div className="field">
              <label htmlFor="sup-phone">{tr('Phone')}</label>
              <input id="sup-phone" className="input" value={form.phone} onChange={set('phone')} />
            </div>
            <div className="field">
              <label htmlFor="sup-phone2">{tr('Second phone')}</label>
              <input id="sup-phone2" className="input" value={form.phone2} onChange={set('phone2')} />
            </div>
            <div className="field">
              <label htmlFor="sup-email">{tr('Email')}</label>
              <input id="sup-email" className="input" type="email" value={form.email} onChange={set('email')} />
            </div>
            <div className="field suppliers-dialog-span">
              <label htmlFor="sup-materials">{tr('Materials supplied')}</label>
              <input id="sup-materials" className="input" value={form.materialsSupplied} onChange={set('materialsSupplied')} placeholder={tr('e.g. Raw bamboo poles')} required />
            </div>

            <h3 className="suppliers-dialog-section">{tr('Location')}</h3>
            <div className="field">
              <label htmlFor="sup-region">{tr('Region')}</label>
              <input id="sup-region" className="input" value={form.region} onChange={set('region')} list="sup-region-list" />
              <datalist id="sup-region-list">{regions.map((r) => <option key={r} value={r} />)}</datalist>
            </div>
            <div className="field">
              <label htmlFor="sup-town">{tr('Town')}</label>
              <input id="sup-town" className="input" value={form.town} onChange={set('town')} />
            </div>
            <div className="field">
              <label htmlFor="sup-district">{tr('District')}</label>
              <input id="sup-district" className="input" value={form.district} onChange={set('district')} />
            </div>
            <div className="field">
              <label htmlFor="sup-address">{tr('Address')}</label>
              <input id="sup-address" className="input" value={form.address} onChange={set('address')} />
            </div>

            <h3 className="suppliers-dialog-section">{tr('Sourcing')}</h3>
            <div className="field">
              <label htmlFor="sup-price">{tr('Quoted price (GHS)')}</label>
              <input id="sup-price" className="input" type="number" min="0" step="0.01" value={form.quotedPrice} onChange={set('quotedPrice')} />
            </div>
            <div className="field">
              <label htmlFor="sup-unit">{tr('Per')}</label>
              <input id="sup-unit" className="input" value={form.priceUnit} onChange={set('priceUnit')} placeholder={tr('pole, kg, litre…')} />
            </div>
            <div className="field">
              <label htmlFor="sup-assessment">{tr('Assessment')}</label>
              <input id="sup-assessment" className="input" value={form.assessment} onChange={set('assessment')} list="sup-assessment-list" />
              <datalist id="sup-assessment-list">
                <option value="Meets spec" /><option value="Does not meet spec" /><option value="Too many rejects" />
              </datalist>
            </div>
            <div className="field">
              <label htmlFor="sup-status">{tr('Sourcing status')}</label>
              <input id="sup-status" className="input" value={form.sourcingStatus} onChange={set('sourcingStatus')} list="sup-status-list" />
              <datalist id="sup-status-list">
                {Array.from(new Set(['Active', 'Cutting', 'Cutting sample', 'Yet to cut', 'Not cutting', 'Schedule for meeting']
                  .concat(suppliers.map((s) => s.sourcingStatus).filter(Boolean)))).map((v) => <option key={v} value={v} />)}
              </datalist>
            </div>
            <div className="field">
              <label htmlFor="sup-qty">{tr('Expected quantity')}</label>
              <input id="sup-qty" className="input" type="number" min="0" step="1" value={form.expectedQty} onChange={set('expectedQty')} />
            </div>
            <div className="field">
              <label htmlFor="sup-first">{tr('First contact')}</label>
              <input id="sup-first" className="input" type="date" value={form.firstContactDate} onChange={set('firstContactDate')} />
            </div>
            <div className="field">
              <label htmlFor="sup-iou">{tr('IOU (GHS)')}</label>
              <input id="sup-iou" className="input" type="number" step="0.01" value={form.iouAmount} onChange={set('iouAmount')} />
            </div>
            <div className="field">
              <label htmlFor="sup-iou-notes">{tr('IOU notes')}</label>
              <input id="sup-iou-notes" className="input" value={form.iouNotes} onChange={set('iouNotes')} />
            </div>
            <div className="field suppliers-dialog-span">
              <label htmlFor="sup-notes">{tr('Notes')}</label>
              <textarea id="sup-notes" className="input" rows={3} value={form.notes} onChange={set('notes')} />
            </div>

            <div className="dialog-actions suppliers-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setDialogOpen(false)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{editId ? tr('Save changes') : tr('Add supplier')}</button>
            </div>
          </form>
        </div>
      )}

      {importOpen && (
        <div className="dialog-backdrop" onClick={() => setImportOpen(false)}>
          <div className="dialog suppliers-import-dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Import from the farmer & supplier sheet')}</h2>
            <p className="dialog-body">
              {tr('In Google Sheets, open the "Farmers & Suppliers" tab, then File → Download → Comma-separated values, and upload that file here. People on the sheet more than once are merged by phone number. Uploading the sheet again later updates price, assessment, status, expected quantity and IOU — it never duplicates anyone or undoes a name you corrected here.')}
            </p>
            {importError && <div className="error-banner">{importError}</div>}

            {!importPreview && (
              <>
                <div className="field">
                  <label htmlFor="sup-import-file">{tr('CSV file')}</label>
                  <input id="sup-import-file" className="input" type="file" accept=".csv,text/csv" onChange={(e) => setImportFile(e.target.files[0] || null)} />
                </div>
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
                <div className="suppliers-import-summary">
                  <div>{trNodes('{rows} sheet rows → {suppliers} suppliers', { rows: <strong>{importPreview.sheetRows}</strong>, suppliers: <strong>{importPreview.suppliers.length}</strong> })}</div>
                  <div>
                    {tr('{n} new', { n: importPreview.summary.create })} · {tr('{n} updated', { n: importPreview.summary.update })} · {tr('{n} unchanged', { n: importPreview.summary.unchanged })}
                    {!!importPreview.summary.merged && <> · {tr('{n} merged from repeated rows', { n: importPreview.summary.merged })}</>}
                  </div>
                  <div className="suppliers-import-datenote">{dateNote(importPreview.dateOrder)}</div>
                  {!!importPreview.summary.withWarnings && (
                    <div className="suppliers-import-warncount">{tr('{n} need a look — listed first below.', { n: importPreview.summary.withWarnings })}</div>
                  )}
                </div>
                <div className="suppliers-import-list">
                  {previewRows.map((c, i) => (
                    <div key={i} className={'suppliers-import-row suppliers-import-' + c.action}>
                      <div className="suppliers-import-head">
                        <strong>{c.name}</strong>
                        <span className="suppliers-import-meta">{c.phone || tr('no phone')} · {place(c) || '—'} · {tr('sheet rows {rows}', { rows: c.sheetRows.join(', ') })}</span>
                        <span className={'tag ' + (c.action === 'create' ? 'tag-neutral' : 'tag-accent')}>
                          {c.action === 'create' ? tr('New') : c.action === 'update' ? tr('Update') : tr('Unchanged')}
                        </span>
                      </div>
                      {c.action === 'update' && c.changes && c.changes.map((x, xi) => <div key={xi} className="suppliers-import-change">{x}</div>)}
                      {c.warnings.map((w, wi) => <div key={wi} className="suppliers-import-warning">{w}</div>)}
                    </div>
                  ))}
                </div>
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setImportPreview(null)}>{tr('Back')}</button>
                  <button type="button" className="btn btn-secondary" onClick={() => setImportOpen(false)}>{tr('Cancel')}</button>
                  <button type="button" className="btn btn-primary" disabled={importCommitting || !toWrite} onClick={commitImport}>
                    {importCommitting ? tr('Importing…') : toWrite ? tr('Import {n} suppliers', { n: toWrite }) : tr('Nothing to import')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {deleteTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Delete supplier')}</h2>
            <p className="dialog-body">{tr('Delete')} <strong>{deleteTarget.name}</strong>{tr('? This cannot be undone.')}</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={confirmDelete}>{deleting ? tr('Deleting…') : tr('Delete')}</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
