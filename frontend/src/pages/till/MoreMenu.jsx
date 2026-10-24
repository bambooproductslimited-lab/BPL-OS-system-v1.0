import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../components/DashKit';
import { tr } from '../../lib/i18n.jsx';

// The till's top bar keeps what is used all the time (the shift, the
// kitchen, open orders, log out); the rest waits behind "More", sorted into
// groups so a cashier finds it at a glance: money and accounts, orders and
// guests, screens and devices, managing the restaurant. groups: [{ key,
// label, emoji }] in the order shown; items: [{ key, group, icon (DashKit
// name or a node), label, note, badge, tone, onClick, href }]; extra:
// anything else at the foot (light, dark or glass; the language).
export default function MoreMenu({ groups, items, extra }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  const panel = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    function away(e) {
      if (box.current && box.current.contains(e.target)) return;
      if (panel.current && panel.current.contains(e.target)) return;
      setOpen(false);
    }
    function esc(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const shown = items.filter(Boolean);
  const dots = shown.filter((i) => i.badge).length;
  const sections = groups.map((g) => ({ ...g, items: shown.filter((i) => i.group === g.key) })).filter((g) => g.items.length);

  function item(it) {
    const body = (
      <>
        <span className={'tl-more-ico' + (it.tone ? ' is-' + it.tone : '')} aria-hidden="true">{typeof it.icon === 'string' ? <Icon name={it.icon} /> : it.icon}</span>
        <span className="tl-more-text"><strong>{it.label}</strong>{it.note && <small>{it.note}</small>}</span>
        {it.badge ? <b className="tl-more-count">{it.badge}</b> : null}
      </>
    );
    return it.href ? (
      <a key={it.key} role="menuitem" className="tl-more-item" href={it.href} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>{body}<span className="tl-more-out" aria-hidden="true">↗</span></a>
    ) : (
      <button key={it.key} type="button" role="menuitem" className="tl-more-item" disabled={it.disabled} onClick={() => { setOpen(false); it.onClick(); }}>{body}</button>
    );
  }

  return (
    <div className="tl-more" ref={box}>
      <button type="button" className={'btn btn-secondary tl-btn tl-more-btn' + (open ? ' is-open' : '')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="tl-more-dots" aria-hidden="true"><i /><i /><i /></span><span>{tr('More')}</span>
        {dots > 0 && !open && <b className="tl-more-badge" aria-label={tr('{n} need a look', { n: dots })}>{dots}</b>}
      </button>
      {/* At the page's root: a header that blurs what is behind it would
          otherwise hold the panel inside itself. */}
      {open && createPortal(
        <div className="dk pos-till tl-more-layer">
          <div className="tl-more-scrim" aria-hidden="true" />
          <div className="tl-more-menu is-grouped" role="menu" aria-label={tr('More')} ref={panel}>
            <div className="tl-more-groups">
              {sections.map((g) => (
                <section key={g.key} className={'tl-more-group is-' + g.key} aria-label={g.label}>
                  <h3 className="tl-more-head"><span aria-hidden="true">{g.emoji}</span>{g.label}</h3>
                  <div className="tl-more-list">{g.items.map(item)}</div>
                </section>
              ))}
            </div>
            {extra && <div className="tl-more-extra">{extra}</div>}
          </div>
        </div>, document.body
      )}
    </div>
  );
}
