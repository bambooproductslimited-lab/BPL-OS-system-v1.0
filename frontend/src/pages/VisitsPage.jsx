import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { api, API_URL } from '../api/client';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import SignaturePad, { SignatureView } from '../components/SignaturePad';
import { shrinkPhoto } from './till/photoShrink';
import './VisitsPage.css';

// Bamboo Products' deliveries, fitting and repairs (backend bplVisits,
// migration 0195). The week's visits on a calendar; what waits for one —
// shop orders to deliver, sales orders, repair requests — planned for a day,
// a time window and a crew (the customer told); a visit moved on by its
// crew on their phone: on the way, there, done with a signature and photos,
// or could not be done. Repairs asked for from an order's page: under
// warranty or not, answered, a repair visit planned.

const KIND = { delivery: ['🚚', msg('Delivery')], install: ['🛠️', msg('Fitting')], repair: ['🔧', msg('Repair')] };
const STATUS = { planned: ['🗓️', msg('Planned')], on_way: ['🚚', msg('On the way')], arrived: ['📍', msg('There')], done: ['✅', msg('Done')], failed: ['⚠️', msg('Could not be done')], cancelled: ['✕', msg('Cancelled')] };
const SERVICE = { new: ['🆕', msg('New')], visit: ['🗓️', msg('Visit planned')], fixed: ['✅', msg('Fixed')], closed: ['📁', msg('Closed')] };
function addDays(day, n) { return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
function dayHead(day) { return new Date(day + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); }
function untilDay(day) { return new Date(day + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); }
function dayLong(day) { return new Date(day + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }); }
function when(iso) { return new Date(iso).toLocaleString(activeIntlLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
function initials(name) { return String(name || '?').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase(); }
function hue(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }

// A photo the API keeps behind the sign-in.
function SecureImg({ path, label }) {
  const [url, setUrl] = useState(null);
  const [big, setBig] = useState(false);
  useEffect(() => {
    let live = true, made = null;
    fetch(API_URL + path, { headers: api.authHeaders() }).then((r) => (r.ok ? r.blob() : null)).then((b) => { if (b && live) { made = URL.createObjectURL(b); setUrl(made); } }).catch(() => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [path]);
  if (!url) return <span className="vz-thumb is-empty" aria-hidden="true">📷</span>;
  return (
    <>
      <button type="button" className="vz-thumb" onClick={() => setBig(true)} aria-label={label}><img src={url} alt="" /></button>
      {big && createPortal(<div className="vz-zoom" onClick={() => setBig(false)} role="dialog" aria-label={label}><img src={url} alt="" /></div>, document.body)}
    </>
  );
}

function Crew({ crew }) {
  return <span className="vz-crew">{crew.map((c) => <i key={c.id} style={{ '--h': hue(c.name) }} title={c.name}>{initials(c.name)}</i>)}</span>;
}

// Planning a visit (new, or changed).
function PlanDialog({ start, data, onClose, onSaved }) {
  const [v, setV] = useState(start);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (patch) => setV({ ...v, ...patch });
  const windows = data.settings.windows;
  const toggle = (id) => set({ crew: v.crew.indexOf(id) >= 0 ? v.crew.filter((x) => x !== id) : v.crew.concat([id]) });
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onSaved(await api.post('/visits', { ...v, items: v.items.filter((x) => x.description.trim()).map((x) => ({ description: x.description, qty: Number(x.qty) || 1 })) })); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog vz-plan" role="dialog" aria-modal="true" aria-labelledby="vz-plan-title" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="vz-dlg-head">
          <span className="vz-dlg-art" aria-hidden="true">{KIND[v.kind][0]}</span>
          <div><h2 id="vz-plan-title">{v.id ? tr('Change the visit') : tr('Plan a visit')}</h2><p>{v.link || tr('For a customer, with what to bring.')}</p></div>
        </div>
        <div className="vz-seg" role="radiogroup" aria-label={tr('What')}>
          {Object.keys(KIND).map((k) => <button key={k} type="button" role="radio" aria-checked={v.kind === k} className={v.kind === k ? 'is-on' : ''} onClick={() => set({ kind: k })}>{KIND[k][0]} {tr(KIND[k][1])}</button>)}
        </div>
        <div className="vz-grid">
          <label><span>{tr('Day')}</span><input className="input" type="date" required value={v.day} onChange={(e) => set({ day: e.target.value })} /></label>
          <div className="vz-windows"><span>{tr('Time window')}</span>
            <div className="vz-chips">{windows.map((w) => { const [a, b] = w.split('-'); return <button key={w} type="button" className={v.from === a && v.to === b ? 'is-on' : ''} onClick={() => set({ from: a, to: b })}>{a}–{b}</button>; })}</div>
          </div>
        </div>
        <div className="vz-crew-pick"><span>{tr('Crew')}</span>
          <div className="vz-chips">{data.crew.map((c) => <button key={c.id} type="button" aria-pressed={v.crew.indexOf(c.id) >= 0} className={v.crew.indexOf(c.id) >= 0 ? 'is-on' : ''} onClick={() => toggle(c.id)}><i style={{ '--h': hue(c.name) }}>{initials(c.name)}</i>{c.name}</button>)}</div>
        </div>
        <div className="vz-grid">
          <label><span>{tr('Customer')}</span><input className="input" maxLength={80} value={v.name} onChange={(e) => set({ name: e.target.value })} /></label>
          <label><span>{tr('Phone')}</span><input className="input" type="tel" maxLength={30} value={v.phone} onChange={(e) => set({ phone: e.target.value })} /></label>
          <label className="is-wide"><span>{tr('Address')}</span><input className="input" maxLength={300} value={v.address} onChange={(e) => set({ address: e.target.value })} /></label>
          <label><span>{tr('Area')}</span><input className="input" maxLength={80} value={v.area} onChange={(e) => set({ area: e.target.value })} /></label>
          <label><span>{tr('Vehicle')}</span><input className="input" maxLength={40} value={v.vehicle} onChange={(e) => set({ vehicle: e.target.value })} placeholder={tr('e.g. the van')} /></label>
        </div>
        <div className="vz-items"><span>{tr('What goes on the van')}</span>
          {v.items.map((x, i) => (
            <div key={i} className="vz-item-row">
              <input className="input" maxLength={160} value={x.description} onChange={(e) => set({ items: v.items.map((y, k) => (k === i ? { ...y, description: e.target.value } : y)) })} aria-label={tr('What')} />
              <input className="input" type="number" min="1" value={x.qty} onChange={(e) => set({ items: v.items.map((y, k) => (k === i ? { ...y, qty: e.target.value } : y)) })} aria-label={tr('How many')} />
              <button type="button" className="pos-link is-bad" onClick={() => set({ items: v.items.filter((y, k) => k !== i) })} aria-label={tr('Take it off')}>✕</button>
            </div>
          ))}
          <button type="button" className="pos-link" onClick={() => set({ items: v.items.concat([{ description: '', qty: 1 }]) })}>＋ {tr('Add a line')}</button>
        </div>
        <label className="vz-note"><span>{tr('Note for the crew')}</span><textarea className="input" rows={2} maxLength={500} value={v.note} onChange={(e) => set({ note: e.target.value })} placeholder={tr('e.g. call at the gate; second floor')} /></label>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !v.crew.length}>{v.id ? tr('Save') : tr('Plan it and tell the customer')}</button>
        </div>
      </form>
    </div>
  );
}

// Done: who received it signs; photos.
function DoneDialog({ visit, onClose, onDone }) {
  const [name, setName] = useState('');
  const [sig, setSig] = useState([]);
  const [photos, setPhotos] = useState([]);
  const [outcome, setOutcome] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function addPhoto(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { const p = await shrinkPhoto(f); setPhotos((l) => l.concat([p]).slice(0, 4)); } catch { setError(tr('That file is not a photo.')); }
  }
  async function go(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.post('/visits/' + visit.id + '/done', { signedName: name, signature: sig.length ? sig : undefined, photos, outcome })); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog vz-done" role="dialog" aria-modal="true" aria-labelledby="vz-done-title" onClick={(e) => e.stopPropagation()} onSubmit={go}>
        <div className="vz-dlg-head">
          <span className="vz-dlg-art is-done" aria-hidden="true">✍️</span>
          <div><h2 id="vz-done-title">{tr('Done: signed for')}</h2><p>{visit.ref} · {visit.name}</p></div>
        </div>
        <label><span>{tr('Who received it')}</span><input className="input" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder={visit.name} /></label>
        <div className="vz-sign"><span>{tr('Their signature')}</span><SignaturePad strokes={sig} onChange={setSig} label={tr('Sign here')} /></div>
        <div className="vz-photos">
          {photos.map((p, i) => <span key={i} className="vz-photo"><img src={p} alt="" /><button type="button" onClick={() => setPhotos(photos.filter((x, k) => k !== i))} aria-label={tr('Take it off')}>✕</button></span>)}
          {photos.length < 4 && <label className="vz-photo-add">📷 {tr('A photo of it in place')}<input type="file" accept="image/*" capture="environment" onChange={addPhoto} hidden /></label>}
        </div>
        <input className="input" maxLength={500} value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder={tr('A note (optional), e.g. fitted in the bedroom')} aria-label={tr('Note')} />
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Back')}</button>
          <button type="submit" className="btn btn-primary vz-done-go" disabled={busy || name.trim().length < 2 || (!sig.length && !photos.length)}>✅ {tr('Done')}</button>
        </div>
      </form>
    </div>
  );
}

// A visit's card opened: who, where, what, the crew's buttons.
function VisitSheet({ visit, canManage, me, onClose, onChanged, onEdit, onToast }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const mine = visit.crew.some((c) => c.id === me);
  const can = canManage || mine;
  const live = ['planned', 'on_way', 'arrived'].indexOf(visit.status) >= 0;
  async function act(action, body) {
    setBusy(true); setError(null);
    try {
      const r = await api.post('/visits/' + visit.id + '/' + action, body || {});
      onChanged(r);
      if (r.told && r.told.length) onToast(tr('The customer was told ({how}).', { how: r.told.join(', ') }));
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className={'dialog vz-sheet is-' + visit.status} role="dialog" aria-modal="true" aria-labelledby="vz-sheet-title" onClick={(e) => e.stopPropagation()}>
        <div className="vz-dlg-head">
          <span className={'vz-dlg-art is-' + visit.kind} aria-hidden="true">{KIND[visit.kind][0]}</span>
          <div><h2 id="vz-sheet-title">{tr(KIND[visit.kind][1])} · {visit.name}</h2><p>{visit.ref}{visit.shopOrder ? ' · ' + visit.shopOrder.orderNo : visit.salesOrder ? ' · ' + visit.salesOrder.orderNo : visit.service ? ' · ' + visit.service.ref : ''}</p></div>
          <span className={'vz-status is-' + visit.status}>{STATUS[visit.status][0]} {tr(STATUS[visit.status][1])}</span>
        </div>
        <div className="vz-facts">
          <div><small>{tr('When')}</small><strong>{dayLong(visit.day)}</strong><span>{visit.from}–{visit.to}</span></div>
          <div><small>{tr('Where')}</small><strong>{visit.address}</strong><span>{visit.area}</span></div>
          <div><small>{tr('Customer')}</small><strong>{visit.name}</strong>{visit.phone && <a href={'tel:' + visit.phone.replace(/[^\d+]/g, '')}>📞 {visit.phone}</a>}</div>
          <div><small>{tr('Crew')}</small><strong className="vz-crew-names"><Crew crew={visit.crew} />{visit.crew.map((c) => c.first || c.name).join(', ')}</strong><span>{visit.vehicle}</span></div>
        </div>
        {visit.items.length > 0 && <ul className="vz-load">{visit.items.map((x, i) => <li key={i}><b>{x.qty}×</b> {x.description}</li>)}</ul>}
        {visit.note && <p className="vz-crew-note">📝 {visit.note}</p>}
        <ol className="vz-steps">
          {['planned', 'on_way', 'arrived', 'done'].map((k) => <li key={k} className={visit.steps[k] || (k === 'planned') ? 'is-on' : ''}><span aria-hidden="true">{STATUS[k][0]}</span>{tr(STATUS[k][1])}{visit.steps[k] && <small>{when(visit.steps[k])}</small>}</li>)}
        </ol>
        {visit.status === 'done' && (
          <div className="vz-proof">
            <div className="vz-received"><small>{tr('Received by')}</small><strong>{visit.signedName}</strong></div>
            {visit.signature && <SignatureView strokes={visit.signature} className="vz-sig" />}
            <div className="vz-proof-photos">{Array.from({ length: visit.photos }).map((x, i) => <SecureImg key={i} path={'/visits/' + visit.id + '/photos/' + i} label={tr('Photo {n}', { n: i + 1 })} />)}</div>
            {visit.outcome && <p>💬 {visit.outcome}</p>}
          </div>
        )}
        {visit.status === 'failed' && visit.outcome && <p className="vz-failed">⚠️ {visit.outcome}</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {can && live && (
          <div className="vz-acts">
            {visit.status === 'planned' && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => act('on-way')}>🚚 {tr('On my way')}</button>}
            {(visit.status === 'planned' || visit.status === 'on_way') && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => act('arrived')}>📍 {tr('We are there')}</button>}
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => setDoneOpen(true)}>✅ {tr('Done')}</button>
            <button type="button" className="pos-link is-bad" disabled={busy} onClick={() => { const why = window.prompt(tr('Why could it not be done?')); if (why) act('failed', { outcome: why }); }}>{tr('Could not be done')}</button>
          </div>
        )}
        <div className="dialog-actions">
          {canManage && live && <button type="button" className="pos-link is-bad" disabled={busy} onClick={() => { if (window.confirm(tr('Cancel {ref}?', { ref: visit.ref }))) act('cancel'); }}>{tr('Cancel the visit')}</button>}
          {canManage && visit.status === 'planned' && <button type="button" className="btn btn-secondary" onClick={() => onEdit(visit)}>{tr('Change')}</button>}
          <button type="button" className="btn btn-primary" onClick={onClose}>{tr('Close')}</button>
        </div>
        {doneOpen && <DoneDialog visit={visit} onClose={() => setDoneOpen(false)} onDone={(r) => { setDoneOpen(false); onChanged(r); onToast(tr('Done and signed for.')); }} />}
      </div>
    </div>
  );
}

function VisitCard({ v, onOpen, i }) {
  return (
    <button type="button" className={'vz-card is-' + v.status + ' is-' + v.kind} style={{ '--i': i }} onClick={() => onOpen(v)}>
      <span className="vz-card-top"><b>{v.from}–{v.to}</b><span aria-hidden="true">{KIND[v.kind][0]}</span></span>
      <strong>{v.name}</strong>
      <small>{v.area || v.address}</small>
      <span className="vz-card-foot"><Crew crew={v.crew} /><em className={'vz-status is-' + v.status}>{STATUS[v.status][0]}</em></span>
    </button>
  );
}

function SettingsDialog({ settings, onClose, onSaved }) {
  const [s, setS] = useState({ ...settings, windows: settings.windows.join(', ') });
  const [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault();
    try { onSaved(await api.put('/visits/settings', { warrantyMonths: Number(s.warrantyMonths), windows: s.windows.split(',').map((w) => w.trim()).filter(Boolean), repairs: s.repairs })); } catch (err) { setError(err.message); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog vz-plan" role="dialog" aria-modal="true" aria-labelledby="vz-set-title" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2 id="vz-set-title">⚙️ {tr('Deliveries and repairs: settings')}</h2>
        <label><span>{tr('Warranty, months from delivery')}</span><input className="input" type="number" min="0" max="120" value={s.warrantyMonths} onChange={(e) => setS({ ...s, warrantyMonths: e.target.value })} /></label>
        <label><span>{tr('Time windows offered (with commas)')}</span><input className="input" value={s.windows} onChange={(e) => setS({ ...s, windows: e.target.value })} placeholder="08:00-12:00, 12:00-16:00" /></label>
        <label className="vz-check"><input type="checkbox" checked={s.repairs} onChange={(e) => setS({ ...s, repairs: e.target.checked })} />{tr('Customers ask for a repair from their order\'s page')}</label>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary">{tr('Save')}</button></div>
      </form>
    </div>
  );
}

function ServiceCard({ s, canManage, onPlan, onSaved, i }) {
  const [answer, setAnswer] = useState(s.answer || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save(patch) {
    setBusy(true); setError(null);
    try { onSaved(await api.put('/visits/services/' + s.id, patch)); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <article className={'vz-svc is-' + s.status} style={{ '--i': i }}>
      <header>
        <span className={'vz-svc-status is-' + s.status}>{SERVICE[s.status][0]} {tr(SERVICE[s.status][1])}</span>
        <strong>{s.ref} · {s.name}</strong>
        <small>{s.orderNo ? tr('Order {no}', { no: s.orderNo }) + ' · ' : ''}{when(s.createdAt)}</small>
      </header>
      <p className="vz-svc-item">{s.item && <b>{s.item}: </b>}{s.problem}</p>
      {s.photos > 0 && <div className="vz-proof-photos">{Array.from({ length: s.photos }).map((x, k) => <SecureImg key={k} path={'/visits/services/' + s.id + '/photos/' + k} label={tr('Photo {n}', { n: k + 1 })} />)}</div>}
      <div className="vz-warranty">
        {s.warrantyUntil && <span className={'vz-wtag' + (s.underWarranty ? ' is-in' : ' is-out')}>{s.underWarranty ? '🛡️ ' + tr('Under warranty until {day}', { day: untilDay(s.warrantyUntil) }) : tr('Warranty ended {day}', { day: untilDay(s.warrantyUntil) })}</span>}
        {canManage && (
          <span className="vz-chips">
            <button type="button" className={s.warranty === true ? 'is-on' : ''} disabled={busy} onClick={() => save({ warranty: true })}>🛡️ {tr('Free: under warranty')}</button>
            <button type="button" className={s.warranty === false ? 'is-on is-paid' : ''} disabled={busy} onClick={() => save({ warranty: false })}>💳 {tr('Paid repair')}</button>
          </span>
        )}
      </div>
      {canManage && (
        <div className="vz-answer">
          <textarea className="input" rows={2} maxLength={800} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={tr('Your answer to the customer: they are told by text and email')} aria-label={tr('Answer')} />
          <div className="vz-svc-acts">
            <button type="button" className="btn btn-secondary" disabled={busy || answer === (s.answer || '') || !answer.trim()} onClick={() => save({ answer })}>💬 {tr('Send the answer')}</button>
            {(s.status === 'new' || s.status === 'visit') && <button type="button" className="btn btn-primary" onClick={() => onPlan(s)}>🔧 {s.visitDay ? tr('Visit on {day}', { day: dayHead(s.visitDay) }) : tr('Plan a repair visit')}</button>}
            {s.status !== 'closed' && <button type="button" className="pos-link" disabled={busy} onClick={() => save({ status: 'closed' })}>{tr('Close it')}</button>}
          </div>
        </div>
      )}
      {error && <div className="error-banner" role="alert">{error}</div>}
    </article>
  );
}

export default function VisitsPage() {
  const [params] = useSearchParams();
  const [from, setFrom] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState(params.get('repairs') ? 'repairs' : params.get('mine') ? 'mine' : 'week');
  const [plan, setPlan] = useState(null);
  const [open, setOpen] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const load = useCallback((f) => api.get('/visits' + (f ? '?from=' + f : '')).then((d) => { setData(d); setFrom(d.from || null); if (!d.canRead) setTab('mine'); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(null); }, [load]);
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(null), 4000); return () => clearTimeout(t); }, [toast]);
  const me = data && data.me;
  const days = useMemo(() => (from ? Array.from({ length: 7 }, (x, i) => addDays(from, i)) : []), [from]);
  if (error) return <div className="vz-page"><div className="error-banner" role="alert">{error}</div></div>;
  if (!data) return <div className="vz-page"><p className="dk-muted">{tr('Loading…')}</p></div>;
  const planFor = (base) => setPlan({ kind: 'delivery', day: addDays(data.today, 1), from: data.settings.windows[0].split('-')[0], to: data.settings.windows[0].split('-')[1], crew: [], vehicle: '', name: '', phone: '', address: '', area: '', items: [], note: '', ...base });
  const changed = () => { setOpen(null); load(from); };
  return (
    <div className="vz-page">
      <header className="vz-hero">
        <span className="vz-hero-art" aria-hidden="true"><i>🚚</i><i>🎋</i></span>
        <div>
          <h1>{tr('Deliveries and fitting')}</h1>
          <p>{tr('Plan who goes where and when; the customer is told the day and the time, the crew sign it off on their phone.')}</p>
          {data.canRead && <div className="vz-pills"><span>🗓️ {tr('{n} this week', { n: data.counts.week })}</span><span className={data.counts.waiting ? 'is-hot' : ''}>📦 {tr('{n} to plan', { n: data.counts.waiting })}</span><span className={data.counts.repairs ? 'is-hot' : ''}>🔧 {tr('{n} new repairs', { n: data.counts.repairs })}</span></div>}
        </div>
        {data.canManage && <button type="button" className="btn btn-secondary vz-gear" onClick={() => setSettingsOpen(true)} aria-label={tr('Settings')}>⚙️ {tr('Settings')}</button>}
      </header>
      {toast && <div className="ts-flash vz-toast" role="status">{toast}</div>}
      <div className="vz-tabs" role="tablist">
        {data.canRead && <button type="button" role="tab" aria-selected={tab === 'week'} className={tab === 'week' ? 'is-on' : ''} onClick={() => setTab('week')}>🗓️ {tr('This week')}</button>}
        {data.canRead && <button type="button" role="tab" aria-selected={tab === 'plan'} className={tab === 'plan' ? 'is-on' : ''} onClick={() => setTab('plan')}>📦 {tr('To plan')}{data.counts.waiting > 0 && <em>{data.counts.waiting}</em>}</button>}
        {data.canRead && <button type="button" role="tab" aria-selected={tab === 'repairs'} className={tab === 'repairs' ? 'is-on' : ''} onClick={() => setTab('repairs')}>🔧 {tr('Repairs')}{data.counts.repairs > 0 && <em>{data.counts.repairs}</em>}</button>}
        <button type="button" role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'is-on' : ''} onClick={() => setTab('mine')}>🙋 {tr('My visits')}{data.mine.length > 0 && <em>{data.mine.length}</em>}</button>
      </div>

      {tab === 'week' && (
        <section className="vz-week">
          <div className="vz-week-nav">
            <button type="button" className="btn btn-secondary" onClick={() => load(addDays(from, -7))} aria-label={tr('The week before')}>←</button>
            <strong>{dayHead(days[0])} – {dayHead(days[6])}</strong>
            <button type="button" className="btn btn-secondary" onClick={() => load(addDays(from, 7))} aria-label={tr('The week after')}>→</button>
            <button type="button" className="pos-link" onClick={() => load(null)}>{tr('This week')}</button>
            {data.canManage && <button type="button" className="btn btn-primary vz-new" onClick={() => planFor({})}>＋ {tr('Plan a visit')}</button>}
          </div>
          <div className="vz-cal">
            {days.map((d) => {
              const list = data.visits.filter((v) => v.day === d);
              return (
                <div key={d} className={'vz-day' + (d === data.today ? ' is-today' : '') + (d < data.today ? ' is-past' : '')}>
                  <h3>{dayHead(d)}{list.length > 0 && <small>{list.length}</small>}</h3>
                  {list.map((v, i) => <VisitCard key={v.id} v={v} i={i} onOpen={setOpen} />)}
                  {!list.length && <span className="vz-free">{tr('Free')}</span>}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {tab === 'plan' && (
        <section className="vz-waiting">
          {!data.waiting.shop.length && !data.waiting.sales.length && <div className="dk-empty"><span aria-hidden="true">🎉</span><p>{tr('Every order has its delivery planned.')}</p></div>}
          {data.waiting.shop.map((o, i) => (
            <article key={o.id} className="vz-wait" style={{ '--i': i }}>
              <span className="vz-wait-ico" aria-hidden="true">🛍️</span>
              <div>
                <strong>{o.orderNo} · {o.name}</strong>
                <small>{tr('Online shop')} · {o.status === 'ready' ? '✅ ' + tr('Ready') : o.readyBy ? tr('Ready by {day}', { day: dayHead(o.readyBy) }) : tr('Being made')}{o.area ? ' · ' + o.area : ''}</small>
                <small>{o.items.map((x) => x.qty + '× ' + x.description).join(', ')}</small>
              </div>
              {data.canManage && <button type="button" className="btn btn-primary" onClick={() => planFor({ shopOrderId: o.id, link: o.orderNo, name: o.name, phone: o.phone, address: o.address, area: o.area, items: o.items })}>🚚 {tr('Plan the delivery')}</button>}
            </article>
          ))}
          {data.waiting.sales.map((o, i) => (
            <article key={o.id} className="vz-wait is-sales" style={{ '--i': i + data.waiting.shop.length }}>
              <span className="vz-wait-ico" aria-hidden="true">📄</span>
              <div>
                <strong>{o.orderNo} · {o.name}</strong>
                <small>{tr('Sales order')}{o.promised ? ' · ' + tr('Promised for {day}', { day: dayHead(o.promised) }) : ''}</small>
                <small>{o.address}</small>
              </div>
              {data.canManage && <button type="button" className="btn btn-secondary" onClick={() => planFor({ kind: 'install', salesOrderId: o.id, link: o.orderNo, name: o.name, phone: o.phone, address: o.address })}>🛠️ {tr('Plan it')}</button>}
            </article>
          ))}
        </section>
      )}

      {tab === 'repairs' && (
        <section className="vz-svcs">
          {!data.services.length && <div className="dk-empty"><span aria-hidden="true">🛡️</span><p>{tr('No repair requests.')}</p></div>}
          {data.services.map((s, i) => <ServiceCard key={s.id + s.status + (s.warranty === null ? 'n' : s.warranty)} s={s} i={i} canManage={data.canManage}
            onPlan={(x) => planFor({ kind: 'repair', serviceId: x.id, link: x.ref, name: x.name, phone: x.phone, address: x.address, items: x.item ? [{ description: x.item, qty: 1 }] : [] })}
            onSaved={(r) => { setData({ ...data, services: data.services.map((y) => (y.id === r.id ? { ...y, ...r } : y)) }); if (r.told && r.told.length) setToast(tr('The customer was told ({how}).', { how: r.told.join(', ') })); }} />)}
        </section>
      )}

      {tab === 'mine' && (
        <section className="vz-mine">
          {!data.mine.length && <div className="dk-empty"><span aria-hidden="true">☕</span><p>{tr('No visits for you this week.')}</p></div>}
          {data.mine.map((v, i) => (
            <button key={v.id} type="button" className={'vz-mine-card is-' + v.status + (v.day === data.today ? ' is-today' : '')} style={{ '--i': i }} onClick={() => setOpen(v)}>
              <span className="vz-mine-when"><b>{v.day === data.today ? tr('Today') : dayHead(v.day)}</b><small>{v.from}–{v.to}</small></span>
              <span className="vz-mine-main"><strong>{KIND[v.kind][0]} {v.name}</strong><small>📍 {v.address}{v.area ? ', ' + v.area : ''}</small><small>{v.items.map((x) => x.qty + '× ' + x.description).join(', ')}</small></span>
              <em className={'vz-status is-' + v.status}>{STATUS[v.status][0]} {tr(STATUS[v.status][1])}</em>
            </button>
          ))}
        </section>
      )}

      {plan && <PlanDialog start={plan} data={data} onClose={() => setPlan(null)} onSaved={(r) => { setPlan(null); setToast(r.told && r.told.length ? tr('Planned: the customer was told ({how}).', { how: r.told.join(', ') }) : tr('Planned.')); load(from); }} />}
      {open && <VisitSheet visit={open} me={me} canManage={data.canManage} onClose={() => setOpen(null)} onToast={setToast} onChanged={changed}
        onEdit={(v) => { setOpen(null); setPlan({ id: v.id, kind: v.kind, day: v.day, from: v.from, to: v.to, crew: v.crew.map((c) => c.id), vehicle: v.vehicle, name: v.name, phone: v.phone, address: v.address, area: v.area, items: v.items, note: v.note, link: v.ref }); }} />}
      {settingsOpen && <SettingsDialog settings={data.settings} onClose={() => setSettingsOpen(false)} onSaved={(s) => { setSettingsOpen(false); setData({ ...data, settings: s }); setToast(tr('Saved.')); }} />}
    </div>
  );
}
