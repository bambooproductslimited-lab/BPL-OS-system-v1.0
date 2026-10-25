import { useEffect, useState } from 'react';
import { API_URL } from '../api/client';
import { tr } from '../lib/i18n.jsx';
import './QuoteSheet.css';

// "Ask for a quote" on Bamboo Products' website (backend shopQuotes.service
// ask): something made to the customer's size — what, how big, how many,
// where, by when, roughly for how much — with up to four photos of the
// space or of a piece they like. Staff price it and send the quotation;
// the customer sees it in My account. Opened from the shop's top, or from
// an item ("Need another size?", `item` filled in); a signed-in customer's
// details are filled in (`me`).

const MAX_PHOTOS = 4;
const MAX_BYTES = 6 * 1024 * 1024;

export default function QuoteSheet({ item, me, onClose }) {
  const mine = (me && me.profile) || {};
  const [f, setF] = useState({ what: item ? item.name : '', size: '', qty: 1, area: '', budget: '', neededBy: '', name: mine.name || '', phone: mine.phone || '', email: mine.email || '', note: '' });
  const [photos, setPhotos] = useState([]); // [{ file, url }]
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  useEffect(() => () => photos.forEach((p) => URL.revokeObjectURL(p.url)), [photos]);

  function addPhotos(list) {
    setError(null);
    const room = MAX_PHOTOS - photos.length;
    const picked = Array.from(list || []).slice(0, room);
    const big = picked.find((x) => x.size > MAX_BYTES);
    if (big) { setError(tr('Each photo up to 6 MB.')); return; }
    if (!picked.every((x) => /^image\/(jpeg|png|webp)$/.test(x.type))) { setError(tr('Add photos (JPG, PNG or WebP).')); return; }
    setPhotos(photos.concat(picked.map((file) => ({ file, url: URL.createObjectURL(file) }))));
  }
  async function send(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      Object.entries({ ...f, itemId: item ? item.id : '', website: '' }).forEach(([k, v]) => fd.append(k, v == null ? '' : String(v)));
      photos.forEach((p) => fd.append('photos', p.file, p.file.name));
      const r = await fetch(API_URL + '/shop/quotes', { method: 'POST', body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j.error && j.error.message) || tr('Something went wrong. Please try again.'));
      setDone(j);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <div className="shp-back" onClick={() => !busy && onClose()}>
      {done ? (
        <div className="shp-sheet qte qte-done" role="dialog" aria-modal="true" aria-labelledby="qte-done-title" onClick={(e) => e.stopPropagation()}>
          <span className="qte-done-art" aria-hidden="true">{['📐', '🎋', '✨'].map((x, i) => <i key={i} style={{ '--i': i }}>{x}</i>)}</span>
          <h2 id="qte-done-title">{tr('Request {no} is in!', { no: done.number })}</h2>
          <p>{tr('We will work out your quotation and send it to you, usually within two working days.')}</p>
          {done.emailed && <p className="qte-sent">✉️ {tr('We have emailed you what you asked for.')}</p>}
          <a className="shp-go is-big" href="/account">👤 {tr('Follow it in My account')}</a>
          <button type="button" className="shp-go is-ghost" onClick={onClose}>{tr('Back to the shop')}</button>
        </div>
      ) : (
        <form className="shp-sheet is-checkout qte" role="dialog" aria-modal="true" aria-labelledby="qte-title" onClick={(e) => e.stopPropagation()} onSubmit={send}>
          <div className="shp-co-head">
            <button type="button" className="shp-x is-plain" onClick={onClose} aria-label={tr('Close')}>←</button>
            <h2 id="qte-title">📐 {tr('Ask for a quote')}</h2>
          </div>
          <p className="qte-intro">{tr('Made to your size, in the numbers you need: tell us what you have in mind and we send you a price.')}</p>
          <label className="shp-field"><span>{tr('What would you like us to make?')}</span>
            <input className="input" required maxLength={160} value={f.what} onChange={(e) => set({ what: e.target.value })} placeholder={tr('e.g. a pergola for the garden, 10 bar stools')} /></label>
          <div className="shp-two">
            <label className="shp-field"><span>{tr('Size (optional)')}</span>
              <input className="input" maxLength={160} value={f.size} onChange={(e) => set({ size: e.target.value })} placeholder={tr('e.g. 4 m by 3 m')} /></label>
            <label className="shp-field"><span>{tr('How many')}</span>
              <input className="input" type="number" min="1" max="9999" required value={f.qty} onChange={(e) => set({ qty: e.target.value })} /></label>
          </div>
          <div className="shp-two">
            <label className="shp-field"><span>{tr('Where (area or town)')}</span>
              <input className="input" maxLength={80} value={f.area} onChange={(e) => set({ area: e.target.value })} placeholder={tr('e.g. East Legon')} /></label>
            <label className="shp-field"><span>{tr('Needed by (optional)')}</span>
              <input className="input" type="date" value={f.neededBy} min={new Date().toISOString().slice(0, 10)} onChange={(e) => set({ neededBy: e.target.value })} /></label>
          </div>
          <label className="shp-field"><span>{tr('Your budget, roughly (optional)')}</span>
            <span className="qte-money"><b>GHS</b><input className="input" type="number" min="0" step="50" value={f.budget} onChange={(e) => set({ budget: e.target.value })} /></span></label>

          <div className="shp-field"><span>{tr('Photos (optional, up to {n})', { n: MAX_PHOTOS })}</span>
            <div className="qte-photos">
              {photos.map((p, i) => (
                <span key={p.url} className="qte-photo" style={{ '--i': i }}>
                  <img src={p.url} alt={tr('Photo {n}', { n: i + 1 })} />
                  <button type="button" onClick={() => setPhotos(photos.filter((x) => x !== p))} aria-label={tr('Take this photo out')}>✕</button>
                </span>
              ))}
              {photos.length < MAX_PHOTOS && (
                <label className="qte-add">
                  <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => { addPhotos(e.target.files); e.target.value = ''; }} />
                  <span aria-hidden="true">📷</span><small>{tr('The space, or a piece you like')}</small>
                </label>
              )}
            </div>
          </div>

          <label className="shp-field"><span>{tr('Your name')}</span><input className="input" required maxLength={120} autoComplete="name" value={f.name} onChange={(e) => set({ name: e.target.value })} /></label>
          <div className="shp-two">
            <label className="shp-field"><span>{tr('Phone number')}</span><input className="input" type="tel" inputMode="tel" required autoComplete="tel" value={f.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="024 000 0000" /></label>
            <label className="shp-field"><span>{tr('Email (for the quotation)')}</span><input className="input" type="email" autoComplete="email" value={f.email} onChange={(e) => set({ email: e.target.value })} /></label>
          </div>
          <label className="shp-field"><span>{tr('Anything else? (optional)')}</span>
            <textarea className="input" rows={2} maxLength={800} value={f.note} onChange={(e) => set({ note: e.target.value })} placeholder={tr('e.g. colours, a finish, how you will use it')} /></label>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <button type="submit" className="shp-go is-big" disabled={busy || f.what.trim().length < 3}>{busy ? tr('Sending…') : '📐 ' + tr('Send my request')}</button>
          <p className="shp-hint is-center">{tr('Free, and nothing to pay until you approve the quotation.')}</p>
        </form>
      )}
    </div>
  );
}
