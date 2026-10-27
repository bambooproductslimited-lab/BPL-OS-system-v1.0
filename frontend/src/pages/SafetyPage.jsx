import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { api, API_URL } from '../api/client';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import { shrinkPhoto } from './till/photoShrink';
import './seventeenth.css';
import './eighteenth.css';

// Health and safety (People → Health and safety; backend safety.service.js,
// migration 0199): incidents and near misses reported by anyone, from My
// space too, with photos; the investigation, the actions with an owner and a
// day, closed once they are done. Each company's days since its last
// lost-time injury; the year by month.

function dayText(d, opts) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC', ...opts }) : '—'; }
function when(t) { return t ? new Date(t).toLocaleString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; }
function monthText(m) { return new Date(m + '-15T12:00:00Z').toLocaleDateString(activeIntlLocale(), { month: 'short', timeZone: 'UTC' }); }
function localNow() { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }
function today() { return new Date().toISOString().slice(0, 10); }
const KIND = {
  injury: ['🤕', msg('Injury')], near_miss: ['🟡', msg('Near miss')], property_damage: ['💥', msg('Damage')], fire: ['🔥', msg('Fire')], food_safety: ['🍽️', msg('Food safety')],
  vehicle: ['🚚', msg('Vehicle')], environment: ['🌿', msg('Spill or environment')], security: ['🔒', msg('Security')], other: ['📝', msg('Something else')]
};
const SEVERITY = { low: ['is-good', msg('Low')], medium: ['is-warn', msg('Medium')], high: ['is-bad', msg('High')], critical: ['is-bad', msg('Critical')] };
const TREATMENT = { none: msg('No treatment'), first_aid: msg('First aid'), clinic: msg('Clinic'), hospital: msg('Hospital') };
const STATUS = { new: ['🆕', 'is-calm', msg('New')], investigating: ['🔍', 'is-warn', msg('Investigating')], closed: ['✅', 'is-good', msg('Closed')] };
const COLORS = { injury: 'var(--x7-bad)', nearMiss: 'var(--x7-warn)', other: 'var(--x7-calm)' };

function Photo({ id, n }) {
  const [url, setUrl] = useState(null);
  const [big, setBig] = useState(false);
  useEffect(() => {
    let made = null, live = true;
    fetch(API_URL + '/safety/' + id + '/photos/' + n, { headers: api.authHeaders() }).then((r) => (r.ok ? r.blob() : null)).then((b) => { if (b && live) { made = URL.createObjectURL(b); setUrl(made); } }).catch(() => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [id, n]);
  if (!url) return <span className="hs-photo" aria-hidden="true" />;
  return (
    <>
      <button type="button" className="hs-photo" onClick={() => setBig(true)} aria-label={tr('See the photo')}><img src={url} alt="" /></button>
      {big && createPortal(<div className="x7-zoom" onClick={() => setBig(false)} role="dialog" aria-label={tr('Photo')}><img src={url} alt={tr('Photo')} /></div>, document.body)}
    </>
  );
}

// Reporting: from this page or from My space.
export function ReportDialog({ companies, company, onClose, onDone }) {
  const [f, setF] = useState({ kind: '', occurredAt: localNow(), location: '', description: '', companyId: company || '', hurt: false, injuredName: '', injury: '', treatment: 'none', photos: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function pick(e) {
    const files = Array.from(e.target.files || []).slice(0, 4 - f.photos.length);
    e.target.value = '';
    try { const shots = []; for (const file of files) shots.push(await shrinkPhoto(file)); setF((x) => ({ ...x, photos: [...x.photos, ...shots].slice(0, 4) })); } catch { setError(tr('That file is not a photo.')); }
  }
  async function save(e) {
    e.preventDefault();
    if (!f.kind) { setError(tr('What happened: an injury, a near miss, damage…?')); return; }
    setBusy(true); setError(null);
    try {
      onDone(await api.post('/safety', { kind: f.kind, occurredAt: new Date(f.occurredAt).toISOString(), location: f.location, description: f.description, companyId: f.companyId || null,
        injuredName: f.hurt ? f.injuredName : '', injury: f.hurt ? f.injury : '', treatment: f.hurt ? f.treatment : 'none', photos: f.photos }));
    } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" style={{ width: 'min(680px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="hs-r-t" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">⛑️</span><div><h2 id="hs-r-t">{tr('Report an incident or a near miss')}</h2><p>{tr('A near miss is worth reporting too: it is how the next accident is stopped.')}</p></div></div>
        <div className="x7-chips" role="group" aria-label={tr('What happened')}>{Object.entries(KIND).map(([k, [ic, l]]) => <button key={k} type="button" className={f.kind === k ? 'is-on' : ''} onClick={() => setF({ ...f, kind: k, hurt: k === 'injury' ? true : f.hurt })}><em aria-hidden="true">{ic}</em>{tr(l)}</button>)}</div>
        <div className="x7-grid2">
          <label><span>{tr('When')}</span><input className="input" type="datetime-local" required value={f.occurredAt} max={localNow()} onChange={(e) => setF({ ...f, occurredAt: e.target.value })} /></label>
          <label><span>{tr('Where')}</span><input className="input" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder={tr('e.g. By the planer, workshop')} /></label>
        </div>
        {companies && companies.length > 1 && <label><span>{tr('Company')}</span><select className="input" value={f.companyId} onChange={(e) => setF({ ...f, companyId: e.target.value })}><option value="">—</option>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
        <label><span>{tr('What happened?')}</span><textarea className="input" rows={3} required value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
        <label className="x7-check"><input type="checkbox" checked={f.hurt} onChange={(e) => setF({ ...f, hurt: e.target.checked })} /><span>{tr('Someone was hurt')}</span></label>
        {f.hurt && (
          <div className="x7-grid2">
            <label><span>{tr('Who?')}</span><input className="input" value={f.injuredName} onChange={(e) => setF({ ...f, injuredName: e.target.value })} /></label>
            <label><span>{tr('The injury')}</span><input className="input" value={f.injury} onChange={(e) => setF({ ...f, injury: e.target.value })} placeholder={tr('e.g. Cut on the left hand')} /></label>
            <label style={{ gridColumn: '1 / -1' }}><span>{tr('Treatment')}</span><span className="x7-seg" style={{ alignSelf: 'flex-start' }}>{Object.entries(TREATMENT).map(([k, l]) => <button key={k} type="button" className={f.treatment === k ? 'is-on' : ''} onClick={() => setF({ ...f, treatment: k })}>{tr(l)}</button>)}</span></label>
          </div>
        )}
        <label className={'x7-drop' + (f.photos.length ? ' is-set' : '')}><input type="file" accept="image/*" capture="environment" multiple onChange={pick} /><em aria-hidden="true">{f.photos.length ? '✅' : '📸'}</em><span>{f.photos.length ? tr('{n} of 4 photos — tap to add', { n: f.photos.length }) : tr('Photos of the place, the damage (up to 4)')}</span></label>
        {f.photos.length > 0 && <div className="hs-photos">{f.photos.map((p, i) => <button key={i} type="button" className="hs-photo" onClick={() => setF({ ...f, photos: f.photos.filter((_, j) => j !== i) })} aria-label={tr('Remove')}><img src={p} alt="" /></button>)}</div>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? tr('Sending…') : tr('Send the report')}</button></div>
      </form>
    </div>
  );
}

function IncidentSheet({ id, people, onClose, onChanged }) {
  const [i, setI] = useState(null);
  const [f, setF] = useState(null);
  const [act, setAct] = useState({ title: '', ownerId: '', dueOn: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const take = (x) => { setI(x); setF({ severity: x.severity, investigatorId: x.investigator ? x.investigator.id : '', lostDays: String(x.lostDays || 0), treatment: x.treatment, rootCause: x.rootCause, immediateAction: x.immediateAction }); };
  useEffect(() => { api.get('/safety/' + id).then(take).catch((e) => setError(e.message)); }, [id]);
  async function run(fn) {
    setBusy(true); setError(null);
    try { const x = await fn(); if (x && x.id) take(x); onChanged(); return true; } catch (e) { setError(e.message); return false; } finally { setBusy(false); }
  }
  if (!i) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const open = i.status !== 'closed';
  const hot = i.severity === 'high' || i.severity === 'critical' || i.lostTime;
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet is-wide" role="dialog" aria-modal="true" aria-labelledby="hs-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={hot ? { '--g1': '#b91c1c', '--g2': '#c2410c' } : i.kind === 'near_miss' ? { '--g1': '#b45309', '--g2': '#a16207' } : { '--g1': '#1d4ed8', '--g2': '#0f766e' }}>
          <span className="x7-icon" aria-hidden="true">{KIND[i.kind][0]}</span>
          <div><small>{i.ref} · {when(i.occurredAt)}{i.location ? ' · ' + i.location : ''}</small><h2 id="hs-t">{tr(KIND[i.kind][1])}{i.company ? ' — ' + i.company : ''}</h2>
            <p><span className="x7-pill">{STATUS[i.status][0]} {tr(STATUS[i.status][2])}</span><span className="x7-pill">{tr('Severity')}: {tr(SEVERITY[i.severity][1])}</span>{i.lostTime && <span className="x7-pill">⏱️ {tr('Lost time: {n} days', { n: i.lostDays })}</span>}</p></div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        <p className="x7-note">📝 {i.description}</p>
        <dl className="x7-facts">
          <div><dt>{tr('Reported by')}</dt><dd>{i.reportedBy ? i.reportedBy.name : '—'}</dd></div>
          <div><dt>{tr('Hurt')}</dt><dd>{i.injured ? i.injured.name + (i.injury ? ' · ' + i.injury : '') : tr('No one')}</dd></div>
          <div><dt>{tr('Treatment')}</dt><dd>{tr(TREATMENT[i.treatment])}</dd></div>
          <div><dt>{tr('Investigator')}</dt><dd>{i.investigator ? i.investigator.name : '—'}</dd></div>
        </dl>
        {i.photos > 0 && <div className="hs-photos">{Array.from({ length: i.photos }, (_, n) => <Photo key={n} id={i.id} n={n} />)}</div>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {i.canManage && open && f && (
          <form className="x7-form" onSubmit={(e) => { e.preventDefault(); run(() => api.put('/safety/' + i.id, { ...f, investigatorId: f.investigatorId || null })); }}>
            <h3>🔍 {tr('Investigation')}</h3>
            <div className="x7-chips" role="group" aria-label={tr('Severity')}>{Object.entries(SEVERITY).map(([k, [, l]]) => <button key={k} type="button" className={f.severity === k ? 'is-on' : ''} onClick={() => setF({ ...f, severity: k })}>{tr(l)}</button>)}</div>
            <div className="x7-grid3">
              <label><span>{tr('Investigator')}</span><select className="input" value={f.investigatorId} onChange={(e) => setF({ ...f, investigatorId: e.target.value })}><option value="">—</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              <label><span>{tr('Treatment')}</span><select className="input" value={f.treatment} onChange={(e) => setF({ ...f, treatment: e.target.value })}>{Object.entries(TREATMENT).map(([k, l]) => <option key={k} value={k}>{tr(l)}</option>)}</select></label>
              <label><span>{tr('Days off work')}</span><input className="input" type="number" min="0" value={f.lostDays} onChange={(e) => setF({ ...f, lostDays: e.target.value })} /></label>
            </div>
            <label><span>{tr('What was done at once')}</span><input className="input" value={f.immediateAction} onChange={(e) => setF({ ...f, immediateAction: e.target.value })} /></label>
            <label><span>{tr('The cause: what let it happen?')}</span><textarea className="input" rows={2} value={f.rootCause} onChange={(e) => setF({ ...f, rootCause: e.target.value })} /></label>
            <div className="dialog-actions"><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save')}</button></div>
          </form>
        )}
        {!open && (i.rootCause || i.immediateAction) && <dl className="x7-facts">{i.immediateAction && <div><dt>{tr('What was done at once')}</dt><dd>{i.immediateAction}</dd></div>}{i.rootCause && <div><dt>{tr('The cause')}</dt><dd>{i.rootCause}</dd></div>}</dl>}
        <div className="x7-sec">
          <h3>🛠️ {tr('Actions')} <span className="x7-muted">{i.actionList.filter((a) => a.done).length}/{i.actionList.length}</span></h3>
          <div className="x7-list">{i.actionList.map((a) => (
            <div key={a.id} className={'ob-step' + (a.done ? ' is-done' : '') + (a.late ? ' is-late' : '')}>
              <button type="button" className="ob-tick" disabled={busy || !open || (!i.canManage && !a.mine)} aria-pressed={a.done} onClick={() => run(() => api.post('/safety/actions/' + a.id, { done: !a.done }))}>{a.done ? '✓' : ''}</button>
              <span className="x7-who"><b>{a.title}</b><small>{a.owner ? a.owner.name : '—'} · {a.done ? tr('done {date}', { date: dayText(a.doneAt) }) : (a.late ? '⏰ ' : '') + tr('by {date}', { date: dayText(a.dueOn) })}</small></span>
            </div>
          ))}</div>
          {!i.actionList.length && <p className="x7-muted">{tr('No action yet.')}</p>}
          {i.canManage && open && (
            <form className="hs-add" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.post('/safety/' + i.id + '/actions', act))) setAct({ title: '', ownerId: '', dueOn: '' }); }}>
              <input className="input" required value={act.title} onChange={(e) => setAct({ ...act, title: e.target.value })} placeholder={tr('e.g. Fit a guard on the saw')} aria-label={tr('Action')} />
              <select className="input" required value={act.ownerId} onChange={(e) => setAct({ ...act, ownerId: e.target.value })} aria-label={tr('Who does it')}><option value="">{tr('Who?')}</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
              <input className="input" type="date" required min={today()} value={act.dueOn} onChange={(e) => setAct({ ...act, dueOn: e.target.value })} aria-label={tr('By when')} />
              <button type="submit" className="btn btn-secondary" disabled={busy}>➕ {tr('Add')}</button>
            </form>
          )}
        </div>
        {i.canManage && (
          <div className="x7-actions">
            {open ? <button type="button" className="btn btn-primary is-end" disabled={busy} onClick={() => run(() => api.post('/safety/' + i.id + '/close', {}))}>✅ {tr('Close it')}</button>
              : <button type="button" className="btn btn-secondary is-end" disabled={busy} onClick={() => run(() => api.post('/safety/' + i.id + '/reopen', {}))}>↩️ {tr('Reopen')}</button>}
          </div>
        )}
      </div>
    </div>
  );
}

// Twelve months: injuries, near misses and the rest, stacked.
function MonthsChart({ months }) {
  const max = Math.max(1, ...months.map((m) => m.injury + m.nearMiss + m.other));
  const top = Math.max(2, Math.ceil(max / 2) * 2);
  const W = 640, H = 150, padL = 26, step = (W - padL - 6) / months.length, bw = Math.min(26, step * 0.56);
  const y = (v) => 8 + H - v / top * H;
  const ticks = [0, top / 2, top];
  return (
    <div className="hs-chart">
      <svg viewBox={'0 0 ' + W + ' ' + (H + 30)} role="img" aria-label={tr('Reports each month')}>
        {ticks.map((t) => <g key={t}><line x1={padL} x2={W - 4} y1={y(t)} y2={y(t)} className="bg-grid" /><text x={padL - 6} y={y(t) + 4} textAnchor="end" className="bg-axis">{t}</text></g>)}
        {months.map((m, i) => {
          let base = 0;
          const cx = padL + step * i + step / 2;
          return (
            <g key={m.month}>
              {['injury', 'nearMiss', 'other'].map((k) => {
                if (!m[k]) return null;
                const y0 = y(base), y1 = y(base + m[k]);
                base += m[k];
                return <rect key={k} x={cx - bw / 2} y={y1 + 1} width={bw} height={Math.max(1, y0 - y1 - 2)} rx="4" style={{ fill: COLORS[k] }}><title>{monthText(m.month)}: {m[k]} {k === 'injury' ? tr('injuries') : k === 'nearMiss' ? tr('near misses') : tr('other reports')}</title></rect>;
              })}
              <text x={cx} y={H + 26} textAnchor="middle" className="bg-axis">{monthText(m.month)}</text>
            </g>
          );
        })}
      </svg>
      <div className="bg-legend"><span><i className="bg-key" style={{ background: COLORS.injury }} />{tr('Injuries')}</span><span><i className="bg-key" style={{ background: COLORS.nearMiss }} />{tr('Near misses')}</span><span><i className="bg-key" style={{ background: COLORS.other }} />{tr('Other reports')}</span></div>
    </div>
  );
}

export default function SafetyPage() {
  const [params, setParams] = useSearchParams();
  const [company, setCompany] = useState('');
  const [status, setStatus] = useState('all');
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [reporting, setReporting] = useState(false);
  const load = useCallback(() => api.get('/safety?status=' + status + (company ? '&company=' + company : '')).then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), [company, status]);
  useEffect(() => { load(); }, [load]);
  const openId = params.get('incident');
  const open = (id) => setParams(id ? { incident: id } : {});
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const s = d.summary;
  return (
    <div className="x7">
      <header className="x7-head">
        <div>
          <h1>⛑️ {tr('Health and safety')}</h1>
          <p>{tr('Incidents and near misses reported by anyone, from My space too; the cause, the actions to stop it happening again, each with an owner and a day.')}</p>
        </div>
        <div className="x7-head-actions"><button type="button" className="btn btn-primary" onClick={() => setReporting(true)}>⛑️ {tr('Report something')}</button></div>
      </header>
      <div className="x7-chips">
        <button type="button" className={!company ? 'is-on' : ''} onClick={() => setCompany('')}>{tr('All companies')}</button>
        {d.companies.map((c) => <button key={c.id} type="button" className={company === c.id ? 'is-on' : ''} onClick={() => setCompany(c.id)}>{c.name}</button>)}
      </div>
      {d.counters.length > 0 && (
        <div className="hs-counters">{d.counters.filter((c) => !company || c.companyId === company).map((c) => (
          <div key={c.companyId} className={'hs-counter ' + (c.clean || c.days >= 30 ? 'is-good' : c.days >= 7 ? 'is-warn' : 'is-bad')}>
            <b>{c.days}</b>
            <span><strong>{c.clean ? (c.days === 1 ? tr('day with no lost-time injury on record') : tr('days with no lost-time injury on record')) : c.days === 1 ? tr('day since the last lost-time injury') : tr('days since the last lost-time injury')}</strong><small>{c.company}{c.lastLostTime ? ' · ' + tr('last {date}', { date: dayText(c.lastLostTime, { year: 'numeric' }) }) : ' · ' + tr('since {date}', { date: dayText(c.since, { year: 'numeric' }) })}</small></span>
          </div>
        ))}</div>
      )}
      <div className="x7-tiles">
        <div className="x7-tile is-calm"><small>📋 {tr('This year')}</small><b>{s.year}</b><span>{tr('reports')}</span></div>
        <div className="x7-tile is-bad"><small>🤕 {tr('Injuries')}</small><b>{s.injuries}</b><span>{tr('{n} days off work', { n: s.lostDays })}</span></div>
        <div className="x7-tile is-warn"><small>🟡 {tr('Near misses')}</small><b>{s.nearMisses}</b><span>{s.nearPerInjury != null ? tr('{n} for each injury — keep them coming', { n: s.nearPerInjury }) : tr('worth reporting too')}</span></div>
        <div className={'x7-tile ' + (s.lateActions ? 'is-bad' : 'is-good')}><small>🛠️ {tr('Actions open')}</small><b>{s.openActions}</b><span>{s.lateActions ? tr('{n} late', { n: s.lateActions }) : tr('none late')}</span></div>
      </div>
      <section className="x7-card"><h2>📅 {tr('The last twelve months')}</h2><MonthsChart months={d.months} /></section>
      {d.actions.length > 0 && (
        <section className="x7-card">
          <h2>🛠️ {tr('Actions to do')}</h2>
          <div className="x7-list">{d.actions.map((a) => (
            <button key={a.id} type="button" className={'x7-row' + (a.late ? ' is-flag is-bad' : '')} onClick={() => open(a.incidentId)}>
              <span className="x7-icon" aria-hidden="true">{KIND[a.kind][0]}</span>
              <span className="x7-who"><b>{a.title}</b><small>{a.ref} · {a.owner || '—'}</small></span>
              <span className={'x7-pill ' + (a.late ? 'is-bad' : 'is-calm')}>{a.late ? '⏰ ' : ''}{tr('by {date}', { date: dayText(a.dueOn) })}</span><span />
            </button>
          ))}</div>
        </section>
      )}
      <div className="x7-bar">
        <h2 className="x7-h2" style={{ margin: 0 }}>📋 {tr('Reports')}</h2>
        <div className="x7-seg" role="tablist">{[['all', tr('All')], ['open', tr('Open')], ['closed', tr('Closed')]].map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={status === k} className={status === k ? 'is-on' : ''} onClick={() => setStatus(k)}>{l}</button>)}</div>
      </div>
      {!d.incidents.length ? <div className="x7-empty"><span aria-hidden="true">⛑️</span><p>{tr('Nothing reported. Report near misses too: they show where the next accident is waiting.')}</p></div> : (
        <div className="x7-list">{d.incidents.map((i) => (
          <button key={i.id} type="button" className={'x7-row' + (i.status !== 'closed' && (i.severity === 'high' || i.severity === 'critical' || i.lostTime) ? ' is-flag is-bad' : i.status === 'new' ? ' is-flag is-calm' : '')} onClick={() => open(i.id)}>
            <span className="x7-icon" aria-hidden="true">{KIND[i.kind][0]}</span>
            <span className="x7-who"><b>{i.description}</b><small>{i.ref} · {tr(KIND[i.kind][1])} · {when(i.occurredAt)}{i.location ? ' · ' + i.location : ''}{i.company && !company ? ' · ' + i.company : ''}</small></span>
            <span className={'x7-pill ' + STATUS[i.status][1]}>{STATUS[i.status][0]} {tr(STATUS[i.status][2])}{i.openActions ? ' · 🛠️ ' + i.openActions : ''}</span>
            <span className={'x7-pill ' + SEVERITY[i.severity][0]}>{tr(SEVERITY[i.severity][1])}</span>
          </button>
        ))}</div>
      )}
      {reporting && <ReportDialog companies={d.companies} company={company} onClose={() => setReporting(false)} onDone={(x) => { setReporting(false); load(); open(x.id); }} />}
      {openId && <IncidentSheet key={openId} id={openId} people={d.people} onClose={() => open(null)} onChanged={load} />}
    </div>
  );
}

// My space: report something; my safety actions; what I reported.
export function MySafetyCard() {
  const [d, setD] = useState(null);
  const [reporting, setReporting] = useState(false);
  const [flash, setFlash] = useState(null);
  const load = useCallback(() => api.get('/safety/mine').then(setD).catch(() => setD(null)), []);
  useEffect(() => { load(); }, [load]);
  if (!d) return null;
  async function done(id) { try { await api.post('/safety/actions/' + id, { done: true }); load(); } catch { /* shown on the next load */ } }
  return (
    <div className="msx-card x7-mine">
      <h4 className="msp-h4">⛑️ {tr('Health and safety')}</h4>
      <div className="x7-mine-top" style={{ '--tone': 'var(--x7-warn)' }}>
        <span><small>{tr('Seen something unsafe, or a near miss?')}</small><b>{tr('Tell us, with a photo')}</b></span>
        <button type="button" className="btn btn-primary" onClick={() => setReporting(true)}>⛑️ {tr('Report')}</button>
      </div>
      {flash && <div className="x7-flash" role="status">{flash}</div>}
      {d.actions.length > 0 && <ul className="x7-mine-list">{d.actions.map((a) => (
        <li key={a.id}><button type="button" className="ob-tick" onClick={() => done(a.id)} aria-label={tr('Done')} /><span><b>{a.title}</b><small>{a.ref} · {a.late ? '⏰ ' : ''}{tr('by {date}', { date: dayText(a.dueOn) })}</small></span></li>
      ))}</ul>}
      {d.reports.length > 0 && <ul className="x7-mine-list">{d.reports.slice(0, 3).map((r) => (
        <li key={r.id}><span aria-hidden="true">{KIND[r.kind][0]}</span><span><b>{r.ref} · {tr(KIND[r.kind][1])}</b><small>{dayText(r.occurredAt)}</small></span><span className={'x7-pill ' + STATUS[r.status][1]} style={{ flex: 'none' }}>{STATUS[r.status][0]} {tr(STATUS[r.status][2])}</span></li>
      ))}</ul>}
      {reporting && <ReportDialog companies={d.companies} company={d.company} onClose={() => setReporting(false)} onDone={(x) => { setReporting(false); setFlash('✅ ' + tr('Thank you: {ref} is with whoever looks after safety.', { ref: x.ref })); load(); }} />}
    </div>
  );
}
