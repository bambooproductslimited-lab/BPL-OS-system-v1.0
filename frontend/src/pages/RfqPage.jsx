import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { API_URL, api } from '../api/client';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './seventeenth.css';
import './twentyfirst.css';

// Requests for quotes (Operations → Requests for quotes; backend
// rfqs.service.js, migration 0203): one request to several suppliers —
// Bamboo Products' or a restaurant's — sent by WhatsApp or email, their
// prices typed in side by side with the cheapest of each line, the total,
// how soon they deliver and their scorecard grade; the one awarded becomes
// the order.

const SUP = { asked: ['⏳', msg('Waiting'), 'is-calm'], quoted: ['💬', msg('Quoted'), 'is-good'], declined: ['🙅', msg('Will not quote'), ''] };
const GRADE = { A: 'is-good', B: 'is-teal', C: 'is-warn', D: 'is-bad' };

function dayText(d, opts) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC', ...opts }) : '—'; }
function num(v) { return v == null ? '—' : (Math.round(v * 1000) / 1000).toLocaleString(activeIntlLocale()); }
function today() { return new Date().toISOString().slice(0, 10); }
function addDays(n) { return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10); }
function toDataUrl(file) { return new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(file); }); }
function openFile(path) {
  const w = window.open('', '_blank');
  fetch(API_URL + path, { headers: api.authHeaders() }).then((r) => (r.ok ? r.blob() : null)).then((b) => { if (b && w) w.location.href = URL.createObjectURL(b); else if (w) w.close(); }).catch(() => { if (w) w.close(); });
}
function Grade({ s }) {
  return s.grade ? <span className={'rfq-grade ' + GRADE[s.grade]} title={tr('Scorecard {n} out of 100', { n: s.score })}>{s.grade}</span> : <span className="rfq-grade" title={tr('Not graded yet')}>·</span>;
}

function NewDialog({ onClose, onDone }) {
  const [o, setO] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ kind: 'bpl', companyId: '', requestId: '', title: '', lines: [{ name: '', qty: '', unit: '' }], supplierIds: [], replyBy: addDays(3), neededBy: '', note: '' });
  const [q, setQ] = useState('');
  useEffect(() => {
    api.get('/rfqs/options').then((x) => {
      setO(x);
      setF((v) => ({ ...v, kind: x.bpl ? 'bpl' : 'restaurant', companyId: x.restaurants[0] ? x.restaurants[0].id : '', lines: x.bpl ? v.lines : [{ type: '', id: '', qty: '' }] }));
    }).catch((e) => setError(e.message));
  }, []);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  if (!o) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-dlg"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const rest = o.restaurants.find((r) => r.id === f.companyId);
  const sups = f.kind === 'bpl' ? (o.bpl ? o.bpl.suppliers : []) : rest ? rest.suppliers : [];
  const shown = sups.filter((s) => !q || (s.name + ' ' + (s.supplies || '')).toLowerCase().includes(q.toLowerCase()));
  function kind(k) { setF((x) => ({ ...x, kind: k, supplierIds: [], requestId: '', lines: k === 'bpl' ? [{ name: '', qty: '', unit: '' }] : [{ type: '', id: '', qty: '' }] })); }
  function line(i, v) { setF((x) => ({ ...x, lines: x.lines.map((l, n) => (n === i ? { ...l, ...v } : l)) })); }
  function fromRequest(id) {
    const r = o.bpl.requests.find((x) => x.id === id);
    setF((x) => ({ ...x, requestId: id, title: r ? r.item : x.title, neededBy: r && r.neededBy ? r.neededBy : x.neededBy, lines: r ? [{ name: r.item, qty: String(r.qty), unit: '' }] : x.lines }));
  }
  function toggle(id) { setF((x) => ({ ...x, supplierIds: x.supplierIds.includes(id) ? x.supplierIds.filter((s) => s !== id) : x.supplierIds.concat(id) })); }
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    const lines = f.kind === 'bpl' ? f.lines.filter((l) => l.name || l.qty) : f.lines.filter((l) => l.id).map((l) => { const [type, id] = l.id.split(':'); return { type, id, qty: l.qty }; });
    try { onDone(await api.post('/rfqs', { ...f, lines })); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" style={{ width: 'min(720px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="rfq-n-t" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">🧾</span><div><h2 id="rfq-n-t">{tr('Ask for prices')}</h2><p>{tr('What you want, how many and by when: sent to each supplier you pick, their prices side by side when they reply.')}</p></div></div>
        {o.bpl && o.restaurants.length > 0 && <div className="x7-seg" role="tablist">{[['bpl', '🎋', msg('Bamboo Products')], ['restaurant', '🍴', msg('A restaurant')]].map(([k, ic, lab]) => <button key={k} type="button" role="tab" aria-selected={f.kind === k} className={f.kind === k ? 'is-on' : ''} onClick={() => kind(k)}>{ic} {tr(lab)}</button>)}</div>}
        {f.kind === 'restaurant' && <label><span>{tr('Restaurant')}</span><select className="input" value={f.companyId} onChange={(e) => setF((x) => ({ ...x, companyId: e.target.value, supplierIds: [], lines: [{ type: '', id: '', qty: '' }] }))}>{o.restaurants.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>}
        {f.kind === 'bpl' && o.bpl.requests.length > 0 && <label><span>{tr('From an approved purchase request')}</span><select className="input" value={f.requestId} onChange={(e) => fromRequest(e.target.value)}><option value="">{tr('None: a new one')}</option>{o.bpl.requests.map((r) => <option key={r.id} value={r.id}>{r.item} · {num(r.qty)} · {r.by}</option>)}</select></label>}
        <label><span>{tr('Title')}</span><input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder={tr('e.g. Sanding supplies for November')} /></label>
        <div className="rfq-lines">
          <div className="rfq-lines-head"><span>{tr('What')}</span><span>{tr('How many')}</span><span>{f.kind === 'bpl' ? tr('Unit') : ''}</span><span /></div>
          {f.lines.map((l, i) => (
            <div key={i} className="rfq-line">
              {f.kind === 'bpl' ? <input className="input" value={l.name} onChange={(e) => line(i, { name: e.target.value })} placeholder={tr('e.g. Sandpaper, grit 120')} aria-label={tr('What')} />
                : <select className="input" value={l.id} onChange={(e) => line(i, { id: e.target.value })} aria-label={tr('What')}><option value="">—</option>{(rest ? rest.items : []).map((it) => <option key={it.type + it.id} value={it.type + ':' + it.id}>{it.name}{it.unit ? ' (' + it.unit + ')' : ''}{it.low ? ' · ' + tr('low') : ''}</option>)}</select>}
              <input className="input" type="number" min="0" step="any" value={l.qty} onChange={(e) => line(i, { qty: e.target.value })} aria-label={tr('How many')} />
              {f.kind === 'bpl' ? <input className="input" value={l.unit} onChange={(e) => line(i, { unit: e.target.value })} placeholder={tr('sheets')} aria-label={tr('Unit')} /> : <span />}
              <button type="button" className="rfq-x" onClick={() => setF((x) => ({ ...x, lines: x.lines.length > 1 ? x.lines.filter((_, n) => n !== i) : x.lines }))} aria-label={tr('Take off')}>✕</button>
            </div>
          ))}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setF((x) => ({ ...x, lines: x.lines.concat(x.kind === 'bpl' ? { name: '', qty: '', unit: '' } : { id: '', qty: '' }) }))}>➕ {tr('A line')}</button>
        </div>
        <div className="rfq-pick-head"><b>{tr('Ask')}</b><small>{f.supplierIds.length === 1 ? tr('1 supplier') : tr('{n} suppliers', { n: f.supplierIds.length })}</small>{sups.length > 6 && <input className="input" data-type-to-search value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Find a supplier')} aria-label={tr('Find a supplier')} />}</div>
        {!sups.length ? <p className="x7-note">{tr('No supplier on file yet.')}</p> : <div className="rfq-pick">{shown.map((s) => (
          <button key={s.id} type="button" role="checkbox" aria-checked={f.supplierIds.includes(s.id)} className={f.supplierIds.includes(s.id) ? 'is-on' : ''} onClick={() => toggle(s.id)}>
            <Grade s={s} /><span><b>{s.name}</b><small>{[s.supplies, s.phone ? '📱' : null, s.email ? '✉️' : null].filter(Boolean).join(' ')}</small></span>
          </button>
        ))}</div>}
        <div className="x7-grid2">
          <label><span>{tr('Reply by')}</span><input className="input" type="date" min={today()} value={f.replyBy} onChange={(e) => set('replyBy', e.target.value)} /></label>
          <label><span>{tr('Needed by')}</span><input className="input" type="date" min={today()} value={f.neededBy} onChange={(e) => set('neededBy', e.target.value)} /></label>
        </div>
        <label><span>{tr('A word for the suppliers')}</span><input className="input" value={f.note} onChange={(e) => set('note', e.target.value)} placeholder={tr('e.g. delivered to the Tema factory')} /></label>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>🧾 {tr('Make the request')}</button></div>
      </form>
    </div>
  );
}

function QuoteDialog({ r, s, onClose, onDone }) {
  const [f, setF] = useState({ prices: Object.fromEntries(s.prices.map((p) => [p.lineId, p.unitPrice == null ? '' : String(p.unitPrice)])), deliveryDays: s.deliveryDays ?? '', validUntil: s.validUntil || '', terms: s.terms || '', note: s.note || '', file: undefined });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const total = r.lines.reduce((a, l) => a + (Number(f.prices[l.id]) || 0) * l.qty, 0);
  async function send(body) {
    setBusy(true); setError(null);
    try { onDone(await api.post('/rfqs/' + r.id + '/quote', { rfqSupplierId: s.id, ...body })); } catch (e) { setError(e.message); setBusy(false); }
  }
  async function pick(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setF((x) => ({ ...x, file: { name: file.name, dataUrl: null } }));
    const dataUrl = await toDataUrl(file);
    setF((x) => ({ ...x, file: { name: file.name, dataUrl } }));
  }
  return createPortal(
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" style={{ width: 'min(620px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="rfq-q-t" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); send({ ...f }); }}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">💬</span><div><h2 id="rfq-q-t">{tr('{name}\'s prices', { name: s.name })}</h2><p>{tr('The price for one of each, as they quoted. Leave a line empty if they do not have it.')}</p></div></div>
        <div className="rfq-qlines">{r.lines.map((l, i) => (
          <div key={l.id} className="rfq-qline"><span><b>{l.name}</b><small>{num(l.qty)} {l.unit}</small></span>
            <input className="input" type="number" min="0" step="any" autoFocus={i === 0} value={f.prices[l.id]} onChange={(e) => setF((x) => ({ ...x, prices: { ...x.prices, [l.id]: e.target.value } }))} aria-label={tr('Price for one: {what}', { what: l.name })} />
            <em>{f.prices[l.id] !== '' ? money((Number(f.prices[l.id]) || 0) * l.qty) : '—'}</em></div>
        ))}
          <div className="rfq-qtotal"><span>{tr('Total')}</span><b>{money(total)}</b></div>
        </div>
        <div className="x7-grid2">
          <label><span>{tr('Days to deliver')}</span><input className="input" type="number" min="0" max="365" value={f.deliveryDays} onChange={(e) => setF({ ...f, deliveryDays: e.target.value })} /></label>
          <label><span>{tr('Price holds until')}</span><input className="input" type="date" value={f.validUntil} onChange={(e) => setF({ ...f, validUntil: e.target.value })} /></label>
        </div>
        <div className="x7-grid2">
          <label><span>{tr('Terms')}</span><input className="input" value={f.terms} onChange={(e) => setF({ ...f, terms: e.target.value })} placeholder={tr('e.g. half up front, delivered')} /></label>
          <label><span>{tr('Note')}</span><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
        </div>
        <label className="x7-drop"><input type="file" accept="application/pdf,image/*" onChange={pick} /><span>📎 {f.file ? f.file.name : s.file ? tr('Their quote is attached: add another to replace it') : tr('Their quote: a PDF or a photo')}</span></label>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary is-end" disabled={busy} onClick={() => send({ declined: true, note: f.note })}>🙅 {tr('They will not quote')}</button>
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || (f.file && !f.file.dataUrl)}>{tr('Save the prices')}</button>
        </div>
      </form>
    </div>,
    document.body
  );
}

function RfqSheet({ id, onClose, onChanged }) {
  const [r, setR] = useState(null);
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(null);
  const [dlg, setDlg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [awardNote, setAwardNote] = useState('');
  const load = useCallback(() => api.get('/rfqs/' + id).then(setR).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  const done = (x) => { setR(x); setDlg(null); setError(null); onChanged(); };
  async function act(path, body, ok) {
    setBusy(true); setError(null);
    try { const x = await api.post('/rfqs/' + id + path, body || {}); done(x); if (ok) setFlash(ok(x)); return x; } catch (e) { setError(e.message); return null; } finally { setBusy(false); }
  }
  async function sendWa(s) {
    const w = window.open('', '_blank');
    const x = await act('/send', { rfqSupplierId: s.id, via: 'whatsapp' });
    if (x && x.wa && w) w.location.href = x.wa; else if (w) w.close();
  }
  if (!r) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const open = r.status === 'open';
  const won = r.suppliers.find((s) => s.id === r.awardedTo);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet rfq-sheet" role="dialog" aria-modal="true" aria-labelledby="rfq-s-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={{ '--g1': r.status === 'awarded' ? '#15803d' : r.status === 'cancelled' ? '#475569' : '#7c3aed', '--g2': r.status === 'awarded' ? '#0f766e' : r.status === 'cancelled' ? '#334155' : '#2563eb' }}>
          <span className="x7-icon" aria-hidden="true">{r.status === 'awarded' ? '🏆' : r.status === 'cancelled' ? '⛔' : '🧾'}</span>
          <div><small>{r.ref} · {r.company.name}</small><h2 id="rfq-s-t">{r.title}</h2>
            <p>{open && r.replyBy && <span className="x7-pill">⏳ {tr('reply by {date}', { date: dayText(r.replyBy) })}</span>}{r.neededBy && <span className="x7-pill">📅 {tr('needed by {date}', { date: dayText(r.neededBy) })}</span>}{won && <span className="x7-pill">🏆 {won.name} · {money(won.total)}</span>}</p></div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {flash && <p className="x7-flash is-good" role="status">✅ {flash}</p>}
        {r.request && <p className="x7-note">🛒 {tr('For the purchase request: {item}', { item: r.request.item })}</p>}
        {r.po && <p className="x7-note">📦 {tr('Draft purchase order {ref} made: send it from the till\'s back office.', { ref: r.po.ref })}</p>}
        {r.note && <p className="x7-note">📝 {r.note}</p>}
        <div className="rfq-compare-wrap">
          <table className="rfq-compare">
            <thead>
              <tr><th scope="col">{tr('What')}</th>{r.suppliers.map((s) => (
                <th key={s.id} scope="col" className={(s.id === r.pickId && open ? 'is-pick ' : '') + (s.id === r.awardedTo ? 'is-won' : '')}>
                  {s.id === r.pickId && open && <span className="rfq-ribbon">⭐ {tr('Best value')}</span>}
                  {s.id === r.awardedTo && <span className="rfq-ribbon is-won">🏆 {tr('Awarded')}</span>}
                  <span className="rfq-sup"><Grade s={s} /><b>{s.name}</b></span>
                  <span className={'x7-pill ' + SUP[s.status][2]}>{SUP[s.status][0]} {tr(SUP[s.status][1])}</span>
                </th>
              ))}</tr>
            </thead>
            <tbody>
              {r.lines.map((l, i) => (
                <tr key={l.id}><th scope="row"><b>{l.name}</b><small>{num(l.qty)} {l.unit}</small></th>
                  {r.suppliers.map((s) => { const p = s.prices[i]; return <td key={s.id} className={p.cheapest ? 'is-cheap' : ''}>{p.unitPrice == null ? <span className="rfq-none">—</span> : <><b>{money(p.amount)}</b><small>{tr('{v} each', { v: money(p.unitPrice) })}</small></>}</td>; })}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="is-total"><th scope="row">{tr('Total')}</th>{r.suppliers.map((s) => <td key={s.id} className={s.id === r.cheapestId ? 'is-cheap' : ''}>{s.total != null ? <><b>{money(s.total)}</b>{!s.complete && <small className="is-warn">{tr('{n} of {m} priced', { n: s.priced, m: r.lines.length })}</small>}</> : '—'}</td>)}</tr>
              <tr><th scope="row">{tr('Delivers in')}</th>{r.suppliers.map((s) => <td key={s.id}>{s.deliveryDays != null ? (s.deliveryDays === 1 ? tr('1 day') : tr('{n} days', { n: s.deliveryDays })) : '—'}</td>)}</tr>
              <tr><th scope="row">{tr('Price holds')}</th>{r.suppliers.map((s) => <td key={s.id} className={s.expired ? 'is-bad' : ''}>{s.validUntil ? dayText(s.validUntil) : '—'}{s.expired ? ' · ' + tr('ended') : ''}</td>)}</tr>
              {r.suppliers.some((s) => s.terms || s.note || s.file) && <tr><th scope="row">{tr('Notes')}</th>{r.suppliers.map((s) => <td key={s.id} className="rfq-notes">{[s.terms, s.note].filter(Boolean).join(' · ')}{s.file && <button type="button" className="rfq-file" onClick={() => openFile('/rfqs/' + r.id + '/file/' + s.id)}>📎 {tr('Their quote')}</button>}</td>)}</tr>}
              {open && r.canRun && (
                <tr className="rfq-acts"><th scope="row" />{r.suppliers.map((s) => (
                  <td key={s.id}>
                    <button type="button" className="btn btn-sm btn-secondary" onClick={() => setDlg({ k: 'quote', s })}>💬 {s.status === 'quoted' ? tr('Change the prices') : tr('Their prices')}</button>
                    {s.status !== 'quoted' && <span className="rfq-send">
                      {s.wa && <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => sendWa(s)} title={s.sentAt ? tr('Sent {date}', { date: dayText(s.sentAt) }) : ''}>🟢 WhatsApp</button>}
                      {s.email && r.emailOn && <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => act('/send', { rfqSupplierId: s.id, via: 'email' }, () => tr('Emailed to {name}.', { name: s.name }))}>✉️ {tr('Email')}</button>}
                    </span>}
                    {s.sentAt && <small className="rfq-sent">{tr('Sent {date}', { date: dayText(s.sentAt) })}</small>}
                    {r.canAward && s.complete && <button type="button" className={'btn btn-sm ' + (s.id === r.pickId ? 'btn-primary' : 'btn-secondary')} onClick={() => setDlg({ k: 'award', s })}>🏆 {tr('Award')}</button>}
                  </td>
                ))}</tr>
              )}
            </tfoot>
          </table>
        </div>
        {r.spread != null && r.spread > 0 && <p className="x7-note">💡 {tr('The full quotes are {v} apart.', { v: money(r.spread) })}</p>}
        {dlg && dlg.k === 'award' && (
          <div className="x7-form"><h3>🏆 {tr('Award it to {name} for {v}?', { name: dlg.s.name, v: money(dlg.s.total) })}</h3>
            <p className="x7-note">{r.kind === 'restaurant' ? tr('A draft purchase order is made with their prices.') : r.request ? tr('The purchase request is ordered from them.') : tr('A purchase request is made, ordered from them.')}</p>
            {dlg.s.id !== r.cheapestId && r.cheapestId && <p className="x7-flash is-warn">⚠️ {tr('Not the cheapest: say why.')}</p>}
            <input className="input" value={awardNote} onChange={(e) => setAwardNote(e.target.value)} placeholder={tr('Why them, e.g. better grade, sooner')} aria-label={tr('Why them')} />
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setDlg(null)}>{tr('Back')}</button><button type="button" className="btn btn-primary" disabled={busy} onClick={() => act('/award', { rfqSupplierId: dlg.s.id, note: awardNote }, () => tr('Awarded to {name}.', { name: dlg.s.name }))}>🏆 {tr('Award')}</button></div></div>
        )}
        {dlg && dlg.k === 'cancel' && (
          <div className="x7-form"><h3>⛔ {tr('Cancel the request')}</h3>
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={tr('Why? e.g. bought at the market')} aria-label={tr('Why?')} />
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setDlg(null)}>{tr('Back')}</button><button type="button" className="btn btn-danger" disabled={busy} onClick={() => act('/cancel', { reason })}>{tr('Cancel the request')}</button></div></div>
        )}
        {!dlg && open && r.canRun && <div className="x7-actions"><button type="button" className="btn btn-secondary" onClick={() => setDlg({ k: 'cancel' })}>⛔ {tr('Cancel')}</button></div>}
        {dlg && dlg.k === 'quote' && <QuoteDialog r={r} s={dlg.s} onClose={() => setDlg(null)} onDone={done} />}
      </div>
    </div>
  );
}

export default function RfqPage() {
  const [params, setParams] = useSearchParams();
  const [show, setShow] = useState('open');
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [making, setMaking] = useState(false);
  const load = useCallback(() => api.get('/rfqs?show=' + show).then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), [show]);
  useEffect(() => { load(); }, [load]);
  const open = params.get('rfq');
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const s = d.summary;
  const canMake = d.canRun.bpl || d.canRun.restaurant;
  return (
    <div className="x7">
      <header className="x7-head">
        <div>
          <h1>🧾 {tr('Requests for quotes')}</h1>
          <p>{tr('One request to several suppliers: their prices side by side with the cheapest of each line, how soon they deliver and how they have done; the one chosen becomes the order.')}</p>
        </div>
        {canMake && <div className="x7-head-actions"><button type="button" className="btn btn-primary" onClick={() => setMaking(true)}>🧾 {tr('Ask for prices')}</button></div>}
      </header>
      <div className="x7-tiles">
        <div className="x7-tile is-violet"><small>🧾 {tr('Open')}</small><b>{s.open}</b><span>{tr('requests out')}</span></div>
        <div className="x7-tile is-calm"><small>⏳ {tr('Waiting for replies')}</small><b>{s.waiting ?? '—'}</b><span>{tr('suppliers yet to answer')}</span></div>
        <div className={'x7-tile ' + (s.toCompare ? 'is-teal' : 'is-calm')}><small>⚖️ {tr('Ready to compare')}</small><b>{s.toCompare ?? '—'}</b><span>{tr('two quotes or more')}</span></div>
        <div className={'x7-tile ' + (s.late ? 'is-warn' : 'is-good')}><small>⏰ {tr('Past the reply day')}</small><b>{s.late ?? '—'}</b><span>{tr('still waiting on someone')}</span></div>
        <div className="x7-tile is-good"><small>🏆 {tr('Awarded this month')}</small><b>{s.awardedMonth}</b><span>{money(s.spentMonth)}</span></div>
        <div className="x7-tile is-teal"><small>💰 {tr('Saved this month')}</small><b>{money(s.savedMonth)}</b><span>{tr('against the dearest full quote')}</span></div>
      </div>
      <div className="x7-seg" role="tablist">{[['open', '🧾', msg('Open')], ['closed', '🗂️', msg('Closed')]].map(([k, ic, lab]) => <button key={k} type="button" role="tab" aria-selected={show === k} className={show === k ? 'is-on' : ''} onClick={() => setShow(k)}>{ic} {tr(lab)}</button>)}</div>
      {!d.rfqs.length ? <div className="x7-empty"><span aria-hidden="true">🧾</span><p>{show === 'open' ? tr('No request out. Ask two or three suppliers for prices before buying.') : tr('Nothing closed yet.')}</p></div> : (
        <div className="rfq-grid">{d.rfqs.map((r) => (
          <button key={r.id} type="button" className={'rfq-card is-' + r.status + (r.late ? ' is-late' : '')} onClick={() => setParams({ rfq: r.id })}>
            <span className="rfq-card-top"><b>{r.ref}</b><span className={'x7-pill ' + (r.company.code === 'BPL' ? 'is-good' : 'is-violet')}>{r.company.code === 'BPL' ? '🎋' : '🍴'} {r.company.name}</span></span>
            <span className="rfq-card-title">{r.title}</span>
            <span className="rfq-dots" aria-label={tr('{q} of {n} quoted', { q: r.quoted, n: r.asked })}>{Array.from({ length: r.asked }, (_, i) => <i key={i} className={i < r.quoted ? 'is-quoted' : i < r.quoted + r.declined ? 'is-declined' : ''} />)}<small>{tr('{q} of {n} quoted', { q: r.quoted, n: r.asked })}</small></span>
            <span className="rfq-card-foot">
              {r.awarded ? <span className="x7-pill is-good">🏆 {r.awarded.name} · {money(r.awarded.total)}</span> : r.status === 'cancelled' ? <span className="x7-pill">⛔ {tr('Cancelled')}</span> : r.best ? <span className="x7-pill is-teal">⭐ {r.best.name} · {money(r.best.total)}</span> : <span className="x7-pill is-calm">⏳ {tr('No full quote yet')}</span>}
              {r.status === 'open' && r.replyBy && <small className={r.late ? 'is-bad' : ''}>{tr('reply by {date}', { date: dayText(r.replyBy) })}</small>}
            </span>
          </button>
        ))}</div>
      )}
      {making && <NewDialog onClose={() => setMaking(false)} onDone={(x) => { setMaking(false); load(); setParams({ rfq: x.id }); }} />}
      {open && <RfqSheet key={open} id={open} onClose={() => setParams({})} onChanged={load} />}
    </div>
  );
}
