import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './seventeenth.css';
import './twentieth.css';

// Kilns and treatment (Operations → Kilns and treatment; backend
// kilns.service.js, migration 0201): the kilns, the borate tanks and the
// air-drying sheds, each with the charge in it — read for moisture until it
// is dry, or soaked for its days — taken out with what split; how busy each
// is, how long a charge takes, how much is lost.

const KIND = { kiln: ['🔥', msg('Kiln')], tank: ['🛁', msg('Treatment tank')], shed: ['🏚️', msg('Air-drying shed')] };
const HERO = { kiln: ['#c2410c', '#9a3412'], tank: ['#0369a1', '#1d4ed8'], shed: ['#4d7c0f', '#0f766e'] };

function dayText(d, opts) { return d ? new Date(d).toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', ...opts }) : '—'; }
function timeText(d) { return new Date(d).toLocaleString(activeIntlLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
function num(v) { return v == null ? '—' : String(Math.round(v * 10) / 10); }
function daysWords(n) { const d = Math.floor(n); return d < 1 ? tr('in today') : d === 1 ? tr('day 1') : tr('day {n}', { n: d }); }

// Moisture over the charge: the readings and the target. One line, its
// last value labelled; the target dashed and named.
function MoistureChart({ c, height = 150 }) {
  const pts = c.readings.filter((r) => r.moisture != null);
  if (pts.length < 1) return <p className="x7-muted">{tr('No moisture reading yet.')}</p>;
  const W = 560, H = height, L = 34, R = 46, T = 12, B = 22;
  const t0 = new Date(c.startedAt).getTime(), t1 = Math.max(Date.now(), ...pts.map((p) => new Date(p.at).getTime()), t0 + 3600000);
  const vals = pts.map((p) => p.moisture).concat(c.targetMoisture != null ? [c.targetMoisture] : []);
  const lo = Math.max(0, Math.floor(Math.min(...vals) / 5) * 5 - 5), hi = Math.ceil(Math.max(...vals) / 5) * 5 + 5;
  const x = (t) => L + (new Date(t).getTime() - t0) / (t1 - t0) * (W - L - R);
  const y = (v) => T + (hi - v) / (hi - lo) * (H - T - B);
  const ticks = [lo, Math.round((lo + hi) / 2), hi];
  const last = pts[pts.length - 1];
  const days = Math.max(1, Math.ceil((t1 - t0) / 86400000));
  return (
    <svg className="kln-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={tr('Moisture since it went in: {from}% to {to}%', { from: num(pts[0].moisture), to: num(last.moisture) })}>
      {ticks.map((v) => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="kln-grid" /><text x={L - 6} y={y(v) + 4} textAnchor="end" className="kln-axis">{v}%</text></g>)}
      <text x={L} y={H - 6} className="kln-axis">{dayText(c.startedAt)}</text>
      <text x={W - R} y={H - 6} textAnchor="end" className="kln-axis">{days === 1 ? tr('1 day') : tr('{n} days', { n: days })}</text>
      {c.targetMoisture != null && <g><line x1={L} x2={W - R} y1={y(c.targetMoisture)} y2={y(c.targetMoisture)} className="kln-target" /><text x={L + 4} y={y(c.targetMoisture) - 5} className="kln-axis is-target">{tr('target')} {num(c.targetMoisture)}%</text></g>}
      <polyline className="kln-line" points={pts.map((p) => x(p.at) + ',' + y(p.moisture)).join(' ')} />
      {pts.map((p) => <circle key={p.id} cx={x(p.at)} cy={y(p.moisture)} r="4" className="kln-dot"><title>{timeText(p.at)} · {num(p.moisture)}%</title></circle>)}
      <text x={x(last.at) + 8} y={y(last.moisture) - 8} className="kln-last">{num(last.moisture)}%</text>
    </svg>
  );
}

function flags(c) {
  const out = [];
  if (c.ready) out.push(<span key="r" className="x7-pill is-good">✅ {c.kiln.kind === 'tank' ? tr('Soaked: take it out') : tr('Dry: take it out')}</span>);
  if (c.late) out.push(<span key="l" className="x7-pill is-bad">⏰ {tr('Longer than planned')}</span>);
  if (c.quiet) out.push(<span key="q" className="x7-pill is-warn">📏 {tr('Not read for 2 days')}</span>);
  return out;
}

function ReadForm({ c, onDone, onCancel }) {
  const [f, setF] = useState({ moisture: '', temperature: '', humidity: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.post('/kilns/charges/' + c.id + '/readings', f)); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <form className="x7-form kln-read" onSubmit={save}>
      <h3>📏 {tr('A reading')}</h3>
      <div className="x7-grid3">
        <label><span>{tr('Moisture %')}</span><input className="input" type="number" min="0" max="100" step="0.1" autoFocus value={f.moisture} onChange={(e) => setF({ ...f, moisture: e.target.value })} /></label>
        <label><span>{tr('Temperature °C')}</span><input className="input" type="number" step="0.5" value={f.temperature} onChange={(e) => setF({ ...f, temperature: e.target.value })} /></label>
        <label><span>{tr('Humidity %')}</span><input className="input" type="number" min="0" max="100" value={f.humidity} onChange={(e) => setF({ ...f, humidity: e.target.value })} /></label>
      </div>
      <input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder={tr('Anything to add')} aria-label={tr('Note')} />
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onCancel}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save the reading')}</button></div>
    </form>
  );
}

function FinishForm({ c, onDone, onCancel }) {
  const [f, setF] = useState({ outQty: String(c.qty), rejectQty: '0', endMoisture: c.latestMoisture != null && c.kiln.kind !== 'tank' ? String(c.latestMoisture) : '', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.post('/kilns/charges/' + c.id + '/finish', f)); } catch (err) { setError(err.message); setBusy(false); }
  }
  const lost = c.qty - (Number(f.outQty) || 0) - (Number(f.rejectQty) || 0);
  return (
    <form className="x7-form" onSubmit={save}>
      <h3>📤 {tr('Taken out')}</h3>
      <div className="x7-grid3">
        <label><span>{tr('Good')}</span><input className="input" type="number" min="0" step="any" required value={f.outQty} onChange={(e) => setF({ ...f, outQty: e.target.value })} /></label>
        <label><span>{tr('Split or rejected')}</span><input className="input" type="number" min="0" step="any" value={f.rejectQty} onChange={(e) => setF({ ...f, rejectQty: e.target.value })} /></label>
        {c.kiln.kind !== 'tank' && <label><span>{tr('Moisture %')}</span><input className="input" type="number" min="0" max="100" step="0.1" value={f.endMoisture} onChange={(e) => setF({ ...f, endMoisture: e.target.value })} /></label>}
      </div>
      <p className="x7-note">{tr('{n} {unit} went in.', { n: c.qty, unit: c.unit })}{lost > 0 ? ' ' + tr('{n} not counted.', { n: Math.round(lost * 100) / 100 }) : ''}</p>
      <input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder={tr('Anything to add')} aria-label={tr('Note')} />
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onCancel}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Taken out')}</button></div>
    </form>
  );
}

function StartDialog({ d, kilnId, onClose, onDone }) {
  const free = d.kilns.filter((k) => k.active && !k.running);
  const [f, setF] = useState({ kilnId: kilnId || (free[0] || {}).id || '', from: 'batch', rawBatchId: '', productId: '', description: '', qty: '', unit: '', plannedDays: '', targetMoisture: '', startMoisture: '', solution: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const k = d.kilns.find((x) => x.id === f.kilnId);
  const set = (key, v) => setF((x) => ({ ...x, [key]: v }));
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    const body = { ...f, rawBatchId: f.from === 'batch' ? f.rawBatchId : '', productId: f.from === 'product' ? f.productId : '' };
    try { onDone(await api.post('/kilns/charges', body)); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" style={{ width: 'min(680px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="kln-s-t" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">{k ? KIND[k.kind][0] : '🔥'}</span><div><h2 id="kln-s-t">{tr('A charge in')}</h2><p>{tr('Culms from a raw batch, or boards: read until dry, or soaked for their days.')}</p></div></div>
        {!free.length ? <p className="x7-note">{tr('Every kiln and tank is in use: take a charge out first.')}</p> : (
          <div className="kln-pick" role="radiogroup" aria-label={tr('Where')}>{free.map((x) => (
            <button key={x.id} type="button" role="radio" aria-checked={f.kilnId === x.id} className={f.kilnId === x.id ? 'is-on' : ''} onClick={() => set('kilnId', x.id)}>
              <em aria-hidden="true">{KIND[x.kind][0]}</em><b>{x.name}</b><small>{x.capacity ? tr('holds {n} {unit}', { n: x.capacity, unit: x.unit }) : tr(KIND[x.kind][1])}</small>
            </button>
          ))}</div>
        )}
        <div className="x7-seg" role="tablist">{[['batch', '🎋', msg('From a raw batch')], ['product', '📦', msg('A product')], ['other', '✏️', msg('Something else')]].map(([key, ic, lab]) => (
          <button key={key} type="button" role="tab" aria-selected={f.from === key} className={f.from === key ? 'is-on' : ''} onClick={() => set('from', key)}>{ic} {tr(lab)}</button>
        ))}</div>
        {f.from === 'batch' && <label><span>{tr('Raw batch')}</span><select className="input" value={f.rawBatchId} onChange={(e) => { const b = d.rawBatches.find((x) => x.id === e.target.value); setF((x) => ({ ...x, rawBatchId: e.target.value, unit: b ? b.unit : x.unit })); }}><option value="">—</option>{d.rawBatches.map((b) => <option key={b.id} value={b.id}>{b.batchNo} · {b.species} · {b.quantity} {b.unit}</option>)}</select></label>}
        {f.from === 'product' && <label><span>{tr('Product')}</span><select className="input" value={f.productId} onChange={(e) => { const p = d.products.find((x) => x.id === e.target.value); setF((x) => ({ ...x, productId: e.target.value, unit: p ? p.unit : x.unit })); }}><option value="">—</option>{d.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
        <label><span>{tr('What goes in')}</span><input className="input" value={f.description} onChange={(e) => set('description', e.target.value)} placeholder={f.from === 'other' ? tr('e.g. 2 m boards for the tables') : tr('As the batch or product says, unless you write it')} /></label>
        <div className="x7-grid3">
          <label><span>{tr('How many')}</span><input className="input" type="number" min="0" step="any" required value={f.qty} onChange={(e) => set('qty', e.target.value)} />{k && k.capacity > 0 && <small>{tr('it holds {n}', { n: k.capacity })}</small>}</label>
          <label><span>{tr('Unit')}</span><input className="input" value={f.unit} onChange={(e) => set('unit', e.target.value)} placeholder={k ? k.unit : ''} /></label>
          <label><span>{k && k.kind === 'tank' ? tr('Days in the soak') : tr('Days planned')}</span><input className="input" type="number" min="0.5" max="120" step="0.5" value={f.plannedDays} onChange={(e) => set('plannedDays', e.target.value)} placeholder={k && k.days ? String(k.days) : ''} /></label>
        </div>
        {k && k.kind !== 'tank' ? (
          <div className="x7-grid2">
            <label><span>{tr('Moisture going in %')}</span><input className="input" type="number" min="0" max="100" step="0.1" value={f.startMoisture} onChange={(e) => set('startMoisture', e.target.value)} /></label>
            <label><span>{tr('Dry at %')}</span><input className="input" type="number" min="0" max="60" step="0.5" value={f.targetMoisture} onChange={(e) => set('targetMoisture', e.target.value)} placeholder={k.targetMoisture != null ? String(k.targetMoisture) : ''} /></label>
          </div>
        ) : <label><span>{tr('Solution')}</span><input className="input" value={f.solution} onChange={(e) => set('solution', e.target.value)} placeholder={tr('e.g. borax and boric acid, 5%')} /></label>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy || !free.length}>▶️ {tr('Start')}</button></div>
      </form>
    </div>
  );
}

function KilnsDialog({ d, onClose, onDone }) {
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  function start(k) {
    setEdit(k ? { id: k.id, name: k.name, kind: k.kind, capacity: String(k.capacity || ''), unit: k.unit, targetMoisture: k.targetMoisture != null ? String(k.targetMoisture) : '', days: k.days != null ? String(k.days) : '', active: k.active, seq: k.seq }
      : { name: '', kind: 'kiln', capacity: '', unit: 'culms', targetMoisture: '12', days: '', active: true, seq: d.kilns.length });
  }
  async function save() {
    setBusy(true); setError(null);
    try { onDone(await (edit.id ? api.put('/kilns/' + edit.id, edit) : api.post('/kilns', edit))); setEdit(null); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-dlg" style={{ width: 'min(640px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="kln-k-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">🏭</span><div><h2 id="kln-k-t">{tr('Kilns, tanks and sheds')}</h2><p>{tr('What each holds, the moisture it dries to, and how long a charge usually takes.')}</p></div></div>
        {!edit ? (
          <>
            <div className="x7-list">{d.kilns.map((k) => (
              <button key={k.id} type="button" className="x7-row" onClick={() => start(k)}>
                <span className="x7-icon" aria-hidden="true">{KIND[k.kind][0]}</span>
                <span className="x7-who"><b>{k.name}</b><small>{tr(KIND[k.kind][1])}{k.capacity ? ' · ' + tr('holds {n} {unit}', { n: k.capacity, unit: k.unit }) : ''}{k.targetMoisture != null ? ' · ' + tr('dry at {n}%', { n: k.targetMoisture }) : ''}{k.days ? ' · ' + tr('{n} days', { n: k.days }) : ''}</small></span>
                <span className={'x7-pill ' + (k.active ? 'is-good' : '')}>{k.active ? tr('In use') : tr('Not in use')}</span><span />
              </button>
            ))}</div>
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button><button type="button" className="btn btn-primary" onClick={() => start(null)}>➕ {tr('Add one')}</button></div>
          </>
        ) : (
          <>
            <div className="lic-kinds" role="radiogroup" aria-label={tr('Kind')}>{Object.entries(KIND).map(([key, [ic, lab]]) => <button key={key} type="button" role="radio" aria-checked={edit.kind === key} className={edit.kind === key ? 'is-on' : ''} onClick={() => setEdit({ ...edit, kind: key })}><em aria-hidden="true">{ic}</em>{tr(lab)}</button>)}</div>
            <div className="x7-grid3">
              <label><span>{tr('Name')}</span><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder={tr('e.g. Kiln 1')} /></label>
              <label><span>{tr('Holds')}</span><input className="input" type="number" min="0" value={edit.capacity} onChange={(e) => setEdit({ ...edit, capacity: e.target.value })} /></label>
              <label><span>{tr('Unit')}</span><input className="input" value={edit.unit} onChange={(e) => setEdit({ ...edit, unit: e.target.value })} /></label>
              {edit.kind !== 'tank' && <label><span>{tr('Dry at %')}</span><input className="input" type="number" min="0" max="60" step="0.5" value={edit.targetMoisture} onChange={(e) => setEdit({ ...edit, targetMoisture: e.target.value })} /></label>}
              <label><span>{edit.kind === 'tank' ? tr('Days in the soak') : tr('Usual days')}</span><input className="input" type="number" min="0" max="120" value={edit.days} onChange={(e) => setEdit({ ...edit, days: e.target.value })} /></label>
            </div>
            {edit.id && <label className="x7-check"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /><span>{tr('In use')}</span></label>}
            {error && <div className="error-banner" role="alert">{error}</div>}
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setEdit(null)}>{tr('Back')}</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{tr('Save')}</button></div>
          </>
        )}
      </div>
    </div>
  );
}

function ChargeSheet({ id, canManage, onClose, onChanged }) {
  const [c, setC] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get('/kilns/charges/' + id).then(setC).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  async function abort() {
    setBusy(true); setError(null);
    try { setC(await api.post('/kilns/charges/' + id + '/abort', { note })); setForm(null); onChanged(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  if (!c) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const g = HERO[c.kiln.kind];
  const done = (x) => { setC(x); setForm(null); onChanged(); };
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet" role="dialog" aria-modal="true" aria-labelledby="kln-c-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={{ '--g1': g[0], '--g2': g[1] }}>
          <span className="x7-icon" aria-hidden="true">{KIND[c.kiln.kind][0]}</span>
          <div><small>{c.ref} · {c.kiln.name}</small><h2 id="kln-c-t">{c.description}</h2>
            <p><span className="x7-pill">{c.status === 'running' ? daysWords(c.days) + (c.plannedDays ? ' / ' + c.plannedDays : '') : c.status === 'done' ? '✅ ' + tr('Out after {n} days', { n: num(c.days) }) : '⛔ ' + tr('Stopped')}</span>
              {c.kiln.kind !== 'tank' && c.latestMoisture != null && <span className="x7-pill">💧 {num(c.latestMoisture)}%{c.targetMoisture != null ? ' → ' + num(c.targetMoisture) + '%' : ''}</span>}</p></div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {c.status === 'running' && flags(c).length > 0 && <div className="x7-chips">{flags(c)}</div>}
        {c.progress != null && <div className="kln-progress" role="progressbar" aria-valuenow={c.progress} aria-valuemin="0" aria-valuemax="100" aria-label={tr('How far along')}><i style={{ width: c.progress + '%' }} /><b>{c.progress}%</b></div>}
        <dl className="x7-facts">
          <div><dt>{tr('In')}</dt><dd>{c.qty} {c.unit}</dd></div>
          <div><dt>{tr('Went in')}</dt><dd>{timeText(c.startedAt)}{c.startedBy ? ' · ' + c.startedBy : ''}</dd></div>
          {c.rawBatch && <div><dt>{tr('Raw batch')}</dt><dd>{c.rawBatch.batchNo} · {c.rawBatch.species}</dd></div>}
          {c.solution && <div><dt>{tr('Solution')}</dt><dd>{c.solution}</dd></div>}
          {c.status === 'done' && <div><dt>{tr('Came out')}</dt><dd>{tr('{good} good, {bad} split', { good: num(c.outQty), bad: num(c.rejectQty) })}</dd></div>}
          {c.endedAt && <div><dt>{c.status === 'done' ? tr('Taken out') : tr('Stopped')}</dt><dd>{timeText(c.endedAt)}{c.endedBy ? ' · ' + c.endedBy : ''}</dd></div>}
        </dl>
        {c.endNote && <p className="x7-note">📝 {c.endNote}</p>}
        {c.kiln.kind !== 'tank' && <div className="x7-sec"><h3>💧 {tr('Moisture')}</h3><MoistureChart c={c} /></div>}
        {c.readings.length > 0 && (
          <div className="x7-sec"><h3>📏 {tr('Readings')}</h3>
            <div className="kln-readings">{c.readings.slice().reverse().map((r) => (
              <div key={r.id}><span>{timeText(r.at)}</span><b>{r.moisture != null ? num(r.moisture) + '%' : '—'}</b><span>{r.temperature != null ? num(r.temperature) + '°C' : ''}</span><span>{r.humidity != null ? num(r.humidity) + '% RH' : ''}</span><small>{[r.note, r.by].filter(Boolean).join(' · ')}</small></div>
            ))}</div>
          </div>
        )}
        {form === 'read' && <ReadForm c={c} onDone={done} onCancel={() => setForm(null)} />}
        {form === 'finish' && <FinishForm c={c} onDone={done} onCancel={() => setForm(null)} />}
        {form === 'abort' && (
          <div className="x7-form"><h3>⛔ {tr('Stop the charge')}</h3>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr('Why? e.g. the burner failed')} aria-label={tr('Why?')} />
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setForm(null)}>{tr('Cancel')}</button><button type="button" className="btn btn-danger" disabled={busy} onClick={abort}>{tr('Stop it')}</button></div></div>
        )}
        {!form && canManage && c.status === 'running' && (
          <div className="x7-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setForm('abort')}>⛔ {tr('Stop')}</button>
            <button type="button" className="btn btn-secondary is-end" onClick={() => setForm('read')}>📏 {tr('A reading')}</button>
            <button type="button" className="btn btn-primary" onClick={() => setForm('finish')}>📤 {tr('Take it out')}</button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function KilnsPage() {
  const [params, setParams] = useSearchParams();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [dlg, setDlg] = useState(null);
  const [reading, setReading] = useState(null);
  const load = useCallback(() => api.get('/kilns').then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const open = params.get('charge');
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const s = d.summary;
  const past = d.charges.filter((c) => c.status !== 'running');
  return (
    <div className="x7">
      <header className="x7-head">
        <div>
          <h1>🔥 {tr('Kilns and treatment')}</h1>
          <p>{tr('What is in each kiln, borate tank and drying shed: read for moisture until it is dry, soaked for its days, taken out with what split. How busy each is and how much is lost.')}</p>
        </div>
        {d.canManage && <div className="x7-head-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setDlg({ k: 'kilns' })}>🏭 {tr('Kilns, tanks and sheds')}</button>
          <button type="button" className="btn btn-primary" onClick={() => setDlg({ k: 'start' })}>▶️ {tr('A charge in')}</button>
        </div>}
      </header>
      <div className="x7-tiles">
        <div className="x7-tile is-teal"><small>🔥 {tr('Running')}</small><b>{s.running}</b><span>{s.idle ? tr('{n} empty', { n: s.idle }) : tr('all in use')}</span></div>
        <div className={'x7-tile ' + (s.ready ? 'is-good' : 'is-calm')}><small>✅ {tr('Ready to come out')}</small><b>{s.ready}</b><span>{tr('dry or soaked')}</span></div>
        <div className={'x7-tile ' + (s.late ? 'is-warn' : 'is-good')}><small>⏰ {tr('To look at')}</small><b>{s.late}</b><span>{tr('late, or not read for 2 days')}</span></div>
        <div className="x7-tile is-violet"><small>⏱️ {tr('A charge takes')}</small><b>{s.kilnDays != null ? tr('{n} days', { n: s.kilnDays }) : '—'}</b><span>{[s.tankDays != null ? '🛁 ' + tr('{n} days', { n: s.tankDays }) : null, s.shedDays != null ? '🏚️ ' + tr('{n} days', { n: s.shedDays }) : null].filter(Boolean).join(' · ') || tr('in a kiln, last 90 days')}</span></div>
        <div className={'x7-tile ' + (s.rejectRate != null && s.rejectRate > 8 ? 'is-bad' : 'is-good')}><small>💔 {tr('Split or rejected')}</small><b>{s.rejectRate != null ? s.rejectRate + '%' : '—'}</b><span>{tr('{a} dried, {b} soaked in 30 days', { a: s.dried30, b: s.soaked30 })}</span></div>
      </div>
      {!d.kilns.length ? <div className="x7-empty"><span aria-hidden="true">🏭</span><p>{tr('No kiln or tank yet: add them first.')}</p></div> : (
        <div className="kln-grid">{d.kilns.filter((k) => k.active || k.running).map((k) => {
          const c = k.running;
          return (
            <article key={k.id} className={'kln-card is-' + k.kind + (c ? (c.ready ? ' is-ready' : c.late ? ' is-late' : '') : ' is-empty')}>
              <header>
                <span className="kln-icon" aria-hidden="true">{KIND[k.kind][0]}</span>
                <div><b>{k.name}</b><small>{tr(KIND[k.kind][1])}{k.capacity ? ' · ' + tr('holds {n} {unit}', { n: k.capacity, unit: k.unit }) : ''}</small></div>
                <span className="kln-use" title={tr('busy in the last 30 days')}><i style={{ '--p': k.use30 }} />{k.use30}%</span>
              </header>
              {c ? (
                <button type="button" className="kln-run" onClick={() => setParams({ charge: c.id })}>
                  <span className="kln-run-top"><b>{c.ref}</b><span>{c.description}</span></span>
                  {c.kiln.kind === 'tank' ? (
                    <span className="kln-big"><b>{Math.floor(c.days)}</b><small>{tr('of {n} days', { n: c.plannedDays })}</small></span>
                  ) : (
                    <span className="kln-big"><b>{c.latestMoisture != null ? num(c.latestMoisture) + '%' : '—'}</b><small>{c.targetMoisture != null ? tr('dry at {n}%', { n: c.targetMoisture }) : ''} · {daysWords(c.days)}</small></span>
                  )}
                  {c.progress != null && <span className="kln-progress"><i style={{ width: c.progress + '%' }} /><b>{c.progress}%</b></span>}
                  {flags(c).length > 0 && <span className="x7-chips">{flags(c)}</span>}
                  <span className="kln-run-foot">{c.qty} {c.unit}{c.solution ? ' · ' + c.solution : ''}</span>
                </button>
              ) : (
                <div className="kln-idle"><span aria-hidden="true">💤</span><p>{tr('Empty')}{k.last ? ' · ' + tr('last out {date}', { date: dayText(k.last.endedAt) }) : ''}</p></div>
              )}
              {d.canManage && (reading === k.id && c ? <ReadForm c={c} onDone={() => { setReading(null); load(); }} onCancel={() => setReading(null)} /> : (
                <footer>
                  {c ? <>
                    {c.kiln.kind !== 'tank' && <button type="button" className="btn btn-secondary" onClick={() => setReading(k.id)}>📏 {tr('A reading')}</button>}
                    <button type="button" className={'btn ' + (c.ready ? 'btn-primary' : 'btn-secondary')} onClick={() => setParams({ charge: c.id })}>📤 {tr('Take it out')}</button>
                  </> : <button type="button" className="btn btn-primary" onClick={() => setDlg({ k: 'start', kilnId: k.id })}>▶️ {tr('A charge in')}</button>}
                </footer>
              ))}
            </article>
          );
        })}</div>
      )}
      {past.length > 0 && (
        <section className="x7-card"><h2>🗂️ {tr('Taken out lately')} <small>{tr('the last 75 days')}</small></h2>
          <div className="x7-list">{past.slice(0, 20).map((c) => (
            <button key={c.id} type="button" className={'x7-row' + (c.status === 'aborted' ? ' is-flag is-bad' : '')} onClick={() => setParams({ charge: c.id })}>
              <span className="x7-icon" aria-hidden="true">{KIND[c.kiln.kind][0]}</span>
              <span className="x7-who"><b>{c.ref} · {c.description}</b><small>{c.kiln.name} · {dayText(c.startedAt)} → {dayText(c.endedAt)} · {tr('{n} days', { n: num(c.days) })}{c.endMoisture != null ? ' · ' + num(c.endMoisture) + '%' : ''}</small></span>
              {c.status === 'done' ? <span className={'x7-pill ' + (c.rejectQty / Math.max(1, (c.outQty || 0) + c.rejectQty) > .08 ? 'is-bad' : 'is-good')}>{tr('{good} good, {bad} split', { good: num(c.outQty), bad: num(c.rejectQty) })}</span> : <span className="x7-pill is-bad">⛔ {tr('Stopped')}</span>}<span />
            </button>
          ))}</div>
        </section>
      )}
      {dlg && dlg.k === 'start' && <StartDialog d={d} kilnId={dlg.kilnId} onClose={() => setDlg(null)} onDone={(c) => { setDlg(null); load(); setParams({ charge: c.id }); }} />}
      {dlg && dlg.k === 'kilns' && <KilnsDialog d={d} onClose={() => setDlg(null)} onDone={(x) => setD(x)} />}
      {open && <ChargeSheet key={open} id={open} canManage={d.canManage} onClose={() => setParams({})} onChanged={load} />}
    </div>
  );
}
