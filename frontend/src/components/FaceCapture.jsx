import { useEffect, useRef, useState } from 'react';
import { loadFaceModels } from '../lib/faceModels';
import './FaceCapture.css';

// Shared live-camera face capture, used two places: the Kiosk (verifying a
// tap against an enrolled face — mode="kiosk", hands-free, auto-captures
// once a steady run of samples is collected so nobody has to find a button
// on a wall-mounted iPad) and the Employee profile (HR enrolling a
// reference — mode="enroll", requires an explicit Capture click, then
// walks the employee through a few head angles).
//
// Detection runs client-side via face-api.js's SsdMobilenetv1 detector +
// 68-point landmarks + recognition net (see lib/faceModels.js) against the
// live <video> element — nothing is ever uploaded as an image; only the
// resulting 128-number descriptor(s) leave this component, via onCapture.
// Detections are chained with setTimeout (not setInterval), since
// SsdMobilenetv1 is slow enough per frame that a fixed interval could queue
// overlapping detections faster than the device can actually run them.
//
// Enrollment captures a SET of descriptors, one per head pose (straight on,
// turned left/right, tilted up/down), each itself an average of a couple of
// frames — onCapture(descriptorSet) receives an array of vectors, not one
// vector. This mirrors how Face ID's own setup has you move your head in a
// circle: verification only has to land close to the NEAREST enrolled
// angle (see kiosk.service.js's nearestDistance), so it stays reliable no
// matter what angle someone happens to be at when they glance at the
// kiosk. Kiosk verification is the opposite shape on purpose — a person
// tapping in isn't going to tilt through a sequence of poses for a two-
// second clock-in, so it captures one steady, averaged reading and leaves
// the angle-tolerance work to what was captured at enrollment.
const DETECT_DELAY_MS = 250;
// Skip counting samples for the first moment after the camera stream
// starts — a webcam's auto-exposure/focus hasn't settled yet, and that
// window was a real source of poor-quality reference/verification shots.
const WARMUP_MS = 900;
const KIOSK_SAMPLE_COUNT = 4; // consecutive good detections, post-warmup, averaged into one capture

const ENROLL_POSES = [
  { label: 'Look straight at the camera' },
  { label: 'Slowly turn your head to your left' },
  { label: 'Slowly turn your head to your right' },
  { label: 'Tilt your chin up slightly' },
  { label: 'Tilt your chin down slightly' }
];
const POSE_SETTLE_MS = 1100; // time to actually move into the new position before it's trusted
const POSE_FRAMES = 2; // frames captured & averaged per pose
const POSE_FRAME_GAP_MS = 300;
const POSE_MAX_ATTEMPTS = 6; // detection attempts per pose before giving up on it (lost face, moved too far)

function averageDescriptors(samples) {
  var len = samples[0].length;
  var out = new Array(len).fill(0);
  for (var i = 0; i < samples.length; i++) {
    for (var j = 0; j < len; j++) out[j] += samples[i][j];
  }
  for (var j = 0; j < len; j++) out[j] /= samples.length;
  return out;
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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
  const [poseIndex, setPoseIndex] = useState(0);

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

  // Enrollment: walks through ENROLL_POSES in sequence — each pose gets a
  // settle pause (time to actually move into it), then a couple of frames
  // captured and averaged into that pose's descriptor. A pose that never
  // sees a face within its attempt budget (lost/moved too far) is simply
  // skipped rather than blocking forever; the whole thing only fails if
  // fewer than 2 poses came back with anything.
  function captureNow() {
    if (capturedRef.current || status !== 'found' || !videoRef.current) return;
    capturedRef.current = true; // stop the background detectLoop; this function drives its own sampling now
    setStatus('capturing');
    (async () => {
      const faceapi = await loadFaceModels();
      const options = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 });
      const poseDescriptors = [];

      for (let p = 0; p < ENROLL_POSES.length; p++) {
        setPoseIndex(p);
        // eslint-disable-next-line no-await-in-loop
        await wait(POSE_SETTLE_MS);

        const frames = [];
        let attempts = 0;
        while (frames.length < POSE_FRAMES && attempts < POSE_MAX_ATTEMPTS) {
          attempts += 1;
          // eslint-disable-next-line no-await-in-loop
          const detection = await faceapi
            .detectSingleFace(videoRef.current, options)
            .withFaceLandmarks()
            .withFaceDescriptor();
          if (detection) frames.push(Array.from(detection.descriptor));
          if (frames.length < POSE_FRAMES && attempts < POSE_MAX_ATTEMPTS) {
            // eslint-disable-next-line no-await-in-loop
            await wait(POSE_FRAME_GAP_MS);
          }
        }
        if (frames.length > 0) poseDescriptors.push(averageDescriptors(frames));
      }

      if (poseDescriptors.length < 2) {
        // Lost the face through most of the walk (moved away, bad
        // lighting) — let them try the whole thing again rather than
        // enrolling off of one or zero angles.
        capturedRef.current = false;
        setPoseIndex(0);
        setStatus('found');
        return;
      }
      onCapture(poseDescriptors);
    })();
  }

  const posesDone = mode === 'enroll' && status === 'capturing';

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
        {posesDone && (ENROLL_POSES[poseIndex] ? ENROLL_POSES[poseIndex].label : 'Almost done…')}
        {status === 'error' && errorMessage}
      </div>
      {posesDone && (
        <div className="facecap-pose-progress">Angle {poseIndex + 1} of {ENROLL_POSES.length}</div>
      )}
      {subtitle && status !== 'error' && !posesDone && <div className="facecap-subtitle">{subtitle}</div>}
      <div className="facecap-actions">
        {mode === 'enroll' && status !== 'error' && (
          <button type="button" className="btn btn-primary" disabled={status !== 'found'} onClick={captureNow}>Capture</button>
        )}
        {onCancel && <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}
