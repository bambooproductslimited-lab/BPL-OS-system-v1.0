import { useRef, useState } from 'react';
import { useBlobUrl } from './Photo';
import { shrinkPhoto } from '../pages/till/photoShrink';
import { tr } from '../lib/i18n.jsx';
import './DonePhotos.css';

// Photos of the finished work, for a maintenance & IT job or routine
// (backend maintenanceWorkOrders.service.js): a job is marked done only
// with one. Used by My Jobs (pages/MyJobsPage.jsx) and the work order
// tracker (pages/MaintenanceOrders.jsx). The same field and strip take and
// show the photos added with a new job (the problem) or routine (what it
// looks after): optional there, from the camera or the phone's photos.

export const MAX_DONE_PHOTOS = 3;

// Taking them: the camera opens (or the gallery, where the phone offers
// it); each is made small on the phone before it is sent. value is the
// list of JPEG data URLs taken so far.
// For a new job or routine: max, the most there may be; camera false lets
// the phone offer its photos too (several at once); required false drops
// the "required" line; takeLabel and altFor, the words.
export function DonePhotoField({ value, onChange, disabled, max = MAX_DONE_PHOTOS, camera = true, required = true, takeLabel, altFor }) {
  const input = useRef(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function take(e) {
    const files = Array.from(e.target.files || []).slice(0, Math.max(0, max - value.length));
    e.target.value = '';
    if (!files.length) return;
    setError(null);
    if (files.some((f) => !/^image\//.test(f.type))) { setError(tr('That file is not a photo.')); return; }
    setBusy(true);
    try {
      const urls = [];
      for (const f of files) urls.push(await shrinkPhoto(f, 1280));
      onChange(value.concat(urls).slice(0, max));
    } catch { setError(tr('That photo could not be read. Take it again.')); }
    setBusy(false);
  }
  const full = value.length >= max;
  const alt = (i) => (altFor ? altFor(i + 1) : tr('Photo {n} of the finished work', { n: i + 1 }));
  return (
    <div className="dp-field">
      <input ref={input} type="file" accept="image/*" capture={camera ? 'environment' : undefined} multiple={!camera} hidden onChange={take} />
      {value.length > 0 && (
        <ul className="dp-thumbs">
          {value.map((src, i) => (
            <li key={i}>
              <img src={src} alt={alt(i)} />
              <button type="button" className="dp-x" disabled={disabled} aria-label={tr('Take photo {n} out', { n: i + 1 })} onClick={() => onChange(value.filter((_, k) => k !== i))}>×</button>
            </li>
          ))}
        </ul>
      )}
      {!full && (
        <button type="button" className={'dp-take' + (value.length ? ' is-more' : '')} disabled={disabled || busy} onClick={() => input.current && input.current.click()}>
          <span aria-hidden="true">📷</span>
          {busy ? tr('Getting the photo ready…') : value.length ? tr('Add another photo') : takeLabel || tr('Take a photo of the finished work')}
        </button>
      )}
      {!value.length && required && <p className="dp-need">{tr('A photo is required before the job can be marked done.')}</p>}
      {error && <p className="dp-error" role="alert">{error}</p>}
    </div>
  );
}

function Shot({ path, token, label, onOpen, onRemove, removeLabel }) {
  const url = useBlobUrl(path, undefined, token);
  return (
    <span className="dp-shot-wrap">
      <button type="button" className="dp-shot" onClick={() => url && onOpen(url)} aria-label={label}>
        {url ? <img src={url} alt="" /> : <span className="dp-shot-wait" aria-hidden="true">📷</span>}
      </button>
      {onRemove && <button type="button" className="dp-x" onClick={onRemove} aria-label={removeLabel}>×</button>}
    </span>
  );
}

// Showing them: thumbnails; a tap shows one full size. paths are the API
// paths of the photos (behind sign-in); token, a kiosk-code sign-in's.
// altFor(n), the words for photo n; onRemove(i), a × on each to take it out.
export function DonePhotoStrip({ paths, token, altFor, onRemove }) {
  const [big, setBig] = useState(null);
  if (!paths || !paths.length) return null;
  const label = (n) => (altFor ? altFor(n) : tr('Photo {n} of the finished work', { n }));
  return (
    <div className="dp-strip">
      {paths.map((p, i) => <Shot key={p} path={p} token={token} label={label(i + 1)} onOpen={setBig}
        onRemove={onRemove ? () => onRemove(i) : null} removeLabel={tr('Take photo {n} out', { n: i + 1 })} />)}
      {big && (
        <div className="dp-big" role="dialog" aria-modal="true" aria-label={altFor ? tr('Photo') : tr('Photo of the finished work')} onClick={() => setBig(null)}>
          <img src={big} alt={altFor ? tr('Photo') : tr('Photo of the finished work')} />
          <button type="button" className="dp-big-x" onClick={() => setBig(null)}>{tr('Close')}</button>
        </div>
      )}
    </div>
  );
}
