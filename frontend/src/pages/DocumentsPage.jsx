import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_URL, api, getToken } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import Photo from '../components/Photo';
import RowMenu from '../components/RowMenu';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { CompanySwitcher, Glossary, Hero, Insights, Section, Status, fmtDate, jump } from '../components/DashKit';
import { downloadProtected, extOf, fileBadge, fmtSize, uploadWithProgress } from '../lib/chatMedia';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './EmployeesPage.css';
import './DocumentsPage.css';

// Company documents: policies, licences, permits, certificates, insurance,
// forms. Same "explains itself" layout as the dashboards
// (components/DashKit.jsx): a company switcher (a document with no company
// belongs to the whole group and shows under every company), the key
// numbers (press one to show only those), what stands out (what has run
// out or is about to), folders by category, then the documents. A document
// opens in a viewer on the page (PDFs and photos; anything else is
// downloaded), and whoever looks after documents can change every detail
// or upload a new version when a licence is renewed
// (documents.service.js, migration 0083). The OS warns before an expiry
// date (backend jobs/dailyAlerts.js).

const SOON_DAYS = 60;
const CATEGORY_HINTS = [msg('Policy'), msg('Licence'), msg('Permit'), msg('Certificate'), msg('Insurance'), msg('Contract'), msg('Form'), msg('Report')];
const EMPTY_FORM = { title: '', category: '', description: '', companyId: '', visibility: 'all', departmentId: '', expiresOn: '' };
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
const TEXT_EXT = ['txt', 'csv'];

function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function isoDay(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

// Days from today to a YYYY-MM-DD date (negative once it has passed).
function daysUntil(iso) {
  const today = new Date();
  const t = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - t) / 86400000);
}
function expiryState(doc) {
  if (!doc.expiresOn) return null;
  const days = daysUntil(doc.expiresOn);
  if (days < 0) return { key: 'expired', days, tone: 'bad', text: tr('Expired {date}', { date: fmtDate(doc.expiresOn) }) };
  if (days === 0) return { key: 'soon', days, tone: 'bad', text: tr('Expires today') };
  if (days === 1) return { key: 'soon', days, tone: 'bad', text: tr('Expires tomorrow') };
  if (days <= SOON_DAYS) return { key: 'soon', days, tone: days <= 14 ? 'bad' : 'warn', text: tr('Expires in {n} days', { n: days }) };
  return { key: 'ok', days, tone: 'muted', text: tr('Valid until {date}', { date: fmtDate(doc.expiresOn) }) };
}
function viewKind(doc) {
  const ext = extOf(doc.fileName);
  const type = String(doc.contentType || '');
  if (ext === 'pdf' || type === 'application/pdf') return 'pdf';
  if (IMAGE_EXT.includes(ext) || (type.startsWith('image/') && !/heic|heif|svg/.test(type))) return 'image';
  if (TEXT_EXT.includes(ext) || type === 'text/plain' || type === 'text/csv') return 'text';
  return 'other';
}
function titleFromFile(name) {
  return String(name || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase()).slice(0, 100);
}

function FileBadge({ doc, big }) {
  const b = fileBadge(doc.fileName || '', 'file');
  return <span className={'doc-badge' + (big ? ' is-big' : '')} style={{ '--doc-c': doc.hasFile ? b.tone : '#8a8f94' }} aria-hidden="true">{doc.hasFile ? b.label : '—'}</span>;
}

// Drag a file on, or press to choose one.
function DropZone({ file, onFile, hint }) {
  const inputRef = useRef(null);
  const [over, setOver] = useState(false);
  return (
    <div
      className={'doc-drop' + (over ? ' is-over' : '') + (file ? ' has-file' : '')}
      role="button" tabIndex={0}
      onClick={() => { if (inputRef.current) inputRef.current.click(); }}
      onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && inputRef.current) { e.preventDefault(); inputRef.current.click(); } }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files && e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); }}>
      <input ref={inputRef} type="file" hidden
        accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.rtf,.odt,.ods,.jpg,.jpeg,.png,.webp,.heic"
        onChange={(e) => { if (e.target.files && e.target.files[0]) onFile(e.target.files[0]); e.target.value = ''; }} />
      {file ? (
        <>
          <FileBadge doc={{ fileName: file.name, hasFile: true }} />
          <span className="doc-drop-text"><strong>{file.name}</strong><span className="dk-muted">{fmtSize(file.size)} · {tr('press to choose another')}</span></span>
        </>
      ) : (
        <span className="doc-drop-text">
          <strong>{tr('Drop a file here or press to choose one')}</strong>
          <span className="dk-muted">{hint || tr('PDF, Word, Excel, PowerPoint, text or a photo.')}</span>
        </span>
      )}
    </div>
  );
}

// The document itself, shown on the page. Files sit behind sign-in, so it
// is fetched with the sign-in token and shown from a local copy.
function Viewer({ doc, canManage, onClose, onEdit, onReplace }) {
  const kind = viewKind(doc);
  const [url, setUrl] = useState(null);
  const [text, setText] = useState(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const exp = expiryState(doc);
  // Phones (Chrome on Android, for one) cannot show a PDF inside the page;
  // there the PDF opens in the phone's own viewer instead.
  const canShowPdf = typeof navigator === 'undefined' || navigator.pdfViewerEnabled !== false;

  useEffect(() => {
    if (!doc.hasFile || kind === 'other') return undefined;
    let alive = true;
    let made = null;
    fetch(API_URL + '/documents/' + doc.id + '/file', { headers: { Authorization: 'Bearer ' + (getToken() || '') } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('file'))))
      .then(async (b) => {
        if (!alive) return;
        if (kind === 'text') { setText((await b.text()).slice(0, 200000)); return; }
        const typed = kind === 'pdf' && b.type !== 'application/pdf' ? new Blob([b], { type: 'application/pdf' }) : b;
        made = URL.createObjectURL(typed);
        setUrl(made);
      })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [doc.id, doc.hasFile, doc.version, kind]);

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function download() {
    setBusy(true);
    try { await downloadProtected('/documents/' + doc.id + '/file?download=1', doc.fileName); } catch { setFailed(true); } finally { setBusy(false); }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog doc-viewer" role="dialog" aria-label={doc.title} onClick={(e) => e.stopPropagation()}>
        <div className="doc-viewer-head">
          <FileBadge doc={doc} big />
          <div className="doc-viewer-title">
            <h2>{doc.title}</h2>
            <span className="dk-muted">
              {doc.category}{doc.fileName ? ' · ' + doc.fileName : ''}{doc.size ? ' · ' + fmtSize(doc.size) : ''}{doc.version > 1 ? ' · ' + tr('version {n}', { n: doc.version }) : ''}
            </span>
          </div>
          <button type="button" className="doc-close" onClick={onClose} aria-label={tr('Close')}>×</button>
        </div>
        <div className="doc-viewer-tags">
          {exp && <Status tone={exp.tone === 'muted' ? 'good' : exp.tone}>{exp.text}</Status>}
          <span className="doc-tag">{doc.companyName || tr('Whole group')}</span>
          <span className="doc-tag">{visibilityText(doc)}</span>
        </div>
        {doc.description && <p className="doc-desc">{doc.description}</p>}

        <div className={'doc-frame is-' + kind}>
          {!doc.hasFile ? (
            <p className="dk-muted">{tr('No file was kept for this document. Upload one with "Upload new version".')}</p>
          ) : failed ? (
            <p className="dk-muted">{tr('The file could not be opened. Try downloading it.')}</p>
          ) : kind === 'other' ? (
            <div className="doc-frame-other">
              <FileBadge doc={doc} big />
              <p className="dk-muted">{tr('This kind of file cannot be shown in the browser. Download it to open it on your device.')}</p>
            </div>
          ) : kind === 'text' ? (
            text === null ? <p className="dk-muted">{tr('Loading…')}</p> : <pre className="doc-text">{text}</pre>
          ) : !url ? (
            <p className="dk-muted">{tr('Loading…')}</p>
          ) : kind === 'pdf' && !canShowPdf ? (
            <div className="doc-frame-other">
              <FileBadge doc={doc} big />
              <p className="dk-muted">{tr('This browser opens PDFs in its own viewer.')}</p>
              <a className="btn btn-primary" href={url} target="_blank" rel="noopener noreferrer">{tr('Open the PDF')}</a>
            </div>
          ) : kind === 'pdf' ? (
            <iframe title={doc.title} src={url + '#toolbar=1'} />
          ) : (
            <img src={url} alt={doc.title} />
          )}
        </div>

        <p className="dk-muted doc-small">
          {tr('Added by {name} on {date}', { name: doc.uploaderName, date: fmtDate(String(doc.uploadedAt).slice(0, 10)) })}
          {doc.updatedAt ? ' · ' + tr('last changed {date}', { date: fmtDate(String(doc.updatedAt).slice(0, 10)) }) : ''}
        </p>
        <div className="dialog-actions doc-viewer-actions">
          {canManage && <button type="button" className="btn btn-secondary" onClick={onEdit}>{tr('Edit details')}</button>}
          {canManage && <button type="button" className="btn btn-secondary" onClick={onReplace}>{tr('Upload new version')}</button>}
          {doc.hasFile && <button type="button" className="btn btn-primary" onClick={download} disabled={busy}>{busy ? tr('Downloading…') : tr('Download')}</button>}
        </div>
      </div>
    </div>
  );
}

function visibilityText(doc) {
  if (doc.visibility === 'managers') return tr('Managers only');
  if (doc.visibility === 'department') return tr('{name} only', { name: doc.departmentName || tr('One department') });
  return tr('Everyone');
}

export default function DocumentsPage() {
  const { session, can } = useAuth();
  const canManage = can('document.manage');
  const myId = session && session.employee ? session.employee.id : null;

  const [documents, setDocuments] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [companyCode, setCompanyCode] = useState(() => readPref('bos.documentsCompany', 'ALL'));
  const [chip, setChip] = useState('all');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('newest');

  const [viewing, setViewing] = useState(null);
  const [dialog, setDialog] = useState(null); // { mode: 'new' | 'edit', doc }
  const [form, setForm] = useState(EMPTY_FORM);
  const [file, setFile] = useState(null);
  const [replacing, setReplacing] = useState(null); // { doc, file, expiresOn }
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [rows, depts] = await Promise.all([api.get('/documents'), api.get('/departments')]);
      setDocuments(rows);
      setDepartments(depts);
      return rows;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const companies = useMemo(() => {
    const seen = new Map();
    departments.forEach((d) => { if (!seen.has(d.companyId)) seen.set(d.companyId, { id: d.companyId, name: d.companyName, code: d.companyCode || d.companyId }); });
    return Array.from(seen.values()).sort((a, b) => (a.code === 'BPL' ? -1 : b.code === 'BPL' ? 1 : a.name.localeCompare(b.name)));
  }, [departments]);
  const currentCompany = companies.find((c) => c.code === companyCode) || null;
  function pickCompany(code) { setCompanyCode(code); writePref('bos.documentsCompany', code); }

  // ── actions ──────────────────────────────────────────────────────────
  function openNew() {
    setForm({ ...EMPTY_FORM, category: category || '', companyId: currentCompany ? currentCompany.id : '' });
    setFile(null);
    setFormError(null);
    setProgress(0);
    setDialog({ mode: 'new' });
  }
  function openEdit(doc) {
    setViewing(null);
    setForm({
      title: doc.title, category: doc.category, description: doc.description || '', companyId: doc.companyId || '',
      visibility: doc.visibility, departmentId: doc.departmentId || '', expiresOn: doc.expiresOn || ''
    });
    setFormError(null);
    setDialog({ mode: 'edit', doc });
  }
  function openReplace(doc) {
    setViewing(null);
    setFormError(null);
    setProgress(0);
    setReplacing({ doc, file: null, expiresOn: '' });
  }
  function pickFile(f) {
    setFile(f);
    if (!form.title.trim()) setForm((cur) => ({ ...cur, title: titleFromFile(f.name) }));
  }
  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      if (dialog.mode === 'new') {
        if (!file) throw new Error(tr('Choose a file to upload.'));
        const fd = new FormData();
        ['title', 'category', 'description', 'companyId', 'visibility', 'expiresOn'].forEach((k) => fd.append(k, form[k] || ''));
        if (form.visibility === 'department' && form.departmentId) fd.append('departmentId', form.departmentId);
        fd.append('file', file);
        await uploadWithProgress('/documents', fd, setProgress);
        setToast(tr('Document added.'));
      } else {
        await api.patch('/documents/' + dialog.doc.id, {
          title: form.title, category: form.category, description: form.description, companyId: form.companyId || null,
          visibility: form.visibility, departmentId: form.visibility === 'department' ? form.departmentId || undefined : undefined,
          expiresOn: form.expiresOn || null
        });
        setToast(tr('Document updated.'));
      }
      setDialog(null);
      await load();
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  }
  async function saveReplace(e) {
    e.preventDefault();
    if (!replacing.file) { setFormError(tr('Choose a file to upload.')); return; }
    setSaving(true);
    setFormError(null);
    try {
      const fd = new FormData();
      if (replacing.expiresOn) fd.append('expiresOn', replacing.expiresOn);
      fd.append('file', replacing.file);
      const updated = await uploadWithProgress('/documents/' + replacing.doc.id + '/replace', fd, setProgress);
      setToast(tr('Version {n} uploaded.', { n: updated.version }));
      setReplacing(null);
      await load();
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  }
  async function confirmDelete() {
    try { await api.del('/documents/' + deleteTarget.id); setDeleteTarget(null); setViewing(null); setToast(tr('Document removed.')); await load(); } catch (err) { setError(err.message); }
  }
  async function download(doc) {
    try { await downloadProtected('/documents/' + doc.id + '/file?download=1', doc.fileName); } catch (err) { setError(err.message); }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const inCompany = documents.filter((d) => !currentCompany || !d.companyId || d.companyId === currentCompany.id);
  const withState = inCompany.map((d) => ({ d, exp: expiryState(d) }));
  const expired = withState.filter((x) => x.exp && x.exp.key === 'expired');
  const soon = withState.filter((x) => x.exp && x.exp.key === 'soon').sort((a, b) => a.exp.days - b.exp.days);
  const monthStart = isoDay(new Date()).slice(0, 7);
  const thisMonth = inCompany.filter((d) => String(d.uploadedAt).slice(0, 7) === monthStart || (d.updatedAt && String(d.updatedAt).slice(0, 7) === monthStart && d.version > 1));
  const noFile = inCompany.filter((d) => !d.hasFile);
  const mine = inCompany.filter((d) => d.uploadedBy === myId);

  const folders = Array.from(inCompany.reduce((m, d) => m.set(d.category, (m.get(d.category) || 0) + 1), new Map()).entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const categoryNames = Array.from(new Set([...documents.map((d) => d.category), ...CATEGORY_HINTS.map((c) => tr(c))])).sort((a, b) => a.localeCompare(b));

  const chipTest = {
    all: () => true,
    soon: (x) => x.exp && x.exp.key === 'soon',
    expired: (x) => x.exp && x.exp.key === 'expired',
    dated: (x) => !!x.exp,
    mine: (x) => x.d.uploadedBy === myId,
    group: (x) => !x.d.companyId,
    nofile: (x) => !x.d.hasFile
  };
  function showOnly(key) { setChip(chip === key ? 'all' : key); setCategory(''); jump('doc-list'); }
  const sorters = {
    newest: (a, b) => String(b.d.updatedAt || b.d.uploadedAt).localeCompare(String(a.d.updatedAt || a.d.uploadedAt)),
    title: (a, b) => a.d.title.localeCompare(b.d.title),
    expiry: (a, b) => (a.exp ? a.exp.days : 1e9) - (b.exp ? b.exp.days : 1e9)
  };
  const visible = withState
    .filter(chipTest[chip] || chipTest.all)
    .filter((x) => !category || x.d.category === category)
    .filter((x) => matchesQuery(search, x.d.title, x.d.category, x.d.description, x.d.fileName, x.d.uploaderName, x.d.companyName))
    .sort(sorters[sort] || sorters.newest);
  const showCompany = !currentCompany && companies.length > 1;

  const stats = [
    { icon: 'doc', value: String(inCompany.length), label: tr('documents'), note: folders.length === 1 ? tr('in 1 folder') : tr('in {n} folders', { n: folders.length }), onClick: () => { setChip('all'); setCategory(''); jump('doc-list'); } },
    { icon: 'warn', value: String(expired.length), label: tr('expired'), note: expired.length ? tr('need renewing') : tr('nothing has run out'), tone: expired.length ? 'bad' : 'good', onClick: () => showOnly('expired') },
    { icon: 'clock', value: String(soon.length), label: tr('expiring soon'), note: tr('within {n} days', { n: SOON_DAYS }), tone: soon.length ? 'alert' : '', onClick: () => showOnly('soon') },
    { icon: 'calendar', value: String(thisMonth.length), label: tr('added this month'), note: tr('new documents and new versions'), onClick: () => { setChip('all'); setSort('newest'); setCategory(''); jump('doc-list'); } }
  ];

  const insights = [];
  if (expired.length) {
    const worst = expired.slice().sort((a, b) => a.exp.days - b.exp.days)[0];
    insights.push({
      tone: 'bad', icon: 'warn',
      text: expired.length === 1
        ? tr('"{title}" ran out on {date}. Upload the renewed one as a new version.', { title: worst.d.title, date: fmtDate(worst.d.expiresOn) })
        : tr('{n} documents have run out, the oldest "{title}" on {date}.', { n: expired.length, title: worst.d.title, date: fmtDate(worst.d.expiresOn) }),
      action: { label: expired.length === 1 ? tr('Open it') : tr('Show them'), run: () => (expired.length === 1 ? setViewing(worst.d) : showOnly('expired')) }
    });
  }
  if (soon.length) {
    const next = soon[0];
    insights.push({
      tone: next.exp.days <= 14 ? 'bad' : 'warn', icon: 'clock',
      text: soon.length === 1
        ? tr('"{title}" expires in {n} days ({date}).', { title: next.d.title, n: next.exp.days, date: fmtDate(next.d.expiresOn) })
        : tr('{count} documents expire in the next {days} days; first "{title}" on {date}.', { count: soon.length, days: SOON_DAYS, title: next.d.title, date: fmtDate(next.d.expiresOn) }),
      action: { label: tr('Show them'), run: () => showOnly('soon') }
    });
  }
  if (canManage && noFile.length) insights.push({ tone: 'info', icon: 'doc', text: noFile.length === 1 ? tr('"{title}" has no file kept. Upload one so people can open it.', { title: noFile[0].title }) : tr('{n} documents have no file kept. Upload one so people can open them.', { n: noFile.length }), action: { label: tr('Show them'), run: () => showOnly('nofile') } });
  const undated = inCompany.filter((d) => !d.expiresOn && /licen|permit|certif|insur/i.test(d.category + ' ' + d.title));
  if (canManage && undated.length) insights.push({ tone: 'info', icon: 'calendar', text: undated.length === 1 ? tr('"{title}" looks like it expires but has no date. Add one and the OS will warn before it runs out.', { title: undated[0].title }) : tr('{n} licences, permits or certificates have no expiry date. Add one and the OS will warn before they run out.', { n: undated.length }), action: { label: tr('Edit'), run: () => openEdit(undated[0]) } });
  if (!expired.length && !soon.length && inCompany.some((d) => d.expiresOn)) insights.push({ tone: 'good', icon: 'check', text: tr('Everything with an expiry date is in date for at least {n} days.', { n: SOON_DAYS }) });
  const newest = inCompany.slice().sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)))[0];
  if (newest && (Date.now() - new Date(newest.uploadedAt).getTime()) < 7 * 86400000) insights.push({ tone: 'info', icon: 'spark', text: tr('Newest: "{title}", added by {name}.', { title: newest.title, name: newest.uploaderName }), action: { label: tr('Open it'), run: () => setViewing(newest) } });

  const chips = [
    ['all', tr('All'), inCompany.length],
    ['soon', tr('Expiring soon'), soon.length],
    ['expired', tr('Expired'), expired.length],
    ['dated', tr('Has an expiry date'), withState.filter((x) => x.exp).length],
    canManage && ['mine', tr('Added by me'), mine.length],
    companies.length > 1 && ['group', tr('Whole group'), inCompany.filter((d) => !d.companyId).length],
    canManage && ['nofile', tr('No file'), noFile.length]
  ].filter(Boolean).filter(([k, , n]) => n > 0 || k === 'all' || k === chip);

  const deptChoices = departments.filter((d) => !form.companyId || d.companyId === form.companyId);

  return (
    <div className="dk doc">
      {error && <div className="error-banner" role="alert">{error}</div>}

      {companies.length > 1 && (
        <CompanySwitcher companies={[{ code: 'ALL', name: tr('All companies') }, ...companies]} company={currentCompany ? currentCompany.code : 'ALL'}
          onPick={pickCompany}
          describe={(co) => {
            const n = documents.filter((d) => co.code === 'ALL' || !d.companyId || d.companyId === co.id).length;
            return n === 1 ? tr('1 document') : tr('{n} documents', { n });
          }} />
      )}

      <Hero
        eyebrow={currentCompany ? currentCompany.name : new Date().toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        title={tr('Documents')}
        sub={canManage
          ? tr('Policies, licences, permits, certificates and forms in one place. Give a document an expiry date and the OS warns you before it runs out; when it is renewed, upload the new version. Press a number to show only those.')
          : tr('Policies, licences, certificates and forms you may see. Press a document to open it here.')}
        actions={canManage && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('Add document')}</button>}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      {folders.length > 1 && (
        <Section id="doc-folders" title={tr('Folders')} sub={tr('Documents by category. Press one to show only that folder.')}>
          <div className="doc-folders">
            {folders.map(([name, n]) => {
              const warn = withState.filter((x) => x.d.category === name && x.exp && x.exp.key !== 'ok').length;
              const bad = withState.some((x) => x.d.category === name && x.exp && x.exp.tone === 'bad');
              return (
                <button key={name} type="button" className={'doc-folder' + (category === name ? ' is-on' : '')} onClick={() => { setCategory(category === name ? '' : name); setChip('all'); jump('doc-list'); }}>
                  <svg className="doc-folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true"><path d="M3 7.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
                  <span className="doc-folder-text">
                    <strong>{name}</strong>
                    <span className="dk-muted">{n === 1 ? tr('1 document') : tr('{n} documents', { n })}</span>
                  </span>
                  {warn > 0 && <span className={'doc-folder-warn' + (bad ? ' is-bad' : '')} title={tr('expired or expiring soon')}>{warn}</span>}
                </button>
              );
            })}
          </div>
        </Section>
      )}

      <Section id="doc-list" title={category || tr('All documents')} sub={category ? tr('Only the {name} folder.', { name: category }) : tr('Press a document to open it.')}
        action={category && <button type="button" className="dk-link" onClick={() => setCategory('')}>{tr('Show all folders')}</button>}>
        <div className="doc-tools">
          <div className="doc-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search documents…')} /></div>
          <select className="input doc-select" value={sort} onChange={(e) => setSort(e.target.value)} aria-label={tr('Sort')}>
            <option value="newest">{tr('Newest first')}</option>
            <option value="expiry">{tr('Expiring first')}</option>
            <option value="title">{tr('Title A–Z')}</option>
          </select>
        </div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, n]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
              {label} <span className="ppl-chip-n">{n}</span>
            </button>
          ))}
        </div>

        {visible.length ? (
          <ul className="doc-list">
            {visible.map(({ d, exp }) => (
              <li key={d.id} className={'doc-row' + (exp && exp.key !== 'ok' ? ' is-' + exp.tone : '')}>
                <button type="button" className="doc-open" onClick={() => setViewing(d)}>
                  <FileBadge doc={d} />
                  <span className="doc-main">
                    <span className="doc-title">{d.title}</span>
                    <span className="doc-sub dk-muted">
                      {d.category}{d.hasFile ? ' · ' + d.fileName : ' · ' + tr('no file')}{d.size ? ' · ' + fmtSize(d.size) : ''}{d.version > 1 ? ' · v' + d.version : ''}
                    </span>
                  </span>
                </button>
                <span className="doc-tags">
                  {exp && exp.key !== 'ok' && <Status tone={exp.tone}>{exp.text}</Status>}
                  {exp && exp.key === 'ok' && <span className="doc-tag">{exp.text}</span>}
                  {(showCompany || !d.companyId) && companies.length > 1 && <span className="doc-tag">{d.companyCode || tr('Whole group')}</span>}
                  {d.visibility !== 'all' && <span className="doc-tag is-lock">{visibilityText(d)}</span>}
                </span>
                <span className="doc-who">
                  <Photo id={d.uploadedBy} name={d.uploaderName} photo={d.uploaderPhoto} size={26} />
                  <span className="dk-muted">{fmtDate(String(d.updatedAt || d.uploadedAt).slice(0, 10))}</span>
                </span>
                <span className="doc-menu">
                  <RowMenu actions={[
                    { label: tr('Open'), onClick: () => setViewing(d) },
                    d.hasFile && { label: tr('Download'), onClick: () => download(d) },
                    canManage && { label: tr('Edit details'), onClick: () => openEdit(d) },
                    canManage && { label: tr('Upload new version'), onClick: () => openReplace(d) },
                    canManage && { label: tr('Remove'), onClick: () => setDeleteTarget(d), danger: true }
                  ].filter(Boolean)} />
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="dk-empty doc-empty">
            <p>{documents.length ? tr('Nothing matches. Try another search or filter.') : tr('No documents yet.')}</p>
            {(search || category || chip !== 'all') && documents.length > 0 && <button type="button" className="btn btn-secondary" onClick={() => { setSearch(''); setCategory(''); setChip('all'); }}>{tr('Show all')}</button>}
            {canManage && !documents.length && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('Add document')}</button>}
          </div>
        )}
      </Section>

      <Glossary items={[
        [tr('Expiry date'), tr('When a licence, permit, certificate or insurance runs out. Whoever looks after documents is warned 60, 30, 14 and 7 days before.')],
        [tr('Expiring soon'), tr('Runs out within {n} days.', { n: SOON_DAYS })],
        [tr('New version'), tr('The renewed or updated file. It replaces the old one, keeps the same title and place, and can move the expiry date on.')],
        [tr('Whole group'), tr('A document that is not for one company only. It shows under every company.')],
        [tr('Who can see it'), tr('Everyone; one department only; or managers only (people who look after documents or all staff records).')]
      ]} />

      {viewing && (
        <Viewer doc={viewing} canManage={canManage} onClose={() => setViewing(null)} onEdit={() => openEdit(viewing)} onReplace={() => openReplace(viewing)} />
      )}

      {dialog && (
        <div className="dialog-backdrop" onClick={() => !saving && setDialog(null)}>
          <form className="dialog doc-dialog" onClick={(e) => e.stopPropagation()} onSubmit={save}>
            <h2>{dialog.mode === 'new' ? tr('Add document') : tr('Edit document')}</h2>
            {dialog.mode === 'new' && <DropZone file={file} onFile={pickFile} />}
            <div className="field">
              <label htmlFor="doc-title">{tr('Title')}</label>
              <input id="doc-title" className="input" value={form.title} maxLength={100} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
            </div>
            <div className="doc-form-grid">
              <div className="field">
                <label htmlFor="doc-category">{tr('Category (folder)')}</label>
                <input id="doc-category" className="input" list="doc-categories" value={form.category} maxLength={40} onChange={(e) => setForm({ ...form, category: e.target.value })} required placeholder={tr('e.g. Licence')} />
                <datalist id="doc-categories">{categoryNames.map((c) => <option key={c} value={c} />)}</datalist>
              </div>
              <div className="field">
                <label htmlFor="doc-expires">{tr('Expires on (optional)')}</label>
                <input id="doc-expires" className="input" type="date" value={form.expiresOn} onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="doc-desc">{tr('Notes (optional)')}</label>
              <textarea id="doc-desc" className="input doc-textarea" value={form.description} maxLength={500} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder={tr('What it covers, a reference number, who to call to renew it…')} />
            </div>
            <div className="doc-form-grid">
              {companies.length > 1 && (
                <div className="field">
                  <label htmlFor="doc-company">{tr('Company')}</label>
                  <select id="doc-company" className="input" value={form.companyId} onChange={(e) => setForm({ ...form, companyId: e.target.value, departmentId: '' })}>
                    <option value="">{tr('Whole group')}</option>
                    {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              )}
              <div className="field">
                <label htmlFor="doc-vis">{tr('Who can see it')}</label>
                <select id="doc-vis" className="input" value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })}>
                  <option value="all">{tr('Everyone')}</option>
                  <option value="department">{tr('One department only')}</option>
                  <option value="managers">{tr('Managers only')}</option>
                </select>
              </div>
              {form.visibility === 'department' && (
                <div className="field">
                  <label htmlFor="doc-dept">{tr('Department')}</label>
                  <select id="doc-dept" className="input" value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })}>
                    <option value="">{tr('My department')}</option>
                    {deptChoices.map((d) => <option key={d.id} value={d.id}>{form.companyId || companies.length < 2 ? d.name : d.name + ' — ' + d.companyName}</option>)}
                  </select>
                </div>
              )}
            </div>
            {saving && dialog.mode === 'new' && <div className="doc-progress" aria-hidden="true"><span style={{ width: Math.round(progress * 100) + '%' }} /></div>}
            {formError && <div className="error-banner">{formError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : dialog.mode === 'new' ? tr('Upload') : tr('Save changes')}</button>
            </div>
          </form>
        </div>
      )}

      {replacing && (
        <div className="dialog-backdrop" onClick={() => !saving && setReplacing(null)}>
          <form className="dialog doc-dialog" onClick={(e) => e.stopPropagation()} onSubmit={saveReplace}>
            <h2>{tr('Upload new version')}</h2>
            <p className="dk-muted doc-small">
              {tr('"{title}" is on version {n}. The new file replaces the current one ({file}); the title, folder and who can see it stay the same.', { title: replacing.doc.title, n: replacing.doc.version || 1, file: replacing.doc.fileName || tr('no file') })}
            </p>
            <DropZone file={replacing.file} onFile={(f) => setReplacing({ ...replacing, file: f })} />
            <div className="field">
              <label htmlFor="doc-new-expiry">{tr('New expiry date (optional)')}</label>
              <input id="doc-new-expiry" className="input" type="date" value={replacing.expiresOn} onChange={(e) => setReplacing({ ...replacing, expiresOn: e.target.value })} />
              <span className="dk-muted doc-small">{replacing.doc.expiresOn ? tr('Now {date}. Leave blank to keep it.', { date: fmtDate(replacing.doc.expiresOn) }) : tr('Leave blank if it does not expire.')}</span>
            </div>
            {saving && <div className="doc-progress" aria-hidden="true"><span style={{ width: Math.round(progress * 100) + '%' }} /></div>}
            {formError && <div className="error-banner">{formError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setReplacing(null)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Uploading…') : tr('Upload')}</button>
            </div>
          </form>
        </div>
      )}

      {deleteTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Remove document')}</h2>
            <p className="dialog-body">{tr('Remove')} <strong>{deleteTarget.title}</strong>{tr('? The file is deleted too. This cannot be undone.')}</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" onClick={confirmDelete}>{tr('Remove')}</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
