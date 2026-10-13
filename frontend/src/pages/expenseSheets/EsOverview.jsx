import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { downloadProtected } from '../../lib/chatMedia';
import { Empty, Icon, Insights, Section, fmtDate } from '../../components/DashKit';
import { tr } from '../../lib/i18n.jsx';
import { DecideDialog, Dialog, GHS, GHS0, MonthBars, PivotTable, RankBars, Who, daysSince, shortDate } from './EsParts';

// Finance's view: every officer's sheet with its balance, what is waiting
// (top-ups, lines not checked), and the whole company's spending this year.

export default function EsOverview({ sheets, report, topups, can, people, year, onYear, onOpen, onReload, setNotice }) {
  const [dialog, setDialog] = useState(null); // 'new' | 'lists' | { topup }
  const withOfficers = sheets.filter((s) => s.balance > 0).reduce((t, s) => t + s.balance, 0);
  const owed = sheets.filter((s) => s.balance < 0).reduce((t, s) => t - s.balance, 0);
  const spentMonth = sheets.reduce((t, s) => t + s.spentThisMonth, 0);
  const waiting = sheets.reduce((t, s) => t + s.uncheckedLines, 0);
  const stale = sheets.filter((s) => s.lines && (!s.checkedUntil || daysSince(s.checkedUntil) > 30) && s.uncheckedLines > 0);
  const owedTo = sheets.filter((s) => s.balance < 0);
  const low = sheets.filter((s) => s.lines && s.floatLimit && s.balance >= 0 && s.balance < s.floatLimit * 0.2);

  const insights = [];
  if (topups.length) insights.push({ tone: 'warn', icon: 'cash', text: topups.length === 1 ? tr('1 top-up request is waiting for you.') : tr('{n} top-up requests are waiting for you.', { n: topups.length }), action: { label: tr('See them'), run: () => document.getElementById('es-topups') && document.getElementById('es-topups').scrollIntoView({ behavior: 'smooth' }) } });
  if (owedTo.length) insights.push({ tone: 'warn', icon: 'owed', text: owedTo.length === 1 ? tr('The company owes {name} {amount} they spent from their own pocket.', { name: owedTo[0].employee.name, amount: GHS(owed) }) : tr('The company owes {n} officers {amount} they spent from their own pocket.', { n: owedTo.length, amount: GHS(owed) }) });
  if (stale.length) insights.push({ tone: 'info', icon: 'check', text: stale.length === 1 ? tr("{name}'s sheet has not been checked for over 30 days.", { name: stale[0].employee.name }) : tr('{n} sheets not checked for over 30 days: {names}.', { n: stale.length, names: stale.map((s) => s.employee.name).join(', ') }) });
  if (low.length) insights.push({ tone: 'info', icon: 'cash', text: low.length === 1 ? tr('{name} has less than a fifth of the float left.', { name: low[0].employee.name }) : tr('{n} officers have less than a fifth of their float left: {names}.', { n: low.length, names: low.map((s) => s.employee.name).join(', ') }) });

  return (
    <div className="es-overview">
      <section className="es-hero is-finance">
        <div className="es-hero-main">
          <p className="es-eyebrow">{tr('Finance')} · {year}</p>
          <h1 className="es-hero-title">{tr('Expense sheets')}</h1>
          <p className="es-hero-sub">{tr('Every officer\'s float: the money they were given, what they spent it on, and what has been checked.')}</p>
          <div className="es-hero-actions">
            {can.manage && <button type="button" className="es-pill is-main" onClick={() => setDialog('new')}><Icon name="people" /> {tr('Open a sheet for an officer')}</button>}
            <button type="button" className="es-pill" onClick={() => downloadProtected('/expense-sheets/export.csv?year=' + year, 'expense-sheets-' + year + '.csv').catch((e) => setNotice(e.message))}><Icon name="doc" /> {tr('Export all lines')}</button>
            {can.manage && <button type="button" className="es-pill" onClick={() => setDialog('lists')}><Icon name="layers" /> {tr('Categories & cost centres')}</button>}
          </div>
        </div>
        <div className="es-hero-figs">
          <span><small>{tr('Cash with officers')}</small><b>{GHS(withOfficers)}</b></span>
          <span className={owed ? 'is-owed' : ''}><small>{tr('Owed to officers')}</small><b>{GHS(owed)}</b></span>
          <span><small>{tr('Spent this month')}</small><b>{GHS(spentMonth)}</b></span>
          <span><small>{tr('Lines not checked yet')}</small><b>{waiting}</b></span>
        </div>
      </section>

      <Insights items={insights} />

      {topups.length > 0 && (
        <Section id="es-topups" title={tr('Top-ups waiting')} sub={tr('Approving adds the money to the officer\'s sheet.')}>
          <div className="es-topups">
            {topups.map((t) => (
              <div key={t.id} className="es-topup">
                <Who person={t.officer} size={44} />
                <span className="es-topup-text"><b>{t.officer.name}</b><small>{t.reason || tr('No reason given')} · {fmtDate(String(t.requestedAt).slice(0, 10))}</small></span>
                <strong>{GHS(t.amount)}</strong>
                <button type="button" className="btn btn-primary" onClick={() => setDialog({ topup: t })}>{tr('Decide')}</button>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title={tr('Officers')} sub={tr('Press a sheet to open it. The ring is the balance against the usual float; red means the company owes them.')}>
        {sheets.length ? (
          <div className="es-cards">
            {sheets.map((s) => {
              const part = s.floatLimit ? Math.max(0, Math.min(1, Math.abs(s.balance) / s.floatLimit)) : s.balance !== 0 ? 1 : 0;
              const r = 22, c = 2 * Math.PI * r;
              const age = s.checkedUntil ? daysSince(s.checkedUntil) : null;
              return (
                <button key={s.id} type="button" className={'es-officer' + (s.balance < 0 ? ' is-owed' : '') + (s.status === 'closed' ? ' is-closed' : '')} onClick={() => onOpen(s.id)}>
                  <span className="es-officer-top">
                    <Who person={s.employee} size={46} />
                    <span className="es-officer-name"><b>{s.employee.name}</b><small>{s.employee.title || s.employee.department}</small></span>
                    {s.pendingTopups > 0 && <span className="es-badge" title={tr('Top-up waiting')}>{s.pendingTopups}</span>}
                  </span>
                  <span className="es-officer-mid">
                    <span className="es-ring" aria-hidden="true">
                      <svg viewBox="0 0 54 54" width="54" height="54"><circle cx="27" cy="27" r={r} className="es-gauge-track" /><circle cx="27" cy="27" r={r} className="es-gauge-fill" strokeDasharray={c} strokeDashoffset={c * (1 - part)} transform="rotate(-90 27 27)" /></svg>
                    </span>
                    <span className="es-officer-bal"><small>{s.balance < 0 ? tr('owed to them') : tr('cash in hand')}</small><b>{GHS(Math.abs(s.balance))}</b>{s.floatLimit ? <em>{tr('float {amount}', { amount: GHS(s.floatLimit) })}</em> : null}</span>
                  </span>
                  <span className="es-officer-foot">
                    <span><small>{tr('this month')}</small><b>{GHS0(s.spentThisMonth)}</b></span>
                    <span><small>{tr('this year')}</small><b>{GHS0(s.spentThisYear)}</b></span>
                    <span className={age === null ? 'is-warn' : age > 30 ? 'is-warn' : ''}><small>{tr('checked')}</small><b>{s.checkedUntil ? shortDate(s.checkedUntil) : tr('never')}</b></span>
                  </span>
                  {s.uncheckedLines > 0 && <span className="es-officer-wait">{s.uncheckedLines === 1 ? tr('1 line waiting for a check') : tr('{n} lines waiting for a check', { n: s.uncheckedLines })}</span>}
                </button>
              );
            })}
          </div>
        ) : <Empty icon="people">{can.manage ? tr('No expense sheets yet. Open one for each officer who is given a float.') : tr('No expense sheets yet.')}</Empty>}
      </Section>

      {report && (
        <Section title={tr('Spending across the company in {year}', { year })} sub={tr('Every officer\'s lines together: month by month, by category, by cost centre and by officer.')}
          action={<select className="input es-year" value={year} onChange={(e) => onYear(Number(e.target.value))} aria-label={tr('Year')}>{[year - 1, year, year + 1].filter((y) => y <= new Date().getFullYear()).map((y) => <option key={y} value={y}>{y}</option>)}</select>}>
          <div className="es-two">
            <div className="es-card"><h4>{tr('Month by month')}</h4><MonthBars spent={report.monthSpent} funded={report.monthFunded} year={year} /></div>
            <div className="es-card"><h4>{tr('By officer')}</h4><RankBars rows={report.officers.filter((o) => o.spent > 0).map((o) => ({ name: o.name, total: o.spent }))} empty={tr('Nothing spent yet.')} /></div>
          </div>
          <div className="es-card"><h4>{tr('By category and month')}</h4><PivotTable categories={report.categories} monthSpent={report.monthSpent} year={year} /></div>
          <div className="es-card"><h4>{tr('By cost centre')}</h4><RankBars rows={report.costCentres.slice(0, 12)} empty={tr('Nothing spent yet.')} /></div>
        </Section>
      )}

      {dialog === 'new' && <NewSheetDialog people={people} taken={sheets.map((s) => s.employee.id)} onClose={() => setDialog(null)} onDone={(s) => { setDialog(null); onReload(); onOpen(s.id); }} />}
      {dialog === 'lists' && <ListsDialog onClose={() => { setDialog(null); onReload(); }} />}
      {dialog && dialog.topup && <DecideDialog topup={dialog.topup} officer={dialog.topup.officer.name} onClose={() => setDialog(null)} onDone={(t) => { setDialog(null); setNotice(t.status === 'approved' ? tr('Approved and added to the sheet.') : tr('Declined.')); onReload(); }} />}
    </div>
  );
}

function NewSheetDialog({ people, taken, onDone, onClose }) {
  const [emp, setEmp] = useState('');
  const [sup, setSup] = useState('');
  const [limit, setLimit] = useState('');
  const [err, setErr] = useState(null);
  const free = people.filter((p) => taken.indexOf(p.id) < 0);
  async function go() {
    setErr(null);
    try { onDone(await api.post('/expense-sheets', { employeeId: emp, supervisorId: sup || null, floatLimit: limit === '' ? null : Number(limit) })); } catch (ex) { setErr(ex.message); }
  }
  return (
    <Dialog title={tr('Open an expense sheet')} onClose={onClose}>
      <p className="dialog-body">{tr('The officer records what they spend for the company and the money they receive. Their supervisor (their manager unless you choose someone) checks it.')}</p>
      {err && <div className="error-banner">{err}</div>}
      <div className="es-form-grid">
        <label className="es-field is-wide"><span>{tr('Officer')}</span>
          <select className="input" value={emp} onChange={(e) => setEmp(e.target.value)}><option value="">{tr('Choose…')}</option>{free.map((p) => <option key={p.id} value={p.id}>{p.name}{p.department ? ' · ' + p.department : ''}</option>)}</select>
        </label>
        <label className="es-field is-wide"><span>{tr('Checked by (supervisor)')}</span>
          <select className="input" value={sup} onChange={(e) => setSup(e.target.value)}><option value="">{tr('Their manager')}</option>{people.filter((p) => p.id !== emp).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        </label>
        <label className="es-field"><span>{tr('Usual float (GHS)')}</span><input className="input" type="number" min="0" step="0.01" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder={tr('optional')} /></label>
      </div>
      <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="button" className="btn btn-primary" disabled={!emp} onClick={go}>{tr('Open the sheet')}</button></div>
    </Dialog>
  );
}

function ListsDialog({ onClose }) {
  const [lists, setLists] = useState(null);
  const [kind, setKind] = useState('category');
  const [name, setName] = useState('');
  const [err, setErr] = useState(null);
  useEffect(() => { api.get('/expense-sheets/lists').then(setLists).catch((e) => setErr(e.message)); }, []);
  async function save(item) {
    setErr(null);
    try { setLists(await api.post('/expense-sheets/lists', item)); setName(''); } catch (ex) { setErr(ex.message); }
  }
  const rows = lists ? (kind === 'category' ? lists.categories : lists.costCentres) : [];
  return (
    <Dialog title={tr('Categories & cost centres')} onClose={onClose} wide>
      <div className="es-kind">
        <button type="button" className={kind === 'category' ? 'is-on' : ''} onClick={() => setKind('category')}>{tr('Categories')}</button>
        <button type="button" className={kind === 'cost_centre' ? 'is-on' : ''} onClick={() => setKind('cost_centre')}>{tr('Cost centres')}</button>
      </div>
      {err && <div className="error-banner">{err}</div>}
      <form className="es-list-add" onSubmit={(e) => { e.preventDefault(); if (name.trim()) save({ kind, name }); }}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'category' ? tr('New category') : tr('New cost centre (a site, a job)')} maxLength={80} />
        <button type="submit" className="btn btn-primary">{tr('Add')}</button>
      </form>
      <ul className="es-list">
        {rows.map((r) => (
          <li key={r.id} className={r.active ? '' : 'is-off'}>
            <span>{r.name}{r.companyName && r.companyName !== r.name ? <small> · {r.companyName}</small> : null}</span>
            <button type="button" className="es-link" onClick={() => save({ id: r.id, kind, name: r.name, companyId: r.companyId, active: !r.active })}>{r.active ? tr('Hide') : tr('Show again')}</button>
          </li>
        ))}
      </ul>
      <div className="dialog-actions"><button type="button" className="btn btn-primary" onClick={onClose}>{tr('Done')}</button></div>
    </Dialog>
  );
}
