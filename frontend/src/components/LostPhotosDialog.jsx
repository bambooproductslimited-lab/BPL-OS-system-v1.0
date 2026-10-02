import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useBlobUrl } from './Photo';
import { CameraIcon } from './CatalogPhotos';
import { tr } from '../lib/i18n.jsx';
import { fmtDate } from './DashKit';
import './EmailDocumentDialog.css';
import './LostPhotosDialog.css';

// Photos lost when the Square import used to delete and re-create its items
// (backend catalogPhotoRecovery.service.js). The picture files were still
// in storage; each is shown with the item it was added to, matched to the
// item of that name today. Tick, check the item, put back — nothing is put
// back until then.

function Thumb({ refKey }) {
  const url = useBlobUrl('/catalog/lost-photos/preview?ref=' + encodeURIComponent(refKey), refKey);
  return <span className="lpd-thumb">{url ? <img src={url} alt="" /> : <CameraIcon />}</span>;
}

export default function LostPhotosDialog({ lost, items, onClose, onDone }) {
  const [pick, setPick] = useState({}); // ref -> true
  const [target, setTarget] = useState({}); // ref -> itemId
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    const p = {}, t = {};
    lost.forEach((l) => { if (l.matches.length) { p[l.ref] = true; t[l.ref] = l.matches[0].id; } });
    setPick(p); setTarget(t);
  }, [lost]);

  const chosen = lost.filter((l) => pick[l.ref] && target[l.ref]);
  const allItems = items.slice().sort((a, b) => a.name.localeCompare(b.name));

  async function save() {
    setSaving(true); setError(null);
    try {
      const r = await api.post('/catalog/lost-photos/restore', { photos: chosen.map((l) => ({ ref: l.ref, itemId: target[l.ref] })) });
      setDone(r);
      if (onDone) onDone(r);
    } catch (e) { setError(e.message); }
    setSaving(false);
  }

  return (
    <div className="dialog-backdrop" onClick={() => !saving && onClose()}>
      <div className="dialog ed lpd" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="lpd-title">
        <div className="ed-head">
          <span className="ed-head-icon" aria-hidden="true"><CameraIcon /></span>
          <div>
            <h2 id="lpd-title">{tr('Put back lost photos')}</h2>
            <p className="ed-sub">{tr('These photos were added to items that the Square import used to delete and make again, so the photos lost their item. The pictures were kept. Each is matched to the item with the same name today — check it, then put them back.')}</p>
          </div>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}

        {done ? (
          <div className="ed-done" role="status">
            <strong>{tr('{n} photos put back', { n: done.restored })}</strong>
            {done.full.length > 0 && <span>{tr('Not put back — these items already have 12 photos: {names}', { names: done.full.join(', ') })}</span>}
          </div>
        ) : (
          <ul className="lpd-list">
            {lost.map((l) => (
              <li key={l.ref} className={'lpd-row' + (pick[l.ref] ? ' is-on' : '')}>
                <input type="checkbox" checked={!!pick[l.ref]} onChange={(e) => setPick((p) => ({ ...p, [l.ref]: e.target.checked }))} aria-label={tr('Put back this photo of {name}', { name: l.itemName })} />
                <Thumb refKey={l.ref} />
                <span className="lpd-main">
                  <strong>{l.itemName}</strong>
                  <small>{l.uploadedAt ? tr('Added {date}', { date: fmtDate(l.uploadedAt) }) : ''}{!l.matches.length ? ' · ' + tr('no item has this name now') : l.matches.length > 1 ? ' · ' + tr('{n} items have this name', { n: l.matches.length }) : ''}</small>
                </span>
                <select className={'input lpd-select' + (pick[l.ref] && !target[l.ref] ? ' is-missing' : '')} value={target[l.ref] || ''}
                  onChange={(e) => { const v = e.target.value; setTarget((t) => ({ ...t, [l.ref]: v })); if (v) setPick((p) => ({ ...p, [l.ref]: true })); }}
                  aria-label={tr('Item for this photo')}>
                  <option value="">{tr('Choose the item…')}</option>
                  {l.matches.length > 0 && (
                    <optgroup label={tr('Same name')}>
                      {l.matches.map((m) => <option key={m.id} value={m.id}>{m.name}{m.active ? '' : ' (' + tr('inactive') + ')'}{m.photos ? ' · ' + tr('{n} photos', { n: m.photos }) : ''}</option>)}
                    </optgroup>
                  )}
                  <optgroup label={tr('All items')}>
                    {allItems.map((it) => <option key={it.id} value={it.id}>{it.name}</option>)}
                  </optgroup>
                </select>
              </li>
            ))}
          </ul>
        )}

        <div className="dialog-actions">
          {done ? <button type="button" className="btn btn-primary" onClick={onClose}>{tr('Done')}</button> : (
            <>
              <button type="button" className="btn btn-secondary" disabled={saving} onClick={onClose}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={saving || !chosen.length} onClick={save}>
                {saving ? tr('Putting back…') : tr('Put back {n} photos', { n: chosen.length })}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
