import { useEffect, useRef, useState } from 'react';
import { loadFaceModels } from '../lib/faceModels';
import './FaceCapture.css';

// Shared live-camera face capture, used two places: the Kiosk (verifying a
// tap against an enrolled face — mode="kiosk", hands-free, auto-captures
// the moment a face is confidently seen so nobody has to find a button on
// a wall-mounted iPad) and the Employee profile (HR enrolling a reference
// face — mode="enroll", requires an explicit Capture click so HR controls
// the moment, with the employee looking at the camera on their own time).
//
// Detection runs client-side via face-api.js's tiny face detector +
// 68-point landmarks + recognition net (see lib/faceModels.js) on a
// polling interval against the live <video> element — nothing is ever
// uploaded as an image; only the resulting 128-number descriptor leaves
// this component, via onCapture.
const DETECT_INTERVAL_MS = 350;
const KIOSK_STABLE_HITS = 2; // consecutive good detections before auto-capturing

export default function FaceCapture({ mode, onCapture, onCancel, onTimeout, onError, timeoutMs, title, subtitle }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const detectTimerRef = useRef(null);
  const timeoutTimerRef = useRef(null);
  const stableHitsRef = useRef(0);
  const capturedRef = useRef(false);
  const [status, setStatus] = useState('starting'); // starting | searching | found | error
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function start() {
      try {
        const [faceapi, stream] = await Promise.all([
          loadFaceModels(),
          navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 480 } } })
        ]);
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setStatus('searching');

        if (timeoutMs) {
          timeoutTimerRef.current = setTimeout(() => {
            if (!capturedRef.current && onTimeout) onTimeout();
          }, timeoutMs);
        }

        const options = new faceapi.TinyFaceDetectorOptions();
        detectTimerRef.current = setInterval(async () => {
          if (cancelled || capturedRef.current || !videoRef.current) return;
          const detection = await faceapi
            .detectSingleFace(videoRef.current, options)
            .withFaceLandmarks()
            .withFaceDescriptor();
          if (cancelled || capturedRef.current) return;

          if (!detection) {
            stableHitsRef.current = 0;
            setStatus('searching');
            return;
          }
          setStatus('found');
          stableHitsRef.current += 1;

          if (mode === 'kiosk' && stableHitsRef.current >= KIOSK_STABLE_HITS) {
            capturedRef.current = true;
            onCapture(Array.from(detection.descriptor));
          }
        }, DETECT_INTERVAL_MS);
      } catch (err) {
        if (cancelled) return;
        var message = err && err.name === 'NotAllowedError'
          ? 'Camera access was denied. This device needs camera permission to continue.'
          : 'Could not start the camera. ' + (err && err.message ? err.message : '');
        setStatus('error');
        setErrorMessage(message);
        if (onError) onError(message);
      }
    }
    start();

    return () => {
      cancelled = true;
      if (detectTimerRef.current) clearInterval(detectTimerRef.current);
      if (timeoutTimerRef.current) clearTimeout(timeoutTimerRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  function captureNow() {
    if (capturedRef.current || status !== 'found' || !videoRef.current) return;
    (async () => {
      const faceapi = await loadFaceModels();
      const detection = await faceapi
        .detectSingleFace(videoRef.current, new faceapi.TinyFaceDetectorOptions())
        .withFaceLandmarks()
        .withFaceDescriptor();
      if (detection) {
        capturedRef.current = true;
        onCapture(Array.from(detection.descriptor));
      }
    })();
  }

  return (
    <div className="facecap">
      <div className="facecap-frame">
        <video ref={videoRef} className="facecap-video" muted playsInline autoPlay />
        {status !== 'error' && <div className={'facecap-ring facecap-ring-' + status} />}
      </div>
      <div className="facecap-status">
        {status === 'starting' && 'Starting camera…'}
        {status === 'searching' && (title || 'Look at the camera')}
        {status === 'found' && (mode === 'kiosk' ? 'Got it…' : 'Face found — capture when ready')}
        {status === 'error' && errorMessage}
      </div>
      {subtitle && status !== 'error' && <div className="facecap-subtitle">{subtitle}</div>}
      <div className="facecap-actions">
        {mode === 'enroll' && status !== 'error' && (
          <button type="button" className="btn btn-primary" disabled={status !== 'found'} onClick={captureNow}>Capture</button>
        )}
        {onCancel && <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}
