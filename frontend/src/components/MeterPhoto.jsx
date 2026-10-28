import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';
import { useBlobUrl, forgetBlob } from './Photo';
import { shrinkPhoto } from '../pages/till/photoShrink';
import { tr, activeIntlLocale } from '../lib/i18n.jsx';

// Photos of the water and electricity meters with their readings (property
// billing): the figure the tenant is billed for, as the meter showed it.
// Taken with the phone's camera (or picked from the gallery), made small
// before it is sent, and kept behind sign-in.

const photoPath = (r) => '/poki/readings/' + r.id + '/photo';

async function pickPhoto(file) {
  if (!file) return null;
  if (!/^image\//.test(file.type)) throw new Error(tr('That file is not a photo.'));
  return shrinkPhoto(file, 1600);
}

// In the "Record meter reading" dialog: tap to take the photo; it shows
// before the reading is saved, and can be taken again or left out.
export function MeterPhotoField({ value, onChange }) {
  const input = useRef(null);
  const [error, setError] = useState(null);
  async function take(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    setError(null);
    try { const url = await pickPhoto(file); if (url) onChange(url); } catch (err) { setError(err.message); }
  }
  return (
    <div className="mtr-field">
      <input ref={input} type="file" accept="image/*" capture="environment" onChange={take} hidden aria-hidden="true" tabIndex={-1} />
      {value ? (
        <div className="mtr-preview">
          <img src={value} alt={tr('The meter')} />
          <span className="mtr-preview-acts">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => input.current.click()}>📷 {tr('Take it again')}</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => onChange(null)}>{tr('Leave it out')}</button>
          </span>
        </div>
      ) : (
        <button type="button" className="mtr-take" onClick={() => input.current.click()}>
          <span aria-hidden="true">📷</span>
          <b>{tr('Photo of the meter')}</b>
          <small>{tr('Take it so the figure can be read: the proof of what the tenant is billed.')}</small>
        </button>
      )}
      {error && <p className="mtr-error" role="alert">{error}</p>}
    </div>
  );
}

// A reading's photo, small, in a list or on a meter's card; null while it
// loads. Opens the viewer.
export function MeterPhotoThumb({ reading, onOpen, size = 44 }) {
  const url = useBlobUrl(reading && reading.hasPhoto ? photoPath(reading) : null, reading && reading.photoAt);
  if (!reading || !reading.hasPhoto) return null;
  return (
    <button type="button" className="mtr-thumb" style={{ width: size, height: size }} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onOpen(reading); }}
      aria-label={tr('Photo of the meter for {unit}', { unit: reading.unitCode })} title={tr('Photo of the meter')}>
      {url ? <img src={url} alt="" /> : <span className="mtr-thumb-wait" />}
    </button>
  );
}

// The photo large, with the reading beside it; staff who manage the
// billing can add one, take a better one, or take it off.
export function MeterPhotoViewer({ reading, canManage, onClose, onChanged, utilityLabel, fmtDate }) {
  const input = useRef(null);
  const [r, setR] = useState(reading);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const url = useBlobUrl(r.hasPhoto ? photoPath(r) : null, r.photoAt);
  async function save(photo) {
    setBusy(true); setError(null);
    try {
      const next = await api.put('/poki/readings/' + r.id + '/photo', { photo });
      forgetBlob(photoPath(r));
      setR(next); onChanged(next);
    } catch (err) { setError(err.message); }
    setBusy(false);
  }
  async function take(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    try { const data = await pickPhoto(file); if (data) await save(data); } catch (err) { setError(err.message); }
  }
  const taken = r.photoAt ? new Date(r.photoAt).toLocaleString(activeIntlLocale(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
  return createPortal(
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog mtr-viewer" role="dialog" aria-modal="true" aria-labelledby="mtr-v-t" onClick={(e) => e.stopPropagation()}>
        <header className="mtr-viewer-head">
          <span className={'mtr-kind is-' + r.utilityType} aria-hidden="true">{r.utilityType === 'water' ? '💧' : r.utilityType === 'electricity' ? '⚡' : '🔥'}</span>
          <span>
            <h2 id="mtr-v-t">{r.unitCode} · {utilityLabel(r.utilityType)}</h2>
            <small>{r.propertyName} · {fmtDate(r.periodStart)} – {fmtDate(r.periodEnd)}</small>
          </span>
          <button type="button" className="mtr-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </header>
        <div className="mtr-viewer-body">
          <div className="mtr-big">
            {r.hasPhoto ? (url ? <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={tr('Photo of the meter for {unit}', { unit: r.unitCode })} /></a> : <span className="mtr-thumb-wait" />)
              : <div className="mtr-none"><span aria-hidden="true">📷</span><p>{tr('No photo of the meter with this reading yet.')}</p></div>}
          </div>
          <dl className="mtr-facts">
            <div><dt>{tr('Previous reading')}</dt><dd>{r.previousReading} {r.measureUnit}</dd></div>
            <div><dt>{tr('Current reading')}</dt><dd><b>{r.currentReading} {r.measureUnit}</b></dd></div>
            <div><dt>{tr('Used')}</dt><dd>{r.consumption} {r.measureUnit}</dd></div>
            {taken && <div><dt>{tr('Photo taken')}</dt><dd>{taken}</dd></div>}
          </dl>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {canManage && (
          <div className="dialog-actions">
            <input ref={input} type="file" accept="image/*" capture="environment" onChange={take} hidden aria-hidden="true" tabIndex={-1} />
            {r.hasPhoto && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { if (window.confirm(tr('Take the photo off this reading?'))) save(null); }}>{tr('Remove photo')}</button>}
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => input.current.click()}>📷 {r.hasPhoto ? tr('Take a new photo') : tr('Add a photo')}</button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
