import { useCallback, useEffect, useRef, useState } from 'react';
import { posFetch } from '../lib/posApi';
import { restaurantLogoUrl } from '../lib/restaurantLogos';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import { playOrderReady, unlockAudio } from '../kiosk/kioskSounds';
import './ReadyBoard.css';

// The "ready for pickup" board (backend restaurantBoard): a TV facing the
// customers, opened at /ready-board on the till's website (or in the OS).
// It shows a code until someone types it on the till (More → Ready board),
// then two columns from the kitchen screen — Preparing, and Ready — with
// the order's number and the first name given. A new ready order chimes
// and glows; it leaves when handed over, or half an hour after.

const KEY = 'bamboo.board.key';
function readKey() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } }
function writeKey(v) { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch { /* kept for this visit only */ } }
const POLL_MS = 3000;
const FRESH_MS = 12000;

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 15000); return () => clearInterval(t); }, []);
  return <span className="rb-clock">{now.toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' })}</span>;
}

export default function ReadyBoardPage() {
  const [key, setKey] = useState(readKey);
  const [view, setView] = useState(null);
  const [offline, setOffline] = useState(false);
  const [sound, setSound] = useState(false);
  const seen = useRef(null); // the ready orders already shown
  const [fresh, setFresh] = useState({}); // id → when it became ready here

  const hello = useCallback(async (k) => {
    try {
      const v = await posFetch('POST', '/pos/board/hello', null, { key: k || undefined });
      writeKey(v.key); setKey(v.key); setOffline(false);
    } catch { setOffline(true); }
  }, []);
  useEffect(() => { document.title = tr('Ready for pickup'); hello(readKey()); }, [hello]);

  useEffect(() => {
    if (!key) return undefined;
    let live = true;
    const ask = async () => {
      try {
        const v = await posFetch('GET', '/pos/board', key);
        if (!live) return;
        setView(v); setOffline(false);
        if (v.paired) {
          const ids = v.ready.map((x) => x.id);
          if (seen.current) {
            const added = ids.filter((id) => !seen.current.has(id));
            if (added.length) {
              if (sound) playOrderReady();
              const at = Date.now();
              setFresh((f) => Object.assign({}, f, Object.fromEntries(added.map((id) => [id, at]))));
            }
          }
          seen.current = new Set(ids);
        }
      } catch (err) {
        if (!live) return;
        if (err.status === 401) { writeKey(''); setView(null); seen.current = null; hello(''); } else setOffline(true);
      }
    };
    ask();
    const t = setInterval(ask, POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [key, hello, sound]);
  // The glow fades after a while.
  useEffect(() => {
    const t = setInterval(() => setFresh((f) => Object.fromEntries(Object.entries(f).filter(([, at]) => Date.now() - at < FRESH_MS))), 2000);
    return () => clearInterval(t);
  }, []);

  if (!view) {
    return <div className="rb is-wait"><div className="rb-mid"><span className="rb-spin" aria-hidden="true">🛎️</span><strong>{offline ? tr('No connection. Trying again…') : tr('Starting…')}</strong></div></div>;
  }
  if (!view.paired) {
    return (
      <div className="rb is-pair">
        <div className="rb-mid">
          <span className="rb-pair-art" aria-hidden="true">📺</span>
          <h1>{tr('Ready for pickup board')}</h1>
          <p>{tr('On the till: More → Ready board, then type this code.')}</p>
          <div className="rb-code" aria-label={tr('Code {code}', { code: view.code })}>{String(view.code).split('').map((c, i) => <b key={i} style={{ '--i': i }}>{c}</b>)}</div>
        </div>
      </div>
    );
  }
  const logo = restaurantLogoUrl(view.restaurant.code);
  return (
    <div className="rb" data-brand={view.restaurant.code} onClick={() => { if (!sound) { unlockAudio(); setSound(true); } }}>
      <header className="rb-top">
        <div className="rb-brand">{logo ? <img src={logo} alt="" /> : <span aria-hidden="true">🍽️</span>}<strong>{view.restaurant.name}</strong></div>
        {!sound && <button type="button" className="rb-sound" onClick={(e) => { e.stopPropagation(); unlockAudio(); setSound(true); }}>🔔 {tr('Tap for sound')}</button>}
        {offline && <span className="rb-off">{tr('Reconnecting…')}</span>}
        <Clock />
      </header>
      <main className="rb-cols">
        <section className="rb-col is-prep" aria-labelledby="rb-prep">
          <h2 id="rb-prep"><span aria-hidden="true">👩‍🍳</span>{tr('Preparing')}<small>{view.preparing.length}</small></h2>
          <ul className="rb-list is-plain">
            {view.preparing.map((x) => <li key={x.id} className="rb-card"><b>{x.ref}</b>{x.name && <span>{x.name}</span>}</li>)}
          </ul>
          {!view.preparing.length && <p className="rb-empty">{tr('Nothing cooking right now.')}</p>}
        </section>
        <section className="rb-col is-ready" aria-labelledby="rb-ready" aria-live="polite">
          <h2 id="rb-ready"><span aria-hidden="true">🛎️</span>{tr('Ready, come to the counter')}<small>{view.ready.length}</small></h2>
          <ul className="rb-list is-plain">
            {view.ready.map((x) => <li key={x.id} className={'rb-card' + (fresh[x.id] ? ' is-fresh' : '')}><b>{x.ref}</b>{x.name && <span>{x.name}</span>}</li>)}
          </ul>
          {!view.ready.length && <p className="rb-empty">{tr('Your number shows here when it is ready.')}</p>}
        </section>
      </main>
      <footer className="rb-foot">{tr('Show your number at the counter to collect your order.')}</footer>
    </div>
  );
}
