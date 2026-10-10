import { useEffect, useState } from 'react';
import PrintLayer from './PrintLayer';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import './SlideDeck.css';

// The Saturday reviews' slide show (the work orders',
// pages/WorkOrdersPresent.jsx, and the sales team's,
// pages/crm/SalesPresent.jsx): a week to pick, slides on a dark stage,
// arrow keys or the buttons to move, F for full screen, and one slide a
// page when printed or saved as PDF. The review gives the slides and how
// to draw each one; paused stops the keys while a window is open over it.

function isoDay(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
export function addDays(iso, n) { const d = new Date(iso + 'T00:00'); d.setDate(d.getDate() + n); return isoDay(d); }
export function mondayOf(iso) { const d = new Date(iso + 'T00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return isoDay(d); }
export function weekLabel(from, to) {
  const a = new Date(from + 'T00:00'), b = new Date(to + 'T00:00');
  const loc = activeIntlLocale();
  const end = b.toLocaleDateString(loc, { day: 'numeric', month: 'long', year: 'numeric' });
  return a.getMonth() === b.getMonth() && !/^(zh|ja)/.test(loc)
    ? a.toLocaleDateString(loc, { day: 'numeric' }) + ' – ' + end
    : a.toLocaleDateString(loc, { day: 'numeric', month: 'long' }) + ' – ' + end;
}
// This week and the three before it, for the week picker.
export function recentWeeks(thisMonday, n = 4) {
  return Array.from({ length: n }, (_, i) => {
    const from = addDays(thisMonday, -7 * i), dates = weekLabel(from, addDays(from, 6));
    return { from, label: i === 0 ? tr('This week ({dates})', { dates }) : i === 1 ? tr('Last week ({dates})', { dates }) : dates };
  });
}

export default function SlideDeck({ brand, className = '', weeks, weekFrom, onWeek, slides, render, onClose, paused }) {
  const [at, setAt] = useState(0);
  const [printing, setPrinting] = useState(false);
  const cur = Math.min(at, Math.max(0, slides.length - 1));

  useEffect(() => { setAt(0); }, [weekFrom]);
  useEffect(() => {
    function onKey(e) {
      if (paused || e.target.closest('select, input, textarea')) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); setAt((i) => Math.min(i + 1, slides.length - 1)); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); setAt((i) => Math.max(i - 1, 0)); }
      else if (e.key === 'Home') setAt(0);
      else if (e.key === 'End') setAt(slides.length - 1);
      else if (e.key === 'Escape' && !document.fullscreenElement) onClose();
      else if (e.key === 'f' || e.key === 'F') fullScreen();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!printing) return undefined;
    const done = () => setPrinting(false);
    window.addEventListener('afterprint', done);
    const id = setTimeout(() => window.print(), 300);
    return () => { clearTimeout(id); window.removeEventListener('afterprint', done); };
  }, [printing]);

  // The whole page goes full screen, not only the slides, so a window opened
  // from a slide still shows over them.
  function fullScreen() {
    const el = document.documentElement;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  }

  return (
    <PrintLayer>
      <div className={'wop ' + className + (printing ? ' is-printing' : '')} role="dialog" aria-modal="true" aria-label={brand}>
        <div className="wop-bar no-print">
          <strong className="wop-brand">{brand}</strong>
          <select className="wop-week" value={weekFrom} onChange={(e) => onWeek(e.target.value)} aria-label={tr('Which week')}>
            {weeks.map((w) => <option key={w.from} value={w.from}>{w.label}</option>)}
          </select>
          <span className="wop-fill" />
          <button type="button" className="wop-btn" onClick={fullScreen} title={tr('Full screen (F)')}>{tr('Full screen')}</button>
          <button type="button" className="wop-btn" disabled={!slides.length} onClick={() => setPrinting(true)}>{tr('Print or save as PDF')}</button>
          <button type="button" className="wop-btn is-close" onClick={onClose} aria-label={tr('Close')}>×</button>
        </div>
        {printing ? (
          <div className="wop-print">
            {slides.map((sl) => <section key={sl.key} className={'wop-slide is-' + sl.kind}>{render(sl)}</section>)}
          </div>
        ) : (
          <div className="wop-stage">
            {slides.length > 0 && <section key={slides[cur].key} className={'wop-slide is-' + slides[cur].kind}>{render(slides[cur])}</section>}
          </div>
        )}
        <p className="wop-turn no-print">{tr('Best on a TV or laptop, or with the phone turned sideways.')}</p>
        <div className="wop-nav no-print">
          <button type="button" className="wop-btn" disabled={cur === 0} onClick={() => setAt(cur - 1)} aria-label={tr('Previous slide')}>←</button>
          <span className="wop-dots">
            {slides.map((sl, i) => <button key={sl.key} type="button" className={'wop-dot' + (i === cur ? ' is-on' : '')} onClick={() => setAt(i)} aria-label={tr('Slide {n}', { n: i + 1 })} />)}
          </span>
          <span className="wop-count">{tr('{a} of {b}', { a: slides.length ? cur + 1 : 0, b: slides.length })}</span>
          <button type="button" className="wop-btn" disabled={cur >= slides.length - 1} onClick={() => setAt(cur + 1)} aria-label={tr('Next slide')}>→</button>
        </div>
      </div>
    </PrintLayer>
  );
}
