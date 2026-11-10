import { msg } from '../lib/i18n.jsx';
import { audioContext } from './kioskSounds';

// The kitchen screen's tones (pages/KdsPage.jsx, till/KdsSounds.jsx): a few
// to choose from for a new ticket and for an order all ready, each screen
// its own (the grill and the bar can sound different), at its own volume,
// and, if asked, rung again until someone touches the screen. Synthesized
// like the kiosk's (kioskSounds.js): nothing to load, so they work with no
// internet too. Through a compressor, so loud stays clean over a kitchen.

// A note: [frequency, start (s), length (s), wave, peak, slide to (Hz)?]
const BELL = (f, t, peak) => [[f, t, 1.3, 'sine', peak], [f * 2.76, t, 0.5, 'sine', peak * 0.3], [f * 5.4, t, 0.18, 'sine', peak * 0.12]];
export const TONES = [
  { id: 'triple', name: msg('Triple ding'), notes: [[1046.5, 0, 0.14, 'triangle', 0.5], [1318.5, 0.15, 0.14, 'triangle', 0.5], [1568, 0.3, 0.4, 'triangle', 0.55]] },
  { id: 'bell', name: msg('Service bell'), notes: BELL(1760, 0, 0.45).concat(BELL(1760, 0.42, 0.4)) },
  { id: 'chime', name: msg('Chime'), notes: [[1568, 0, 0.7, 'sine', 0.45], [1318.5, 0.2, 0.7, 'sine', 0.45], [1046.5, 0.4, 0.9, 'sine', 0.45]] },
  { id: 'marimba', name: msg('Marimba'), notes: [[784, 0, 0.32, 'sine', 0.55], [988, 0.1, 0.32, 'sine', 0.55], [1175, 0.2, 0.32, 'sine', 0.55], [1568, 0.3, 0.5, 'sine', 0.6]] },
  { id: 'double', name: msg('Double beep'), notes: [[1000, 0, 0.13, 'square', 0.22], [1000, 0.2, 0.13, 'square', 0.22]] },
  { id: 'buzzer', name: msg('Buzzer'), notes: [[220, 0, 0.45, 'sawtooth', 0.3], [233, 0, 0.45, 'sawtooth', 0.22], [220, 0.6, 0.45, 'sawtooth', 0.3], [233, 0.6, 0.45, 'sawtooth', 0.22]] },
  { id: 'dingdong', name: msg('Ding-dong'), notes: [[1174.7, 0, 0.6, 'sine', 0.5], [880, 0.32, 1, 'sine', 0.5]] }
];
export const REPEATS = [0, 15, 30, 60]; // seconds; 0: once

// Plays a tone at a volume (0.1 to 1); returns how long it lasts (s).
export function playTone(id, volume) {
  const tone = TONES.find((t) => t.id === id) || TONES[0];
  const ctx = audioContext();
  if (!ctx) return 0;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const out = ctx.createGain();
  out.gain.value = 0.4 + 1.6 * Math.max(0.1, Math.min(1, Number(volume) || 0.8)); // up to twice the old ding
  const squash = ctx.createDynamicsCompressor ? ctx.createDynamicsCompressor() : null;
  if (squash) { squash.threshold.value = -10; squash.ratio.value = 8; out.connect(squash); squash.connect(ctx.destination); } else out.connect(ctx.destination);
  const t0 = ctx.currentTime + 0.02;
  let end = 0;
  tone.notes.forEach(([f, at, len, wave, peak, slide]) => {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const t = t0 + at;
    osc.type = wave;
    osc.frequency.setValueAtTime(f, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(slide, t + len);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    osc.connect(g); g.connect(out);
    osc.start(t); osc.stop(t + len + 0.05);
    end = Math.max(end, at + len);
  });
  return end;
}

// This screen's sound settings, kept on the tablet.
const KEY = 'bamboo.kds.sounds';
const OLD_KEY = 'bamboo.kds.sound'; // the bell's on/off before there were tones
export const SOUND_DEFAULTS = { on: true, newTone: 'triple', readyTone: 'dingdong', volume: 0.8, repeat: 0 };
export function loadSounds() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { s = null; }
  if (!s) { let old = null; try { old = localStorage.getItem(OLD_KEY); } catch { old = null; } s = { on: old !== 'off' }; }
  const ok = (id) => TONES.some((t) => t.id === id);
  return {
    on: s.on !== false,
    newTone: ok(s.newTone) ? s.newTone : SOUND_DEFAULTS.newTone,
    readyTone: ok(s.readyTone) ? s.readyTone : SOUND_DEFAULTS.readyTone,
    volume: Math.max(0.1, Math.min(1, Number(s.volume) || SOUND_DEFAULTS.volume)),
    repeat: REPEATS.includes(Number(s.repeat)) ? Number(s.repeat) : 0
  };
}
export function saveSounds(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); localStorage.setItem(OLD_KEY, s.on ? 'on' : 'off'); } catch { /* kept for this visit only */ }
}
