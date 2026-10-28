import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { api, API_URL } from '../api/client';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import { shrinkPhoto } from './till/photoShrink';
import './seventeenth.css';
import './eighteenth.css';
import './nineteenth.css';

// Quality inspections (Operations → Quality; backend quality.service.js,
// migration 0200): a checklist per product or stage, gone through on the
// floor for a batch — points ok or not, measures in range or not, defects
// counted with photos; the lot passes, passes with notes, goes on hold or
// fails, and a held lot is released, reworked, scrapped or sent back. The
// share passing first time, week by week; the defects that come up most;
// batches nobody has inspected yet.

function dayText(d, opts) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC', ...opts }) : '—'; }
function when(t) { return t ? new Date(t).toLocaleString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; }
function num(n) { return Number(n).toLocaleString(activeIntlLocale(), { maximumFractionDigits: 2 }); }

const VERDICT = { pass: ['✅', 'is-good', msg('Passed')], pass_notes: ['📝', 'is-teal', msg('Passed with notes')], hold: ['✋', 'is-warn', msg('On hold')], fail: ['⛔', 'is-bad', msg('Failed')] };
const STAGE = { incoming: ['🚚', msg('Arriving')], in_process: ['⚙️', msg('In process')], final: ['🏁', msg('Finished')], packing: ['📦', msg('Packing')] };
const DEFECT = {
  crack: ['💥', msg('Crack')], split: ['🪓', msg('Split')], mould: ['🍄', msg('Mould')], insect: ['🐛', msg('Insect damage')], colour: ['🎨', msg('Colour')], finish: ['✨', msg('Finish')], joint: ['🔩', msg('Joint')],
  glue: ['🧴', msg('Glue')], dimension: ['📏', msg('Size')], moisture: ['💧', msg('Moisture')], warp: ['〰️', msg('Warp')], damage: ['🔨', msg('Damage')], other: ['📝', msg('Other')]
};
const SEVERITY = { minor: ['is-calm', msg('Minor')], major: ['is-warn', msg('Major')], critical: ['is-bad', msg('Critical')] };
const DISPOSITION = { release: ['✅', msg('Release it')], rework: ['🔧', msg('Rework')], scrap: ['🗑️', msg('Scrap')], return: ['↩️', msg('Send back')] };
const COLORS = { pass: 'var(--x7-good)', passNotes: 'var(--x7-teal)', hold: 'var(--x7-warn)', fail: 'var(--x7-bad)' };

// The same rule as the server's (quality.service.js verdictOf).
function verdictOf(points, results, defects, note) {
  const out = points.map((p, n) => ({ ...p, ...results[n], ok: p.kind === 'measure' ? (results[n] && results[n].value !== '' && results[n].value != null ? (p.min == null || Number(results[n].value) >= p.min) && (p.max == null || Number(results[n].value) <= p.max) : null) : results[n] ? results[n].ok : null }));
  if (out.some((r) => r.ok === false && r.critical) || defects.some((d) => d.severity === 'critical')) return 'fail';
  if (out.some((r) => r.ok === false) || defects.some((d) => d.severity === 'major')) return 'hold';
  if (defects.length || (note && note.trim())) return 'pass_notes';
  return 'pass';
}

function DefectPhoto({ inspection, defect }) {
  const [url, setUrl] = useState(null);
  const [big, setBig] = useState(false);
  useEffect(() => {
    let made = null, live = true;
    fetch(API_URL + '/quality/' + inspection + '/defects/' + defect + '/photo', { headers: api.authHeaders() }).then((r) => (r.ok ? r.blob() : null)).then((b) => { if (b && live) { made = URL.createObjectURL(b); setUrl(made); } }).catch(() => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [inspection, defect]);
  if (!url) return <span className="hs-photo" aria-hidden="true" />;
  return (
    <>
      <button type="button" className="hs-photo" onClick={() => setBig(true)} aria-label={tr('See the photo')}><img src={url} alt="" /></button>
      {big && createPortal(<div className="x7-zoom" onClick={() => setBig(false)} role="dialog" aria-label={tr('Photo')}><img src={url} alt={tr('Photo')} /></div>, document.body)}
    </>
  );
}

function InspectionSheet({ id, onClose, onChanged }) {
  const [i, setI] = useState(null);
  const [g, setG] = useState({ disposition: '', reworkQty: '', scrapQty: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { api.get('/quality/' + id).then(setI).catch((e) => setError(e.message)); }, [id]);
  async function settle(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { setI(await api.post('/quality/' + i.id + '/settle', g)); onChanged(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  if (!i) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const v = VERDICT[i.verdict];
  const tones = { pass: ['#15803d', '#0f766e'], pass_notes: ['#0f766e', '#1d4ed8'], hold: ['#b45309', '#a16207'], fail: ['#b91c1c', '#9d174d'] }[i.verdict];
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet is-wide" role="dialog" aria-modal="true" aria-labelledby="qc-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={{ '--g1': tones[0], '--g2': tones[1] }}>
          <span className="x7-icon" aria-hidden="true">{v[0]}</span>
          <div><small>{i.ref} · {tr(STAGE[i.stage][1])} · {when(i.inspectedAt)}{i.inspector ? ' · ' + i.inspector : ''}</small><h2 id="qc-t">{i.batch ? tr('Batch {n}', { n: i.batch.batchNo }) : i.lotRef}{i.product ? ' — ' + i.product.name : ''}</h2>
            <p><span className="x7-pill">{v[0]} {tr(v[2])}</span>{!i.firstPass && <span className="x7-pill">🔁 {tr('Re-inspection')}</span>}{i.defects > 0 && <span className="x7-pill">🔍 {tr('{n} defects', { n: i.defects })}</span>}{i.open && <span className="x7-pill">⏳ {(i.ageDays === 0 ? tr('waiting since today') : i.ageDays === 1 ? tr('1 day waiting') : tr('{n} days waiting', { n: i.ageDays }))}</span>}</p></div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        <dl className="x7-facts">
          <div><dt>{tr('Checklist')}</dt><dd>{i.checklist || '—'}</dd></div>
          <div><dt>{tr('The lot')}</dt><dd>{i.lotQty ? num(i.lotQty) : '—'}{i.batch && i.batch.line ? ' · ' + i.batch.line : ''}</dd></div>
          <div><dt>{tr('Sample checked')}</dt><dd>{i.sampleSize || '—'}</dd></div>
          <div><dt>{tr('Made')}</dt><dd>{i.batch ? dayText(i.batch.date) : '—'}</dd></div>
        </dl>
        {i.results.length > 0 && (
          <div className="x7-sec">
            <h3>📋 {tr('The checklist')}</h3>
            <div className="qc-points">{i.results.map((r, n) => (
              <div key={n} className={'qc-point ' + (r.ok ? 'is-ok' : 'is-no')}>
                <i aria-hidden="true">{r.ok ? '✓' : '✗'}</i>
                <span><b>{r.label}{r.critical ? ' ⚠️' : ''}</b>{r.kind === 'measure' && <small>{num(r.value)}{r.unit} · {tr('between {min} and {max}', { min: r.min == null ? '…' : r.min, max: r.max == null ? '…' : r.max })}</small>}{r.note && <small>{r.note}</small>}</span>
              </div>
            ))}</div>
          </div>
        )}
        {i.defectList.length > 0 && (
          <div className="x7-sec">
            <h3>🔍 {tr('Defects')}</h3>
            <div className="x7-list">{i.defectList.map((d) => (
              <div key={d.id} className="x7-row" style={{ cursor: 'default' }}>
                <span className="x7-icon" aria-hidden="true">{DEFECT[d.type][0]}</span>
                <span className="x7-who"><b>{d.qty} × {tr(DEFECT[d.type][1])}</b><small>{d.note || '—'}</small></span>
                <span className={'x7-pill ' + SEVERITY[d.severity][0]}>{tr(SEVERITY[d.severity][1])}</span>
                {d.photo ? <DefectPhoto inspection={i.id} defect={d.id} /> : <span />}
              </div>
            ))}</div>
          </div>
        )}
        {i.note && <p className="x7-note">📝 {i.note}</p>}
        {!i.open && i.disposition && i.verdict !== 'pass' && i.verdict !== 'pass_notes' && (
          <dl className="x7-facts"><div><dt>{tr('Decided')}</dt><dd>{DISPOSITION[i.disposition][0]} {tr(DISPOSITION[i.disposition][1])}</dd></div>{i.reworkQty > 0 && <div><dt>{tr('Reworked')}</dt><dd>{num(i.reworkQty)}</dd></div>}{i.scrapQty > 0 && <div><dt>{tr('Scrapped')}</dt><dd>{num(i.scrapQty)}</dd></div>}<div><dt>{tr('By')}</dt><dd>{i.settledBy || '—'} · {dayText(i.settledAt)}</dd></div></dl>
        )}
        {i.settleNote && <p className="x7-note">🗒️ {i.settleNote}</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        {i.open && i.canManage && (
          <form className="x7-form" onSubmit={settle}>
            <h3>⚖️ {tr('What happens to the lot')}</h3>
            <div className="x7-chips">{Object.entries(DISPOSITION).filter(([k]) => !(i.verdict === 'fail' && k === 'release')).map(([k, [ic, l]]) => <button key={k} type="button" className={g.disposition === k ? 'is-on' : ''} onClick={() => setG({ ...g, disposition: k })}><em aria-hidden="true">{ic}</em>{tr(l)}</button>)}</div>
            <div className="x7-grid2">
              <label><span>{tr('How many to rework')}</span><input className="input" type="number" min="0" value={g.reworkQty} onChange={(e) => setG({ ...g, reworkQty: e.target.value })} placeholder={g.disposition === 'rework' ? String(i.lotQty || '') : '0'} /></label>
              <label><span>{tr('How many to scrap')}</span><input className="input" type="number" min="0" value={g.scrapQty} onChange={(e) => setG({ ...g, scrapQty: e.target.value })} placeholder={g.disposition === 'scrap' ? String(i.lotQty || '') : '0'} /></label>
            </div>
            <label><span>{tr('Why')}</span><input className="input" required value={g.note} onChange={(e) => setG({ ...g, note: e.target.value })} placeholder={tr('e.g. Back to the kiln for two days')} /></label>
            <div className="dialog-actions"><button type="submit" className="btn btn-primary" disabled={busy || !g.disposition}>{tr('Decide')}</button></div>
          </form>
        )}
        {i.others.length > 0 && (
          <div className="x7-sec">
            <h3>🔁 {tr('The same batch')}</h3>
            <ul className="x7-mine-list">{i.others.map((o) => <li key={o.id}><span aria-hidden="true">{VERDICT[o.verdict][0]}</span><span><b>{o.ref} · {tr(VERDICT[o.verdict][2])}</b><small>{when(o.inspectedAt)} · {o.inspector || '—'}</small></span></li>)}</ul>
          </div>
        )}
      </div>
    </div>
  );
}

function InspectDialog({ d, batchId, lot, onClose, onDone }) {
  const pick = (bid) => {
    const b = d.batches.find((x) => x.id === bid) || d.notInspected.find((x) => x.id === bid);
    const list = (b && d.checklists.find((c) => c.productId === b.productId)) || d.checklists.find((c) => !c.productId) || d.checklists[0];
    return { batchId: bid || '', lotRef: '', productId: b ? b.productId || '' : '', checklistId: list ? list.id : '', lotQty: b ? String(b.outputQty) : '', sampleSize: '' };
  };
  // A production job's lot (Production jobs → Inspect the lot): its
  // reference, product and how many, filled in.
  const fromLot = () => {
    const list = d.checklists.find((c) => c.productId === lot.product) || d.checklists.find((c) => !c.productId) || d.checklists[0];
    return { batchId: '', lotRef: lot.ref, productId: lot.product || '', checklistId: list ? list.id : '', lotQty: lot.qty || '', sampleSize: '' };
  };
  const [f, setF] = useState(() => (lot && !batchId ? fromLot() : pick(batchId)));
  const [results, setResults] = useState([]);
  const [defects, setDefects] = useState([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const checklist = d.checklists.find((c) => c.id === f.checklistId);
  const points = checklist ? checklist.points : [];
  // Results go with the checklist's points, by position; a new checklist starts afresh.
  const setR = (n, x) => { const next = points.map((_, j) => results[j] || {}); next[n] = { ...next[n], ...x }; setResults(next); };
  const verdict = verdictOf(points, results, defects, note);
  const done = points.every((p, n) => results[n] && (p.kind === 'measure' ? results[n].value !== undefined && results[n].value !== '' : results[n].ok !== undefined));
  async function addPhoto(n, e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try { const shot = await shrinkPhoto(file); setDefects((x) => x.map((dd, j) => (j === n ? { ...dd, photo: shot } : dd))); } catch { setError(tr('That file is not a photo.')); }
  }
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      onDone(await api.post('/quality', { ...f, batchId: f.batchId || null, productId: f.productId || null, checklistId: f.checklistId || null,
        results: points.map((p, n) => (p.kind === 'measure' ? { value: results[n] ? results[n].value : null, note: (results[n] || {}).note } : { ok: results[n] ? results[n].ok : null, note: (results[n] || {}).note })), defects, note }));
    } catch (err) { setError(err.message); setBusy(false); }
  }
  const v = VERDICT[verdict];
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" style={{ width: 'min(760px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="qc-i-t" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">🔎</span><div><h2 id="qc-i-t">{tr('Inspect a lot')}</h2><p>{tr('Go through every point; count the defects, with a photo. The verdict follows.')}</p></div></div>
        <div className="x7-grid2">
          <label><span>{tr('Batch')}</span><select className="input" value={f.batchId} onChange={(e) => { setF(pick(e.target.value)); setResults([]); }}><option value="">{tr('Another lot (give its reference)')}</option>{d.batches.map((b) => <option key={b.id} value={b.id}>{b.batchNo} · {b.product || '—'} · {dayText(b.date)}</option>)}</select></label>
          {f.batchId ? <label><span>{tr('Checklist')}</span><select className="input" value={f.checklistId} onChange={(e) => { setF({ ...f, checklistId: e.target.value }); setResults([]); }}><option value="">—</option>{d.checklists.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            : <label><span>{tr('Lot reference')}</span><input className="input" required value={f.lotRef} onChange={(e) => setF({ ...f, lotRef: e.target.value })} placeholder={tr('e.g. Delivery note 4471')} /></label>}
        </div>
        {!f.batchId && (
          <div className="x7-grid2">
            <label><span>{tr('Product')}</span><select className="input" value={f.productId} onChange={(e) => setF({ ...f, productId: e.target.value })}><option value="">—</option>{d.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label><span>{tr('Checklist')}</span><select className="input" value={f.checklistId} onChange={(e) => { setF({ ...f, checklistId: e.target.value }); setResults([]); }}><option value="">—</option>{d.checklists.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          </div>
        )}
        <div className="x7-grid2">
          <label><span>{tr('How many in the lot')}</span><input className="input" type="number" min="0" value={f.lotQty} onChange={(e) => setF({ ...f, lotQty: e.target.value })} /></label>
          <label><span>{tr('How many you checked')}</span><input className="input" type="number" min="0" value={f.sampleSize} onChange={(e) => setF({ ...f, sampleSize: e.target.value })} /></label>
        </div>
        {points.length > 0 && <div className="qc-form-points">{points.map((p, n) => {
          const r = results[n] || {};
          const inRange = p.kind === 'measure' && r.value !== undefined && r.value !== '' ? (p.min == null || Number(r.value) >= p.min) && (p.max == null || Number(r.value) <= p.max) : null;
          return (
            <div key={n} className={'qc-form-point' + (p.kind === 'measure' ? (inRange === false ? ' is-no' : inRange ? ' is-ok' : '') : r.ok === false ? ' is-no' : r.ok ? ' is-ok' : '')}>
              <span><b>{p.label}{p.critical ? ' ⚠️' : ''}</b>{p.kind === 'measure' && <small>{tr('between {min} and {max}', { min: p.min == null ? '…' : p.min, max: p.max == null ? '…' : p.max })}{p.unit ? ' ' + p.unit : ''}</small>}</span>
              {p.kind === 'measure'
                ? <input className="input" type="number" step="any" value={r.value || ''} onChange={(e) => setR(n, { value: e.target.value })} aria-label={p.label} />
                : <span className="qc-okno"><button type="button" className={r.ok === true ? 'is-on' : ''} onClick={() => setR(n, { ok: true })} aria-label={tr('OK')}>✓</button><button type="button" className={r.ok === false ? 'is-on is-no' : ''} onClick={() => setR(n, { ok: false })} aria-label={tr('Not OK')}>✗</button></span>}
            </div>
          );
        })}</div>}
        <div className="x7-sec">
          <h3>🔍 {tr('Defects')} <button type="button" className="x7-link" onClick={() => setDefects([...defects, { type: 'finish', qty: 1, severity: 'minor', note: '', photo: null }])}>➕ {tr('Add one')}</button></h3>
          {defects.map((dd, n) => (
            <div key={n} className="qc-defect">
              <select className="input" value={dd.type} onChange={(e) => setDefects(defects.map((x, j) => (j === n ? { ...x, type: e.target.value } : x)))} aria-label={tr('Defect')}>{d.defectTypes.map((k) => <option key={k} value={k}>{DEFECT[k][0]} {tr(DEFECT[k][1])}</option>)}</select>
              <input className="input" type="number" min="1" value={dd.qty} onChange={(e) => setDefects(defects.map((x, j) => (j === n ? { ...x, qty: e.target.value } : x)))} aria-label={tr('How many')} />
              <span className="x7-seg">{Object.entries(SEVERITY).map(([k, [, l]]) => <button key={k} type="button" className={dd.severity === k ? 'is-on' : ''} onClick={() => setDefects(defects.map((x, j) => (j === n ? { ...x, severity: k } : x)))}>{tr(l)}</button>)}</span>
              <label className={'qc-cam' + (dd.photo ? ' is-set' : '')} aria-label={tr('Photo')}><input type="file" accept="image/*" capture="environment" onChange={(e) => addPhoto(n, e)} />{dd.photo ? <img src={dd.photo} alt="" /> : '📸'}</label>
              <button type="button" className="btn btn-secondary" onClick={() => setDefects(defects.filter((_, j) => j !== n))} aria-label={tr('Remove')}>✕</button>
            </div>
          ))}
        </div>
        <label><span>{tr('Note')}</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <div className={'qc-verdict ' + v[1]}><i aria-hidden="true">{v[0]}</i><span><b>{tr(v[2])}</b><small>{verdict === 'fail' ? tr('A critical point or a critical defect.') : verdict === 'hold' ? tr('A point not met, or a major defect: production is told.') : verdict === 'pass_notes' ? tr('Minor defects, written down.') : tr('Everything as it should be.')}</small></span></div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy || !done}>{tr('Record the inspection')}</button></div>
      </form>
    </div>
  );
}

function ChecklistsDialog({ d, onClose, onDone }) {
  const [list, setList] = useState(d.checklists);
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save() {
    setBusy(true); setError(null);
    try { const x = await (edit.id ? api.put('/quality/checklists/' + edit.id, edit) : api.post('/quality/checklists', edit)); setList(x.filter((c) => c.active)); setEdit(null); onDone(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const setP = (n, x) => setEdit({ ...edit, points: edit.points.map((p, j) => (j === n ? { ...p, ...x } : p)) });
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-dlg" style={{ width: 'min(780px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="qc-c-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">📋</span><div><h2 id="qc-c-t">{tr('Checklists')}</h2><p>{tr('What to check for each product or stage. A critical point not met fails the lot.')}</p></div></div>
        {!edit ? (
          <>
            <div className="x7-list">{list.map((c) => (
              <button key={c.id} type="button" className="x7-row" onClick={() => setEdit({ ...c })}>
                <span className="x7-icon" aria-hidden="true">{STAGE[c.stage][0]}</span>
                <span className="x7-who"><b>{c.name}</b><small>{tr(STAGE[c.stage][1])}{c.product ? ' · ' + c.product : ''} · {tr('{n} points', { n: c.points.length })}</small></span>
                <span className="x7-pill is-bad">{c.points.filter((p) => p.critical).length} ⚠️</span><span />
              </button>
            ))}</div>
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button><button type="button" className="btn btn-primary" onClick={() => setEdit({ name: '', stage: 'final', productId: '', points: [{ label: '', kind: 'check', critical: false }] })}>➕ {tr('New checklist')}</button></div>
          </>
        ) : (
          <>
            <div className="x7-grid3">
              <label><span>{tr('Name')}</span><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
              <label><span>{tr('Stage')}</span><select className="input" value={edit.stage} onChange={(e) => setEdit({ ...edit, stage: e.target.value })}>{Object.entries(STAGE).map(([k, [ic, l]]) => <option key={k} value={k}>{ic} {tr(l)}</option>)}</select></label>
              <label><span>{tr('Product')}</span><select className="input" value={edit.productId || ''} onChange={(e) => setEdit({ ...edit, productId: e.target.value })}><option value="">{tr('Any')}</option>{d.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            </div>
            <div className="ob-edit">{edit.points.map((p, n) => (
              <div key={n} className="qc-edit-row">
                <input className="input" value={p.label} onChange={(e) => setP(n, { label: e.target.value })} placeholder={tr('e.g. Joints tight')} aria-label={tr('Point')} />
                <select className="input" value={p.kind} onChange={(e) => setP(n, { kind: e.target.value })} aria-label={tr('Kind')}><option value="check">{tr('OK / not OK')}</option><option value="measure">{tr('Measure')}</option></select>
                {p.kind === 'measure' ? <><input className="input" type="number" step="any" value={p.min ?? ''} onChange={(e) => setP(n, { min: e.target.value })} placeholder={tr('Min')} aria-label={tr('Min')} /><input className="input" type="number" step="any" value={p.max ?? ''} onChange={(e) => setP(n, { max: e.target.value })} placeholder={tr('Max')} aria-label={tr('Max')} /><input className="input" value={p.unit || ''} onChange={(e) => setP(n, { unit: e.target.value })} placeholder={tr('Unit')} aria-label={tr('Unit')} /></> : <><span /><span /><span /></>}
                <label className="qc-crit"><input type="checkbox" checked={!!p.critical} onChange={(e) => setP(n, { critical: e.target.checked })} />⚠️</label>
                <button type="button" className="btn btn-secondary" onClick={() => setEdit({ ...edit, points: edit.points.filter((_, j) => j !== n) })} aria-label={tr('Remove')}>✕</button>
              </div>
            ))}</div>
            <button type="button" className="x7-link" style={{ alignSelf: 'flex-start' }} onClick={() => setEdit({ ...edit, points: [...edit.points, { label: '', kind: 'check', critical: false }] })}>➕ {tr('Another point')}</button>
            {error && <div className="error-banner" role="alert">{error}</div>}
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setEdit(null)}>{tr('Back')}</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{tr('Save')}</button></div>
          </>
        )}
      </div>
    </div>
  );
}

// Twelve weeks of first inspections, stacked; the share passing on top.
function WeeksChart({ weeks }) {
  const max = Math.max(1, ...weeks.map((w) => w.total));
  const W = 640, H = 140, padL = 26, step = (W - padL - 6) / weeks.length, bw = Math.min(28, step * 0.58);
  const y = (v) => 18 + H - v / max * H;
  return (
    <div className="hs-chart">
      <svg viewBox={'0 0 ' + W + ' ' + (H + 42)} role="img" aria-label={tr('Inspections each week')}>
        {[0, max].map((t) => <g key={t}><line x1={padL} x2={W - 4} y1={y(t)} y2={y(t)} className="bg-grid" /><text x={padL - 6} y={y(t) + 4} textAnchor="end" className="bg-axis">{t}</text></g>)}
        {weeks.map((w, n) => {
          let base = 0;
          const cx = padL + step * n + step / 2;
          return (
            <g key={w.week}>
              {['pass', 'passNotes', 'hold', 'fail'].map((k) => {
                if (!w[k]) return null;
                const y0 = y(base), y1 = y(base + w[k]);
                base += w[k];
                return <rect key={k} x={cx - bw / 2} y={y1 + 1} width={bw} height={Math.max(1, y0 - y1 - 2)} rx="4" style={{ fill: COLORS[k] }}><title>{dayText(w.week)}: {w[k]}</title></rect>;
              })}
              {w.yield != null && <text x={cx} y={y(w.total) - 5} textAnchor="middle" className="qc-yield">{Math.round(w.yield)}%</text>}
              <text x={cx} y={H + 36} textAnchor="middle" className="bg-axis">{dayText(w.week)}</text>
            </g>
          );
        })}
      </svg>
      <div className="bg-legend">{[['pass', msg('Passed')], ['passNotes', msg('With notes')], ['hold', msg('On hold')], ['fail', msg('Failed')]].map(([k, l]) => <span key={k}><i className="bg-key" style={{ background: COLORS[k] }} />{tr(l)}</span>)}</div>
    </div>
  );
}

export default function QualityPage() {
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState('all');
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [dlg, setDlg] = useState(null);
  const load = useCallback(() => api.get('/quality?verdict=' + filter).then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), [filter]);
  useEffect(() => { load(); }, [load]);
  const openId = params.get('inspection');
  const open = (id) => setParams(id ? { inspection: id } : {});
  const lot = params.get('lot') ? { ref: params.get('lot'), product: params.get('product') || '', qty: params.get('qty') || '' } : null;
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const s = d.summary;
  const topMax = Math.max(1, ...d.topDefects.map((t) => t.qty));
  return (
    <div className="x7">
      <header className="x7-head">
        <div>
          <h1>🔎 {tr('Quality')}</h1>
          <p>{tr('Every batch checked against its checklist on the floor: what passed first time, what is held, the defects that keep coming back.')}</p>
        </div>
        {d.canManage && <div className="x7-head-actions"><button type="button" className="btn btn-secondary" onClick={() => setDlg({ k: 'lists' })}>📋 {tr('Checklists')}</button><button type="button" className="btn btn-primary" onClick={() => setDlg({ k: 'inspect' })}>🔎 {tr('Inspect a lot')}</button></div>}
      </header>
      <div className="x7-tiles">
        <div className={'x7-tile ' + (s.firstPassYield == null || s.firstPassYield >= 90 ? 'is-good' : s.firstPassYield >= 75 ? 'is-warn' : 'is-bad')}><small>🎯 {tr('Right first time')}</small><b>{s.firstPassYield == null ? '—' : s.firstPassYield + '%'}</b><span>{tr('{n} inspections this month', { n: s.month })}</span></div>
        <div className={'x7-tile ' + (s.onHold ? 'is-warn' : 'is-good')}><small>✋ {tr('On hold')}</small><b>{s.onHold}</b><span>{s.onHold ? (s.oldestHold === 1 ? tr('oldest 1 day') : tr('oldest {n} days', { n: s.oldestHold })) : tr('nothing waiting')}</span></div>
        <div className="x7-tile is-calm"><small>🔍 {tr('Defects found')}</small><b>{s.defects}</b><span>{tr('this month')}</span></div>
        <div className="x7-tile is-violet"><small>🔧 {tr('Reworked · scrapped')}</small><b>{num(s.rework)} · {num(s.scrap)}</b><span>{tr('this month')}</span></div>
        <div className={'x7-tile ' + (s.notInspected ? 'is-warn' : 'is-good')}><small>🕳️ {tr('Not inspected')}</small><b>{s.notInspected}</b><span>{tr('batches, last 14 days')}</span></div>
      </div>
      <div className="x7-grid2 qc-top">
        <section className="x7-card"><h2>📈 {tr('Twelve weeks')}</h2><WeeksChart weeks={d.weeks} /></section>
        <section className="x7-card">
          <h2>🔍 {tr('What comes up most')} <small>{tr('90 days')}</small></h2>
          {!d.topDefects.length ? <p className="x7-muted">{tr('No defects recorded.')}</p> : <div className="qc-pareto">{d.topDefects.map((t) => (
            <div key={t.type} className="qc-pareto-row">
              <span className="qc-pareto-name"><em aria-hidden="true">{DEFECT[t.type][0]}</em>{tr(DEFECT[t.type][1])}</span>
              <span className="qc-pareto-bar"><i style={{ width: t.qty / topMax * 100 + '%' }} /></span>
              <b>{t.qty}</b><small>{t.share}% · Σ {t.cumulative}%</small>
            </div>
          ))}</div>}
        </section>
      </div>
      {d.notInspected.length > 0 && (
        <section className="x7-card">
          <h2>🕳️ {tr('Made lately, not inspected yet')}</h2>
          <div className="x7-list">{d.notInspected.map((b) => (
            <div key={b.id} className="x7-row" style={{ cursor: 'default' }}>
              <span className="x7-icon" aria-hidden="true">🏭</span>
              <span className="x7-who"><b>{tr('Batch {n}', { n: b.batchNo })} · {b.product || '—'}</b><small>{dayText(b.date)} · {b.line || '—'} · {num(b.outputQty)}</small></span>
              <span />
              {d.canManage ? <button type="button" className="btn btn-primary" onClick={() => setDlg({ k: 'inspect', batch: b.id })}>🔎 {tr('Inspect')}</button> : <span />}
            </div>
          ))}</div>
        </section>
      )}
      <div className="x7-bar">
        <h2 className="x7-h2" style={{ margin: 0 }}>📋 {tr('Inspections')}</h2>
        <div className="x7-seg" role="tablist">{[['all', tr('All')], ['open', tr('Waiting for a decision')], ['fail', tr('Held or failed')]].map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={filter === k} className={filter === k ? 'is-on' : ''} onClick={() => setFilter(k)}>{l}</button>)}</div>
      </div>
      {!d.inspections.length ? <div className="x7-empty"><span aria-hidden="true">🔎</span><p>{tr('No inspection yet. Start with the batches made this week.')}</p></div> : (
        <div className="x7-list">{d.inspections.map((i) => (
          <button key={i.id} type="button" className={'x7-row' + (i.open ? ' is-flag ' + (i.verdict === 'fail' ? 'is-bad' : 'is-warn') : '')} onClick={() => open(i.id)}>
            <span className="x7-icon" aria-hidden="true">{VERDICT[i.verdict][0]}</span>
            <span className="x7-who"><b>{i.batch ? tr('Batch {n}', { n: i.batch.batchNo }) : i.lotRef}{i.product ? ' · ' + i.product.name : ''}</b><small>{i.ref} · {tr(STAGE[i.stage][1])} · {when(i.inspectedAt)}{i.inspector ? ' · ' + i.inspector : ''}{!i.firstPass ? ' · 🔁' : ''}</small></span>
            <span className="x7-pill is-calm">{i.defects ? '🔍 ' + i.defects : '—'}</span>
            <span className={'x7-pill ' + VERDICT[i.verdict][1]}>{tr(VERDICT[i.verdict][2])}{i.open ? ' · ⏳ ' + tr('{n} d', { n: i.ageDays }) : i.disposition && i.verdict !== 'pass' && i.verdict !== 'pass_notes' ? ' → ' + tr(DISPOSITION[i.disposition][1]) : ''}</span>
          </button>
        ))}</div>
      )}
      {dlg && dlg.k === 'inspect' && <InspectDialog d={d} batchId={dlg.batch} onClose={() => setDlg(null)} onDone={(x) => { setDlg(null); load(); open(x.id); }} />}
      {lot && !dlg && d.canManage && <InspectDialog d={d} lot={lot} onClose={() => setParams({})} onDone={(x) => { load(); open(x.id); }} />}
      {dlg && dlg.k === 'lists' && <ChecklistsDialog d={d} onClose={() => setDlg(null)} onDone={load} />}
      {openId && <InspectionSheet key={openId} id={openId} onClose={() => open(null)} onChanged={load} />}
    </div>
  );
}
