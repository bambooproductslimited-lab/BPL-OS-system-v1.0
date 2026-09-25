import { useRef, useState } from 'react';
import { api } from '../api/client';
import Photo, { forgetBlob } from './Photo';
import { squarePhoto, uploadWithProgress } from '../lib/chatMedia';
import { tr } from '../lib/i18n.jsx';
import './PhotoDialog.css';

// Choose / remove a square photo for a person or a group.
export default function PhotoDialog({ title, kind, id, name, photo, uploadPath, onDone, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  async function choose(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const sq = await squarePhoto(file);
      const fd = new FormData(); fd.append('photo', sq);
      const r = await uploadWithProgress(uploadPath, fd);
      forgetBlob(uploadPath);
      onDone(r.photo);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true); setError(null);
    try { await api.del(uploadPath); forgetBlob(uploadPath); onDone(null); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog photo-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <div className="photo-dialog-preview"><Photo kind={kind} id={id} name={name} photo={photo} size={140} /></div>
        {error && <div className="error-banner">{error}</div>}
        <p className="photo-dialog-note">{tr('The photo is cropped to a square. Everyone in the OS can see profile photos; a group photo is seen by its members.')}</p>
        <input ref={inputRef} type="file" accept="image/*" hidden onChange={choose} />
        <div className="dialog-actions">
          {photo && <button type="button" className="btn btn-secondary" disabled={busy} onClick={remove}>{tr('Remove photo')}</button>}
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => inputRef.current.click()}>{busy ? tr('Saving…') : photo ? tr('Choose a new photo') : tr('Choose a photo')}</button>
        </div>
      </div>
    </div>
  );
}
