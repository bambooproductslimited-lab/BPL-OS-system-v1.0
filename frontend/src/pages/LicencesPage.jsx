import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { API_URL, api } from '../api/client';
import { money } from '../lib/currency';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './seventeenth.css';
import './twentieth.css';

// Licences and permits (Operations → Licences and permits; backend
// licences.service.js, migration 0201): what each company and site must hold
// to trade, who issues it, its number, what it cost and a copy; ending soon
// or ended; applied for; renewed (the period before kept); the staff
// certificates and vehicle papers ending soon shown alongside.

function dayText(d, opts) { return d ? new Date(String(d).slice(0, 10) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC', ...opts }) : '—'; }
function dayY(d) { return dayText(d, d && String(d).slice(0, 4) !== String(new Date().getFullYear()) ? { year: 'numeric' } : undefined); }
function today() { return new Date().toISOString().slice(0, 10); }
function hue(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function toDataUrl(file) { return new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(file); }); }

const KIND = {
  business: ['🏢', msg('Operating permit')], fire: ['🧯', msg('Fire certificate')], food: ['🍽️', msg('Food hygiene')], environment: ['🌿', msg('Environment (EPA)')],
  building: ['🏗️', msg('Building permit')], liquor: ['🍷', msg('Liquor licence')], signage: ['🪧', msg('Signage')], export: ['🚢', msg('Export')], insurance: ['🛡️', msg('Insurance')], other: ['📄', msg('Other')]
};
const STATE = {
  expired: ['is-bad', '⛔', msg('Expired')], renewing_late: ['is-bad', '⏳', msg('Expired · renewal applied for')], due: ['is-warn', '⏰', msg('Ending soon')],
  renewing: ['is-calm', '⏳', msg('Renewal applied for')], ok: ['is-good', '✅', msg('In force')], no_expiry: ['is-calm', '♾️', msg('No end date')], closed: ['', '🗄️', msg('Closed')]
};
const HERO = { expired: ['#b91c1c', '#7f1d1d'], renewing_late: ['#b91c1c', '#9a3412'], due: ['#d97706', '#b45309'], renewing: ['#2563eb', '#4338ca'], ok: ['#0f766e', '#15803d'], no_expiry: ['#334155', '#2563eb'], closed: ['#475569', '#334155'] };

function leftWords(n) {
  if (n == null) return '';
  if (n < 0) return n === -1 ? tr('ended yesterday') : tr('ended {n} days ago', { n: -n });
  if (n === 0) return tr('ends today');
  if (n === 1) return tr('ends tomorrow');
  if (n < 60) return tr('{n} days left', { n });
  return tr('{n} months left', { n: Math.round(n / 30.4) });
}

// A copy, fetched with the sign-in and opened here.
function LicFile({ path, file }) {
  const [url, setUrl] = useState(null);
  const [big, setBig] = useState(false);
  useEffect(() => {
    let live = true, made = null;
    fetch(API_URL + path, { headers: api.authHeaders() }).then((r) => (r.ok ? r.blob() : null)).then((b) => { if (b && live) { made = URL.createObjectURL(b); setUrl(made); } }).catch(() => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [path]);
  const isPdf = file.type === 'application/pdf';
  if (!url) return <span className="lic-file is-wait" aria-hidden="true">{isPdf ? '📄' : '📷'}</span>;
  if (isPdf) return <a className="lic-file is-pdf" href={url} target="_blank" rel="noreferrer" title={file.name}><b>PDF</b><small>{file.name}</small></a>;
  return (
    <>
      <button type="button" className="lic-file" onClick={() => setBig(true)} aria-label={file.name}><img src={url} alt="" /></button>
      {big && createPortal(<div className="x7-zoom" onClick={() => setBig(false)} role="dialog" aria-label={file.name}><img src={url} alt="" /></div>, document.body)}
    </>
  );
}

function FilePick({ files, setFiles }) {
  async function add(list) {
    const out = [];
    for (const f of Array.from(list).slice(0, 6)) out.push({ name: f.name, dataUrl: await toDataUrl(f) });
    setFiles([...files, ...out].slice(0, 6));
  }
  return (
    <>
      <label className={'x7-drop' + (files.length ? ' is-set' : '')}><em aria-hidden="true">📎</em><span>{files.length ? tr('{n} files to add', { n: files.length }) : tr('Add a copy: a PDF or a photo')}</span>
        <input type="file" accept="application/pdf,image/*" multiple onChange={(e) => { add(e.target.files); e.target.value = ''; }} /></label>
      {files.length > 0 && <div className="x7-chips">{files.map((f, n) => <button key={n} type="button" onClick={() => setFiles(files.filter((_, i) => i !== n))}>📎 {f.name} ✕</button>)}</div>}
    </>
  );
}

function EditDialog({ d, l, onClose, onDone }) {
  const [f, setF] = useState(l ? { kind: l.kind, title: l.title, companyId: l.company ? l.company.id : '', authority: l.authority, number: l.number, site: l.site, issuedOn: l.issuedOn || '', expiresOn: l.expiresOn || '', cost: String(l.cost || ''), ownerId: l.owner ? l.owner.id : '', leadDays: String(l.leadDays), note: l.note || '' }
    : { kind: 'business', title: '', companyId: '', authority: '', number: '', site: '', issuedOn: '', expiresOn: '', cost: '', ownerId: '', leadDays: '30', note: '' });
  const [files, setFiles] = useState([]);
  const [remove, setRemove] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    const body = { ...f, addFiles: files, removeFiles: remove };
    try { onDone(await (l ? api.put('/licences/' + l.id, body) : api.post('/licences', body))); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" style={{ width: 'min(720px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="lic-e-t" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">{KIND[f.kind][0]}</span><div><h2 id="lic-e-t">{l ? tr('Change the licence') : tr('A licence or permit')}</h2><p>{tr('Its owner and whoever keeps the licences are reminded 60, 30, 14 and 7 days before it ends.')}</p></div></div>
        <div className="lic-kinds" role="radiogroup" aria-label={tr('Kind')}>{Object.entries(KIND).map(([k, [ic, lab]]) => (
          <button key={k} type="button" role="radio" aria-checked={f.kind === k} className={f.kind === k ? 'is-on' : ''} onClick={() => set('kind', k)}><em aria-hidden="true">{ic}</em>{tr(lab)}</button>
        ))}</div>
        <div className="x7-grid2">
          <label><span>{tr('Called')}</span><input className="input" required value={f.title} onChange={(e) => set('title', e.target.value)} placeholder={tr('e.g. Business operating permit')} /></label>
          <label><span>{tr('Company')}</span><select className="input" value={f.companyId} onChange={(e) => set('companyId', e.target.value)}><option value="">{tr('All of us')}</option>{d.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label><span>{tr('Issued by')}</span><input className="input" value={f.authority} onChange={(e) => set('authority', e.target.value)} placeholder={tr('e.g. the Municipal Assembly')} /></label>
          <label><span>{tr('Number')}</span><input className="input" value={f.number} onChange={(e) => set('number', e.target.value)} /></label>
          <label><span>{tr('Site')}</span><input className="input" value={f.site} onChange={(e) => set('site', e.target.value)} placeholder={tr('e.g. the factory, the restaurant')} /></label>
          <label><span>{tr('Who looks after it')}</span><select className="input" value={f.ownerId} onChange={(e) => set('ownerId', e.target.value)}><option value="">—</option>{d.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        </div>
        <div className="x7-grid3">
          <label><span>{tr('Issued on')}</span><input className="input" type="date" value={f.issuedOn} onChange={(e) => set('issuedOn', e.target.value)} /></label>
          <label><span>{tr('Ends on')}</span><input className="input" type="date" value={f.expiresOn} onChange={(e) => set('expiresOn', e.target.value)} /><small>{tr('Empty if it does not end.')}</small></label>
          <label><span>{tr('Cost')}</span><input className="input" type="number" min="0" step="0.01" value={f.cost} onChange={(e) => set('cost', e.target.value)} /></label>
        </div>
        <label><span>{tr('Start renewing this many days before')}</span><input className="input" type="number" min="0" max="365" value={f.leadDays} onChange={(e) => set('leadDays', e.target.value)} style={{ maxWidth: 140 }} /></label>
        <label><span>{tr('Note')}</span><textarea className="input" rows={2} value={f.note} onChange={(e) => set('note', e.target.value)} /></label>
        {l && l.files.length > 0 && <div className="x7-chips">{l.files.map((x) => <button key={x.n} type="button" className={remove.includes(x.n) ? 'is-on' : ''} style={{ '--c1': '#b91c1c', '--c2': '#7f1d1d' }} onClick={() => setRemove(remove.includes(x.n) ? remove.filter((y) => y !== x.n) : [...remove, x.n])}>{remove.includes(x.n) ? '🗑️' : '📎'} {x.name}</button>)}</div>}
        <FilePick files={files} setFiles={setFiles} />
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save')}</button></div>
      </form>
    </div>
  );
}

function RenewDialog({ l, onClose, onDone }) {
  const [f, setF] = useState({ number: l.number, issuedOn: today(), expiresOn: '', cost: String(l.cost || ''), note: '' });
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onDone(await api.post('/licences/' + l.id + '/renew', { ...f, files })); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" role="dialog" aria-modal="true" aria-labelledby="lic-r-t" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">🔄</span><div><h2 id="lic-r-t">{tr('Renewed: the new one')}</h2><p>{tr('The one before goes into the history, with its copy.')}</p></div></div>
        <div className="x7-grid2">
          <label><span>{tr('Number')}</span><input className="input" value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} /></label>
          <label><span>{tr('Cost')}</span><input className="input" type="number" min="0" step="0.01" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} /></label>
          <label><span>{tr('Issued on')}</span><input className="input" type="date" value={f.issuedOn} onChange={(e) => setF({ ...f, issuedOn: e.target.value })} /></label>
          <label><span>{tr('Ends on')}</span><input className="input" type="date" required value={f.expiresOn} onChange={(e) => setF({ ...f, expiresOn: e.target.value })} /></label>
        </div>
        <FilePick files={files} setFiles={setFiles} />
        <label><span>{tr('Note')}</span><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save the new one')}</button></div>
      </form>
    </div>
  );
}

function LicenceSheet({ id, d, onClose, onChanged }) {
  const [l, setL] = useState(null);
  const [error, setError] = useState(null);
  const [dlg, setDlg] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.get('/licences/' + id).then(setL).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  async function act(path, body) {
    setBusy(true); setError(null);
    try { setL(await api.post('/licences/' + id + path, body || {})); setForm(null); onChanged(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  if (!l) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const st = STATE[l.state], g = HERO[l.state];
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet" role="dialog" aria-modal="true" aria-labelledby="lic-s-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={{ '--g1': g[0], '--g2': g[1] }}>
          <span className="x7-icon" aria-hidden="true">{KIND[l.kind][0]}</span>
          <div><small>{tr(KIND[l.kind][1])}{l.company ? ' · ' + l.company.name : ''}{l.site ? ' · ' + l.site : ''}</small><h2 id="lic-s-t">{l.title}</h2>
            <p><span className="x7-pill">{st[1]} {tr(st[2])}</span>{l.daysLeft != null && l.status !== 'closed' && <span className="x7-pill">{leftWords(l.daysLeft)}</span>}</p></div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <dl className="x7-facts">
          <div><dt>{tr('Issued by')}</dt><dd>{l.authority || '—'}</dd></div>
          <div><dt>{tr('Number')}</dt><dd>{l.number || '—'}</dd></div>
          <div><dt>{tr('Issued on')}</dt><dd>{dayY(l.issuedOn)}</dd></div>
          <div><dt>{tr('Ends on')}</dt><dd>{l.expiresOn ? dayText(l.expiresOn, { year: 'numeric' }) : tr('Does not end')}</dd></div>
          <div><dt>{tr('Cost')}</dt><dd>{money(l.cost, 'GHS')}</dd></div>
          <div><dt>{tr('Spent on it so far')}</dt><dd>{money(l.spent, 'GHS')}{l.renewals ? ' · ' + (l.renewals === 1 ? tr('1 renewal') : tr('{n} renewals', { n: l.renewals })) : ''}</dd></div>
          <div><dt>{tr('Who looks after it')}</dt><dd>{l.owner ? l.owner.name : '—'}</dd></div>
          <div><dt>{tr('Renewing starts')}</dt><dd>{tr('{n} days before', { n: l.leadDays })}</dd></div>
        </dl>
        {l.renewingSince && <p className="x7-note">⏳ {tr('Renewal applied for on {date}.', { date: dayY(l.renewingSince) })}</p>}
        {l.note && <p className="x7-note">📝 {l.note}</p>}
        {l.files.length > 0 && <div className="x7-sec"><h3>📎 {tr('The copy')}</h3><div className="lic-files">{l.files.map((x) => <LicFile key={x.n + l.updatedAt} path={'/licences/' + l.id + '/files/' + x.n} file={x} />)}</div></div>}
        {form && form.k === 'applied' && (
          <div className="x7-form"><h3>⏳ {tr('The renewal is in')}</h3>
            <div className="x7-grid2"><label><span>{tr('Applied on')}</span><input className="input" type="date" max={today()} value={form.on} onChange={(e) => setForm({ ...form, on: e.target.value })} /></label>
              <label><span>{tr('Note')}</span><input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder={tr('e.g. inspection booked')} /></label></div>
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setForm(null)}>{tr('Cancel')}</button><button type="button" className="btn btn-primary" disabled={busy} onClick={() => act('/applied', { on: form.on, note: form.note })}>{tr('Save')}</button></div></div>
        )}
        {form && form.k === 'close' && (
          <div className="x7-form"><h3>🗄️ {tr('No longer needed')}</h3>
            <label><span>{tr('Why?')}</span><input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setForm(null)}>{tr('Cancel')}</button><button type="button" className="btn btn-primary" disabled={busy} onClick={() => act('/close', { note: form.note })}>{tr('Close it')}</button></div></div>
        )}
        {l.history.length > 0 && (
          <div className="x7-sec"><h3>🗂️ {tr('Before')}</h3>
            <ol className="lic-history">{l.history.map((h) => (
              <li key={h.id}><b>{dayY(h.issuedOn)} → {dayY(h.expiresOn)}</b><small>{[h.number, money(h.cost, 'GHS'), h.by].filter(Boolean).join(' · ')}</small>
                {h.files.length > 0 && <div className="lic-files is-small">{h.files.map((x) => <LicFile key={x.n} path={'/licences/' + l.id + '/files/' + x.n + '?renewal=' + h.id} file={x} />)}</div>}</li>
            ))}</ol>
          </div>
        )}
        {!form && (
          <div className="x7-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setDlg('edit')}>✏️ {tr('Change')}</button>
            {l.status === 'closed' ? <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => act('/reopen')}>♻️ {tr('Open it again')}</button> : <>
              <button type="button" className="btn btn-secondary" onClick={() => setForm({ k: 'close', note: '' })}>🗄️ {tr('No longer needed')}</button>
              {l.status !== 'renewing' && l.expiresOn && <button type="button" className="btn btn-secondary is-end" onClick={() => setForm({ k: 'applied', on: today(), note: '' })}>⏳ {tr('Applied for renewal')}</button>}
              <button type="button" className={'btn btn-primary' + (l.status === 'renewing' || !l.expiresOn ? ' is-end' : '')} onClick={() => setDlg('renew')}>🔄 {tr('Renewed')}</button>
            </>}
          </div>
        )}
        {dlg === 'edit' && <EditDialog d={d} l={l} onClose={() => setDlg(null)} onDone={(x) => { setDlg(null); setL(x); onChanged(); }} />}
        {dlg === 'renew' && <RenewDialog l={l} onClose={() => setDlg(null)} onDone={(x) => { setDlg(null); setL(x); onChanged(); }} />}
      </div>
    </div>
  );
}

export default function LicencesPage() {
  const [params, setParams] = useSearchParams();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState('');
  const tab = params.get('tab') || 'held';
  const load = useCallback(() => api.get('/licences' + (tab === 'closed' ? '?status=closed' : '')).then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), [tab]);
  useEffect(() => { load(); }, [load]);
  const open = params.get('licence');
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const s = d.summary;
  const go = (p) => setParams(p);
  const shown = d.licences.filter((l) => !q || [l.title, l.authority, l.number, l.site, l.company && l.company.name].join(' ').toLowerCase().includes(q.toLowerCase()));
  const maxCount = Math.max(1, ...d.months.map((m) => m.count));
  const thisMonth = today().slice(0, 7);
  return (
    <div className="x7">
      <header className="x7-head">
        <div>
          <h1>🪪 {tr('Licences and permits')}</h1>
          <p>{tr('The operating permits, fire certificates, food hygiene, EPA and liquor licences each company and site must hold: when each ends, what it costs, a copy, and a reminder in time to renew.')}</p>
        </div>
        <div className="x7-head-actions"><button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>➕ {tr('A licence')}</button></div>
      </header>
      <div className="x7-tiles">
        <div className="x7-tile is-teal"><small>🪪 {tr('Held')}</small><b>{s.held}</b><span>{s.next ? tr('next: {title}, {when}', { title: s.next.title, when: leftWords(s.next.daysLeft) }) : tr('nothing ending')}</span></div>
        <div className={'x7-tile ' + (s.expired ? 'is-bad' : 'is-good')}><small>⛔ {tr('Expired')}</small><b>{s.expired}</b><span>{s.expired ? tr('renew now') : tr('none')}</span></div>
        <div className={'x7-tile ' + (s.due ? 'is-warn' : 'is-good')}><small>⏰ {tr('Ending soon')}</small><b>{s.due}</b><span>{tr('time to renew')}</span></div>
        <div className="x7-tile is-calm"><small>⏳ {tr('Renewal applied for')}</small><b>{s.renewing}</b><span>{tr('waiting on the issuer')}</span></div>
        <div className="x7-tile is-violet"><small>💵 {tr('Spent this year')}</small><b>{money(s.spentYear, 'GHS')}</b><span>{tr('on licences and renewals')}</span></div>
      </div>
      <section className="x7-card lic-year" aria-label={tr('The next twelve months')}>
        <h2>🗓️ {tr('What ends in the next twelve months')}</h2>
        <div className="lic-months">{d.months.map((m) => (
          <div key={m.month} className={'lic-month' + (m.month === thisMonth ? ' is-now' : '') + (m.count ? ' is-some' : '')} title={m.count ? tr('{n} ending · {v}', { n: m.count, v: money(m.cost, 'GHS') }) : ''}>
            <span className="lic-month-bar"><i style={{ height: (m.count / maxCount * 100) + '%' }} />{m.count > 0 && <b>{m.count}</b>}</span>
            <small>{new Date(m.month + '-15T12:00:00Z').toLocaleDateString(activeIntlLocale(), { month: 'short', timeZone: 'UTC' })}</small>
            <em>{m.cost ? money(m.cost, 'GHS').replace(/\.00$/, '') : ''}</em>
          </div>
        ))}</div>
      </section>
      <div className="lic-bar">
        <div className="x7-seg" role="tablist">{[['held', '🪪', msg('In force')], ['also', '🧾', msg('Staff and vehicle papers')], ['closed', '🗄️', msg('Closed')]].map(([k, ic, lab]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'is-on' : ''} onClick={() => go(k === 'held' ? {} : { tab: k })}>{ic} {tr(lab)}{k === 'also' && s.alsoSoon ? <i>{s.alsoSoon}</i> : null}</button>
        ))}</div>
        {tab !== 'also' && <input className="input lic-search" data-type-to-search value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Find a licence')} aria-label={tr('Find a licence')} />}
      </div>
      {tab !== 'also' && (!shown.length ? <div className="x7-empty"><span aria-hidden="true">🪪</span><p>{tab === 'closed' ? tr('Nothing closed.') : tr('No licence yet: add the first.')}</p></div> : (
        <div className="lic-grid">{shown.map((l) => {
          const st = STATE[l.state];
          const ring = l.daysLeft == null ? 100 : Math.max(0, Math.min(100, l.daysLeft / 365 * 100));
          return (
            <button key={l.id} type="button" className={'lic-card ' + st[0]} onClick={() => go({ ...(tab === 'held' ? {} : { tab }), licence: l.id })}>
              <span className="lic-ring" style={{ '--p': ring }} aria-hidden="true"><em>{KIND[l.kind][0]}</em></span>
              <span className="lic-main">
                <b>{l.title}</b>
                <small>{[l.authority, l.number].filter(Boolean).join(' · ') || tr(KIND[l.kind][1])}</small>
                <small>{[l.company && l.company.name, l.site].filter(Boolean).join(' · ') || tr('All of us')}</small>
              </span>
              <span className="lic-when">
                <span className={'x7-pill ' + st[0]}>{st[1]} {tr(st[2])}</span>
                <b>{l.expiresOn ? dayText(l.expiresOn, { year: 'numeric' }) : '—'}</b>
                <small>{l.status !== 'closed' ? leftWords(l.daysLeft) : ''}</small>
              </span>
              <span className="lic-foot">
                {l.owner ? <span className="lic-owner"><i style={{ '--h': hue(l.owner.name) }} aria-hidden="true">{l.owner.name.charAt(0)}</i>{l.owner.name}</span> : <span className="lic-owner is-none">{tr('Nobody looks after it')}</span>}
                <span>{[l.files.length ? '📎 ' + l.files.length : null, l.cost ? money(l.cost, 'GHS') : null].filter(Boolean).join(' · ')}</span>
              </span>
            </button>
          );
        })}</div>
      ))}
      {tab === 'also' && (
        <div className="lic-also">
          <section className="x7-card"><h2>🎓 {tr('Staff certificates')} <small>{tr('kept in Training and certificates')}</small></h2>
            {!d.also.certs.length ? <p className="x7-muted">{tr('None ending in the next 60 days.')}</p> : <div className="x7-list">{d.also.certs.map((c) => (
              <div key={c.id} className={'x7-row' + (c.daysLeft < 0 ? ' is-flag is-bad' : c.daysLeft <= 30 ? ' is-flag is-warn' : '')} style={{ cursor: 'default' }}>
                <span className="x7-avatar" style={{ '--h': hue(c.person.name) }} aria-hidden="true">{c.person.name.charAt(0)}</span>
                <span className="x7-who"><b>{c.person.name}</b><small>{c.type}</small></span>
                <span className={'x7-pill ' + (c.daysLeft < 0 ? 'is-bad' : 'is-warn')}>{leftWords(c.daysLeft)}</span><b className="lic-date">{dayY(c.expiresOn)}</b>
              </div>
            ))}</div>}
          </section>
          <section className="x7-card"><h2>🚐 {tr('Vehicle papers')} <small>{tr('kept in Vehicles and fuel')}</small></h2>
            {!d.also.vehicles.length ? <p className="x7-muted">{tr('None ending in the next 60 days.')}</p> : <div className="x7-list">{d.also.vehicles.map((v) => (
              <div key={v.id + v.what} className={'x7-row' + (v.daysLeft < 0 ? ' is-flag is-bad' : v.daysLeft <= 30 ? ' is-flag is-warn' : '')} style={{ cursor: 'default' }}>
                <span className="x7-icon" aria-hidden="true">{v.what === 'insurance' ? '🛡️' : '🔧'}</span>
                <span className="x7-who"><b>{v.vehicle}</b><small>{v.what === 'insurance' ? tr('Insurance') : tr('Roadworthy certificate')}</small></span>
                <span className={'x7-pill ' + (v.daysLeft < 0 ? 'is-bad' : 'is-warn')}>{leftWords(v.daysLeft)}</span><b className="lic-date">{dayY(v.expiresOn)}</b>
              </div>
            ))}</div>}
          </section>
        </div>
      )}
      {adding && <EditDialog d={d} l={null} onClose={() => setAdding(false)} onDone={(x) => { setAdding(false); load(); go({ licence: x.id }); }} />}
      {open && <LicenceSheet key={open} id={open} d={d} onClose={() => go(tab === 'held' ? {} : { tab })} onChanged={load} />}
    </div>
  );
}
