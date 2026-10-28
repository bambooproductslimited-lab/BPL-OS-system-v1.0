import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './seventeenth.css';
import './eighteenth.css';
import './nineteenth.css';

// Discipline and grievances (People → Discipline and grievances; backend
// discipline.service.js, migration 0200): a case about someone — the query
// letter with a day to reply by, their reply from My space, the hearing and
// its panel, the outcome (a warning runs 3, 6 or 12 months), the appeal.
// Grievances raised by staff from My space. Confidential: HR's notes stay
// with HR; the person sees the letters, the hearing and the outcome.

function dayText(d, opts) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC', ...opts }) : '—'; }
function when(t) { return t ? new Date(t).toLocaleString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; }
function monthText(m) { return new Date(m + '-15T12:00:00Z').toLocaleDateString(activeIntlLocale(), { month: 'short', timeZone: 'UTC' }); }
function today() { return new Date().toISOString().slice(0, 10); }
function inDays(n) { return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10); }
function hue(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function localSoon() { const d = new Date(Date.now() + 2 * 86400000); d.setHours(10, 0, 0, 0); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }

const CATEGORY = {
  lateness: ['⏰', msg('Lateness')], absence: ['🚪', msg('Absence')], misconduct: ['⚠️', msg('Misconduct')], performance: ['📉', msg('Performance')], safety_breach: ['⛑️', msg('Safety breach')],
  theft: ['🔒', msg('Theft or fraud')], harassment: ['🛑', msg('Harassment')], insubordination: ['🙅', msg('Insubordination')], policy_breach: ['📜', msg('Policy breach')], other: ['📝', msg('Other')],
  pay: ['💵', msg('Pay')], workload: ['🏋️', msg('Workload')], treatment: ['🤝', msg('How I am treated')], conditions: ['🏭', msg('Working conditions')], safety: ['⛑️', msg('Safety')], discrimination: ['⚖️', msg('Discrimination')]
};
const OUTCOME = {
  no_action: ['is-good', msg('No action')], counselling: ['is-calm', msg('Counselling')], verbal_warning: ['is-warn', msg('Verbal warning')], written_warning: ['is-warn', msg('Written warning')],
  final_warning: ['is-bad', msg('Final written warning')], suspension: ['is-bad', msg('Suspension')], dismissal: ['is-bad', msg('Dismissal')],
  upheld: ['is-good', msg('Upheld')], partly_upheld: ['is-warn', msg('Partly upheld')], not_upheld: ['is-calm', msg('Not upheld')]
};
const WARNING_MONTHS = { verbal_warning: 3, written_warning: 6, final_warning: 12, suspension: 12 };
const STATUS = {
  open: ['📂', 'is-calm', msg('Open')], awaiting_reply: ['📩', 'is-warn', msg('Waiting for a reply')], hearing: ['📅', 'is-violet', msg('Hearing set')], decided: ['📬', 'is-teal', msg('Decided')],
  appealed: ['⚖️', 'is-bad', msg('Appealed')], closed: ['✅', 'is-good', msg('Closed')], withdrawn: ['↩️', 'is-calm', msg('Withdrawn')]
};
const EVENT = {
  opened: ['📂', msg('Opened')], note: ['🗒️', msg('Note (HR only)')], query: ['📩', msg('Query sent')], reply: ['✉️', msg('Reply')], hearing: ['📅', msg('Hearing set')], outcome: ['📬', msg('Outcome')],
  appeal: ['⚖️', msg('Appeal')], appeal_result: ['🏛️', msg('Appeal decided')], closed: ['✅', msg('Closed')], withdrawn: ['↩️', msg('Withdrawn')], reopened: ['🔁', msg('Reopened')]
};
// The steps a case goes through, for the little track on each row.
const TRACK = [['opened', msg('Opened')], ['query', msg('Query')], ['reply', msg('Reply')], ['hearing', msg('Hearing')], ['outcome', msg('Outcome')]];
function trackOf(c) {
  return { opened: true, query: !!c.query, reply: !!c.reply, hearing: !!c.hearing, outcome: !!c.outcome };
}
const APPEAL = { stands: msg('The decision stands'), reduced: msg('Reduced'), overturned: msg('Overturned') };

function Track({ c }) {
  const t = trackOf(c);
  if (c.kind === 'grievance') return null;
  return <span className="dc-track" aria-label={tr('Steps')}>{TRACK.map(([k, l]) => <i key={k} className={t[k] ? 'is-on' : ''} title={tr(l)} />)}</span>;
}

// The letter, laid out to print: the query or the outcome.
function Letter({ c, kind, onClose }) {
  const outcome = kind === 'outcome';
  const body = outcome ? (c.outcome ? c.outcome.note : '') : (c.query ? c.query.text : '');
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet vz-print dc-letter print-solo" role="dialog" aria-modal="true" aria-labelledby="dc-l-t" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        <header><b>{c.person.company || 'Bamboo Products'}</b><span>{dayText(outcome && c.outcome ? c.outcome.at : c.query ? c.query.sentAt : today(), { weekday: undefined })}</span></header>
        <p className="dc-letter-to">{tr('To')}: <b>{c.person.name}</b>{c.person.position ? ', ' + c.person.position : ''}{c.person.department ? ' — ' + c.person.department : ''}</p>
        <h2 id="dc-l-t">{c.ref} · {outcome ? tr('Outcome of the disciplinary process') : tr('Query: request for a written explanation')}</h2>
        <p className="dc-letter-sub">{tr('Re: {title}', { title: c.title })}</p>
        <div className="dc-letter-body">{body}</div>
        {!outcome && c.query && <p><b>{tr('Please reply in writing by {date}, in My space or on paper to HR.', { date: dayText(c.query.replyDue) })}</b></p>}
        {outcome && c.outcome && (
          <p><b>{tr(OUTCOME[c.outcome.outcome][1])}</b>{c.outcome.warningUntil ? ' — ' + tr('on your record until {date}', { date: dayText(c.outcome.warningUntil) }) : ''}{c.outcome.suspensionDays ? ' — ' + (c.outcome.suspensionDays === 1 ? tr('1 day of suspension') : tr('{n} days of suspension', { n: c.outcome.suspensionDays })) : ''}. {c.kind === 'discipline' && c.outcome.outcome !== 'no_action' ? tr('You may appeal in writing within 10 days.') : ''}</p>
        )}
        <div className="dc-letter-sign"><span>{c.handler ? c.handler.name : tr('Human resources')}</span><small>{tr('Human resources')}</small></div>
        <div className="x7-actions"><button type="button" className="btn btn-primary is-end" onClick={() => window.print()}>🖨️ {tr('Print')}</button></div>
      </div>
    </div>
  );
}

function CaseSheet({ id, d, onClose, onChanged }) {
  const [c, setC] = useState(null);
  const [mode, setMode] = useState('');
  const [f, setF] = useState({});
  const [letter, setLetter] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { api.get('/discipline/' + id).then(setC).catch((e) => setError(e.message)); }, [id]);
  async function run(path, body, after) {
    setBusy(true); setError(null);
    try { const x = await api.post('/discipline/' + c.id + path, body || {}); if (x && x.id) setC(x); setMode(''); onChanged(); if (after) after(x); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  function start(m) {
    setError(null);
    if (m === 'query') setF({ text: tr('Regarding "{title}" ({date}): you are requested to explain in writing why disciplinary action should not be taken against you.', { title: c.title, date: c.occurredOn ? dayText(c.occurredOn) : dayText(c.createdAt) }), replyDue: inDays(3) });
    if (m === 'hearing') setF({ at: localSoon(), place: '', panelIds: [] });
    if (m === 'decide') setF({ outcome: c.suggested || (c.kind === 'grievance' ? 'upheld' : 'verbal_warning'), note: '', suspensionDays: '', startLeaving: false });
    if (m === 'appeal') setF({ result: 'stands', outcome: '', note: '' });
    if (m === 'note' || m === 'reply') setF({ text: '' });
    setMode(m);
  }
  if (!c) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const open = c.status !== 'closed' && c.status !== 'withdrawn';
  const grievance = c.kind === 'grievance';
  const cat = CATEGORY[c.category] || CATEGORY.other;
  const outcomes = grievance ? ['upheld', 'partly_upheld', 'not_upheld'] : ['no_action', 'counselling', 'verbal_warning', 'written_warning', 'final_warning', 'suspension', 'dismissal'];
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet is-wide" role="dialog" aria-modal="true" aria-labelledby="dc-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={grievance ? { '--g1': '#0f766e', '--g2': '#1d4ed8' } : c.outcome && OUTCOME[c.outcome.outcome][0] === 'is-bad' ? { '--g1': '#7f1d1d', '--g2': '#6d28d9' } : { '--g1': '#4c1d95', '--g2': '#be185d' }}>
          <span className="x7-icon" aria-hidden="true">{cat[0]}</span>
          <div><small>{c.ref} · {grievance ? tr('Grievance') : tr('Disciplinary case')} · {tr(cat[1])}</small><h2 id="dc-t">{c.title}</h2>
            <p><span className="x7-pill">{STATUS[c.status][0]} {tr(STATUS[c.status][2])}</span>{c.outcome && <span className="x7-pill">{tr(OUTCOME[c.outcome.outcome][1])}{c.outcome.warningUntil ? ' · ' + tr('until {date}', { date: dayText(c.outcome.warningUntil) }) : ''}</span>}{c.query && c.query.late && <span className="x7-pill">⏰ {tr('Reply late')}</span>}</p></div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        <dl className="x7-facts">
          <div><dt>{grievance ? tr('Raised by') : tr('About')}</dt><dd>{c.person.name}{c.person.position ? ' · ' + c.person.position : ''}</dd></div>
          {grievance && <div><dt>{tr('About')}</dt><dd>{c.against ? c.against.name : '—'}</dd></div>}
          <div><dt>{tr('Department')}</dt><dd>{c.person.department || '—'}</dd></div>
          <div><dt>{tr('Handled by')}</dt><dd>{c.handler ? c.handler.name : '—'}</dd></div>
          {c.occurredOn && <div><dt>{tr('When')}</dt><dd>{dayText(c.occurredOn)}</dd></div>}
        </dl>
        {c.details && <p className="x7-note">📝 {c.details}</p>}
        {c.history && c.history.length > 0 && (
          <div className="x7-sec dc-history">
            <h3>🗂️ {tr('Their record')}</h3>
            <ul className="x7-mine-list">{c.history.map((h) => (
              <li key={h.id}><span aria-hidden="true">{(CATEGORY[h.category] || CATEGORY.other)[0]}</span><span><b>{h.ref} · {h.title}</b><small>{h.outcome ? tr(OUTCOME[h.outcome][1]) : tr(STATUS[h.status][2])}{h.warningUntil ? ' · ' + (h.active ? tr('running until {date}', { date: dayText(h.warningUntil) }) : tr('ended {date}', { date: dayText(h.warningUntil) })) : ''}</small></span>{h.active && <span className="x7-pill is-warn" style={{ flex: 'none' }}>{tr('Active')}</span>}</li>
            ))}</ul>
            {c.suggested && open && !c.outcome && <p className="x7-note">🪜 {tr('With a warning still running, the next step would be: {step}.', { step: tr(OUTCOME[c.suggested][1]).toLowerCase() })}</p>}
          </div>
        )}
        <div className="x7-sec">
          <h3>🧾 {tr('What happened, in order')}</h3>
          <ol className="dc-timeline">{c.events.map((ev) => (
            <li key={ev.id} className={'is-' + ev.kind + (ev.shared ? '' : ' is-private')}>
              <i aria-hidden="true">{EVENT[ev.kind][0]}</i>
              <div><b>{tr(EVENT[ev.kind][1])}</b><small>{when(ev.at)}{ev.by ? ' · ' + ev.by : ''}{!ev.shared && ev.kind !== 'opened' ? ' · 🔒 ' + tr('HR only') : ''}</small>{ev.body && ev.kind !== 'opened' && <p>{ev.body}</p>}</div>
            </li>
          ))}</ol>
        </div>
        {c.query && <div className="x7-actions"><button type="button" className="btn btn-secondary" onClick={() => setLetter('query')}>🖨️ {tr('The query letter')}</button>{c.outcome && <button type="button" className="btn btn-secondary" onClick={() => setLetter('outcome')}>🖨️ {tr('The outcome letter')}</button>}</div>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {mode === 'query' && (
          <form className="x7-form" onSubmit={(e) => { e.preventDefault(); run('/query', f); }}>
            <h3>📩 {tr('Send a query')}</h3>
            <label><span>{tr('The letter')}</span><textarea className="input" rows={5} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} /></label>
            <label><span>{tr('Reply by')}</span><input className="input" type="date" required min={today()} value={f.replyDue} onChange={(e) => setF({ ...f, replyDue: e.target.value })} /></label>
            <p className="x7-note">📲 {tr('It reaches them in My space; their reply comes back here.')}</p>
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setMode('')}>{tr('Back')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Send the query')}</button></div>
          </form>
        )}
        {mode === 'reply' && (
          <form className="x7-form" onSubmit={(e) => { e.preventDefault(); run('/reply', f); }}>
            <h3>✉️ {tr('Their reply, handed in on paper')}</h3>
            <textarea className="input" rows={4} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} aria-label={tr('Reply')} />
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setMode('')}>{tr('Back')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save')}</button></div>
          </form>
        )}
        {mode === 'hearing' && (
          <form className="x7-form" onSubmit={(e) => { e.preventDefault(); run('/hearing', { ...f, at: new Date(f.at).toISOString() }); }}>
            <h3>📅 {tr('Set a hearing')}</h3>
            <div className="x7-grid2">
              <label><span>{tr('When')}</span><input className="input" type="datetime-local" required value={f.at} onChange={(e) => setF({ ...f, at: e.target.value })} /></label>
              <label><span>{tr('Where')}</span><input className="input" value={f.place} onChange={(e) => setF({ ...f, place: e.target.value })} placeholder={tr('e.g. The meeting room')} /></label>
            </div>
            <label><span>{tr('The panel (up to 5)')}</span><select className="input" value="" onChange={(e) => { if (e.target.value && !f.panelIds.includes(e.target.value)) setF({ ...f, panelIds: [...f.panelIds, e.target.value].slice(0, 5) }); }}><option value="">{tr('Add someone…')}</option>{d.people.filter((p) => p.id !== c.person.id).map((p) => <option key={p.id} value={p.id}>{p.name}{p.position ? ' · ' + p.position : ''}</option>)}</select></label>
            {f.panelIds.length > 0 && <div className="x7-chips">{f.panelIds.map((pid) => <button key={pid} type="button" className="is-on" onClick={() => setF({ ...f, panelIds: f.panelIds.filter((x) => x !== pid) })}>{(d.people.find((p) => p.id === pid) || {}).name} ✕</button>)}</div>}
            <p className="x7-note">🤝 {tr('They are told, and may bring a colleague with them. Everyone is reminded the day before.')}</p>
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setMode('')}>{tr('Back')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Set the hearing')}</button></div>
          </form>
        )}
        {mode === 'decide' && (
          <form className="x7-form" onSubmit={(e) => { e.preventDefault(); run('/decide', f); }}>
            <h3>📬 {tr('The outcome')}</h3>
            <div className="x7-chips">{outcomes.map((k) => <button key={k} type="button" className={(f.outcome === k ? 'is-on' : '') + (c.suggested === k ? ' dc-suggested' : '')} onClick={() => setF({ ...f, outcome: k })}>{tr(OUTCOME[k][1])}{WARNING_MONTHS[k] ? ' · ' + tr('{n} months', { n: WARNING_MONTHS[k] }) : ''}</button>)}</div>
            {f.outcome === 'suspension' && <label><span>{tr('Days of suspension')}</span><input className="input" type="number" min="1" max="30" value={f.suspensionDays} onChange={(e) => setF({ ...f, suspensionDays: e.target.value })} /></label>}
            <label><span>{tr('Why — it goes in the outcome letter')}</span><textarea className="input" rows={4} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
            {f.outcome === 'dismissal' && <label className="x7-check"><input type="checkbox" checked={f.startLeaving} onChange={(e) => setF({ ...f, startLeaving: e.target.checked })} /><span>{tr('Start their leaving checklist')}<small>{tr('Hand-backs, final pay, the exit steps — in Joiners and leavers.')}</small></span></label>}
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setMode('')}>{tr('Back')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Decide')}</button></div>
          </form>
        )}
        {mode === 'appeal' && (
          <form className="x7-form" onSubmit={(e) => { e.preventDefault(); run('/appeal-result', f); }}>
            <h3>🏛️ {tr('The appeal')}</h3>
            {c.appeal && <p className="x7-note">⚖️ {c.appeal.text}</p>}
            <div className="x7-seg" style={{ alignSelf: 'flex-start' }}>{Object.entries(APPEAL).map(([k, l]) => <button key={k} type="button" className={f.result === k ? 'is-on' : ''} onClick={() => setF({ ...f, result: k })}>{tr(l)}</button>)}</div>
            {f.result === 'reduced' && <label><span>{tr('Reduced to')}</span><select className="input" value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })}><option value="">—</option>{['counselling', 'verbal_warning', 'written_warning'].map((k) => <option key={k} value={k}>{tr(OUTCOME[k][1])}</option>)}</select></label>}
            <label><span>{tr('Why')}</span><textarea className="input" rows={3} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setMode('')}>{tr('Back')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Decide the appeal')}</button></div>
          </form>
        )}
        {mode === 'note' && (
          <form className="x7-form" onSubmit={(e) => { e.preventDefault(); run('/note', { body: f.text }); }}>
            <h3>🗒️ {tr('A note for the file')} <span className="x7-muted">🔒 {tr('HR only')}</span></h3>
            <textarea className="input" rows={3} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} aria-label={tr('Note')} />
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setMode('')}>{tr('Back')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Add the note')}</button></div>
          </form>
        )}
        {!mode && c.canManage && (
          <div className="x7-actions dc-next">
            {open && !grievance && !c.outcome && c.status !== 'awaiting_reply' && <button type="button" className={'btn ' + (!c.query ? 'btn-primary' : 'btn-secondary')} onClick={() => start('query')}>📩 {c.query ? tr('Send another query') : tr('Send a query')}</button>}
            {open && c.status === 'awaiting_reply' && <button type="button" className="btn btn-secondary" onClick={() => start('reply')}>✉️ {tr('Record a paper reply')}</button>}
            {open && !c.outcome && <button type="button" className={'btn ' + (c.reply && !c.hearing ? 'btn-primary' : 'btn-secondary')} onClick={() => start('hearing')}>📅 {c.hearing ? tr('Move the hearing') : tr('Set a hearing')}</button>}
            {open && !c.outcome && <button type="button" className={'btn ' + (c.hearing || grievance ? 'btn-primary' : 'btn-secondary')} onClick={() => start('decide')}>📬 {tr('Decide')}</button>}
            {c.status === 'appealed' && <button type="button" className="btn btn-primary" onClick={() => start('appeal')}>🏛️ {tr('Decide the appeal')}</button>}
            <button type="button" className="btn btn-secondary" onClick={() => start('note')}>🗒️ {tr('Note')}</button>
            {open && c.outcome && c.status !== 'appealed' && <button type="button" className="btn btn-secondary is-end" disabled={busy} onClick={() => run('/close')}>✅ {tr('Close')}</button>}
            {open && !c.outcome && <button type="button" className="btn btn-secondary is-end" disabled={busy} onClick={() => { if (window.confirm(tr('Withdraw this case? Nothing further happens on it.'))) run('/withdraw'); }}>↩️ {tr('Withdraw')}</button>}
            {!open && <button type="button" className="btn btn-secondary is-end" disabled={busy} onClick={() => run('/reopen')}>🔁 {tr('Reopen')}</button>}
          </div>
        )}
        {letter && <Letter c={c} kind={letter} onClose={() => setLetter(null)} />}
      </div>
    </div>
  );
}

function OpenDialog({ d, onClose, onDone }) {
  const [f, setF] = useState({ employeeId: '', category: 'lateness', title: '', details: '', occurredOn: today(), handlerId: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.post('/discipline', { ...f, handlerId: f.handlerId || null })); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" style={{ width: 'min(680px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="dc-o-t" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">🗂️</span><div><h2 id="dc-o-t">{tr('Open a disciplinary case')}</h2><p>{tr('Confidential: only those who handle cases see it. The person sees nothing until a query reaches them.')}</p></div></div>
        <label><span>{tr('About')}</span><select className="input" required value={f.employeeId} onChange={(e) => setF({ ...f, employeeId: e.target.value })}><option value="">—</option>{d.people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.department ? ' · ' + p.department : ''}</option>)}</select></label>
        <div className="x7-chips">{d.lists.discipline.map((k) => <button key={k} type="button" className={f.category === k ? 'is-on' : ''} onClick={() => setF({ ...f, category: k })}><em aria-hidden="true">{CATEGORY[k][0]}</em>{tr(CATEGORY[k][1])}</button>)}</div>
        <label><span>{tr('In a few words')}</span><input className="input" required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder={tr('e.g. Late four times this month')} /></label>
        <label><span>{tr('What happened')}</span><textarea className="input" rows={3} value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} /></label>
        <div className="x7-grid2">
          <label><span>{tr('When')}</span><input className="input" type="date" max={today()} value={f.occurredOn} onChange={(e) => setF({ ...f, occurredOn: e.target.value })} /></label>
          <label><span>{tr('Handled by')}</span><select className="input" value={f.handlerId} onChange={(e) => setF({ ...f, handlerId: e.target.value })}><option value="">{tr('Me')}</option>{d.people.filter((p) => p.id !== f.employeeId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Open the case')}</button></div>
      </form>
    </div>
  );
}

function MonthsBars({ months }) {
  const max = Math.max(1, ...months.map((m) => m.discipline + m.grievance));
  return (
    <div className="dc-months" role="img" aria-label={tr('Cases opened each month')}>
      {months.map((m) => (
        <span key={m.month} title={monthText(m.month) + ': ' + m.discipline + ' · ' + m.grievance}>
          <i className="dc-bar">{m.grievance > 0 && <em className="is-g" style={{ height: m.grievance / max * 100 + '%' }} />}{m.discipline > 0 && <em style={{ height: m.discipline / max * 100 + '%' }} />}</i>
          <small>{monthText(m.month)}</small>
        </span>
      ))}
    </div>
  );
}

export default function DisciplinePage() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState('open');
  const [kind, setKind] = useState('');
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [opening, setOpening] = useState(false);
  const load = useCallback(() => api.get('/discipline?status=' + status + (kind ? '&kind=' + kind : '')).then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), [status, kind]);
  useEffect(() => { load(); }, [load]);
  const caseId = params.get('case');
  const open = (id) => setParams(id ? { case: id } : {});
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const s = d.summary;
  return (
    <div className="x7">
      <header className="x7-head">
        <div>
          <h1>⚖️ {tr('Discipline and grievances')}</h1>
          <p>{tr('Fair and on paper: the query, their reply, a hearing, the outcome and the right to appeal. Grievances raised from My space. Only those who handle cases see them.')}</p>
        </div>
        <div className="x7-head-actions"><button type="button" className="btn btn-primary" onClick={() => setOpening(true)}>🗂️ {tr('Open a case')}</button></div>
      </header>
      <div className="x7-tiles">
        <div className="x7-tile is-violet"><small>🗂️ {tr('Cases open')}</small><b>{s.open}</b><span>{s.appeals ? tr('{n} appealed', { n: s.appeals }) : tr('none appealed')}</span></div>
        <div className="x7-tile is-teal"><small>📮 {tr('Grievances open')}</small><b>{s.grievances}</b><span>{tr('raised by staff')}</span></div>
        <div className={'x7-tile ' + (s.lateReplies ? 'is-bad' : 'is-warn')}><small>📩 {tr('Waiting for a reply')}</small><b>{s.awaitingReply}</b><span>{s.lateReplies ? tr('{n} past their day', { n: s.lateReplies }) : tr('none late')}</span></div>
        <div className="x7-tile is-calm"><small>📅 {tr('Hearings')}</small><b>{s.hearingsWeek}</b><span>{tr('in the next 7 days')}</span></div>
        <div className="x7-tile is-warn"><small>🟨 {tr('Warnings running')}</small><b>{s.warnings}</b><span>{tr('on someone\'s record now')}</span></div>
      </div>
      <div className="x7-grid2 dc-top">
        <section className="x7-card">
          <h2>📅 {tr('Hearings coming')}</h2>
          {!d.hearings.length ? <p className="x7-muted">{tr('No hearing set.')}</p> : <div className="x7-list">{d.hearings.map((h) => (
            <button key={h.caseId} type="button" className="x7-row" onClick={() => open(h.caseId)}>
              <span className="dc-date" aria-hidden="true"><b>{new Date(h.at).getDate()}</b><small>{new Date(h.at).toLocaleDateString(activeIntlLocale(), { month: 'short' })}</small></span>
              <span className="x7-who"><b>{h.person}</b><small>{h.ref} · {h.title}</small></span>
              <span className="x7-pill is-violet">{new Date(h.at).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' })}{h.place ? ' · ' + h.place : ''}</span><span />
            </button>
          ))}</div>}
          <h2 style={{ marginTop: 14 }}>📊 {tr('Opened each month')}</h2>
          <MonthsBars months={d.months} />
          <div className="bg-legend"><span><i className="bg-key" style={{ background: 'var(--x7-violet)' }} />{tr('Disciplinary')}</span><span><i className="bg-key" style={{ background: 'var(--x7-teal)' }} />{tr('Grievances')}</span></div>
        </section>
        <section className="x7-card">
          <h2>🟨 {tr('Warnings running')}</h2>
          {!d.warnings.length ? <p className="x7-muted">{tr('No warning is running.')}</p> : <div className="x7-list">{d.warnings.map((w) => {
            const total = (WARNING_MONTHS[w.outcome] || 6) * 30.4, left = Math.max(0, (Date.parse(w.until + 'T12:00:00Z') - Date.now()) / 86400000);
            return (
              <button key={w.caseId} type="button" className="x7-row dc-warn" onClick={() => open(w.caseId)}>
                <span className="x7-avatar" style={{ '--h': hue(w.person.name) }} aria-hidden="true">{w.person.name.charAt(0)}</span>
                <span className="x7-who"><b>{w.person.name}</b><small>{tr(OUTCOME[w.outcome][1])} · {tr((CATEGORY[w.category] || CATEGORY.other)[1])} · {w.ref}</small><i className="dc-left" style={{ '--p': Math.round(left / total * 100) }} /></span>
                <span className={'x7-pill ' + OUTCOME[w.outcome][0]}>{tr('until {date}', { date: dayText(w.until, { year: undefined }) })}</span><span />
              </button>
            );
          })}</div>}
        </section>
      </div>
      <div className="x7-bar">
        <h2 className="x7-h2" style={{ margin: 0 }}>🗂️ {tr('Cases')}</h2>
        <div className="x7-chips">{[['', tr('All')], ['discipline', tr('Disciplinary')], ['grievance', tr('Grievances')]].map(([k, l]) => <button key={k} type="button" className={kind === k ? 'is-on' : ''} onClick={() => setKind(k)}>{l}</button>)}</div>
        <div className="x7-seg" role="tablist">{[['open', tr('Open')], ['closed', tr('Closed')], ['all', tr('All')]].map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={status === k} className={status === k ? 'is-on' : ''} onClick={() => setStatus(k)}>{l}</button>)}</div>
      </div>
      {!d.cases.length ? <div className="x7-empty"><span aria-hidden="true">🕊️</span><p>{tr('Nothing here. Long may it last.')}</p></div> : (
        <div className="x7-list">{d.cases.map((c) => {
          const cat = CATEGORY[c.category] || CATEGORY.other;
          return (
            <button key={c.id} type="button" className={'x7-row' + (c.query && c.query.late ? ' is-flag is-bad' : c.status === 'appealed' ? ' is-flag is-warn' : c.kind === 'grievance' && c.status === 'open' ? ' is-flag is-calm' : '')} onClick={() => open(c.id)}>
              <span className="x7-icon" aria-hidden="true">{cat[0]}</span>
              <span className="x7-who"><b>{c.title}</b><small>{c.ref} · {c.person.name}{c.against ? ' → ' + c.against.name : ''} · {tr(cat[1])} · {dayText(c.createdAt, { year: undefined })}</small></span>
              <Track c={c} />
              <span className={'x7-pill ' + (c.outcome ? OUTCOME[c.outcome.outcome][0] : STATUS[c.status][1])}>{c.outcome ? tr(OUTCOME[c.outcome.outcome][1]) : STATUS[c.status][0] + ' ' + tr(STATUS[c.status][2])}</span>
            </button>
          );
        })}</div>
      )}
      {opening && <OpenDialog d={d} onClose={() => setOpening(false)} onDone={(x) => { setOpening(false); load(); open(x.id); }} />}
      {caseId && <CaseSheet key={caseId} id={caseId} d={d} onClose={() => open(null)} onChanged={load} />}
    </div>
  );
}

// My space: letters waiting for a reply, hearings, outcomes and warnings that
// are mine; the grievances I raised; raising one.
export function MyHrCard() {
  const [d, setD] = useState(null);
  const [raising, setRaising] = useState(false);
  const [f, setF] = useState({ category: 'treatment', title: '', details: '', againstId: '' });
  const [texts, setTexts] = useState({});
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => api.get('/discipline/mine').then(setD).catch(() => setD(null)), []);
  useEffect(() => { load(); }, [load]);
  if (!d) return null;
  async function send(path, body, done) {
    setBusy(true); setError(null);
    try { await api.post(path, body); setFlash(done); await load(); return true; } catch (e) { setError(e.message); return false; } finally { setBusy(false); }
  }
  return (
    <div className="msx-card x7-mine dc-mine">
      <h4 className="msp-h4">⚖️ {tr('HR matters')}</h4>
      {d.cases.map((c) => (
        <div key={c.id} className={'dc-mine-case' + (c.canReply ? ' is-due' : '')}>
          <div className="dc-mine-head"><b>{c.ref} · {c.title}</b><span className={'x7-pill ' + (c.outcome ? OUTCOME[c.outcome.outcome][0] : STATUS[c.status][1])}>{c.outcome ? tr(OUTCOME[c.outcome.outcome][1]) : STATUS[c.status][0] + ' ' + tr(STATUS[c.status][2])}</span></div>
          {c.canReply && c.query && (
            <form className="x7-form" onSubmit={async (e) => { e.preventDefault(); if (await send('/discipline/' + c.id + '/reply', { text: texts[c.id] || '' }, '✉️ ' + tr('Your reply has gone to HR.'))) setTexts({ ...texts, [c.id]: '' }); }}>
              <p className="dc-quote">{c.query.text}</p>
              <label><span>{tr('Your reply — by {date}', { date: dayText(c.query.replyDue) })}</span><textarea className="input" rows={3} value={texts[c.id] || ''} onChange={(e) => setTexts({ ...texts, [c.id]: e.target.value })} /></label>
              <div className="dialog-actions"><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Send my reply')}</button></div>
            </form>
          )}
          {c.hearing && c.status === 'hearing' && <p className="x7-note">📅 {tr('Hearing: {when}', { when: when(c.hearing.at) })}{c.hearing.place ? ' · ' + c.hearing.place : ''} — {tr('you may bring a colleague.')}</p>}
          {c.outcome && <p className="dc-quote">{c.outcome.note}{c.outcome.warningUntil ? ' — ' + tr('on your record until {date}', { date: dayText(c.outcome.warningUntil) }) : ''}</p>}
          {c.appeal && c.appeal.result && <p className="x7-note">🏛️ {tr('Your appeal')}: {tr(APPEAL[c.appeal.result])}{c.appeal.note ? ' — ' + c.appeal.note : ''}</p>}
          {c.canAppeal && (
            <form className="x7-form" onSubmit={async (e) => { e.preventDefault(); await send('/discipline/' + c.id + '/appeal', { text: texts['a' + c.id] || '' }, '⚖️ ' + tr('Your appeal has gone to HR.')); }}>
              <label><span>{tr('Appeal — by {date}', { date: dayText(c.appealBy) })}</span><textarea className="input" rows={2} value={texts['a' + c.id] || ''} onChange={(e) => setTexts({ ...texts, ['a' + c.id]: e.target.value })} placeholder={tr('Why the outcome should change')} /></label>
              <div className="dialog-actions"><button type="submit" className="btn btn-secondary" disabled={busy}>⚖️ {tr('Appeal')}</button></div>
            </form>
          )}
        </div>
      ))}
      {flash && <div className="x7-flash" role="status">{flash}</div>}
      {error && <div className="error-banner" role="alert">{error}</div>}
      {!raising ? (
        <div className="x7-mine-top" style={{ '--tone': 'var(--x7-teal)' }}>
          <span><small>{tr('Something not right at work?')}</small><b>{tr('Raise it — HR keeps it confidential')}</b></span>
          <button type="button" className="btn btn-secondary" onClick={() => { setRaising(true); setFlash(null); }}>📮 {tr('Raise a grievance')}</button>
        </div>
      ) : (
        <form className="x7-form" onSubmit={async (e) => { e.preventDefault(); if (await send('/discipline/grievance', { ...f, againstId: f.againstId || null }, '📮 ' + tr('Raised. HR will be in touch; it stays confidential.'))) { setRaising(false); setF({ category: 'treatment', title: '', details: '', againstId: '' }); } }}>
          <div className="x7-chips">{d.categories.map((k) => <button key={k} type="button" className={f.category === k ? 'is-on' : ''} onClick={() => setF({ ...f, category: k })}><em aria-hidden="true">{CATEGORY[k][0]}</em>{tr(CATEGORY[k][1])}</button>)}</div>
          <label><span>{tr('In a few words')}</span><input className="input" required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
          <label><span>{tr('What happened, and what you would like done')}</span><textarea className="input" rows={3} required value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} /></label>
          <label><span>{tr('About someone? (optional)')}</span><select className="input" value={f.againstId} onChange={(e) => setF({ ...f, againstId: e.target.value })}><option value="">—</option>{d.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setRaising(false)}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Raise it')}</button></div>
        </form>
      )}
    </div>
  );
}
