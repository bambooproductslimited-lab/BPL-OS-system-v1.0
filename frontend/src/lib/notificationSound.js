// The chime the header bell plays when a new notification lands.
//
// Synthesized with the Web Audio API rather than shipped as an audio file,
// for the same reasons kiosk/kioskSounds.js does it: nothing extra to load,
// nothing that can 404 or go stale in a cache, and it still works on a
// device that has gone offline mid-session. This is a separate module from
// the kiosk's because the two have different problems — the kiosk unlocks
// audio from a keypad tap it knows is coming, whereas a notification
// arrives on a 45-second poll with no gesture anywhere near it.
//
// Which is the thing to understand about this file: every browser refuses
// to play audio until the person has interacted with the page at least
// once. There is no way around that and no reason to want one — it is what
// stops a background tab making noise at somebody. So installUnlock()
// listens for the first click or keypress anywhere in the app and resumes
// the AudioContext inside that gesture's call stack; until then a chime is
// silently skipped rather than queued, because a burst of backdated dings
// the moment someone finally clicks is worse than the silence was.

const MUTE_KEY = 'bamboo-os-notification-sound-muted';

let audioCtx = null;
let unlocked = false;

function getContext() {
  if (audioCtx) return audioCtx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  audioCtx = new Ctor();
  return audioCtx;
}

export function isMuted() {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
}

export function setMuted(muted) {
  try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* storage blocked — the choice just won't persist */ }
}

// Resumes the audio context from inside the first real user gesture, then
// unhooks itself. Returns a cleanup so a re-render can't stack listeners.
export function installUnlock() {
  if (unlocked) return () => {};
  const events = ['pointerdown', 'keydown', 'touchstart'];
  function unlock() {
    unlocked = true;
    const ctx = getContext();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    events.forEach((e) => window.removeEventListener(e, unlock));
  }
  events.forEach((e) => window.addEventListener(e, unlock, { passive: true }));
  return () => events.forEach((e) => window.removeEventListener(e, unlock));
}

function beep(ctx, freq, startTime, duration, gainPeak) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(gainPeak, startTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.02);
}

// A soft two-note rise — deliberately quieter and gentler than the kiosk's
// chime, since this one goes off in an office while people are working, not
// across a factory floor.
export function playNotification() {
  if (isMuted() || !unlocked) return;
  const ctx = getContext();
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime;
  beep(ctx, 987.77, t, 0.14, 0.14);        // B5
  beep(ctx, 1318.51, t + 0.11, 0.30, 0.12); // E6
}
