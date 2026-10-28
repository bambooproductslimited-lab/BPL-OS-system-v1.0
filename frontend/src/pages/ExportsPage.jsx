import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { API_URL, api } from '../api/client';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './seventeenth.css';
import './twentysecond.css';

// Export papers (Sales → Export papers; backend exports.service.js,
// migration 0205): a shipment abroad, usually from a sales order — the lines
// with their HS codes, the packages with their marks, weights and sizes, the
// route and the Incoterm — and the three documents printed from it: the
// proforma invoice, the packing list and the certificate of origin. The
// other papers it needs are ticked off as they come in.

const STATUS = { draft: ['📝', msg('Draft'), 'is-calm'], proforma_sent: ['📨', msg('Proforma sent'), 'is-violet'], packed: ['📦', msg('Packed'), 'is-warn'], shipped: ['🚢', msg('Shipped'), 'is-good'], cancelled: ['⛔', msg('Cancelled'), ''] };
const NEXT = { draft: ['proforma_sent', msg('Proforma sent')], proforma_sent: ['packed', msg('Packed')], packed: ['shipped', msg('Shipped')] };
const PAPER = { phyto: msg('Phytosanitary certificate'), fumigation: msg('Fumigation certificate'), permit: msg('Export permit'), customs: msg('Customs export declaration'), origin: msg('Certificate of origin (certified)'), bl: msg('Bill of lading / air waybill') };
const KIND = { carton: msg('carton'), crate: msg('crate'), pallet: msg('pallet'), bundle: msg('bundle'), bale: msg('bale'), box: msg('box'), piece: msg('piece') };
const TRANSPORT = { sea: ['🚢', msg('By sea')], air: ['✈️', msg('By air')], road: ['🚛', msg('By road')] };
const DOCS = [['proforma', '🧾', msg('Proforma invoice')], ['packing', '📦', msg('Packing list')], ['origin', '🇬🇭', msg('Certificate of origin')]];
const STEPS = ['draft', 'proforma_sent', 'packed', 'shipped'];


// The container the goods fit: a 20-foot (about 33 m³ of cargo), a 40-foot
// (67 m³) or a 40-foot high cube (76 m³); more than that takes several.
function containerFor(cbm) {
  const v = Number(cbm) || 0;
  if (v <= 33) return { fill: v / 33 * 100, text: tr('{p}% of a 20-foot container', { p: Math.round(v / 33 * 100) }) };
  if (v <= 67) return { fill: v / 67 * 100, text: tr('{p}% of a 40-foot container', { p: Math.round(v / 67 * 100) }) };
  if (v <= 76) return { fill: v / 76 * 100, text: tr('{p}% of a 40-foot high cube', { p: Math.round(v / 76 * 100) }) };
  const n = Math.ceil(v / 76);
  return { fill: 100, text: tr('{n} × 40-foot high cubes, {p}% full', { n, p: Math.round(v / (n * 76) * 100) }) };
}
function dayText(d) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—'; }
function num(v, p = 2) { return (Math.round((Number(v) || 0) * 10 ** p) / 10 ** p).toLocaleString(activeIntlLocale()); }
function openPdf(path) {
  const w = window.open('', '_blank');
  fetch(API_URL + path, { headers: api.authHeaders() }).then((r) => (r.ok ? r.blob() : null)).then((b) => { if (b && w) w.location.href = URL.createObjectURL(b); else if (w) w.close(); }).catch(() => { if (w) w.close(); });
}

function Field({ label, children, wide }) { return <label className={wide ? 'exp-wide' : ''}><span>{label}</span>{children}</label>; }

// The shipment, all of it editable until it sails.
function Sheet({ id, d, onClose, onChanged }) {
  const [x, setX] = useState(null);
  const [f, setF] = useState(null);
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('goods');
  const take = (r) => { setX(r); setF(JSON.parse(JSON.stringify(r))); };
  useEffect(() => { api.get('/exports/' + id).then(take).catch((e) => setError(e.message)); }, [id]);
  if (!x) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const locked = x.status === 'shipped' || x.status === 'cancelled' || !d.canManage;
  const set = (k, v) => setF((o) => ({ ...o, [k]: v }));
  const setParty = (who, k, v) => setF((o) => ({ ...o, [who]: { ...o[who], [k]: v } }));
  const setLine = (i, k, v) => setF((o) => ({ ...o, lines: o.lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)) }));
  const setPkg = (i, k, v) => setF((o) => ({ ...o, packages: o.packages.map((p, j) => (j === i ? { ...p, [k]: v } : p)) }));
  const dirty = JSON.stringify(f) !== JSON.stringify(x);
  async function save(then) {
    setBusy(true); setError(null);
    try { const r = await api.put('/exports/' + x.id, f); take(r); onChanged(); if (then) await then(); else setFlash(tr('Saved.')); } catch (e) { setError(e.message); }
    setBusy(false);
  }
  async function move(status) {
    const go = async () => { const r = await api.post('/exports/' + x.id + '/status', { status }); take(r); onChanged(); setFlash(tr('Now: {s}', { s: tr(STATUS[status][1]) })); };
    if (dirty) return save(go);
    setBusy(true); setError(null);
    try { await go(); } catch (e) { setError(e.message); }
    setBusy(false);
  }
  // Live sums from what is typed.
  const goods = f.lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
  const withFreight = ['CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'].indexOf(f.incoterm) >= 0, withIns = ['CIF', 'CIP', 'DAP', 'DPU', 'DDP'].indexOf(f.incoterm) >= 0;
  const total = goods + (withFreight ? Number(f.freight) || 0 : 0) + (withIns ? Number(f.insurance) || 0 : 0);
  const pk = f.packages.reduce((a, p) => ({ n: a.n + (Number(p.count) || 0), net: a.net + (Number(p.netKg) || 0) * (Number(p.count) || 0), gross: a.gross + (Number(p.grossKg) || 0) * (Number(p.count) || 0), cbm: a.cbm + (Number(p.l) || 0) * (Number(p.w) || 0) * (Number(p.h) || 0) / 1e6 * (Number(p.count) || 0) }), { n: 0, net: 0, gross: 0, cbm: 0 });
  const at = STEPS.indexOf(x.status);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet exp-sheet" role="dialog" aria-modal="true" aria-labelledby="exp-s-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={{ '--g1': x.status === 'shipped' ? '#0f766e' : '#0369a1', '--g2': x.status === 'shipped' ? '#15803d' : '#7c3aed' }}>
          <span className="x7-icon" aria-hidden="true">{TRANSPORT[x.transport][0]}</span>
          <div><small>{x.ref}{x.salesOrder ? ' · ' + x.salesOrder.orderNo : ''}</small><h2 id="exp-s-t">{x.consignee.name || tr('A shipment')}</h2>
            <p><span className="x7-pill">{STATUS[x.status][0]} {tr(STATUS[x.status][1])}</span>{x.country && <span className="x7-pill">📍 {x.country}</span>}<span className="x7-pill">{x.incoterm} {x.incotermPlace}</span><b>{money(total, f.currency)}</b></p></div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {flash && <p className="x7-flash is-good" role="status">✅ {flash}</p>}
        <ol className="exp-steps">{STEPS.map((k, i) => <li key={k} className={i <= at ? 'is-done' : ''}><span aria-hidden="true">{STATUS[k][0]}</span>{tr(STATUS[k][1])}</li>)}</ol>
        <div className="exp-docs">{DOCS.map((doc) => (
          <button key={doc[0]} type="button" className="exp-doc" onClick={() => (dirty && !locked ? save(async () => openPdf('/exports/' + x.id + '/pdf/' + doc[0])) : openPdf('/exports/' + x.id + '/pdf/' + doc[0]))}>
            <span aria-hidden="true">{doc[1]}</span><b>{tr(doc[2])}</b><small>PDF</small>
          </button>
        ))}</div>
        <div className="x7-seg exp-tabs">{[['goods', '📋', msg('Goods')], ['packing', '📦', msg('Packing')], ['route', '🧭', msg('Route and terms')], ['parties', '👥', msg('Buyer')], ['papers', '🗂️', msg('Papers')]].map((t) => (
          <button key={t[0]} type="button" className={tab === t[0] ? 'is-on' : ''} onClick={() => setTab(t[0])}>{t[1]} {tr(t[2])}{t[0] === 'papers' && <i>{x.papersDone}/{d.papers.length}</i>}</button>
        ))}</div>
        <fieldset disabled={locked} className="exp-body">
          {tab === 'goods' && <>
            <div className="exp-table exp-lines">
              <div className="exp-th"><span>{tr('Description')}</span><span>{tr('HS code')}</span><span>{tr('Quantity')}</span><span>{tr('Unit')}</span><span>{tr('Unit price')}</span><span>{tr('Amount')}</span><span /></div>
              {f.lines.map((l, i) => (
                <div key={i} className="exp-tr">
                  <input className="input" value={l.description} onChange={(e) => setLine(i, 'description', e.target.value)} aria-label={tr('Description')} />
                  <input className={'input' + (l.hsCode ? '' : ' is-missing')} list="exp-hs" value={l.hsCode} onChange={(e) => setLine(i, 'hsCode', e.target.value)} aria-label={tr('HS code')} placeholder="9403.82" />
                  <input className="input" type="number" min="0" step="any" value={l.qty} onChange={(e) => setLine(i, 'qty', e.target.value)} aria-label={tr('Quantity')} />
                  <input className="input" value={l.unit} onChange={(e) => setLine(i, 'unit', e.target.value)} aria-label={tr('Unit')} />
                  <input className="input" type="number" min="0" step="0.01" value={l.unitPrice} onChange={(e) => setLine(i, 'unitPrice', e.target.value)} aria-label={tr('Unit price')} />
                  <b>{money((Number(l.qty) || 0) * (Number(l.unitPrice) || 0), f.currency)}</b>
                  <button type="button" className="exp-del" onClick={() => set('lines', f.lines.filter((y, j) => j !== i))} aria-label={tr('Remove')}>✕</button>
                </div>
              ))}
              <datalist id="exp-hs">{d.hs.map((h) => <option key={h.code} value={h.code}>{h.what}</option>)}</datalist>
            </div>
            {!locked && <button type="button" className="btn btn-secondary btn-sm" onClick={() => set('lines', f.lines.concat([{ description: '', hsCode: '', qty: 1, unit: 'pcs', unitPrice: 0 }]))}>➕ {tr('A line')}</button>}
            <div className="exp-totals">
              <span><small>{tr('Goods')}</small><b>{money(goods, f.currency)}</b></span>
              {withFreight && <label><small>{tr('Freight')}</small><input className="input" type="number" min="0" step="0.01" value={f.freight} onChange={(e) => set('freight', e.target.value)} /></label>}
              {withIns && <label><small>{tr('Insurance')}</small><input className="input" type="number" min="0" step="0.01" value={f.insurance} onChange={(e) => set('insurance', e.target.value)} /></label>}
              <span className="is-total"><small>{tr('Total {term}', { term: f.incoterm })}</small><b>{money(total, f.currency)}</b></span>
            </div>
          </>}
          {tab === 'packing' && <>
            <div className="exp-table exp-pkgs">
              <div className="exp-th"><span>{tr('Marks')}</span><span>{tr('How many')}</span><span>{tr('Packed in')}</span><span>{tr('Contents')}</span><span>{tr('Net kg each')}</span><span>{tr('Gross kg each')}</span><span>{tr('L × W × H cm')}</span><span /></div>
              {f.packages.map((p, i) => (
                <div key={i} className="exp-tr">
                  <input className="input" value={p.marks} onChange={(e) => setPkg(i, 'marks', e.target.value)} aria-label={tr('Marks')} />
                  <input className="input" type="number" min="1" value={p.count} onChange={(e) => setPkg(i, 'count', e.target.value)} aria-label={tr('How many')} />
                  <select className="input" value={p.kind} onChange={(e) => setPkg(i, 'kind', e.target.value)} aria-label={tr('Packed in')}>{d.kinds.map((k) => <option key={k} value={k}>{tr(KIND[k])}</option>)}</select>
                  <input className="input" value={p.contents} onChange={(e) => setPkg(i, 'contents', e.target.value)} aria-label={tr('Contents')} />
                  <input className="input" type="number" min="0" step="any" value={p.netKg} onChange={(e) => setPkg(i, 'netKg', e.target.value)} aria-label={tr('Net kg each')} />
                  <input className="input" type="number" min="0" step="any" value={p.grossKg} onChange={(e) => setPkg(i, 'grossKg', e.target.value)} aria-label={tr('Gross kg each')} />
                  <span className="exp-dims"><input className="input" type="number" min="0" value={p.l} onChange={(e) => setPkg(i, 'l', e.target.value)} aria-label={tr('Length cm')} /><input className="input" type="number" min="0" value={p.w} onChange={(e) => setPkg(i, 'w', e.target.value)} aria-label={tr('Width cm')} /><input className="input" type="number" min="0" value={p.h} onChange={(e) => setPkg(i, 'h', e.target.value)} aria-label={tr('Height cm')} /></span>
                  <button type="button" className="exp-del" onClick={() => set('packages', f.packages.filter((y, j) => j !== i))} aria-label={tr('Remove')}>✕</button>
                </div>
              ))}
            </div>
            {!locked && <button type="button" className="btn btn-secondary btn-sm" onClick={() => set('packages', f.packages.concat([{ marks: '', count: 1, kind: 'carton', contents: '', netKg: 0, grossKg: 0, l: 0, w: 0, h: 0 }]))}>➕ {tr('A package')}</button>}
            <div className="exp-pack-sum">
              <span><em>{pk.n}</em><small>{tr('packages')}</small></span><span><em>{num(pk.net, 1)} kg</em><small>{tr('net')}</small></span><span><em>{num(pk.gross, 1)} kg</em><small>{tr('gross')}</small></span><span><em>{num(pk.cbm, 3)} m³</em><small>{tr('volume')}</small></span>
              {(() => { const c = containerFor(pk.cbm); return <span className="exp-fill"><i style={{ width: Math.min(100, c.fill) + '%' }} /><small>{c.text}</small></span>; })()}
            </div>
          </>}
          {tab === 'route' && <div className="exp-form">
            <div className="x7-seg">{Object.keys(TRANSPORT).map((k) => <button key={k} type="button" className={f.transport === k ? 'is-on' : ''} onClick={() => set('transport', k)}>{TRANSPORT[k][0]} {tr(TRANSPORT[k][1])}</button>)}</div>
            <div className="exp-grid">
              <Field label={tr('Incoterm')}><select className="input" value={f.incoterm} onChange={(e) => set('incoterm', e.target.value)}>{d.incoterms.map((t) => <option key={t}>{t}</option>)}</select></Field>
              <Field label={tr('Named place')}><input className="input" value={f.incotermPlace} onChange={(e) => set('incotermPlace', e.target.value)} placeholder={tr('e.g. Tema')} /></Field>
              <Field label={tr('Currency')}><select className="input" value={f.currency} onChange={(e) => set('currency', e.target.value)}>{['USD', 'EUR', 'GBP', 'GHS', 'CNY', 'XOF', 'NGN'].map((c) => <option key={c}>{c}</option>)}</select></Field>
              <Field label={tr('Port of loading')}><input className="input" value={f.portLoading} onChange={(e) => set('portLoading', e.target.value)} /></Field>
              <Field label={tr('Port of discharge')}><input className="input" value={f.portDischarge} onChange={(e) => set('portDischarge', e.target.value)} /></Field>
              <Field label={tr('Country of destination')}><input className="input" value={f.country} onChange={(e) => set('country', e.target.value)} /></Field>
              <Field label={tr('Final destination')}><input className="input" value={f.finalDestination} onChange={(e) => set('finalDestination', e.target.value)} /></Field>
              <Field label={tr('Ready to ship')}><input className="input" type="date" value={f.shipOn || ''} onChange={(e) => set('shipOn', e.target.value)} /></Field>
              <Field label={tr('Vessel or flight')}><input className="input" value={f.vessel} onChange={(e) => set('vessel', e.target.value)} /></Field>
              <Field label={tr('Container')}><input className="input" value={f.containerNo} onChange={(e) => set('containerNo', e.target.value)} /></Field>
              <Field label={tr('Seal')}><input className="input" value={f.sealNo} onChange={(e) => set('sealNo', e.target.value)} /></Field>
              <Field label={tr('Bill of lading')}><input className="input" value={f.blNo} onChange={(e) => set('blNo', e.target.value)} /></Field>
              <Field label={tr('Proforma valid for (days)')}><input className="input" type="number" min="1" max="365" value={f.validDays} onChange={(e) => set('validDays', e.target.value)} /></Field>
              <Field label={tr('Origin')}><select className="input" value={f.originCriterion} onChange={(e) => set('originCriterion', e.target.value)}><option value="wholly">{tr('Wholly obtained in Ghana')}</option><option value="worked">{tr('Sufficiently worked in Ghana')}</option></select></Field>
              <Field label={tr('Payment terms')} wide><input className="input" value={f.paymentTerms} onChange={(e) => set('paymentTerms', e.target.value)} placeholder={tr('e.g. 50% before loading, 50% against the bill of lading')} /></Field>
              <Field label={tr('Note')} wide><input className="input" value={f.note} onChange={(e) => set('note', e.target.value)} /></Field>
            </div>
          </div>}
          {tab === 'parties' && <div className="exp-parties">{[['consignee', tr('Buyer / consignee')], ['notify', tr('Notify party (if not the buyer)')]].map((p) => (
            <div key={p[0]} className="exp-party"><h3>{p[1]}</h3>
              <Field label={tr('Name')}><input className="input" value={f[p[0]].name} onChange={(e) => setParty(p[0], 'name', e.target.value)} /></Field>
              <Field label={tr('Address')}><textarea className="input" rows={2} value={f[p[0]].address} onChange={(e) => setParty(p[0], 'address', e.target.value)} /></Field>
              <div className="x7-grid2">
                <Field label={tr('Country')}><input className="input" value={f[p[0]].country} onChange={(e) => setParty(p[0], 'country', e.target.value)} /></Field>
                <Field label={tr('Tax ID')}><input className="input" value={f[p[0]].taxId} onChange={(e) => setParty(p[0], 'taxId', e.target.value)} /></Field>
                <Field label={tr('Phone')}><input className="input" value={f[p[0]].phone} onChange={(e) => setParty(p[0], 'phone', e.target.value)} /></Field>
                <Field label={tr('Email')}><input className="input" value={f[p[0]].email} onChange={(e) => setParty(p[0], 'email', e.target.value)} /></Field>
              </div>
              {p[0] === 'consignee' && <Field label={tr('Their order reference')}><input className="input" value={f.buyerRef} onChange={(e) => set('buyerRef', e.target.value)} /></Field>}
            </div>
          ))}</div>}
          {tab === 'papers' && <div className="exp-papers">{d.papers.map((p) => {
            const v = f.papers[p.key] || {};
            return (
              <div key={p.key} className={'exp-paper' + (v.done ? ' is-done' : '')}>
                <label className="exp-paper-check"><input type="checkbox" checked={!!v.done} onChange={(e) => set('papers', { ...f.papers, [p.key]: { ...v, done: e.target.checked, on: e.target.checked && !v.on ? new Date().toISOString().slice(0, 10) : v.on } })} /><b>{tr(PAPER[p.key])}</b></label>
                <input className="input" value={v.ref || ''} onChange={(e) => set('papers', { ...f.papers, [p.key]: { ...v, ref: e.target.value } })} placeholder={tr('Number')} aria-label={tr('Number')} />
                <input className="input" type="date" value={v.on || ''} onChange={(e) => set('papers', { ...f.papers, [p.key]: { ...v, on: e.target.value } })} aria-label={tr('Date')} />
              </div>
            );
          })}</div>}
        </fieldset>
        {d.canManage && <div className="exp-acts">
          {!locked && dirty && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => save()}>💾 {tr('Save')}</button>}
          {NEXT[x.status] && <button type="button" className={'btn ' + (dirty ? 'btn-secondary' : 'btn-primary')} disabled={busy} onClick={() => move(NEXT[x.status][0])}>{STATUS[NEXT[x.status][0]][0]} {tr(NEXT[x.status][1])}</button>}
          {x.status === 'shipped' && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => move('packed')}>↩️ {tr('Not shipped yet')}</button>}
          {x.status !== 'shipped' && x.status !== 'cancelled' && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { if (window.confirm(tr('Cancel this shipment?'))) move('cancelled'); }}>⛔ {tr('Cancel it')}</button>}
          {x.status === 'cancelled' && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => move('draft')}>↩️ {tr('Open it again')}</button>}
        </div>}
      </div>
    </div>
  );
}

export default function ExportsPage() {
  const [params, setParams] = useSearchParams();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [pick, setPick] = useState(false);
  const [busy, setBusy] = useState(false);
  const open = params.get('shipment');
  const load = useCallback(() => api.get('/exports').then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const s = d.summary;
  const show = (x) => setParams(x ? { shipment: x.id } : {});
  async function start(orderId) {
    setBusy(true); setError(null);
    try { const r = await api.post('/exports', orderId ? { salesOrderId: orderId } : {}); setPick(false); await load(); show(r); } catch (e) { setError(e.message); }
    setBusy(false);
  }
  const live = d.shipments.filter((x) => ['draft', 'proforma_sent', 'packed'].indexOf(x.status) >= 0);
  const rest = d.shipments.filter((x) => live.indexOf(x) < 0);
  const lanes = ['draft', 'proforma_sent', 'packed'];
  return (
    <div className="x7 exp">
      <header className="x7-head">
        <div>
          <h1>🚢 {tr('Export papers')}</h1>
          <p>{tr('Shipments abroad: the goods with their HS codes, how they are packed, the route and the Incoterm — and the proforma invoice, packing list and certificate of origin, ready to print. The other papers are ticked off as they come in.')}</p>
        </div>
        {d.canManage && <div className="x7-head-actions"><button type="button" className="btn btn-primary" onClick={() => setPick(true)}>🚢 {tr('A shipment')}</button></div>}
      </header>
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="x7-tiles">
        <div className="x7-tile is-calm"><small>🧭 {tr('Under way')}</small><b>{s.open}</b><span>{s.next ? tr('next ready {date}', { date: dayText(s.next.shipOn) }) : tr('shipments being prepared')}</span></div>
        <div className={'x7-tile ' + (s.sailingSoon ? 'is-warn' : 'is-good')}><small>⏰ {tr('Ready within 14 days')}</small><b>{s.sailingSoon}</b><span>{tr('check the papers')}</span></div>
        <div className={'x7-tile ' + (s.papersMissing ? 'is-warn' : 'is-good')}><small>🗂️ {tr('Papers to get')}</small><b>{s.papersMissing}</b><span>{tr('across the open shipments')}</span></div>
        <div className={'x7-tile ' + (s.noHs ? 'is-bad' : 'is-good')}><small>🏷️ {tr('Lines without an HS code')}</small><b>{s.noHs}</b><span>{tr('customs need one')}</span></div>
        <div className="x7-tile is-teal"><small>🚢 {tr('Shipped this year')}</small><b>{s.shippedYear}</b><span>{d.byCurrency.map((c) => money(c.total, c.currency)).join(' · ') || tr('none yet')}</span></div>
      </div>
      {pick && <section className="x7-card exp-pick">
        <h2>🧾 {tr('From a sales order')} <small><button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => start(null)}>{tr('Start from nothing')}</button> <button type="button" className="btn btn-sm btn-secondary" onClick={() => setPick(false)}>{tr('Cancel')}</button></small></h2>
        {!d.orders.length ? <p className="x7-muted">{tr('No sales order waiting for export papers.')}</p> : <div className="exp-orders">{d.orders.map((o) => (
          <button key={o.id} type="button" disabled={busy} onClick={() => start(o.id)}><b>{o.orderNo}</b><small>{o.name}</small><em>{money(o.total, o.currency)}</em></button>
        ))}</div>}
      </section>}
      <div className="exp-lanes">{lanes.map((k) => (
        <section key={k} className={'exp-lane is-' + k}>
          <h2>{STATUS[k][0]} {tr(STATUS[k][1])} <small>{live.filter((x) => x.status === k).length}</small></h2>
          {live.filter((x) => x.status === k).map((x) => (
            <button key={x.id} type="button" className="exp-card" onClick={() => show(x)}>
              <span className="exp-card-top"><b>{x.ref}</b><span>{TRANSPORT[x.transport][0]}</span></span>
              <b className="exp-card-to">{x.consignee.name || '—'}</b>
              <small>{[x.portDischarge || x.country, x.incoterm + (x.incotermPlace ? ' ' + x.incotermPlace : '')].filter(Boolean).join(' · ')}</small>
              <span className="exp-card-figs"><em>{money(x.totals.total, x.currency)}</em><em>{tr('{n} pkgs', { n: x.totals.packages })} · {num(x.totals.grossKg, 0)} kg</em></span>
              <span className="exp-card-papers" title={tr('{a} of {b} papers', { a: x.papersDone, b: d.papers.length })}>{d.papers.map((p) => <i key={p.key} className={x.papers[p.key] && x.papers[p.key].done ? 'is-done' : ''} />)}</span>
              {x.shipOn && <small className="exp-card-date">📅 {dayText(x.shipOn)}</small>}
              {x.missingHs > 0 && <small className="exp-card-warn">🏷️ {x.missingHs === 1 ? tr('1 line without an HS code') : tr('{n} lines without an HS code', { n: x.missingHs })}</small>}
            </button>
          ))}
          {!live.some((x) => x.status === k) && <p className="x7-muted">{tr('None.')}</p>}
        </section>
      ))}</div>
      {rest.length > 0 && <section className="x7-card">
        <h2>🗂️ {tr('Shipped and cancelled')}</h2>
        <div className="x7-list">{rest.map((x) => (
          <button key={x.id} type="button" className="x7-row" onClick={() => show(x)}>
            <span className="x7-icon" aria-hidden="true">{STATUS[x.status][0]}</span>
            <span className="x7-who"><b>{x.ref} · {x.consignee.name}</b><small>{[x.vessel, x.blNo, x.portDischarge, x.shipOn ? dayText(x.shipOn) : null].filter(Boolean).join(' · ')}</small></span>
            <span className={'x7-pill ' + STATUS[x.status][2]}>{tr(STATUS[x.status][1])}</span>
            <span className="x7-money"><b>{money(x.totals.total, x.currency)}</b><small>{tr('{n} pkgs', { n: x.totals.packages })} · {num(x.totals.cbm, 2)} m³</small></span>
          </button>
        ))}</div>
      </section>}
      {d.byCountry.length > 0 && <section className="x7-card exp-countries"><h2>🌍 {tr('Where it went this year')}</h2><div className="x7-chips">{d.byCountry.map((c) => <span key={c.country} className="x7-pill is-teal">{c.country} · {c.shipments}</span>)}</div></section>}
      {open && <Sheet key={open} id={open} d={d} onClose={() => show(null)} onChanged={load} />}
    </div>
  );
}
