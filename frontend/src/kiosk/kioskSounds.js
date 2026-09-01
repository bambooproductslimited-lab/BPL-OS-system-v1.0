// Kiosk audio feedback — synthesized with the Web Audio API rather than
// shipped as sound files, since the kiosk is designed to work with zero
// connectivity (see kiosk-sw.js): a synthesized tone can never fail to
// load or go stale in a cache, and there's nothing extra to precache.
//
// iOS Safari only lets an AudioContext produce sound once it's been
// resumed from inside a user-gesture call stack. unlockAudio() is called
// synchronously from the keypad's onClick (before the PIN submit's await),
// so the context is already 'running' by the time a result comes back and
// the actual chime plays.

let audioCtx = null;

function getContext() {
  if (audioCtx) return audioCtx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  audioCtx = new Ctor();
  return audioCtx;
}

export function unlockAudio() {
  const ctx = getContext();
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}

function beep(ctx, freq, type, startTime, duration, gainPeak) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(gainPeak, startTime + 0.015);
  gain.gain.linearRampToValueAtTime(0, startTime + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.02);
}

// notes: array of [frequency, duration, gapAfter]
function playSequence(notes, type) {
  const ctx = getContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  let t = ctx.currentTime;
  notes.forEach(([freq, duration, gap]) => {
    beep(ctx, freq, type, t, duration, 0.25);
    t += duration + (gap || 0);
  });
}

export function playClockIn() {
  playSequence([[880, 0.12, 0.03], [1318.5, 0.18, 0]], 'sine'); // rising chime
}

export function playClockOut() {
  playSequence([[1318.5, 0.12, 0.03], [880, 0.18, 0]], 'sine'); // falling chime
}

export function playWrongPin() {
  playSequence([[220, 0.14, 0.06], [220, 0.14, 0]], 'square'); // low double buzz
}
