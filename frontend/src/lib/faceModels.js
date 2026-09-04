// Loads face-api.js's three pretrained models once and caches the promise,
// since both the kiosk (verifying a tap) and the Employee profile
// (enrolling a reference face) need the same models and neither should
// re-download them mid-session. Weight files are served same-origin from
// /models (frontend/public/models/, ~7MB total, fetched straight from
// face-api.js's own published weights) rather than a CDN, so the kiosk's
// service worker can cache them for offline use the same way it caches the
// page itself — see kiosk-sw.js.
let modelsPromise = null;

export function loadFaceModels() {
  if (!modelsPromise) {
    modelsPromise = (async () => {
      const faceapi = await import('face-api.js');
      await Promise.all([
        // SsdMobilenetv1, not TinyFaceDetector — the tiny detector's looser
        // face box/alignment was measurably letting different people match
        // each other at the kiosk. This one is slower per frame but a kiosk
        // tap can afford an extra second; accuracy matters more here.
        faceapi.nets.ssdMobilenetv1.loadFromUri('/models'),
        faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
        faceapi.nets.faceRecognitionNet.loadFromUri('/models')
      ]);
      return faceapi;
    })();
  }
  return modelsPromise;
}
