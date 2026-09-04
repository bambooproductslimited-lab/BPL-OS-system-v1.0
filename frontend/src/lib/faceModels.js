// Loads face-api.js's pretrained models once per mode and caches the
// promise, since neither the kiosk (verifying a tap) nor the Employee
// profile (enrolling a reference face) should re-download them mid-session.
// Weight files are served same-origin from /models (frontend/public/models/,
// fetched straight from face-api.js's own published weights) rather than a
// CDN, so the kiosk's service worker can cache them for offline use the
// same way it caches the page itself — see kiosk-sw.js.
//
// Two different face DETECTORS on purpose, chosen for where each mode
// actually runs:
//
// - "enroll" (Employee profile, run by HR on whatever computer they're at —
//   doesn't have to be the kiosk device itself) uses SsdMobilenetv1: more
//   accurate face box/alignment, at the cost of being noticeably heavier to
//   run. Worth it for a once-per-employee capture on ordinary hardware.
//
// - "kiosk" (the actual iPad mounted at the door, which this company runs
//   across a real spread of hardware and iPadOS versions — as old as an
//   iPad Air 2 capped at iPadOS 15) uses TinyFaceDetector: the detector
//   face-api.js itself describes as built for real-time use on resource-
//   constrained/mobile hardware. SsdMobilenetv1 on every single tap, on the
//   oldest deployed iPad, risked turning a two-second clock-in into a much
//   longer wait — or worse, tripping one of tfjs's known WebGL-backend
//   quirks on older mobile Safari.
//
// Both share the same landmark + recognition nets — the detector's only
// job is locating the face box; the descriptor that actually gets matched
// comes from the recognition net either way, so this split doesn't cost
// the multi-angle accuracy work in kiosk.service.js/FaceCapture.jsx.
const modelsPromises = { enroll: null, kiosk: null };

export function loadFaceModels(mode) {
  const key = mode === 'kiosk' ? 'kiosk' : 'enroll';
  if (!modelsPromises[key]) {
    modelsPromises[key] = (async () => {
      const faceapi = await import('face-api.js');
      const detectorLoad = key === 'kiosk'
        ? faceapi.nets.tinyFaceDetector.loadFromUri('/models')
        : faceapi.nets.ssdMobilenetv1.loadFromUri('/models');
      await Promise.all([
        detectorLoad,
        faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
        faceapi.nets.faceRecognitionNet.loadFromUri('/models')
      ]);
      return faceapi;
    })();
  }
  return modelsPromises[key];
}
