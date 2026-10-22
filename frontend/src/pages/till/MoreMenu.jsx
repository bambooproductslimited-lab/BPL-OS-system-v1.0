import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/DashKit';
import { tr } from '../../lib/i18n.jsx';

// The till's top bar keeps what is used all the time (the shift, the drawer,
// the kitchen, open orders, log out); the rest waits behind "More": VIP,
// IOUs, refunds, the settings, the kitchen screen, the printer, light,
// dark or glass, the language. items: [{ key, icon (DashKit name or a node), label,
// note, badge, tone, onClick, href }]; extra: anything else at the foot.
export default function MoreMenu({ items, extra }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    function away(e) { if (box.current && !box.current.contains(e.target)) setOpen(false); }
    function esc(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const shown = items.filter(Boolean);
  const dots = shown.filter((i) => i.badge).length;
  return (
    <div className="tl-more" ref={box}>
      <button type="button" className={'btn btn-secondary tl-btn tl-more-btn' + (open ? ' is-open' : '')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="tl-more-dots" aria-hidden="true"><i /><i /><i /></span><span>{tr('More')}</span>
        {dots > 0 && !open && <b className="tl-more-badge" aria-label={tr('{n} need a look', { n: dots })}>{dots}</b>}
      </button>
      {open && (
        <div className="tl-more-menu" role="menu">
          {shown.map((it) => {
            const body = (
              <>
                <span className={'tl-more-ico' + (it.tone ? ' is-' + it.tone : '')} aria-hidden="true">{typeof it.icon === 'string' ? <Icon name={it.icon} /> : it.icon}</span>
                <span className="tl-more-text"><strong>{it.label}</strong>{it.note && <small>{it.note}</small>}</span>
                {it.badge ? <b className="tl-more-count">{it.badge}</b> : null}
              </>
            );
            return it.href ? (
              <a key={it.key} role="menuitem" className="tl-more-item" href={it.href} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>{body}</a>
            ) : (
              <button key={it.key} type="button" role="menuitem" className="tl-more-item" disabled={it.disabled} onClick={() => { setOpen(false); it.onClick(); }}>{body}</button>
            );
          })}
          {extra && <div className="tl-more-extra">{extra}</div>}
        </div>
      )}
    </div>
  );
}
