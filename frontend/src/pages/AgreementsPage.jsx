import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { API_URL, api } from '../api/client';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './seventeenth.css';
import './twentysecond.css';

// Leases and contracts (Finance → Leases and contracts; backend
// agreements.service.js, migration 0205): the factory's lease, supply
// contracts, the service firms, loans and insurance — who with, what they
// cost, the last day to give notice and whether they renew themselves.
// Reminded before the notice date and the end; the ones that renew
// themselves move on to their next term with their rise. (Contracts
// customers sign online are kept in Contracts.)

const KIND = { lease: ['🏠', msg('Lease')], supplier: ['📦', msg('Supply contract')], service: ['🛠️', msg('Service contract')], customer: ['🤝', msg('Customer agreement')], loan: ['🏦', msg('Loan')], insurance: ['🛡️', msg('Insurance')], other: ['📄', msg('Other')] };
const STATE = {
  ok: ['✅', msg('In force'), 'is-good'], notice_due: ['⏰', msg('Notice due'), 'is-warn'], locked_in: ['🔁', msg('Renews itself'), 'is-violet'],
  ending: ['🏁', msg('Ends at its date'), 'is-warn'], lapsed: ['⛔', msg('Ran out'), 'is-bad'], renegotiating: ['💬', msg('Being renegotiated'), 'is-violet'],
  open_ended: ['♾️', msg('No end date'), 'is-calm'], ended: ['📁', msg('Ended'), '']
};
const PER = { month: msg('a month'), quarter: msg('a quarter'), year: msg('a year'), once: msg('once') };
const INTENT = { renew: ['🔁', msg('Renew it')], renegotiate: ['💬', msg('Renegotiate')], end: ['🏁', msg('Let it end')] };

function dayText(d) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—'; }
function monthText(m) { return new Date(m + '-01T12:00:00Z').toLocaleDateString(activeIntlLocale(), { month: 'short', timeZone: 'UTC' }); }
function inDays(n) { return n === 0 ? tr('today') : n === 1 ? tr('tomorrow') : n < 0 ? (n === -1 ? tr('yesterday') : tr('{n} days ago', { n: -n })) : tr('in {n} days', { n }); }
function whole(n, c) { return (c || 'GHS') + ' ' + Math.round(Number(n) || 0).toLocaleString(); }
function readFile(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res({ dataUrl: r.result, name: file.name }); r.onerror = rej; r.readAsDataURL(file); }); }
function openFile(path) {
  const w = window.open('', '_blank');
  fetch(API_URL + path, { headers: api.authHeaders() }).then((r) => (r.ok ? r.blob() : null)).then((b) => { if (b && w) w.location.href = URL.createObjectURL(b); else if (w) w.close(); }).catch(() => { if (w) w.close(); });
}

function Dialog({ title, icon, sub, onClose, onSubmit, children, busy, error, submit, width, danger }) {
  return createPortal(
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" style={{ width: 'min(' + (width || 560) + 'px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="agr-d-t" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">{icon}</span><div><h2 id="agr-d-t">{title}</h2>{sub && <p>{sub}</p>}</div></div>
        {children}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>{submit && <button type="submit" className={'btn ' + (danger ? 'btn-danger' : 'btn-primary')} disabled={busy}>{submit}</button>}</div>
      </form>
    </div>,
    document.body
  );
}
function useSend(onDone) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  return { busy, error, send: async (fn) => { setBusy(true); setError(null); try { onDone(await fn()); } catch (e) { setError(e.message); setBusy(false); } } };
}
function StatePill({ a }) { return <span className={'x7-pill ' + STATE[a.state][2]}>{STATE[a.state][0]} {tr(STATE[a.state][1])}</span>; }

function FormDialog({ d, a, onClose, onDone }) {
  const [f, setF] = useState(a ? { kind: a.kind, title: a.title, party: a.party, supplierId: a.supplier ? a.supplier.id : '', companyId: a.company ? a.company.id : '', site: a.site, reference: a.reference, startsOn: a.startsOn || '', endsOn: a.endsOn || '',
    noticeDays: a.noticeDays, autoRenews: a.autoRenews, renewMonths: a.renewMonths, value: a.value, currency: a.currency, per: a.per, escalation: a.escalation, ownerId: a.owner ? a.owner.id : '', note: a.note, removeFiles: [] }
    : { kind: 'lease', title: '', party: '', supplierId: '', companyId: (d.companies[0] || {}).id || '', site: '', reference: '', startsOn: '', endsOn: '', noticeDays: 90, autoRenews: false, renewMonths: 12, value: '', currency: 'GHS', per: 'month', escalation: 0, ownerId: '', note: '', removeFiles: [] });
  const [files, setFiles] = useState([]);
  const s = useSend(onDone);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  async function pick(e) { const list = await Promise.all(Array.from(e.target.files || []).slice(0, 6).map(readFile)); setFiles((x) => x.concat(list)); e.target.value = ''; }
  const notice = f.endsOn && f.noticeDays !== '' ? new Date(Date.parse(f.endsOn + 'T00:00:00Z') - Number(f.noticeDays) * 86400000).toISOString().slice(0, 10) : null;
  return (
    <Dialog title={a ? a.title : tr('An agreement')} icon={KIND[f.kind][0]} sub={tr('A lease or a contract the companies are bound by: who with, its term, its cost and the notice it takes.')} width={680}
      onClose={onClose} onSubmit={() => s.send(() => { const body = { ...f, addFiles: files }; return a ? api.put('/agreements/' + a.id, body) : api.post('/agreements', body); })} busy={s.busy} error={s.error} submit={tr('Save')}>
      <div className="agr-kinds" role="radiogroup" aria-label={tr('What kind')}>{Object.keys(KIND).map((k) => (
        <button key={k} type="button" role="radio" aria-checked={f.kind === k} className={f.kind === k ? 'is-on' : ''} onClick={() => set('kind', k)}><span aria-hidden="true">{KIND[k][0]}</span>{tr(KIND[k][1])}</button>
      ))}</div>
      <div className="x7-grid2">
        <label><span>{tr('What it is')}</span><input className="input" required value={f.title} onChange={(e) => set('title', e.target.value)} placeholder={tr('e.g. Factory lease, Tema')} /></label>
        {f.kind === 'supplier' ? <label><span>{tr('Supplier')}</span><select className="input" value={f.supplierId} onChange={(e) => { const sp = d.suppliers.find((x) => x.id === e.target.value); setF((x) => ({ ...x, supplierId: e.target.value, party: sp ? sp.name : x.party })); }}><option value="">—</option>{d.suppliers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
          : <label><span>{tr('Who with')}</span><input className="input" required value={f.party} onChange={(e) => set('party', e.target.value)} /></label>}
        <label><span>{tr('Company')}</span><select className="input" value={f.companyId} onChange={(e) => set('companyId', e.target.value)}><option value="">{tr('The group')}</option>{d.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label><span>{tr('Site or property')}</span><input className="input" value={f.site} onChange={(e) => set('site', e.target.value)} /></label>
        <label><span>{tr('Starts')}</span><input className="input" type="date" value={f.startsOn} onChange={(e) => set('startsOn', e.target.value)} /></label>
        <label><span>{tr('Ends')}</span><input className="input" type="date" value={f.endsOn} onChange={(e) => set('endsOn', e.target.value)} /></label>
        <label><span>{tr('Notice it takes (days)')}</span><input className="input" type="number" min="0" max="730" value={f.noticeDays} onChange={(e) => set('noticeDays', e.target.value)} />{notice && <small>{tr('Last day to give notice: {date}', { date: dayText(notice) })}</small>}</label>
        <label><span>{tr('Reference')}</span><input className="input" value={f.reference} onChange={(e) => set('reference', e.target.value)} /></label>
      </div>
      <div className="agr-money">
        <label><span>{tr('What it costs')}</span><input className="input" type="number" min="0" step="0.01" value={f.value} onChange={(e) => set('value', e.target.value)} /></label>
        <label><span>{tr('Currency')}</span><select className="input" value={f.currency} onChange={(e) => set('currency', e.target.value)}>{['GHS', 'USD', 'EUR', 'GBP', 'CNY'].map((c) => <option key={c}>{c}</option>)}</select></label>
        <label><span>{tr('How often')}</span><select className="input" value={f.per} onChange={(e) => set('per', e.target.value)}>{Object.keys(PER).map((p) => <option key={p} value={p}>{tr(PER[p])}</option>)}</select></label>
        <label><span>{tr('Yearly rise %')}</span><input className="input" type="number" min="0" max="100" step="0.5" value={f.escalation} onChange={(e) => set('escalation', e.target.value)} /></label>
      </div>
      <label className="agr-auto"><input type="checkbox" checked={f.autoRenews} onChange={(e) => set('autoRenews', e.target.checked)} /><span><b>🔁 {tr('Renews itself')}</b><small>{tr('Unless notice is given, it runs on for another term at its end.')}</small></span>
        {f.autoRenews && <input className="input" type="number" min="1" max="120" value={f.renewMonths} onChange={(e) => set('renewMonths', e.target.value)} aria-label={tr('Months a term')} title={tr('Months a term')} />}{f.autoRenews && <small>{tr('months')}</small>}</label>
      <div className="x7-grid2">
        <label><span>{tr('Who looks after it')}</span><select className="input" value={f.ownerId} onChange={(e) => set('ownerId', e.target.value)}><option value="">—</option>{d.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label><span>{tr('A copy (PDF or photo)')}</span><input className="input" type="file" accept="application/pdf,image/*" multiple onChange={pick} /></label>
      </div>
      {(files.length > 0 || (a && a.files.length > 0)) && <div className="agr-files">
        {a && a.files.filter((x) => f.removeFiles.indexOf(x.n) < 0).map((x) => <span key={'o' + x.n} className="x7-pill">📎 {x.name}<button type="button" onClick={() => set('removeFiles', f.removeFiles.concat([x.n]))} aria-label={tr('Remove')}>✕</button></span>)}
        {files.map((x, i) => <span key={'n' + i} className="x7-pill is-calm">📎 {x.name}<button type="button" onClick={() => setFiles(files.filter((y, j) => j !== i))} aria-label={tr('Remove')}>✕</button></span>)}
      </div>}
      <label><span>{tr('Note')}</span><textarea className="input" rows={2} value={f.note} onChange={(e) => set('note', e.target.value)} /></label>
    </Dialog>
  );
}

// The end of a new term as long as the last one (or the months it renews by).
function sameTerm(a, start) {
  let months = a.autoRenews && a.renewMonths ? Number(a.renewMonths) : 12;
  if (!(a.autoRenews && a.renewMonths) && a.startsOn && a.endsOn) {
    const m = Math.round(((Date.parse(a.endsOn + 'T00:00:00Z') - Date.parse(a.startsOn + 'T00:00:00Z')) / 86400000 + 1) / 30.44);
    if (m >= 1) months = m;
  }
  const d = new Date(start + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months); d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function RenewDialog({ a, onClose, onDone }) {
  const next = a.endsOn ? new Date(Date.parse(a.endsOn + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ startsOn: next, endsOn: sameTerm(a, next), value: Math.round(a.value * (1 + (a.escalation || 0) / 100) * 100) / 100, per: a.per, currency: a.currency, note: '' });
  const [files, setFiles] = useState([]);
  const s = useSend(onDone);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Dialog title={tr('Renew: {title}', { title: a.title })} icon="🔁" sub={tr('The new term. The one ending now goes to the history.')} onClose={onClose} onSubmit={() => s.send(() => api.post('/agreements/' + a.id + '/renew', { ...f, files }))} busy={s.busy} error={s.error} submit={tr('Renew')}>
      <div className="x7-grid2">
        <label><span>{tr('Starts')}</span><input className="input" type="date" value={f.startsOn} onChange={(e) => set('startsOn', e.target.value)} /></label>
        <label><span>{tr('Ends')}</span><input className="input" type="date" required min={next} value={f.endsOn} onChange={(e) => set('endsOn', e.target.value)} /></label>
        <label><span>{tr('What it costs')}</span><input className="input" type="number" min="0" step="0.01" value={f.value} onChange={(e) => set('value', e.target.value)} />{a.escalation > 0 && <small>{tr('{p}% up on {v}', { p: a.escalation, v: money(a.value, a.currency) })}</small>}</label>
        <label><span>{tr('How often')}</span><select className="input" value={f.per} onChange={(e) => set('per', e.target.value)}>{Object.keys(PER).map((p) => <option key={p} value={p}>{tr(PER[p])}</option>)}</select></label>
      </div>
      <label><span>{tr('The signed copy')}</span><input className="input" type="file" accept="application/pdf,image/*" multiple onChange={async (e) => setFiles(await Promise.all(Array.from(e.target.files || []).slice(0, 6).map(readFile)))} /></label>
      <label><span>{tr('Note')}</span><input className="input" value={f.note} onChange={(e) => set('note', e.target.value)} placeholder={tr('e.g. agreed a 3-year term')} /></label>
    </Dialog>
  );
}

function EndDialog({ a, onClose, onDone }) {
  const [f, setF] = useState({ on: a.endsOn && a.endsOn < new Date().toISOString().slice(0, 10) ? a.endsOn : new Date().toISOString().slice(0, 10), note: '' });
  const s = useSend(onDone);
  return (
    <Dialog title={tr('It has ended: {title}', { title: a.title })} icon="📁" sub={tr('It leaves the register and its reminders stop.')} onClose={onClose} onSubmit={() => s.send(() => api.post('/agreements/' + a.id + '/end', f))} busy={s.busy} error={s.error} submit={tr('Mark ended')} danger>
      <label><span>{tr('Ended on')}</span><input className="input" type="date" value={f.on} onChange={(e) => setF({ ...f, on: e.target.value })} /></label>
      <label><span>{tr('Why')}</span><input className="input" required value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder={tr('e.g. moved out, notice given on 1 March')} /></label>
    </Dialog>
  );
}

function Sheet({ id, d, onClose, onChanged }) {
  const [a, setA] = useState(null);
  const [error, setError] = useState(null);
  const [dlg, setDlg] = useState(null);
  const load = useCallback(() => api.get('/agreements/' + id).then(setA).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  const done = (x) => { setDlg(null); setA(x); onChanged(); };
  async function intent(k) { try { done(await api.post('/agreements/' + a.id + '/intent', { intent: a.intent === k ? null : k })); } catch (e) { setError(e.message); } }
  async function reopen() { try { done(await api.post('/agreements/' + a.id + '/reopen')); } catch (e) { setError(e.message); } }
  if (!a) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const tone = { ok: ['#15803d', '#0f766e'], notice_due: ['#d97706', '#db2777'], locked_in: ['#7c3aed', '#2563eb'], ending: ['#ea580c', '#d97706'], lapsed: ['#dc2626', '#9f1239'], renegotiating: ['#7c3aed', '#db2777'], open_ended: ['#0369a1', '#0f766e'], ended: ['#475569', '#334155'] }[a.state];
  // Where today sits in the term, for the bar.
  const t0 = a.startsOn ? Date.parse(a.startsOn) : null, t1 = a.endsOn ? Date.parse(a.endsOn) : null, nb = a.noticeBy ? Date.parse(a.noticeBy) : null;
  const pct = (t) => (t0 && t1 && t1 > t0 ? Math.max(0, Math.min(100, (t - t0) / (t1 - t0) * 100)) : null);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet agr-sheet" role="dialog" aria-modal="true" aria-labelledby="agr-s-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={{ '--g1': tone[0], '--g2': tone[1] }}>
          <span className="x7-icon" aria-hidden="true">{KIND[a.kind][0]}</span>
          <div><small>{a.ref} · {tr(KIND[a.kind][1])}{a.company ? ' · ' + a.company.name : ''}</small><h2 id="agr-s-t">{a.title}</h2>
            <p><span className="x7-pill">🤝 {a.party}</span><span className="x7-pill">{STATE[a.state][0]} {tr(STATE[a.state][1])}</span>{a.value > 0 && <span className="x7-pill">💰 {money(a.value, a.currency)} {tr(PER[a.per])}</span>}</p></div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {t0 && t1 && <div className="agr-term">
          <div className="agr-term-bar"><i style={{ width: pct(Date.now()) + '%' }} />{nb && <b style={{ left: pct(nb) + '%' }} title={tr('Last day to give notice')} />}</div>
          <div className="agr-term-axis"><small>{dayText(a.startsOn)}</small>{nb && <small className="is-notice">⏰ {tr('notice by {date}', { date: dayText(a.noticeBy) })}</small>}<small>{dayText(a.endsOn)}</small></div>
        </div>}
        <div className="agr-facts">
          <span><small>{tr('Ends')}</small><b>{a.endsOn ? dayText(a.endsOn) : '—'}</b>{a.daysLeft != null && <em>{inDays(a.daysLeft)}</em>}</span>
          <span><small>{tr('Notice by')}</small><b>{a.noticeBy ? dayText(a.noticeBy) : '—'}</b>{a.noticeLeft != null && <em className={a.noticeLeft >= 0 && a.noticeLeft <= 30 ? 'is-warn' : ''}>{inDays(a.noticeLeft)}</em>}</span>
          <span><small>{tr('A year')}</small><b>{a.yearly ? money(a.yearly, a.currency) : '—'}</b>{a.escalation > 0 && <em>{tr('+{p}% a year', { p: a.escalation })}</em>}</span>
          <span><small>{tr('Renews itself')}</small><b>{a.autoRenews ? tr('Yes, {n} months at a time', { n: a.renewMonths }) : tr('No')}</b></span>
          <span><small>{tr('Who looks after it')}</small><b>{a.owner ? a.owner.name : '—'}</b></span>
          <span><small>{tr('Reference')}</small><b>{a.reference || '—'}</b>{a.site && <em>{a.site}</em>}</span>
        </div>
        {a.status !== 'ended' && <div className="agr-intent">
          <b>{tr('When the notice date comes, we mean to:')}</b>
          <div className="x7-chips">{Object.keys(INTENT).map((k) => <button key={k} type="button" className={a.intent === k ? 'is-on' : ''} onClick={() => intent(k)}><em aria-hidden="true">{INTENT[k][0]}</em>{tr(INTENT[k][1])}</button>)}</div>
        </div>}
        {a.status === 'ended' && <p className="x7-note">📁 {tr('Ended on {date}', { date: dayText(a.endedOn) })}{a.endNote ? ': ' + a.endNote : ''}</p>}
        {a.note && <p className="x7-note">📝 {a.note}</p>}
        {a.files.length > 0 && <div className="agr-files">{a.files.map((f) => <button key={f.n} type="button" className="x7-pill is-calm" onClick={() => openFile('/agreements/' + a.id + '/files/' + f.n)}>📎 {f.name}</button>)}</div>}
        {a.history.length > 0 && <div className="agr-history">
          <h3>🗂️ {tr('Terms before')}</h3>
          {a.history.map((h) => (
            <div key={h.id} className="agr-hist-row"><span>{dayText(h.startsOn)} → {dayText(h.endsOn)}</span><span>{money(h.value, h.currency)} {tr(PER[h.per])}</span><span className="x7-pill">{h.how === 'auto' ? '🔁 ' + tr('renewed itself') : '✍️ ' + tr('renewed')}</span>
              {h.files.map((f) => <button key={f.n} type="button" className="x7-pill is-calm" onClick={() => openFile('/agreements/' + a.id + '/files/' + f.n + '?period=' + h.id)}>📎</button>)}</div>
          ))}
        </div>}
        <div className="agr-acts">
          {a.status === 'ended' ? <button type="button" className="btn btn-secondary" onClick={reopen}>↩️ {tr('In force again')}</button> : <>
            <button type="button" className="btn btn-primary" onClick={() => setDlg('renew')}>🔁 {tr('Renew')}</button>
            <button type="button" className="btn btn-secondary" onClick={() => setDlg('edit')}>✏️ {tr('Change')}</button>
            <button type="button" className="btn btn-secondary" onClick={() => setDlg('end')}>📁 {tr('It has ended')}</button>
          </>}
        </div>
        {dlg === 'edit' && <FormDialog d={d} a={a} onClose={() => setDlg(null)} onDone={done} />}
        {dlg === 'renew' && <RenewDialog a={a} onClose={() => setDlg(null)} onDone={done} />}
        {dlg === 'end' && <EndDialog a={a} onClose={() => setDlg(null)} onDone={done} />}
      </div>
    </div>
  );
}

export default function AgreementsPage() {
  const [params, setParams] = useSearchParams();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [view, setView] = useState('live');
  const [kind, setKind] = useState('');
  const [dlg, setDlg] = useState(null);
  const open = params.get('agreement');
  const load = useCallback(() => api.get('/agreements' + (view === 'ended' ? '?status=ended' : '')).then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), [view]);
  useEffect(() => { load(); }, [load]);
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const s = d.summary;
  const show = (a) => setParams(a ? { agreement: a.id } : {});
  const soon = d.agreements.filter((a) => ['notice_due', 'lapsed', 'renegotiating'].indexOf(a.state) >= 0 || (a.state === 'ending' && a.daysLeft <= 60));
  const list = d.agreements.filter((a) => !kind || a.kind === kind);
  const peak = Math.max(1, ...d.months.map((m) => m.notices + m.ends));
  const yearTop = Math.max(1, ...d.byKind.map((k) => k.yearly));
  return (
    <div className="x7 agr">
      <header className="x7-head">
        <div>
          <h1>📜 {tr('Leases and contracts')}</h1>
          <p>{tr('The leases and contracts the companies are bound by: what they cost, the last day to give notice, and the ones that renew themselves. Reminders come before the notice date and before the end.')}</p>
        </div>
        <div className="x7-head-actions"><button type="button" className="btn btn-primary" onClick={() => setDlg('new')}>📝 {tr('An agreement')}</button></div>
      </header>
      <div className="x7-tiles">
        <div className="x7-tile is-teal"><small>📜 {tr('In force')}</small><b>{s.live}</b><span>{s.autoRenew === 1 ? tr('1 renews itself') : tr('{n} renew themselves', { n: s.autoRenew })}</span></div>
        <div className="x7-tile is-violet"><small>💰 {tr('A year')}</small><b>{whole(s.yearlyGhs)}</b><span>{d.byCurrency.filter((c) => c.currency !== 'GHS').map((c) => whole(c.yearly, c.currency)).join(' · ') || tr('in cedis')}</span></div>
        <div className={'x7-tile ' + (s.noticeDue ? 'is-warn' : 'is-good')}><small>⏰ {tr('Notice due')}</small><b>{s.noticeDue}</b><span>{s.next ? tr('next: {title}, {when}', { title: s.next.title, when: inDays(s.next.noticeLeft) }) : tr('within 30 days')}</span></div>
        <div className="x7-tile is-calm"><small>🏁 {tr('Ending in 90 days')}</small><b>{s.endingSoon}</b><span>{tr('renew them or let them go')}</span></div>
        <div className={'x7-tile ' + (s.lapsed ? 'is-bad' : 'is-good')}><small>⛔ {tr('Ran out')}</small><b>{s.lapsed}</b><span>{s.lapsed ? tr('past their end, not renewed') : tr('none')}</span></div>
      </div>
      <div className="agr-top">
        <section className="x7-card agr-year">
          <h2>📅 {tr('The next twelve months')}</h2>
          <div className="agr-months">{d.months.map((m) => (
            <span key={m.month} className="agr-month" title={tr('{a} notice dates, {b} ends', { a: m.notices, b: m.ends })}>
              <span className="agr-stack">{m.notices > 0 && <i className="is-notice" style={{ height: (m.notices / peak * 100) + '%' }} />}{m.ends > 0 && <i className="is-end" style={{ height: (m.ends / peak * 100) + '%' }} />}</span>
              <small>{monthText(m.month)}</small>
            </span>
          ))}</div>
          <p className="agr-legend"><span><i className="is-notice" /> {tr('last day to give notice')}</span><span><i className="is-end" /> {tr('ends')}</span></p>
        </section>
        <section className="x7-card agr-kinds-cost">
          <h2>💰 {tr('What they cost a year')}</h2>
          {!d.byKind.length ? <p className="x7-muted">{tr('Nothing with a cost yet.')}</p> : d.byKind.map((k) => (
            <div key={k.kind} className="agr-kind-row"><span>{KIND[k.kind][0]} {tr(KIND[k.kind][1])}</span><i style={{ width: (k.yearly / yearTop * 100) + '%' }} /><b>{whole(k.yearly)}</b></div>
          ))}
        </section>
      </div>
      {view === 'live' && soon.length > 0 && <section className="agr-soon">
        <h2>⚡ {tr('To act on')}</h2>
        <div className="agr-soon-grid">{soon.map((a) => (
          <button key={a.id} type="button" className={'agr-soon-card is-' + a.state} onClick={() => show(a)}>
            <span className="agr-soon-icon" aria-hidden="true">{KIND[a.kind][0]}</span>
            <b>{a.title}</b><small>{a.party}</small>
            <StatePill a={a} />
            <em>{a.state === 'notice_due' ? tr('Give notice by {date} · {when}', { date: dayText(a.noticeBy), when: inDays(a.noticeLeft) }) : a.state === 'lapsed' ? tr('Ended {when}', { when: inDays(a.daysLeft) }) : tr('Ends {date} · {when}', { date: dayText(a.endsOn), when: inDays(a.daysLeft) })}</em>
          </button>
        ))}</div>
      </section>}
      <div className="x7-bar">
        <div className="x7-seg"><button type="button" className={view === 'live' ? 'is-on' : ''} onClick={() => setView('live')}>📜 {tr('In force')}</button><button type="button" className={view === 'ended' ? 'is-on' : ''} onClick={() => setView('ended')}>📁 {tr('Ended')}</button></div>
        <div className="x7-chips"><button type="button" className={!kind ? 'is-on' : ''} onClick={() => setKind('')}>{tr('All')}</button>{Object.keys(KIND).filter((k) => d.agreements.some((a) => a.kind === k)).map((k) => <button key={k} type="button" className={kind === k ? 'is-on' : ''} onClick={() => setKind(k)}><em aria-hidden="true">{KIND[k][0]}</em>{tr(KIND[k][1])}</button>)}</div>
      </div>
      {!list.length ? <div className="x7-empty"><span aria-hidden="true">📜</span><p>{view === 'ended' ? tr('Nothing has ended yet.') : tr('No leases or contracts yet. Add the factory lease first.')}</p></div> : <div className="x7-list">{list.map((a) => (
        <button key={a.id} type="button" className={'x7-row agr-row is-' + a.state} onClick={() => show(a)}>
          <span className="x7-icon" aria-hidden="true">{KIND[a.kind][0]}</span>
          <span className="x7-who"><b>{a.title}</b><small>{[a.party, a.company ? a.company.name : null, a.ref].filter(Boolean).join(' · ')}</small></span>
          <span className="agr-dates"><small>{a.endsOn ? tr('ends {date}', { date: dayText(a.endsOn) }) : tr('no end date')}</small>{a.noticeBy && a.noticeLeft >= 0 && <small className={a.noticeLeft <= 30 ? 'is-warn' : ''}>⏰ {tr('notice by {date}', { date: dayText(a.noticeBy) })}</small>}<StatePill a={a} /></span>
          <span className="x7-money"><b>{a.value ? money(a.value, a.currency) : '—'}</b><small>{a.value ? tr(PER[a.per]) : ''}{a.autoRenews ? ' · 🔁' : ''}</small></span>
        </button>
      ))}</div>}
      {dlg === 'new' && <FormDialog d={d} onClose={() => setDlg(null)} onDone={(a) => { setDlg(null); load(); show(a); }} />}
      {open && <Sheet key={open} id={open} d={d} onClose={() => show(null)} onChanged={load} />}
    </div>
  );
}
