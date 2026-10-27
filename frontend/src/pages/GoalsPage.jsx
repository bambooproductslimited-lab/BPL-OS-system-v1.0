import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './seventeenth.css';
import './eighteenth.css';
import './nineteenth.css';

// Goals (Overview → Goals; backend goals.service.js, migration 0200): the
// quarter's objectives for the company and each team lined up under them;
// each with key results from a start to a target, an owner who checks in
// every week (where it is, how confident they are). Everyone sees them;
// goals.manage sets them. The quarter's time gone beside each one's progress.

function dayText(d) { return d ? new Date(d).toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' }) : '—'; }
function hue(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function periodText(p) { return p.slice(-2) + ' ' + p.slice(0, 4); }
function valueText(k, v) {
  if (k.kind === 'done') return v >= 1 ? tr('Done') : tr('Not yet');
  if (k.kind === 'money') return money(v, 'GHS');
  if (k.kind === 'percent') return Number(v).toLocaleString(activeIntlLocale(), { maximumFractionDigits: 1 }) + '%';
  return Number(v).toLocaleString(activeIntlLocale(), { maximumFractionDigits: 2 }) + (k.unit ? ' ' + k.unit : '');
}

const CONFIDENCE = { on_track: ['🟢', 'is-good', msg('On track')], at_risk: ['🟠', 'is-warn', msg('At risk')], off_track: ['🔴', 'is-bad', msg('Off track')] };
const PACE = { ahead: ['is-good', msg('Keeping pace')], behind: ['is-warn', msg('A little behind')], far_behind: ['is-bad', msg('Well behind')], done: ['is-good', msg('Done')], dropped: ['is-calm', msg('Dropped')] };
const KIND = { number: msg('A number'), percent: msg('A share (%)'), money: msg('Money (GHS)'), done: msg('Done or not') };

function Ring({ value, size }) {
  return <span className="bk-ring gl-ring" style={{ '--p': value, width: size, height: size }} role="img" aria-label={value + '%'}><b>{value}%</b></span>;
}
// A key result's bar: how far it has come, and where it should be by now.
function KrBar({ k, expected }) {
  return (
    <span className="gl-bar" title={tr('{p}% there; {e}% of the quarter gone', { p: k.progress, e: expected })}>
      <i className={'is-' + k.confidence} style={{ width: k.progress + '%' }} />
      {expected > 0 && expected < 100 && <em style={{ left: expected + '%' }} aria-hidden="true" />}
    </span>
  );
}

function CheckIn({ k, onDone, compact }) {
  const [f, setF] = useState({ value: k.kind === 'done' ? (k.current >= 1 ? 1 : 0) : String(k.current), confidence: k.confidence, note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.post('/goals/key-results/' + k.id + '/checkin', { ...f, value: k.kind === 'done' ? Number(f.value) : f.value })); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <form className={'gl-checkin' + (compact ? ' is-compact' : '')} onSubmit={save}>
      {k.kind === 'done'
        ? <span className="x7-seg">{[[0, tr('Not yet')], [1, tr('Done')]].map(([v, l]) => <button key={v} type="button" className={Number(f.value) === v ? 'is-on' : ''} onClick={() => setF({ ...f, value: v })}>{l}</button>)}</span>
        : <label><span>{tr('Now')}</span><input className="input" type="number" step="any" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></label>}
      <span className="x7-seg gl-conf">{Object.entries(CONFIDENCE).map(([c, [ic, , l]]) => <button key={c} type="button" className={f.confidence === c ? 'is-on' : ''} onClick={() => setF({ ...f, confidence: c })} title={tr(l)}>{ic}{compact ? '' : ' ' + tr(l)}</button>)}</span>
      {!compact && <input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder={tr('What moved it, what is in the way')} aria-label={tr('Note')} />}
      <button type="submit" className="btn btn-primary" disabled={busy}>{tr('Check in')}</button>
      {error && <div className="error-banner" role="alert">{error}</div>}
    </form>
  );
}

function Spark({ k }) {
  const pts = [{ value: k.start }].concat(k.checkins || []);
  if (pts.length < 2) return null;
  const lo = Math.min(k.start, k.target, ...pts.map((p) => p.value)), hi = Math.max(k.start, k.target, ...pts.map((p) => p.value));
  const W = 160, H = 40, x = (n) => 4 + n * (W - 8) / (pts.length - 1), y = (v) => 4 + (hi - v) / ((hi - lo) || 1) * (H - 8);
  return (
    <svg className="gl-spark" viewBox={'0 0 ' + W + ' ' + H} role="img" aria-label={tr('Check-ins')}>
      <line x1="4" x2={W - 4} y1={y(k.target)} y2={y(k.target)} className="gl-spark-target" />
      <polyline points={pts.map((p, n) => x(n) + ',' + y(p.value)).join(' ')} />
      {pts.map((p, n) => <circle key={n} cx={x(n)} cy={y(p.value)} r="3" className={p.confidence ? 'is-' + p.confidence : ''} />)}
    </svg>
  );
}

function ObjectiveSheet({ id, d, onClose, onChanged, onOpen }) {
  const [o, setO] = useState(null);
  const [adding, setAdding] = useState(false);
  const [kr, setKr] = useState({ title: '', kind: 'number', start: '0', target: '', unit: '', ownerId: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { api.get('/goals/' + id).then(setO).catch((e) => setError(e.message)); }, [id]);
  async function run(fn) {
    setBusy(true); setError(null);
    try { setO(await fn()); onChanged(); return true; } catch (e) { setError(e.message); return false; } finally { setBusy(false); }
  }
  if (!o) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const pace = PACE[o.pace];
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet is-wide" role="dialog" aria-modal="true" aria-labelledby="gl-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={o.confidence === 'off_track' ? { '--g1': '#9a3412', '--g2': '#be185d' } : o.level === 'team' ? { '--g1': '#0f766e', '--g2': '#2563eb' } : { '--g1': '#1e3a8a', '--g2': '#7c3aed' }}>
          <Ring value={o.progress} size={62} />
          <div><small>{periodText(o.period)} · {o.level === 'team' ? (o.department ? o.department.name : tr('Team')) : tr('Company')}{o.owner ? ' · ' + o.owner.name : ''}</small><h2 id="gl-t">{o.title}</h2>
            <p><span className="x7-pill">{tr(pace[1])}</span><span className="x7-pill">{tr('{n}% of the quarter gone', { n: o.expected })}</span>{o.parent && <button type="button" className="x7-pill gl-parent" onClick={() => onOpen(o.parent.id)}>↳ {o.parent.title}</button>}</p></div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        {o.why && <p className="x7-note">💭 {o.why}</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="gl-krs">{o.keyResults.map((k) => (
          <section key={k.id} className={'gl-kr is-' + k.confidence}>
            <div className="gl-kr-head">
              <span className="x7-avatar" style={{ '--h': hue(k.owner ? k.owner.name : '?') }} aria-hidden="true">{k.owner ? k.owner.name.charAt(0) : '?'}</span>
              <span className="x7-who"><b>{k.title}</b><small>{k.owner ? k.owner.name : '—'} · {valueText(k, k.start)} → {valueText(k, k.target)}{k.checkedAt ? ' · ' + tr('checked in {date}', { date: dayText(k.checkedAt) }) : ' · ' + tr('no check-in yet')}{k.stale && o.status === 'active' ? ' ⏰' : ''}</small></span>
              <span className={'x7-pill ' + CONFIDENCE[k.confidence][1]}>{CONFIDENCE[k.confidence][0]} {tr(CONFIDENCE[k.confidence][2])}</span>
            </div>
            <div className="gl-kr-now"><b>{valueText(k, k.current)}</b><KrBar k={k} expected={o.expected} /><small>{k.progress}%</small><Spark k={k} /></div>
            {k.checkins && k.checkins.length > 0 && <ul className="gl-notes">{k.checkins.slice(-3).reverse().map((c, n) => <li key={n}><span aria-hidden="true">{CONFIDENCE[c.confidence][0]}</span><span><b>{valueText(k, c.value)}</b>{c.note ? ' — ' + c.note : ''}<small>{dayText(c.at)} · {c.by}</small></span></li>)}</ul>}
            {k.canCheckIn && o.status === 'active' && <CheckIn k={k} onDone={(x) => { setO(x); onChanged(); }} />}
          </section>
        ))}</div>
        {o.children.length > 0 && (
          <div className="x7-sec">
            <h3>🧩 {tr('The teams\' part')}</h3>
            <div className="x7-list">{o.children.map((c) => (
              <button key={c.id} type="button" className="x7-row" onClick={() => onOpen(c.id)}>
                <Ring value={c.progress} size={40} />
                <span className="x7-who"><b>{c.title}</b><small>{c.department ? c.department.name : ''}{c.owner ? ' · ' + c.owner.name : ''}</small></span>
                <span className={'x7-pill ' + CONFIDENCE[c.confidence][1]}>{CONFIDENCE[c.confidence][0]}</span><span />
              </button>
            ))}</div>
          </div>
        )}
        {o.canManage && adding && (
          <form className="x7-form" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api.post('/goals/' + o.id + '/key-results', { ...kr, ownerId: kr.ownerId || null }))) { setAdding(false); setKr({ title: '', kind: 'number', start: '0', target: '', unit: '', ownerId: '' }); } }}>
            <h3>➕ {tr('A key result')}</h3>
            <label><span>{tr('How will you know?')}</span><input className="input" required value={kr.title} onChange={(e) => setKr({ ...kr, title: e.target.value })} /></label>
            <div className="x7-grid3">
              <label><span>{tr('Measured as')}</span><select className="input" value={kr.kind} onChange={(e) => setKr({ ...kr, kind: e.target.value })}>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{tr(l)}</option>)}</select></label>
              {kr.kind !== 'done' && <label><span>{tr('From')}</span><input className="input" type="number" step="any" value={kr.start} onChange={(e) => setKr({ ...kr, start: e.target.value })} /></label>}
              {kr.kind !== 'done' && <label><span>{tr('To')}</span><input className="input" type="number" step="any" required value={kr.target} onChange={(e) => setKr({ ...kr, target: e.target.value })} /></label>}
            </div>
            <label><span>{tr('Owner')}</span><select className="input" value={kr.ownerId} onChange={(e) => setKr({ ...kr, ownerId: e.target.value })}><option value="">{o.owner ? o.owner.name : '—'}</option>{d.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setAdding(false)}>{tr('Back')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Add')}</button></div>
          </form>
        )}
        {o.canManage && !adding && (
          <div className="x7-actions">
            {o.status === 'active' && o.keyResults.length < 6 && <button type="button" className="btn btn-secondary" onClick={() => setAdding(true)}>➕ {tr('A key result')}</button>}
            {o.status === 'active' && <button type="button" className="btn btn-secondary is-end" disabled={busy} onClick={() => run(() => api.put('/goals/' + o.id, { status: 'dropped' }))}>💤 {tr('Drop it')}</button>}
            {o.status === 'active' && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run(() => api.put('/goals/' + o.id, { status: 'done' }))}>🏁 {tr('Achieved')}</button>}
            {o.status !== 'active' && <button type="button" className="btn btn-secondary is-end" disabled={busy} onClick={() => run(() => api.put('/goals/' + o.id, { status: 'active' }))}>🔁 {tr('Make it active again')}</button>}
          </div>
        )}
      </div>
    </div>
  );
}

function NewObjective({ d, onClose, onDone }) {
  const [f, setF] = useState({ level: 'company', departmentId: '', parentId: '', title: '', why: '', ownerId: '', keyResults: [{ title: '', kind: 'number', start: '0', target: '', unit: '', ownerId: '' }] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const setK = (n, x) => setF({ ...f, keyResults: f.keyResults.map((k, j) => (j === n ? { ...k, ...x } : k)) });
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.post('/goals', { ...f, period: d.period, departmentId: f.departmentId || null, parentId: f.parentId || null, ownerId: f.ownerId || null, keyResults: f.keyResults.map((k) => ({ ...k, ownerId: k.ownerId || null })) })); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" style={{ width: 'min(780px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="gl-n-t" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">🎯</span><div><h2 id="gl-n-t">{tr('An objective for {p}', { p: periodText(d.period) })}</h2><p>{tr('What we will get done, and why. Its key results say how we will know: two to four is plenty.')}</p></div></div>
        <div className="x7-seg" style={{ alignSelf: 'flex-start' }}>{[['company', tr('The company')], ['team', tr('A team')]].map(([k, l]) => <button key={k} type="button" className={f.level === k ? 'is-on' : ''} onClick={() => setF({ ...f, level: k })}>{l}</button>)}</div>
        {f.level === 'team' && (
          <div className="x7-grid2">
            <label><span>{tr('Team')}</span><select className="input" required value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}><option value="">—</option>{d.departments.map((x) => <option key={x.id} value={x.id}>{x.company ? x.company + ' · ' : ''}{x.name}</option>)}</select></label>
            <label><span>{tr('Its part in')}</span><select className="input" value={f.parentId} onChange={(e) => setF({ ...f, parentId: e.target.value })}><option value="">—</option>{d.company.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}</select></label>
          </div>
        )}
        <label><span>{tr('The objective')}</span><input className="input" required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder={tr('e.g. Become the hotels\' first choice for bamboo furniture')} /></label>
        <div className="x7-grid2">
          <label><span>{tr('Why it matters')}</span><input className="input" value={f.why} onChange={(e) => setF({ ...f, why: e.target.value })} /></label>
          <label><span>{tr('Owner')}</span><select className="input" value={f.ownerId} onChange={(e) => setF({ ...f, ownerId: e.target.value })}><option value="">{tr('Me')}</option>{d.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        </div>
        <h3 className="gl-krh">📏 {tr('Key results')}</h3>
        <div className="ob-edit">{f.keyResults.map((k, n) => (
          <div key={n} className="gl-kr-row">
            <input className="input" required value={k.title} onChange={(e) => setK(n, { title: e.target.value })} placeholder={tr('e.g. Chairs sold to hotels')} aria-label={tr('Key result')} />
            <select className="input" value={k.kind} onChange={(e) => setK(n, { kind: e.target.value })} aria-label={tr('Measured as')}>{Object.entries(KIND).map(([x, l]) => <option key={x} value={x}>{tr(l)}</option>)}</select>
            {k.kind !== 'done' ? <input className="input" type="number" step="any" value={k.start} onChange={(e) => setK(n, { start: e.target.value })} placeholder={tr('From')} aria-label={tr('From')} /> : <span />}
            {k.kind !== 'done' ? <input className="input" type="number" step="any" value={k.target} onChange={(e) => setK(n, { target: e.target.value })} placeholder={tr('To')} aria-label={tr('To')} /> : <span />}
            <select className="input" value={k.ownerId} onChange={(e) => setK(n, { ownerId: e.target.value })} aria-label={tr('Owner')}><option value="">{tr('Its owner')}</option>{d.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            <button type="button" className="btn btn-secondary" disabled={f.keyResults.length === 1} onClick={() => setF({ ...f, keyResults: f.keyResults.filter((_, j) => j !== n) })} aria-label={tr('Remove')}>✕</button>
          </div>
        ))}</div>
        {f.keyResults.length < 6 && <button type="button" className="x7-link" style={{ alignSelf: 'flex-start' }} onClick={() => setF({ ...f, keyResults: [...f.keyResults, { title: '', kind: 'number', start: '0', target: '', unit: '', ownerId: '' }] })}>➕ {tr('Another key result')}</button>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>🎯 {tr('Set it')}</button></div>
      </form>
    </div>
  );
}

function ObjectiveCard({ o, expected, onOpen, big }) {
  return (
    <button type="button" className={'gl-obj' + (big ? ' is-big' : '') + (o.status !== 'active' ? ' is-' + o.status : '')} onClick={() => onOpen(o.id)}>
      <div className="gl-obj-head">
        <Ring value={o.progress} size={big ? 64 : 48} />
        <span className="x7-who"><b>{o.title}</b><small>{o.level === 'team' && o.department ? o.department.name + ' · ' : ''}{o.owner ? o.owner.name : '—'}{o.aligned ? ' · 🧩 ' + tr('{n} team objectives', { n: o.aligned }) : ''}</small><span className={'x7-pill ' + PACE[o.pace][0]}>{tr(PACE[o.pace][1])}</span></span>
      </div>
      <div className="gl-obj-krs">{o.keyResults.map((k) => (
        <div key={k.id} className="gl-obj-kr">
          <span className="gl-dot" aria-label={tr(CONFIDENCE[k.confidence][2])}>{CONFIDENCE[k.confidence][0]}</span>
          <span className="gl-kr-name">{k.title}</span>
          <KrBar k={k} expected={expected} />
          <small>{valueText(k, k.current)} / {valueText(k, k.target)}</small>
        </div>
      ))}</div>
    </button>
  );
}

export default function GoalsPage() {
  const [params, setParams] = useSearchParams();
  const [period, setPeriod] = useState('');
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => api.get('/goals' + (period ? '?period=' + period : '')).then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), [period]);
  useEffect(() => { load(); }, [load]);
  const openId = params.get('objective');
  const open = (id) => setParams(id ? { objective: id } : {});
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const s = d.summary;
  const byTeam = {};
  d.teams.forEach((t) => { const k = t.department ? t.department.name : '—'; (byTeam[k] = byTeam[k] || []).push(t); });
  return (
    <div className="x7">
      <header className="x7-head">
        <div>
          <h1>🎯 {tr('Goals')}</h1>
          <p>{tr('What the company means to get done this quarter, each team\'s part in it, and where every key result stands — checked in each week by its owner.')}</p>
        </div>
        <div className="x7-head-actions">
          <div className="x7-seg">{d.periods.map((p) => <button key={p} type="button" className={d.period === p ? 'is-on' : ''} onClick={() => setPeriod(p)}>{periodText(p)}{p === d.current ? ' ·' : ''}</button>)}</div>
          {d.canManage && <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>🎯 {tr('New objective')}</button>}
        </div>
      </header>
      <div className="gl-quarter">
        <div><small>{periodText(d.period)}</small><b>{tr('{n}% of the quarter gone', { n: d.elapsed })}</b></div>
        <span className="gl-time"><i style={{ width: d.elapsed + '%' }} /></span>
        <div className="gl-quarter-avg"><Ring value={s.progress || 0} size={54} /><span><small>{tr('Company objectives')}</small><b>{tr('{n}% done on average', { n: s.progress || 0 })}</b></span></div>
      </div>
      <div className="x7-tiles">
        <div className="x7-tile is-violet"><small>🎯 {tr('Objectives')}</small><b>{s.objectives}</b><span>{tr('{n} key results', { n: s.keyResults })}</span></div>
        <div className="x7-tile is-good"><small>🟢 {tr('On track')}</small><b>{s.onTrack}</b><span>{tr('key results')}</span></div>
        <div className="x7-tile is-warn"><small>🟠 {tr('At risk')}</small><b>{s.atRisk}</b><span>{tr('key results')}</span></div>
        <div className="x7-tile is-bad"><small>🔴 {tr('Off track')}</small><b>{s.offTrack}</b><span>{tr('key results')}</span></div>
        <div className={'x7-tile ' + (s.stale ? 'is-warn' : 'is-good')}><small>⏰ {tr('No check-in this week')}</small><b>{s.stale}</b><span>{s.stale ? tr('their owners are reminded') : tr('everyone checked in')}</span></div>
      </div>
      {d.mine.length > 0 && (
        <section className="x7-card gl-mine">
          <h2>🙋 {tr('Your key results')}</h2>
          {d.mine.map((k) => (
            <div key={k.id} className="gl-mine-row">
              <span className="x7-who"><b>{k.title}</b><small>{valueText(k, k.current)} / {valueText(k, k.target)} · {k.progress}%{k.stale ? ' · ⏰ ' + tr('check in') : ''}</small></span>
              <KrBar k={k} expected={d.elapsed} />
              <CheckIn k={k} compact onDone={() => load()} />
            </div>
          ))}
        </section>
      )}
      <h2 className="x7-h2">🏢 {tr('The company')}</h2>
      {!d.company.length ? <div className="x7-empty"><span aria-hidden="true">🎯</span><p>{tr('No objectives for this quarter yet.')}</p></div>
        : <div className="gl-grid">{d.company.map((o) => <ObjectiveCard key={o.id} o={o} expected={d.elapsed} onOpen={open} big />)}</div>}
      {Object.keys(byTeam).length > 0 && (
        <>
          <h2 className="x7-h2">🧩 {tr('The teams')}</h2>
          <div className="gl-teams">{Object.entries(byTeam).map(([team, list]) => (
            <section key={team} className="gl-team">
              <h3>{team}</h3>
              <div className="gl-grid">{list.map((o) => <ObjectiveCard key={o.id} o={o} expected={d.elapsed} onOpen={open} />)}</div>
            </section>
          ))}</div>
        </>
      )}
      {creating && <NewObjective d={d} onClose={() => setCreating(false)} onDone={(x) => { setCreating(false); load(); open(x.id); }} />}
      {openId && <ObjectiveSheet key={openId} id={openId} d={d} onClose={() => open(null)} onChanged={load} onOpen={open} />}
    </div>
  );
}

// My space: the key results I own this quarter, checked in from here.
export function MyGoalsCard() {
  const [d, setD] = useState(null);
  const [flash, setFlash] = useState(null);
  const load = useCallback(() => api.get('/goals/mine').then(setD).catch(() => setD(null)), []);
  useEffect(() => { load(); }, [load]);
  if (!d || !d.keyResults.length) return null;
  return (
    <div className="msx-card x7-mine">
      <h4 className="msp-h4">🎯 {tr('My key results')} · {periodText(d.period)}</h4>
      {flash && <div className="x7-flash" role="status">{flash}</div>}
      {d.keyResults.map((k) => (
        <div key={k.id} className="gl-mine-row is-card">
          <span className="x7-who"><b>{k.title}</b><small>{k.objective.title}</small></span>
          <div className="gl-kr-now"><b>{valueText(k, k.current)}</b><KrBar k={k} expected={d.elapsed} /><small>{k.progress}%</small></div>
          <CheckIn k={k} compact onDone={() => { setFlash('✅ ' + tr('Checked in. Thank you!')); load(); }} />
        </div>
      ))}
    </div>
  );
}
