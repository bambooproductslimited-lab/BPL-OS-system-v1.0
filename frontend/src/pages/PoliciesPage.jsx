import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { API_URL, api } from '../api/client';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './seventeenth.css';
import './twentieth.css';

// Policies to read and sign (People → Policies; backend policies.service.js,
// migration 0201): the handbook, the code of conduct, the safety rules —
// written here or a PDF — published to everyone, a company or a department;
// who has signed, who has not and who is late; a new version asks everyone
// again. Staff read and sign in My space (MyPoliciesCard below); a joiner
// gets each on their first-day checklist.

const CATEGORY = { handbook: ['📘', msg('Staff handbook')], conduct: ['🤝', msg('Code of conduct')], safety: ['🦺', msg('Safety')], it: ['💻', msg('IT and devices')], hr: ['👥', msg('HR')], food: ['🍽️', msg('Food and hygiene')], finance: ['💰', msg('Money and spending')], other: ['📄', msg('Other')] };
const STATUS = { draft: ['is-calm', '✏️', msg('Draft')], published: ['is-good', '📢', msg('In force')], retired: ['', '🗄️', msg('Retired')] };

function dayText(d, opts) { return d ? new Date(String(d).length > 10 ? d : String(d) + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short', ...opts }) : '—'; }
function hue(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function toDataUrl(file) { return new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(file); }); }
function audienceText(a) { return a.kind === 'all' ? tr('Everyone') : a.name; }
function dueWords(due) {
  const n = Math.round((Date.parse(due + 'T00:00:00Z') - Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z')) / 86400000);
  return n < 0 ? (n === -1 ? tr('1 day late') : tr('{n} days late', { n: -n })) : n === 0 ? tr('due today') : n === 1 ? tr('due tomorrow') : tr('due in {n} days', { n });
}

// The policy's PDF, fetched with the sign-in.
function PolicyPdf({ id, version }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let live = true, made = null;
    fetch(API_URL + '/policies/' + id + '/file' + (version ? '?version=' + version : ''), { headers: api.authHeaders() }).then((r) => (r.ok ? r.blob() : null)).then((b) => { if (b && live) { made = URL.createObjectURL(b); setUrl(made); } }).catch(() => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [id, version]);
  if (!url) return <span className="pol-pdf is-wait">📄 {tr('Loading…')}</span>;
  return <a className="pol-pdf" href={url} target="_blank" rel="noreferrer">📄 {tr('Open the PDF')}</a>;
}

// The words of a policy, a paragraph to each blank line.
function PolicyText({ body }) {
  if (!body) return null;
  return <div className="pol-text">{body.split(/\n{2,}/).map((p, n) => <p key={n}>{p}</p>)}</div>;
}

function EditDialog({ d, p, onClose, onDone }) {
  const [f, setF] = useState(p ? { title: p.title, category: p.category, summary: p.summary || '', body: p.body || '', companyId: p.audience.kind === 'company' ? p.audience.id : '', departmentId: p.audience.kind === 'department' ? p.audience.id : '', mustSign: p.mustSign, signDays: String(p.signDays), joiners: p.joiners, versionNote: '' }
    : { title: '', category: 'handbook', summary: '', body: '', companyId: '', departmentId: '', mustSign: true, signDays: '14', joiners: true, versionNote: '' });
  const [file, setFile] = useState(null);
  const [removeFile, setRemoveFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const live = p && p.status === 'published';
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    const body = { ...f, file: file ? file.dataUrl : undefined, fileName: file ? file.name : undefined, removeFile, newVersion: live || undefined };
    try { onDone(await (p ? api.put('/policies/' + p.id, body) : api.post('/policies', body))); } catch (err) { setError(err.message); setBusy(false); }
  }
  const depts = d.departments.filter((x) => !f.companyId || d.companies.find((c) => c.id === f.companyId && c.name === x.company));
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <form className="dialog x7-dlg" style={{ width: 'min(780px, calc(100vw - 24px))' }} role="dialog" aria-modal="true" aria-labelledby="pol-e-t" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="x7-dlg-head"><span className="x7-dlg-art" aria-hidden="true">{CATEGORY[f.category][0]}</span><div><h2 id="pol-e-t">{p ? tr('Change the policy') : tr('A policy')}</h2><p>{live ? tr('It is in force: changing what it says makes version {n}, and everyone signs again.', { n: p.version + 1 }) : tr('Written here or a PDF. Publish it when it is ready: everyone it is for is told.')}</p></div></div>
        <div className="lic-kinds" role="radiogroup" aria-label={tr('Kind')}>{Object.entries(CATEGORY).map(([k, [ic, lab]]) => <button key={k} type="button" role="radio" aria-checked={f.category === k} className={f.category === k ? 'is-on' : ''} onClick={() => set('category', k)}><em aria-hidden="true">{ic}</em>{tr(lab)}</button>)}</div>
        <label><span>{tr('Called')}</span><input className="input" required value={f.title} onChange={(e) => set('title', e.target.value)} placeholder={tr('e.g. Code of conduct')} /></label>
        <label><span>{tr('In a line')}</span><input className="input" value={f.summary} onChange={(e) => set('summary', e.target.value)} placeholder={tr('What it is about, for the list')} /></label>
        <div className="x7-grid2">
          <label><span>{tr('For')}</span><select className="input" value={f.companyId} onChange={(e) => setF({ ...f, companyId: e.target.value, departmentId: '' })}><option value="">{tr('Everyone')}</option>{d.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label><span>{tr('Only one department')}</span><select className="input" value={f.departmentId} onChange={(e) => set('departmentId', e.target.value)}><option value="">—</option>{depts.map((x) => <option key={x.id} value={x.id}>{x.name}{x.company ? ' · ' + x.company : ''}</option>)}</select></label>
        </div>
        <label><span>{tr('What it says')}</span><textarea className="input pol-body" rows={10} value={f.body} onChange={(e) => set('body', e.target.value)} placeholder={tr('A blank line between paragraphs.')} /></label>
        <label className={'x7-drop' + (file ? ' is-set' : '')}><em aria-hidden="true">📄</em><span>{file ? file.name : p && p.hasFile && !removeFile ? tr('A PDF is attached: add another to replace it') : tr('Or add it as a PDF')}</span>
          <input type="file" accept="application/pdf" onChange={async (e) => { const x = e.target.files[0]; e.target.value = ''; if (x) setFile({ name: x.name, dataUrl: await toDataUrl(x) }); }} /></label>
        {p && p.hasFile && !file && <label className="x7-check"><input type="checkbox" checked={removeFile} onChange={(e) => setRemoveFile(e.target.checked)} /><span>{tr('Take the PDF off')}</span></label>}
        <div className="pol-opts">
          <label className="x7-check"><input type="checkbox" checked={f.mustSign} onChange={(e) => set('mustSign', e.target.checked)} /><span>{tr('Everyone must sign it')}<small>{tr('Otherwise only to read.')}</small></span></label>
          {f.mustSign && <label><span>{tr('Days to sign')}</span><input className="input" type="number" min="1" max="90" value={f.signDays} onChange={(e) => set('signDays', e.target.value)} style={{ maxWidth: 100 }} /></label>}
          {f.mustSign && <label className="x7-check"><input type="checkbox" checked={f.joiners} onChange={(e) => set('joiners', e.target.checked)} /><span>{tr('On every joiner\'s first-day checklist')}</span></label>}
        </div>
        {live && <label><span>{tr('What changed, in a line')}</span><input className="input" value={f.versionNote} onChange={(e) => set('versionNote', e.target.value)} placeholder={tr('Only if what it says changed, e.g. phones away on the shop floor')} /></label>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save')}</button></div>
      </form>
    </div>
  );
}

function PolicySheet({ id, d, onClose, onChanged }) {
  const [p, setP] = useState(null);
  const [error, setError] = useState(null);
  const [view, setView] = useState('people');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const load = useCallback(() => api.get('/policies/' + id).then(setP).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  async function act(path, confirm) {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true); setError(null);
    try { const x = await api.post('/policies/' + id + path); if (x.reminded != null) setFlash('🔔 ' + (x.reminded === 1 ? tr('1 person reminded.') : tr('{n} people reminded.', { n: x.reminded }))); else setP(x); onChanged(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  if (!p) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const st = STATUS[p.status];
  const people = p.people || [];
  const signed = people.filter((x) => x.signedAt), late = people.filter((x) => x.overdue), waiting = people.filter((x) => !x.signedAt && !x.overdue);
  const rate = people.length ? Math.round(signed.length / people.length * 100) : 0;
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet is-wide" role="dialog" aria-modal="true" aria-labelledby="pol-s-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={{ '--g1': '#4338ca', '--g2': '#0f766e' }}>
          <span className="x7-icon" aria-hidden="true">{CATEGORY[p.category][0]}</span>
          <div><small>{tr(CATEGORY[p.category][1])} · {audienceText(p.audience)} · {tr('version {n}', { n: p.version })}</small><h2 id="pol-s-t">{p.title}</h2>
            <p><span className="x7-pill">{st[1]} {tr(st[2])}</span>{p.status === 'published' && p.mustSign && <span className="x7-pill">✍️ {tr('{a} of {b} signed', { a: signed.length, b: people.length })}</span>}{late.length > 0 && <span className="x7-pill">⏰ {tr('{n} late', { n: late.length })}</span>}</p></div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {flash && <div className="x7-flash" role="status">{flash}</div>}
        {p.status === 'published' && p.mustSign && people.length > 0 && <div className="pol-progress"><span><i style={{ width: rate + '%' }} /></span><b>{rate}%</b></div>}
        <div className="x7-seg" role="tablist">{[['people', '✍️', msg('Who has signed')], ['text', '📄', msg('What it says')], ['versions', '🗂️', msg('Versions')]].map(([k, ic, lab]) => <button key={k} type="button" role="tab" aria-selected={view === k} className={view === k ? 'is-on' : ''} onClick={() => setView(k)}>{ic} {tr(lab)}</button>)}</div>
        {view === 'people' && (p.status !== 'published' ? <p className="x7-note">{p.status === 'draft' ? tr('A draft: nobody sees it until it is published.') : tr('Retired: nobody is asked to sign it any more.')}</p> : !p.mustSign ? <p className="x7-note">{tr('Only to read: {n} people see it in My space.', { n: people.length })}</p> : (
          <div className="pol-people">
            {[[late, 'is-bad', '⏰', msg('Late')], [waiting, 'is-warn', '⏳', msg('Not yet')], [signed, 'is-good', '✅', msg('Signed')]].map(([list, tone, ic, lab]) => list.length > 0 && (
              <div key={lab} className="pol-group"><h4 className={tone}>{ic} {tr(lab)} <small>{list.length}</small></h4>
                <div className="pol-names">{list.map((x) => (
                  <span key={x.id} className={'pol-name ' + tone}><i style={{ '--h': hue(x.name) }} aria-hidden="true">{x.name.charAt(0)}</i><span><b>{x.name}</b><small>{x.signedAt ? tr('signed {date}', { date: dayText(x.signedAt) }) : x.signedVersion ? tr('signed version {n}', { n: x.signedVersion }) + ' · ' + dueWords(x.due) : [x.department, dueWords(x.due)].filter(Boolean).join(' · ')}</small></span></span>
                ))}</div>
              </div>
            ))}
          </div>
        ))}
        {view === 'text' && <div className="x7-sec">{p.summary && <p className="x7-note">💬 {p.summary}</p>}{p.hasFile && <PolicyPdf id={p.id} />}<PolicyText body={p.body} /></div>}
        {view === 'versions' && (!p.versions.length ? <p className="x7-muted">{tr('Not published yet.')}</p> : <ol className="lic-history">{p.versions.map((v) => <li key={v.version}><b>{tr('Version {n}', { n: v.version })} · {dayText(v.publishedAt, { year: 'numeric' })}</b><small>{[v.note, v.by].filter(Boolean).join(' · ')}</small></li>)}</ol>)}
        <div className="x7-actions">
          {p.status !== 'retired' && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => act('/retire', tr('Retire "{t}"? Nobody will be asked to sign it.', { t: p.title }))}>🗄️ {tr('Retire')}</button>}
          {p.status !== 'retired' && <button type="button" className="btn btn-secondary is-end" onClick={() => setEditing(true)}>✏️ {tr('Edit')}</button>}
          {p.status === 'published' && p.mustSign && waiting.length + late.length > 0 && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => act('/remind')}>🔔 {tr('Remind {n}', { n: waiting.length + late.length })}</button>}
          {p.status === 'draft' && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act('/publish', tr('Publish "{t}"? Everyone it is for is told.', { t: p.title }))}>📢 {tr('Publish')}</button>}
        </div>
        {editing && <EditDialog d={d} p={p} onClose={() => setEditing(false)} onDone={(x) => { setEditing(false); setP(x); onChanged(); }} />}
      </div>
    </div>
  );
}

export default function PoliciesPage() {
  const [params, setParams] = useSearchParams();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => api.get('/policies').then((x) => { setD(x); setError(null); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const open = params.get('policy');
  if (!d) return <div className="x7"><p className="x7-wait">{error || tr('Loading…')}</p></div>;
  const s = d.summary;
  const groups = [['published', msg('In force')], ['draft', msg('Drafts')], ['retired', msg('Retired')]];
  return (
    <div className="x7">
      <header className="x7-head">
        <div>
          <h1>📜 {tr('Policies')}</h1>
          <p>{tr('The handbook, the code of conduct, the safety rules: published to the people they are for, read and signed in My space, signed again when they change. Joiners sign them in their first days.')}</p>
        </div>
        <div className="x7-head-actions"><button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>➕ {tr('A policy')}</button></div>
      </header>
      <div className="x7-tiles">
        <div className="x7-tile is-teal"><small>📢 {tr('In force')}</small><b>{s.published}</b><span>{s.drafts ? (s.drafts === 1 ? tr('1 draft') : tr('{n} drafts', { n: s.drafts })) : tr('no draft')}</span></div>
        <div className={'x7-tile ' + (s.rate == null ? 'is-calm' : s.rate >= 90 ? 'is-good' : 'is-warn')}><small>✍️ {tr('Signed')}</small><b>{s.rate != null ? s.rate + '%' : '—'}</b><span>{tr('{n} fully signed', { n: s.complete })}</span></div>
        <div className={'x7-tile ' + (s.toSign ? 'is-warn' : 'is-good')}><small>⏳ {tr('Signatures waiting')}</small><b>{s.toSign}</b><span>{tr('people and policies')}</span></div>
        <div className={'x7-tile ' + (s.overdue ? 'is-bad' : 'is-good')}><small>⏰ {tr('Late')}</small><b>{s.overdue}</b><span>{tr('reminded every week')}</span></div>
      </div>
      {!d.policies.length ? <div className="x7-empty"><span aria-hidden="true">📜</span><p>{tr('No policy yet: write the first, or add it as a PDF.')}</p></div> : groups.map(([g, lab]) => {
        const list = d.policies.filter((p) => p.status === g);
        if (!list.length) return null;
        return (
          <section key={g} className="pol-sec"><h2 className="x7-h2">{tr(lab)} <small>{list.length}</small></h2>
            <div className="pol-grid">{list.map((p) => {
              const rate = p.people ? Math.round(p.signed / p.people * 100) : 0;
              return (
                <button key={p.id} type="button" className={'pol-card is-' + p.status + (p.overdue ? ' is-late' : '')} onClick={() => setParams({ policy: p.id })}>
                  <span className="pol-cat" aria-hidden="true">{CATEGORY[p.category][0]}</span>
                  <span className="pol-main"><b>{p.title}</b><small>{p.summary || tr(CATEGORY[p.category][1])}</small></span>
                  <span className="pol-meta"><span className="x7-pill is-calm">👥 {audienceText(p.audience)}</span><span className="x7-pill">v{p.version}</span>{p.hasFile && <span className="x7-pill">📄 PDF</span>}{!p.mustSign && <span className="x7-pill">👁️ {tr('to read')}</span>}</span>
                  {p.status === 'published' && p.mustSign && (
                    <span className="pol-sign"><span className="pol-progress"><span><i style={{ width: rate + '%' }} /></span><b>{p.signed}/{p.people}</b></span>{p.overdue > 0 && <span className="x7-pill is-bad">⏰ {tr('{n} late', { n: p.overdue })}</span>}</span>
                  )}
                </button>
              );
            })}</div>
          </section>
        );
      })}
      {adding && <EditDialog d={d} p={null} onClose={() => setAdding(false)} onDone={(x) => { setAdding(false); load(); setParams({ policy: x.id }); }} />}
      {open && <PolicySheet key={open} id={open} d={d} onClose={() => setParams({})} onChanged={load} />}
    </div>
  );
}

// My space: the policies to read and sign, read in a sheet and signed with
// one's name; those signed; those only to read.
export function MyPoliciesCard() {
  const [d, setD] = useState(null);
  const [reading, setReading] = useState(null);
  const [flash, setFlash] = useState(null);
  const [showSigned, setShowSigned] = useState(false);
  const load = useCallback(() => api.get('/policies/mine').then(setD).catch(() => setD(null)), []);
  useEffect(() => { load(); }, [load]);
  if (!d || (!d.toSign.length && !d.signed.length && !d.toRead.length)) return null;
  return (
    <div className="msx-card x7-mine pol-mine">
      <h4 className="msp-h4">📜 {tr('Policies')}</h4>
      {d.toSign.map((p) => (
        <div key={p.id} className="x7-mine-top" style={{ '--tone': p.overdue ? 'var(--x7-bad)' : 'var(--x7-warn)' }}>
          <span><small>{p.again ? '🔄 ' + tr('Changed: sign again') : '✍️ ' + tr('To read and sign')} · {dueWords(p.due)}</small><b>{CATEGORY[p.category][0]} {p.title}</b></span>
          <button type="button" className="btn btn-primary" onClick={() => setReading(p.id)}>{tr('Read and sign')}</button>
        </div>
      ))}
      {d.toRead.length > 0 && <ul className="x7-mine-list">{d.toRead.map((p) => (
        <li key={p.id}><span aria-hidden="true">{CATEGORY[p.category][0]}</span><span><b>{p.title}</b><small>{p.summary || tr('To read')}</small></span><button type="button" className="x7-link" onClick={() => setReading(p.id)}>{tr('Read')}</button></li>
      ))}</ul>}
      {d.signed.length > 0 && (
        <>
          <button type="button" className="x7-link pol-signed-toggle" onClick={() => setShowSigned(!showSigned)}>✅ {d.signed.length === 1 ? tr('1 signed') : tr('{n} signed', { n: d.signed.length })} {showSigned ? '▴' : '▾'}</button>
          {showSigned && <ul className="x7-mine-list">{d.signed.map((p) => (
            <li key={p.id}><span aria-hidden="true">{CATEGORY[p.category][0]}</span><span><b>{p.title}</b><small>{tr('version {n}, signed {date}', { n: p.version, date: dayText(p.signedAt, { year: 'numeric' }) })}</small></span><button type="button" className="x7-link" onClick={() => setReading(p.id)}>{tr('Read')}</button></li>
          ))}</ul>}
        </>
      )}
      {flash && <div className="x7-flash" role="status">{flash}</div>}
      {reading && <ReadSheet id={reading} onClose={() => setReading(null)} onSigned={(t) => { setReading(null); setFlash('✍️ ' + tr('Signed: {t}. Thank you.', { t })); load(); }} />}
    </div>
  );
}

function ReadSheet({ id, onClose, onSigned }) {
  const [p, setP] = useState(null);
  const [name, setName] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { api.get('/policies/' + id).then(setP).catch((e) => setError(e.message)); }, [id]);
  async function sign(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await api.post('/policies/' + id + '/sign', { name, agree }); onSigned(p.title); } catch (err) { setError(err.message); setBusy(false); }
  }
  if (!p) return <div className="dialog-backdrop" onClick={onClose}><div className="dialog x7-sheet"><p className="x7-wait">{error || tr('Loading…')}</p></div></div>;
  const toSign = p.mustSign && p.mine.forMe && !p.mine.signedAt;
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog x7-sheet is-wide" role="dialog" aria-modal="true" aria-labelledby="pol-r-t" onClick={(e) => e.stopPropagation()}>
        <div className="x7-hero" style={{ '--g1': '#4338ca', '--g2': '#0f766e' }}>
          <span className="x7-icon" aria-hidden="true">{CATEGORY[p.category][0]}</span>
          <div><small>{tr(CATEGORY[p.category][1])} · {tr('version {n}', { n: p.version })}</small><h2 id="pol-r-t">{p.title}</h2>
            <p>{p.mine.signedAt ? <span className="x7-pill">✅ {tr('You signed it on {date}', { date: dayText(p.mine.signedAt, { year: 'numeric' }) })}</span> : p.mine.olderVersion ? <span className="x7-pill">🔄 {tr('You signed version {n}: it has changed', { n: p.mine.olderVersion })}</span> : null}</p></div>
          <button type="button" className="x7-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>
        {p.versionNote && p.version > 1 && <p className="x7-note">🔄 {tr('What changed: {note}', { note: p.versionNote })}</p>}
        {p.summary && <p className="x7-note">💬 {p.summary}</p>}
        {p.hasFile && <PolicyPdf id={p.id} />}
        <PolicyText body={p.body} />
        {toSign && (
          <form className="pol-signbox" onSubmit={sign}>
            <h3>✍️ {tr('Sign it')}</h3>
            <label className="x7-check"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /><span>{tr('I have read it and I understand it, and I will keep to it.')}</span></label>
            <div className="pol-signrow">
              <input className="input pol-signname" value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('Type your full name')} aria-label={tr('Type your full name')} autoComplete="name" />
              <button type="submit" className="btn btn-primary" disabled={busy || !agree || name.trim().length < 3}>{tr('Sign')}</button>
            </div>
            {error && <div className="error-banner" role="alert">{error}</div>}
          </form>
        )}
      </div>
    </div>
  );
}
