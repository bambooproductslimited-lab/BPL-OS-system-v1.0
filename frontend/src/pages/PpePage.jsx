import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './seventeenth.css';
import './eighteenth.css';
import './nineteenth.css';

// Uniforms and PPE (Operations → Uniforms and PPE; backend ppe.service.js,
// migration 0200): the store's stock by size; handing them out; what each
// person holds and when it is due for replacing; who in a team that needs
// something has not got it; requests from My space. A leaver hands back what
// they hold on their checklist.

function dayText(d, opts) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC', ...opts }) : '—'; }
// The year only when it is not this one.
function dayY(d) { return dayText(d, d && String(d).slice(0, 4) !== String(new Date().getFullYear()) ? { year: 'numeric' } : undefined); }
function hue(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
// A picture for each kind of thing, by its name.
function iconOf(name, kind) {
  const n = String(name).toLowerCase();
  if (/boot|shoe|clog/.test(n)) return '🥾';
  if (/glove/.test(n)) return '🧤';
  if (/helmet|hard hat/.test(n)) return '⛑️';
  if (/goggle|glasses|visor/.test(n)) return '🥽';
  if (/ear|muff|plug/.test(n)) return '🎧';
  if (/mask|respirator|dust/.test(n)) return '😷';
  if (/apron/.test(n)) return '🧑‍🍳';
  if (/chef|jacket/.test(n)) return '🧥';
  if (/vest|hi-vis|reflect/.test(n)) return '🦺';
  if (/cap|hat/.test(n)) return '🧢';
  if (/shirt|polo|t-shirt/.test(n)) return '👕';
  if (/overall|coverall|trouser/.test(n)) return '👖';
  return kind === 'uniform' ? '👕' : '🦺';
}
const REASON = { new: ['🆕', msg('New')], worn: ['🧵', msg('Worn out')], damaged: ['💥', msg('Damaged')], lost: ['❓', msg('Lost')], size: ['📏', msg('Wrong size')] };
const KIND = { ppe: msg('Protective kit'), uniform: msg('Uniform') };
const TABS = [['store', '🏬', msg('The store')], ['requests', '🙋', msg('Requests')], ['due', '🔁', msg('Due for replacing')], ['missing', '🕳️', msg('Missing')], ['people', '👥', msg('People')]];

function IssueDialog({ d, preset, onClose, onDone }) {
  const p0 = d.people.find((p) => p.id === preset.employeeId);
  const [f, setF] = useState({ employeeId: preset.employeeId || '', itemId: preset.itemId || '', size: preset.size || (p0 && preset.itemId ? p0.sizes[preset.itemId] || '' : ''), qty: 1, note: '', requestId: preset.requestId || null, replaces: preset.replaces || null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const item = d.items.find((i) => i.id === f.itemId);
  const person = d.people.find((p) => p.id === f.employeeId);
  const setItem = (id) => setF({ ...f, itemId: id, size: person && person.sizes[id] ? person.sizes[id] : '' });
  const setPerson = (id) => { const pp = d.people.find((p) => p.id === id); setF({ ...f, employeeId: id, size: pp && f.itemId && pp.sizes[f.itemId] ? pp.sizes[f.itemId] : f.size }); };
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.post('/ppe/issue', f)); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" style={{ width: 'min(640px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="pp-i-t" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">{item ? iconOf(item.name, item.kind) : '🦺'}</span><div><h2 id="pp-i-t">{preset.replaces ? tr('A replacement') : tr('Hand something out')}</h2><p>{tr('Taken from the store; they are told, and reminded when it is due for replacing.')}</p></div></div>
        <div className="x7-grid2">
          <label><span>{tr('Who')}</span><select className="input" required value={f.employeeId} onChange={(e) => setPerson(e.target.value)}><option value="">—</option>{d.people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.department ? ' · ' + p.department : ''}</option>)}</select></label>
          <label><span>{tr('What')}</span><select className="input" required value={f.itemId} onChange={(e) => setItem(e.target.value)}><option value="">—</option>{d.items.filter((i) => i.active).map((i) => <option key={i.id} value={i.id}>{iconOf(i.name, i.kind)} {i.name}</option>)}</select></label>
        </div>
        {item && item.sizes.length > 0 && (
          <div className="pp-sizes" role="group" aria-label={tr('Size')}>{item.stock.map((s) => (
            <button key={s.size} type="button" className={(f.size === s.size ? 'is-on ' : '') + (!s.qty ? 'is-out' : s.low ? 'is-low' : '')} onClick={() => setF({ ...f, size: s.size })}><b>{s.size}</b><small>{tr('{n} in store', { n: s.qty })}</small></button>
          ))}</div>
        )}
        {person && item && person.sizes[item.id] && <p className="x7-note">📏 {tr('{name} wears {size}.', { name: person.name, size: person.sizes[item.id] })}</p>}
        <div className="x7-grid2">
          <label><span>{tr('How many')}</span><input className="input" type="number" min="1" max="20" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></label>
          <label><span>{tr('Note')}</span><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
        </div>
        {item && <p className="x7-note">💵 {money(item.unitCost * (Number(f.qty) || 1), 'GHS')}{item.lifeMonths ? ' · ' + tr('due for replacing in {n} months', { n: item.lifeMonths }) : ''}</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Hand it over')}</button></div>
      </form>
    </div>
  );
}

function ReceiveDialog({ d, onClose, onDone }) {
  const [f, setF] = useState({ itemId: (d.items[0] || {}).id || '', size: '', qty: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const item = d.items.find((i) => i.id === f.itemId);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.post('/ppe/stock', f)); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" style={{ width: 'min(560px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="pp-r-t" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">📦</span><div><h2 id="pp-r-t">{tr('Into the store')}</h2><p>{tr('A delivery from the supplier. A minus takes some out (counted short, thrown away).')}</p></div></div>
        <label><span>{tr('What')}</span><select className="input" value={f.itemId} onChange={(e) => setF({ ...f, itemId: e.target.value, size: '' })}>{d.items.map((i) => <option key={i.id} value={i.id}>{iconOf(i.name, i.kind)} {i.name}</option>)}</select></label>
        {item && item.sizes.length > 0 && <div className="pp-sizes">{item.stock.map((s) => <button key={s.size} type="button" className={f.size === s.size ? 'is-on' : ''} onClick={() => setF({ ...f, size: s.size })}><b>{s.size}</b><small>{tr('{n} in store', { n: s.qty })}</small></button>)}</div>}
        <label><span>{tr('How many')}</span><input className="input" type="number" required value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></label>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save')}</button></div>
      </form>
    </div>
  );
}

function ItemsDialog({ d, onClose, onDone }) {
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  function start(i) {
    setEdit(i ? { id: i.id, name: i.name, kind: i.kind, sizes: i.sizes.join(', '), lifeMonths: String(i.lifeMonths), unitCost: String(i.unitCost), perPerson: String(i.perPerson), requiredFor: i.requiredFor, active: i.active, minQty: Object.fromEntries(i.stock.map((s) => [s.size, String(s.min)])) }
      : { name: '', kind: 'ppe', sizes: '', lifeMonths: '12', unitCost: '', perPerson: '1', requiredFor: [], active: true, minQty: {} });
  }
  async function save() {
    setBusy(true); setError(null);
    const body = { ...edit, sizes: edit.sizes.split(',').map((s) => s.trim()).filter(Boolean) };
    try { onDone(await (edit.id ? api.put('/ppe/items/' + edit.id, body) : api.post('/ppe/items', body))); setEdit(null); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const sizes = edit ? (edit.sizes.split(',').map((s) => s.trim()).filter(Boolean).length ? edit.sizes.split(',').map((s) => s.trim()).filter(Boolean) : ['']) : [];
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-dlg" style={{ width: 'min(760px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="pp-x-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">🧰</span><div><h2 id="pp-x-t">{tr('What we hand out')}</h2><p>{tr('Sizes, how long each lasts, what it costs, and the teams that must have it.')}</p></div></div>
        {!edit ? (
          <>
            <div className="x7-list">{d.items.map((i) => (
              <button key={i.id} type="button" className="x7-row" onClick={() => start(i)}>
                <span className="x7-icon" aria-hidden="true">{iconOf(i.name, i.kind)}</span>
                <span className="x7-who"><b>{i.name}</b><small>{tr(KIND[i.kind])} · {i.sizes.length ? i.sizes.join(' · ') : tr('one size')} · {i.lifeMonths ? tr('{n} months', { n: i.lifeMonths }) : tr('no set life')} · {money(i.unitCost, 'GHS')}</small></span>
                <span className="x7-pill is-calm">{tr('{n} teams', { n: i.requiredFor.length })}</span><span />
              </button>
            ))}</div>
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button><button type="button" className="btn btn-primary" onClick={() => start(null)}>➕ {tr('Something new')}</button></div>
          </>
        ) : (
          <>
            <div className="x7-grid3">
              <label><span>{tr('Name')}</span><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder={tr('e.g. Safety boots')} /></label>
              <label><span>{tr('Kind')}</span><select className="input" value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>{Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{tr(l)}</option>)}</select></label>
              <label><span>{tr('Sizes, with commas')}</span><input className="input" value={edit.sizes} onChange={(e) => setEdit({ ...edit, sizes: e.target.value })} placeholder="S, M, L, XL" /></label>
              <label><span>{tr('Lasts (months)')}</span><input className="input" type="number" min="0" value={edit.lifeMonths} onChange={(e) => setEdit({ ...edit, lifeMonths: e.target.value })} /></label>
              <label><span>{tr('Cost each')}</span><input className="input" type="number" min="0" step="0.01" value={edit.unitCost} onChange={(e) => setEdit({ ...edit, unitCost: e.target.value })} /></label>
              <label><span>{tr('Each person gets')}</span><input className="input" type="number" min="1" max="10" value={edit.perPerson} onChange={(e) => setEdit({ ...edit, perPerson: e.target.value })} /></label>
            </div>
            <span className="x7-muted">{tr('Teams that must have it')}</span>
            <div className="pp-teams">{d.departments.map((x) => <label key={x.id} className="x7-check"><input type="checkbox" checked={edit.requiredFor.includes(x.id)} onChange={(e) => setEdit({ ...edit, requiredFor: e.target.checked ? [...edit.requiredFor, x.id] : edit.requiredFor.filter((y) => y !== x.id) })} /><span>{x.name}<small>{x.company}</small></span></label>)}</div>
            <span className="x7-muted">{tr('Buy more when the store is down to')}</span>
            <div className="pp-mins">{sizes.map((sz) => <label key={sz || 'one'}><span>{sz || tr('one size')}</span><input className="input" type="number" min="0" value={edit.minQty[sz] || ''} onChange={(e) => setEdit({ ...edit, minQty: { ...edit.minQty, [sz]: e.target.value } })} /></label>)}</div>
            {error && <div className="error-banner" role="alert">{error}</div>}
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setEdit(null)}>{tr('Back')}</button><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{tr('Save')}</button></div>
          </>
        )}
      </div>
    </div>
  );
}

function PersonSheet({ id, onClose, onIssue, onChanged }) {
  const [p, setP] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => api.get('/ppe/person/' + id).then(setP).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  async function back(issue, status) {
    setError(null);
    try { await api.post('/ppe/issues/' + issue.id + '/return', { status, condition: status === 'returned' ? 'good' : '', restock: status === 'returned' }); load(); onChanged(); } catch (e) { setError(e.message); }
  }
  if (!p) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const held = p.issues.filter((s) => s.status === 'out'), past = p.issues.filter((s) => s.status !== 'out');
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet" role="dialog" aria-modal="true" aria-labelledby="pp-p-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={{ '--g1': '#0f766e', '--g2': '#4d7c0f' }}>
          <span className="x7-avatar" style={{ '--h': hue(p.name) }} aria-hidden="true">{p.name.charAt(0)}</span>
          <div><small>{[p.position, p.department].filter(Boolean).join(' · ')}</small><h2 id="pp-p-t">{p.name}</h2><p><span className="x7-pill">🦺 {tr('{n} held', { n: held.length })}</span><span className="x7-pill">💵 {money(p.cost, 'GHS')}</span></p></div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="x7-sec"><h3>🦺 {tr('Holding now')}</h3>
          {!held.length ? <p className="x7-muted">{tr('Nothing.')}</p> : <div className="x7-list">{held.map((s) => (
            <div key={s.id} className={'x7-row' + (s.dueIn != null && s.dueIn < 0 ? ' is-flag is-bad' : '')} style={{ cursor: 'default' }}>
              <span className="x7-icon" aria-hidden="true">{iconOf(s.item, s.kind)}</span>
              <span className="x7-who"><b>{s.qty > 1 ? s.qty + ' × ' : ''}{s.item}{s.size ? ' · ' + s.size : ''}</b><small>{tr('since {date}', { date: dayY(s.issuedOn) })}{s.dueOn ? ' · ' + tr('due {date}', { date: dayY(s.dueOn) }) : ''}</small></span>
              <span className="pp-acts"><button type="button" className="btn btn-secondary" onClick={() => onIssue({ employeeId: p.id, itemId: s.itemId, size: s.size, replaces: s.id })}>🔁</button><button type="button" className="btn btn-secondary" onClick={() => back(s, 'returned')} title={tr('Back in good order')}>↩️</button><button type="button" className="btn btn-secondary" onClick={() => back(s, 'lost')} title={tr('Lost')}>❓</button></span><span />
            </div>
          ))}</div>}
        </div>
        {past.length > 0 && <div className="x7-sec"><h3>🗂️ {tr('Before')}</h3><ul className="x7-mine-list">{past.map((s) => <li key={s.id}><span aria-hidden="true">{iconOf(s.item, s.kind)}</span><span><b>{s.item}{s.size ? ' · ' + s.size : ''}</b><small>{dayText(s.issuedOn)} → {dayText(s.endedOn)} · {s.status === 'replaced' ? tr('replaced') : s.status === 'lost' ? tr('lost') : tr('handed back')}</small></span></li>)}</ul></div>}
        <div className="x7-actions"><button type="button" className="btn btn-primary is-end" onClick={() => onIssue({ employeeId: p.id })}>➕ {tr('Hand something out')}</button></div>
      </div>
    </div>
  );
}

export default function PpePage() {
  const [params, setParams] = useSearchParams();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [dlg, setDlg] = useState(null);
  const [q, setQ] = useState('');
  const [flash, setFlash] = useState(null);
  const load = useCallback(() => api.get('/ppe').then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const tab = params.get('tab') || (params.get('person') ? 'people' : 'store');
  const personId = params.get('person');
  const go = (p) => setParams(p);
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const s = d.summary;
  async function decline(r) {
    const note = window.prompt(tr('Why? They are told.'));
    if (!note) return;
    try { await api.post('/ppe/requests/' + r.id + '/decline', { note }); load(); } catch (e) { setFlash('⚠️ ' + e.message); }
  }
  const counts = { store: d.items.reduce((a, i) => a + i.low, 0), requests: d.requests.length, due: s.overdue + s.dueSoon, missing: d.gaps.length, people: 0 };
  const gapsByItem = {};
  d.gaps.forEach((g) => { (gapsByItem[g.item] = gapsByItem[g.item] || []).push(g); });
  const spendMax = Math.max(1, ...d.spendYear.map((x) => x.cost));
  return (
    <div className="x7">
      <header className="x7-head">
        <div>
          <h1>🦺 {tr('Uniforms and PPE')}</h1>
          <p>{tr('Boots, gloves, helmets, overalls and chef jackets: the store by size, who holds what, what is due for replacing, and who is missing what their team must wear.')}</p>
        </div>
        <div className="x7-head-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setDlg({ k: 'items' })}>🧰 {tr('What we hand out')}</button>
          <button type="button" className="btn btn-secondary" onClick={() => setDlg({ k: 'receive' })}>📦 {tr('Into the store')}</button>
          <button type="button" className="btn btn-primary" onClick={() => setDlg({ k: 'issue', preset: {} })}>➕ {tr('Hand something out')}</button>
        </div>
      </header>
      <div className="x7-tiles">
        <div className="x7-tile is-teal"><small>🦺 {tr('Handed out this month')}</small><b>{s.issuedMonth}</b><span>{money(s.costMonth, 'GHS')} · {tr('{v} this year', { v: money(s.costYear, 'GHS') })}</span></div>
        <div className={'x7-tile ' + (s.overdue ? 'is-bad' : 'is-warn')}><small>🔁 {tr('Due for replacing')}</small><b>{s.overdue + s.dueSoon}</b><span>{s.overdue ? tr('{n} overdue', { n: s.overdue }) : tr('in the next 30 days')}</span></div>
        <div className={'x7-tile ' + (s.requests ? 'is-calm' : 'is-good')}><small>🙋 {tr('Requests')}</small><b>{s.requests}</b><span>{tr('waiting')}</span></div>
        <div className={'x7-tile ' + (s.gaps ? 'is-bad' : 'is-good')}><small>🕳️ {tr('Missing')}</small><b>{s.gaps}</b><span>{tr('without what their team must wear')}</span></div>
        <div className={'x7-tile ' + (s.lowStock ? 'is-warn' : 'is-good')}><small>📦 {tr('Low in the store')}</small><b>{s.lowStock}</b><span>{tr('sizes to buy')}</span></div>
      </div>
      <div className="x7-seg pp-tabs" role="tablist">{TABS.map(([k, ic, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-on' : ''} onClick={() => go(k === 'store' ? {} : { tab: k })}>{ic} {tr(l)}{counts[k] ? <i>{counts[k]}</i> : null}</button>)}</div>
      {flash && <div className="x7-flash" role="status">{flash}</div>}
      {tab === 'store' && (
        <>
          <div className="pp-kits">{d.items.filter((i) => i.active).map((i) => (
            <article key={i.id} className="pp-kit">
              <header><span className="pp-icon" aria-hidden="true">{iconOf(i.name, i.kind)}</span><div><b>{i.name}</b><small>{tr(KIND[i.kind])} · {i.lifeMonths ? (i.lifeMonths === 1 ? tr('lasts 1 month') : tr('lasts {n} months', { n: i.lifeMonths })) : tr('no set life')} · {money(i.unitCost, 'GHS')}</small></div></header>
              <div className="pp-stock">{i.stock.map((st) => <span key={st.size} className={!st.qty ? 'is-out' : st.low ? 'is-low' : ''}><b>{st.qty}</b><small>{st.size || tr('one size')}</small></span>)}</div>
              <footer><span>📦 {tr('{n} in the store', { n: i.total })}</span><span>👷 {tr('{n} with staff', { n: i.out })}</span>{i.low > 0 && <span className="x7-pill is-warn">{(i.low === 1 ? tr('1 size low') : tr('{n} sizes low', { n: i.low }))}</span>}</footer>
            </article>
          ))}</div>
          {d.spendYear.length > 0 && (
            <section className="x7-card"><h2>💵 {tr('Spent this year')}</h2>
              <div className="qc-pareto">{d.spendYear.map((x) => <div key={x.item} className="qc-pareto-row"><span className="qc-pareto-name"><em aria-hidden="true">{iconOf(x.item)}</em>{x.item}</span><span className="qc-pareto-bar"><i style={{ width: x.cost / spendMax * 100 + '%' }} /></span><b>{money(x.cost, 'GHS')}</b><small>{tr('{n} pieces', { n: x.qty })}</small></div>)}</div>
            </section>
          )}
        </>
      )}
      {tab === 'requests' && (!d.requests.length ? <div className="x7-empty"><span aria-hidden="true">🙋</span><p>{tr('No request waiting.')}</p></div> : (
        <div className="x7-list">{d.requests.map((r) => (
          <div key={r.id} className="x7-row" style={{ cursor: 'default' }}>
            <span className="x7-avatar" style={{ '--h': hue(r.person.name) }} aria-hidden="true">{r.person.name.charAt(0)}</span>
            <span className="x7-who"><b>{r.person.name} · {iconOf(r.item)} {r.item}{r.size ? ' (' + r.size + ')' : ''}</b><small>{REASON[r.reason][0]} {tr(REASON[r.reason][1])}{r.note ? ' · ' + r.note : ''} · {r.person.department} · {dayText(r.createdAt)}</small></span>
            <span className="pp-acts"><button type="button" className="btn btn-secondary" onClick={() => decline(r)}>{tr('Decline')}</button></span>
            <button type="button" className="btn btn-primary" onClick={() => setDlg({ k: 'issue', preset: { employeeId: r.person.id, itemId: r.itemId, size: r.size, requestId: r.id } })}>{tr('Hand it over')}</button>
          </div>
        ))}</div>
      ))}
      {tab === 'due' && (!d.due.length ? <div className="x7-empty"><span aria-hidden="true">🔁</span><p>{tr('Nothing due for replacing in the next 30 days.')}</p></div> : (
        <div className="x7-list">{d.due.map((x) => (
          <div key={x.id} className={'x7-row' + (x.dueIn < 0 ? ' is-flag is-bad' : x.dueIn <= 7 ? ' is-flag is-warn' : '')} style={{ cursor: 'default' }}>
            <span className="x7-icon" aria-hidden="true">{iconOf(x.item, x.kind)}</span>
            <span className="x7-who"><b>{x.person.name} · {x.item}{x.size ? ' (' + x.size + ')' : ''}</b><small>{x.person.department} · {tr('since {date}', { date: dayText(x.issuedOn, { year: 'numeric' }) })}</small></span>
            <span className={'x7-pill ' + (x.dueIn < 0 ? 'is-bad' : 'is-warn')}>{x.dueIn < 0 ? (x.dueIn === -1 ? tr('1 day overdue') : tr('{n} days overdue', { n: -x.dueIn })) : x.dueIn === 0 ? tr('due today') : (x.dueIn === 1 ? tr('in 1 day') : tr('in {n} days', { n: x.dueIn }))}</span>
            <button type="button" className="btn btn-secondary" onClick={() => setDlg({ k: 'issue', preset: { employeeId: x.person.id, itemId: x.itemId, size: x.size, replaces: x.id } })}>🔁 {tr('Replace')}</button>
          </div>
        ))}</div>
      ))}
      {tab === 'missing' && (!d.gaps.length ? <div className="x7-empty"><span aria-hidden="true">✅</span><p>{tr('Everyone has what their team must wear.')}</p></div> : Object.entries(gapsByItem).map(([item, list]) => (
        <section key={item} className="x7-card">
          <h2>{iconOf(item)} {item} <small>{tr('{n} without', { n: list.length })}</small></h2>
          <div className="pp-gaps">{list.map((g) => (
            <button key={g.person.id + g.itemId} type="button" className="pp-gap" onClick={() => setDlg({ k: 'issue', preset: { employeeId: g.person.id, itemId: g.itemId, size: g.size } })}>
              <span className="x7-avatar" style={{ '--h': hue(g.person.name) }} aria-hidden="true">{g.person.name.charAt(0)}</span>
              <span><b>{g.person.name}</b><small>{g.person.department}{g.size ? ' · ' + tr('size {s}', { s: g.size }) : ''}</small></span>
              <em aria-hidden="true">➕</em>
            </button>
          ))}</div>
        </section>
      )))}
      {tab === 'people' && (
        <>
          <input className="input pp-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Find someone')} aria-label={tr('Find someone')} />
          <div className="x7-list">{d.people.filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase())).slice(0, 60).map((p) => (
            <button key={p.id} type="button" className="x7-row" onClick={() => go({ tab: 'people', person: p.id })}>
              <span className="x7-avatar" style={{ '--h': hue(p.name) }} aria-hidden="true">{p.name.charAt(0)}</span>
              <span className="x7-who"><b>{p.name}</b><small>{p.department || '—'}{Object.keys(p.sizes).length ? ' · 📏 ' + Object.values(p.sizes).join(' · ') : ''}</small></span><span /><span />
            </button>
          ))}</div>
        </>
      )}
      {dlg && dlg.k === 'issue' && <IssueDialog d={d} preset={dlg.preset} onClose={() => setDlg(null)} onDone={(x) => { setDlg(null); setFlash('🦺 ' + tr('{item} handed to {name}.', { item: x.item + (x.size ? ' (' + x.size + ')' : ''), name: x.person.name })); load(); }} />}
      {dlg && dlg.k === 'receive' && <ReceiveDialog d={d} onClose={() => setDlg(null)} onDone={(x) => { setDlg(null); setD(x); }} />}
      {dlg && dlg.k === 'items' && <ItemsDialog d={d} onClose={() => setDlg(null)} onDone={(x) => setD(x)} />}
      {personId && <PersonSheet key={personId} id={personId} onClose={() => go({ tab: 'people' })} onIssue={(preset) => setDlg({ k: 'issue', preset })} onChanged={load} />}
    </div>
  );
}

// My space: what I hold and when it is due; what my team must wear that I do
// not have; my sizes; asking for something.
export function MyKitCard() {
  const [d, setD] = useState(null);
  const [asking, setAsking] = useState(null);
  const [sizing, setSizing] = useState(false);
  const [sizes, setSizes] = useState({});
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => api.get('/ppe/mine').then((x) => { setD(x); setSizes(x.sizes); }).catch(() => setD(null)), []);
  useEffect(() => { load(); }, [load]);
  if (!d || (!d.held.length && !d.missing.length && !d.requests.length && !d.items.length)) return null;
  async function ask(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await api.post('/ppe/requests', asking); setAsking(null); setFlash('🙋 ' + tr('Asked — the store will let you know.')); load(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function saveSizes() {
    setBusy(true); setError(null);
    try { const x = await api.put('/ppe/mine/sizes', { sizes }); setD(x); setSizing(false); setFlash('📏 ' + tr('Sizes saved.')); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const sized = d.items.filter((i) => i.sizes.length);
  const askItem = asking && d.items.find((i) => i.id === asking.itemId);
  return (
    <div className="msx-card x7-mine">
      <h4 className="msp-h4">🦺 {tr('My uniform and kit')}</h4>
      {d.missing.map((m) => (
        <div key={m.id} className="x7-mine-top" style={{ '--tone': 'var(--x7-bad)' }}>
          <span><small>{tr('Your team must wear it')}</small><b>{iconOf(m.name)} {m.name}</b></span>
          <button type="button" className="btn btn-primary" onClick={() => setAsking({ itemId: m.id, size: d.sizes[m.id] || '', reason: 'new', note: '' })}>🙋 {tr('Ask for it')}</button>
        </div>
      ))}
      {d.held.length > 0 && <ul className="x7-mine-list">{d.held.map((s) => (
        <li key={s.id}><span aria-hidden="true">{iconOf(s.item, s.kind)}</span><span><b>{s.item}{s.size ? ' · ' + s.size : ''}</b><small>{tr('since {date}', { date: dayY(s.issuedOn) })}{s.dueOn ? ' · ' + (s.dueIn < 0 ? '⏰ ' + tr('due for a new one') : tr('new one due {date}', { date: dayY(s.dueOn) })) : ''}</small></span>
          <button type="button" className="x7-link" onClick={() => setAsking({ itemId: s.itemId, size: s.size, reason: s.dueIn != null && s.dueIn <= 7 ? 'worn' : 'damaged', note: '' })}>{tr('Need a new one?')}</button></li>
      ))}</ul>}
      {d.requests.length > 0 && <ul className="x7-mine-list">{d.requests.map((r) => (
        <li key={r.id}><span aria-hidden="true">🙋</span><span><b>{r.item}{r.size ? ' · ' + r.size : ''}</b><small>{r.status === 'requested' ? tr('asked {date}', { date: dayText(r.createdAt) }) : r.status === 'issued' ? tr('ready — collect it from the store') : r.declineNote}</small></span><span className={'x7-pill ' + (r.status === 'issued' ? 'is-good' : r.status === 'declined' ? 'is-bad' : 'is-calm')} style={{ flex: 'none' }}>{r.status === 'requested' ? tr('Asked') : r.status === 'issued' ? tr('Ready') : tr('Declined')}</span></li>
      ))}</ul>}
      {flash && <div className="x7-flash" role="status">{flash}</div>}
      {error && <div className="error-banner" role="alert">{error}</div>}
      {asking && (
        <form className="x7-form" onSubmit={ask}>
          <label><span>{tr('What')}</span><select className="input" value={asking.itemId} onChange={(e) => setAsking({ ...asking, itemId: e.target.value, size: d.sizes[e.target.value] || '' })}>{d.items.map((i) => <option key={i.id} value={i.id}>{iconOf(i.name, i.kind)} {i.name}</option>)}</select></label>
          {askItem && askItem.sizes.length > 0 && <div className="pp-sizes is-small">{askItem.sizes.map((sz) => <button key={sz} type="button" className={asking.size === sz ? 'is-on' : ''} onClick={() => setAsking({ ...asking, size: sz })}><b>{sz}</b></button>)}</div>}
          <div className="x7-chips">{d.reasons.map((r) => <button key={r} type="button" className={asking.reason === r ? 'is-on' : ''} onClick={() => setAsking({ ...asking, reason: r })}><em aria-hidden="true">{REASON[r][0]}</em>{tr(REASON[r][1])}</button>)}</div>
          <input className="input" value={asking.note} onChange={(e) => setAsking({ ...asking, note: e.target.value })} placeholder={tr('Anything to add')} aria-label={tr('Note')} />
          <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setAsking(null)}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Ask')}</button></div>
        </form>
      )}
      {!asking && (sizing ? (
        <div className="x7-form">
          <div className="pp-mysizes">{sized.map((i) => <label key={i.id}><span>{iconOf(i.name, i.kind)} {i.name}</span><select className="input" value={sizes[i.id] || ''} onChange={(e) => setSizes({ ...sizes, [i.id]: e.target.value })}><option value="">—</option>{i.sizes.map((sz) => <option key={sz} value={sz}>{sz}</option>)}</select></label>)}</div>
          <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setSizing(false)}>{tr('Cancel')}</button><button type="button" className="btn btn-primary" disabled={busy} onClick={saveSizes}>{tr('Save')}</button></div>
        </div>
      ) : (
        <div className="x7-actions">
          {sized.length > 0 && <button type="button" className="btn btn-secondary" onClick={() => setSizing(true)}>📏 {tr('My sizes')}{Object.keys(d.sizes).length ? ' · ' + Object.values(d.sizes).join(' · ') : ''}</button>}
          {d.items.length > 0 && <button type="button" className="btn btn-secondary is-end" onClick={() => setAsking({ itemId: d.items[0].id, size: d.sizes[d.items[0].id] || '', reason: 'new', note: '' })}>🙋 {tr('Ask for something')}</button>}
        </div>
      ))}
    </div>
  );
}
