import { useEffect, useMemo, useRef, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { cameraCanScan } from './barcodeScan';
import { tr } from '../../lib/i18n.jsx';
import './sixth.css';

// Barcodes at the till (backend restaurantTillMenu linkBarcode): a USB or
// Bluetooth scanner types the code fast and ends with Enter — the till
// hears it wherever the cashier is (not while typing in a box); the
// phone's or tablet's camera reads one too, where the browser can
// (BarcodeDetector). A code is a dish's SKU, or one of its sizes'. A code
// no dish has opens LinkBarcode: pick the dish, and it is that dish's from
// now on (by whoever may count the stock, else with a manager's PIN).

// The camera, reading codes until one is found (or a code typed by hand).
export function CameraScan({ onCode, onClose }) {
  const video = useRef(null);
  const [error, setError] = useState(cameraCanScan ? null : tr('This browser cannot read barcodes with the camera. Use a scanner, or type the code.'));
  const [typed, setTyped] = useState('');
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (!cameraCanScan) return undefined;
    let stream = null, timer = null, stopped = false;
    (async () => {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        const detector = new window.BarcodeDetector({ formats: formats.filter((f) => ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code', 'itf'].includes(f)) });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
        video.current.srcObject = stream;
        await video.current.play();
        const look = async () => {
          if (stopped) return;
          try {
            const found = await detector.detect(video.current);
            if (found.length && found[0].rawValue) { setSeen(true); if (navigator.vibrate) navigator.vibrate(60); onCode(found[0].rawValue); return; }
          } catch { /* a frame not ready: the next one */ }
          timer = setTimeout(look, 220);
        };
        look();
      } catch (e) {
        setError(e && e.name === 'NotAllowedError' ? tr('The camera was not allowed. Allow it in the browser, or type the code.') : tr('The camera cannot be opened here. Type the code instead.'));
      }
    })();
    return () => { stopped = true; clearTimeout(timer); if (stream) stream.getTracks().forEach((t) => t.stop()); };
  }, [onCode]);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog bc" onClick={(e) => e.stopPropagation()}>
        <h2>📷 {tr('Scan a barcode')}</h2>
        {!error ? (
          <div className={'bc-view' + (seen ? ' is-seen' : '')}>
            <video ref={video} playsInline muted />
            <span className="bc-frame" aria-hidden="true"><i /></span>
            <small>{tr('Hold the barcode inside the frame.')}</small>
          </div>
        ) : <p className="bc-msg">{error}</p>}
        <form className="bc-type" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) onCode(typed.trim()); }}>
          <input className="input" inputMode="numeric" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={tr('Or type the code')} aria-label={tr('Or type the code')} />
          <button type="submit" className="btn btn-secondary" disabled={!typed.trim()}>{tr('Find')}</button>
        </form>
        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button></div>
      </div>
    </div>
  );
}

// A code no dish has: give it to one (or one of its sizes).
export function LinkBarcode({ code, menu, token, canStock, onLinked, onClose }) {
  const [q, setQ] = useState('');
  const [pick, setPick] = useState(null); // { item, variation }
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return menu.filter((m) => !s || m.name.toLowerCase().includes(s) || (m.category || '').toLowerCase().includes(s)).slice(0, 40);
  }, [menu, q]);
  async function link() {
    setBusy(true); setError(null);
    try {
      await posFetch('POST', '/pos/stock', token, { action: 'barcode', code, menuItemId: pick.item.id, variationId: pick.variation ? pick.variation.id : undefined, managerPin: canStock ? undefined : pin });
      onLinked(pick);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog bc bc-link" onClick={(e) => e.stopPropagation()}>
        <span className="bc-code" aria-label={tr('Barcode')}><i aria-hidden="true" />{code}</span>
        <h2>{tr('A new barcode')}</h2>
        <p className="dk-muted">{tr('No dish has this code yet. Pick the one it is, and it rings up by itself from now on.')}</p>
        <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Find a dish…')} aria-label={tr('Find a dish…')} />
        <div className="bc-list">
          {shown.map((m) => (m.variations && m.variations.length ? m.variations.map((v) => (
            <button key={v.id} type="button" className={'bc-row' + (pick && pick.variation && pick.variation.id === v.id ? ' is-on' : '')} onClick={() => setPick({ item: m, variation: v })}>
              <b>{m.name} — {v.name}</b><small>{v.sku ? tr('has {code}', { code: v.sku }) : m.category}</small>
            </button>
          )) : (
            <button key={m.id} type="button" className={'bc-row' + (pick && !pick.variation && pick.item.id === m.id ? ' is-on' : '')} onClick={() => setPick({ item: m, variation: null })}>
              <b>{m.name}</b><small>{m.sku ? tr('has {code}', { code: m.sku }) : m.category}</small>
            </button>
          )))}
        </div>
        {!canStock && pick && (
          <input className="input bc-pin" type="password" inputMode="numeric" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder={tr('Manager PIN')} aria-label={tr('Manager PIN')} />
        )}
        {error && <div className="error-banner">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={busy || !pick || (!canStock && pin.length !== 4)} onClick={link}>{busy ? tr('Saving…') : tr('Give it this code and add it')}</button>
        </div>
      </div>
    </div>
  );
}
