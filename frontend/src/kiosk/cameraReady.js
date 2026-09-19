// Camera permission handling for the clock-in kiosk.
//
// Why this exists: getUserMedia always needs the browser's permission, and
// the browser only asks the first time something calls it. Until now the
// kiosk's only call lived inside FaceCapture, which mounts *after* an
// employee has typed their PIN — so the permission dialog always landed in
// front of an employee halfway through clocking in. That's the wrong person
// to ask: they have no idea whether they're supposed to say yes, the answer
// isn't theirs to give (it's the device's, and the device belongs to the
// company), and the shift-change queue behind them waits while they read it.
//
// Priming moves that first call to kiosk startup, while the idle PIN pad is
// on screen and nobody is waiting: open the camera, then stop the track
// again immediately. The permission is granted from then on, so every real
// clock-in goes straight to the viewfinder. The camera is NOT held open
// between taps — the stream is released within milliseconds of being
// acquired, so the device's camera indicator still only lights up when
// somebody is actually being verified.
//
// How long a grant lasts is the browser's business, not ours:
//   * Chrome/Edge/Firefox over HTTPS remember it per origin, so the prompt
//     happens once on that device and never again.
//   * Safari on iPadOS only remembers it for the life of the page unless the
//     site has been explicitly allowed (the "aA" button in the address bar
//     -> Website Settings -> Camera -> Allow, or Settings > Safari >
//     Camera > Allow). Without that, a reload — or the tab being discarded
//     after the iPad has been asleep a while — puts the device back to
//     un-granted. Priming at startup covers that too, since it re-asks on
//     the idle screen rather than at somebody's clock-in.
// Either way, if we can't get a grant, the kiosk shows a banner on the idle
// screen so whoever walks past can fix it, rather than the next employee to
// tap a PIN discovering it the hard way.

export function cameraSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

// 'granted' | 'denied' | 'prompt' | 'unknown' | 'unavailable'.
// Safari went years without supporting a 'camera' query and throws on the
// name rather than returning anything, so anything unsupported or unhappy
// reports 'unknown' — never an error, and never a reason to skip priming.
export async function cameraPermissionState() {
  if (!cameraSupported()) return 'unavailable';
  if (!navigator.permissions || !navigator.permissions.query) return 'unknown';
  try {
    const status = await navigator.permissions.query({ name: 'camera' });
    return status && status.state ? status.state : 'unknown';
  } catch {
    return 'unknown';
  }
}

// Asks for the camera and hands it straight back. Resolves to 'granted',
// 'denied' (somebody said no, or the browser wouldn't ask without a tap) or
// 'unavailable' (no camera on this device at all, or it's busy) — it never
// throws, since nothing about a kiosk startup should break over this.
export async function primeCamera() {
  if (!cameraSupported()) return 'unavailable';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    stream.getTracks().forEach((t) => t.stop());
    return 'granted';
  } catch (err) {
    return err && (err.name === 'NotAllowedError' || err.name === 'SecurityError') ? 'denied' : 'unavailable';
  }
}
