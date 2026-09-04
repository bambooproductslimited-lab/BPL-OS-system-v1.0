import { useEffect, useRef, useState } from 'react';
import { loadFaceModels } from '../lib/faceModels';
import './FaceCapture.css';

// Shared live-camera face capture, used two places: the Kiosk (verifying a
// tap against an enrolled face — mode="kiosk", hands-free, auto-captures
// once a steady run of samples is collected so nobody has to find a button
// on a wall-mounted iPad) and the Employee profile (HR enrolling a
// reference face — mode="enroll", requires an explicit Capture click so HR
// controls the moment, then the employee holds still through a short burst
// of samples).
//
// Detection runs client-side via face-api.js's SsdMobilenetv1 detector +
// 68-point landmarks + recognition net (see lib/faceModels.js) against the
// live <video> element — nothing is ever uploaded as an image; only the
// resulting 128-number descriptor leaves this component, via onCapture.
// Detections are chained with setTimeout (not setInterval), since
// SsdMobilenetv1 is slow enough per frame that a fixed interval could queue
// overlapping detections faster than the device can actually run them.
//
// Averaging multiple samples (rather than trusting whichever single frame
// happened to be captured) matters a lot for real-world accuracy: one
// slightly blurry, off-angle, or badly lit frame is a common, mundane cause
// of a false match or a false reject, and there's no way to know in advance
// which frame that will be. Taking several a fraction of a second apart and
// averaging cancels most of that noise out — this is the single biggest
// lever available without different camera hardware (see the module
// comment in kiosk.service.js on the 2D-webcam-vs-depth-sensor ceiling).
const DETECT_DELAY_MS = 250;
// Skip counting samples for the first moment after the camera stream
// starts — a webcam's auto-exposure/focus hasn't settled yet, and that
// window was a real source of poor-quality reference/verification shots.
const WARMUP_MS = 900;
const KIOSK_SAMPLE_COUNT = 4; // consecutive good detections, post-warmup, averaged into one capture
const ENROLL_SAMPLE_COUNT = 5; // deliberate burst, spaced out, once HR clicks Capture
const ENROLL_SAMPLE_GAP_MS = 350;

function averageDescriptors(samples) {
  var len = samples[0].length;
  var out = new Array(len).fill(0);
  for (var i = 0; i < samples.length; i++) {
    for (var j = 0; j < len; j++) out[j] += samples[i][j];
  }
  for (var j = 0; j < len; j++) out[j] /= samples.length;
  return out;
}

export default function FaceCapture({ mode, onCapture, onCancel, onTimeout, onError, timeoutMs, title, subtitle }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const detectTimerRef = useRef(null);
  const timeoutTimerRef = useRef(null);
  const samplesRef = useRef([]);
  const capturedRef = useRef(false);
  const streamStartedAtRef = useRef(0);
  const [status, setStatus] = useState('starting'); // starting | searching | found | capturing | error
  const [errorMessage, setErrorMessage] = useState('');
  const [captureProgress, setCaptureProgress] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      try {
        const [faceapi, stream] = await Promise.all([
          loadFaceModels(),
          navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 720 } } })
        ]);
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        streamStartedAtRef.current = Date.now();
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

        const options = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 });
        async function detectLoop() {
          if (cancelled || capturedRef.current || !videoRef.current) return;
          const detection = await faceapi
            .detectSingleFace(videoRef.current, options)
            .withFaceLandmarks()
            .withFaceDescriptor();
          if (cancelled || capturedRef.current) return;

          if (!detection) {
            samplesRef.current = [];
            setStatus('searching');
          } else {
            setStatus('found');
            var warmedUp = Date.now() - streamStartedAtRef.current >= WARMUP_MS;
            if (warmedUp) samplesRef.current.push(Array.from(detection.descriptor));

            if (mode === 'kiosk' && warmedUp && samplesRef.current.length >= KIOSK_SAMPLE_COUNT) {
              capturedRef.current = true;
              onCapture(averageDescriptors(samplesRef.current));
              return;
            }
          }
          detectTimerRef.current = setTimeout(detectLoop, DETECT_DELAY_MS);
        }
        detectLoop();
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
      if (detectTimerRef.current) clearTimeout(detectTimerRef.current);
      if (timeoutTimerRef.current) clearTimeout(timeoutTimerRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Enrollment: a deliberate burst of several samples spaced out, so a
  // single bad frame can't become the one-and-only reference for this
  // person. HR keeps the employee looking at the camera through the whole
  // burst — the progress text below tells them when it's done.
  function captureNow() {
    if (capturedRef.current || status !== 'found' || !videoRef.current) return;
    capturedRef.current = true; // stop the background detectLoop; this function drives its own sampling now
    setStatus('capturing');
    (async () => {
      const faceapi = await loadFaceModels();
      const options = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 });
      const collected = [];
      for (let i = 0; i < ENROLL_SAMPLE_COUNT; i++) {
        setCaptureProgress(i + 1);
        // eslint-disable-next-line no-await-in-loop
        const detection = await faceapi
          .detectSingleFace(videoRef.current, options)
          .withFaceLandmarks()
          .withFaceDescriptor();
        if (detection) collected.push(Array.from(detection.descriptor));
        if (i < ENROLL_SAMPLE_COUNT - 1) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, ENROLL_SAMPLE_GAP_MS));
        }
      }
      if (collected.length === 0) {
        // Lost the face mid-burst (moved, blinked through every frame,
        // lighting changed) — let them try the whole thing again rather
        // than enrolling off of nothing.
        capturedRef.current = false;
        setCaptureProgress(0);
        setStatus('found');
        return;
      }
      onCapture(averageDescriptors(collected));
    })();
  }

  return (
    <div className="facecap">
      <div className="facecap-frame">
        <video ref={videoRef} className="facecap-video" muted playsInline autoPlay />
        {status !== 'error' && <div className={'facecap-ring facecap-ring-' + (status === 'capturing' ? 'found' : status)} />}
      </div>
      <div className="facecap-status">
        {status === 'starting' && 'Starting camera…'}
        {status === 'searching' && (title || 'Look at the camera')}
        {status === 'found' && (mode === 'kiosk' ? 'Got it…' : 'Face found — capture when ready')}
        {status === 'capturing' && 'Hold still — capturing ' + captureProgress + '/' + ENROLL_SAMPLE_COUNT + '…'}
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
