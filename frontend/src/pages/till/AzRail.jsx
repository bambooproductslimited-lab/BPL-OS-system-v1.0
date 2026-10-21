import { useRef, useState } from 'react';
import { tr } from '../../lib/i18n.jsx';

// "All items" on the till (RestaurantPosPage.jsx), A to Z: every dish under
// the letter it starts with (dishes starting with a number under 0–9), and
// a bar of letters down the side — tap one, or slide a finger along it, to
// jump there while scrolling. Letters with no dish are dimmed.

export const NUM = '0–9';
const LETTERS = [NUM].concat('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));

// The letter a dish is filed under: its first letter (accents dropped), or 0–9.
export function letterOf(name) {
  const c = String(name || '').trim().normalize('NFD').replace(/[̀-ͯ]/g, '').charAt(0).toUpperCase();
  if (/[0-9]/.test(c)) return NUM;
  return /[A-Z]/.test(c) ? c : '#';
}

// Dishes in A–Z groups: [[letter, items]], each sorted by name.
export function azGroups(items) {
  const by = new Map();
  items.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })).forEach((m) => {
    const l = letterOf(m.name);
    if (!by.has(l)) by.set(l, []);
    by.get(l).push(m);
  });
  return LETTERS.concat(['#']).filter((l) => by.has(l)).map((l) => [l, by.get(l)]);
}

export function sectionId(letter) { return 'az-' + (letter === NUM ? 'num' : letter === '#' ? 'other' : letter); }

export default function AzRail({ letters, scrollRef }) {
  const [active, setActive] = useState(null);
  const rail = useRef(null);
  const have = new Set(letters);
  const shown = LETTERS.concat(have.has('#') ? ['#'] : []);
  function jump(l) {
    if (!have.has(l)) {
      // The nearest letter after it that has dishes (or before, at the end).
      const i = shown.indexOf(l);
      l = shown.slice(i).find((x) => have.has(x)) || shown.slice(0, i).reverse().find((x) => have.has(x));
      if (!l) return;
    }
    setActive(l);
    const box = scrollRef.current;
    const el = box && box.querySelector('#' + sectionId(l));
    if (el && box) box.scrollTo({ top: el.offsetTop - box.offsetTop - 4, behavior: 'auto' });
  }
  function fromPoint(e) {
    const r = rail.current.getBoundingClientRect();
    const i = Math.max(0, Math.min(shown.length - 1, Math.floor(((e.clientY - r.top) / r.height) * shown.length)));
    jump(shown[i]);
  }
  return (
    <div className="az-rail" ref={rail} role="navigation" aria-label={tr('Jump to a letter')}
      onPointerDown={(e) => { e.preventDefault(); if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId); fromPoint(e); }}
      onPointerMove={(e) => { if (e.buttons || e.pointerType === 'touch') fromPoint(e); }}
      onPointerUp={() => setTimeout(() => setActive(null), 500)} onPointerCancel={() => setActive(null)}>
      {shown.map((l) => (
        <button key={l} type="button" tabIndex={have.has(l) ? 0 : -1} className={(have.has(l) ? '' : 'is-empty') + (active === l ? ' is-on' : '')}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(l); } }} aria-label={tr('Dishes starting with {letter}', { letter: l })}>
          {l === NUM ? '#' : l}
        </button>
      ))}
      {active && <span className="az-bubble" aria-hidden="true">{active}</span>}
    </div>
  );
}
