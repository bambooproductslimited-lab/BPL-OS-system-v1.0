import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { THEMES } from '../lib/theme';
import { tr } from '../lib/i18n.jsx';
import './ThemeSwitch.css';

// Light, dark or glass (lib/theme.js, styles/glass.css), the same switch on
// every screen: the OS header and sign-in, the till, the kitchen screen, the
// kiosk, the delivery screen and the restaurant websites. A button showing
// the mode in use; it opens a small "Appearance" card with a preview of
// each, the way a phone's settings show them; it stays open, so the
// modes can be tried one after the other. ThemeChoice is the card's
// choices alone, for a menu that already has room (the till's More).

const NAMES = { light: () => tr('Light'), dark: () => tr('Dark'), glass: () => tr('Glass') };
const GLYPHS = {
  light: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" /></>,
  dark: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  // two panes of glass, one over the other, with a shine on the front one
  glass: <><rect x="3" y="3" width="13" height="13" rx="3.5" /><rect x="8" y="8" width="13" height="13" rx="3.5" fill="currentColor" fillOpacity=".16" /><path d="M11.5 14.5l3-3M11.5 18l6.5-6.5" strokeWidth="1.4" /></>
};

export function ThemeGlyph({ theme, className }) {
  return (
    <svg className={'thm-glyph' + (className ? ' ' + className : '')} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {GLYPHS[theme] || GLYPHS.light}
    </svg>
  );
}

// The three modes side by side. compact: a row of small pills (icon and
// name); otherwise a little picture of each.
export function ThemeChoice({ theme, onChange, compact, onPicked }) {
  return (
    <div className={'thm-choice' + (compact ? ' is-compact' : '')} role="radiogroup" aria-label={tr('Appearance')}>
      {THEMES.map((t) => (
        <button key={t} type="button" role="radio" aria-checked={t === theme} className={'thm-opt is-' + t + (t === theme ? ' is-on' : '')}
          onClick={() => { onChange(t); if (onPicked) onPicked(t); }}>
          {compact ? <ThemeGlyph theme={t} /> : (
            <span className={'thm-prev is-' + t} aria-hidden="true">
              <i className="thm-prev-blob is-a" /><i className="thm-prev-blob is-b" />
              <span className="thm-prev-win"><b /><b /><b /></span>
            </span>
          )}
          <span className="thm-name">{NAMES[t]()}</span>
        </button>
      ))}
    </div>
  );
}

export default function ThemeSwitch({ theme, onChange, className }) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const card = useRef(null);
  const name = (NAMES[theme] || NAMES.light)();

  // Under the button, kept on the screen; above it when there is no room
  // below. Placed on the page itself (a portal), so a header that hides
  // what overflows it cannot cut it off.
  useLayoutEffect(() => {
    if (!open || !btn.current || !card.current) return;
    const r = btn.current.getBoundingClientRect();
    const w = card.current.offsetWidth;
    const h = card.current.offsetHeight;
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    const below = r.bottom + 8;
    const top = below + h > window.innerHeight - 8 && r.top - 8 - h > 8 ? r.top - 8 - h : below;
    card.current.style.left = left + 'px';
    card.current.style.top = top + 'px';
    const on = card.current.querySelector('.thm-opt.is-on');
    if (on) on.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    function esc(e) { if (e.key === 'Escape') { setOpen(false); if (btn.current) btn.current.focus(); } }
    function gone() { setOpen(false); }
    document.addEventListener('keydown', esc);
    window.addEventListener('resize', gone);
    return () => { document.removeEventListener('keydown', esc); window.removeEventListener('resize', gone); };
  }, [open]);

  return (
    <>
      <button ref={btn} type="button" className={className} aria-haspopup="dialog" aria-expanded={open}
        aria-label={tr('Appearance: {mode}', { mode: name })} title={tr('Appearance: {mode}', { mode: name })} onClick={() => setOpen(!open)}>
        <ThemeGlyph theme={theme} />
      </button>
      {open && createPortal(
        <div className="thm-layer" onPointerDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div ref={card} className="thm-card" role="dialog" aria-label={tr('Appearance')}>
            <div className="thm-head"><strong>{tr('Appearance')}</strong><small>{tr('Kept on this device')}</small></div>
            <ThemeChoice theme={theme} onChange={onChange} />
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
