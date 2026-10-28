import { useEffect, useRef, useState } from 'react';
import { tr } from '../lib/i18n.jsx';

// The camera reading QR codes (staff ID cards at the gate and the kiosk).
// The browser's own barcode reader where there is one (Chrome on Android),
// else jsQR on the frames (Safari on an iPad), loaded only when the camera
// is opened. onCode(text) once per code seen; the same code is not given
// again for a few seconds.
export default function QrScanner({ onCode, className = '', facing = 'environment' }) {
  const video = useRef(null);
  const cb = useRef(onCode);
  cb.current = onCode;
  const [error, setError] = useState(null);
  useEffect(() => {
    let stream = null, timer = null, alive = true, last = { code: '', at: 0 };
    const canvas = document.createElement('canvas');
    function seen(code) {
      const now = Date.now();
      if (!code || (code === last.code && now - last.at < 4000)) return;
      last = { code, at: now };
      cb.current(code);
    }
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false });
        if (!alive) { stream.getTracks().forEach((t) => t.stop()); return; }
        video.current.srcObject = stream;
        await video.current.play();
        let detector = null, jsQR = null;
        if ('BarcodeDetector' in window) {
          try { const formats = await window.BarcodeDetector.getSupportedFormats(); if (formats.indexOf('qr_code') >= 0) detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch { detector = null; }
        }
        if (!detector) jsQR = (await import('jsqr')).default;
        const tick = async () => {
          if (!alive) return;
          const v = video.current;
          if (v && v.readyState >= 2) {
            try {
              if (detector) { const found = await detector.detect(v); if (found[0]) seen(found[0].rawValue); }
              else {
                const w = Math.min(640, v.videoWidth), h = Math.round(v.videoHeight * (w / v.videoWidth));
                canvas.width = w; canvas.height = h;
                const g = canvas.getContext('2d', { willReadFrequently: true });
                g.drawImage(v, 0, 0, w, h);
                const img = g.getImageData(0, 0, w, h);
                const r = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
                if (r) seen(r.data);
              }
            } catch { /* the next frame */ }
          }
          timer = setTimeout(tick, 180);
        };
        tick();
      } catch (e) {
        if (alive) setError(e && e.name === 'NotAllowedError' ? tr('The camera is not allowed: allow it in the browser, or use a scanner.') : tr('No camera here: use a scanner or type the card number.'));
      }
    })();
    return () => { alive = false; clearTimeout(timer); if (stream) stream.getTracks().forEach((t) => t.stop()); };
  }, [facing]);
  return (
    <div className={'qr-scan ' + className}>
      {error ? <p className="qr-scan-error" role="alert">📷 {error}</p> : <><video ref={video} playsInline muted aria-label={tr('Camera')} /><span className="qr-scan-frame" aria-hidden="true" /></>}
    </div>
  );
}
