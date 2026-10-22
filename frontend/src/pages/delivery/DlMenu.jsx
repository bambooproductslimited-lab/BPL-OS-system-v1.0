import { useEffect, useMemo, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { tr } from '../../lib/i18n.jsx';

// What the ordering website sells (backend restaurantDelivery onlineMenu):
// each section of the menu with its dishes, each switched on or off. Off,
// customers do not see it on the website; the till still sells it. A whole
// section off hides its dishes whatever their own switch says (kept for
// when the section comes back on). Switches save as they are flipped.
export default function OnlineMenuDialog({ token, onClose, onError }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(null); // what is being switched
  const [q, setQ] = useState('');
  useEffect(() => {
    posFetch('GET', '/pos/delivery/menu', token).then(setData).catch((e) => { onError(e.message); onClose(); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function flip(key, body) {
    setBusy(key);
    try { setData(await posFetch('POST', '/pos/delivery/menu', token, body)); } catch (e) { onError(e.message); } finally { setBusy(null); }
  }
  const shown = useMemo(() => {
    if (!data) return [];
    const words = q.trim().toLowerCase();
    if (!words) return data.categories;
    return data.categories.map((c) => ({ ...c, items: c.items.filter((i) => i.name.toLowerCase().includes(words) || (c.name || '').toLowerCase().includes(words)) })).filter((c) => c.items.length);
  }, [data, q]);
  const anyOff = data && data.categories.some((c) => !c.on || c.items.some((i) => !i.on));

  return (
    <div className="dialog-backdrop dl-over" onClick={onClose}>
      <div className="dialog dl-send dl-menu" role="dialog" aria-modal="true" aria-labelledby="dl-menu-title" onClick={(e) => e.stopPropagation()}>
        <div className="dl-send-head">
          <span className="dl-send-ico is-menu" aria-hidden="true">🍽️</span>
          <div>
            <h2 id="dl-menu-title">{tr('What the website sells')}</h2>
            <p className="dk-muted">{data ? tr('{on} of {all} dishes on the website.', { on: data.totals.onWebsite, all: data.totals.dishes }) + ' ' : ''}{tr('Off, customers do not see it online; the till still sells it.')}</p>
          </div>
        </div>
        {!data ? <p className="dk-muted">{tr('Loading the menu…')}</p> : (
          <>
            <div className="dl-menu-tools">
              <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Search the menu')} aria-label={tr('Search the menu')} />
              {anyOff && <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={() => flip('all', { allOn: true })}>{tr('Everything on')}</button>}
            </div>
            {!shown.length && <p className="dk-muted">{tr('Nothing called that')}</p>}
            <div className="dl-menu-list">
              {shown.map((c) => {
                const on = c.items.filter((i) => i.on).length;
                return (
                  <section key={c.name} className={'dl-menu-sec' + (c.on ? '' : ' is-off')}>
                    <header>
                      <div><strong>{c.name || tr('Other')}</strong>
                        <small>{c.on ? tr('{on} of {all} on the website', { on, all: c.items.length }) : tr('The whole section is off the website')}</small></div>
                      <Switch on={c.on} busy={busy === 'c:' + c.name} label={tr('{name} on the website', { name: c.name || tr('Other') })} onFlip={() => flip('c:' + c.name, { category: c.name, on: !c.on })} />
                    </header>
                    <ul className="is-plain">
                      {c.items.map((i) => (
                        <li key={i.id} className={i.on && c.on ? '' : 'is-off'}>
                          {i.photoUrl ? <img src={i.photoUrl} alt="" loading="lazy" /> : <span className="dl-menu-ph" aria-hidden="true">{(i.name || '?').charAt(0)}</span>}
                          <span className="dl-menu-name"><b>{i.name}</b><small>{money(i.price)}{i.soldOut ? ' · ' + tr('Sold out') : ''}{!c.on && i.on ? ' · ' + tr('off with its section') : ''}</small></span>
                          <Switch on={i.on} busy={busy === i.id} label={tr('{name} on the website', { name: i.name })} onFlip={() => flip(i.id, { itemId: i.id, on: !i.on })} />
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          </>
        )}
        <div className="dialog-actions"><button type="button" className="btn btn-primary" onClick={onClose}>{tr('Done')}</button></div>
      </div>
    </div>
  );
}

function Switch({ on, busy, label, onFlip }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={label} className={'dl-sw' + (on ? ' is-on' : '')} disabled={busy} onClick={onFlip}>
      <span className={'ts-switch' + (on ? ' is-on' : '')} aria-hidden="true"><i /></span>
      <em>{on ? tr('On') : tr('Off')}</em>
    </button>
  );
}
