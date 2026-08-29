import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { toPreviewUrl } from '../lib/previewUrl';
import './DocumentsPage.css';

// Ported from Bamboo OS.dc.html's documents screen (screens.documents
// block + the "Add document" dialog around its render()), extended with
// real file upload/preview against Cloudflare R2 (see
// backend/src/lib/storage.js) — the prototype's version recorded metadata
// only. Files open in a new tab for viewing, never as a download (the
// signed URL is served with Content-Disposition: inline). Documents
// created before storage was wired up have no file
// (hasFile: false) and show a plain, non-clickable filename.
//
// Redesigned around the icon/avatar language established elsewhere:
// file-type icons color-coded by extension (a classic document-library
// pattern — PDF/Word/Excel/image read differently at a glance), an
// uploader avatar, and an icon'd empty state.

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const AVATAR_COLORS = ['#3f7d3b', '#2f5f2c', '#7d5c3f', '#3f5a7d', '#7d3f5c', '#5c3f7d', '#7d6b3f', '#3f7d6b'];
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return ((parts[0] ? parts[0][0] : '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function avatarColor(name) { return AVATAR_COLORS[hashStr(name || '') % AVATAR_COLORS.length]; }

const ICON_PATHS = {
  doc: <><rect x="5" y="3.5" width="14" height="17" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>,
  sheet: <><rect x="5" y="3.5" width="14" height="17" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><path d="M5 9.5h14M10.5 9.5v11" stroke="currentColor" strokeWidth="1.6" /></>,
  image: <><rect x="4" y="4.5" width="16" height="15" rx="1.5" stroke="currentColor" strokeWidth="1.6" /><circle cx="9" cy="10" r="1.6" stroke="currentColor" strokeWidth="1.5" /><path d="M5 16.5l4-4 3 3 3.5-4L20 16" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></>,
  folder: <><circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.6" /><path d="M2.5 19c0-3.6 2.5-6 5.5-6s5.5 2.4 5.5 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><circle cx="16.5" cy="9" r="2.3" stroke="currentColor" strokeWidth="1.6" /><path d="M14.8 13.3c2.6.4 4.7 2.5 4.7 5.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>
};
function Icon({ name }) { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">{ICON_PATHS[name]}</svg>; }

const EXT_KIND = {
  pdf: { icon: 'doc', tone: 'danger' },
  doc: { icon: 'doc', tone: 'ops' }, docx: { icon: 'doc', tone: 'ops' },
  xls: { icon: 'sheet', tone: 'people' }, xlsx: { icon: 'sheet', tone: 'people' }, csv: { icon: 'sheet', tone: 'people' },
  ppt: { icon: 'doc', tone: 'warning' }, pptx: { icon: 'doc', tone: 'warning' },
  png: { icon: 'image', tone: 'finance' }, jpg: { icon: 'image', tone: 'finance' }, jpeg: { icon: 'image', tone: 'finance' }, gif: { icon: 'image', tone: 'finance' }, webp: { icon: 'image', tone: 'finance' }, svg: { icon: 'image', tone: 'finance' }
};
function fileKind(fileName) {
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  return EXT_KIND[ext] || { icon: 'doc', tone: 'muted' };
}

const EMPTY_FORM = { title: '', category: '', visibility: 'all' };

export default function DocumentsPage() {
  const { can } = useAuth();
  const canManage = can('document.manage');

  const [documents, setDocuments] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [file, setFile] = useState(null);
  const [dialogError, setDialogError] = useState(null);
  const [uploading, setUploading] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [downloadingId, setDownloadingId] = useState(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [rows, depts] = await Promise.all([api.get('/documents'), api.get('/departments')]);
      setDocuments(rows);
      setDepartments(depts);
    } catch (err) {
      setError(err.message);
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

  function deptName(id) {
    const d = departments.find((x) => x.id === id);
    return d ? d.name : '—';
  }

  function visLabel(doc) {
    if (doc.visibility === 'all') return 'All staff';
    if (doc.visibility === 'managers') return 'Managers';
    return deptName(doc.departmentId);
  }

  function openNew() {
    setDialogError(null);
    setForm(EMPTY_FORM);
    setFile(null);
    setDialogOpen(true);
  }

  async function handleUpload(e) {
    e.preventDefault();
    if (!file) { setDialogError('Choose a file to upload.'); return; }
    setUploading(true);
    setDialogError(null);
    try {
      const body = new FormData();
      body.append('title', form.title);
      body.append('category', form.category);
      body.append('visibility', form.visibility);
      body.append('file', file);
      await api.upload('/documents', body);
      setToast('Document added.');
      setDialogOpen(false);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function handlePreview(doc) {
    setDownloadingId(doc.id);
    setError(null);
    try {
      const { url } = await api.get('/documents/' + doc.id + '/download');
      window.open(toPreviewUrl(url, doc.fileName), '_blank', 'noopener');
    } catch (err) {
      setError(err.message);
    } finally {
      setDownloadingId(null);
    }
  }

  async function confirmDelete() {
    setDeleting(true);
    try {
      await api.del('/documents/' + deleteTarget.id);
      setToast('Document removed.');
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const visibleDocuments = documents.filter((dc) => matchesQuery(search, dc.title, dc.category, dc.fileName, dc.uploaderName));

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="documents-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search documents…" />
        {canManage && <button type="button" className="btn btn-primary" onClick={openNew}>Add document</button>}
      </div>

      <table className="table">
        <thead>
          <tr><th>Title</th><th>Category</th><th>File</th><th>Visibility</th><th>Uploaded</th><th>By</th><th /></tr>
        </thead>
        <tbody>
          {visibleDocuments.map((dc) => {
            const kind = fileKind(dc.fileName);
            return (
              <tr key={dc.id}>
                <td style={{ fontWeight: 600 }}>{dc.title}</td>
                <td>{dc.category}</td>
                <td className="documents-filename">
                  <div className="documents-file-cell">
                    <span className={'documents-file-icon documents-file-icon-' + kind.tone}><Icon name={kind.icon} /></span>
                    {dc.hasFile ? (
                      <button type="button" className="link-button" disabled={downloadingId === dc.id} onClick={() => handlePreview(dc)}>
                        {downloadingId === dc.id ? 'Preparing…' : dc.fileName}
                      </button>
                    ) : (
                      <span title="Uploaded before file storage was set up — no file on record.">{dc.fileName}</span>
                    )}
                  </div>
                </td>
                <td><span className="tag tag-neutral">{visLabel(dc)}</span></td>
                <td>{fmtDate((dc.uploadedAt || '').slice(0, 10))}</td>
                <td>
                  <div className="documents-uploader-cell">
                    <span className="documents-uploader-avatar" style={{ background: avatarColor(dc.uploaderName) }}>{initials(dc.uploaderName)}</span>
                    {dc.uploaderName}
                  </div>
                </td>
                <td className="table-actions">
                  {canManage && <button type="button" className="btn btn-secondary documents-row-btn" onClick={() => setDeleteTarget(dc)}>Remove</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!documents.length && (
        <div className="documents-empty-state">
          <span className="documents-empty-icon"><Icon name="folder" /></span>
          <p className="documents-empty-title">No documents visible to your role</p>
        </div>
      )}
      {!!documents.length && !visibleDocuments.length && (
        <div className="documents-empty-state">
          <span className="documents-empty-icon"><Icon name="folder" /></span>
          <p className="documents-empty-title">No documents match "{search}"</p>
        </div>
      )}

      {dialogOpen && (
        <div className="dialog-backdrop" onClick={() => setDialogOpen(false)}>
          <form className="dialog documents-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleUpload}>
            <h2>Add document</h2>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="field">
              <label htmlFor="doc-title">Title</label>
              <input id="doc-title" className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="doc-category">Category</label>
              <input id="doc-category" className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Policy, Production, HR…" required />
            </div>
            <div className="field">
              <label htmlFor="doc-file">File</label>
              <input id="doc-file" className="input" type="file" onChange={(e) => setFile(e.target.files[0] || null)} required />
            </div>
            <div className="field">
              <label htmlFor="doc-visibility">Visibility</label>
              <select id="doc-visibility" className="input" value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })}>
                <option value="all">All staff</option>
                <option value="department">My group only</option>
                <option value="managers">Managers only</option>
              </select>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={uploading}>{uploading ? 'Adding…' : 'Add document'}</button>
            </div>
          </form>
        </div>
      )}

      {deleteTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Remove document</h2>
            <p className="dialog-body">Remove <strong>{deleteTarget.title}</strong>? This cannot be undone.</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={confirmDelete}>{deleting ? 'Removing…' : 'Remove'}</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
