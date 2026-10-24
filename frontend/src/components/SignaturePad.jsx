import { useEffect, useRef } from 'react';
import './SignaturePad.css';

// A box to sign in with a finger, a pen or the mouse. What is drawn goes up
// as strokes of [x, y] points in a 600 × 200 box, whatever size the box is
// on the screen (backend documentAnswers.service.js checks and keeps them),
// and SignatureView draws them back the same way.
export const SIG_W = 600;
export const SIG_H = 200;

export default function SignaturePad({ strokes, onChange, label }) {
  const canvas = useRef(null);
  const drawing = useRef(null);
  const list = useRef(strokes || []);

  // Redraw everything: on mount, on a resize, and when cleared from outside.
  function paint() {
    const c = canvas.current;
    if (!c) return;
    const ratio = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * ratio)) { c.width = Math.round(w * ratio); c.height = Math.round(h * ratio); }
    const g = c.getContext('2d');
    g.setTransform(ratio * w / SIG_W, 0, 0, ratio * h / SIG_H, 0, 0);
    g.clearRect(0, 0, SIG_W, SIG_H);
    g.lineWidth = 3.2; g.lineCap = 'round'; g.lineJoin = 'round';
    g.strokeStyle = getComputedStyle(c).color || '#1d1d1b';
    list.current.forEach((s) => {
      g.beginPath();
      s.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
      g.stroke();
    });
  }

  useEffect(() => {
    list.current = strokes || [];
    paint();
  }, [strokes]);

  useEffect(() => {
    const onResize = () => paint();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  function at(e) {
    const r = canvas.current.getBoundingClientRect();
    return [Math.round(((e.clientX - r.left) / r.width) * SIG_W), Math.round(((e.clientY - r.top) / r.height) * SIG_H)];
  }
  function down(e) {
    e.preventDefault();
    canvas.current.setPointerCapture(e.pointerId);
    drawing.current = [at(e)];
    list.current = [...list.current, drawing.current];
  }
  function move(e) {
    if (!drawing.current) return;
    const p = at(e), last = drawing.current[drawing.current.length - 1];
    if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 2) return;
    drawing.current.push(p);
    paint();
  }
  function up() {
    if (!drawing.current) return;
    if (drawing.current.length < 2) drawing.current.push([drawing.current[0][0] + 1, drawing.current[0][1] + 1]);
    drawing.current = null;
    paint();
    onChange(list.current.map((s) => s.slice()));
  }

  return (
    <div className="sigpad">
      <canvas ref={canvas} className="sigpad-canvas" aria-label={label} role="img"
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      <div className="sigpad-line" aria-hidden="true" />
    </div>
  );
}

// A signature as it was drawn, for the document's page and the office.
export function SignatureView({ strokes, className }) {
  if (!strokes || !strokes.length) return null;
  return (
    <svg className={'sigview' + (className ? ' ' + className : '')} viewBox={'0 0 ' + SIG_W + ' ' + SIG_H} preserveAspectRatio="xMinYMid meet" aria-hidden="true">
      {strokes.map((s, i) => <polyline key={i} points={s.map((p) => p.join(',')).join(' ')} />)}
    </svg>
  );
}
