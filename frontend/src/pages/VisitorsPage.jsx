import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './seventeenth.css';
import './eighteenth.css';

// Visitors and gate passes (Operations → Visitors and gate passes; backend
// visitors.service.js, migration 0199): the front desk signs visitors in and
// out and their host is told; staff expecting someone add them from My space
// and send them a pass. Who is on site now, for a roll call. Goods leaving on
// a gate pass: asked for, approved, let out at the gate and, if they are
// coming back, checked back in.

function dayText(d, opts) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC', ...opts }) : '—'; }
function time(t) { return t ? new Date(t).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' }) : '—'; }
function when(t) { return t ? new Date(t).toLocaleString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; }
function hue(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function today() { return new Date().toISOString().slice(0, 10); }
function soon() { const d = new Date(Date.now() + 86400000); d.setHours(10, 0, 0, 0); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }
const PURPOSE = { meeting: ['🤝', msg('Meeting')], delivery: ['📦', msg('Delivery')], interview: ['🎤', msg('Interview')], contractor: ['🛠️', msg('Contractor')], customer: ['🛋️', msg('Customer')], official: ['🏛️', msg('Official visit')], other: ['📝', msg('Other')] };
const REASON = { delivery: ['🚚', msg('Delivery')], repair: ['🔧', msg('For repair')], loan: ['🤝', msg('On loan')], return_to_supplier: ['↩️', msg('Back to the supplier')], sold: ['💰', msg('Sold')], disposal: ['🗑️', msg('Disposal')], other: ['📝', msg('Other')] };
const PASS = { requested: ['🕓', 'is-warn', msg('To approve')], approved: ['✅', 'is-calm', msg('Approved — at the gate')], rejected: ['🚫', 'is-bad', msg('Turned down')], out: ['🚚', 'is-violet', msg('Out')], back: ['↩️', 'is-good', msg('Back in')] };
function passUrl(code) { return window.location.origin + '/visit/' + code; }

function WalkIn({ d, onClose, onDone }) {
  const [f, setF] = useState({ name: '', phone: '', fromOrg: '', hostId: '', purpose: 'meeting', vehicle: '', badge: '', companyId: d.company || '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.post('/visitors/in', f)); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" style={{ width: 'min(640px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="vz-w-t" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">🛎️</span><div><h2 id="vz-w-t">{tr('Sign someone in')}</h2><p>{tr('Whoever they are here to see is told at once.')}</p></div></div>
        <div className="x7-chips">{Object.entries(PURPOSE).map(([k, [ic, l]]) => <button key={k} type="button" className={f.purpose === k ? 'is-on' : ''} onClick={() => setF({ ...f, purpose: k })}><em aria-hidden="true">{ic}</em>{tr(l)}</button>)}</div>
        <div className="x7-grid2">
          <label><span>{tr('Full name')}</span><input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label><span>{tr('Phone')}</span><input className="input" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
          <label><span>{tr('From (company)')}</span><input className="input" value={f.fromOrg} onChange={(e) => setF({ ...f, fromOrg: e.target.value })} /></label>
          <label><span>{tr('Here to see')}</span><select className="input" value={f.hostId} onChange={(e) => setF({ ...f, hostId: e.target.value })}><option value="">—</option>{d.people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.position ? ' · ' + p.position : ''}</option>)}</select></label>
          <label><span>{tr('Vehicle')}</span><input className="input" value={f.vehicle} onChange={(e) => setF({ ...f, vehicle: e.target.value })} placeholder={tr('Number plate')} /></label>
          <label><span>{tr('Badge')}</span><input className="input" value={f.badge} onChange={(e) => setF({ ...f, badge: e.target.value })} placeholder="V-01" /></label>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Sign in')}</button></div>
      </form>
    </div>
  );
}

function PassForm({ d, onClose, onDone }) {
  const [f, setF] = useState({ companyId: d.company || '', items: [{ what: '', qty: 1 }], reason: 'delivery', carrier: '', vehicle: '', returnable: false, backBy: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const setItem = (i, patch) => setF({ ...f, items: f.items.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.post('/visitors/passes', f)); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" style={{ width: 'min(680px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="vz-p-t" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">🚪</span><div><h2 id="vz-p-t">{tr('A gate pass')}</h2><p>{tr('For goods leaving the site: a manager approves it, security lets it out.')}</p></div></div>
        <span className="x7-muted">{tr('What is going out')}</span>
        {f.items.map((x, i) => (
          <div key={i} className="vz-item">
            <input className="input" required={i === 0} value={x.what} onChange={(e) => setItem(i, { what: e.target.value })} placeholder={tr('e.g. Bamboo lounge chairs')} aria-label={tr('What')} />
            <input className="input" type="number" min="1" value={x.qty} onChange={(e) => setItem(i, { qty: e.target.value })} aria-label={tr('How many')} />
            <button type="button" className="btn btn-secondary" onClick={() => setF({ ...f, items: f.items.filter((_, j) => j !== i) })} disabled={f.items.length === 1} aria-label={tr('Remove')}>✕</button>
          </div>
        ))}
        <button type="button" className="x7-link" style={{ alignSelf: 'flex-start' }} onClick={() => setF({ ...f, items: [...f.items, { what: '', qty: 1 }] })}>➕ {tr('Another item')}</button>
        <div className="x7-chips">{Object.entries(REASON).map(([k, [ic, l]]) => <button key={k} type="button" className={f.reason === k ? 'is-on' : ''} onClick={() => setF({ ...f, reason: k, returnable: k === 'repair' || k === 'loan' ? true : f.returnable })}><em aria-hidden="true">{ic}</em>{tr(l)}</button>)}</div>
        <div className="x7-grid2">
          <label><span>{tr('Taken by')}</span><input className="input" value={f.carrier} onChange={(e) => setF({ ...f, carrier: e.target.value })} placeholder={tr('Name or company')} /></label>
          <label><span>{tr('Vehicle')}</span><input className="input" value={f.vehicle} onChange={(e) => setF({ ...f, vehicle: e.target.value })} placeholder={tr('Number plate')} /></label>
          <label><span>{tr('Company')}</span><select className="input" value={f.companyId} onChange={(e) => setF({ ...f, companyId: e.target.value })}><option value="">—</option>{d.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        </div>
        <label className="x7-check"><input type="checkbox" checked={f.returnable} onChange={(e) => setF({ ...f, returnable: e.target.checked })} /><span>{tr('It is coming back')}<small>{tr('Security checks it back in; if it is late, you are reminded.')}</small></span></label>
        {f.returnable && <label><span>{tr('Back by')}</span><input className="input" type="date" required min={today()} value={f.backBy} onChange={(e) => setF({ ...f, backBy: e.target.value })} /></label>}
        <label><span>{tr('Note')}</span><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Ask for it')}</button></div>
      </form>
    </div>
  );
}

function PassSheet({ id, d, onClose, onChanged }) {
  const [p, setP] = useState(null);
  const [no, setNo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { api.get('/visitors/passes/' + id).then(setP).catch((e) => setError(e.message)); }, [id]);
  async function run(path, body) {
    setBusy(true); setError(null);
    try { setP(await api.post('/visitors/passes/' + id + '/' + path, body || {})); setNo(null); onChanged(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  if (!p) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const st = PASS[p.status];
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet" role="dialog" aria-modal="true" aria-labelledby="vz-gp-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={p.status === 'rejected' ? { '--g1': '#475569', '--g2': '#334155' } : p.late ? { '--g1': '#b91c1c', '--g2': '#9d174d' } : { '--g1': '#7c2d12', '--g2': '#b45309' }}>
          <span className="x7-icon" aria-hidden="true">🚪</span>
          <div><small>{p.company}{p.requestedBy ? ' · ' + tr('asked by {name}', { name: p.requestedBy.name }) : ''}</small><h2 id="vz-gp-t">{tr('Gate pass {ref}', { ref: p.ref })}</h2>
            <p><span className="x7-pill">{st[0]} {tr(st[2])}</span><span className="x7-pill">{REASON[p.reason][0]} {tr(REASON[p.reason][1])}</span>{p.returnable && <span className="x7-pill">↩️ {tr('back by {date}', { date: dayText(p.backBy) })}</span>}</p></div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        <ul className="vz-items">{p.items.map((x, i) => <li key={i}><b>{x.qty} ×</b> {x.what}</li>)}</ul>
        <dl className="x7-facts">
          <div><dt>{tr('Taken by')}</dt><dd>{p.carrier || '—'}</dd></div>
          <div><dt>{tr('Vehicle')}</dt><dd>{p.vehicle || '—'}</dd></div>
          <div><dt>{tr('Approved')}</dt><dd>{p.approvedBy ? p.approvedBy + ' · ' + when(p.approvedAt) : '—'}</dd></div>
          <div><dt>{tr('Out of the gate')}</dt><dd>{when(p.outAt)}</dd></div>
          {p.returnable && <div><dt>{tr('Back in')}</dt><dd>{when(p.backAt)}</dd></div>}
        </dl>
        {p.note && <p className="x7-note">📝 {p.note}</p>}
        {p.rejectReason && <p className="x7-note">🚫 {p.rejectReason}</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {p.status === 'requested' && d.canApprove && (no === null ? (
          <div className="x7-actions"><button type="button" className="btn btn-primary" disabled={busy} onClick={() => run('decide', { approve: true })}>✅ {tr('Approve')}</button><button type="button" className="btn btn-secondary" onClick={() => setNo('')}>🚫 {tr('Turn it down')}</button></div>
        ) : (
          <form className="x7-form" onSubmit={(e) => { e.preventDefault(); run('decide', { approve: false, reason: no }); }}>
            <label><span>{tr('Why not?')}</span><input className="input" required value={no} onChange={(e) => setNo(e.target.value)} /></label>
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setNo(null)}>{tr('Back')}</button><button type="submit" className="btn btn-danger" disabled={busy}>{tr('Turn it down')}</button></div>
          </form>
        ))}
        {p.status === 'approved' && d.canDesk && <button type="button" className="btn btn-primary" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => run('out')}>🚚 {tr('Let it out')}</button>}
        {p.status === 'out' && p.returnable && d.canDesk && <button type="button" className="btn btn-primary" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => run('back')}>↩️ {tr('It is back')}</button>}
      </div>
    </div>
  );
}

function RollCall({ company, onClose }) {
  const [r, setR] = useState(null);
  const [seen, setSeen] = useState({});
  const [error, setError] = useState(null);
  useEffect(() => { api.get('/visitors/rollcall' + (company ? '?company=' + company : '')).then(setR).catch((e) => setError(e.message)); }, [company]);
  if (!r) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const count = Object.values(seen).filter(Boolean).length;
  const row = (key, name, sub) => (
    <label key={key} className={'vz-roll' + (seen[key] ? ' is-seen' : '')}><input type="checkbox" checked={!!seen[key]} onChange={(e) => setSeen({ ...seen, [key]: e.target.checked })} /><span><b>{name}</b><small>{sub}</small></span></label>
  );
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet is-wide vz-print" role="dialog" aria-modal="true" aria-labelledby="vz-r-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={{ '--g1': '#b91c1c', '--g2': '#c2410c' }}>
          <span className="x7-icon" aria-hidden="true">📣</span>
          <div><small>{tr('As at {time}', { time: when(r.at) })}</small><h2 id="vz-r-t">{tr('Who is on site')}</h2>
            <p><b>{r.total}</b><span className="x7-pill">✅ {tr('{c} of {n} accounted for', { c: count, n: r.total })}</span></p></div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        <div className="x7-sec"><h3>👷 {tr('Staff clocked in')} <span className="x7-muted">{r.staff.length}</span></h3>
          <div className="vz-rolls">{r.staff.map((s) => row('s' + s.id, s.name, [s.since ? tr('since {time}', { time: s.since }) : '', s.department, s.company].filter(Boolean).join(' · ')))}</div>
          {!r.staff.length && <p className="x7-muted">{tr('No one clocked in.')}</p>}</div>
        <div className="x7-sec"><h3>🛎️ {tr('Visitors')} <span className="x7-muted">{r.visitors.length}</span></h3>
          <div className="vz-rolls">{r.visitors.map((v) => row('v' + v.id, v.name, [v.badge, v.host ? tr('with {name}', { name: v.host.name }) : '', v.fromOrg, v.phone].filter(Boolean).join(' · ')))}</div>
          {!r.visitors.length && <p className="x7-muted">{tr('No visitor signed in.')}</p>}</div>
        <div className="x7-actions"><button type="button" className="btn btn-secondary is-end" onClick={() => window.print()}>🖨️ {tr('Print')}</button></div>
      </div>
    </div>
  );
}

function VisitorRow({ v, children }) {
  return (
    <div className="x7-row vz-row" style={{ cursor: 'default' }}>
      <span className="x7-avatar" style={{ '--h': hue(v.name) }} aria-hidden="true">{v.name.charAt(0)}</span>
      <span className="x7-who"><b>{v.name}{v.fromOrg ? ' · ' + v.fromOrg : ''}</b>
        <small>{PURPOSE[v.purpose][0]} {tr(PURPOSE[v.purpose][1])}{v.host ? ' · ' + tr('with {name}', { name: v.host.name }) : ''}{v.badge ? ' · 🪪 ' + v.badge : ''}{v.vehicle ? ' · 🚗 ' + v.vehicle : ''}</small></span>
      <span className="x7-muted">{v.status === 'in' ? tr('in since {time}', { time: time(v.arrivedAt) }) : v.status === 'out' ? time(v.arrivedAt) + ' – ' + time(v.leftAt) : v.expectedAt ? (v.expectedAt.slice(0, 10) === today() ? tr('at {time}', { time: time(v.expectedAt) }) : when(v.expectedAt)) : ''}</span>
      {children || <span />}
    </div>
  );
}

function Desk({ d, reload, onFlash }) {
  const [badges, setBadges] = useState({});
  const [busy, setBusy] = useState(false);
  async function run(path, body, done) {
    setBusy(true);
    try { const v = await api.post(path, body || {}); onFlash(done(v)); reload(); } catch (e) { onFlash('⚠️ ' + e.message); } finally { setBusy(false); }
  }
  const expected = d.today.filter((v) => v.status === 'expected'), inside = d.today.filter((v) => v.status === 'in'), gone = d.today.filter((v) => v.status === 'out');
  const max = Math.max(1, ...d.days.map((x) => x.visitors));
  return (
    <>
      <div className="x7-tiles">
        <div className="x7-tile is-calm"><small>🕓 {tr('Expected today')}</small><b>{d.summary.expected}</b><span>{tr('{n} more this week', { n: d.upcoming.length })}</span></div>
        <div className="x7-tile is-teal"><small>🛎️ {tr('On site now')}</small><b>{d.summary.inside}</b><span>{tr('signed in')}</span></div>
        <div className="x7-tile is-violet"><small>👋 {tr('Gone today')}</small><b>{d.summary.gone}</b><span>{tr('signed out')}</span></div>
        <div className="x7-tile vz-spark-tile"><small>📈 {tr('Two weeks')}</small>
          <span className="vz-spark" role="img" aria-label={tr('Visitors each day')}>{d.days.map((x) => <i key={x.day} style={{ height: Math.max(4, x.visitors / max * 100) + '%' }} title={dayText(x.day) + ': ' + x.visitors} />)}</span></div>
      </div>
      <section className="x7-card">
        <h2>🕓 {tr('Expected today')} <small>{expected.length}</small></h2>
        {!expected.length ? <p className="x7-muted">{tr('No one expected.')}</p> : <div className="x7-list">{expected.map((v) => (
          <VisitorRow key={v.id} v={v}>
            <span className="vz-sign"><input className="input" value={badges[v.id] || ''} onChange={(e) => setBadges({ ...badges, [v.id]: e.target.value })} placeholder={tr('Badge')} aria-label={tr('Badge')} />
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run('/visitors/in', { id: v.id, badge: badges[v.id] || '' }, (x) => '🛎️ ' + tr('{name} signed in; {host} is told.', { name: x.name, host: x.host ? x.host.name : '—' }))}>{tr('Sign in')}</button></span>
          </VisitorRow>
        ))}</div>}
      </section>
      <section className="x7-card">
        <h2>🛎️ {tr('On site now')} <small>{inside.length}</small></h2>
        {!inside.length ? <p className="x7-muted">{tr('No visitor on site.')}</p> : <div className="x7-list">{inside.map((v) => (
          <VisitorRow key={v.id} v={v}><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => run('/visitors/' + v.id + '/out', {}, (x) => '👋 ' + tr('{name} signed out.', { name: x.name }))}>{tr('Sign out')}</button></VisitorRow>
        ))}</div>}
      </section>
      {d.upcoming.length > 0 && <section className="x7-card"><h2>📅 {tr('Coming this week')}</h2><div className="x7-list">{d.upcoming.map((v) => <VisitorRow key={v.id} v={v} />)}</div></section>}
      {gone.length + d.history.length > 0 && <section className="x7-card"><h2>👋 {tr('Gone')}</h2><div className="x7-list">{gone.concat(d.history).slice(0, 12).map((v) => <VisitorRow key={v.id} v={v}><span className="x7-muted">{dayText(v.leftAt)}</span></VisitorRow>)}</div></section>}
    </>
  );
}

function Passes({ d, open }) {
  const groups = [['requested', tr('To approve')], ['approved', tr('Approved — waiting at the gate')], ['out', tr('Out, coming back')], ['done', tr('Lately')]];
  const pick = (k) => d.passes.filter((p) => (k === 'out' ? p.status === 'out' && p.returnable : k === 'done' ? p.status === 'back' || p.status === 'rejected' || (p.status === 'out' && !p.returnable) : p.status === k));
  return (
    <>
      <div className="x7-tiles">
        <div className="x7-tile is-warn"><small>🕓 {tr('To approve')}</small><b>{d.summary.toApprove}</b><span>{tr('waiting for a manager')}</span></div>
        <div className="x7-tile is-calm"><small>✅ {tr('At the gate')}</small><b>{d.summary.toGo}</b><span>{tr('approved, not out yet')}</span></div>
        <div className={'x7-tile ' + (d.summary.late ? 'is-bad' : 'is-violet')}><small>↩️ {tr('Out, coming back')}</small><b>{d.summary.outBack}</b><span>{d.summary.late ? tr('{n} late', { n: d.summary.late }) : tr('none late')}</span></div>
      </div>
      {groups.map(([k, label]) => {
        const list = k === 'out' ? pick(k).sort((x, y) => (y.late ? 1 : 0) - (x.late ? 1 : 0) || String(x.backBy).localeCompare(String(y.backBy))) : pick(k);
        if (!list.length) return null;
        return (
          <section key={k} className="x7-card">
            <h2>{label} <small>{list.length}</small></h2>
            <div className="x7-list">{list.map((p) => (
              <button key={p.id} type="button" className={'x7-row' + (p.late ? ' is-flag is-bad' : p.status === 'requested' ? ' is-flag is-warn' : '')} onClick={() => open(p.id)}>
                <span className="x7-icon" aria-hidden="true">{REASON[p.reason][0]}</span>
                <span className="x7-who"><b>{p.items.map((x) => x.qty + ' × ' + x.what).join(', ')}</b><small>{p.ref} · {tr(REASON[p.reason][1])}{p.carrier ? ' · ' + p.carrier : ''}{p.vehicle ? ' · 🚗 ' + p.vehicle : ''}{p.requestedBy ? ' · ' + p.requestedBy.name : ''}</small></span>
                <span className={'x7-pill ' + PASS[p.status][1]}>{PASS[p.status][0]} {tr(PASS[p.status][2])}</span>
                <span className="x7-muted">{p.returnable ? (p.late ? '⏰ ' : '') + tr('back by {date}', { date: dayText(p.backBy) }) : dayText(p.createdAt)}</span>
              </button>
            ))}</div>
          </section>
        );
      })}
      {!d.passes.length && <div className="x7-empty"><span aria-hidden="true">🚪</span><p>{tr('No gate pass yet.')}</p></div>}
    </>
  );
}

export default function VisitorsPage() {
  const [params, setParams] = useSearchParams();
  const [company, setCompany] = useState('');
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [dlg, setDlg] = useState('');
  const [flash, setFlash] = useState(null);
  const load = useCallback(() => api.get('/visitors' + (company ? '?company=' + company : '')).then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), [company]);
  useEffect(() => { load(); }, [load]);
  const passId = params.get('pass');
  const tab = params.get('tab') || (passId ? 'passes' : '');
  const go = (next) => setParams(next);
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const view = tab === 'passes' || !d.canDesk ? 'passes' : 'desk';
  return (
    <div className="x7">
      <header className="x7-head">
        <div>
          <h1>🛎️ {tr('Visitors and gate passes')}</h1>
          <p>{tr('Visitors signed in and out at the desk, their host told; who is on site now; goods leaving on an approved gate pass, let out and checked back in.')}</p>
        </div>
        <div className="x7-head-actions">
          {d.canDesk && <button type="button" className="btn btn-secondary" onClick={() => setDlg('roll')}>📣 {tr('Who is on site')}</button>}
          <button type="button" className="btn btn-secondary" onClick={() => setDlg('pass')}>🚪 {tr('A gate pass')}</button>
          {d.canDesk && <button type="button" className="btn btn-primary" onClick={() => setDlg('walkin')}>🛎️ {tr('Sign someone in')}</button>}
        </div>
      </header>
      <div className="x7-bar">
        {d.canDesk ? <div className="x7-seg" role="tablist">
          <button type="button" role="tab" aria-selected={view === 'desk'} className={view === 'desk' ? 'is-on' : ''} onClick={() => go({})}>🛎️ {tr('Front desk')}{d.summary.inside ? <i>{d.summary.inside}</i> : null}</button>
          <button type="button" role="tab" aria-selected={view === 'passes'} className={view === 'passes' ? 'is-on' : ''} onClick={() => go({ tab: 'passes' })}>🚪 {tr('Gate passes')}{d.summary.toApprove + d.summary.toGo ? <i>{d.summary.toApprove + d.summary.toGo}</i> : null}</button>
        </div> : <span />}
        <div className="x7-chips">
          <button type="button" className={!company ? 'is-on' : ''} onClick={() => setCompany('')}>{tr('All companies')}</button>
          {d.companies.map((c) => <button key={c.id} type="button" className={company === c.id ? 'is-on' : ''} onClick={() => setCompany(c.id)}>{c.name}</button>)}
        </div>
      </div>
      {flash && <div className="x7-flash" role="status">{flash}</div>}
      {view === 'desk' ? <Desk d={d} reload={load} onFlash={setFlash} /> : <Passes d={d} open={(id) => go({ tab: 'passes', pass: id })} />}
      {dlg === 'walkin' && <WalkIn d={d} onClose={() => setDlg('')} onDone={(v) => { setDlg(''); setFlash('🛎️ ' + tr('{name} signed in; {host} is told.', { name: v.name, host: v.host ? v.host.name : '—' })); load(); }} />}
      {dlg === 'pass' && <PassForm d={d} onClose={() => setDlg('')} onDone={(p) => { setDlg(''); load(); go({ tab: 'passes', pass: p.id }); }} />}
      {dlg === 'roll' && <RollCall company={company} onClose={() => setDlg('')} />}
      {passId && <PassSheet key={passId} id={passId} d={d} onClose={() => go({ tab: 'passes' })} onChanged={load} />}
    </div>
  );
}

// My space: someone coming to see me — add them, send their pass; who is here.
export function MyVisitorsCard() {
  const [d, setD] = useState(null);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: '', phone: '', fromOrg: '', purpose: 'meeting', expectedAt: soon() });
  const [made, setMade] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const load = useCallback(() => api.get('/visitors/mine').then(setD).catch(() => setD(null)), []);
  useEffect(() => { load(); }, [load]);
  if (!d) return null;
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { const v = await api.post('/visitors/expect', { ...f, expectedAt: new Date(f.expectedAt).toISOString() }); setMade(v); setAdding(false); setF({ name: '', phone: '', fromOrg: '', purpose: 'meeting', expectedAt: soon() }); load(); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function cancel(id) { try { await api.post('/visitors/' + id + '/cancel', {}); load(); } catch { /* shown on the next load */ } }
  const message = made ? tr('Your visitor pass for {when}: {link}', { when: when(made.expectedAt), link: passUrl(made.code) }) : '';
  return (
    <div className="msx-card x7-mine">
      <h4 className="msp-h4">🛎️ {tr('My visitors')}</h4>
      <div className="x7-mine-top" style={{ '--tone': 'var(--x7-calm)' }}>
        <span><small>{tr('Expecting someone?')}</small><b>{tr('Add them; the gate knows')}</b></span>
        {!adding && <button type="button" className="btn btn-primary" onClick={() => { setAdding(true); setMade(null); }}>➕ {tr('Add a visitor')}</button>}
      </div>
      {adding && (
        <form className="x7-form" onSubmit={save}>
          <div className="x7-grid2">
            <label><span>{tr('Full name')}</span><input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label><span>{tr('Phone')}</span><input className="input" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
            <label><span>{tr('From (company)')}</span><input className="input" value={f.fromOrg} onChange={(e) => setF({ ...f, fromOrg: e.target.value })} /></label>
            <label><span>{tr('When')}</span><input className="input" type="datetime-local" required value={f.expectedAt} onChange={(e) => setF({ ...f, expectedAt: e.target.value })} /></label>
          </div>
          <div className="x7-chips">{Object.entries(PURPOSE).map(([k, [ic, l]]) => <button key={k} type="button" className={f.purpose === k ? 'is-on' : ''} onClick={() => setF({ ...f, purpose: k })}><em aria-hidden="true">{ic}</em>{tr(l)}</button>)}</div>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setAdding(false)}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Add')}</button></div>
        </form>
      )}
      {made && (
        <div className="x7-flash vz-made" role="status">
          <span>🎟️ {tr('{name}\'s pass is ready: send it so they show it at the gate.', { name: made.name })}</span>
          <span className="vz-made-actions">
            <button type="button" className="btn btn-secondary" onClick={() => { if (navigator.clipboard) navigator.clipboard.writeText(passUrl(made.code)).catch(() => {}); }}>🔗 {tr('Copy the link')}</button>
            <a className="btn btn-secondary" href={'https://wa.me/' + String(made.phone || '').replace(/\D/g, '').replace(/^0/, '233') + '?text=' + encodeURIComponent(message)} target="_blank" rel="noreferrer">💬 {tr('WhatsApp it')}</a>
          </span>
        </div>
      )}
      {d.visitors.length > 0 && <ul className="x7-mine-list">{d.visitors.map((v) => (
        <li key={v.id}>
          <span aria-hidden="true">{PURPOSE[v.purpose][0]}</span>
          <span><b>{v.name}{v.fromOrg ? ' · ' + v.fromOrg : ''}</b><small>{v.status === 'in' ? '🛎️ ' + tr('here since {time}', { time: time(v.arrivedAt) }) : v.status === 'out' ? tr('left {time}', { time: time(v.leftAt) }) : when(v.expectedAt)}</small></span>
          {v.status === 'expected' && <button type="button" className="x7-link" onClick={() => cancel(v.id)}>{tr('Cancel')}</button>}
        </li>
      ))}</ul>}
    </div>
  );
}
