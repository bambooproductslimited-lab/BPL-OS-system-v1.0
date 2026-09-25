import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import ContactButtons from '../components/ContactButtons';
import RowMenu from '../components/RowMenu';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { Glossary, Hero, Insights, RankList, Section, Status, fmtDate, jump } from '../components/DashKit';
import { money } from '../lib/currency';
import { msg, tr } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import './EmployeesPage.css';
import './ToolRoomPage.css';
import './PokiRentals.css';

// Repairs and issues logged against a unit; the tenant in it at the time is
// attached automatically. Where the tenant is liable (a broken window rather
// than a failing water heater) the cost can be recharged on its own invoice,
// once (pokiBilling.service.js, migration 0091). Same "explains itself"
// layout as the dashboards (components/DashKit.jsx): the key numbers (open,
// urgent, waiting longest, spent this year), what stands out (urgent repairs
// untouched, repairs open a long time, nobody assigned, costs the tenant is
// liable for not yet charged, units that keep breaking), where the money
// goes by property, and the requests as cards — each with who reported it,
// who is fixing it and a call or WhatsApp button for the tenant.

const PRIORITIES = [{ key: 'low', label: msg('Low') }, { key: 'normal', label: msg('Normal') }, { key: 'high', label: msg('High') }, { key: 'urgent', label: msg('Urgent') }];
const STATUSES = [{ key: 'open', label: msg('Open') }, { key: 'in_progress', label: msg('In progress') }, { key: 'resolved', label: msg('Resolved') }, { key: 'closed', label: msg('Closed') }, { key: 'cancelled', label: msg('Cancelled') }];
const CATEGORIES = ['plumbing', 'electrical', 'roof', 'doors & locks', 'painting', 'appliances', 'general'];
const EMPTY = { unitId: '', title: '', description: '', category: 'general', priority: 'normal', reportedBy: '', assignedTo: '', chargeToTenant: false };

function daysSince(iso) {
  if (!iso) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((t - new Date(String(iso).slice(0, 10) + 'T00:00')) / 86400000);
}
function isOpen(r) { return r.status === 'open' || r.status === 'in_progress'; }
function isDone(r) { return r.status === 'resolved' || r.status === 'closed'; }
function unCharged(r) { return r.chargeToTenant && r.cost > 0 && r.bookingId && (!r.chargeInvoiceId || r.chargeInvoiceStatus === 'void'); }
function priorityTone(p) { return p === 'urgent' ? 'bad' : p === 'high' ? 'warn' : 'muted'; }

export default function PokiMaintenancePage() {
  const { can } = useAuth();
  const canManage = can('poki.manage');

  const [requests, setRequests] = useState([]);
  const [units, setUnits] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState('open');
  const [busy, setBusy] = useState(false);

  const [dialog, setDialog] = useState(null); // { id?, resolve? }
  const [form, setForm] = useState(EMPTY);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [r, u] = await Promise.all([api.get('/poki/maintenance'), api.get('/poki/units')]);
      setRequests(r);
      setUnits(u);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (can('employee.read')) api.get('/employees').then(setEmployees).catch(() => {});
  }, [can]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  function openDialog(r, resolve) {
    setDialogError(null);
    if (r) {
      const f = { ...EMPTY };
      Object.keys(r).forEach((k) => { f[k] = r[k] === null || r[k] === undefined ? '' : r[k]; });
      if (resolve) f.status = 'resolved';
      setForm(f);
    } else {
      setForm({ ...EMPTY, unitId: units[0] ? units[0].id : '' });
    }
    setDialog(r ? { id: r.id, resolve: !!resolve } : {});
  }
  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      const body = { ...form, assignedTo: form.assignedTo || null };
      if (dialog.id) await api.patch('/poki/maintenance/' + dialog.id, body);
      else await api.post('/poki/maintenance', body);
      setToast(dialog.id ? (dialog.resolve ? tr('Marked {status}.', { status: codeLabel(form.status) }) : tr('Request updated.')) : tr('Request logged.'));
      setDialog(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }
  async function setStatus(r, status) {
    setBusy(true);
    try {
      await api.patch('/poki/maintenance/' + r.id, { status });
      setToast(tr('Marked {status}.', { status: codeLabel(status) }));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function charge(r) {
    if (!window.confirm(tr('Charge {amount} to {tenant} as a separate invoice?', { amount: money(r.cost, r.currency), tenant: r.tenantName }))) return;
    setBusy(true);
    try {
      const res = await api.post('/poki/maintenance/' + r.id + '/charge');
      setToast(tr('Raised {invoiceNo} for {amount}.', { invoiceNo: res.invoiceNo, amount: money(res.amount, r.currency) }));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const open = requests.filter(isOpen);
  const urgent = open.filter((r) => r.priority === 'urgent' || r.priority === 'high');
  const untouched = urgent.filter((r) => r.status === 'open');
  const oldest = open.slice().sort((x, y) => String(x.reportedOn).localeCompare(String(y.reportedOn)))[0];
  const longOpen = open.filter((r) => daysSince(r.reportedOn) >= 14);
  const nobody = open.filter((r) => !r.assignedTo);
  const toCharge = requests.filter(unCharged);
  const year = String(new Date().getFullYear());
  const doneThisYear = requests.filter((r) => isDone(r) && String(r.resolvedOn || r.reportedOn).slice(0, 4) === year);
  const spentYear = doneThisYear.reduce((s, r) => s + r.cost, 0);
  const recharged = requests.filter((r) => r.chargeInvoiceId && r.chargeInvoiceStatus !== 'void' && String(r.reportedOn).slice(0, 4) === year).reduce((s, r) => s + r.cost, 0);
  const perUnit = {};
  requests.filter((r) => daysSince(r.reportedOn) <= 180 && r.status !== 'cancelled').forEach((r) => { perUnit[r.unitId] = (perUnit[r.unitId] || []).concat(r); });
  const repeat = Object.values(perUnit).filter((l) => l.length >= 3).sort((x, y) => y.length - x.length);
  const byProperty = {};
  doneThisYear.forEach((r) => { byProperty[r.propertyName] = (byProperty[r.propertyName] || 0) + r.cost; });
  const propRows = Object.entries(byProperty).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]).map(([name, v]) => ({ key: name, name, value: v, amount: money(v) }));

  function showOnly(key) { setChip(chip === key ? 'open' : key); jump('pk-reqs'); }
  const stats = [
    { icon: 'warn', value: String(open.length), label: tr('repairs open'), note: open.filter((r) => r.status === 'in_progress').length ? tr('{n} being worked on', { n: open.filter((r) => r.status === 'in_progress').length }) : tr('none started yet'), onClick: () => showOnly('open') },
    { icon: 'clock', value: String(urgent.length), label: tr('high or urgent'), note: untouched.length ? tr('{n} not started', { n: untouched.length }) : tr('all being handled'), tone: untouched.length ? 'bad' : urgent.length ? 'alert' : '', onClick: () => showOnly('urgent') },
    { icon: 'calendar', value: oldest ? tr('{n} days', { n: daysSince(oldest.reportedOn) }) : '—', label: tr('longest waiting'), note: oldest ? oldest.unitCode + ' · ' + oldest.title : tr('nothing waiting'), tone: oldest && daysSince(oldest.reportedOn) >= 14 ? 'alert' : '', onClick: () => showOnly('long') },
    { icon: 'cash', value: money(spentYear), label: tr('spent on repairs this year'), note: recharged ? tr('{amount} of it charged to tenants', { amount: money(recharged) }) : tr('none charged to tenants'), onClick: () => jump('pk-spend') }
  ];

  const insights = [];
  if (untouched.length) insights.push({ tone: 'bad', icon: 'warn', text: untouched.length === 1 ? tr('{priority}: “{title}” at {unit} was reported {n} days ago and nobody has started on it.', { priority: codeLabel(untouched[0].priority), title: untouched[0].title, unit: untouched[0].unitCode, n: daysSince(untouched[0].reportedOn) }) : tr('{n} high or urgent repairs have not been started.', { n: untouched.length }), action: canManage && untouched.length === 1 ? { label: tr('Start it'), run: () => setStatus(untouched[0], 'in_progress') } : { label: tr('Show them'), run: () => showOnly('urgent') } });
  if (toCharge.length) insights.push({ tone: 'warn', icon: 'cash', text: toCharge.length === 1 ? tr('{tenant} is liable for the {amount} repair “{title}”, but it has not been charged.', { tenant: toCharge[0].tenantName, amount: money(toCharge[0].cost, toCharge[0].currency), title: toCharge[0].title }) : tr('{n} repairs tenants are liable for have not been charged.', { n: toCharge.length }), action: canManage && toCharge.length === 1 ? { label: tr('Charge tenant'), run: () => charge(toCharge[0]) } : { label: tr('Show them'), run: () => showOnly('charge') } });
  if (longOpen.length) insights.push({ tone: 'warn', icon: 'calendar', text: longOpen.length === 1 ? tr('“{title}” at {unit} has been open {n} days.', { title: longOpen[0].title, unit: longOpen[0].unitCode, n: daysSince(longOpen[0].reportedOn) }) : tr('{n} repairs have been open for two weeks or more.', { n: longOpen.length }), action: { label: tr('Show them'), run: () => showOnly('long') } });
  if (nobody.length && employees.length) insights.push({ tone: 'info', icon: 'people', text: nobody.length === 1 ? tr('Nobody is assigned to “{title}” at {unit}.', { title: nobody[0].title, unit: nobody[0].unitCode }) : tr('{n} open repairs have nobody assigned.', { n: nobody.length }), action: canManage && nobody.length === 1 ? { label: tr('Assign'), run: () => openDialog(nobody[0]) } : { label: tr('Show them'), run: () => showOnly('nobody') } });
  if (repeat.length) insights.push({ tone: 'info', icon: 'warn', text: tr('{unit} has had {n} repairs in six months. Worth finding out why.', { unit: repeat[0][0].unitCode, n: repeat[0].length }) });
  if (!insights.length && requests.length) insights.push({ tone: 'good', icon: 'check', text: tr('Nothing urgent is waiting, and every repair a tenant is liable for has been charged.') });

  const chipTest = {
    open: isOpen, urgent: (r) => urgent.includes(r), long: (r) => longOpen.includes(r), nobody: (r) => nobody.includes(r),
    charge: unCharged, done: isDone, cancelled: (r) => r.status === 'cancelled', all: () => true
  };
  const visible = requests.filter(chipTest[chip] || chipTest.open)
    .filter((r) => matchesQuery(search, r.title, r.unitCode, r.propertyName, r.tenantName, r.category, r.reportedBy, r.assignedToName));
  const chips = [
    ['open', tr('Open'), open.length], ['urgent', tr('High or urgent'), urgent.length], ['long', tr('Open 2 weeks+'), longOpen.length],
    ['nobody', tr('Nobody assigned'), nobody.length], ['charge', tr('To charge the tenant'), toCharge.length],
    ['done', tr('Done'), requests.filter(isDone).length], ['cancelled', tr('Cancelled'), requests.filter(chipTest.cancelled).length], ['all', tr('All'), requests.length]
  ].filter(([k, , c]) => c > 0 || k === 'open' || k === chip);
  function stateOf(r) {
    if (isOpen(r)) {
      const d = daysSince(r.reportedOn);
      return { tone: r.status === 'in_progress' ? 'info' : d >= 14 ? 'warn' : 'muted', text: (r.status === 'in_progress' ? tr('In progress') : tr('Open')) + ' · ' + (d === 0 ? tr('today') : d === 1 ? tr('1 day') : tr('{n} days', { n: d })) };
    }
    if (isDone(r)) return { tone: 'good', text: r.resolvedOn ? tr('Done {date}', { date: fmtDate(r.resolvedOn) }) : codeLabel(r.status) };
    return { tone: 'muted', text: codeLabel(r.status) };
  }
  function actionsFor(r) {
    return [
      canManage && r.status === 'open' && { label: tr('Start'), onClick: () => setStatus(r, 'in_progress'), disabled: busy },
      canManage && isOpen(r) && { label: tr('Mark done'), onClick: () => openDialog(r, true) },
      canManage && { label: tr('Edit'), onClick: () => openDialog(r) },
      canManage && r.cost > 0 && r.bookingId && (!r.chargeInvoiceId || r.chargeInvoiceStatus === 'void') && { label: tr('Charge tenant'), onClick: () => charge(r), disabled: busy },
      canManage && isOpen(r) && { label: tr('Cancel'), onClick: () => setStatus(r, 'cancelled'), danger: true }
    ].filter(Boolean);
  }
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="dk tl pk">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('Poki Rentals')}
        title={tr('Maintenance')}
        sub={tr('Repairs and problems reported in the units: what is waiting, what is urgent, who is fixing it and what it cost. A repair the tenant caused can be charged to them. Press a number to show only those.')}
        actions={canManage && <button type="button" className="btn btn-primary" disabled={!units.length} onClick={() => openDialog(null)}>{tr('Log request')}</button>}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      <Section id="pk-reqs" title={tr('Requests')} sub={tr('Most urgent first. Press ⋮ to start, finish or charge a repair.')}>
        <div className="tl-tools"><div className="tl-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search requests…')} /></div></div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
        </div>
        {!visible.length ? (
          <div className="dk-empty tl-empty">
            <p>{requests.length ? tr('Try a different search or status filter.') : tr('Log repairs and issues against the unit they affect — the current tenant is attached automatically.')}</p>
            {canManage && !requests.length && units.length > 0 && <button type="button" className="btn btn-primary" onClick={() => openDialog(null)}>{tr('Log request')}</button>}
          </div>
        ) : (
          <div className="tl-grid">
            {visible.map((r) => {
              const st = stateOf(r);
              return (
                <article key={r.id} className={'tl-card' + (isOpen(r) && r.priority === 'urgent' ? ' st-late' : isOpen(r) && r.priority === 'high' ? ' st-low' : '') + (r.status === 'cancelled' ? ' st-retired' : '')}>
                  <div className="tl-card-open pk-static">
                    <span className={'pk-unit-code' + (isOpen(r) ? '' : ' is-let')}>{r.unitCode}</span>
                    <span className="tl-card-head">
                      <span className="dk-muted tl-small">{r.propertyName} · {r.category}</span>
                      <span className="tl-name">{r.title}</span>
                    </span>
                  </div>
                  {actionsFor(r).length > 0 && <span className="tl-menu"><RowMenu actions={actionsFor(r)} /></span>}
                  <div className="tl-tags">
                    {isOpen(r) && r.priority !== 'normal' && <Status tone={priorityTone(r.priority)}>{codeLabel(r.priority)}</Status>}
                    <Status tone={st.tone}>{st.text}</Status>
                    {r.chargeInvoiceNo && r.chargeInvoiceStatus !== 'void' && <Status tone="info">{tr('Charged · {no}', { no: r.chargeInvoiceNo })}</Status>}
                    {unCharged(r) && <Status tone="warn">{tr('Tenant to pay — not charged')}</Status>}
                  </div>
                  {r.description && <p className="dk-muted tl-small pk-desc">{r.description}</p>}
                  <span className="dk-muted tl-small">{[r.reportedBy && tr('reported by {name}', { name: r.reportedBy }), r.assignedToName ? tr('{name} is on it', { name: r.assignedToName }) : isOpen(r) ? tr('nobody assigned') : null, r.resolutionNotes].filter(Boolean).join(' · ')}</span>
                  <div className="tl-foot">
                    <span className="tl-small">{r.cost > 0 ? <strong>{money(r.cost, r.currency)}</strong> : <span className="dk-muted">{tr('no cost recorded')}</span>}{r.tenantName ? <span className="dk-muted"> · {r.tenantName}</span> : <span className="dk-muted"> · {tr('vacant')}</span>}</span>
                    {r.tenantName && <ContactButtons name={r.tenantName} phone={r.tenantPhone} email={r.tenantEmail} />}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </Section>

      {propRows.length > 0 && (
        <Section id="pk-spend" title={tr('Where the money went')} sub={tr('Repairs finished this year, by property.')} card>
          <RankList rows={propRows} />
        </Section>
      )}

      <Glossary items={[
        [tr('Priority'), tr('Urgent: safety, water or power off, the unit can\'t be used. High: fix this week. Normal and low: when convenient.')],
        [tr('Charge tenant'), tr('Raises an invoice to the tenant for the repair cost, where they caused it. A repair is charged once; voiding that invoice lets it be charged again.')],
        [tr('Done'), tr('Resolved or closed. Recording a cost doesn\'t charge anyone.')]
      ]} />

      {dialog && (
        <div className="dialog-backdrop" onClick={() => !saving && setDialog(null)}>
          <form className="dialog tl-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
            <h2>{dialog.resolve ? tr('Mark done: {what}', { what: form.title }) : dialog.id ? tr('Update request') : tr('Log maintenance request')}</h2>
            <div className="tl-form">
              {!dialog.resolve && (
                <>
                  <div className="field tl-span">
                    <label htmlFor="pmr-unit">{tr('Unit')}</label>
                    <select id="pmr-unit" className="input" value={form.unitId} onChange={set('unitId')} required disabled={!!dialog.id}>
                      {units.map((u) => <option key={u.id} value={u.id}>{u.propertyName} · {u.code}{u.tenantName ? ' — ' + u.tenantName : tr(' (vacant)')}</option>)}
                    </select>
                  </div>
                  <div className="field tl-span">
                    <label htmlFor="pmr-title">{tr('Issue')}</label>
                    <input id="pmr-title" className="input" maxLength={160} value={form.title} onChange={set('title')} required placeholder={tr('e.g. Leaking kitchen tap')} />
                  </div>
                  <div className="field">
                    <label htmlFor="pmr-cat">{tr('Category')}</label>
                    <input id="pmr-cat" className="input" list="pmr-cats" value={form.category} onChange={set('category')} placeholder={tr('plumbing, electrical…')} />
                    <datalist id="pmr-cats">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
                  </div>
                  <div className="field">
                    <label htmlFor="pmr-by">{tr('Reported by')}</label>
                    <input id="pmr-by" className="input" value={form.reportedBy} onChange={set('reportedBy')} placeholder={tr('tenant name, caretaker…')} />
                  </div>
                  <div className="field tl-span">
                    <span className="tl-label">{tr('Priority')}</span>
                    <div className="tl-seg" role="radiogroup" aria-label={tr('Priority')}>
                      {PRIORITIES.map((p) => <button key={p.key} type="button" role="radio" aria-checked={form.priority === p.key} className={'tl-seg-btn' + (p.key === 'urgent' ? ' is-poor' : p.key === 'high' ? ' is-fair' : '') + (form.priority === p.key ? ' is-on' : '')} onClick={() => setForm({ ...form, priority: p.key })}>{tr(p.label)}</button>)}
                    </div>
                  </div>
                  <div className="field tl-span">
                    <label htmlFor="pmr-desc">{tr('Description')}</label>
                    <textarea id="pmr-desc" className="input tl-textarea" value={form.description} onChange={set('description')} />
                  </div>
                </>
              )}
              {employees.length > 0 && (
                <div className="field">
                  <label htmlFor="pmr-who">{tr('Who is fixing it')}</label>
                  <select id="pmr-who" className="input" value={form.assignedTo || ''} onChange={set('assignedTo')}>
                    <option value="">{tr('Nobody yet')}</option>
                    {employees.filter((e) => e.status !== 'terminated').map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
                  </select>
                </div>
              )}
              {dialog.id && (
                <>
                  <div className="field">
                    <label htmlFor="pmr-cost">{tr('Repair cost')}</label>
                    <input id="pmr-cost" className="input" type="number" min="0" step="0.01" value={form.cost || ''} onChange={set('cost')} />
                  </div>
                  <div className="field tl-span">
                    <span className="tl-label">{tr('Status')}</span>
                    <div className="tl-seg" role="radiogroup" aria-label={tr('Status')}>
                      {STATUSES.map((s) => <button key={s.key} type="button" role="radio" aria-checked={form.status === s.key} className={'tl-seg-btn' + (form.status === s.key ? ' is-on' : '')} onClick={() => setForm({ ...form, status: s.key })}>{tr(s.label)}</button>)}
                    </div>
                  </div>
                  <div className="field tl-span">
                    <label htmlFor="pmr-res">{tr('Resolution notes')}</label>
                    <textarea id="pmr-res" className="input tl-textarea" value={form.resolutionNotes || ''} onChange={set('resolutionNotes')} placeholder={tr('What was done, parts used…')} />
                  </div>
                </>
              )}
              <label className="checkbox-field tl-span">
                <input type="checkbox" checked={!!form.chargeToTenant} onChange={(e) => setForm({ ...form, chargeToTenant: e.target.checked })} />
                {tr('The tenant caused this and will pay for it')}
              </label>
              {dialog.id && <p className="dk-muted tl-small tl-span">{tr('Recording a cost doesn\'t charge anyone. Use "Charge tenant" on the request to raise an invoice where the tenant is liable.')}</p>}
            </div>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : dialog.resolve ? tr('Mark done') : tr('Save')}</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
