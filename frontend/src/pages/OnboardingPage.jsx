import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './seventeenth.css';
import './eighteenth.css';

// Joiners and leavers (People → Joiners and leavers; backend
// onboarding.service.js, migration 0199): a checklist for someone's first
// days or their last, each step for HR, IT, finance, their manager or the
// person; a leaver's list names what they hand back, the exit interview and
// the final pay. My space shows each person the steps waiting on them.

function dayText(d, opts) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC', ...opts }) : '—'; }
function hue(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function today() { return new Date().toISOString().slice(0, 10); }
const OWNER = { hr: ['🧑‍💼', msg('HR')], it: ['💻', msg('IT')], finance: ['💰', msg('Finance')], manager: ['🧭', msg('Their manager')], person: ['🙋', msg('Them')] };
const REASON = { resigned: msg('Resigned'), end_of_contract: msg('End of contract'), dismissed: msg('Dismissed'), retired: msg('Retired'), other: msg('Other') };
function dayWords(l) {
  const n = l.daysTo;
  if (l.kind === 'join') return n === 0 ? tr('starts today') : n === 1 ? tr('starts tomorrow') : n > 1 ? tr('starts in {n} days', { n }) : n === -1 ? tr('started yesterday') : tr('started {n} days ago', { n: -n });
  return n === 0 ? tr('leaves today') : n === 1 ? tr('leaves tomorrow') : n > 1 ? tr('leaves in {n} days', { n }) : n === -1 ? tr('left yesterday') : tr('left {n} days ago', { n: -n });
}

function Ring({ done, total }) {
  const p = total ? Math.round(done / total * 100) : 0;
  return <span className="bk-ring" style={{ '--p': p }} role="img" aria-label={tr('{d} of {n} done', { d: done, n: total })}><b>{p}%</b></span>;
}

function StepRow({ s, onTick, busy }) {
  return (
    <div className={'ob-step' + (s.done ? ' is-done' : '') + (s.late ? ' is-late' : '')}>
      <button type="button" className="ob-tick" disabled={!s.canTick || busy} onClick={() => onTick(s)} aria-pressed={s.done} aria-label={s.done ? tr('Not done') : tr('Done')}>{s.done ? '✓' : ''}</button>
      <span className="x7-who"><b>{s.title}</b>
        <small>{s.done ? tr('done {date} by {name}', { date: dayText(s.doneAt), name: s.doneBy || '—' }) : (s.late ? '⏰ ' : '') + tr('by {date}', { date: dayText(s.dueOn, { weekday: 'short' }) }) + (s.assignee ? ' · ' + s.assignee.name : '')}</small>
      </span>
    </div>
  );
}

function ExitForm({ list, onDone }) {
  const [f, setF] = useState({ reason: '', rating: 0, rehire: null, comments: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.post('/onboarding/' + list.id + '/exit', f)); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <form className="x7-form" onSubmit={save}>
      <h3>🎙️ {tr('Exit interview')}</h3>
      <label><span>{tr('Why are they leaving?')}</span><input className="input" required value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder={tr('e.g. A job nearer home')} /></label>
      <div className="x7-grid2">
        <label><span>{tr('How was it to work here? (1–5)')}</span><span className="x7-score">{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" className={f.rating === n ? 'is-on' : ''} onClick={() => setF({ ...f, rating: n })}>{n}</button>)}</span></label>
        <label><span>{tr('Would we take them back?')}</span><span className="x7-seg" style={{ alignSelf: 'flex-start' }}>{[[true, tr('Yes')], [false, tr('No')]].map(([v, l]) => <button key={String(v)} type="button" className={f.rehire === v ? 'is-on' : ''} onClick={() => setF({ ...f, rehire: v })}>{l}</button>)}</span></label>
      </div>
      <label><span>{tr('What they said')}</span><textarea className="input" rows={3} value={f.comments} onChange={(e) => setF({ ...f, comments: e.target.value })} /></label>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="dialog-actions"><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save')}</button></div>
    </form>
  );
}

function ListSheet({ id, onClose, onChanged }) {
  const [l, setL] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const load = useCallback(() => api.get('/onboarding/' + id).then(setL).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  async function tick(s) {
    setBusy(true); setError(null);
    try { const x = await api.post('/onboarding/steps/' + s.id, { done: !s.done }); if (x && x.steps) setL(x); else await load(); onChanged(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function cancel() {
    if (!window.confirm(tr('Cancel this checklist?'))) return;
    try { setL(await api.post('/onboarding/' + id + '/cancel', {})); onChanged(); } catch (e) { setError(e.message); }
  }
  if (!l) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const join = l.kind === 'join';
  const groups = Object.keys(OWNER).map((o) => [o, l.steps.filter((s) => s.owner === o)]).filter(([, list]) => list.length);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet is-wide" role="dialog" aria-modal="true" aria-labelledby="ob-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={join ? { '--g1': '#047857', '--g2': '#0284c7' } : { '--g1': '#b45309', '--g2': '#be185d' }}>
          <span className="x7-avatar" style={{ '--h': hue(l.employee.name) }} aria-hidden="true">{l.employee.name.charAt(0)}</span>
          <div><small>{[l.employee.position, l.employee.department, l.employee.company].filter(Boolean).join(' · ')}</small><h2 id="ob-t">{l.employee.name}</h2>
            <p><span className="x7-pill">{join ? '🧳 ' + tr('First day {date}', { date: dayText(l.day, { weekday: 'short' }) }) : '👋 ' + tr('Last day {date}', { date: dayText(l.day, { weekday: 'short' }) })}</span>
              {l.reason && <span className="x7-pill">{tr(REASON[l.reason] || REASON.other)}</span>}
              <span className="x7-pill">✅ {tr('{d} of {n} done', { d: l.done, n: l.total })}</span>
              {l.status !== 'open' && <span className="x7-pill">{l.status === 'done' ? '🎉 ' + tr('All done') : '✖ ' + tr('Cancelled')}</span>}</p></div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {l.finalPay && (
          <div className="x7-facts">
            <div><dt>💵 {tr('Salary advance still owed')}</dt><dd>{l.finalPay.advanceOwed > 0 ? money(l.finalPay.advanceOwed, 'GHS') : tr('None')}</dd></div>
            <div><dt>🧾 {tr('Last payslip')}</dt><dd>{l.finalPay.lastRun ? l.finalPay.lastRun.runNo + ' · ' + money(l.finalPay.lastRun.net, 'GHS') : '—'}</dd></div>
          </div>
        )}
        <div className="ob-groups">
          {groups.map(([o, list]) => (
            <section key={o} className="ob-group">
              <h3><em aria-hidden="true">{OWNER[o][0]}</em> {tr(OWNER[o][1])} <small>{list.filter((s) => s.done).length}/{list.length}</small></h3>
              {list.map((s) => <StepRow key={s.id} s={s} onTick={tick} busy={busy} />)}
            </section>
          ))}
        </div>
        {!join && l.canManage && (l.exit ? (
          <div className="x7-sec">
            <h3>🎙️ {tr('Exit interview')}</h3>
            <dl className="x7-facts">
              <div><dt>{tr('Why')}</dt><dd>{l.exit.reason}</dd></div>
              <div><dt>{tr('Rating')}</dt><dd>{l.exit.rating ? '★'.repeat(l.exit.rating) + '☆'.repeat(5 - l.exit.rating) : '—'}</dd></div>
              <div><dt>{tr('Would we take them back?')}</dt><dd>{l.exit.rehire === true ? '👍 ' + tr('Yes') : l.exit.rehire === false ? '👎 ' + tr('No') : '—'}</dd></div>
            </dl>
            {l.exit.comments && <p className="x7-note">💬 {l.exit.comments}</p>}
          </div>
        ) : l.status === 'open' && <ExitForm list={l} onDone={(x) => { setL(x); onChanged(); }} />)}
        {l.canManage && l.status === 'open' && <div className="x7-actions"><button type="button" className="btn btn-secondary is-end" onClick={cancel}>✖ {tr('Cancel the checklist')}</button></div>}
      </div>
    </div>
  );
}

function StartDialog({ d, kind, person, onClose, onDone }) {
  const [f, setF] = useState({ kind, employeeId: person || '', day: kind === 'join' ? (d.noList.find((p) => p.id === person) || {}).hireDate || today() : '', reason: 'resigned' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const who = d.people.find((p) => p.id === f.employeeId);
  const co = who ? d.companies.find((c) => c.name === who.company) : null;
  const steps = (co ? d.templates.byCompany[co.id] : d.templates.all)[f.kind];
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.post('/onboarding', f)); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" role="dialog" aria-modal="true" aria-labelledby="ob-s-t" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">{f.kind === 'join' ? '🧳' : '👋'}</span><div><h2 id="ob-s-t">{f.kind === 'join' ? tr('Someone is starting') : tr('Someone is leaving')}</h2><p>{tr('Each step goes to HR, IT, finance, their manager or them, with its day.')}</p></div></div>
        <div className="x7-seg" style={{ alignSelf: 'flex-start' }}>{[['join', tr('Starting')], ['leave', tr('Leaving')]].map(([k, l]) => <button key={k} type="button" className={f.kind === k ? 'is-on' : ''} onClick={() => setF({ ...f, kind: k, day: k === 'join' ? today() : '' })}>{l}</button>)}</div>
        <label><span>{tr('Who?')}</span><select className="input" required value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value, day: f.kind === 'join' ? (d.people.find((p) => p.id === e.target.value) || {}).hireDate || f.day : f.day })}><option value="">—</option>{d.people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.position ? ' · ' + p.position : ''}</option>)}</select></label>
        <div className="x7-grid2">
          <label><span>{f.kind === 'join' ? tr('First day') : tr('Last day')}</span><input className="input" type="date" required value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} /></label>
          {f.kind === 'leave' && <label><span>{tr('Why')}</span><select className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}>{Object.keys(REASON).map((k) => <option key={k} value={k}>{tr(REASON[k])}</option>)}</select></label>}
        </div>
        <p className="x7-note">📋 {tr('{n} steps', { n: steps.length })}{f.kind === 'leave' ? ' ' + tr('— and one for each device, tool and asset they hold.') : ''}</p>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Start the checklist')}</button></div>
      </form>
    </div>
  );
}

function StepsDialog({ d, onClose, onDone }) {
  const [kind, setKind] = useState('join');
  const [company, setCompany] = useState('');
  const pick = (k, c) => ((c ? d.templates.byCompany[c] : d.templates.all)[k] || []).map((s) => ({ ...s }));
  const [steps, setSteps] = useState(() => pick('join', ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  function choose(k, c) { setKind(k); setCompany(c); setSteps(pick(k, c)); }
  const set = (i, patch) => setSteps(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  async function save(list) {
    setBusy(true); setError(null);
    try { onDone(await api.put('/onboarding/templates', { kind, companyId: company || null, steps: list })); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-dlg" style={{ width: 'min(760px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="ob-t-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">📋</span><div><h2 id="ob-t-t">{tr('The steps')}</h2><p>{tr('Days count from the first day (or the last): −3 is three days before.')}</p></div></div>
        <div className="x7-bar">
          <div className="x7-seg">{[['join', tr('Starting')], ['leave', tr('Leaving')]].map(([k, l]) => <button key={k} type="button" className={kind === k ? 'is-on' : ''} onClick={() => choose(k, company)}>{l}</button>)}</div>
          <select className="input" style={{ maxWidth: 260 }} value={company} onChange={(e) => choose(kind, e.target.value)}><option value="">{tr('Every company')}</option>{d.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        </div>
        <div className="ob-edit">
          {steps.map((s, i) => (
            <div key={i} className="ob-edit-row">
              <input className="input" value={s.title} onChange={(e) => set(i, { title: e.target.value })} aria-label={tr('Step')} />
              <select className="input" value={s.owner} onChange={(e) => set(i, { owner: e.target.value })} aria-label={tr('Whose')}>{Object.keys(OWNER).map((o) => <option key={o} value={o}>{OWNER[o][0]} {tr(OWNER[o][1])}</option>)}</select>
              <input className="input" type="number" value={s.days} onChange={(e) => set(i, { days: e.target.value })} aria-label={tr('Day')} />
              <button type="button" className="btn btn-secondary" onClick={() => setSteps(steps.filter((_, j) => j !== i))} aria-label={tr('Remove')}>✕</button>
            </div>
          ))}
        </div>
        <button type="button" className="x7-link" style={{ alignSelf: 'flex-start' }} onClick={() => setSteps([...steps, { title: '', owner: 'hr', days: 0, kind: 'task' }])}>➕ {tr('Another step')}</button>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => save([])} disabled={busy}>↺ {tr('Back to the usual steps')}</button><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="button" className="btn btn-primary" disabled={busy} onClick={() => save(steps)}>{tr('Save')}</button></div>
      </div>
    </div>
  );
}

function ListCard({ l, onOpen }) {
  return (
    <button type="button" className={'x7-acc ob-card' + (l.status !== 'open' ? ' is-done' : '')} onClick={() => onOpen(l.id)}>
      <span className="bk-acc-top">
        <span className="x7-avatar" style={{ '--h': hue(l.employee.name) }} aria-hidden="true">{l.employee.name.charAt(0)}</span>
        <span className="x7-who"><b>{l.employee.name}</b><small>{[l.employee.position, l.employee.company].filter(Boolean).join(' · ')}</small></span>
        <Ring done={l.done} total={l.total} />
      </span>
      <span className="ob-card-foot">
        <span className={'x7-pill ' + (l.kind === 'join' ? 'is-teal' : 'is-warn')}>{l.kind === 'join' ? '🧳' : '👋'} {dayWords(l)}</span>
        {l.status === 'done' ? <span className="x7-pill is-good">🎉 {tr('All done')}</span> : l.late > 0 ? <span className="x7-pill is-bad">⏰ {tr('{n} late', { n: l.late })}</span> : l.nextDue && <span className="x7-muted">{tr('next by {date}', { date: dayText(l.nextDue) })}</span>}
      </span>
    </button>
  );
}

export default function OnboardingPage() {
  const [params, setParams] = useSearchParams();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [dlg, setDlg] = useState(null);
  const load = useCallback(() => api.get('/onboarding').then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const listId = params.get('list');
  const open = (id) => setParams(id ? { list: id } : {});
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const s = d.summary;
  const joins = d.lists.filter((l) => l.kind === 'join'), leaves = d.lists.filter((l) => l.kind === 'leave');
  return (
    <div className="x7">
      <header className="x7-head">
        <div>
          <h1>🧳 {tr('Joiners and leavers')}</h1>
          <p>{tr('A checklist for someone\'s first days or their last: each step for HR, IT, finance, their manager or them, with its day. A leaver hands back what they hold.')}</p>
        </div>
        <div className="x7-head-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setDlg({ k: 'steps' })}>📋 {tr('The steps')}</button>
          <button type="button" className="btn btn-secondary" onClick={() => setDlg({ k: 'start', kind: 'leave' })}>👋 {tr('Someone is leaving')}</button>
          <button type="button" className="btn btn-primary" onClick={() => setDlg({ k: 'start', kind: 'join' })}>🧳 {tr('Someone is starting')}</button>
        </div>
      </header>
      <div className="x7-tiles">
        <div className="x7-tile is-teal"><small>🧳 {tr('Starting')}</small><b>{s.joining}</b><span>{tr('first-day checklists open')}</span></div>
        <div className="x7-tile is-warn"><small>👋 {tr('Leaving')}</small><b>{s.leaving}</b><span>{tr('leaving checklists open')}</span></div>
        <div className="x7-tile is-calm"><small>📅 {tr('This week')}</small><b>{s.thisWeek}</b><span>{tr('first or last days in the next 7 days')}</span></div>
        <div className={'x7-tile ' + (s.late ? 'is-bad' : 'is-good')}><small>⏰ {tr('Steps late')}</small><b>{s.late}</b><span>{s.late ? tr('chased each morning') : tr('nothing late')}</span></div>
      </div>
      {d.noList.length > 0 && (
        <section className="x7-card">
          <h2>✨ {tr('Hired lately, no first-day checklist')}</h2>
          <div className="x7-list">{d.noList.map((p) => (
            <div key={p.id} className="x7-row" style={{ cursor: 'default' }}>
              <span className="x7-avatar" style={{ '--h': hue(p.name) }} aria-hidden="true">{p.name.charAt(0)}</span>
              <span className="x7-who"><b>{p.name}</b><small>{[p.position, p.company, tr('hired {date}', { date: dayText(p.hireDate) })].filter(Boolean).join(' · ')}</small></span>
              <span />
              <button type="button" className="btn btn-primary" onClick={() => setDlg({ k: 'start', kind: 'join', person: p.id })}>{tr('Start')}</button>
            </div>
          ))}</div>
        </section>
      )}
      <div className="ob-lanes">
        <section>
          <h2 className="x7-h2">🧳 {tr('Starting')} <small>{joins.filter((l) => l.status === 'open').length}</small></h2>
          {joins.length ? <div className="ob-cards">{joins.map((l) => <ListCard key={l.id} l={l} onOpen={open} />)}</div> : <div className="x7-empty"><span aria-hidden="true">🧳</span><p>{tr('No one starting just now.')}</p></div>}
        </section>
        <section>
          <h2 className="x7-h2">👋 {tr('Leaving')} <small>{leaves.filter((l) => l.status === 'open').length}</small></h2>
          {leaves.length ? <div className="ob-cards">{leaves.map((l) => <ListCard key={l.id} l={l} onOpen={open} />)}</div> : <div className="x7-empty"><span aria-hidden="true">👋</span><p>{tr('No one leaving just now.')}</p></div>}
        </section>
      </div>
      {dlg && dlg.k === 'start' && <StartDialog d={d} kind={dlg.kind} person={dlg.person} onClose={() => setDlg(null)} onDone={(x) => { setDlg(null); load(); open(x.id); }} />}
      {dlg && dlg.k === 'steps' && <StepsDialog d={d} onClose={() => setDlg(null)} onDone={(x) => { setD(x); setDlg(null); }} />}
      {listId && <ListSheet key={listId} id={listId} onClose={() => open(null)} onChanged={load} />}
    </div>
  );
}

// My space: the steps waiting on me; my own first days.
export function MyStepsCard() {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get('/onboarding/mine').then(setD).catch(() => setD(null)), []);
  useEffect(() => { load(); }, [load]);
  if (!d || (!d.steps.length && !d.own)) return null;
  async function tick(id, done) {
    setBusy(true);
    try { await api.post('/onboarding/steps/' + id, { done }); await load(); } catch { /* shown on the next load */ } finally { setBusy(false); }
  }
  return (
    <div className="msx-card x7-mine">
      <h4 className="msp-h4">🧳 {d.own ? tr('My first days') : tr('Joiners and leavers')}</h4>
      {d.own && (
        <>
          <div className="x7-mine-top" style={{ '--tone': 'var(--x7-teal)' }}>
            <span><small>{tr('Welcome! Your first day: {date}', { date: dayText(d.own.day, { weekday: 'long' }) })}</small><b>{tr('{d} of {n} done', { d: d.own.done, n: d.own.total })}</b></span>
            <Ring done={d.own.done} total={d.own.total} />
          </div>
          <ul className="x7-mine-list">{d.own.steps.map((s) => (
            <li key={s.id}><button type="button" className="ob-tick" disabled={busy} aria-pressed={s.done} onClick={() => tick(s.id, !s.done)}>{s.done ? '✓' : ''}</button><span><b>{s.title}</b><small>{tr('by {date}', { date: dayText(s.dueOn) })}</small></span></li>
          ))}</ul>
        </>
      )}
      {d.steps.length > 0 && (
        <>
          {d.own && <h4 className="msp-h4" style={{ marginTop: 6 }}>{tr('For others')}</h4>}
          <ul className="x7-mine-list">{d.steps.map((s) => (
            <li key={s.id}>
              <button type="button" className="ob-tick" disabled={busy} onClick={() => tick(s.id, true)} aria-label={tr('Done')} />
              <span><b>{s.title}</b><small>{s.listKind === 'join' ? '🧳 ' : '👋 '}{s.person} · {s.late ? '⏰ ' : ''}{tr('by {date}', { date: dayText(s.dueOn) })}</small></span>
            </li>
          ))}</ul>
        </>
      )}
    </div>
  );
}
