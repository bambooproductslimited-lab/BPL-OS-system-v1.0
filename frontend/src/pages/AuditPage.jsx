import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import SearchInput from '../components/SearchInput';
import Photo from '../components/Photo';
import { Glossary, Hero, Insights, Section, Status, fmtDate, jump } from '../components/DashKit';
import { downloadCsv, rowsToCsv } from '../lib/csvExport';
import { tr, msg, activeIntlLocale } from '../lib/i18n.jsx';
import './EmployeesPage.css';
import './ToolRoomPage.css';
import './AuditPage.css';

// The audit log — every change made in Bamboo OS, who made it and when, in
// the same "explains itself" layout as the dashboards (components/DashKit.jsx):
// how busy the last week was, changes to access and settings, removals and
// after-hours work, the last 30 days day by day, the busiest areas and
// people, and the log itself — narrowed by words, group, person, dates or
// kind, grouped by day, 100 at a time, with a window for each entry and a
// CSV of what is shown (audit.service.js list and summary).

const GROUPS = {
  access: { label: msg('Access & security'), tone: 'bad' },
  settings: { label: msg('Settings'), tone: 'warn' },
  money: { label: msg('Money'), tone: 'info' },
  people: { label: msg('People & work'), tone: 'good' },
  operations: { label: msg('Operations'), tone: 'muted' },
  other: { label: msg('Other'), tone: 'muted' }
};
const AREAS = {
  auth: msg('Sign-in'), user: msg('User accounts'), role: msg('Roles'), mcp: msg('Claude connector'), ai: msg('AI Assistant'),
  settings: msg('Settings'), integration: msg('Integrations'), company: msg('Companies'), department: msg('Departments'), shift: msg('Shifts'), sms: msg('Text messages'), mail: msg('Email'), system: msg('System'),
  invoice: msg('Invoices'), payment: msg('Payments'), receipt: msg('Receipts'), expense: msg('Expenses'), payroll: msg('Payroll'), report: msg('Reports'), estimate: msg('Estimates'), quotation: msg('Quotations'), salesorder: msg('Sales orders'),
  employee: msg('Employees'), leave: msg('Leave'), attendance: msg('Attendance'), task: msg('Tasks'), project: msg('Projects'), announcement: msg('Announcements'), document: msg('Documents'), chat: msg('Messages'), message: msg('Messages'),
  product: msg('Products'), stock: msg('Stock'), warehouse: msg('Warehouses'), toolroom: msg('Tool room'), itdevice: msg('IT devices'), asset: msg('Assets'), maintenance: msg('Maintenance'), waybill: msg('Waybills'),
  production: msg('Production'), rawbatch: msg('Raw bamboo'), procurement: msg('Procurement'), supplier: msg('Suppliers'), catalog: msg('Products & services'), restaurant: msg('Restaurants'), poki: msg('Poki Rentals'),
  customer: msg('Clients'), marketing: msg('Marketing')
};
function areaLabel(a) { return AREAS[a] ? tr(AREAS[a]) : a.charAt(0).toUpperCase() + a.slice(1); }
const EMPTY_FILTERS = { q: '', group: '', actorId: '', from: '', to: '', kind: '' };

function fmtTime(iso) { return new Date(iso).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' }); }
function fmtWhen(iso) { return new Date(iso).toLocaleString(activeIntlLocale(), { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function dayKey(iso) { return new Date(iso).toISOString().slice(0, 10); }
function afterHours(iso) { const h = new Date(iso).getUTCHours(); return h < 6 || h >= 20; }

function Actor({ l, size = 30 }) {
  if (!l.actorUserId) return <span className="au-system" style={{ width: size, height: size }} aria-hidden="true">⚙</span>;
  return <Photo id={l.actorEmployeeId} name={l.actorName} photo={l.actorPhoto} size={size} />;
}

export default function AuditPage() {
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [qInput, setQInput] = useState('');
  const [detail, setDetail] = useState(null);

  // Debounce the search box so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === qInput ? f : { ...f, q: qInput })), 300);
    return () => clearTimeout(t);
  }, [qInput]);

  const query = useCallback((extra) => {
    const params = new URLSearchParams();
    Object.entries({ ...filters, ...(extra || {}) }).forEach(([k, v]) => { if (v) params.set(k, v); });
    return '/audit' + (params.toString() ? '?' + params.toString() : '');
  }, [filters]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await api.get(query());
      setRows(list);
      setMore(list.length === 100);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [query]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/audit/summary').then(setSummary).catch((err) => setError(err.message)); }, []);

  async function loadMore() {
    if (!rows.length) return;
    setLoadingMore(true);
    try {
      const list = await api.get(query({ before: rows[rows.length - 1].at }));
      setRows(rows.concat(list));
      setMore(list.length === 100);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingMore(false);
    }
  }
  function setFilter(patch) { setFilters((f) => ({ ...f, ...patch })); }
  function only(patch) { setQInput(patch.q || ''); setFilters({ ...EMPTY_FILTERS, ...patch }); jump('au-log'); }
  function exportCsv() {
    const csv = rowsToCsv([[tr('When'), tr('Who'), tr('Area'), tr('Action'), tr('What happened')]].concat(rows.map((l) => [fmtWhen(l.at), l.actorUserId ? l.actorName : tr('System'), areaLabel(l.area), l.action, l.summary])));
    downloadCsv('audit-log-' + new Date().toISOString().slice(0, 10) + '.csv', csv);
  }

  if (loading || !summary) return error ? <div className="error-banner" role="alert">{error}</div> : <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const s = summary;
  const change = s.prevWeek ? Math.round(((s.week - s.prevWeek) / s.prevWeek) * 100) : null;
  const busiestPerson = s.people.find((p) => p.id);
  const lateOwl = s.people.filter((p) => p.id && p.afterHours).sort((a, b) => b.afterHours - a.afterHours)[0];
  const maxDay = Math.max(1, ...s.days.map((d) => d.n));
  const busiestDay = s.days.reduce((b, d) => (d.n > b.n ? d : b), s.days[0]);

  const stats = [
    { icon: 'clock', value: String(s.week), label: tr('actions in the last 7 days'), note: change === null ? tr('by {n} people', { n: s.actorsWeek }) : tr('{pct}% on the week before · by {n} people', { pct: (change > 0 ? '+' : '') + change, n: s.actorsWeek }), onClick: () => only({ from: new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10) }) },
    { icon: 'warn', value: String(s.accessChanges + s.settingsChanges), label: tr('changes to access or settings'), note: tr('in the last 30 days · {n} sign-ins', { n: s.signIns }), tone: s.accessChanges + s.settingsChanges ? 'warn' : '', onClick: () => only({ group: 'access' }) },
    { icon: 'void', value: String(s.removals), label: tr('deleted, voided or cancelled'), note: tr('in the last 30 days'), onClick: () => only({ kind: 'removals' }) },
    { icon: 'calendar', value: String(s.afterHours), label: tr('actions after hours'), note: tr('before 6:00 or from 20:00, last 30 days'), tone: s.afterHours ? 'info' : '', onClick: () => only({ kind: 'afterhours' }) }
  ];

  const insights = [];
  if (s.latestAccess) insights.push({ tone: 'warn', icon: 'warn', text: tr('Latest change to access or settings, {date} by {name}: {what}', { date: fmtDate(s.latestAccess.at), name: s.latestAccess.actorName, what: s.latestAccess.summary }), action: { label: tr('Show them'), run: () => only({ group: 'access' }) } });
  if (lateOwl) insights.push({ tone: 'info', icon: 'clock', text: lateOwl.afterHours === 1 ? tr('{name} did 1 thing after hours in the last 30 days.', { name: lateOwl.name }) : tr('{name} did {n} things after hours in the last 30 days, the most of anyone.', { name: lateOwl.name, n: lateOwl.afterHours }), action: { label: tr('Show them'), run: () => only({ actorId: lateOwl.id, kind: 'afterhours' }) } });
  if (s.removals) insights.push({ tone: 'info', icon: 'void', text: s.removals === 1 ? tr('One thing was deleted, voided or cancelled in the last 30 days.') : tr('{n} things were deleted, voided or cancelled in the last 30 days.', { n: s.removals }), action: { label: tr('Show them'), run: () => only({ kind: 'removals' }) } });
  if (busiestPerson) insights.push({ tone: 'good', icon: 'people', text: tr('{name} made the most changes in the last 30 days: {n}.', { name: busiestPerson.name, n: busiestPerson.n }), action: { label: tr('Show them'), run: () => only({ actorId: busiestPerson.id }) } });
  if (busiestDay && busiestDay.n) insights.push({ tone: 'info', icon: 'calendar', text: tr('The busiest day lately was {date}, with {n} actions.', { date: fmtDate(busiestDay.day), n: busiestDay.n }), action: { label: tr('Show them'), run: () => only({ from: busiestDay.day, to: busiestDay.day }) } });
  if (!insights.length) insights.push({ tone: 'good', icon: 'check', text: tr('Nothing recorded in the last 30 days.') });

  const groupCount = (g) => (s.groups.find((x) => x.group === g) || { n: 0 }).n;
  const chips = [['', tr('Everything')]].concat(Object.keys(GROUPS).filter((g) => g !== 'other' || groupCount('other') || filters.group === 'other').map((g) => [g, tr(GROUPS[g].label)]));
  const kinds = [['', tr('Any kind')], ['removals', tr('Deleted, voided or cancelled')], ['afterhours', tr('After hours')]];
  const byDay = [];
  rows.forEach((l) => {
    const k = dayKey(l.at);
    if (!byDay.length || byDay[byDay.length - 1].day !== k) byDay.push({ day: k, rows: [] });
    byDay[byDay.length - 1].rows.push(l);
  });
  const filtered = Object.values(filters).some(Boolean);
  const cur = detail ? rows.find((l) => l.id === detail) : null;

  return (
    <div className="dk tl au">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('Governance')}
        title={tr('Audit log')}
        sub={tr('Every change made in Bamboo OS: who made it, when and what it was. Nothing here can be edited or deleted. Press a number to show only those.')}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      <Section id="au-days" title={tr('The last 30 days')} sub={tr('Actions per day. Press a day to show only its entries.')}>
        <div className="au-chart" role="list" aria-label={tr('Actions per day')}>
          {s.days.map((d) => (
            <button key={d.day} type="button" role="listitem" className={'au-bar' + (filters.from === d.day && filters.to === d.day ? ' is-on' : '')} title={fmtDate(d.day) + ': ' + d.n}
              aria-label={fmtDate(d.day) + ': ' + d.n} onClick={() => only({ from: d.day, to: d.day })}>
              <span style={{ height: Math.max(d.n ? 4 : 0, Math.round((d.n / maxDay) * 100)) + '%' }} />
            </button>
          ))}
        </div>
        <div className="au-axis dk-muted tl-small"><span>{fmtDate(s.days[0].day)}</span><span>{tr('today')}</span></div>
      </Section>

      <div className="au-two">
        <Section id="au-areas" title={tr('What changed')} sub={tr('The busiest areas in the last 30 days.')} card>
          <ol className="au-rank">
            {s.areas.slice(0, 8).map((a) => (
              <li key={a.area}>
                <button type="button" onClick={() => only({ q: a.area + '.' })}>
                  <span className="au-rank-name">{areaLabel(a.area)} <span className="dk-muted tl-small">{tr(GROUPS[a.group].label)}</span></span>
                  <span className="au-rank-n">{a.n}</span>
                  <span className="au-track"><span style={{ width: Math.round((a.n / Math.max(1, s.areas[0].n)) * 100) + '%' }} /></span>
                </button>
              </li>
            ))}
            {!s.areas.length && <li className="dk-muted">{tr('Nothing recorded in the last 30 days.')}</li>}
          </ol>
        </Section>
        <Section id="au-people" title={tr('Who changed things')} sub={tr('Actions in the last 30 days, sign-ins left out.')} card>
          <ol className="au-rank">
            {s.people.slice(0, 8).map((p) => (
              <li key={p.id || 'system'}>
                <button type="button" onClick={() => only({ actorId: p.id || 'system' })}>
                  <span className="au-rank-name au-rank-person">{p.id ? <Photo id={p.employeeId} name={p.name} photo={p.photo} size={24} /> : <span className="au-system" style={{ width: 24, height: 24 }}>⚙</span>}{p.id ? p.name : tr('System')}</span>
                  <span className="au-rank-n">{p.n}</span>
                  <span className="au-track"><span style={{ width: Math.round((p.n / Math.max(1, s.people[0].n)) * 100) + '%' }} /></span>
                </button>
              </li>
            ))}
            {!s.people.length && <li className="dk-muted">{tr('Nothing recorded in the last 30 days.')}</li>}
          </ol>
        </Section>
      </div>

      <Section id="au-log" title={tr('The log')} sub={tr('Newest first, grouped by day. Press an entry to see everything recorded about it.')}
        action={<button type="button" className="btn btn-secondary" disabled={!rows.length} onClick={exportCsv}>{tr('Download CSV')}</button>}>
        <div className="au-filters">
          <div className="tl-search"><SearchInput value={qInput} onChange={setQInput} placeholder={tr('Search actions, people, summaries…')} /></div>
          <select className="input" value={filters.actorId} aria-label={tr('Who')} onChange={(e) => setFilter({ actorId: e.target.value })}>
            <option value="">{tr('Anyone')}</option>
            {s.actors.map((a) => <option key={a.id} value={a.id}>{a.id === 'system' ? tr('System') : a.name}</option>)}
          </select>
          <select className="input" value={filters.kind} aria-label={tr('Kind')} onChange={(e) => setFilter({ kind: e.target.value })}>
            {kinds.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          <label className="au-date"><span>{tr('From')}</span><input type="date" className="input" value={filters.from} onChange={(e) => setFilter({ from: e.target.value })} /></label>
          <label className="au-date"><span>{tr('To')}</span><input type="date" className="input" value={filters.to} onChange={(e) => setFilter({ to: e.target.value })} /></label>
          {filtered && <button type="button" className="btn btn-secondary" onClick={() => { setQInput(''); setFilters(EMPTY_FILTERS); }}>{tr('Clear filters')}</button>}
        </div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Area')}>
          {chips.map(([key, label]) => (
            <button key={key || 'all'} type="button" role="radio" aria-checked={filters.group === key} className={'ppl-chip' + (filters.group === key ? ' is-on' : '')} onClick={() => setFilter({ group: key })}>
              {label}{key && <span className="ppl-chip-n">{groupCount(key)}</span>}
            </button>
          ))}
        </div>
        {!rows.length ? (
          <div className="dk-empty tl-empty"><p>{filtered ? tr('Nothing matches. Try another search or filter.') : tr('No audit activity yet')}</p></div>
        ) : (
          <div className="au-days">
            {byDay.map((d) => (
              <div key={d.day} className="au-day">
                <h4 className="au-day-h">{fmtDate(d.day)} <span className="dk-muted tl-small">{d.rows.length === 1 ? tr('1 action') : tr('{n} actions', { n: d.rows.length })}</span></h4>
                <ul className="au-list">
                  {d.rows.map((l) => (
                    <li key={l.id}>
                      <button type="button" className={'au-row is-' + l.group} onClick={() => setDetail(l.id)}>
                        <span className="au-time">{fmtTime(l.at)}{afterHours(l.at) && <span className="au-late" title={tr('After hours')}>●</span>}</span>
                        <Actor l={l} />
                        <span className="au-main">
                          <span className="au-summary">{l.summary}</span>
                          <span className="dk-muted tl-small">{l.actorUserId ? l.actorName : tr('System')} · {areaLabel(l.area)}</span>
                        </span>
                        <Status tone={GROUPS[l.group].tone}>{tr(GROUPS[l.group].label)}</Status>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {more && <button type="button" className="btn btn-secondary au-more" disabled={loadingMore} onClick={loadMore}>{loadingMore ? tr('Loading…') : tr('Show older entries')}</button>}
          </div>
        )}
      </Section>

      <Glossary items={[
        [tr('Audit log'), tr('A record the system writes itself every time something is changed. Nobody can edit or delete it, not even an administrator.')],
        [tr('Access & security'), tr('Sign-ins, user accounts, roles, and the Claude connector and assistant.')],
        [tr('Settings'), tr('Company settings, integrations, companies, departments, shifts, text messages and email.')],
        [tr('After hours'), tr('Before 6:00 or from 20:00 Ghana time. Not wrong in itself — worth a look if it is unexpected.')],
        [tr('System'), tr('Changes the OS made on its own, like nightly reminders or automatic expiries.')],
        [tr('Action'), tr('The code for what was done, like leave.decide or invoice.void: the area, then what happened.')]
      ]} />

      {cur && (
        <div className="dialog-backdrop" onClick={() => setDetail(null)}>
          <div className="dialog tl-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="tl-detail-head">
              <Actor l={cur} size={56} />
              <div>
                <span className="dk-muted tl-small">{fmtWhen(cur.at)}{afterHours(cur.at) ? ' · ' + tr('After hours') : ''}</span>
                <h2>{cur.actorUserId ? cur.actorName : tr('System')}</h2>
                <div className="tl-tags"><Status tone={GROUPS[cur.group].tone}>{tr(GROUPS[cur.group].label)}</Status></div>
              </div>
              <button type="button" className="tl-close" onClick={() => setDetail(null)} aria-label={tr('Close')}>×</button>
            </div>
            <p className="au-big">{cur.summary}</p>
            <dl className="tl-facts">
              <div><dt>{tr('Area')}</dt><dd>{areaLabel(cur.area)}</dd></div>
              <div><dt>{tr('Action')}</dt><dd><code>{cur.action}</code></dd></div>
              <div><dt>{tr('Record')}</dt><dd><code>{cur.entity}</code> <span className="dk-muted tl-small au-id">{cur.entityId}</span></dd></div>
            </dl>
            {cur.meta && <><h3 className="tl-h3">{tr('Details recorded')}</h3><pre className="au-meta">{JSON.stringify(cur.meta, null, 2)}</pre></>}
            <div className="dialog-actions tl-actions">
              {cur.actorUserId && <button type="button" className="btn btn-secondary" onClick={() => { setDetail(null); only({ actorId: cur.actorUserId }); }}>{tr('Everything by {name}', { name: cur.actorName })}</button>}
              <button type="button" className="btn btn-secondary" onClick={() => { setDetail(null); only({ q: cur.entityId }); }}>{tr('Everything about this record')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
