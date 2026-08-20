import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import './EmployeeIdDocsDialog.css';

// Three fixed ID/passport document slots on an employee record — front of
// ID, back of ID, passport scan. Opened from a row action on the Employee
// directory. Same real-upload/signed-download pattern as the Documents
// module (backend/src/services/employeeDocuments.service.js).

const SLOT_LABELS = { id_front: 'ID — front', id_back: 'ID — back', passport: 'Passport' };

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function EmployeeIdDocsDialog({ employee, onClose }) {
  const [slots, setSlots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [uploadingKind, setUploadingKind] = useState(null);
  const [downloadingKind, setDownloadingKind] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSlots(await api.get('/employees/' + employee.id + '/id-documents'));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [employee.id]);

  useEffect(() => { load(); }, [load]);

  async function handleFile(kind, file) {
    if (!file) return;
    setUploadingKind(kind);
    setError(null);
    try {
      const body = new FormData();
      body.append('file', file);
      setSlots(await api.upload('/employees/' + employee.id + '/id-documents/' + kind, body));
    } catch (err) {
      setError(err.message);
    } finally {
      setUploadingKind(null);
    }
  }

  async function handleDownload(kind) {
    setDownloadingKind(kind);
    setError(null);
    try {
      const { url } = await api.get('/employees/' + employee.id + '/id-documents/' + kind + '/download');
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      setError(err.message);
    } finally {
      setDownloadingKind(null);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog id-docs-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>ID documents — {employee.firstName} {employee.lastName}</h2>
        {error && <div className="error-banner">{error}</div>}

        {loading ? (
          <div className="eyebrow">Loading…</div>
        ) : (
          <div className="id-docs-list">
            {slots.map((s) => (
              <div className="id-docs-row" key={s.kind}>
                <div className="id-docs-row-main">
                  <div className="id-docs-row-label">{SLOT_LABELS[s.kind]}</div>
                  {s.fileName ? (
                    <div className="id-docs-row-file">{s.fileName} <span className="id-docs-row-date">uploaded {fmtDate(s.uploadedAt)}</span></div>
                  ) : (
                    <div className="id-docs-row-empty">Not uploaded</div>
                  )}
                </div>
                <div className="id-docs-row-actions">
                  {s.fileName && (
                    <button type="button" className="btn btn-secondary id-docs-btn" disabled={downloadingKind === s.kind} onClick={() => handleDownload(s.kind)}>
                      {downloadingKind === s.kind ? 'Preparing…' : 'Download'}
                    </button>
                  )}
                  <label className="btn btn-secondary id-docs-btn id-docs-upload-btn">
                    {uploadingKind === s.kind ? 'Uploading…' : (s.fileName ? 'Replace' : 'Upload')}
                    <input
                      type="file"
                      accept="image/*,application/pdf"
                      disabled={uploadingKind === s.kind}
                      onChange={(e) => { handleFile(s.kind, e.target.files[0]); e.target.value = ''; }}
                    />
                  </label>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
