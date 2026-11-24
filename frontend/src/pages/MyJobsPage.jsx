import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { api, API_URL } from '../api/client';
import LoginPage from './LoginPage';
import ForcedPasswordChangePage from './ForcedPasswordChangePage';
import { DonePhotoField, DonePhotoStrip } from '../components/DonePhotos';
import { KINDS, PRIORITIES, jobPhotoPaths, jobReportPhotoPaths, kindIcon, kindName, priorityName, routinePhotoPaths, statusName } from '../lib/maintenance';
import { tr, activeIntlLocale } from '../lib/i18n.jsx';
import './MyJobsPage.css';

// My Jobs: the maintenance & IT team's phone app (installed from /myjobs,
// myjobs.html and myjobs-manifest.webmanifest). Each person signs in once
// and sees the jobs given to them — late ones first, then today's, then
// those coming up — starts them, puts them on hold, adds notes, and marks
// them done with a photo of the finished work (required: the button stays
// off until a photo is taken). Their routines are there too; a routine
// close to its day is already a work order (backend runDue). Every morning
// a notification says how many jobs they have (backend morning).
//
// Signing in: with the kiosk code (the 4-digit code they clock in with), on
// a phone that has the team code — typed once, or brought by the team's
// link (/myjobs?team=…) — backend myJobsAccess.service.js; or with their
// Bamboo OS email and password. A kiosk-code sign-in reaches only the
// person's own jobs.
//
// They can add work too: a job they found (theirs to do, or sent to the
// managers to give to someone) and routines of their own, which they can
// change or stop later; the managers hear of each one.
//
// Data: GET mine; moves: POST jobs/:id/status, POST routines/:id/done;
// adding: POST jobs, POST routines, PATCH routines/:id, POST
// routines/:id/stop — under /api/myjobs signed in with a kiosk code,
// /api/maint-work-orders (/mine/…) with the OS (backend
// maintenanceWorkOrders.service.js).

const REFRESH_MS = 2 * 60 * 1000;
const TEAM_KEY = 'bos.myjobs.team';
const SIGN_IN_KEY = 'bos.myjobs.signIn';

function readStore(k) { try { return localStorage.getItem(k); } catch { return null; } }
function writeStore(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* this visit only */ } }
function normTeam(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); }
function shownTeam(v) { const c = normTeam(v); return c.length > 4 ? c.slice(0, 4) + '-' + c.slice(4) : c; }

// The team's link brings the team code: kept on this phone, taken off the
// address (so it is not in what is shared or saved to the home screen).
function takeTeamFromLink() {
  try {
    const p = new URLSearchParams(window.location.search);
    const t = normTeam(p.get('team'));
    if (!t) return;
    writeStore(TEAM_KEY, t);
    p.delete('team');
    window.history.replaceState(window.history.state, '', window.location.pathname + (p.toString() ? '?' + p.toString() : ''));
  } catch { /* the code can be typed instead */ }
}

// A call to My Jobs' own API (signed in with a kiosk code): its answer, or
// an Error with the server's words and the status.
async function myJobsCall(method, path, body, token) {
  let res;
  try {
    res = await fetch(API_URL + '/myjobs' + path, {
      method,
      headers: Object.assign({}, token ? { Authorization: 'Bearer ' + token } : {}, body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    throw Object.assign(new Error(tr('No connection. Check the internet and try again.')), { status: 0 });
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw Object.assign(new Error(data && data.error ? data.error.message : tr('Something went wrong.')), { status: res.status });
  return data;
}

// The same few calls, for either sign-in.
function osClient() {
  return {
    mine: () => api.get('/maint-work-orders/mine'),
    job: (id) => api.get('/maint-work-orders/' + id),
    move: (id, body) => api.post('/maint-work-orders/' + id + '/status', body),
    routineDone: (id, body) => api.post('/maint-work-orders/routines/' + id + '/done', body),
    addJob: (body) => api.post('/maint-work-orders/mine/jobs', body),
    addRoutine: (body) => api.post('/maint-work-orders/mine/routines', body),
    saveRoutine: (id, body) => api.patch('/maint-work-orders/mine/routines/' + id, body),
    stopRoutine: (id) => api.post('/maint-work-orders/mine/routines/' + id + '/stop', {}),
    photoBase: '/maint-work-orders/', routineBase: '/maint-work-orders/routines/', token: null, team: null
  };
}
function pinClient(token, team, onEnded) {
  const call = (method, path, body) => myJobsCall(method, path, body, token).catch((e) => { if (e.status === 401) onEnded(); throw e; });
  return {
    mine: () => call('GET', '/mine'),
    job: (id) => call('GET', '/jobs/' + id),
    move: (id, body) => call('POST', '/jobs/' + id + '/status', body),
    routineDone: (id, body) => call('POST', '/routines/' + id + '/done', body),
    addJob: (body) => call('POST', '/jobs', body),
    addRoutine: (body) => call('POST', '/routines', body),
    saveRoutine: (id, body) => call('PATCH', '/routines/' + id, body),
    stopRoutine: (id) => call('POST', '/routines/' + id + '/stop', {}),
    photoBase: '/myjobs/jobs/', routineBase: '/myjobs/routines/', token, team
  };
}

function dayWords(iso, today) {
  if (!iso) return '';
  const n = Math.round((new Date(iso + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000);
  if (n === 0) return tr('Today');
  if (n === 1) return tr('Tomorrow');
  if (n === -1) return tr('Yesterday');
  if (n < 0) return tr('{n} days late', { n: -n });
  return tr('In {n} days', { n });
}
function niceDay(iso) {
  if (!iso) return '';
  return new Date(iso + 'T00:00:00Z').toLocaleDateString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
function hello() {
  const h = new Date().getHours();
  return h < 12 ? tr('Good morning') : h < 17 ? tr('Good afternoon') : tr('Good evening');
}
function isInstalled() {
  try { return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true; } catch { return false; }
}
function isIos() { return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }

function JobCard({ job, today, onOpen }) {
  const day = job.scheduledOn || null;
  return (
    <li>
      <button type="button" className={'mj-card is-' + job.status + (job.overdue ? ' is-late' : '')} onClick={() => onOpen(job)}>
        <span className="mj-card-ico" aria-hidden="true">{kindIcon(job.category)}</span>
        <span className="mj-card-main">
          <span className="mj-card-top">
            <b>{job.ref}</b>
            {(job.priority === 'urgent' || job.priority === 'high') && <span className={'mj-prio is-' + job.priority}>{priorityName(job.priority)}</span>}
            {job.status === 'in_progress' && <span className="mj-tag is-going">{tr('Started')}</span>}
            {job.status === 'on_hold' && <span className="mj-tag is-hold">{tr('On hold')}</span>}
            {job.routineId && <span className="mj-tag">🔁 {tr('Routine')}</span>}
            {job.photos && job.photos.length > 0 && <span className="mj-tag" aria-label={tr('{n} photos', { n: job.photos.length })}>📷 {job.photos.length}</span>}
          </span>
          <span className="mj-card-what">{job.description}</span>
          <span className="mj-card-meta">
            {job.location && <span>📍 {job.location}</span>}
            {day && <span className={job.overdue ? 'is-late' : ''}>📅 {niceDay(day)} · {dayWords(day, today)}</span>}
            {job.status === 'completed' && job.completedOn && <span>✅ {niceDay(job.completedOn)}</span>}
          </span>
        </span>
        <span className="mj-card-go" aria-hidden="true">›</span>
      </button>
    </li>
  );
}

// One job, full screen on the phone: what, where, who asked; start, hold,
// note; done with photos.
function JobSheet({ job, today, busy, client, onMove, onClose }) {
  const [step, setStep] = useState(null); // 'done' | 'hold' | 'note'
  const [photos, setPhotos] = useState([]);
  const [note, setNote] = useState('');
  const [cost, setCost] = useState('');
  const [err, setErr] = useState(null);
  async function move(body) {
    setErr(null);
    try { await onMove(job, body); setStep(null); setNote(''); setPhotos([]); } catch (e) { setErr(e.message); }
  }
  const open = job.open;
  return (
    <div className="mj-sheet" role="dialog" aria-modal="true" aria-labelledby="mj-sheet-title">
      <header className="mj-sheet-bar">
        <button type="button" className="mj-back" onClick={onClose} aria-label={tr('Back to my jobs')}>‹ {tr('My jobs')}</button>
        <span className="mj-sheet-ref">{job.ref}</span>
      </header>
      <div className="mj-sheet-body">
        <div className="mj-sheet-tags">
          <span className={'mj-status is-' + job.status}>{statusName(job.status)}</span>
          <span className={'mj-prio is-' + job.priority}>{priorityName(job.priority)}</span>
          <span className="mj-tag">{kindIcon(job.category)} {kindName(job.category)}</span>
          {job.overdue && <span className="mj-tag is-late">{tr('Late')}</span>}
        </div>
        <h2 id="mj-sheet-title" className="mj-sheet-what">{job.description}</h2>
        <dl className="mj-facts">
          <div><dt>{tr('Place')}</dt><dd>📍 {job.location || '—'}{job.companyName && job.companyName !== job.location ? ' · ' + job.companyName : ''}</dd></div>
          <div><dt>{tr('Planned for')}</dt><dd className={job.overdue ? 'is-late' : ''}>{job.scheduledOn ? niceDay(job.scheduledOn) + ' · ' + dayWords(job.scheduledOn, today) : tr('No day set')}</dd></div>
          <div><dt>{tr('Asked for by')}</dt><dd>{(job.requestedBy && job.requestedBy.name) || '—'} · {niceDay(job.requestedOn)}</dd></div>
          {job.routineName && <div><dt>{tr('Routine')}</dt><dd>🔁 {job.routineName}</dd></div>}
          {job.completedOn && <div><dt>{tr('Done on')}</dt><dd>✅ {niceDay(job.completedOn)}</dd></div>}
        </dl>
        {job.notes && <p className="mj-notes">{job.notes}</p>}
        {job.photos && job.photos.length > 0 && (
          <section className="mj-sec">
            <h3>{job.routineId ? tr('Photos of the routine') : tr('Photos from when it was added')}</h3>
            <DonePhotoStrip paths={jobReportPhotoPaths(job, client.photoBase)} token={client.token} altFor={(n) => tr('Photo {n}', { n })} />
          </section>
        )}
        {job.donePhotos && job.donePhotos.length > 0 && (
          <section className="mj-sec">
            <h3>{tr('Photos of the finished work')}</h3>
            <DonePhotoStrip paths={jobPhotoPaths(job, client.photoBase)} token={client.token} />
          </section>
        )}

        {step === 'done' && (
          <section className="mj-done">
            <h3>✓ {tr('Finish the job')}</h3>
            <DonePhotoField value={photos} onChange={setPhotos} disabled={busy} />
            <label className="mj-field"><span>{tr('Note (optional)')}</span>
              <textarea className="input" rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr('What was done, parts used…')} />
            </label>
            <label className="mj-field"><span>{tr('What it cost, {currency} (optional)', { currency: job.currency || 'GHS' })}</span>
              <input className="input" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0.00" />
            </label>
            <button type="button" className="mj-big is-done" disabled={busy || !photos.length} onClick={() => move({ status: 'completed', photos, note, actualCost: cost })}>
              {busy ? tr('Sending…') : '✓ ' + tr('Mark as completed')}
            </button>
            <button type="button" className="mj-link" onClick={() => setStep(null)}>{tr('Not yet')}</button>
          </section>
        )}
        {(step === 'hold' || step === 'note') && (
          <section className="mj-done">
            <h3>{step === 'hold' ? '⏸ ' + tr('Put on hold') : '✎ ' + tr('Add a note')}</h3>
            <label className="mj-field"><span>{step === 'hold' ? tr('Why (waiting for a part, the room locked…)') : tr('Note')}</span>
              <textarea className="input" rows={3} maxLength={300} value={note} autoFocus onChange={(e) => setNote(e.target.value)} />
            </label>
            <button type="button" className="mj-big" disabled={busy || !note.trim()} onClick={() => move({ status: step === 'hold' ? 'on_hold' : job.status, note })}>
              {busy ? tr('Sending…') : step === 'hold' ? tr('Put on hold') : tr('Add note')}
            </button>
            <button type="button" className="mj-link" onClick={() => setStep(null)}>{tr('Cancel')}</button>
          </section>
        )}
        {err && <p className="mj-error" role="alert">{err}</p>}

        {!step && open && (
          <div className="mj-acts">
            <button type="button" className="mj-big is-done" disabled={busy} onClick={() => setStep('done')}>✓ {tr('Finished: take the photo')}</button>
            {job.status !== 'in_progress' && <button type="button" className="mj-big is-start" disabled={busy} onClick={() => move({ status: 'in_progress' })}>▶ {job.status === 'on_hold' ? tr('Carry on with it') : tr('Start the job')}</button>}
            <div className="mj-acts-row">
              {job.status !== 'on_hold' && <button type="button" className="mj-small" disabled={busy} onClick={() => setStep('hold')}>⏸ {tr('On hold')}</button>}
              <button type="button" className="mj-small" disabled={busy} onClick={() => setStep('note')}>✎ {tr('Add a note')}</button>
            </div>
          </div>
        )}
        {!step && !open && job.status === 'completed' && (
          <div className="mj-acts"><button type="button" className="mj-small" disabled={busy} onClick={() => setStep('note')}>✎ {tr('Add a note')}</button></div>
        )}
      </div>
    </div>
  );
}

// A routine done early, by hand: photos required, as for a job.
function RoutineDone({ routine, client, busy, onDone, onClose }) {
  const [photos, setPhotos] = useState([]);
  const [note, setNote] = useState('');
  const [err, setErr] = useState(null);
  async function send() {
    setErr(null);
    try { await onDone(routine, { photos, note }); } catch (e) { setErr(e.message); }
  }
  return (
    <div className="mj-sheet" role="dialog" aria-modal="true" aria-labelledby="mj-rt-title">
      <header className="mj-sheet-bar">
        <button type="button" className="mj-back" onClick={onClose} aria-label={tr('Back to my jobs')}>‹ {tr('My jobs')}</button>
        <span className="mj-sheet-ref">{routine.ref}</span>
      </header>
      <div className="mj-sheet-body">
        <h2 id="mj-rt-title" className="mj-sheet-what">🔁 {routine.name}</h2>
        <dl className="mj-facts">
          <div><dt>{tr('Place')}</dt><dd>📍 {routine.location || '—'}</dd></div>
          {routine.everyDays && <div><dt>{tr('Comes round')}</dt><dd>{tr('Every {n} days', { n: routine.everyDays })}{routine.scheduleNote ? ' · ' + routine.scheduleNote : ''}</dd></div>}
        </dl>
        {routine.description && <p className="mj-notes">{routine.description}</p>}
        {routine.photos && routine.photos.length > 0 && (
          <section className="mj-sec">
            <h3>{tr('Photos of the routine')}</h3>
            <DonePhotoStrip paths={routinePhotoPaths(routine, client.routineBase)} token={client.token} altFor={(n) => tr('Photo {n}', { n })} />
          </section>
        )}
        <section className="mj-done">
          <h3>✓ {tr('Done today')}</h3>
          <DonePhotoField value={photos} onChange={setPhotos} disabled={busy} />
          <label className="mj-field"><span>{tr('Note (optional)')}</span>
            <textarea className="input" rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button type="button" className="mj-big is-done" disabled={busy || !photos.length} onClick={send}>{busy ? tr('Sending…') : '✓ ' + tr('Mark as completed')}</button>
          {err && <p className="mj-error" role="alert">{err}</p>}
        </section>
      </div>
    </div>
  );
}

// A row of choices, one picked (kind of job, how urgent, how often).
function Chips({ label, value, options, onChange }) {
  return (
    <div className="mj-field">
      <span>{label}</span>
      <div className="mj-chips" role="radiogroup" aria-label={label}>
        {options.map(([v, text]) => (
          <button key={v} type="button" role="radio" aria-checked={value === v} className={'mj-chip' + (value === v ? ' is-on' : '')} onClick={() => onChange(v)}>{text}</button>
        ))}
      </div>
    </div>
  );
}

function Places({ places }) {
  return <datalist id="mj-places">{(places || []).map((p) => <option key={p} value={p} />)}</datalist>;
}

// Photos with a new job (the problem) or routine (what it looks after), at most.
const MAX_ADD_PHOTOS = 4;

// Adding a job from the phone: one they do themselves (planned for its day,
// today unless changed), or one sent to the managers to give to someone.
function AddJobSheet({ today, places, busy, onSave, onClose }) {
  const [f, setF] = useState({ description: '', location: '', category: 'other', priority: 'medium', scheduledOn: today, notes: '', forMe: true });
  const [photos, setPhotos] = useState([]);
  const [err, setErr] = useState(null);
  const set = (k, v) => setF((o) => ({ ...o, [k]: v }));
  function who(forMe) {
    // A job for the managers has no day unless one is wanted; one for me is today.
    setF((o) => ({ ...o, forMe, scheduledOn: forMe ? (o.scheduledOn || today) : (o.scheduledOn === today ? '' : o.scheduledOn) }));
  }
  async function send(e) {
    e.preventDefault();
    setErr(null);
    if (!f.description.trim()) { setErr(tr('Say what needs doing.')); return; }
    try { await onSave({ ...f, scheduledOn: f.scheduledOn || null, photos }); } catch (x) { setErr(x.message); }
  }
  return (
    <form className="mj-sheet" role="dialog" aria-modal="true" aria-labelledby="mj-add-title" onSubmit={send}>
      <header className="mj-sheet-bar">
        <button type="button" className="mj-back" onClick={onClose} aria-label={tr('Back to my jobs')}>‹ {tr('My jobs')}</button>
        <span className="mj-sheet-ref">{tr('New job')}</span>
      </header>
      <div className="mj-sheet-body">
        <h2 id="mj-add-title" className="mj-sheet-what">🛠️ {tr('Add a job')}</h2>
        <p className="mj-hint">{tr('Something that needs fixing or doing. The work order managers are told.')}</p>
        <div className="mj-form">
          <label className="mj-field"><span>{tr('What needs doing?')}</span>
            <textarea className="input" rows={3} maxLength={2000} value={f.description} onChange={(e) => set('description', e.target.value)} placeholder={tr('e.g. The tap in the canteen is dripping')} autoFocus />
          </label>
          <div className="mj-field">
            <span>{tr('Photos of the problem (optional)')}</span>
            <DonePhotoField value={photos} onChange={setPhotos} disabled={busy} max={MAX_ADD_PHOTOS} camera={false} required={false}
              takeLabel={tr('Add a photo of the problem')} altFor={(n) => tr('Photo {n} of the problem', { n })} />
          </div>
          <label className="mj-field"><span>{tr('Where?')}</span>
            <input className="input" list="mj-places" maxLength={80} value={f.location} onChange={(e) => set('location', e.target.value)} placeholder={tr('e.g. BPL factory, the canteen')} />
          </label>
          <Places places={places} />
          <Chips label={tr('Kind of job')} value={f.category} onChange={(v) => set('category', v)} options={KINDS.map((k) => [k, kindIcon(k) + ' ' + kindName(k)])} />
          <Chips label={tr('How urgent?')} value={f.priority} onChange={(v) => set('priority', v)} options={PRIORITIES.map((p) => [p, priorityName(p)])} />
          <div className="mj-field">
            <span>{tr('Who does it?')}</span>
            <div className="mj-who" role="radiogroup" aria-label={tr('Who does it?')}>
              <button type="button" role="radio" aria-checked={f.forMe} className={'mj-who-opt' + (f.forMe ? ' is-on' : '')} onClick={() => who(true)}>
                <b>🙋 {tr('Me')}</b><small>{tr('It goes on my list')}</small>
              </button>
              <button type="button" role="radio" aria-checked={!f.forMe} className={'mj-who-opt' + (!f.forMe ? ' is-on' : '')} onClick={() => who(false)}>
                <b>📨 {tr('The managers')}</b><small>{tr('They give it to someone')}</small>
              </button>
            </div>
          </div>
          <label className="mj-field"><span>{f.forMe ? tr('Which day?') : tr('Needed by (optional)')}</span>
            <input type="date" className="input" value={f.scheduledOn} min={today} onChange={(e) => set('scheduledOn', e.target.value)} required={f.forMe} />
          </label>
          <label className="mj-field"><span>{tr('Note (optional)')}</span>
            <textarea className="input" rows={2} maxLength={2000} value={f.notes} onChange={(e) => set('notes', e.target.value)} placeholder={tr('Parts needed, who reported it…')} />
          </label>
          {err && <p className="mj-error" role="alert">{err}</p>}
          <button type="submit" className="mj-big is-done" disabled={busy || !f.description.trim()}>
            {busy ? tr('Sending…') : f.forMe ? '＋ ' + tr('Add to my jobs') : '📨 ' + tr('Send to the managers')}
          </button>
          <button type="button" className="mj-link" onClick={onClose}>{tr('Cancel')}</button>
        </div>
      </div>
    </form>
  );
}

const EVERY = [[1, () => tr('Every day')], [7, () => tr('Every week')], [14, () => tr('Every 2 weeks')], [30, () => tr('Every month')], [90, () => tr('Every 3 months')], [365, () => tr('Every year')]];

// A routine of one's own: added from the phone, changed or stopped later.
// Close to each time it becomes a job on their list (backend runDue).
function RoutineForm({ routine, client, today, places, busy, onSave, onStop, onClose }) {
  const [f, setF] = useState(() => ({
    name: routine ? routine.name : '', location: routine ? routine.location || '' : '', category: routine ? routine.category || 'other' : 'other',
    everyDays: routine && routine.everyDays ? String(routine.everyDays) : '7', nextOn: routine ? routine.nextOn || today : today,
    scheduleNote: routine ? routine.scheduleNote || '' : '', description: routine ? routine.description || '' : ''
  }));
  const [err, setErr] = useState(null);
  const [photos, setPhotos] = useState([]);
  const [drop, setDrop] = useState([]); // its photos taken out (their numbers)
  const set = (k, v) => setF((o) => ({ ...o, [k]: v }));
  const every = Number(f.everyDays);
  const had = routine ? (routine.photos || []).filter((p) => !drop.includes(p.n)) : [];
  const everyOk = Number.isInteger(every) && every >= 1 && every <= 3660;
  async function send(e) {
    e.preventDefault();
    setErr(null);
    if (!f.name.trim()) { setErr(tr('Say what is done each time.')); return; }
    if (!everyOk) { setErr(tr('Say every how many days it comes round: a whole number from 1 to 3660.')); return; }
    const body = { ...f, everyDays: every, photos };
    if (drop.length) body.dropPhotos = drop;
    // A late routine keeps its day unless it is changed.
    if (routine && f.nextOn === routine.nextOn) delete body.nextOn;
    else if (f.nextOn < today) { setErr(tr('The next time must be today or later.')); return; }
    try { await onSave(routine, body); } catch (x) { setErr(x.message); }
  }
  async function stop() {
    if (!window.confirm(tr('Stop {name}? It will not come round again.', { name: routine.name }))) return;
    setErr(null);
    try { await onStop(routine); } catch (x) { setErr(x.message); }
  }
  const quick = EVERY.some(([n]) => n === every);
  return (
    <form className="mj-sheet" role="dialog" aria-modal="true" aria-labelledby="mj-rf-title" onSubmit={send}>
      <header className="mj-sheet-bar">
        <button type="button" className="mj-back" onClick={onClose} aria-label={tr('Back to my jobs')}>‹ {tr('My jobs')}</button>
        <span className="mj-sheet-ref">{routine ? routine.ref : tr('New routine')}</span>
      </header>
      <div className="mj-sheet-body">
        <h2 id="mj-rf-title" className="mj-sheet-what">🔁 {routine ? tr('Change the routine') : tr('Add a routine')}</h2>
        <p className="mj-hint">{tr('Work that comes round again and again, like servicing the generator. Close to each time it becomes a job on your list, and you get a notification.')}</p>
        <div className="mj-form">
          <label className="mj-field"><span>{tr('What is done each time?')}</span>
            <input className="input" maxLength={120} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder={tr('e.g. Service the generator')} autoFocus={!routine} />
          </label>
          <label className="mj-field"><span>{tr('Where?')}</span>
            <input className="input" list="mj-places" maxLength={80} value={f.location} onChange={(e) => set('location', e.target.value)} placeholder={tr('e.g. BPL factory, the canteen')} />
          </label>
          <Places places={places} />
          <Chips label={tr('Kind of job')} value={f.category} onChange={(v) => set('category', v)} options={KINDS.map((k) => [k, kindIcon(k) + ' ' + kindName(k)])} />
          <Chips label={tr('How often?')} value={quick ? every : 'other'} onChange={(v) => set('everyDays', v === 'other' ? (quick ? '' : f.everyDays) : String(v))}
            options={EVERY.map(([n, t]) => [n, t()]).concat([['other', tr('Other…')]])} />
          {!quick && (
            <label className="mj-field mj-every"><span>{tr('Every how many days?')}</span>
              <input className="input" type="number" inputMode="numeric" min={1} max={3660} step={1} value={f.everyDays} onChange={(e) => set('everyDays', e.target.value)} placeholder="45" />
            </label>
          )}
          <label className="mj-field"><span>{routine ? tr('Next time on') : tr('First time on')}</span>
            <input type="date" className="input" value={f.nextOn} min={today} onChange={(e) => set('nextOn', e.target.value)} required />
          </label>
          <label className="mj-field"><span>{tr('What time of day? (optional)')}</span>
            <input className="input" maxLength={80} value={f.scheduleNote} onChange={(e) => set('scheduleNote', e.target.value)} placeholder={tr('e.g. Saturday morning, before work starts')} />
          </label>
          <div className="mj-field">
            <span>{tr('Photos (optional)')} <small>· {tr('the machine, the place, what to check')}</small></span>
            {had.length > 0 && (
              <DonePhotoStrip paths={routinePhotoPaths({ id: routine.id, photos: had }, client.routineBase)} token={client.token}
                altFor={(n) => tr('Photo {n}', { n })} onRemove={(i) => setDrop((d) => d.concat(had[i].n))} />
            )}
            <DonePhotoField value={photos} onChange={setPhotos} disabled={busy} max={Math.max(0, MAX_ADD_PHOTOS - had.length)} camera={false} required={false}
              takeLabel={tr('Add a photo')} altFor={(n) => tr('Photo {n}', { n })} />
          </div>
          <label className="mj-field"><span>{tr('How it is done (optional)')}</span>
            <textarea className="input" rows={3} maxLength={1000} value={f.description} onChange={(e) => set('description', e.target.value)} placeholder={tr('Steps, parts, what to check…')} />
          </label>
          {err && <p className="mj-error" role="alert">{err}</p>}
          <button type="submit" className="mj-big is-done" disabled={busy || !f.name.trim() || !everyOk}>
            {busy ? tr('Sending…') : routine ? '✓ ' + tr('Save the routine') : '＋ ' + tr('Add the routine')}
          </button>
          {routine && <button type="button" className="mj-small is-stop" disabled={busy} onClick={stop}>⏹ {tr('Stop this routine')}</button>}
          <button type="button" className="mj-link" onClick={onClose}>{tr('Cancel')}</button>
        </div>
      </div>
    </form>
  );
}

function InstallHint({ team }) {
  const [prompt, setPrompt] = useState(null);
  const [hidden, setHidden] = useState(() => { try { return isInstalled() || localStorage.getItem('bos.myjobs.installHint') === 'off'; } catch { return isInstalled(); } });
  useEffect(() => {
    const keep = (e) => { e.preventDefault(); setPrompt(e); };
    window.addEventListener('beforeinstallprompt', keep);
    return () => window.removeEventListener('beforeinstallprompt', keep);
  }, []);
  if (hidden) return null;
  const hide = () => { setHidden(true); try { localStorage.setItem('bos.myjobs.installHint', 'off'); } catch { /* shown again next time */ } };
  return (
    <div className="mj-install">
      <span className="mj-install-ico" aria-hidden="true">📲</span>
      <div>
        <strong>{tr('Put My Jobs on your home screen')}</strong>
        <small>{prompt ? tr('It opens like an app, straight to your jobs.')
          : isIos() ? (team ? tr('In Safari: tap Share ⬆, then Add to Home Screen. The first time you open it from there, enter the team code {code} again.', { code: shownTeam(team) }) : tr('In Safari: tap Share ⬆, then Add to Home Screen.'))
            : tr('In Chrome: tap ⋮, then Install app or Add to Home screen.')}</small>
      </div>
      {prompt && <button type="button" className="mj-small is-on" onClick={async () => { prompt.prompt(); try { await prompt.userChoice; } catch { /* closed */ } setPrompt(null); hide(); }}>{tr('Install')}</button>}
      <button type="button" className="mj-x" onClick={hide} aria-label={tr('Hide this')}>×</button>
    </div>
  );
}

function Jobs({ client, onSignOut }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('todo');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [routineOpen, setRoutineOpen] = useState(null);
  const [form, setForm] = useState(null); // { kind: 'job' } | { kind: 'routine', routine: null | one of mine }
  const [extraJob, setExtraJob] = useState(null); // a job not on my list (opened from a link)
  const jobId = new URLSearchParams(location.search).get('job');

  const load = useCallback(() => client.mine().then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message)), [client]);
  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    const back = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', back);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', back); };
  }, [load]);
  // A tap on a notification while the app is open (public/sw.js).
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined;
    const onMsg = (e) => {
      const d = e.data;
      if (!d || d.type !== 'bamboo-open' || typeof d.path !== 'string') return;
      if (d.path.indexOf('/myjobs') === 0) { navigate(d.path); load(); } else window.location.assign(d.path);
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, [navigate, load]);

  const all = useMemo(() => (data ? data.todo.concat(data.done) : []), [data]);
  const listed = jobId ? all.find((j) => j.id === jobId) : null;
  useEffect(() => {
    if (!jobId || !data || listed) { setExtraJob(null); return; }
    client.job(jobId).then(setExtraJob).catch(() => setExtraJob(null));
  }, [jobId, data, listed, client]);
  const job = listed || (extraJob && extraJob.id === jobId ? extraJob : null);

  const openJob = (j) => navigate('/myjobs?job=' + j.id);
  const closeJob = () => navigate('/myjobs');
  function say(text) { setToast(text); setTimeout(() => setToast(null), 3500); }

  async function move(j, body) {
    setBusy(true);
    try {
      const out = await client.move(j.id, body);
      await load();
      if (extraJob && extraJob.id === j.id) setExtraJob(out);
      if (body.status === 'completed' && j.status !== 'completed') { say(tr('{ref} done. Well done!', { ref: j.ref })); closeJob(); }
      else if (body.status === 'in_progress') say(tr('{ref} started.', { ref: j.ref }));
      else if (body.status === 'on_hold') say(tr('{ref} is on hold.', { ref: j.ref }));
      else say(tr('Note added.'));
    } finally { setBusy(false); }
  }
  async function routineDone(r, body) {
    setBusy(true);
    try {
      await client.routineDone(r.id, body);
      await load();
      setRoutineOpen(null);
      say(tr('{name} done. Next time moved on.', { name: r.name }));
    } finally { setBusy(false); }
  }

  async function addJob(body) {
    setBusy(true);
    try {
      const out = await client.addJob(body);
      await load();
      setForm(null);
      if (body.forMe) { setTab('todo'); say(tr('{ref} is on your list.', { ref: out.ref })); } else say(tr('{ref} sent to the managers.', { ref: out.ref }));
    } finally { setBusy(false); }
  }
  async function saveRoutine(r, body) {
    setBusy(true);
    try {
      const out = r ? await client.saveRoutine(r.id, body) : await client.addRoutine(body);
      await load();
      setForm(null);
      setTab('routines');
      say(r ? tr('{name} saved.', { name: out.name }) : tr('{name} added to your routines.', { name: out.name }));
    } finally { setBusy(false); }
  }
  async function stopRoutine(r) {
    setBusy(true);
    try {
      await client.stopRoutine(r.id);
      await load();
      setForm(null);
      say(tr('{name} stopped.', { name: r.name }));
    } finally { setBusy(false); }
  }

  const today = data ? data.today : new Date().toISOString().slice(0, 10);
  const dayOf = (o) => o.scheduledOn || o.requestedOn || today;
  const late = data ? data.todo.filter((o) => o.overdue) : [];
  const now = data ? data.todo.filter((o) => !o.overdue && dayOf(o) <= today) : [];
  const later = data ? data.todo.filter((o) => !o.overdue && dayOf(o) > today) : [];
  const first = (data && data.me.name ? data.me.name : '').split(' ')[0];

  if (job) return <JobSheet key={job.id + job.status + (job.notes || '').length} job={job} today={today} busy={busy} client={client} onMove={move} onClose={closeJob} />;
  if (routineOpen) return <RoutineDone routine={routineOpen} client={client} busy={busy} onDone={routineDone} onClose={() => setRoutineOpen(null)} />;
  const places = data && data.options ? data.options.places : [];
  if (form && form.kind === 'job') return <AddJobSheet today={today} places={places} busy={busy} onSave={addJob} onClose={() => setForm(null)} />;
  if (form && form.kind === 'routine') return <RoutineForm routine={form.routine} client={client} today={today} places={places} busy={busy} onSave={saveRoutine} onStop={stopRoutine} onClose={() => setForm(null)} />;

  const group = (title, list, tone) => list.length > 0 && (
    <section className={'mj-group' + (tone ? ' is-' + tone : '')}>
      <h2>{title} <small>{list.length}</small></h2>
      <ul className="mj-list">{list.map((o) => <JobCard key={o.id} job={o} today={today} onOpen={openJob} />)}</ul>
    </section>
  );

  return (
    <div className="mj-page">
      <header className="mj-bar">
        <span className="mj-brand"><img src="/icon-192.png" alt="" width="28" height="28" /> {tr('My Jobs')}</span>
        <button type="button" className="mj-icon-btn" onClick={load} aria-label={tr('Refresh')} title={tr('Refresh')}>⟳</button>
        <button type="button" className="mj-icon-btn is-text" onClick={() => { if (window.confirm(tr('Sign out of My Jobs?'))) onSignOut(); }}>{tr('Sign out')}</button>
      </header>
      <main className="mj-main">
        <div className="mj-hello">
          <h1>{hello()}{first ? ', ' + first : ''}</h1>
          <p>{new Date().toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        </div>
        <InstallHint team={client.team} />
        {error && <p className="mj-error" role="alert">{error} <button type="button" className="mj-link" onClick={load}>{tr('Try again')}</button></p>}
        {!data && !error && <p className="mj-muted">{tr('Loading your jobs…')}</p>}
        {data && (
          <>
            <div className="mj-counts" role="list">
              <span role="listitem" className={'mj-count is-late' + (data.counts.late ? '' : ' is-zero')}><b>{data.counts.late}</b>{tr('Late')}</span>
              <span role="listitem" className={'mj-count' + (data.counts.today ? '' : ' is-zero')}><b>{data.counts.today}</b>{tr('Today')}</span>
              <span role="listitem" className={'mj-count' + (data.counts.later ? '' : ' is-zero')}><b>{data.counts.later}</b>{tr('Coming up')}</span>
              <span role="listitem" className={'mj-count is-done' + (data.counts.doneThisWeek ? '' : ' is-zero')}><b>{data.counts.doneThisWeek}</b>{tr('Done this week')}</span>
            </div>
            <section className="mj-add" aria-label={tr('Add work')}>
              <button type="button" className="mj-add-btn" onClick={() => setForm({ kind: 'job' })}>
                <span className="mj-add-ico" aria-hidden="true">＋</span>
                <span><b>{tr('Add a job')}</b><small>{tr('Something that needs fixing')}</small></span>
              </button>
              <button type="button" className="mj-add-btn" onClick={() => setForm({ kind: 'routine', routine: null })}>
                <span className="mj-add-ico" aria-hidden="true">🔁</span>
                <span><b>{tr('Add a routine')}</b><small>{tr('Work that comes round again')}</small></span>
              </button>
            </section>
            <nav className="mj-tabs" role="tablist">
              {[['todo', tr('To do'), data.todo.length], ['routines', tr('Routines'), data.routines.length], ['done', tr('Done'), data.done.length]].map(([k, label, n]) => (
                <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-on' : ''} onClick={() => setTab(k)}>{label} <small>{n}</small></button>
              ))}
            </nav>
            {tab === 'todo' && (
              data.todo.length ? <>
                {group('⚠️ ' + tr('Late'), late, 'late')}
                {group(tr('Today'), now)}
                {group(tr('Coming up'), later)}
              </> : <p className="mj-empty">🎉 {tr('Nothing to do right now. New jobs given to you show up here, and you get a notification.')}</p>
            )}
            {tab === 'routines' && (
              data.routines.length ? (
                <ul className="mj-list">
                  {data.routines.map((r) => {
                    const openJobOf = r.openOrderId ? all.find((o) => o.id === r.openOrderId) : null;
                    return (
                      <li key={r.id} className={'mj-routine' + (r.late ? ' is-late' : '')}>
                        <span className="mj-card-ico" aria-hidden="true">{kindIcon(r.category)}</span>
                        <span className="mj-card-main">
                          <span className="mj-card-top"><b>{r.ref}</b>{r.everyDays && <span className="mj-tag">{tr('Every {n} days', { n: r.everyDays })}</span>}{r.addedByMe && <span className="mj-tag is-mine">{tr('Added by you')}</span>}{r.photos && r.photos.length > 0 && <span className="mj-tag">📷 {r.photos.length}</span>}</span>
                          <span className="mj-card-what">{r.name}</span>
                          <span className="mj-card-meta">
                            {r.location && <span>📍 {r.location}</span>}
                            {r.nextOn ? <span className={r.late ? 'is-late' : ''}>📅 {tr('Next')}: {niceDay(r.nextOn)} · {dayWords(r.nextOn, today)}</span> : <span>{tr('No next day set')}</span>}
                          </span>
                          <span className="mj-routine-acts">
                            {r.openOrderId
                              ? <button type="button" className="mj-small is-on" onClick={() => (openJobOf ? openJob(openJobOf) : navigate('/myjobs?job=' + r.openOrderId))}>{tr('It is a work order now: open it')}</button>
                              : <button type="button" className="mj-small" onClick={() => setRoutineOpen(r)}>✓ {tr('Done it early')}</button>}
                            {r.addedByMe && <button type="button" className="mj-small" onClick={() => setForm({ kind: 'routine', routine: r })}>✎ {tr('Change')}</button>}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : <p className="mj-empty">{tr('No routines are given to you. Add your own with “Add a routine” above.')}</p>
            )}
            {tab === 'done' && (
              data.done.length ? <ul className="mj-list">{data.done.map((o) => <JobCard key={o.id} job={o} today={today} onOpen={openJob} />)}</ul>
                : <p className="mj-empty">{tr('Jobs you finish this week show here, with their photos.')}</p>
            )}
          </>
        )}
        <p className="mj-foot"><a href="/dashboard">{tr('Open the full Bamboo OS')}</a></p>
      </main>
      {toast && <div className="mj-toast" role="status">✅ {toast}</div>}
    </div>
  );
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'back'];

// Signing in with the kiosk code: the team code first on a new phone (or
// from the team's link), then the 4 digits, sent as soon as the 4th is in.
function KioskSignIn({ notice, onSignedIn, onEmail }) {
  const [team, setTeam] = useState(() => readStore(TEAM_KEY) || '');
  const [step, setStep] = useState(() => (normTeam(readStore(TEAM_KEY)).length === 8 ? 'pin' : 'team'));
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  async function checkTeam(e) {
    e.preventDefault();
    setErr(null);
    if (normTeam(team).length !== 8) { setErr(tr('The team code has 8 letters and numbers.')); return; }
    setBusy(true);
    try { await myJobsCall('POST', '/team', { team: normTeam(team) }); writeStore(TEAM_KEY, normTeam(team)); setStep('pin'); } catch (x) { setErr(x.message); }
    setBusy(false);
  }
  async function signIn(code) {
    setBusy(true);
    setErr(null);
    try {
      const r = await myJobsCall('POST', '/sign-in', { team: normTeam(team), pin: code });
      const s = { token: r.token, team: normTeam(team) };
      writeStore(SIGN_IN_KEY, JSON.stringify(s));
      onSignedIn(s);
    } catch (x) {
      setPin('');
      setErr(x.message);
      // The team code changed: type the new one.
      if (x.status === 400 && /team code/i.test(x.message)) { writeStore(TEAM_KEY, null); setStep('team'); }
    }
    setBusy(false);
  }
  function press(k) {
    if (busy) return;
    if (k === 'back') { setPin((p) => p.slice(0, -1)); return; }
    if (!k || pin.length >= 4) return;
    const next = pin + k;
    setPin(next);
    if (next.length === 4) signIn(next);
  }
  return (
    <div className="mj-page mj-signin">
      <header className="mj-bar"><span className="mj-brand"><img src="/icon-192.png" alt="" width="28" height="28" /> {tr('My Jobs')}</span></header>
      <main className="mj-main">
        {notice && <p className="mj-notice" role="status">{notice}</p>}
        {step === 'team' ? (
          <form className="mj-signin-box" onSubmit={checkTeam}>
            <h1>{tr('Enter your team code')}</h1>
            <p>{tr('Your manager has it: 8 letters and numbers, like ABCD-2345. You type it once on this phone.')}</p>
            <input className="input mj-team-input" value={shownTeam(team)} onChange={(e) => setTeam(normTeam(e.target.value))} autoCapitalize="characters" autoComplete="off" autoCorrect="off" spellCheck={false}
              inputMode="text" maxLength={9} placeholder="ABCD-2345" aria-label={tr('Team code')} autoFocus />
            {err && <p className="mj-error" role="alert">{err}</p>}
            <button type="submit" className="mj-big is-done" disabled={busy || normTeam(team).length !== 8}>{busy ? tr('Checking…') : tr('Next')}</button>
          </form>
        ) : (
          <div className="mj-signin-box">
            <h1>{tr('Enter your kiosk code')}</h1>
            <p>{tr('The 4-digit code you clock in with.')}</p>
            <div className={'mj-dots' + (err ? ' is-wrong' : '')} aria-label={tr('{n} of 4 digits', { n: pin.length })} role="status">
              {[0, 1, 2, 3].map((i) => <span key={i} className={i < pin.length ? 'is-on' : ''} />)}
            </div>
            {err && <p className="mj-error" role="alert">{err}</p>}
            {busy && <p className="mj-muted">{tr('Signing in…')}</p>}
            <div className="mj-keypad">
              {KEYS.map((k, i) => k === '' ? <span key={i} /> : (
                <button key={i} type="button" className={k === 'back' ? 'is-back' : ''} disabled={busy} onClick={() => press(k)} aria-label={k === 'back' ? tr('Delete the last digit') : k}>
                  {k === 'back' ? '⌫' : k}
                </button>
              ))}
            </div>
            <button type="button" className="mj-link" onClick={() => { setStep('team'); setErr(null); setPin(''); }}>{tr('Team code: {code} · change it', { code: shownTeam(team) })}</button>
          </div>
        )}
        <p className="mj-foot"><button type="button" className="mj-link" onClick={onEmail}>{tr('Sign in with your Bamboo OS email and password instead')}</button></p>
      </main>
    </div>
  );
}

function readSignIn() {
  try { const s = JSON.parse(readStore(SIGN_IN_KEY)); return s && /^[0-9a-f]{64}$/.test(s.token) ? s : null; } catch { return null; }
}

export default function MyJobsPage() {
  const { session, loading, reconnecting, logout } = useAuth();
  const [kiosk, setKiosk] = useState(() => { takeTeamFromLink(); return readSignIn(); });
  const [useEmail, setUseEmail] = useState(false);
  const [notice, setNotice] = useState(null);
  useEffect(() => {
    const before = document.title;
    document.title = tr('My Jobs · Bamboo OS');
    return () => { document.title = before; };
  }, []);
  const ended = useCallback(() => { writeStore(SIGN_IN_KEY, null); setKiosk(null); setNotice(tr('Signed out. Sign in again with your kiosk code.')); }, []);
  const client = useMemo(() => (session ? osClient() : kiosk ? pinClient(kiosk.token, kiosk.team, ended) : null), [session, kiosk, ended]);
  async function signOutKiosk() {
    try { await myJobsCall('POST', '/sign-out', {}, kiosk.token); } catch { /* signed out here anyway */ }
    writeStore(SIGN_IN_KEY, null);
    setKiosk(null);
    setNotice(null);
  }

  if (loading) return <div className="mj-wait">{reconnecting ? tr('Reaching the server…') : tr('Loading…')}</div>;
  // Signed in right here: an installed app leaving its own address to sign in
  // would open a browser instead (iPhone).
  if (session) {
    if (session.mustChangePassword) return <ForcedPasswordChangePage />;
    return <Jobs client={client} onSignOut={() => logout()} />;
  }
  if (kiosk) return <Jobs client={client} onSignOut={signOutKiosk} />;
  if (useEmail) {
    return (
      <div className="mj-email">
        <LoginPage home="/myjobs" />
        <button type="button" className="mj-switch" onClick={() => setUseEmail(false)}>🔢 {tr('Use my kiosk code instead')}</button>
      </div>
    );
  }
  return <KioskSignIn notice={notice} onSignedIn={(s) => { setNotice(null); setKiosk(s); }} onEmail={() => setUseEmail(true)} />;
}
