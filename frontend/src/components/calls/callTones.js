import { getContext } from '../../lib/notificationSound';

// The sounds of a call, made in the browser (no sound file to load):
//
// - 'incoming': someone is calling me. A loud, bright double ring, like a
//   phone's own: a fast warble for a second, a short gap, again, then a
//   pause — repeated until I answer, decline, or it stops ringing. Loud on
//   purpose: it has to be heard across a room, over a factory floor or a
//   kitchen. It runs through a compressor so it is loud without clipping.
// - 'ringback': I am calling and it is ringing at the other end. The
//   familiar ring-ring (400 + 450 Hz, as on phone lines in Ghana and the
//   UK), quieter than the incoming ring since it is in my own ear.
//
// Browsers only play sound once the person has tapped or typed somewhere in
// the OS; notificationSound.js unlocks the shared context on that first
// gesture, and the call screen offers "tap to hear" otherwise.

const PATTERNS = {
  incoming: { every: 3.2, volume: 0.95 },
  ringback: { every: 3.0, volume: 0.45 },
};

function warble(ctx, out, at, len) {
  // Two bright tones swapping 20 times a second: the classic phone trill.
  const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain();
  o1.type = 'square'; o2.type = 'triangle';
  const steps = Math.round(len / 0.05);
  for (let i = 0; i < steps; i++) {
    const f = i % 2 ? 1046 : 830;
    o1.frequency.setValueAtTime(f, at + i * 0.05);
    o2.frequency.setValueAtTime(f * 1.5, at + i * 0.05);
  }
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(0.5, at + 0.02);
  g.gain.setValueAtTime(0.5, at + len - 0.04);
  g.gain.exponentialRampToValueAtTime(0.0001, at + len);
  o1.connect(g); o2.connect(g); g.connect(out);
  [o1, o2].forEach((o) => { o.start(at); o.stop(at + len + 0.02); });
}

function burr(ctx, out, at, len) {
  // 400 Hz and 450 Hz together: the ring you hear when calling a phone.
  [400, 450].forEach((f) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.5, at + 0.02);
    g.gain.setValueAtTime(0.5, at + len - 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, at + len);
    o.connect(g).connect(out);
    o.start(at); o.stop(at + len + 0.02);
  });
}

// Starts a tone; returns a function that stops it.
export function startCallTone(kind) {
  const pattern = PATTERNS[kind];
  let ctx = null;
  try { ctx = getContext(); } catch { /* no Web Audio */ }
  let out = null, timer = null, stopped = false;
  if (ctx) {
    try {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12; comp.knee.value = 6; comp.ratio.value = 8;
      out = ctx.createGain();
      out.gain.value = pattern.volume;
      out.connect(comp).connect(ctx.destination);
    } catch { out = null; }
  }
  const once = () => {
    if (stopped) return;
    if (out) {
      try {
        const t = ctx.currentTime + 0.03;
        if (kind === 'incoming') { warble(ctx, out, t, 1.0); warble(ctx, out, t + 1.25, 1.0); }
        else { burr(ctx, out, t, 0.4); burr(ctx, out, t + 0.6, 0.4); }
      } catch { /* sound not allowed yet — the screen still shows it */ }
    }
    if (kind === 'incoming') { try { if (navigator.vibrate) navigator.vibrate([600, 250, 600]); } catch { /* not a phone */ } }
  };
  once();
  timer = setInterval(once, pattern.every * 1000);
  return () => {
    stopped = true;
    clearInterval(timer);
    // Cut it off now rather than letting the last ring finish.
    if (out) { try { out.gain.setValueAtTime(0, ctx.currentTime); out.disconnect(); } catch { /* gone */ } }
    try { if (navigator.vibrate) navigator.vibrate(0); } catch { /* not a phone */ }
  };
}
