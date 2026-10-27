import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './seventeenth.css';

// Staff performance reviews (People → Performance reviews; backend
// reviews.service.js, migration 0198): HR opens a round for the companies it
// covers; each person rates themselves in My space, their manager scores the
// same points and sets goals, the person reads and signs it. HR sees every
// review of the round; a reviewer, the ones they write.

const KNOWN = {
  quality: msg('Quality of work'), reliability: msg('Reliability and time-keeping'), teamwork: msg('Teamwork'), initiative: msg('Initiative'),
  customers: msg('Care for customers and safety'), learning: msg('Learning and skills'), leadership: msg('Leading others')
};
const STATUS = { self: ['✍️', msg('Self-review to do')], manager: ['🧑‍💼', msg('With the reviewer')], done: ['📬', msg('Ready to sign')], signed: ['✅', msg('Signed')] };
const TONE = { self: 'is-warn', manager: 'is-calm', done: 'is-violet', signed: 'is-good' };
const COLORS = { self: 'var(--x7-warn)', manager: 'var(--x7-calm)', done: 'var(--x7-violet)', signed: 'var(--x7-good)' };
function qLabel(q) { return KNOWN[q.key] ? tr(KNOWN[q.key]) : q.label; }
function dayText(d) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—'; }
function hue(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function Dots({ v, color }) {
  return <span className="rv-dots" role="img" aria-label={v ? tr('{n} of 5', { n: v }) : tr('Not scored')} style={{ '--dot': color }}>{[1, 2, 3, 4, 5].map((n) => <i key={n} className={v >= n ? 'is-on' : ''} />)}<small>{v || '—'}</small></span>;
}
function Score({ value, onChange, label }) {
  return <span className="x7-score" role="radiogroup" aria-label={label}>{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" role="radio" aria-checked={value === n} className={value === n ? 'is-on' : ''} onClick={() => onChange(n)}>{n}</button>)}</span>;
}
function Stars({ v }) {
  if (v == null) return <span className="x7-muted">—</span>;
  const full = Math.round(v);
  return <span className="x7-stars" role="img" aria-label={tr('{n} of 5', { n: v })}>{'★'.repeat(full)}<i>{'★'.repeat(5 - full)}</i> <b style={{ color: 'var(--color-text)', letterSpacing: 0, marginLeft: 4 }}>{v}</b></span>;
}

// Both sides of a review, point by point.
function Answers({ r }) {
  return (
    <div className="rv-qs">
      {r.questions.map((q) => (
        <div key={q.key} className="rv-q">
          <span>{qLabel(q)}</span>
          <span title={tr('Their own score')}><Dots v={r.self.scores[q.key]} color="var(--x7-warn)" /></span>
          {r.manager ? <span title={tr('The reviewer\'s score')}><Dots v={r.manager.scores[q.key]} color="var(--x7-violet)" /></span> : <span />}
        </div>
      ))}
      <p className="x7-muted"><span style={{ color: 'var(--x7-warn)' }}>● {tr('their own score')}</span>{r.manager ? <> · <span style={{ color: 'var(--x7-violet)' }}>● {tr('the reviewer\'s')}</span></> : null}</p>
    </div>
  );
}

function ManagerForm({ r, onDone, onCancel }) {
  const [scores, setScores] = useState(() => ({ ...r.self.scores }));
  const [strengths, setStrengths] = useState('');
  const [improve, setImprove] = useState('');
  const [goals, setGoals] = useState(['', '']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.post('/reviews/' + r.id + '/manager', { scores, strengths, improve, goals: goals.filter((g) => g.trim()) })); }
    catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <form className="x7-form" onSubmit={save}>
      <h3>🧑‍💼 {tr('Your review of {name}', { name: r.employee.name })}</h3>
      <div className="rv-qs">{r.questions.map((q) => <div key={q.key} className="rv-q is-form"><span>{qLabel(q)}</span><Score value={scores[q.key]} onChange={(n) => setScores({ ...scores, [q.key]: n })} label={qLabel(q)} /></div>)}</div>
      <label><span>{tr('What went well')}</span><textarea className="input" rows={3} value={strengths} onChange={(e) => setStrengths(e.target.value)} /></label>
      <label><span>{tr('What to work on')}</span><textarea className="input" rows={2} value={improve} onChange={(e) => setImprove(e.target.value)} /></label>
      <span className="x7-muted">{tr('Goals for the next period')}</span>
      {goals.map((g, i) => (
        <div key={i} className="rv-goal-row">
          <input className="input" value={g} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? e.target.value : x)))} placeholder={tr('e.g. Lead the finishing line')} />
          <button type="button" className="btn btn-secondary" onClick={() => setGoals(goals.filter((_, j) => j !== i))} aria-label={tr('Remove')}>✕</button>
        </div>
      ))}
      {goals.length < 6 && <button type="button" className="x7-link" style={{ alignSelf: 'flex-start' }} onClick={() => setGoals([...goals, ''])}>➕ {tr('Another goal')}</button>}
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onCancel}>{tr('Back')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Send the review')}</button></div>
    </form>
  );
}

function ReviewSheet({ id, people, onClose, onChanged }) {
  const [r, setR] = useState(null);
  const [mode, setMode] = useState('');
  const [rev, setRev] = useState('');
  const [error, setError] = useState(null);
  useEffect(() => { api.get('/reviews/' + id).then(setR).catch((e) => setError(e.message)); }, [id]);
  function done(x) { setR(x); setMode(''); onChanged(); }
  async function setReviewer() {
    try { done(await api.post('/reviews/' + id + '/reviewer', { reviewerId: rev })); } catch (e) { setError(e.message); }
  }
  if (!r) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const st = STATUS[r.status];
  const canWrite = (r.you.reviewer || r.you.hr) && !r.you.employee && (r.status === 'self' || r.status === 'manager') && r.round.status === 'open';
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet is-wide" role="dialog" aria-modal="true" aria-labelledby="rv-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={r.status === 'signed' ? { '--g1': '#15803d', '--g2': '#0f766e' } : r.status === 'done' ? { '--g1': '#6d28d9', '--g2': '#db2777' } : {}}>
          <span className="x7-avatar" style={{ '--h': hue(r.employee.name) }} aria-hidden="true">{r.employee.name.charAt(0)}</span>
          <div>
            <small>{r.round.name} · {r.employee.position || r.employee.code}{r.employee.company ? ' · ' + r.employee.company : ''}</small>
            <h2 id="rv-t">{r.employee.name}</h2>
            <p>{r.manager && r.manager.overall != null ? <b>★ {r.manager.overall}</b> : null}<span className="x7-pill">{st[0]} {tr(st[1])}</span>{r.late && <span className="x7-pill">⏰ {tr('late')}</span>}</p>
          </div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        <dl className="x7-facts">
          <div><dt>{tr('Period')}</dt><dd>{dayText(r.round.periodStart)} – {dayText(r.round.periodEnd)}</dd></div>
          <div><dt>{tr('Reviewer')}</dt><dd>{r.reviewer ? r.reviewer.name : '—'}</dd></div>
          <div><dt>{tr('Self-review')}</dt><dd>{r.self.at ? dayText(r.self.at) : tr('due {date}', { date: dayText(r.round.selfDue) })}</dd></div>
          <div><dt>{tr('Review')}</dt><dd>{r.manager && r.manager.at ? dayText(r.manager.at) : tr('due {date}', { date: dayText(r.round.dueOn) })}</dd></div>
        </dl>
        <Answers r={r} />
        {r.self.comment && <p className="x7-note">💬 <b>{tr('In their words')}:</b> {r.self.comment}</p>}
        {r.manager && r.manager.at && (
          <>
            <p className="x7-note">🌟 <b>{tr('What went well')}:</b> {r.manager.strengths}</p>
            {r.manager.improve && <p className="x7-note">🔧 <b>{tr('What to work on')}:</b> {r.manager.improve}</p>}
            <div className="x7-sec"><h3>🎯 {tr('Goals for the next period')}</h3><ol className="rv-goals">{r.manager.goals.map((g, i) => <li key={i}>{g.text}</li>)}</ol></div>
          </>
        )}
        {r.signedAt && <p className="x7-note">✍️ {tr('Signed on {date}', { date: dayText(r.signedAt) })}{r.employeeComment ? ' — “' + r.employeeComment + '”' : ''}</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {mode === 'write' && <ManagerForm r={r} onDone={done} onCancel={() => setMode('')} />}
        {mode === 'reviewer' && (
          <div className="x7-form">
            <h3>🧑‍💼 {tr('Who reviews them?')}</h3>
            <select className="input" value={rev} onChange={(e) => setRev(e.target.value)}><option value="">—</option>{people.filter((p) => p.id !== r.employee.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setMode('')}>{tr('Back')}</button><button type="button" className="btn btn-primary" disabled={!rev} onClick={setReviewer}>{tr('Save')}</button></div>
          </div>
        )}
        {!mode && (
          <div className="x7-actions">
            {canWrite && <button type="button" className="btn btn-primary" onClick={() => setMode('write')}>✍️ {r.status === 'self' ? tr('Review without their self-review') : tr('Write the review')}</button>}
            {r.you.hr && r.status !== 'signed' && <button type="button" className="btn btn-secondary" onClick={() => setMode('reviewer')}>🧑‍💼 {tr('Change the reviewer')}</button>}
          </div>
        )}
      </div>
    </div>
  );
}

function RoundDialog({ d, onClose, onDone }) {
  const y = new Date().getUTCFullYear();
  const first = new Date().getUTCMonth() < 6;
  const [f, setF] = useState({ name: (first ? tr('First half') : tr('Second half')) + ' ' + y, periodStart: first ? y + '-01-01' : y + '-07-01', periodEnd: first ? y + '-06-30' : y + '-12-31', selfDue: '', dueOn: '', companyIds: d.companies.map((c) => c.id), questions: d.defaults, custom: [''] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const toggle = (k, v) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] });
  async function go(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.post('/reviews/rounds', { ...f, custom: f.custom.filter((c) => c.trim()) })); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" style={{ width: 'min(680px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="rv-r-t" onClick={(e) => e.stopPropagation()} onSubmit={go}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">🌟</span><div><h2 id="rv-r-t">{tr('Open a review round')}</h2><p>{tr('Everyone in the companies chosen gets a review; their manager reviews them.')}</p></div></div>
        <label><span>{tr('Name')}</span><input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <div className="x7-grid2">
          <label><span>{tr('Period from')}</span><input className="input" type="date" required value={f.periodStart} onChange={(e) => setF({ ...f, periodStart: e.target.value })} /></label>
          <label><span>{tr('to')}</span><input className="input" type="date" required value={f.periodEnd} onChange={(e) => setF({ ...f, periodEnd: e.target.value })} /></label>
          <label><span>{tr('Self-reviews by')}</span><input className="input" type="date" required value={f.selfDue} onChange={(e) => setF({ ...f, selfDue: e.target.value })} /></label>
          <label><span>{tr('Reviews by')}</span><input className="input" type="date" required value={f.dueOn} onChange={(e) => setF({ ...f, dueOn: e.target.value })} /></label>
        </div>
        <span className="x7-muted">{tr('Companies')}</span>
        <div className="x7-chips">{d.companies.map((c) => <button key={c.id} type="button" className={f.companyIds.includes(c.id) ? 'is-on' : ''} onClick={() => toggle('companyIds', c.id)}>{c.name}</button>)}</div>
        <span className="x7-muted">{tr('What is scored, 1 to 5')}</span>
        <div className="x7-chips">{Object.keys(d.known).map((k) => <button key={k} type="button" className={f.questions.includes(k) ? 'is-on' : ''} onClick={() => toggle('questions', k)}>{tr(KNOWN[k])}</button>)}</div>
        {f.custom.map((c, i) => <input key={i} className="input" value={c} onChange={(e) => setF({ ...f, custom: f.custom.map((x, j) => (j === i ? e.target.value : x)) })} placeholder={tr('A point of your own, e.g. Keeps the workshop tidy')} />)}
        {f.custom.length < 4 && <button type="button" className="x7-link" style={{ alignSelf: 'flex-start' }} onClick={() => setF({ ...f, custom: [...f.custom, ''] })}>➕ {tr('Another point')}</button>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Open the round')}</button></div>
      </form>
    </div>
  );
}

export default function ReviewsPage() {
  const [params, setParams] = useSearchParams();
  const [round, setRound] = useState('');
  const [only, setOnly] = useState('all');
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [opening, setOpening] = useState(false);
  const load = useCallback(() => api.get('/reviews' + (round ? '?round=' + round : '')).then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), [round]);
  useEffect(() => { load(); }, [load]);
  const openId = params.get('open');
  const open = (id) => setParams(id ? { open: id } : {});
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const s = d.summary, cur = d.rounds.find((w) => w.id === d.round);
  const list = d.reviews.filter((r) => only === 'all' || r.status === only || (only === 'late' && r.late));
  const total = d.reviews.length || 1;
  return (
    <div className="x7">
      <header className="x7-head">
        <div>
          <h1>🌟 {tr('Performance reviews')}</h1>
          <p>{d.canManage ? tr('Each person rates themselves in My space; their manager scores the same points and sets goals; they read it and sign.') : tr('The reviews you write: their self-review first, then yours.')}</p>
        </div>
        {d.canManage && <button type="button" className="btn btn-primary" onClick={() => setOpening(true)}>➕ {tr('Open a review round')}</button>}
      </header>
      {d.rounds.length > 1 && <div className="x7-chips">{d.rounds.map((w) => <button key={w.id} type="button" className={d.round === w.id ? 'is-on' : ''} onClick={() => setRound(w.id)}>{w.status === 'closed' ? '🔒 ' : ''}{w.name}</button>)}</div>}
      {!cur ? <div className="x7-empty"><span aria-hidden="true">🌟</span><p>{d.canManage ? tr('No review round yet. Open the first one.') : tr('No review for you to write.')}</p></div> : (
        <>
          <div className="x7-tiles">
            <div className="x7-tile is-warn"><small>✍️ {tr('Self-review to do')}</small><b>{s.self}</b><span>{tr('due {date}', { date: dayText(cur.selfDue) })}</span></div>
            <div className="x7-tile is-calm"><small>🧑‍💼 {tr('With the reviewer')}</small><b>{s.manager}</b><span>{tr('due {date}', { date: dayText(cur.dueOn) })}</span></div>
            <div className="x7-tile is-violet"><small>📬 {tr('Ready to sign')}</small><b>{s.done}</b><span>{tr('waiting for the person')}</span></div>
            <div className="x7-tile is-good"><small>✅ {tr('Signed')}</small><b>{s.signed}</b><span>{cur.average != null ? tr('average score {n}', { n: cur.average }) : '—'}</span></div>
            {(s.late > 0 || s.noReviewer > 0) && <div className="x7-tile is-bad"><small>⏰ {tr('Needs a push')}</small><b>{s.late + s.noReviewer}</b><span>{tr('{l} late, {n} without a reviewer', { l: s.late, n: s.noReviewer })}</span></div>}
          </div>
          <section className="x7-card">
            <h2>{cur.name} <small>{dayText(cur.periodStart)} – {dayText(cur.periodEnd)}</small></h2>
            <div className="rv-progress" role="img" aria-label={Object.keys(STATUS).map((k) => tr(STATUS[k][1]) + ' ' + s[k]).join(', ')}>
              {Object.keys(STATUS).map((k) => s[k] > 0 && <i key={k} style={{ flexGrow: s[k] / total, background: COLORS[k] }} />)}
            </div>
            <div className="bg-legend">{Object.keys(STATUS).map((k) => <span key={k}><i className="bg-key" style={{ background: COLORS[k] }} />{tr(STATUS[k][1])} {s[k]}</span>)}</div>
          </section>
          <div className="x7-seg" role="tablist" style={{ alignSelf: 'flex-start' }}>
            {[['all', tr('All')], ['self', tr('Self-review to do')], ['manager', tr('With the reviewer')], ['done', tr('Ready to sign')], ['signed', tr('Signed')], ['late', tr('Late')]].map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={only === k} className={only === k ? 'is-on' : ''} onClick={() => setOnly(k)}>{l}</button>)}
          </div>
          <div className="x7-list">
            {list.map((r) => (
              <button key={r.id} type="button" className={'x7-row' + (r.late ? ' is-flag is-bad' : '')} onClick={() => open(r.id)}>
                <span className="x7-avatar" style={{ '--h': hue(r.employee.name) }} aria-hidden="true">{r.employee.name.charAt(0)}</span>
                <span className="x7-who"><b>{r.employee.name}</b><small>{r.employee.position || r.employee.code} · {r.employee.company}{r.reviewer ? ' · ' + tr('reviewer: {name}', { name: r.reviewer.name }) : ' · ⚠️ ' + tr('no reviewer')}</small></span>
                <span className={'x7-pill ' + TONE[r.status]}>{STATUS[r.status][0]} {tr(STATUS[r.status][1])}{r.late ? ' · ⏰' : ''}</span>
                <span className="x7-money"><Stars v={r.manager ? r.manager.overall : null} /><small>{r.self.average != null ? tr('own score {n}', { n: r.self.average }) : ''}</small></span>
              </button>
            ))}
            {!list.length && <p className="x7-note">{tr('No one here.')}</p>}
          </div>
        </>
      )}
      {openId && <ReviewSheet key={openId} id={openId} people={d.people} onClose={() => open(null)} onChanged={load} />}
      {opening && <RoundDialog d={d} onClose={() => setOpening(false)} onDone={(x) => { setOpening(false); setD(x); setRound(x.round); }} />}
    </div>
  );
}

// My space: my review (rate myself, then read and sign), and the ones I write.
export function MyReviewCard() {
  const [d, setD] = useState(null);
  const [scores, setScores] = useState({});
  const [comment, setComment] = useState('');
  const [sign, setSign] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const load = useCallback(() => api.get('/reviews/mine').then(setD).catch(() => setD(null)), []);
  useEffect(() => { load(); }, [load]);
  if (!d || (!d.reviews.length && !d.toReview)) return null;
  // The one waiting on them first: to sign, then to rate; else the latest.
  const r = d.reviews.find((x) => x.status === 'done') || d.reviews.find((x) => x.status === 'self' && x.round.status === 'open') || d.reviews[0];
  async function act(path, body) {
    setBusy(true); setError(null);
    try { await api.post('/reviews/' + r.id + '/' + path, body); setOpen(false); load(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <div className="msx-card x7-mine">
      <h4 className="msp-h4">🌟 {tr('My review')}</h4>
      {d.toReview > 0 && <Link className="x7-link" to="/reviews">✍️ {d.toReview === 1 ? tr('1 review to write →') : tr('{n} reviews to write →', { n: d.toReview })}</Link>}
      {r && (
        <>
          <div className="x7-mine-top" style={{ '--tone': r.status === 'self' ? 'var(--x7-warn)' : r.status === 'signed' ? 'var(--x7-good)' : 'var(--x7-violet)' }}>
            <span><small>{r.round.name}</small><b>{STATUS[r.status][0]} {r.status === 'manager' ? tr('With {name} now', { name: r.reviewer ? r.reviewer.name : tr('your reviewer') }) : tr(STATUS[r.status][1])}</b>
              {r.status === 'self' && <small>{tr('by {date}', { date: dayText(r.round.selfDue) })}</small>}
              {r.manager && r.manager.overall != null && <small>★ {r.manager.overall} / 5</small>}</span>
            {r.status === 'self' && r.round.status === 'open' && !open && <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>{tr('Rate how it went')}</button>}
            {r.status === 'done' && !open && <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>{tr('Read and sign')}</button>}
            {r.status === 'signed' && <button type="button" className="btn btn-secondary" onClick={() => setOpen(!open)}>{open ? tr('Close') : tr('Read it')}</button>}
          </div>
          {open && r.status === 'self' && (
            <form className="x7-form" onSubmit={(e) => { e.preventDefault(); act('self', { scores, comment }); }}>
              <div className="rv-qs">{r.questions.map((q) => <div key={q.key} className="rv-q is-form"><span>{qLabel(q)}</span><Score value={scores[q.key]} onChange={(n) => setScores({ ...scores, [q.key]: n })} label={qLabel(q)} /></div>)}</div>
              <label><span>{tr('How did it go? What are you proud of, what got in the way?')}</span><textarea className="input" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} /></label>
              {error && <div className="error-banner" role="alert">{error}</div>}
              <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Send')}</button></div>
            </form>
          )}
          {(r.status === 'done' || r.status === 'signed') && open && (
            <div className="x7-form">
              <Answers r={r} />
              <p className="x7-note">🌟 {r.manager.strengths}</p>
              {r.manager.improve && <p className="x7-note">🔧 {r.manager.improve}</p>}
              <ol className="rv-goals">{r.manager.goals.map((g, i) => <li key={i}>{g.text}</li>)}</ol>
              {r.status === 'done' && (
                <form onSubmit={(e) => { e.preventDefault(); act('sign', { comment: sign }); }} className="x7-form" style={{ padding: 0, border: 0, background: 'none' }}>
                  <label><span>{tr('A word of your own (optional)')}</span><input className="input" value={sign} onChange={(e) => setSign(e.target.value)} /></label>
                  {error && <div className="error-banner" role="alert">{error}</div>}
                  <button type="submit" className="btn btn-primary" disabled={busy}>✍️ {tr('I have read it: sign')}</button>
                </form>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
