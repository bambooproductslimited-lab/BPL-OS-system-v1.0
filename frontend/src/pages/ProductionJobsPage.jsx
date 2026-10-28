import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './seventeenth.css';
import './twentyfirst.css';

// Production jobs (Operations → Production jobs; backend
// productionJobs.service.js, migration 0203): N of a product made from its
// bill of materials — planned, started (the parts taken out of stock), more
// taken or some given back, finished with the good ones into stock and the
// spoilt ones recorded, its real cost against the bill's; quality is told
// there is a lot to inspect.

const STATUS = {
  planned: ['📋', msg('Planned'), 'is-calm'], in_progress: ['🛠️', msg('In progress'), 'is-teal'], done: ['✅', msg('Finished'), 'is-good'],
  cancelled: ['⛔', msg('Cancelled'), ''], late: ['⏰', msg('Late'), 'is-bad']
};
const HERO = { planned: ['#2563eb', '#4338ca'], in_progress: ['#0f766e', '#0369a1'], late: ['#c2410c', '#b91c1c'], done: ['#15803d', '#0f766e'], cancelled: ['#475569', '#334155'] };
const VERDICT = { pass: ['✅', msg('Passed'), 'is-good'], pass_notes: ['📝', msg('Passed with notes'), 'is-good'], hold: ['✋', msg('On hold'), 'is-warn'], fail: ['❌', msg('Failed'), 'is-bad'] };

function dayText(d, opts) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC', ...opts }) : '—'; }
function timeText(d) { return d ? new Date(d).toLocaleString(activeIntlLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; }
function num(v) { return v == null ? '—' : (Math.round(v * 100) / 100).toLocaleString(activeIntlLocale()); }
function today() { return new Date().toISOString().slice(0, 10); }
function hue(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function initials(name) { return String(name || '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase(); }
function dueWords(j) {
  if (!j.dueOn) return tr('No day set');
  const n = Math.round((Date.parse(j.dueOn + 'T00:00:00Z') - Date.parse(today() + 'T00:00:00Z')) / 86400000);
  if (n < 0) return n === -1 ? tr('due yesterday') : tr('{n} days late', { n: -n });
  if (n === 0) return tr('due today');
  if (n === 1) return tr('due tomorrow');
  return tr('due {date}', { date: dayText(j.dueOn) });
}
function taken(j) {
  const plan = j.parts.reduce((a, x) => a + x.planned, 0), got = j.parts.reduce((a, x) => a + Math.min(x.issued, x.planned || x.issued), 0);
  return plan > 0 ? Math.round(got / plan * 100) : 0;
}

function PlanDialog({ d, job, onClose, onDone }) {
  const [f, setF] = useState(job
    ? { productId: job.product.id, qty: String(job.qty), dueOn: job.dueOn || '', leadId: job.lead ? job.lead.id : '', kilnChargeId: job.kiln ? job.kiln.id : '', note: job.note }
    : { productId: (d.products[0] || {}).id || '', qty: '', dueOn: '', leadId: '', kilnChargeId: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const p = d.products.find((x) => x.id === f.productId);
  const qty = Number(f.qty) || 0;
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(job ? await api.patch('/production-jobs/' + job.id, { ...f, qty: job.status === 'planned' ? f.qty : undefined }) : await api.post('/production-jobs', f)); } catch (err) { setError(err.message); setBusy(false); }
  }
  return createPortal(
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" style={{ width: 'min(660px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="job-p-t" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">📋</span><div><h2 id="job-p-t">{job ? tr('Change {ref}', { ref: job.ref }) : tr('Plan a job')}</h2><p>{tr('What to make and how many: the parts and the cost come from its bill of materials.')}</p></div></div>
        {!d.products.length ? <p className="x7-note">{tr('No product has a bill of materials yet: write one under Bills of materials first.')}</p> : (
          <>
            <label><span>{tr('What to make')}</span><select className="input" value={f.productId} disabled={!!job} onChange={(e) => set('productId', e.target.value)}>{d.products.map((x) => <option key={x.id} value={x.id}>{x.name}{x.sku ? ' · ' + x.sku : ''}</option>)}</select></label>
            <div className="x7-grid3">
              <label><span>{tr('How many')}</span><input className="input" type="number" min="1" step="any" required autoFocus={!job} disabled={job && job.status !== 'planned'} value={f.qty} onChange={(e) => set('qty', e.target.value)} /></label>
              <label><span>{tr('Due')}</span><input className="input" type="date" value={f.dueOn} onChange={(e) => set('dueOn', e.target.value)} /></label>
              <label><span>{tr('Who runs it')}</span><select className="input" value={f.leadId} onChange={(e) => set('leadId', e.target.value)}><option value="">—</option>{d.people.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
            </div>
            {p && (
              <div className="job-plan">
                <div><small>{tr('The stock makes')}</small><b>{p.canMake == null ? '—' : num(p.canMake)}</b>{qty > 0 && p.canMake != null && <em className={p.canMake >= qty ? 'is-good' : 'is-warn'}>{p.canMake >= qty ? tr('enough for {n}', { n: num(qty) }) : tr('short for {n}', { n: num(qty) })}</em>}</div>
                <div><small>{tr('Costs to make')}</small><b>{money(p.cost * (qty || 1))}</b><em>{qty ? tr('{v} each', { v: money(p.cost) }) : tr('for one')}</em></div>
                <div><small>{tr('Sells for')}</small><b>{p.price ? money(p.price * (qty || 1)) : '—'}</b><em>{p.price ? tr('{n}% margin', { n: Math.round((p.price - p.cost) / p.price * 100) }) : tr('not sold')}</em></div>
              </div>
            )}
            {d.charges.length > 0 && <label><span>{tr('Made from a kiln charge')}</span><select className="input" value={f.kilnChargeId} onChange={(e) => set('kilnChargeId', e.target.value)}><option value="">—</option>{d.charges.map((c) => <option key={c.id} value={c.id}>{c.ref} · {c.kiln} · {c.what}{c.status === 'running' ? ' · ' + tr('still in') : ''}</option>)}</select></label>}
            <label><span>{tr('Note')}</span><input className="input" value={f.note} onChange={(e) => set('note', e.target.value)} placeholder={tr('e.g. for the hotel order, natural finish')} /></label>
          </>
        )}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy || !d.products.length}>{job ? tr('Save') : '📋 ' + tr('Plan it')}</button></div>
      </form>
    </div>,
    document.body
  );
}

// The bill for what was made against what it really cost.
function CostCompare({ j }) {
  const a = j.actual;
  const bill = j.status === 'done' && a.planFor != null ? a.planFor : j.plan.total;
  const real = a.total;
  const top = Math.max(bill, real, 1);
  const over = real > bill;
  return (
    <div className="job-cost">
      <div className="job-cost-bars" role="img" aria-label={tr('The bill says {bill}; it really cost {real}.', { bill: money(bill), real: money(real) })}>
        <div><span>{tr('The bill')}</span><i style={{ width: bill / top * 100 + '%' }} className="is-bill" /><b>{money(bill)}</b></div>
        <div><span>{j.status === 'done' ? tr('Really') : tr('So far')}</span><i style={{ width: real / top * 100 + '%' }} className={over ? 'is-over' : 'is-under'} /><b>{money(real)}</b></div>
      </div>
      {a.variancePct != null && <p className={'job-variance ' + (a.variancePct > 5 ? 'is-bad' : a.variancePct < -5 ? 'is-good' : '')}>{a.variancePct > 0 ? '▲' : a.variancePct < 0 ? '▼' : '='} {tr('{p}% against the bill ({v})', { p: Math.abs(a.variancePct), v: (a.variance > 0 ? '+' : '') + money(a.variance) })}{a.each != null ? ' · ' + tr('{v} each', { v: money(a.each) }) : ''}</p>}
      <table className="job-cost-table">
        <thead><tr><th /><th>{tr('The bill')}</th><th>{j.status === 'done' ? tr('Really') : tr('So far')}</th></tr></thead>
        <tbody>
          <tr><td>{tr('Parts')}</td><td>{money(j.plan.material)}</td><td>{money(a.material)}</td></tr>
          <tr><td>{tr('Labour')}</td><td>{money(j.plan.labour)}<small>{num(j.plan.hours)} h</small></td><td>{a.hours != null ? <>{money(a.labour)}<small>{num(a.hours)} h</small></> : '—'}</td></tr>
          <tr><td>{tr('Overhead')}</td><td>{money(j.plan.overhead)}</td><td>{a.overhead != null ? money(a.overhead) : '—'}</td></tr>
          <tr className="is-total"><td>{tr('For {n}', { n: num(j.qty) })}</td><td>{money(j.plan.total)}</td><td>{money(a.total)}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

function PartsForm({ j, onDone, onCancel }) {
  const [f, setF] = useState({ componentId: (j.parts[0] || {}).componentId || '', qty: '', way: 'take', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const part = j.parts.find((x) => x.componentId === f.componentId);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.post('/production-jobs/' + j.id + '/parts', { componentId: f.componentId, qty: (f.way === 'back' ? -1 : 1) * Number(f.qty), note: f.note })); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <form className="x7-form" onSubmit={save}>
      <h3>🧰 {tr('Parts for the job')}</h3>
      <div className="x7-seg" role="tablist">{[['take', '➕', msg('Take more')], ['back', '↩️', msg('Give back')]].map(([k, ic, lab]) => <button key={k} type="button" role="tab" aria-selected={f.way === k} className={f.way === k ? 'is-on' : ''} onClick={() => setF({ ...f, way: k })}>{ic} {tr(lab)}</button>)}</div>
      <div className="x7-grid2">
        <label><span>{tr('Part')}</span><select className="input" value={f.componentId} onChange={(e) => setF({ ...f, componentId: e.target.value })}>{j.parts.map((x) => <option key={x.componentId} value={x.componentId}>{x.name}</option>)}</select></label>
        <label><span>{tr('How many')}</span><input className="input" type="number" min="0" step="any" required value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} />{part && <small>{f.way === 'take' ? tr('{n} {unit} in stock', { n: num(part.stock), unit: part.unit }) : tr('{n} {unit} taken', { n: num(part.issued), unit: part.unit })}</small>}</label>
      </div>
      <input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder={tr('Why? e.g. two boards split')} aria-label={tr('Note')} />
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onCancel}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{f.way === 'take' ? tr('Take them') : tr('Give them back')}</button></div>
    </form>
  );
}

function FinishForm({ j, onDone, onCancel }) {
  const [f, setF] = useState({ good: String(j.qty), scrap: '0', scrapReason: '', labourHours: String(j.plan.hours || ''), overhead: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.post('/production-jobs/' + j.id + '/finish', f)); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <form className="x7-form" onSubmit={save}>
      <h3>🏁 {tr('Finish the job')}</h3>
      <div className="x7-grid2">
        <label><span>{tr('Good ones, into stock')}</span><input className="input" type="number" min="0" step="any" required autoFocus value={f.good} onChange={(e) => setF({ ...f, good: e.target.value })} /></label>
        <label><span>{tr('Spoilt')}</span><input className="input" type="number" min="0" step="any" value={f.scrap} onChange={(e) => setF({ ...f, scrap: e.target.value })} /></label>
      </div>
      {Number(f.scrap) > 0 && <input className="input" required value={f.scrapReason} onChange={(e) => setF({ ...f, scrapReason: e.target.value })} placeholder={tr('What spoilt them? e.g. split in the press')} aria-label={tr('What spoilt them?')} />}
      <div className="x7-grid2">
        <label><span>{tr('Hours worked')}</span><input className="input" type="number" min="0" step="0.25" value={f.labourHours} onChange={(e) => setF({ ...f, labourHours: e.target.value })} /><small>{tr('the bill says {n} h', { n: num(j.plan.hours) })}</small></label>
        <label><span>{tr('Overhead')}</span><input className="input" type="number" min="0" step="any" value={f.overhead} onChange={(e) => setF({ ...f, overhead: e.target.value })} placeholder={money(j.plan.overhead)} /></label>
      </div>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onCancel}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>🏁 {tr('Finish')}</button></div>
    </form>
  );
}

function JobSheet({ id, d, onClose, onChanged }) {
  const [j, setJ] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get('/production-jobs/' + id).then(setJ).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  const done = (x) => { setJ(x); setForm(null); setError(null); onChanged(); };
  async function act(path, body) {
    setBusy(true); setError(null);
    try { done(await api.post('/production-jobs/' + id + path, body || {})); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  if (!j) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const g = HERO[j.state] || HERO.planned;
  const st = STATUS[j.state] || STATUS[j.status];
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet" role="dialog" aria-modal="true" aria-labelledby="job-s-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={{ '--g1': g[0], '--g2': g[1] }}>
          <span className="x7-icon" aria-hidden="true">{st[0]}</span>
          <div><small>{j.ref} · {tr(st[1])}</small><h2 id="job-s-t">{num(j.qty)} × {j.product.name}</h2>
            <p><span className="x7-pill">📅 {dueWords(j)}</span>{j.lead && <span className="x7-pill">👷 {j.lead.name}</span>}{j.status === 'done' && <span className="x7-pill">✅ {tr('{good} good, {bad} spoilt', { good: num(j.good), bad: num(j.scrap) })}</span>}</p></div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {j.wasShort && j.wasShort.length > 0 && <p className="x7-flash is-warn">⚠️ {tr('Started short of {list}: take the rest when it comes.', { list: j.wasShort.map((s) => num(s.need) + ' ' + s.unit + ' ' + s.name).join(', ') })}</p>}
        <dl className="x7-facts">
          <div><dt>{tr('Product')}</dt><dd>{j.product.name}{j.product.sku ? ' · ' + j.product.sku : ''}</dd></div>
          <div><dt>{tr('In stock now')}</dt><dd>{num(j.product.stock)} {j.product.unit}</dd></div>
          {j.kiln && <div><dt>{tr('Kiln charge')}</dt><dd><Link to={'/kilns?charge=' + j.kiln.id}>{j.kiln.ref}</Link> · {j.kiln.name} · {j.kiln.what}</dd></div>}
          {j.startedAt && <div><dt>{tr('Started')}</dt><dd>{timeText(j.startedAt)}</dd></div>}
          {j.finishedAt && <div><dt>{tr('Finished')}</dt><dd>{timeText(j.finishedAt)}</dd></div>}
          {j.cancelledAt && <div><dt>{tr('Cancelled')}</dt><dd>{timeText(j.cancelledAt)} · {j.cancelReason}</dd></div>}
        </dl>
        {j.note && <p className="x7-note">📝 {j.note}</p>}
        {j.scrap > 0 && j.scrapReason && <p className="x7-note">💔 {tr('Spoilt: {why}', { why: j.scrapReason })}</p>}

        <div className="x7-sec"><h3>🧩 {tr('The parts')}</h3>
          <div className="job-parts">
            <div className="job-parts-head"><span>{tr('Part')}</span><span>{tr('The bill')}</span><span>{tr('Taken')}</span><span>{tr('In stock')}</span><span>{tr('Cost')}</span></div>
            {j.parts.map((x) => {
              const short = j.status === 'in_progress' || j.status === 'planned' ? x.planned - x.issued : 0;
              return (
                <div key={x.id} className={'job-part' + (short > 0.0001 ? ' is-short' : '')}>
                  <span><b>{x.name}</b>{x.extra && <em>{tr('not on the bill')}</em>}</span>
                  <span>{num(x.planned)} <small>{x.unit}</small></span>
                  <span>{num(x.issued)}<i className="job-meter"><i style={{ width: Math.min(100, x.planned > 0 ? x.issued / x.planned * 100 : 100) + '%' }} /></i></span>
                  <span className={short > 0.0001 && x.stock < short ? 'is-bad' : ''}>{num(x.stock)}</span>
                  <span>{money(x.cost)}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="x7-sec"><h3>💰 {tr('Cost against the bill')}</h3>
          {j.actual ? <CostCompare j={j} /> : (
            <div className="job-plan">
              <div><small>{tr('The bill for {n}', { n: num(j.qty) })}</small><b>{money(j.plan.total)}</b><em>{tr('{v} each', { v: money(j.plan.each) })}</em></div>
              <div><small>{tr('Parts')}</small><b>{money(j.plan.material)}</b><em>{tr('{n} h of work', { n: num(j.plan.hours) })}</em></div>
              <div><small>{tr('Sells for')}</small><b>{j.product.price ? money(j.product.price * j.qty) : '—'}</b><em>{j.product.price ? tr('{n}% margin', { n: Math.round((j.product.price - j.plan.each) / j.product.price * 100) }) : ''}</em></div>
            </div>
          )}
        </div>

        {(j.status === 'done' || j.inspections.length > 0) && (
          <div className="x7-sec"><h3>🔎 {tr('Quality')}</h3>
            {j.inspections.length ? <div className="x7-list">{j.inspections.map((i) => (
              <Link key={i.id} to={'/quality?inspection=' + i.id} className="x7-row">
                <span className="x7-icon" aria-hidden="true">{VERDICT[i.verdict][0]}</span>
                <span className="x7-who"><b>{i.ref}</b><small>{timeText(i.at)} · {num(i.qty)}</small></span>
                <span className={'x7-pill ' + VERDICT[i.verdict][2]}>{tr(VERDICT[i.verdict][1])}</span><span />
              </Link>
            ))}</div> : <p className="x7-muted">{tr('Not inspected yet.')}</p>}
            {j.canInspect && j.status === 'done' && <Link className="btn btn-secondary job-inspect" to={'/quality?lot=' + encodeURIComponent(j.ref) + '&product=' + j.product.id + '&qty=' + (j.good || 0)}>🔎 {tr('Inspect the lot')}</Link>}
          </div>
        )}

        {j.moves.length > 0 && (
          <details className="x7-sec job-moves"><summary>📦 {tr('Stock it moved')} <small>({j.moves.length})</small></summary>
            <ul>{j.moves.map((m, n) => <li key={n}><span className={m.qty < 0 ? 'is-out' : 'is-in'}>{m.qty > 0 ? '+' : ''}{num(m.qty)}</span><b>{m.name}</b><small>{dayText(m.day)}{m.by ? ' · ' + m.by : ''}{m.note ? ' · ' + m.note : ''}</small></li>)}</ul>
          </details>
        )}

        {form === 'parts' && <PartsForm j={j} onDone={done} onCancel={() => setForm(null)} />}
        {form === 'finish' && <FinishForm j={j} onDone={done} onCancel={() => setForm(null)} />}
        {form === 'cancel' && (
          <div className="x7-form"><h3>⛔ {tr('Cancel the job')}</h3>
            {j.status === 'in_progress' && <p className="x7-note">{tr('What was taken goes back into stock.')}</p>}
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={tr('Why? e.g. the customer changed the size')} aria-label={tr('Why?')} />
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setForm(null)}>{tr('Back')}</button><button type="button" className="btn btn-danger" disabled={busy} onClick={() => act('/cancel', { reason })}>{tr('Cancel the job')}</button></div></div>
        )}
        {form === 'edit' && <PlanDialog d={d} job={j} onClose={() => setForm(null)} onDone={done} />}
        {!form && j.canManage && (j.status === 'planned' || j.status === 'in_progress') && (
          <div className="x7-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setForm('cancel')}>⛔ {tr('Cancel')}</button>
            <button type="button" className="btn btn-secondary is-end" onClick={() => setForm('edit')}>✏️ {tr('Edit')}</button>
            {j.status === 'planned' && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act('/start')}>▶️ {tr('Start: take the parts')}</button>}
            {j.status === 'in_progress' && <>
              <button type="button" className="btn btn-secondary" onClick={() => setForm('parts')}>🧰 {tr('Parts')}</button>
              <button type="button" className="btn btn-primary" onClick={() => setForm('finish')}>🏁 {tr('Finish')}</button>
            </>}
          </div>
        )}
      </div>
    </div>
  );
}

function JobCard({ j, onOpen }) {
  const st = STATUS[j.state] || STATUS[j.status];
  const pct = taken(j);
  return (
    <button type="button" className={'job-card is-' + j.state} onClick={onOpen}>
      <span className="job-card-top"><b>{j.ref}</b><span className={'x7-pill ' + st[2]}>{st[0]} {j.state === 'late' ? dueWords(j) : tr(st[1])}</span></span>
      <span className="job-card-what"><em>{num(j.qty)}</em><span>× {j.product.name}</span></span>
      {j.status === 'in_progress' && <span className="job-card-bar" title={tr('Parts taken')}><i style={{ width: pct + '%' }} /><small>{tr('{n}% of the parts taken', { n: pct })}</small></span>}
      <span className="job-card-foot">
        {j.lead ? <span className="job-lead"><i style={{ '--h': hue(j.lead.name) }}>{initials(j.lead.name)}</i>{j.lead.name}</span> : <span className="job-lead is-none">{tr('Nobody yet')}</span>}
        <span>{j.state !== 'late' ? dueWords(j) : ''}</span>
      </span>
      {(j.short.length > 0 || j.kiln) && <span className="x7-chips">
        {j.short.length > 0 && <span className="x7-pill is-warn">🧩 {j.short.length === 1 ? tr('1 part short') : tr('{n} parts short', { n: j.short.length })}</span>}
        {j.kiln && <span className="x7-pill is-calm">🔥 {j.kiln.ref}</span>}
      </span>}
    </button>
  );
}

export default function ProductionJobsPage() {
  const [params, setParams] = useSearchParams();
  const [show, setShow] = useState('open');
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [plan, setPlan] = useState(false);
  const load = useCallback(() => api.get('/production-jobs?show=' + show).then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), [show]);
  useEffect(() => { load(); }, [load]);
  const open = params.get('job');
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const s = d.summary;
  const cols = [['planned', d.jobs.filter((j) => j.status === 'planned')], ['in_progress', d.jobs.filter((j) => j.status === 'in_progress')]];
  return (
    <div className="x7">
      <header className="x7-head">
        <div>
          <h1>🏭 {tr('Production jobs')}</h1>
          <p>{tr('What the workshop is making: the parts taken from stock by the bill of materials, the good ones into stock and what was spoilt, and what each job really cost against its bill.')}</p>
        </div>
        {d.canManage && <div className="x7-head-actions"><Link className="btn btn-secondary" to="/bom">🧩 {tr('Bills of materials')}</Link><button type="button" className="btn btn-primary" onClick={() => setPlan(true)}>📋 {tr('Plan a job')}</button></div>}
      </header>
      <div className="x7-tiles">
        <div className="x7-tile is-teal"><small>🛠️ {tr('In progress')}</small><b>{s.inProgress}</b><span>{s.planned === 1 ? tr('1 planned') : tr('{n} planned', { n: s.planned })}</span></div>
        <div className={'x7-tile ' + (s.late ? 'is-bad' : 'is-good')}><small>⏰ {tr('Late')}</small><b>{s.late}</b><span>{s.dueWeek === 1 ? tr('1 due this week') : tr('{n} due this week', { n: s.dueWeek })}</span></div>
        <div className={'x7-tile ' + (s.short ? 'is-warn' : 'is-good')}><small>🧩 {tr('Short of parts')}</small><b>{s.short}</b><span>{tr('jobs waiting on stock')}</span></div>
        <div className="x7-tile is-violet"><small>📦 {tr('Made this month')}</small><b>{num(s.madeQty)}</b><span>{tr('worth {v}', { v: money(s.madeValue) })}</span></div>
        <div className={'x7-tile ' + (s.scrapPct != null && s.scrapPct > 5 ? 'is-warn' : 'is-good')}><small>💔 {tr('Spoilt')}</small><b>{s.scrapPct != null ? s.scrapPct + '%' : '—'}</b><span>{tr('of what was made, 90 days')}</span></div>
        <div className={'x7-tile ' + (s.variancePct == null ? 'is-calm' : s.variancePct > 5 ? 'is-bad' : 'is-good')}><small>💰 {tr('Against the bill')}</small><b>{s.variancePct == null ? '—' : (s.variancePct > 0 ? '+' : '') + s.variancePct + '%'}</b><span>{tr('real cost, 90 days')}</span></div>
      </div>
      <div className="x7-seg" role="tablist">{[['open', '🛠️', msg('Open')], ['done', '✅', msg('Finished')], ['all', '🗂️', msg('All')]].map(([k, ic, lab]) => <button key={k} type="button" role="tab" aria-selected={show === k} className={show === k ? 'is-on' : ''} onClick={() => setShow(k)}>{ic} {tr(lab)}</button>)}</div>
      {show === 'open' ? (
        !d.jobs.length ? <div className="x7-empty"><span aria-hidden="true">🏭</span><p>{tr('No job open. Plan one from a product with a bill of materials.')}</p></div> : (
          <div className="job-board">{cols.map(([k, list]) => (
            <section key={k} className={'job-col is-' + k}>
              <h2>{STATUS[k][0]} {tr(STATUS[k][1])} <small>{list.length}</small></h2>
              {!list.length ? <p className="x7-muted">{tr('None.')}</p> : list.map((j) => <JobCard key={j.id} j={j} onOpen={() => setParams({ job: j.id })} />)}
            </section>
          ))}</div>
        )
      ) : (
        !d.jobs.length ? <div className="x7-empty"><span aria-hidden="true">🗂️</span><p>{tr('Nothing here yet.')}</p></div> : (
          <section className="x7-card"><div className="x7-list">{d.jobs.map((j) => {
            const st = STATUS[j.state] || STATUS[j.status];
            return (
              <button key={j.id} type="button" className={'x7-row' + (j.status === 'cancelled' ? ' is-flag' : '')} onClick={() => setParams({ job: j.id })}>
                <span className="x7-icon" aria-hidden="true">{st[0]}</span>
                <span className="x7-who"><b>{j.ref} · {num(j.qty)} × {j.product.name}</b><small>{j.status === 'done' ? tr('{good} good, {bad} spoilt', { good: num(j.good), bad: num(j.scrap) }) + ' · ' + timeText(j.finishedAt) : j.status === 'cancelled' ? j.cancelReason : dueWords(j)}</small></span>
                {j.actual && j.actual.variancePct != null ? <span className={'x7-pill ' + (j.actual.variancePct > 5 ? 'is-bad' : 'is-good')}>{(j.actual.variancePct > 0 ? '+' : '') + j.actual.variancePct}%</span> : <span className={'x7-pill ' + st[2]}>{tr(st[1])}</span>}<span />
              </button>
            );
          })}</div></section>
        )
      )}
      {plan && <PlanDialog d={d} onClose={() => setPlan(false)} onDone={(j) => { setPlan(false); load(); setParams({ job: j.id }); }} />}
      {open && <JobSheet key={open} id={open} d={d} onClose={() => setParams({})} onChanged={load} />}
    </div>
  );
}
