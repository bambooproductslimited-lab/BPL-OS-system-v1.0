import { useCallback, useEffect, useMemo, useState } from 'react';
import { posFetch } from '../lib/posApi';
import { money } from '../lib/currency';
import { restaurantLogoUrl } from '../lib/restaurantLogos';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import { photo, tint } from './online/onlineShared';
import './MenuBoard.css';

// A menu board (backend restaurantMenuBoards, migration 0195): a TV in the
// restaurant opened at /menu-board on the till's website. It shows a code
// until a manager types it in the back office (Setup → Menu boards); then
// the menu chosen, a page at a time — happy-hour prices while they are on,
// sold out greyed, a menu outside its hours dimmed — and, if asked, the
// orders ready for pickup beside it.

const KEY = 'bamboo.menuboard.key';
function readKey() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } }
function writeKey(v) { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch { /* kept for this visit only */ } }

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 15000); return () => clearInterval(t); }, []);
  return <span className="mb-clock">{now.toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' })}</span>;
}

// The menu cut into pages: as many dishes as fit, a category's name again
// on the page it carries on.
function pagesOf(sections, perPage) {
  const pages = [];
  let page = [], room = perPage;
  sections.forEach((s) => {
    let i = 0;
    while (i < s.items.length) {
      if (room < 2 && page.length) { pages.push(page); page = []; room = perPage; }
      const take = s.items.slice(i, i + room);
      page.push({ category: s.category, more: i > 0, items: take });
      room -= take.length; i += take.length;
      if (room <= 0) { pages.push(page); page = []; room = perPage; }
    }
  });
  if (page.length) pages.push(page);
  return pages.length ? pages : [[]];
}

function Price({ price, happy, show }) {
  if (!show) return null;
  return happy != null
    ? <span className="mb-price is-happy"><s>{money(price)}</s><b>{money(happy)}</b></span>
    : <span className="mb-price"><b>{money(price)}</b></span>;
}

export default function MenuBoardPage() {
  const [key, setKey] = useState(readKey);
  const [view, setView] = useState(null);
  const [offline, setOffline] = useState(false);
  const [at, setAt] = useState(0);

  const hello = useCallback(async (k) => {
    try {
      const v = await posFetch('POST', '/pos/menu-board/hello', null, { key: k || undefined });
      writeKey(v.key); setKey(v.key); setOffline(false);
    } catch { setOffline(true); }
  }, []);
  useEffect(() => { document.title = tr('Menu'); hello(readKey()); }, [hello]);

  const ready = !!(view && view.options && view.options.ready);
  useEffect(() => {
    if (!key) return undefined;
    let live = true;
    const ask = async () => {
      try {
        const v = await posFetch('GET', '/pos/menu-board', key);
        if (live) { setView(v); setOffline(false); }
      } catch (err) {
        if (!live) return;
        if (err.status === 401) { writeKey(''); setView(null); hello(''); } else setOffline(true);
      }
    };
    ask();
    const t = setInterval(ask, ready ? 6000 : 20000);
    return () => { live = false; clearInterval(t); };
  }, [key, hello, ready]);

  const o = view && view.options;
  const perPage = o ? (o.layout === 'list' ? (ready ? 14 : 20) : o.photos ? (ready ? 6 : 8) : (ready ? 9 : 12)) : 8;
  const pages = useMemo(() => (view && view.paired ? pagesOf(view.sections, perPage) : [[]]), [view, perPage]);
  const rotate = o ? o.rotate : 12;
  useEffect(() => {
    if (pages.length < 2) { setAt(0); return undefined; }
    const t = setInterval(() => setAt((a) => (a + 1) % pages.length), rotate * 1000);
    return () => clearInterval(t);
  }, [pages.length, rotate]);

  if (!view) {
    return <div className="mb is-wait"><div className="mb-mid"><span className="mb-spin" aria-hidden="true">🍽️</span><strong>{offline ? tr('No connection. Trying again…') : tr('Starting…')}</strong></div></div>;
  }
  if (!view.paired) {
    return (
      <div className="mb is-pair is-night">
        <div className="mb-mid">
          <span className="mb-pair-art" aria-hidden="true">📺</span>
          <h1>{tr('Menu board')}</h1>
          <p>{tr('In the till\'s back office: Setup → Menu boards, then type this code.')}</p>
          <div className="mb-code" aria-label={tr('Code {code}', { code: view.code })}>{String(view.code).split('').map((c, i) => <b key={i} style={{ '--i': i }}>{c}</b>)}</div>
        </div>
      </div>
    );
  }
  const logo = restaurantLogoUrl(view.restaurant.code);
  const page = pages[Math.min(at, pages.length - 1)];
  return (
    <div className={'mb is-' + o.theme + ' is-' + o.layout + (ready ? ' has-ready' : '')} data-brand={view.restaurant.code}>
      <header className="mb-top">
        <div className="mb-brand">{logo ? <img src={logo} alt="" /> : <span aria-hidden="true">🍽️</span>}<strong>{o.title || view.restaurant.name}</strong></div>
        {view.happy.length > 0 && (
          <div className="mb-happy" role="note">
            <span aria-hidden="true">🍹</span>
            {view.happy.map((h, i) => <span key={i}><b>{h.name}</b> {tr('{n}% off until {time}', { n: h.percent, time: h.to })}</span>)}
          </div>
        )}
        {offline && <span className="mb-off">{tr('Reconnecting…')}</span>}
        <Clock />
      </header>
      <div className="mb-body">
        <main className="mb-page" key={at} aria-live="polite">
          {page.map((block, bi) => (
            <section key={block.category + bi} className="mb-sec" style={{ '--i': bi }}>
              <h2>{block.category}{block.more && <small> · {tr('more')}</small>}</h2>
              <ul className="mb-items">
                {block.items.map((it, i) => (
                  <li key={it.id} className={'mb-item' + (it.soldOut ? ' is-out' : '') + (it.notNow ? ' is-later' : '') + (it.happyPrice != null ? ' is-happy' : '')} style={{ '--i': i, '--c': tint(it.name) }}>
                    {o.layout === 'grid' && o.photos && (
                      <span className="mb-pic">{it.photo ? <img src={photo(it.photo)} alt="" /> : <b aria-hidden="true">{it.name.replace(/\s*\(zq\)\s*/i, '').replace(/^zq\s+/i, '').charAt(0)}</b>}</span>
                    )}
                    <span className="mb-name">
                      <strong>{it.name}</strong>
                      {it.variations.length > 0 && o.prices && <small>{it.variations.map((v) => v.name + ' ' + money(v.happyPrice != null ? v.happyPrice : v.price)).join(' · ')}</small>}
                      {it.soldOut ? <em className="mb-tag is-out">{tr('Sold out today')}</em> : it.notNow && it.hours ? <em className="mb-tag">{tr('From {time}', { time: it.hours.from })}</em> : it.happyPrice != null ? <em className="mb-tag is-happy">🍹 {tr('Happy hour')}</em> : null}
                    </span>
                    {!it.variations.length && <Price price={it.price} happy={it.happyPrice} show={o.prices} />}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </main>
        {ready && view.ready && (
          <aside className="mb-ready" aria-label={tr('Ready for pickup')}>
            <h2>🛎️ {tr('Ready')}</h2>
            <ul>{view.ready.ready.slice(0, 8).map((x) => <li key={x.id} className="is-ready"><b>{x.ref}</b>{x.name && <span>{x.name}</span>}</li>)}</ul>
            {!view.ready.ready.length && <p>{tr('Your number shows here when it is ready.')}</p>}
            <h3>👩‍🍳 {tr('Preparing')}</h3>
            <ul className="is-prep">{view.ready.preparing.slice(0, 10).map((x) => <li key={x.id}><b>{x.ref}</b></li>)}</ul>
          </aside>
        )}
      </div>
      {pages.length > 1 && (
        <footer className="mb-foot">
          <span className="mb-dots">{pages.map((p, i) => <i key={i} className={i === at ? 'is-on' : ''} />)}</span>
          <span className="mb-bar" key={at} style={{ '--t': rotate + 's' }}><i /></span>
        </footer>
      )}
    </div>
  );
}
