import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { api, API_URL } from '../api/client';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import { shrinkPhoto } from './till/photoShrink';
import './seventeenth.css';

// Training and certificates (People → Training and certificates; backend
// training.service.js, migration 0198): who holds which certificate, which
// each company needs, what is missing or running out; each person's with a
// photo; training sessions, those who came given the certificate. Staff add
// their own from My space, a manager checks them.

function dayText(d, opts) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC', ...opts }) : '—'; }
// The starting five (migration 0198) in the reader's language; names added
// in the OS stay as they were typed.
const STARTERS = [msg('Food handler\'s health certificate'), msg('Fire safety'), msg('First aid'), msg('Forklift licence'), msg('Driving licence')];
function tn(name) { return STARTERS.includes(name) ? tr(name) : name; }
function hue(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function today() { return new Date().toISOString().slice(0, 10); }
function leftText(c) {
  if (c.state === 'missing') return tr('missing');
  if (c.daysLeft == null) return tr('no end date');
  if (c.daysLeft < 0) return tr('ran out {n} days ago', { n: -c.daysLeft });
  if (c.daysLeft === 0) return tr('runs out today');
  return c.state === 'soon' ? tr('{n} days left', { n: c.daysLeft }) : tr('until {date}', { date: dayText(c.expiresOn) });
}
const ICON = { ok: '✅', soon: '⏳', expired: '⛔', missing: '❗' };

function Thumb({ id }) {
  const [url, setUrl] = useState(null);
  const [big, setBig] = useState(false);
  useEffect(() => {
    let made = null, live = true;
    fetch(API_URL + '/training/certs/' + id + '/photo', { headers: api.authHeaders() }).then((r) => (r.ok ? r.blob() : null)).then((b) => { if (b && live) { made = URL.createObjectURL(b); setUrl(made); } }).catch(() => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [id]);
  if (!url) return <span className="tr-thumb" aria-hidden="true" />;
  return (
    <>
      <button type="button" className="tr-thumb" onClick={() => setBig(true)} aria-label={tr('See the certificate')}><img src={url} alt="" /></button>
      {big && createPortal(<div className="x7-zoom" onClick={() => setBig(false)} role="dialog" aria-label={tr('Certificate')}><img src={url} alt={tr('Certificate')} /></div>, document.body)}
    </>
  );
}

export function CertForm({ types, employeeId, onDone, onCancel, mine }) {
  const [f, setF] = useState({ typeId: (types[0] || {}).id || '', number: '', issuer: '', issuedOn: '', expiresOn: '', photo: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const ty = types.find((t) => t.id === f.typeId);
  async function pick(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try { const p = await shrinkPhoto(file); setF((x) => ({ ...x, photo: p })); } catch { setError(tr('That file is not a photo.')); }
  }
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.post('/training/certs', { ...f, employeeId })); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <form className="x7-form" onSubmit={save}>
      <h3>📜 {tr('Add a certificate')}</h3>
      <div className="x7-chips">{types.map((t) => <button key={t.id} type="button" className={f.typeId === t.id ? 'is-on' : ''} onClick={() => setF({ ...f, typeId: t.id })}>{tn(t.name)}</button>)}</div>
      <div className="x7-grid2">
        <label><span>{tr('Number')}</span><input className="input" value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} placeholder={tr('Optional')} /></label>
        <label><span>{tr('Issued by')}</span><input className="input" value={f.issuer} onChange={(e) => setF({ ...f, issuer: e.target.value })} placeholder={tr('Optional')} /></label>
        <label><span>{tr('Issued on')}</span><input className="input" type="date" max={today()} value={f.issuedOn} onChange={(e) => setF({ ...f, issuedOn: e.target.value })} />{ty && ty.validMonths ? <small>{tr('Valid {n} months from then', { n: ty.validMonths })}</small> : null}</label>
        <label><span>{tr('Runs out on')}</span><input className="input" type="date" value={f.expiresOn} onChange={(e) => setF({ ...f, expiresOn: e.target.value })} /><small>{tr('Empty: worked out from the day it was issued.')}</small></label>
      </div>
      <label className={'x7-drop' + (f.photo ? ' is-set' : '')}><input type="file" accept="image/*" capture="environment" onChange={pick} /><em aria-hidden="true">{f.photo ? '✅' : '📸'}</em><span>{f.photo ? tr('Photo added — tap to change') : tr('A photo of the certificate')}</span></label>
      {mine && <p className="x7-muted">{tr('Your manager checks it before it counts.')}</p>}
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onCancel}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy || !f.typeId}>{tr('Save')}</button></div>
    </form>
  );
}

function CertRow({ c, manage, onVerify, onRemove }) {
  return (
    <div className="tr-cert">
      {c.hasPhoto ? <Thumb id={c.id} /> : <span className="x7-icon" aria-hidden="true">📜</span>}
      <span className="x7-who"><b>{tn(c.type)}{!c.verified ? ' · ' + tr('to check') : ''}</b><small>{[c.number, c.issuer, c.issuedOn ? tr('issued {date}', { date: dayText(c.issuedOn) }) : null].filter(Boolean).join(' · ') || '—'}</small></span>
      <span className={'x7-pill ' + (c.state === 'ok' ? 'is-good' : c.state === 'soon' ? 'is-warn' : 'is-bad')}>{ICON[c.state]} {leftText(c)}</span>
      <span className="x7-actions">
        {manage && !c.verified && <button type="button" className="btn btn-secondary" onClick={() => onVerify(c.id)}>✔️ {tr('Checked')}</button>}
        {onRemove && <button type="button" className="x7-link" onClick={() => onRemove(c.id)} aria-label={tr('Remove')}>✕</button>}
      </span>
    </div>
  );
}

function PersonSheet({ id, onClose, onChanged }) {
  const [p, setP] = useState(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(null);
  const load = useCallback(() => api.get('/training/people/' + id).then(setP).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  async function verify(cid) { try { setP(await api.post('/training/certs/' + cid + '/verify', {})); onChanged(); } catch (e) { setError(e.message); } }
  async function remove(cid) { try { setP(await api.del('/training/certs/' + cid)); onChanged(); } catch (e) { setError(e.message); } }
  if (!p) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const bad = p.certs.some((c) => c.state === 'expired') || p.missing.length;
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet" role="dialog" aria-modal="true" aria-labelledby="tr-p-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={bad ? { '--g1': '#b91c1c', '--g2': '#db2777' } : { '--g1': '#0f766e', '--g2': '#2563eb' }}>
          <span className="x7-avatar" style={{ '--h': hue(p.person.name) }} aria-hidden="true">{p.person.name.charAt(0)}</span>
          <div><small>{p.person.position || p.person.code} · {p.person.company}</small><h2 id="tr-p-t">{p.person.name}</h2>
            <p><span className="x7-pill">📜 {p.certs.length === 1 ? tr('1 certificate') : tr('{n} certificates', { n: p.certs.length })}</span>{p.missing.length > 0 && <span className="x7-pill">❗ {tr('{n} missing', { n: p.missing.length })}</span>}</p></div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        {p.missing.length > 0 && <p className="x7-note">❗ {tr('Needed in their company and not on record: {list}', { list: p.missing.map((m) => tn(m.name)).join(', ') })}</p>}
        <div className="x7-list">{p.certs.map((c) => <CertRow key={c.id} c={c} manage={p.canManage} onVerify={verify} onRemove={p.canManage ? remove : null} />)}</div>
        {!p.certs.length && <p className="x7-muted">{tr('No certificate yet.')}</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {adding ? <CertForm types={p.types} employeeId={p.person.id} onCancel={() => setAdding(false)} onDone={(x) => { setP(x); setAdding(false); onChanged(); }} />
          : <button type="button" className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={() => setAdding(true)}>➕ {tr('Add a certificate')}</button>}
        {p.sessions.length > 0 && (
          <div className="x7-sec"><h3>🎓 {tr('Training')}</h3>
            {p.sessions.map((s) => <div key={s.id} className="tr-att"><span className="x7-who"><b>{s.title}</b><small>{dayText(s.day)}{s.trainer ? ' · ' + s.trainer : ''}</small></span><span className={'x7-pill ' + (s.status === 'attended' ? 'is-good' : s.status === 'missed' ? 'is-bad' : 'is-calm')}>{s.status === 'attended' ? '✅ ' + tr('Came') : s.status === 'missed' ? '✖ ' + tr('Missed') : '📨 ' + tr('Invited')}</span></div>)}
          </div>
        )}
      </div>
    </div>
  );
}

function SessionSheet({ id, onClose, onChanged }) {
  const [s, setS] = useState(null);
  const [marks, setMarks] = useState({});
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { api.get('/training/sessions/' + id).then((x) => { setS(x); setMarks(Object.fromEntries(x.attendees.map((a) => [a.id, a.status]))); }).catch((e) => setError(e.message)); }, [id]);
  async function save() {
    setBusy(true); setError(null);
    try { const x = await api.post('/training/sessions/' + id + '/attendance', { marks }); setS(x); setFlash('✅ ' + tr('Saved.') + (x.given ? ' ' + tr('{n} certificates given.', { n: x.given }) : '')); onChanged(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  if (!s) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const past = s.day <= today();
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet" role="dialog" aria-modal="true" aria-labelledby="tr-s-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={{ '--g1': '#7c3aed', '--g2': '#0f766e' }}>
          <span className="x7-icon" aria-hidden="true">🎓</span>
          <div><small>{dayText(s.day, { weekday: 'long' })}{s.starts ? ' · ' + s.starts : ''}{s.hours ? ' · ' + tr('{n} h', { n: s.hours }) : ''}</small><h2 id="tr-s-t">{s.title}</h2>
            <p>{s.type && <span className="x7-pill">📜 {tn(s.type)}</span>}<span className="x7-pill">👥 {tr('{c} of {n} came', { c: s.came, n: s.invited })}</span></p></div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        {(s.trainer || s.location) && <p className="x7-note">🧑‍🏫 {[s.trainer, s.location].filter(Boolean).join(' · ')}</p>}
        <div className="x7-list">
          {s.attendees.map((a) => (
            <div key={a.id} className="tr-att">
              <span className="x7-who"><b>{a.name}</b><small>{a.position}</small></span>
              {past ? (
                <span className="x7-seg">{[['attended', '✅ ' + tr('Came')], ['missed', '✖ ' + tr('Missed')]].map(([k, l]) => <button key={k} type="button" className={marks[a.id] === k ? 'is-on' : ''} onClick={() => setMarks({ ...marks, [a.id]: k })}>{l}</button>)}</span>
              ) : <span className="x7-pill is-calm">📨 {tr('Invited')}</span>}
            </div>
          ))}
        </div>
        {flash && <div className="x7-flash" role="status">{flash}</div>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {past && <div className="x7-actions"><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{tr('Save who came')}</button>{s.type && <span className="x7-muted">{tr('Those who came get the certificate.')}</span>}</div>}
      </div>
    </div>
  );
}

function SessionForm({ d, onClose, onDone }) {
  const [f, setF] = useState({ title: '', typeId: '', companyId: d.company || '', day: today(), starts: '09:00', hours: '', location: '', trainer: '', employeeIds: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const staff = d.staff.filter((p) => !f.companyId || p.companyId === f.companyId);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.post('/training/sessions', f)); } catch (err) { setError(err.message); setBusy(false); }
  }
  const toggle = (id) => setF({ ...f, employeeIds: f.employeeIds.includes(id) ? f.employeeIds.filter((x) => x !== id) : [...f.employeeIds, id] });
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" style={{ width: 'min(700px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="tr-sf-t" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">🎓</span><div><h2 id="tr-sf-t">{tr('Plan a training')}</h2><p>{tr('Those invited are told; those who come get its certificate.')}</p></div></div>
        <div className="x7-grid2">
          <label><span>{tr('What')}</span><input className="input" required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder={tr('e.g. Fire safety refresher')} /></label>
          <label><span>{tr('Gives the certificate')}</span><select className="input" value={f.typeId} onChange={(e) => setF({ ...f, typeId: e.target.value })}><option value="">—</option>{d.types.map((t) => <option key={t.id} value={t.id}>{tn(t.name)}</option>)}</select></label>
        </div>
        <div className="x7-grid3">
          <label><span>{tr('Day')}</span><input className="input" type="date" required value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} /></label>
          <label><span>{tr('Starts')}</span><input className="input" type="time" value={f.starts} onChange={(e) => setF({ ...f, starts: e.target.value })} /></label>
          <label><span>{tr('Hours')}</span><input className="input" type="number" min="0.5" step="0.5" value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} /></label>
          <label><span>{tr('Where')}</span><input className="input" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></label>
          <label><span>{tr('Trainer')}</span><input className="input" value={f.trainer} onChange={(e) => setF({ ...f, trainer: e.target.value })} /></label>
        </div>
        <div className="x7-chips">
          <button type="button" className={!f.companyId ? 'is-on' : ''} onClick={() => setF({ ...f, companyId: '' })}>{tr('Everyone')}</button>
          {d.companies.map((c) => <button key={c.id} type="button" className={f.companyId === c.id ? 'is-on' : ''} onClick={() => setF({ ...f, companyId: c.id })}>{c.name}</button>)}
        </div>
        <span className="x7-muted">{tr('Who is invited ({n})', { n: f.employeeIds.length })} · <button type="button" className="x7-link" onClick={() => setF({ ...f, employeeIds: staff.map((p) => p.id) })}>{tr('Everyone shown')}</button></span>
        <div className="x7-chips" style={{ maxHeight: 180, overflowY: 'auto' }}>{staff.map((p) => <button key={p.id} type="button" className={f.employeeIds.includes(p.id) ? 'is-on' : ''} onClick={() => toggle(p.id)}>{p.name}</button>)}</div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Plan it')}</button></div>
      </form>
    </div>
  );
}

function TypesDialog({ d, onClose, onDone }) {
  const [f, setF] = useState({ name: '', validMonths: '', requiredFor: [] });
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  function pick(t) { setEdit(t.id); setF({ id: t.id, name: t.name, validMonths: t.validMonths == null ? '' : String(t.validMonths), requiredFor: t.requiredFor }); }
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.post('/training/types', f)); setF({ name: '', validMonths: '', requiredFor: [] }); setEdit(null); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const toggle = (id) => setF({ ...f, requiredFor: f.requiredFor.includes(id) ? f.requiredFor.filter((x) => x !== id) : [...f.requiredFor, id] });
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" role="dialog" aria-modal="true" aria-labelledby="tr-t-t" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">📜</span><div><h2 id="tr-t-t">{tr('Certificates')}</h2><p>{tr('How long each is valid, and which companies need it.')}</p></div></div>
        <div className="x7-list">{d.types.map((t) => (
          <button key={t.id} type="button" className={'x7-row' + (edit === t.id ? ' is-flag is-calm' : '')} onClick={() => pick(t)}>
            <span className="x7-icon" aria-hidden="true">📜</span>
            <span className="x7-who"><b>{tn(t.name)}</b><small>{t.validMonths ? tr('valid {n} months', { n: t.validMonths }) : tr('no fixed term')}</small></span>
            <span className="x7-muted">{t.requiredFor.length ? d.companies.filter((c) => t.requiredFor.includes(c.id)).map((c) => c.code).join(', ') : tr('not required')}</span><span />
          </button>
        ))}</div>
        <div className="x7-form">
          <h3>{edit ? '✏️ ' + tr('Change') : '➕ ' + tr('A new certificate')}</h3>
          <div className="x7-grid2">
            <label><span>{tr('Name')}</span><input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label><span>{tr('Valid for (months)')}</span><input className="input" type="number" min="1" value={f.validMonths} onChange={(e) => setF({ ...f, validMonths: e.target.value })} placeholder={tr('Empty: no fixed term')} /></label>
          </div>
          <span className="x7-muted">{tr('Needed by everyone in')}</span>
          <div className="x7-chips">{d.companies.map((c) => <button key={c.id} type="button" className={f.requiredFor.includes(c.id) ? 'is-on' : ''} onClick={() => toggle(c.id)}>{c.name}</button>)}</div>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save')}</button></div>
      </form>
    </div>
  );
}

export default function TrainingPage() {
  const [params, setParams] = useSearchParams();
  const [company, setCompany] = useState('');
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [dlg, setDlg] = useState('');
  const [pickFor, setPickFor] = useState('');
  const load = useCallback(() => api.get('/training' + (company ? '?company=' + company : '')).then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), [company]);
  useEffect(() => { load(); }, [load]);
  const personId = params.get('person'), sessionId = params.get('session');
  const go = (k, v) => setParams(v ? { [k]: v } : {});
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const c = d.counts;
  // The certificates needed where we look (or held by someone shown).
  const cols = d.types.filter((t) => (company ? t.requiredFor.includes(company) : t.requiredFor.length) || d.people.some((p) => p.cells[t.id]));
  return (
    <div className="x7">
      <header className="x7-head">
        <div>
          <h1>🎓 {tr('Training and certificates')}</h1>
          <p>{tr('Who holds which certificate, what each company needs, what is missing or running out; training sessions and who came.')}</p>
        </div>
        <div className="x7-head-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setDlg('types')}>📜 {tr('Certificates')}</button>
          <button type="button" className="btn btn-secondary" onClick={() => setDlg('session')}>🎓 {tr('Plan a training')}</button>
          <button type="button" className="btn btn-primary" onClick={() => setDlg('pick')}>➕ {tr('Add a certificate')}</button>
        </div>
      </header>
      <div className="x7-chips">
        <button type="button" className={!company ? 'is-on' : ''} onClick={() => setCompany('')}>{tr('All companies')}</button>
        {d.companies.map((x) => <button key={x.id} type="button" className={company === x.id ? 'is-on' : ''} onClick={() => setCompany(x.id)}>{x.name}</button>)}
      </div>
      <div className="x7-tiles">
        <div className="x7-tile is-good"><small>✅ {tr('Valid')}</small><b>{c.ok}</b><span>{tr('certificates')}</span></div>
        <div className="x7-tile is-warn"><small>⏳ {tr('Running out')}</small><b>{c.soon}</b><span>{tr('in the next 30 days')}</span></div>
        <div className="x7-tile is-bad"><small>⛔ {tr('Ran out')}</small><b>{c.expired}</b><span>{tr('renew them')}</span></div>
        <div className="x7-tile is-violet"><small>❗ {tr('Missing')}</small><b>{c.missing}</b><span>{tr('needed and not on record')}</span></div>
        <div className="x7-tile is-calm"><small>🔍 {tr('To check')}</small><b>{c.unverified}</b><span>{tr('added by staff')}</span></div>
      </div>
      {d.due.length > 0 && (
        <section className="x7-card">
          <h2>⏰ {tr('Running out and ran out')}</h2>
          <div className="x7-list">{d.due.map((x) => (
            <button key={x.id} type="button" className={'x7-row is-flag ' + (x.state === 'expired' ? 'is-bad' : 'is-warn')} onClick={() => go('person', x.employeeId)}>
              <span className="x7-avatar" style={{ '--h': hue(x.employee) }} aria-hidden="true">{x.employee.charAt(0)}</span>
              <span className="x7-who"><b>{x.employee}</b><small>{tn(x.type)}{x.number ? ' · ' + x.number : ''}</small></span>
              <span className={'x7-pill ' + (x.state === 'expired' ? 'is-bad' : 'is-warn')}>{ICON[x.state]} {leftText(x)}</span><span />
            </button>
          ))}</div>
        </section>
      )}
      {d.unverified.length > 0 && (
        <section className="x7-card">
          <h2>🔍 {tr('Added by staff, to check')}</h2>
          <div className="x7-list">{d.unverified.map((x) => (
            <button key={x.id} type="button" className="x7-row" onClick={() => go('person', x.employeeId)}>
              <span className="x7-avatar" style={{ '--h': hue(x.employee) }} aria-hidden="true">{x.employee.charAt(0)}</span>
              <span className="x7-who"><b>{x.employee}</b><small>{tn(x.type)}{x.expiresOn ? ' · ' + tr('until {date}', { date: dayText(x.expiresOn) }) : ''}</small></span>
              <span className="x7-pill is-calm">🔍 {tr('To check')}</span><span />
            </button>
          ))}</div>
        </section>
      )}
      <h2 className="x7-h2">👥 {tr('Who holds what')} <small>{tr('{n} people', { n: d.people.length })}</small></h2>
      <div className="tr-matrix-wrap">
        <table className="tr-matrix">
          <thead><tr><th>{tr('Person')}</th>{cols.map((t) => <th key={t.id}>{tn(t.name)}</th>)}</tr></thead>
          <tbody>
            {d.people.map((p) => (
              <tr key={p.id}>
                <td><button type="button" onClick={() => go('person', p.id)}><b>{p.name}</b><small>{p.position || p.code} · {p.company}</small></button></td>
                {cols.map((t) => {
                  const cell = p.cells[t.id];
                  if (!cell) return <td key={t.id}><span className="tr-none">·</span></td>;
                  return <td key={t.id}><span className={'tr-cell is-' + cell.state + (cell.state !== 'missing' && !cell.verified ? ' is-unchecked' : '')} title={leftText(cell)}>{ICON[cell.state]}<small>{cell.state === 'missing' ? tr('missing') : cell.expiresOn ? dayText(cell.expiresOn, { year: '2-digit' }) : tr('no end')}</small></span></td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="x7-muted">✅ {tr('valid')} · ⏳ {tr('runs out within 30 days')} · ⛔ {tr('ran out')} · ❗ {tr('needed, missing')} · {tr('dashed: added by staff, to check')}</p>
      {d.sessions.length > 0 && (
        <section className="x7-card">
          <h2>🎓 {tr('Training sessions')}</h2>
          <div className="x7-list">{d.sessions.map((s) => (
            <button key={s.id} type="button" className="x7-row" onClick={() => go('session', s.id)}>
              <span className="x7-icon" aria-hidden="true">{s.upcoming ? '📅' : '🎓'}</span>
              <span className="x7-who"><b>{s.title}</b><small>{dayText(s.day)}{s.starts ? ' · ' + s.starts : ''}{s.trainer ? ' · ' + s.trainer : ''}{s.type ? ' · 📜 ' + tn(s.type) : ''}</small></span>
              <span className={'x7-pill ' + (s.upcoming ? 'is-calm' : 'is-good')}>{s.upcoming ? '📨 ' + tr('{n} invited', { n: s.invited }) : '👥 ' + tr('{c} of {n} came', { c: s.came, n: s.invited })}</span><span />
            </button>
          ))}</div>
        </section>
      )}
      {dlg === 'pick' && (
        <div className="dialog-backdrop" onClick={() => setDlg('')}>
          <div className="dialog x7-dlg" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">📜</span><div><h2>{tr('Add a certificate')}</h2><p>{tr('Whose is it?')}</p></div></div>
            <select className="input" value={pickFor} onChange={(e) => setPickFor(e.target.value)}><option value="">—</option>{d.staff.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setDlg('')}>{tr('Cancel')}</button><button type="button" className="btn btn-primary" disabled={!pickFor} onClick={() => { setDlg(''); go('person', pickFor); }}>{tr('Next')}</button></div>
          </div>
        </div>
      )}
      {dlg === 'session' && <SessionForm d={d} onClose={() => setDlg('')} onDone={(x) => { setDlg(''); load(); go('session', x.id); }} />}
      {dlg === 'types' && <TypesDialog d={d} onClose={() => setDlg('')} onDone={(x) => setD(x)} />}
      {personId && <PersonSheet key={personId} id={personId} onClose={() => go('person', null)} onChanged={load} />}
      {sessionId && <SessionSheet key={sessionId} id={sessionId} onClose={() => go('session', null)} onChanged={load} />}
    </div>
  );
}

// My space: my certificates (add one with its photo), my training.
export function MyCertsCard() {
  const [d, setD] = useState(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => api.get('/training/mine').then(setD).catch(() => setD(null)), []);
  useEffect(() => { load(); }, [load]);
  if (!d) return null;
  const upcoming = d.sessions.filter((s) => s.upcoming);
  const due = d.certs.filter((c) => c.state !== 'ok').length + d.missing.length;
  return (
    <div className="msx-card x7-mine">
      <h4 className="msp-h4">📜 {tr('My certificates')}</h4>
      <div className="x7-mine-top" style={{ '--tone': due ? 'var(--x7-warn)' : 'var(--x7-good)' }}>
        <span><small>{due ? tr('Needs your attention') : tr('All in order')}</small><b>{d.certs.length === 1 ? tr('1 certificate') : tr('{n} certificates', { n: d.certs.length })}</b>{d.missing.length > 0 && <small>❗ {tr('Needed: {list}', { list: d.missing.map((m) => m.name).join(', ') })}</small>}</span>
        {!adding && <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>➕ {tr('Add one')}</button>}
      </div>
      {adding && <CertForm types={d.types} mine onCancel={() => setAdding(false)} onDone={(x) => { setD(x); setAdding(false); }} />}
      {d.certs.length > 0 && (
        <ul className="x7-mine-list">
          {d.certs.slice(0, 5).map((c) => (
            <li key={c.id}>
              <span><b>{tn(c.type)}</b><small>{c.verified ? '' : tr('to check') + ' · '}{c.number || ''}</small></span>
              <span className={'x7-pill ' + (c.state === 'ok' ? 'is-good' : c.state === 'soon' ? 'is-warn' : 'is-bad')} style={{ flex: 'none' }}>{ICON[c.state]} {leftText(c)}</span>
            </li>
          ))}
        </ul>
      )}
      {upcoming.length > 0 && <p className="x7-note">🎓 {tr('Training: {title}, {date}', { title: upcoming[0].title, date: dayText(upcoming[0].day) + (upcoming[0].starts ? ' ' + upcoming[0].starts : '') })}</p>}
    </div>
  );
}
