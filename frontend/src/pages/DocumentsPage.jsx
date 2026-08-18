import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import './DocumentsPage.css';

// Ported from Bamboo OS.dc.html's documents screen (screens.documents
// block + the "Add document" dialog around its render()). This records
// metadata only — file storage isn't wired up, matching the prototype's
// own note in the upload dialog and the backend's known gaps.

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const EMPTY_FORM = { title: '', category: '', fileName: '', visibility: 'all' };

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
  const [dialogError, setDialogError] = useState(null);
  const [uploading, setUploading] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

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
    setDialogOpen(true);
  }

  async function handleUpload(e) {
    e.preventDefault();
    setUploading(true);
    setDialogError(null);
    try {
      await api.post('/documents', form);
      setToast('Document added.');
      setDialogOpen(false);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setUploading(false);
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

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      {canManage && (
        <div className="documents-toolbar">
          <button type="button" className="btn btn-primary" onClick={openNew}>Add document</button>
        </div>
      )}

      <table className="table">
        <thead>
          <tr><th>Title</th><th>Category</th><th>File</th><th>Visibility</th><th>Uploaded</th><th>By</th><th /></tr>
        </thead>
        <tbody>
          {documents.map((dc) => (
            <tr key={dc.id}>
              <td style={{ fontWeight: 600 }}>{dc.title}</td>
              <td>{dc.category}</td>
              <td className="documents-filename">{dc.fileName}</td>
              <td><span className="tag tag-neutral">{visLabel(dc)}</span></td>
              <td>{fmtDate((dc.uploadedAt || '').slice(0, 10))}</td>
              <td>{dc.uploaderName}</td>
              <td className="table-actions">
                {canManage && <button type="button" className="btn btn-secondary documents-row-btn" onClick={() => setDeleteTarget(dc)}>Remove</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!documents.length && <p className="table-empty">No documents visible to your role.</p>}

      {dialogOpen && (
        <div className="dialog-backdrop" onClick={() => setDialogOpen(false)}>
          <form className="dialog documents-dialog" onClick={(e) => e.stopPropagation()} onSubmit={handleUpload}>
            <h2>Add document</h2>
            <p className="documents-dialog-note">This records document metadata only — file storage is not wired up in this prototype.</p>
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
              <label htmlFor="doc-filename">File name</label>
              <input id="doc-filename" className="input" value={form.fileName} onChange={(e) => setForm({ ...form, fileName: e.target.value })} placeholder="filename.pdf" required />
            </div>
            <div className="field">
              <label htmlFor="doc-visibility">Visibility</label>
              <select id="doc-visibility" className="input" value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })}>
                <option value="all">All staff</option>
                <option value="department">My department only</option>
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
