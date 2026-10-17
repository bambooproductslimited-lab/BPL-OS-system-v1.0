import { useEffect, useRef, useState } from 'react';
import Photo from './Photo';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import './SlideKit.css';

// The pieces the reviews' slides share (pages/WorkOrdersPresent.jsx,
// pages/crm/SalesPresent.jsx), with their look in SlideKit.css: a number
// that counts up, the score ring, this week against last, and a row of
// faces.

// A number that counts up when its slide comes on (straight to the end when
// printed, or for anyone who asked their device for less motion). format
// writes it (money, say); a whole number if not.
export function CountUp({ value, ms = 900, format }) {
  const ref = useRef(null);
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const el = ref.current;
    const still = !el || el.closest('.wop-print') || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) || typeof value !== 'number';
    if (still) { setShown(value); return undefined; }
    let raf, start;
    const step = (ts) => {
      if (start === undefined) start = ts;
      const k = Math.min(1, (ts - start) / ms);
      const v = value * (1 - Math.pow(1 - k, 3));
      setShown(format ? (k < 1 ? Math.round(v) : value) : Math.round(v));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    setShown(0);
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]); // eslint-disable-line react-hooks/exhaustive-deps
  const text = typeof shown !== 'number' ? shown : format ? format(shown) : shown.toLocaleString(activeIntlLocale());
  return <span ref={ref} className="sk-n">{text}</span>;
}

// The on-time share as a ring.
export function Ring({ pct, label }) {
  const r = 42, c = 2 * Math.PI * r, v = pct === null ? 0 : pct;
  const tone = pct === null ? 'none' : pct >= 80 ? 'good' : pct >= 60 ? 'warn' : 'bad';
  return (
    <div className={'sk-ring is-' + tone}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r={r} className="is-track" />
        <circle cx="50" cy="50" r={r} className="is-fill" strokeDasharray={c} strokeDashoffset={c - (c * v) / 100} transform="rotate(-90 50 50)" />
      </svg>
      <span className="sk-ring-in"><b>{pct === null ? '—' : <><CountUp value={pct} />%</>}</b><small>{label}</small></span>
    </div>
  );
}

// "▲ 3 more than last week".
// format: how to write the difference (money, say); a whole number if not.
export function Delta({ now, before, format }) {
  const d = Math.round((now - before) * 100) / 100;
  if (!d) return <span className="sk-delta">{tr('same as last week')}</span>;
  const n = format ? format(Math.abs(d)) : Math.abs(d);
  return <span className={'sk-delta ' + (d > 0 ? 'is-up' : 'is-down')}>{d > 0 ? '▲ ' + tr('{n} more than last week', { n }) : '▼ ' + tr('{n} less than last week', { n })}</span>;
}

export function Faces({ people, max = 4 }) {
  if (!people.length) return null;
  return (
    <span className="sk-faces">
      {people.slice(0, max).map((p) => <Photo key={p.id} id={p.id} name={p.name} photo={p.photo} size={22} />)}
      {people.length > max && <i>+{people.length - max}</i>}
    </span>
  );
}
