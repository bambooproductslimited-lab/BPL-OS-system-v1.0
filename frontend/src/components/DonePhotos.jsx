import { useRef, useState } from 'react';
import { useBlobUrl } from './Photo';
import { shrinkPhoto } from '../pages/till/photoShrink';
import { tr } from '../lib/i18n.jsx';
import './DonePhotos.css';

// Photos of the finished work, for a maintenance & IT job or routine
// (backend maintenanceWorkOrders.service.js): a job is marked done only
// with one. Used by My Jobs (pages/MyJobsPage.jsx) and the work order
// tracker (pages/MaintenanceOrders.jsx).

export const MAX_DONE_PHOTOS = 3;

// Taking them: the camera opens (or the gallery, where the phone offers
// it); each is made small on the phone before it is sent. value is the
// list of JPEG data URLs taken so far.
export function DonePhotoField({ value, onChange, disabled }) {
  const input = useRef(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function take(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    if (!/^image\//.test(file.type)) { setError(tr('That file is not a photo.')); return; }
    setBusy(true);
    try { const url = await shrinkPhoto(file, 1280); onChange(value.concat([url]).slice(0, MAX_DONE_PHOTOS)); } catch { setError(tr('That photo could not be read. Take it again.')); }
    setBusy(false);
  }
  const full = value.length >= MAX_DONE_PHOTOS;
  return (
    <div className="dp-field">
      <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={take} />
      {value.length > 0 && (
        <ul className="dp-thumbs">
          {value.map((src, i) => (
            <li key={i}>
              <img src={src} alt={tr('Photo {n} of the finished work', { n: i + 1 })} />
              <button type="button" className="dp-x" disabled={disabled} aria-label={tr('Take photo {n} out', { n: i + 1 })} onClick={() => onChange(value.filter((_, k) => k !== i))}>×</button>
            </li>
          ))}
        </ul>
      )}
      {!full && (
        <button type="button" className={'dp-take' + (value.length ? ' is-more' : '')} disabled={disabled || busy} onClick={() => input.current && input.current.click()}>
          <span aria-hidden="true">📷</span>
          {busy ? tr('Getting the photo ready…') : value.length ? tr('Add another photo') : tr('Take a photo of the finished work')}
        </button>
      )}
      {!value.length && <p className="dp-need">{tr('A photo is required before the job can be marked done.')}</p>}
      {error && <p className="dp-error" role="alert">{error}</p>}
    </div>
  );
}

function Shot({ path, token, label, onOpen }) {
  const url = useBlobUrl(path, undefined, token);
  return (
    <button type="button" className="dp-shot" onClick={() => url && onOpen(url)} aria-label={label}>
      {url ? <img src={url} alt="" /> : <span className="dp-shot-wait" aria-hidden="true">📷</span>}
    </button>
  );
}

// Showing them: thumbnails; a tap shows one full size. paths are the API
// paths of the photos (behind sign-in); token, a kiosk-code sign-in's.
export function DonePhotoStrip({ paths, token }) {
  const [big, setBig] = useState(null);
  if (!paths || !paths.length) return null;
  return (
    <div className="dp-strip">
      {paths.map((p, i) => <Shot key={p} path={p} token={token} label={tr('Photo {n} of the finished work', { n: i + 1 })} onOpen={setBig} />)}
      {big && (
        <div className="dp-big" role="dialog" aria-modal="true" aria-label={tr('Photo of the finished work')} onClick={() => setBig(null)}>
          <img src={big} alt={tr('Photo of the finished work')} />
          <button type="button" className="dp-big-x" onClick={() => setBig(null)}>{tr('Close')}</button>
        </div>
      )}
    </div>
  );
}
