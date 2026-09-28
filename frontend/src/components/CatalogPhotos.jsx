import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useBlobUrl } from './Photo';
import { shrinkPhoto, uploadWithProgress } from '../lib/chatMedia';
import { tr } from '../lib/i18n.jsx';
import './CatalogPhotos.css';

// Photos of a Products & Services item (catalog.service.js): several per
// item, the first is the cover, and one can be tagged to a variation so the
// quotation / invoice pickers show that variation its own photo. They sit
// behind sign-in, so each is fetched with the token (components/Photo.jsx).

const MAX_PHOTOS = 12;
function photoPath(id) { return '/catalog/photos/' + id; }

export function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 8.5h3l1.6-2.5h6.8L17 8.5h3v10H4z" /><circle cx="12" cy="13" r="3.4" />
    </svg>
  );
}

// One photo, filling its box (fit: 'cover' crops, 'contain' shows it whole).
export function CatalogImage({ id, version, alt = '', fit = 'cover', className = '' }) {
  const url = useBlobUrl(id ? photoPath(id) : null, version || id);
  return (
    <span className={'ctp-img ' + className}>
      {url ? <img src={url} alt={alt} style={{ objectFit: fit }} /> : <span className="ctp-img-wait" aria-hidden="true"><CameraIcon /></span>}
    </span>
  );
}

// Choose photos, shrink the big ones, and send them together.
function useAddPhotos(itemId, onPhotos) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  async function add(fileList) {
    const files = Array.from(fileList || []).filter((f) => /^image\//.test(f.type) || /\.(heic|heif)$/i.test(f.name));
    if (!files.length) return;
    setBusy(true); setError(null); setProgress(0);
    try {
      const fd = new FormData();
      for (const f of files) fd.append('photos', await shrinkPhoto(f));
      onPhotos(await uploadWithProgress('/catalog/items/' + itemId + '/photos', fd, setProgress));
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return { add, busy, progress, error, setError };
}

export function ItemGallery({ item, canManage, onPhotos }) {
  const photos = item.photos || [];
  const [sel, setSel] = useState(0);
  const [full, setFull] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [saving, setSaving] = useState(false);
  const [caption, setCaption] = useState('');
  const inputRef = useRef(null);
  const upload = useAddPhotos(item.id, (list) => { onPhotos(list); setSel(list.length - 1); });
  const cur = photos[Math.min(sel, photos.length - 1)] || null;
  const error = upload.error;

  useEffect(() => { setCaption(cur ? cur.caption : ''); setConfirmRemove(false); }, [cur && cur.id, cur && cur.caption]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!full) return undefined;
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); setFull(false); } }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [full]);

  async function run(fn) {
    setSaving(true); upload.setError(null);
    try { const list = await fn(); onPhotos(list); return list; } catch (err) { upload.setError(err.message); return null; } finally { setSaving(false); }
  }
  const makeCover = () => run(() => api.post(photoPath(cur.id) + '/cover')).then((l) => { if (l) setSel(0); });
  const remove = () => run(() => api.del(photoPath(cur.id))).then((l) => { if (l) setSel((s) => Math.max(0, Math.min(s, l.length - 1))); });
  const tag = (variationId) => run(() => api.put(photoPath(cur.id), { variationId: variationId || null }));
  const saveCaption = () => { if (cur && caption.trim() !== cur.caption) run(() => api.put(photoPath(cur.id), { caption })); };
  const varName = (id) => { const v = item.variations.find((x) => x.id === id); return v ? (v.name && v.name !== 'Regular' ? v.name : tr('Regular')) : ''; };
  const picker = (
    <input ref={inputRef} type="file" accept="image/*" multiple hidden onChange={(e) => { upload.add(e.target.files); e.target.value = ''; }} />
  );

  if (!photos.length) {
    return (
      <div className="ctp-empty">
        <span className="ctp-empty-icon"><CameraIcon /></span>
        <div>
          <strong>{tr('No photos yet')}</strong>
          <p className="dk-muted tl-small">{canManage
            ? tr('Add photos of the item so everyone can see what it looks like when they quote it. You can add several at once.')
            : tr('Nobody has added a photo of this item yet.')}</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
        </div>
        {canManage && (
          <button type="button" className="btn btn-primary tl-btn" disabled={upload.busy} onClick={() => inputRef.current.click()}>
            {upload.busy ? tr('Uploading… {pct}%', { pct: Math.round(upload.progress * 100) }) : tr('Add photos')}
          </button>
        )}
        {picker}
      </div>
    );
  }

  return (
    <div className="ctp">
      {error && <div className="error-banner" role="alert">{error}</div>}
      <button type="button" className="ctp-main" onClick={() => setFull(true)} aria-label={tr('Show this photo full size')}>
        <CatalogImage id={cur.id} fit="contain" alt={cur.caption || item.name} />
        {sel === 0 && photos.length > 1 && <span className="ctp-badge">{tr('Cover')}</span>}
        {cur.variationId && <span className="ctp-badge ctp-badge-var">{varName(cur.variationId)}</span>}
      </button>
      {cur.caption && !canManage && <p className="ctp-caption">{cur.caption}</p>}
      <div className="ctp-strip" role="listbox" aria-label={tr('Photos')}>
        {photos.map((p, i) => (
          <button key={p.id} type="button" role="option" aria-selected={p.id === cur.id} className={'ctp-thumb' + (p.id === cur.id ? ' is-on' : '')} onClick={() => setSel(i)} aria-label={tr('Photo {n} of {total}', { n: i + 1, total: photos.length })}>
            <CatalogImage id={p.id} />
          </button>
        ))}
        {canManage && photos.length < MAX_PHOTOS && (
          <button type="button" className="ctp-thumb ctp-add" disabled={upload.busy} onClick={() => inputRef.current.click()}>
            {upload.busy ? <span className="tl-small">{Math.round(upload.progress * 100)}%</span> : <><CameraIcon /><span className="tl-small">{tr('Add')}</span></>}
          </button>
        )}
      </div>
      {canManage && (
        <div className="ctp-edit">
          <label className="ctp-field">
            <span className="dk-muted tl-small">{tr('This photo shows')}</span>
            <select className="input" value={cur.variationId || ''} disabled={saving} onChange={(e) => tag(e.target.value)}>
              <option value="">{tr('The whole item')}</option>
              {item.variations.map((v) => <option key={v.id} value={v.id}>{v.name && v.name !== 'Regular' ? v.name : tr('Regular')}</option>)}
            </select>
          </label>
          <label className="ctp-field ctp-field-wide">
            <span className="dk-muted tl-small">{tr('Caption (optional)')}</span>
            <input className="input" value={caption} maxLength={200} placeholder={tr('e.g. Finished in dark stain')} disabled={saving}
              onChange={(e) => setCaption(e.target.value)} onBlur={saveCaption} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} />
          </label>
          <div className="ctp-edit-actions">
            {sel !== 0 && <button type="button" className="btn btn-secondary tl-btn" disabled={saving} onClick={makeCover}>{tr('Make it the cover')}</button>}
            {confirmRemove ? (
              <>
                <button type="button" className="btn btn-danger tl-btn" disabled={saving} onClick={remove}>{tr('Yes, remove it')}</button>
                <button type="button" className="btn btn-secondary tl-btn" onClick={() => setConfirmRemove(false)}>{tr('Keep it')}</button>
              </>
            ) : <button type="button" className="btn btn-secondary tl-btn" onClick={() => setConfirmRemove(true)}>{tr('Remove photo')}</button>}
          </div>
        </div>
      )}
      <p className="dk-muted tl-small ctp-note">{canManage
        ? tr('The first photo is the cover, shown on the item\'s card. A photo marked for one variation is the one quotations and invoices show for it.')
        : tr('{n} photos. Press one to see it full size.', { n: photos.length })}</p>
      {picker}
      {full && (
        <div className="ctp-full" role="dialog" aria-modal="true" aria-label={item.name} onClick={() => setFull(false)}>
          <CatalogImage id={cur.id} fit="contain" alt={cur.caption || item.name} />
          {cur.caption && <p className="ctp-full-caption">{cur.caption}</p>}
          <button type="button" className="ctp-full-close" onClick={() => setFull(false)} aria-label={tr('Close')}>×</button>
          {photos.length > 1 && (
            <>
              <button type="button" className="ctp-full-nav is-prev" aria-label={tr('Previous photo')} onClick={(e) => { e.stopPropagation(); setSel((sel - 1 + photos.length) % photos.length); }}>‹</button>
              <button type="button" className="ctp-full-nav is-next" aria-label={tr('Next photo')} onClick={(e) => { e.stopPropagation(); setSel((sel + 1) % photos.length); }}>›</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
