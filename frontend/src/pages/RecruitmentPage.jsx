import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import { api, API_URL } from '../api/client';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './seventeenth.css';

// Recruitment (People → Recruitment; backend recruitment.service.js,
// migration 0198): job openings shown on the jobs page while open; applicants
// from the page with their CV, or added by hand; each moved through the
// stages on a board — new, screening, interview, offer, hired, not this
// time — rated, noted, interviewed; hired straight into the staff.

const STAGES = [['new', '🆕', msg('New')], ['screening', '🔎', msg('Screening')], ['interview', '🗓️', msg('Interview')], ['offer', '🤝', msg('Offer')], ['hired', '🎉', msg('Hired')], ['rejected', '🙅', msg('Not this time')]];
const STAGE = Object.fromEntries(STAGES.map(([k, ic, l]) => [k, [ic, l]]));
const KIND = { full_time: msg('Full time'), part_time: msg('Part time'), contract: msg('Contract'), internship: msg('Internship'), casual: msg('Casual') };
const SOURCE = { website: ['🌐', msg('Jobs page')], walk_in: ['🚶', msg('Walked in')], referral: ['🤝', msg('Referred')], other: ['📎', msg('Other')] };
function dayText(d, opts) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC', ...opts }) : '—'; }
function when(iso) { return iso ? new Date(iso).toLocaleString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; }
function localInput(iso) { if (!iso) return ''; const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
function hue(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function today() { return new Date().toISOString().slice(0, 10); }
function jobsUrl(slug) { const base = import.meta.env.VITE_BPL_SITE_URL || 'https://online.bplghana.com'; return base + '/jobs' + (slug ? '/' + slug : ''); }

function JobForm({ meta, job, onClose, onSaved }) {
  const [f, setF] = useState(job ? { id: job.id, companyId: job.companyId, departmentId: job.departmentId || '', title: job.title, location: job.location, kind: job.kind, description: job.description, requirements: job.requirements, pay: job.pay, closesOn: job.closesOn || '', status: job.status }
    : { companyId: (meta.companies[0] || {}).id, departmentId: '', title: '', location: '', kind: 'full_time', description: '', requirements: '', pay: '', closesOn: '', status: 'open' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onSaved(await api.post('/recruitment/openings', f)); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" style={{ width: 'min(720px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="rc-j-t" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">📣</span><div><h2 id="rc-j-t">{job ? tr('Change the job') : tr('Post a job')}</h2><p>{tr('Open: it shows on the jobs page until the closing day.')}</p></div></div>
        <div className="x7-chips">{meta.companies.map((c) => <button key={c.id} type="button" className={f.companyId === c.id ? 'is-on' : ''} onClick={() => setF({ ...f, companyId: c.id, departmentId: '' })}>{c.name}</button>)}</div>
        <div className="x7-grid2">
          <label><span>{tr('Job title')}</span><input className="input" required value={f.title} onChange={set('title')} placeholder={tr('e.g. Furniture finisher')} /></label>
          <label><span>{tr('Department')}</span><select className="input" value={f.departmentId} onChange={set('departmentId')}><option value="">—</option>{meta.departments.filter((d) => d.companyId === f.companyId).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
          <label><span>{tr('Where')}</span><input className="input" value={f.location} onChange={set('location')} /></label>
          <label><span>{tr('Pay')}</span><input className="input" value={f.pay} onChange={set('pay')} placeholder={tr('Optional, e.g. GHS 2,500 a month')} /></label>
        </div>
        <div className="x7-chips">{Object.entries(KIND).map(([k, l]) => <button key={k} type="button" className={f.kind === k ? 'is-on' : ''} onClick={() => setF({ ...f, kind: k })}>{tr(l)}</button>)}</div>
        <label><span>{tr('The job')}</span><textarea className="input" rows={5} required value={f.description} onChange={set('description')} /></label>
        <label><span>{tr('Who we are looking for')}</span><textarea className="input" rows={3} value={f.requirements} onChange={set('requirements')} /></label>
        <div className="x7-grid2">
          <label><span>{tr('Applications close')}</span><input className="input" type="date" min={today()} value={f.closesOn} onChange={set('closesOn')} /><small>{tr('Empty: open until you close it.')}</small></label>
          <label><span>{tr('Status')}</span><select className="input" value={f.status} onChange={set('status')}><option value="draft">{tr('Draft')}</option><option value="open">{tr('Open')}</option><option value="closed">{tr('Closed')}</option></select></label>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save')}</button></div>
      </form>
    </div>
  );
}

function AddApplicant({ opening, onClose, onSaved }) {
  const [f, setF] = useState({ name: '', email: '', phone: '', note: '', source: 'walk_in' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onSaved(await api.post('/recruitment/applicants', { ...f, openingId: opening.id })); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" role="dialog" aria-modal="true" aria-labelledby="rc-a-t" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">🚶</span><div><h2 id="rc-a-t">{tr('Add an applicant')}</h2><p>{opening.title}</p></div></div>
        <div className="x7-chips">{['walk_in', 'referral', 'other'].map((k) => <button key={k} type="button" className={f.source === k ? 'is-on' : ''} onClick={() => setF({ ...f, source: k })}><em aria-hidden="true">{SOURCE[k][0]}</em>{tr(SOURCE[k][1])}</button>)}</div>
        <div className="x7-grid3">
          <label><span>{tr('Full name')}</span><input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label><span>{tr('Email')}</span><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
          <label><span>{tr('Phone')}</span><input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
        </div>
        <label><span>{tr('Note')}</span><textarea className="input" rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Add')}</button></div>
      </form>
    </div>
  );
}

function CvView({ id, onClose }) {
  const [x, setX] = useState(null);
  useEffect(() => {
    let made = null, live = true;
    fetch(API_URL + '/recruitment/applicants/' + id + '/cv', { headers: api.authHeaders() }).then((r) => (r.ok ? r.blob() : null)).then((b) => { if (b && live) { made = URL.createObjectURL(b); setX({ url: made, type: b.type }); } }).catch(() => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [id]);
  // On the page itself: inside the sheet, its blur would hold it in.
  return createPortal(
    <div className="x7-zoom" onClick={onClose} role="dialog" aria-label={tr('CV')}>
      {!x ? <p>{tr('Loading…')}</p> : x.type.startsWith('image/') ? <img src={x.url} alt={tr('CV')} /> : x.type === 'application/pdf'
        ? <iframe title={tr('CV')} src={x.url} style={{ width: 'min(900px, 96vw)', height: '90vh', border: 0, borderRadius: 12, background: '#fff' }} onClick={(e) => e.stopPropagation()} />
        : <a href={x.url} download="cv" onClick={(e) => e.stopPropagation()} style={{ color: '#fff', fontWeight: 800 }}>⬇️ {tr('Download the CV')}</a>}
    </div>,
    document.body
  );
}

function ApplicantSheet({ id, meta, onClose, onChanged }) {
  const [a, setA] = useState(null);
  const [mode, setMode] = useState('');
  const [note, setNote] = useState('');
  const [f, setF] = useState({});
  const [cv, setCv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api.get('/recruitment/applicants/' + id).then(setA).catch((e) => setError(e.message)); }, [id]);
  async function put(body) {
    setBusy(true); setError(null);
    try { const x = await api.put('/recruitment/applicants/' + id, body); setA(x); setMode(''); onChanged(); return x; } catch (err) { setError(err.message); return null; } finally { setBusy(false); }
  }
  async function addNote(e) {
    e.preventDefault();
    try { setA(await api.post('/recruitment/applicants/' + id + '/notes', { text: note })); setNote(''); } catch (err) { setError(err.message); }
  }
  async function hire(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { const x = await api.post('/recruitment/applicants/' + id + '/hire', f); setA(x); setMode(''); setFlash('🎉 ' + tr('{name} is on the staff now, as {code}.', { name: x.name, code: x.employee.code })); onChanged(); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  if (!a) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const st = STAGE[a.stage];
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet" role="dialog" aria-modal="true" aria-labelledby="rc-ap-t" onClick={(e) => e.stopPropagation()}>
        <div className={'x7-hero rc-stage-' + a.stage} style={a.stage === 'hired' ? { '--g1': '#15803d', '--g2': '#0f766e' } : a.stage === 'rejected' ? { '--g1': '#475569', '--g2': '#334155' } : { '--g1': '#6d28d9', '--g2': '#2563eb' }}>
          <span className="x7-avatar" style={{ '--h': hue(a.name) }} aria-hidden="true">{a.name.charAt(0)}</span>
          <div>
            <small>{a.opening.title} · {a.opening.company} · {SOURCE[a.source][0]} {tr(SOURCE[a.source][1])}</small>
            <h2 id="rc-ap-t">{a.name}</h2>
            <p><span className="x7-pill">{st[0]} {tr(st[1])}</span>{a.interviewAt && a.stage === 'interview' && <span className="x7-pill">🗓️ {when(a.interviewAt)}</span>}</p>
          </div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        <dl className="x7-facts">
          <div><dt>{tr('Email')}</dt><dd>{a.email || '—'}</dd></div>
          <div><dt>{tr('Phone')}</dt><dd>{a.phone || '—'}</dd></div>
          <div><dt>{tr('Applied')}</dt><dd>{dayText(a.createdAt, { year: 'numeric' })}</dd></div>
          <div><dt>{tr('Rating')}</dt><dd><span className="rc-rate" role="radiogroup" aria-label={tr('Rating')}>{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" role="radio" aria-checked={a.rating === n} className={(a.rating || 0) >= n ? 'is-on' : ''} disabled={a.stage === 'hired'} onClick={() => put({ rating: a.rating === n ? null : n })}>★</button>)}</span></dd></div>
        </dl>
        {a.note && <p className="x7-note">💬 {a.note}</p>}
        {a.cv ? <button type="button" className="btn btn-secondary" style={{ alignSelf: 'flex-start' }} onClick={() => setCv(true)}>📄 {tr('Open the CV')}</button> : <p className="x7-muted">{tr('No CV.')}</p>}
        {a.others && a.others.length > 0 && <p className="x7-note">🔁 {tr('Also applied for: {jobs}', { jobs: a.others.map((o) => o.title).join(', ') })}</p>}
        {a.stage === 'rejected' && a.rejectReason && <p className="x7-note">🙅 {a.rejectReason}</p>}
        {flash && <div className="x7-flash" role="status">{flash}{a.employeeId && <> · <Link to={'/people?employee=' + a.employeeId}>{tr('Open their record')}</Link></>}</div>}
        {a.stage !== 'hired' && !mode && (
          <div className="x7-sec">
            <h3>{tr('Move to')}</h3>
            <div className="x7-chips">
              {STAGES.filter(([k]) => k !== 'hired' && k !== a.stage).map(([k, ic, l]) => <button key={k} type="button" disabled={busy} onClick={() => (k === 'interview' ? (setF({ interviewAt: localInput(a.interviewAt), interviewerId: a.interviewer ? a.interviewer.id : '' }), setMode('interview')) : k === 'rejected' ? (setF({ rejectReason: '' }), setMode('reject')) : put({ stage: k }))}><em aria-hidden="true">{ic}</em>{tr(l)}</button>)}
              {meta.canHire && <button type="button" className="is-on" style={{ '--c1': '#15803d', '--c2': '#0f766e' }} onClick={() => { setF({ positionTitle: a.opening.title, hireDate: today(), employmentType: 'permanent', departmentId: '' }); setMode('hire'); }}>🎉 {tr('Hire')}</button>}
            </div>
          </div>
        )}
        {mode === 'interview' && (
          <form className="x7-form" onSubmit={(e) => { e.preventDefault(); put({ stage: 'interview', interviewAt: f.interviewAt ? new Date(f.interviewAt).toISOString() : null, interviewerId: f.interviewerId || null }); }}>
            <h3>🗓️ {tr('Interview')}</h3>
            <div className="x7-grid2">
              <label><span>{tr('When')}</span><input className="input" type="datetime-local" required value={f.interviewAt} onChange={(e) => setF({ ...f, interviewAt: e.target.value })} /></label>
              <label><span>{tr('With')}</span><select className="input" value={f.interviewerId} onChange={(e) => setF({ ...f, interviewerId: e.target.value })}><option value="">—</option>{meta.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><small>{tr('They are told.')}</small></label>
            </div>
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setMode('')}>{tr('Back')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save')}</button></div>
          </form>
        )}
        {mode === 'reject' && (
          <form className="x7-form" onSubmit={(e) => { e.preventDefault(); put({ stage: 'rejected', rejectReason: f.rejectReason }); }}>
            <h3>🙅 {tr('Not this time')}</h3>
            <label><span>{tr('Why? For the record.')}</span><input className="input" required value={f.rejectReason} onChange={(e) => setF({ ...f, rejectReason: e.target.value })} /></label>
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setMode('')}>{tr('Back')}</button><button type="submit" className="btn btn-danger" disabled={busy}>{tr('Save')}</button></div>
          </form>
        )}
        {mode === 'hire' && (
          <form className="x7-form" onSubmit={hire}>
            <h3>🎉 {tr('Hire {name}', { name: a.name })}</h3>
            <div className="x7-grid2">
              <label><span>{tr('Job title')}</span><input className="input" required value={f.positionTitle} onChange={(e) => setF({ ...f, positionTitle: e.target.value })} /></label>
              <label><span>{tr('Starts on')}</span><input className="input" type="date" required value={f.hireDate} onChange={(e) => setF({ ...f, hireDate: e.target.value })} /></label>
              <label><span>{tr('Department')}</span><select className="input" value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}><option value="">{tr('The job\'s own')}</option>{meta.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
              <label><span>{tr('Employment')}</span><select className="input" value={f.employmentType} onChange={(e) => setF({ ...f, employmentType: e.target.value })}><option value="permanent">{tr('Permanent')}</option><option value="contract">{tr('Contract')}</option><option value="casual">{tr('Casual')}</option><option value="day_rate">{tr('Day rate')}</option></select></label>
            </div>
            <p className="x7-muted">{tr('They go into the employee directory with their name, email and phone; add their pay there.')}</p>
            {error && <div className="error-banner" role="alert">{error}</div>}
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setMode('')}>{tr('Back')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Hire')}</button></div>
          </form>
        )}
        {error && mode !== 'hire' && <div className="error-banner" role="alert">{error}</div>}
        <div className="x7-sec">
          <h3>🗒️ {tr('Notes')}</h3>
          <form className="rv-goal-row" onSubmit={addNote}><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr('After the call, the interview…')} /><button type="submit" className="btn btn-secondary" disabled={!note.trim()}>{tr('Add')}</button></form>
          <div className="rc-notes" style={{ marginTop: 8 }}>{(a.notes || []).map((n) => <p key={n.id}>{n.text}<small>{n.by} · {when(n.at)}</small></p>)}</div>
        </div>
        {cv && <CvView id={a.id} onClose={() => setCv(false)} />}
      </div>
    </div>
  );
}

function Opening({ id, meta, onBack, onChanged, openApplicant }) {
  const [d, setD] = useState(null);
  const [dlg, setDlg] = useState('');
  const [copied, setCopied] = useState(false);
  const load = useCallback(() => api.get('/recruitment/openings/' + id).then(setD).catch(() => {}), [id]);
  useEffect(() => { load(); }, [load]);
  if (!d) return <p className="x7-wait">{tr('Loading…')}</p>;
  const o = d.opening;
  async function copy() { try { await navigator.clipboard.writeText(jobsUrl(o.slug)); setCopied(true); } catch { setCopied(true); } }
  return (
    <>
      <button type="button" className="x7-back" onClick={onBack}>← {tr('All jobs')}</button>
      <header className="x7-head">
        <div>
          <h1>📣 {o.title}</h1>
          <p>{o.company}{o.department ? ' · ' + o.department : ''} · {tr(KIND[o.kind])}{o.location ? ' · ' + o.location : ''} · {o.open ? '🟢 ' + tr('open') : o.status === 'draft' ? '📝 ' + tr('draft') : '🔒 ' + tr('closed')}{o.closesOn ? ' · ' + tr('closes {date}', { date: dayText(o.closesOn) }) : ''}</p>
        </div>
        <div className="x7-head-actions">
          {o.open && <button type="button" className="btn btn-secondary" onClick={copy}>🔗 {copied ? tr('Link copied') : tr('Copy the link')}</button>}
          <button type="button" className="btn btn-secondary" onClick={() => setDlg('edit')}>✏️ {tr('Edit')}</button>
          <button type="button" className="btn btn-primary" onClick={() => setDlg('add')}>➕ {tr('Add an applicant')}</button>
        </div>
      </header>
      {copied && <p className="x7-note">🔗 {jobsUrl(o.slug)}</p>}
      <div className="rc-board">
        {STAGES.map(([k, ic, l]) => {
          const list = d.applicants.filter((a) => a.stage === k);
          return (
            <div key={k} className={'x7-col rc-stage-' + k}>
              <h3><span aria-hidden="true">{ic}</span>{tr(l)}<small>{list.length}</small></h3>
              {list.map((a) => (
                <button key={a.id} type="button" className="rc-card" onClick={() => openApplicant(a.id)}>
                  <b>{a.name}</b>
                  <small>{SOURCE[a.source][0]} {dayText(a.createdAt)}{a.cv ? ' · 📄' : ''}</small>
                  {a.rating ? <span className="x7-stars">{'★'.repeat(a.rating)}<i>{'★'.repeat(5 - a.rating)}</i></span> : null}
                  {k === 'interview' && a.interviewAt && <span className="x7-pill is-violet">🗓️ {when(a.interviewAt)}</span>}
                </button>
              ))}
            </div>
          );
        })}
      </div>
      {dlg === 'edit' && <JobForm meta={meta} job={o} onClose={() => setDlg('')} onSaved={(x) => { setDlg(''); setD(x); onChanged(); }} />}
      {dlg === 'add' && <AddApplicant opening={o} onClose={() => setDlg('')} onSaved={(x) => { setDlg(''); load(); onChanged(); openApplicant(x.id); }} />}
    </>
  );
}

export default function RecruitmentPage() {
  const [params, setParams] = useSearchParams();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [posting, setPosting] = useState(false);
  const [tick, setTick] = useState(0);
  const load = useCallback(() => api.get('/recruitment').then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const openingId = params.get('opening'), applicantId = params.get('applicant');
  const go = (k, v) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; });
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const s = d.summary;
  return (
    <div className="x7">
      {openingId ? <Opening key={openingId + ':' + tick} id={openingId} meta={d} onBack={() => go('opening', null)} onChanged={load} openApplicant={(id) => go('applicant', id)} /> : (
        <>
          <header className="x7-head">
            <div>
              <h1>🤝 {tr('Recruitment')}</h1>
              <p>{tr('Post a job and it shows on the jobs page; applicants come in with their CV and move along the board to hired.')}</p>
            </div>
            <div className="x7-head-actions">
              <a className="btn btn-secondary" href={jobsUrl('')} target="_blank" rel="noreferrer">🌐 {tr('The jobs page')}</a>
              <button type="button" className="btn btn-primary" onClick={() => setPosting(true)}>📣 {tr('Post a job')}</button>
            </div>
          </header>
          <div className="x7-tiles">
            <div className="x7-tile is-calm"><small>📣 {tr('Open jobs')}</small><b>{s.open}</b><span>{tr('on the jobs page')}</span></div>
            <div className="x7-tile is-violet"><small>👥 {tr('Applicants')}</small><b>{s.applicants}</b><span>{tr('{n} new to look at', { n: s.fresh })}</span></div>
            <div className="x7-tile is-warn"><small>🗓️ {tr('Interviews coming')}</small><b>{s.interviews}</b><span>{d.interviews[0] ? when(d.interviews[0].interviewAt) : '—'}</span></div>
            <div className="x7-tile is-good"><small>🎉 {tr('Hired')}</small><b>{s.hired90}</b><span>{tr('in the last 90 days')}</span></div>
          </div>
          {!d.openings.length ? <div className="x7-empty"><span aria-hidden="true">📣</span><p>{tr('No job posted yet.')}</p></div> : (
            <div className="rc-jobs">
              {d.openings.map((o, i) => (
                <button key={o.id} type="button" className="x7-acc" style={{ animationDelay: Math.min(i, 8) * 0.04 + 's' }} onClick={() => go('opening', o.id)}>
                  <span className="bk-acc-top">
                    <span className="x7-icon" aria-hidden="true">📣</span>
                    <span className="x7-who"><b>{o.title}</b><small>{o.company}{o.department ? ' · ' + o.department : ''} · {tr(KIND[o.kind])}</small></span>
                    <span className={'x7-pill ' + (o.open ? 'is-good' : o.status === 'draft' ? 'is-warn' : '')}>{o.open ? '🟢 ' + tr('Open') : o.status === 'draft' ? '📝 ' + tr('Draft') : '🔒 ' + tr('Closed')}</span>
                  </span>
                  <span className="rc-pipe" role="img" aria-label={STAGES.map(([k, , l]) => tr(l) + ' ' + o.byStage[k]).join(', ')}>{STAGES.slice(0, 5).map(([k]) => <i key={k} className={'rc-stage-' + k + (o.byStage[k] ? ' is-on' : '')} />)}</span>
                  <span className="bk-acc-facts">
                    <span><small>{tr('Applicants')}</small><b>{o.applicants}{o.newOnes ? ' · 🆕' + o.newOnes : ''}</b></span>
                    <span><small>{tr('Closes')}</small><b>{o.closesOn ? dayText(o.closesOn) : '—'}</b></span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {d.interviews.length > 0 && (
            <section className="x7-card">
              <h2>🗓️ {tr('Interviews coming')}</h2>
              <div className="x7-list">{d.interviews.map((a) => (
                <button key={a.id} type="button" className="x7-row" onClick={() => go('applicant', a.id)}>
                  <span className="x7-avatar" style={{ '--h': hue(a.name) }} aria-hidden="true">{a.name.charAt(0)}</span>
                  <span className="x7-who"><b>{a.name}</b><small>{a.opening.title}{a.interviewer ? ' · ' + tr('with {name}', { name: a.interviewer.name }) : ''}</small></span>
                  <span className="x7-pill is-violet">🗓️ {when(a.interviewAt)}</span><span />
                </button>
              ))}</div>
            </section>
          )}
          {d.recent.length > 0 && (
            <section className="x7-card">
              <h2>🆕 {tr('New applicants')}</h2>
              <div className="x7-list">{d.recent.map((a) => (
                <button key={a.id} type="button" className="x7-row" onClick={() => go('applicant', a.id)}>
                  <span className="x7-avatar" style={{ '--h': hue(a.name) }} aria-hidden="true">{a.name.charAt(0)}</span>
                  <span className="x7-who"><b>{a.name}</b><small>{a.opening.title} · {a.opening.company}</small></span>
                  <span className="x7-pill">{SOURCE[a.source][0]} {tr(SOURCE[a.source][1])}</span>
                  <span className="x7-money"><small>{dayText(a.createdAt)}</small></span>
                </button>
              ))}</div>
            </section>
          )}
        </>
      )}
      {applicantId && <ApplicantSheet key={applicantId} id={applicantId} meta={d} onClose={() => go('applicant', null)} onChanged={() => { load(); setTick((t) => t + 1); }} />}
      {posting && <JobForm meta={d} onClose={() => setPosting(false)} onSaved={(x) => { setPosting(false); load(); go('opening', x.opening.id); }} />}
    </div>
  );
}
