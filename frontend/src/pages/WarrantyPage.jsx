import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams, Link } from 'react-router-dom';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import { useBlobUrl } from '../components/Photo';
import './seventeenth.css';
import './twentysecond.css';

// Warranty claims (Sales → Warranty claims; backend warranty.service.js,
// migration 0205): something wrong with a piece of BPL furniture, judged
// against its warranty from the day it was delivered. Opened from a
// customer's repair request or on an order; its cause, the decision and the
// remedy (the customer is told), the repair visit booked from it, and what
// it cost. A fault in the making goes to quality.

const CAUSE = {
  manufacturing: ['🔧', msg('A fault in the making')], material: ['🎋', msg('The material')], finish: ['🎨', msg('The finish')], hardware: ['🔩', msg('The fittings')],
  transit: ['🚚', msg('Damaged in transit')], installation: ['🛠️', msg('The installation')], misuse: ['⚠️', msg('Misuse')], wear: ['⏳', msg('Normal wear')], other: ['❔', msg('Something else')]
};
const OUR_FAULT = ['manufacturing', 'material', 'finish', 'hardware'];
const REMEDY = { repair: ['🛠️', msg('Repair it')], replace: ['🔁', msg('Replace it')], refund: ['💸', msg('Refund')], credit: ['🧾', msg('Credit their account')] };
const DECISION = { pending: ['⏳', msg('To decide'), 'is-warn'], accepted: ['✅', msg('Under warranty'), 'is-good'], goodwill: ['💚', msg('Goodwill'), 'is-teal'], rejected: ['✋', msg('Not covered'), 'is-bad'] };
const STATUS = { open: msg('Open'), in_hand: msg('In hand'), resolved: msg('Resolved'), closed: msg('Closed') };

function dayText(d) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—'; }
function monthText(m) { return new Date(m + '-01T12:00:00Z').toLocaleDateString(activeIntlLocale(), { month: 'short', timeZone: 'UTC' }); }
function readPhoto(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }); }

function Dialog({ title, icon, sub, onClose, onSubmit, children, busy, error, submit, width, danger }) {
  return createPortal(
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" style={{ width: 'min(' + (width || 560) + 'px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="wty-d-t" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">{icon}</span><div><h2 id="wty-d-t">{title}</h2>{sub && <p>{sub}</p>}</div></div>
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
function WarrantyPill({ c }) {
  if (c.inWarranty == null) return <span className="x7-pill">❔ {tr('No delivery date')}</span>;
  return c.inWarranty ? <span className="x7-pill is-good">🛡️ {tr('In warranty to {date}', { date: dayText(c.warrantyUntil) })}</span> : <span className="x7-pill is-bad">⌛ {tr('Warranty ended {date}', { date: dayText(c.warrantyUntil) })}</span>;
}

function NewDialog({ from, onClose, onDone }) {
  const [opts, setOpts] = useState(null);
  const [q, setQ] = useState('');
  const [f, setF] = useState({ serviceId: from ? from.id : '', order: '', productId: '', item: from ? from.item : '', problem: '', name: '', phone: '', deliveredOn: '', photos: [] });
  const s = useSend(onDone);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  useEffect(() => { const t = setTimeout(() => api.get('/warranty/options?q=' + encodeURIComponent(q)).then(setOpts).catch(() => {}), 250); return () => clearTimeout(t); }, [q]);
  const order = opts && f.order ? opts.orders.find((o) => o.kind + ':' + o.id === f.order) : null;
  function go() {
    const body = { productId: f.productId, item: f.item, problem: f.problem, deliveredOn: f.deliveredOn || (order && order.deliveredOn) || '', photos: f.photos };
    if (f.serviceId) body.serviceId = f.serviceId;
    else if (order) body[order.kind === 'sales' ? 'salesOrderId' : 'shopOrderId'] = order.id;
    else Object.assign(body, { name: f.name, phone: f.phone });
    return s.send(() => api.post('/warranty', body));
  }
  return (
    <Dialog title={from ? tr('A claim for {ref}', { ref: from.ref }) : tr('A warranty claim')} icon="🛡️" sub={from ? from.name + ' · ' + from.problem : tr('On an order, or for a customer without one. Its warranty runs from the delivery.')} onClose={onClose} onSubmit={go} busy={s.busy} error={s.error} submit={tr('Open the claim')} width={620}>
      {!from && <>
        <label><span>{tr('The order')}</span><input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Find an order by its number or the customer')} /></label>
        <div className="wty-orders">{(opts ? opts.orders : []).slice(0, 8).map((o) => (
          <button key={o.kind + o.id} type="button" className={f.order === o.kind + ':' + o.id ? 'is-on' : ''} onClick={() => set('order', f.order === o.kind + ':' + o.id ? '' : o.kind + ':' + o.id)}>
            <b>{o.orderNo}</b><small>{o.name}{o.deliveredOn ? ' · ' + tr('delivered {date}', { date: dayText(o.deliveredOn) }) : ''}</small><em>{o.kind === 'shop' ? '🛒' : '🧾'}</em>
          </button>
        ))}</div>
        {!order && <div className="x7-grid2">
          <label><span>{tr('Customer')}</span><input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} /></label>
          <label><span>{tr('Phone')}</span><input className="input" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></label>
        </div>}
      </>}
      <div className="x7-grid2">
        <label><span>{tr('Product')}</span><select className="input" value={f.productId} onChange={(e) => set('productId', e.target.value)}><option value="">—</option>{(opts ? opts.products : []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label><span>{tr('Delivered on')}</span><input className="input" type="date" value={f.deliveredOn || (order && order.deliveredOn) || ''} onChange={(e) => set('deliveredOn', e.target.value)} /></label>
      </div>
      <label><span>{tr('Which piece')}</span><input className="input" value={f.item} onChange={(e) => set('item', e.target.value)} placeholder={tr('e.g. the left armchair')} /></label>
      {!from && <label><span>{tr('What is wrong')}</span><textarea className="input" rows={3} required value={f.problem} onChange={(e) => set('problem', e.target.value)} /></label>}
      {!from && <label><span>{tr('Photos')}</span><input className="input" type="file" accept="image/*" multiple onChange={async (e) => set('photos', await Promise.all(Array.from(e.target.files || []).slice(0, 6).map(readPhoto)))} /></label>}
    </Dialog>
  );
}

function DecideDialog({ c, onClose, onDone }) {
  const [f, setF] = useState({ decision: c.inWarranty === false ? 'goodwill' : 'accepted', cause: c.cause || '', remedy: c.remedy && c.remedy !== 'none' ? c.remedy : 'repair', note: c.decisionNote || '' });
  const s = useSend(onDone);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Dialog title={tr('Decide on {ref}', { ref: c.ref })} icon="⚖️" sub={tr('The customer is told by text and email. A fault in the making goes to quality too.')} onClose={onClose} onSubmit={() => s.send(() => api.post('/warranty/' + c.id + '/decision', f))} busy={s.busy} error={s.error} submit={tr('Decide')} width={640}>
      <div className="wty-pick" role="radiogroup" aria-label={tr('The decision')}>{['accepted', 'goodwill', 'rejected'].map((k) => (
        <button key={k} type="button" role="radio" aria-checked={f.decision === k} className={'is-' + k + (f.decision === k ? ' is-on' : '')} onClick={() => set('decision', k)}><span aria-hidden="true">{DECISION[k][0]}</span><b>{tr(DECISION[k][1])}</b>
          <small>{k === 'accepted' ? tr('Covered by the warranty') : k === 'goodwill' ? tr('Not covered, but we will') : tr('We will not cover it')}</small></button>
      ))}</div>
      <span className="wty-label">{tr('What caused it')}</span>
      <div className="x7-chips">{Object.keys(CAUSE).map((k) => <button key={k} type="button" className={f.cause === k ? 'is-on' : ''} onClick={() => set('cause', k)}><em aria-hidden="true">{CAUSE[k][0]}</em>{tr(CAUSE[k][1])}</button>)}</div>
      {f.decision !== 'rejected' && <><span className="wty-label">{tr('What we will do')}</span>
        <div className="x7-chips">{Object.keys(REMEDY).map((k) => <button key={k} type="button" className={f.remedy === k ? 'is-on' : ''} onClick={() => set('remedy', k)}><em aria-hidden="true">{REMEDY[k][0]}</em>{tr(REMEDY[k][1])}</button>)}</div></>}
      <label><span>{f.decision === 'rejected' ? tr('Why, for the customer') : tr('A word for the customer')}</span><textarea className="input" rows={2} required={f.decision === 'rejected'} value={f.note} onChange={(e) => set('note', e.target.value)} /></label>
    </Dialog>
  );
}

function ResolveDialog({ c, onClose, onDone }) {
  const [f, setF] = useState({ parts: c.costs.parts || '', labour: c.costs.labour || '', transport: c.costs.transport || '', refund: c.costs.refund || '', resolution: c.resolution || '', customerHappy: c.customerHappy });
  const s = useSend(onDone);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const total = ['parts', 'labour', 'transport', 'refund'].reduce((a, k) => a + (Number(f[k]) || 0), 0);
  const body = { costs: { parts: f.parts, labour: f.labour, transport: f.transport, refund: f.refund }, resolution: f.resolution, customerHappy: f.customerHappy };
  return (
    <Dialog title={c.status === 'resolved' ? tr('What it cost: {ref}', { ref: c.ref }) : tr('Resolved: {ref}', { ref: c.ref })} icon="🏁" sub={tr('What was done, what it cost us, and whether the customer is happy.')} onClose={onClose}
      onSubmit={() => s.send(() => (c.status === 'resolved' || c.status === 'closed' ? api.put('/warranty/' + c.id, body) : api.post('/warranty/' + c.id + '/resolve', body)))} busy={s.busy} error={s.error} submit={tr('Save')} width={600}>
      <label><span>{tr('What was done')}</span><textarea className="input" rows={2} required value={f.resolution} onChange={(e) => set('resolution', e.target.value)} /></label>
      <div className="wty-costs">
        <label><span>🔩 {tr('Parts')}</span><input className="input" type="number" min="0" step="0.01" value={f.parts} onChange={(e) => set('parts', e.target.value)} /></label>
        <label><span>👷 {tr('Labour')}</span><input className="input" type="number" min="0" step="0.01" value={f.labour} onChange={(e) => set('labour', e.target.value)} /></label>
        <label><span>🚚 {tr('Transport')}</span><input className="input" type="number" min="0" step="0.01" value={f.transport} onChange={(e) => set('transport', e.target.value)} /></label>
        <label><span>💸 {tr('Refunded')}</span><input className="input" type="number" min="0" step="0.01" value={f.refund} onChange={(e) => set('refund', e.target.value)} /></label>
      </div>
      <p className="wty-total">{tr('It cost us {v}', { v: money(total) })}</p>
      <span className="wty-label">{tr('Is the customer happy?')}</span>
      <div className="x7-chips"><button type="button" className={f.customerHappy === true ? 'is-on' : ''} onClick={() => set('customerHappy', true)}>😊 {tr('Happy')}</button><button type="button" className={f.customerHappy === false ? 'is-on' : ''} onClick={() => set('customerHappy', false)}>😞 {tr('Not happy')}</button><button type="button" className={f.customerHappy == null ? 'is-on' : ''} onClick={() => set('customerHappy', null)}>🤷 {tr('Not asked')}</button></div>
    </Dialog>
  );
}

function ClaimPhoto({ id, n }) {
  const url = useBlobUrl('/warranty/' + id + '/photos/' + n, 1);
  return url ? <a href={url} target="_blank" rel="noreferrer" className="wty-photo"><img src={url} alt={tr('Photo {n}', { n: n + 1 })} /></a> : <span className="wty-photo is-wait" />;
}

function Sheet({ id, d, onClose, onChanged }) {
  const [c, setC] = useState(null);
  const [error, setError] = useState(null);
  const [dlg, setDlg] = useState(null);
  const load = useCallback(() => api.get('/warranty/' + id).then(setC).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  const done = (x) => { setDlg(null); setC(x); onChanged(); };
  async function act(path) { try { done(await api.post('/warranty/' + c.id + '/' + path)); } catch (e) { setError(e.message); } }
  if (!c) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const tone = c.decision === 'rejected' ? ['#dc2626', '#9f1239'] : c.status === 'resolved' || c.status === 'closed' ? ['#15803d', '#0f766e'] : c.decision === 'pending' ? ['#d97706', '#db2777'] : ['#0369a1', '#7c3aed'];
  const live = c.status === 'open' || c.status === 'in_hand';
  const steps = [['🛡️', tr('Opened'), true], ['⚖️', tr('Decided'), c.decision !== 'pending'], ['🛠️', tr('In hand'), c.status !== 'open' || c.decision === 'rejected'], ['🏁', tr('Resolved'), c.status === 'resolved' || c.status === 'closed']];
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet wty-sheet" role="dialog" aria-modal="true" aria-labelledby="wty-s-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={{ '--g1': tone[0], '--g2': tone[1] }}>
          <span className="x7-icon" aria-hidden="true">🛡️</span>
          <div><small>{c.ref}{c.salesOrder ? ' · ' + c.salesOrder.orderNo : ''}{c.shopOrder ? ' · ' + c.shopOrder.orderNo : ''}{c.service ? ' · ' + c.service.ref : ''}</small><h2 id="wty-s-t">{c.product ? c.product.name : c.item || tr('Warranty claim')}</h2>
            <p><span className="x7-pill">👤 {c.name}</span><span className="x7-pill">{DECISION[c.decision][0]} {tr(DECISION[c.decision][1])}</span><span className="x7-pill">{tr(STATUS[c.status])}</span></p></div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <ol className="wty-steps">{steps.map((s, i) => <li key={i} className={s[2] ? 'is-done' : ''}><span aria-hidden="true">{s[0]}</span>{s[1]}</li>)}</ol>
        <div className="wty-facts">
          <span><small>{tr('Delivered')}</small><b>{dayText(c.deliveredOn)}</b></span>
          <span><small>{tr('Warranty')}</small><WarrantyPill c={c} /></span>
          <span><small>{tr('Cause')}</small><b>{c.cause ? CAUSE[c.cause][0] + ' ' + tr(CAUSE[c.cause][1]) : '—'}</b></span>
          <span><small>{tr('Remedy')}</small><b>{c.remedy && REMEDY[c.remedy] ? REMEDY[c.remedy][0] + ' ' + tr(REMEDY[c.remedy][1]) : '—'}</b></span>
        </div>
        <div className="wty-problem"><b>{tr('What is wrong')}</b><p>{c.problem}</p>{c.item && c.product && <small>{c.item}</small>}
          {c.photos > 0 && <div className="wty-photos">{Array.from({ length: c.photos }, (_, n) => <ClaimPhoto key={n} id={c.id} n={n} />)}</div>}</div>
        {c.decisionNote && <p className="x7-note">💬 {c.decisionNote}{c.decidedBy ? ' — ' + c.decidedBy : ''}</p>}
        {c.visitList.length > 0 && <div className="wty-visits"><b>🚚 {tr('Visits')}</b>{c.visitList.map((v) => <Link key={v.id} to={'/bplvisits'} className="x7-row wty-visit"><span className="x7-icon" aria-hidden="true">{v.status === 'done' ? '✅' : '🛠️'}</span><span className="x7-who"><b>{v.ref} · {dayText(v.day)} {v.from}–{v.to}</b><small>{v.status === 'done' ? tr('Done, signed by {name}', { name: v.signedName || '—' }) : v.outcome || tr('Planned')}</small></span><span /><span /></Link>)}</div>}
        {(c.status === 'resolved' || c.status === 'closed') && <div className="wty-cost"><span>🔩 {money(c.costs.parts)}</span><span>👷 {money(c.costs.labour)}</span><span>🚚 {money(c.costs.transport)}</span>{c.costs.refund > 0 && <span>💸 {money(c.costs.refund)}</span>}<b>{tr('It cost us {v}', { v: money(c.costs.total) })}</b>{c.customerHappy != null && <em>{c.customerHappy ? '😊 ' + tr('Happy') : '😞 ' + tr('Not happy')}</em>}</div>}
        {c.resolution && <p className="x7-note">🏁 {c.resolution}</p>}
        {d.canManage && <div className="wty-acts">
          {live && <button type="button" className={'btn ' + (c.decision === 'pending' ? 'btn-primary' : 'btn-secondary')} onClick={() => setDlg('decide')}>⚖️ {c.decision === 'pending' ? tr('Decide') : tr('Change the decision')}</button>}
          {live && c.decision !== 'pending' && c.decision !== 'rejected' && (c.remedy === 'repair' || c.remedy === 'replace') && <Link className="btn btn-secondary" to={'/bplvisits?claim=' + c.id}>🚚 {tr('Book the visit')}</Link>}
          {live && c.decision !== 'pending' && <button type="button" className="btn btn-primary" onClick={() => setDlg('resolve')}>🏁 {tr('Resolved')}</button>}
          {c.status === 'resolved' && <button type="button" className="btn btn-secondary" onClick={() => setDlg('resolve')}>💰 {tr('What it cost')}</button>}
          {c.status === 'resolved' && <button type="button" className="btn btn-secondary" onClick={() => act('close')}>📁 {tr('Close')}</button>}
          {(c.status === 'resolved' || c.status === 'closed') && <button type="button" className="btn btn-secondary" onClick={() => act('reopen')}>↩️ {tr('Open again')}</button>}
        </div>}
        {c.history.length > 0 && <details className="wty-history"><summary>🗒️ {tr('What happened')} ({c.history.length})</summary>{c.history.map((h, i) => <p key={i}><small>{new Date(h.at).toLocaleString(activeIntlLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · {h.by}</small>{h.what}</p>)}</details>}
        {dlg === 'decide' && <DecideDialog c={c} onClose={() => setDlg(null)} onDone={done} />}
        {dlg === 'resolve' && <ResolveDialog c={c} onClose={() => setDlg(null)} onDone={done} />}
      </div>
    </div>
  );
}

export default function WarrantyPage() {
  const [params, setParams] = useSearchParams();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [view, setView] = useState('open');
  const [dlg, setDlg] = useState(null);
  const open = params.get('claim');
  const load = useCallback(() => api.get('/warranty').then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const s = d.summary;
  const show = (c) => setParams(c ? { claim: c.id } : {});
  const list = d.claims.filter((c) => (view === 'open' ? c.status === 'open' || c.status === 'in_hand' : c.status === 'resolved' || c.status === 'closed'));
  const top = Math.max(1, ...d.months.map((m) => m.claims));
  const causeTop = Math.max(1, ...d.byCause.map((x) => x.claims));
  return (
    <div className="x7 wty">
      <header className="x7-head">
        <div>
          <h1>🛡️ {tr('Warranty claims')}</h1>
          <p>{tr('Furniture that went wrong after delivery, judged against its warranty: the cause, the decision and the remedy, the repair visit, and what it cost us. Faults in the making go to quality.')}</p>
        </div>
        {d.canManage && <div className="x7-head-actions"><button type="button" className="btn btn-primary" onClick={() => setDlg({ k: 'new' })}>🛡️ {tr('A claim')}</button></div>}
      </header>
      <div className="x7-tiles">
        <div className={'x7-tile ' + (s.toDecide ? 'is-warn' : 'is-good')}><small>⚖️ {tr('To decide')}</small><b>{s.toDecide}</b><span>{tr('{n} open in all', { n: s.open })}</span></div>
        <div className={'x7-tile ' + (s.requests ? 'is-warn' : 'is-good')}><small>📨 {tr('Repair requests')}</small><b>{s.requests}</b><span>{tr('from customers, to judge')}</span></div>
        <div className="x7-tile is-teal"><small>✅ {tr('Accepted')}</small><b>{s.decided ? Math.round(s.accepted / s.decided * 100) + '%' : '—'}</b><span>{tr('{a} of {b} decided this year', { a: s.accepted, b: s.decided })}</span></div>
        <div className="x7-tile is-violet"><small>💰 {tr('What warranty cost')}</small><b>{money(s.cost)}</b><span>{tr('12 months')}</span></div>
        <div className="x7-tile is-calm"><small>⏱️ {tr('Days to put right')}</small><b>{s.daysToResolve != null ? s.daysToResolve : '—'}</b><span>{s.asked ? tr('{a} of {b} customers happy', { a: s.happy, b: s.asked }) : tr('on average')}</span></div>
        <div className={'x7-tile ' + (s.ourFault ? 'is-bad' : 'is-good')}><small>🔧 {tr('Our fault')}</small><b>{s.ourFault}</b><span>{tr('made, timber, finish or fittings')}</span></div>
      </div>
      {d.requests.length > 0 && <section className="x7-card wty-requests">
        <h2>📨 {tr('Repair requests to judge')} <small>{d.requests.length}</small></h2>
        <div className="wty-req-grid">{d.requests.map((r) => (
          <div key={r.id} className="wty-req">
            <span className="wty-req-top"><b>{r.ref}</b>{r.inWarranty == null ? <span className="x7-pill">❔</span> : r.inWarranty ? <span className="x7-pill is-good">🛡️ {tr('in warranty')}</span> : <span className="x7-pill is-bad">⌛ {tr('ended')}</span>}</span>
            <b>{r.item || tr('Something they bought')}</b><small>{r.name}{r.orderNo ? ' · ' + r.orderNo : ''}{r.photos ? ' · 📸 ' + r.photos : ''}</small>
            <p>{r.problem}</p>
            {d.canManage && <button type="button" className="btn btn-sm btn-primary" onClick={() => setDlg({ k: 'new', from: r })}>🛡️ {tr('Open a claim')}</button>}
          </div>
        ))}</div>
      </section>}
      <div className="wty-charts">
        <section className="x7-card">
          <h2>📈 {tr('Claims a month')} <small>{tr('12 months')}</small></h2>
          <div className="wty-months">{d.months.map((m) => (
            <span key={m.month} title={tr('{n} claims, {o} our fault', { n: m.claims, o: m.ourFault })}><i style={{ height: (m.claims / top * 100) + '%' }}>{m.ourFault > 0 && <em style={{ height: (m.ourFault / Math.max(1, m.claims) * 100) + '%' }} />}</i><small>{monthText(m.month)}</small></span>
          ))}</div>
          <p className="agr-legend"><span><i className="wty-dot-all" /> {tr('claims')}</span><span><i className="wty-dot-ours" /> {tr('our fault')}</span></p>
        </section>
        <section className="x7-card">
          <h2>🔍 {tr('What caused them')}</h2>
          {!d.byCause.length ? <p className="x7-muted">{tr('Nothing decided yet.')}</p> : d.byCause.map((x) => (
            <div key={x.cause} className={'wty-cause' + (OUR_FAULT.indexOf(x.cause) >= 0 ? ' is-ours' : '')}><span>{CAUSE[x.cause][0]} {tr(CAUSE[x.cause][1])}</span><i style={{ width: (x.claims / causeTop * 100) + '%' }} /><b>{x.claims}</b></div>
          ))}
        </section>
        <section className="x7-card">
          <h2>🪑 {tr('By product')}</h2>
          {!d.byProduct.length ? <p className="x7-muted">{tr('No claims yet.')}</p> : <div className="x7-list">{d.byProduct.map((p) => (
            <div key={p.product} className="wty-prod"><b>{p.product}</b><small>{p.claims === 1 ? tr('1 claim') : tr('{n} claims', { n: p.claims })}{p.ourFault ? ' · ' + tr('{n} our fault', { n: p.ourFault }) : ''}</small><span>{money(p.cost)}</span></div>
          ))}</div>}
        </section>
      </div>
      <div className="x7-bar"><div className="x7-seg"><button type="button" className={view === 'open' ? 'is-on' : ''} onClick={() => setView('open')}>🛠️ {tr('Open')} <i>{s.open}</i></button><button type="button" className={view === 'done' ? 'is-on' : ''} onClick={() => setView('done')}>🏁 {tr('Resolved')}</button></div></div>
      {!list.length ? <div className="x7-empty"><span aria-hidden="true">🛡️</span><p>{view === 'open' ? tr('No open claims. 🎉') : tr('Nothing resolved lately.')}</p></div> : <div className="x7-list">{list.map((c) => (
        <button key={c.id} type="button" className={'x7-row wty-row is-' + c.decision} onClick={() => show(c)}>
          <span className="x7-icon" aria-hidden="true">{c.cause ? CAUSE[c.cause][0] : '🛡️'}</span>
          <span className="x7-who"><b>{c.ref} · {c.product ? c.product.name : c.item || '—'}</b><small>{c.name} · {c.problem}</small></span>
          <span className="wty-row-tags"><WarrantyPill c={c} /><span className={'x7-pill ' + DECISION[c.decision][2]}>{DECISION[c.decision][0]} {tr(DECISION[c.decision][1])}</span>{c.nextVisit && <span className="x7-pill is-calm">🚚 {dayText(c.nextVisit)}</span>}</span>
          <span className="x7-money"><b>{c.costs.total ? money(c.costs.total) : (c.daysOpen === 1 ? tr('1 day') : tr('{n} days', { n: c.daysOpen }))}</b><small>{tr(STATUS[c.status])}</small></span>
        </button>
      ))}</div>}
      {dlg && dlg.k === 'new' && <NewDialog from={dlg.from} onClose={() => setDlg(null)} onDone={(c) => { setDlg(null); load(); show(c); }} />}
      {open && <Sheet key={open} id={open} d={d} onClose={() => show(null)} onChanged={load} />}
    </div>
  );
}
