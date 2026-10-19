import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { posFetch } from '../lib/posApi';
import { restaurantLogoUrl } from '../lib/restaurantLogos';
import DeviceLanguage from '../components/DeviceLanguage';
import { unlockAudio, playNewTicket } from '../kiosk/kioskSounds';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import { applyTheme, clearTheme, getInitialTheme, THEME_KEY } from '../lib/theme';
import '../components/DashKit.css';
import './RestaurantPosPage.css';
import './KdsPage.css';

// The kitchen display (KDS) — a full-screen page for a screen in the
// kitchen, at /kds, outside the app's sign-in like the till and the kiosk.
// A cook opens it with their staff PIN (the till's: restaurantPos.service.js
// login), which scopes it to their restaurant, and picks the station it
// stands at ("Chinese kitchen", "Bar"…) or all of them.
//
// What the till sends (an open table's new round, or a sale when it is
// charged — restaurantKitchen.service.js fire) arrives as a ticket card
// with a ding: its number, the table, the waiter, any note, the dishes for
// this station, and what other stations are making for it. The card's top
// turns amber, then red, the longer it waits. A tap on a dish marks it
// done; Done finishes the card for this station. A ticket with every dish
// done moves to "Ready to serve", where it is served (taken off), or called
// back if that was a mistake. A dish taken off the order after it was sent
// is struck through in red, so the cook stops; a whole ticket cancelled
// stays up until a cook clears it. Above the cards, the "all day" count:
// how many of each dish are still to cook, across every ticket.
//
// The screen asks the server every few seconds and keeps working through a
// dropped connection (it shows the last it had, and says so). Timers run
// on the server's clock, whatever the screen's own clock says.

const SESSION_KEY = 'bamboo.kds.session';
const STATION_KEY = 'bamboo.kds.station';
const SOUND_KEY = 'bamboo.kds.sound';
const PIN_LENGTH = 4;
const POLL_MS = 4000;

function readKey(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch { return fallback; } }
function writeKey(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function qtyText(q) { return Number.isInteger(q) ? String(q) : String(Math.round(q * 100) / 100); }
function mmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0') : m + ':' + String(s % 60).padStart(2, '0');
}
function timeOf(iso) { return new Date(iso).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' }); }
function whereOf(t) { return t.tableName || t.label || t.guestName || tr('Counter'); }

export default function KdsPage() {
  const [session, setSession] = useState(null);
  const [checked, setChecked] = useState(false);
  const [pin, setPin] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState(null);
  const [station, setStation] = useState(() => readKey(STATION_KEY, 'all'));
  const [board, setBoard] = useState(null);
  const [offline, setOffline] = useState(false);
  const [problem, setProblem] = useState(null);
  const [offset, setOffset] = useState(0); // the server's clock minus this screen's
  const [tick, setTick] = useState(() => Date.now());
  const [sound, setSound] = useState(() => readKey(SOUND_KEY, 'on') === 'on');
  const [fresh, setFresh] = useState(() => new Set());
  const [busy, setBusy] = useState(() => new Set());
  const [showRecent, setShowRecent] = useState(false);
  const [theme, setTheme] = useState(getInitialTheme);
  const seenRef = useRef(null); // ticket ids already shown, to ding only for new ones
  const soundRef = useRef(sound);
  useEffect(() => { soundRef.current = sound; }, [sound]);

  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* remembered for this visit only */ }
  }, [theme]);
  useEffect(() => () => clearTheme(), []);
  useEffect(() => { const t = setInterval(() => setTick(Date.now()), 1000); return () => clearInterval(t); }, []);

  const signOut = useCallback(() => {
    try { localStorage.removeItem(SESSION_KEY); } catch { /* nothing kept */ }
    setSession(null); setBoard(null); seenRef.current = null;
  }, []);

  const load = useCallback(async (s, st) => {
    try {
      const b = await posFetch('GET', '/pos/kds?station=' + encodeURIComponent(st), s.token);
      setOffset(new Date(b.now).getTime() - Date.now());
      setOffline(false); setProblem(null);
      // A ding, and a glow, for tickets not seen before (not on first load).
      const ids = b.cooking.map((t) => t.id);
      if (seenRef.current) {
        const added = ids.filter((id) => !seenRef.current.has(id));
        if (added.length) {
          if (soundRef.current) playNewTicket();
          setFresh((f) => new Set([...f, ...added]));
          setTimeout(() => setFresh((f) => { const n = new Set(f); added.forEach((id) => n.delete(id)); return n; }), 8000);
        }
        ids.forEach((id) => seenRef.current.add(id));
      } else seenRef.current = new Set(ids);
      setBoard(b);
      return true;
    } catch (err) {
      if (err.status === 401) { signOut(); return 'signed-out'; }
      if (err.status === 404 && st !== 'all') { setStation('all'); writeKey(STATION_KEY, 'all'); return false; }
      if (err.status) setProblem(err.message); else setOffline(true);
      return false;
    }
  }, [signOut]);

  // A saved session from earlier in the shift.
  useEffect(() => {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { saved = null; }
    if (!saved) { setChecked(true); return; }
    // Kept through a dropped connection; only a refused sign-in ends it.
    load(saved, station).then((r) => { if (r !== 'signed-out') setSession(saved); setChecked(true); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ask again every few seconds, and at once when the station changes.
  useEffect(() => {
    if (!session) return undefined;
    load(session, station);
    const t = setInterval(() => load(session, station), POLL_MS);
    return () => clearInterval(t);
  }, [session, station, load]);

  async function signIn(full) {
    setLoggingIn(true); setLoginError(null);
    try {
      const s = await posFetch('POST', '/pos/login', null, { pin: full });
      writeKey(SESSION_KEY, JSON.stringify(s));
      seenRef.current = null;
      setSession(s);
    } catch (err) {
      setLoginError(err.message);
    } finally {
      setPin(''); setLoggingIn(false);
    }
  }
  function tapDigit(d) {
    if (loggingIn) return;
    unlockAudio();
    const next = (pin + d).slice(0, PIN_LENGTH);
    setPin(next);
    if (next.length === PIN_LENGTH) signIn(next);
  }
  useEffect(() => {
    if (session || !checked) return undefined;
    function onKey(e) {
      if (/^[0-9]$/.test(e.key)) tapDigit(e.key);
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
      else if (e.key === 'Escape') setPin('');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  async function act(key, method, path, body) {
    unlockAudio();
    setBusy((b) => new Set(b).add(key));
    try { await posFetch(method, path, session.token, body); await load(session, station); } catch (err) {
      if (err.status === 401) signOut(); else if (err.status) setProblem(err.message); else setOffline(true);
    } finally { setBusy((b) => { const n = new Set(b); n.delete(key); return n; }); }
  }
  const toggleItem = (i) => act(i.id, 'POST', '/pos/kds/items/' + i.id, { done: i.status !== 'done' });
  const finish = (t) => act(t.id, 'POST', '/pos/kds/tickets/' + t.id + '/done', { station });
  const serve = (t) => act(t.id, 'POST', '/pos/kds/tickets/' + t.id + '/served');
  const recall = (t) => act(t.id, 'POST', '/pos/kds/tickets/' + t.id + '/recall');
  function pickStation(s) { setStation(s); writeKey(STATION_KEY, s); seenRef.current = null; setBoard(null); }
  function toggleSound() { const on = !sound; setSound(on); writeKey(SOUND_KEY, on ? 'on' : 'off'); if (on) { unlockAudio(); playNewTicket(); } }
  function fullScreen() {
    const el = document.documentElement;
    if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  }

  const now = tick + offset;
  // How many of each dish are still to cook, across every ticket on screen.
  const allDay = useMemo(() => {
    const m = new Map();
    (board ? board.cooking : []).forEach((t) => t.items.forEach((i) => {
      if (i.status !== 'cooking') return;
      m.set(i.name, (m.get(i.name) || 0) + i.qty);
    }));
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [board]);

  const themeButton = (
    <button type="button" className="kds-tool" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? tr('Light mode') : tr('Dark mode')} title={theme === 'dark' ? tr('Light mode') : tr('Dark mode')}>
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
  const clock = new Date(now).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' });

  if (!checked) return null;
  if (!session) {
    return (
      <div className="dk pos-shell pos-gate kds-gate">
        <span className="pos-orb is-a" aria-hidden="true" /><span className="pos-orb is-b" aria-hidden="true" />
        <div className="pos-gate-top"><DeviceLanguage className="pos-lang" />{themeButton}</div>
        <div className="pos-gate-card">
          <div className="pos-gate-side">
            <p className="dk-eyebrow">{new Date(now).toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long' })}</p>
            <div className="pos-clock">{clock}</div>
            <h1 className="pos-gate-title">{tr('Kitchen screen')}</h1>
            <p className="dk-muted">{tr('Enter your 4-digit PIN, the same one you clock in with. Orders from the till then show here as tickets for the whole shift.')}</p>
            <div className="pos-gate-logos" aria-hidden="true">
              {['SBR', 'BGN'].map((c) => restaurantLogoUrl(c) && <img key={c} src={restaurantLogoUrl(c)} alt="" />)}
            </div>
          </div>
          <div className="pos-gate-pad">
            <div className={'pos-pin' + (loginError ? ' is-bad' : '')} aria-label={tr('PIN')}>
              {Array.from({ length: PIN_LENGTH }).map((_, i) => <span key={i} className={i < pin.length ? 'is-on' : ''} />)}
            </div>
            <p className={'pos-pin-note' + (loginError ? ' is-bad' : '')} role="status">{loggingIn ? tr('Checking…') : loginError || tr('Tap your PIN or type it.')}</p>
            <div className="pos-keypad">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button key={d} type="button" disabled={loggingIn} onClick={() => tapDigit(d)}>{d}</button>)}
              <button type="button" className="is-muted" disabled={loggingIn} onClick={() => setPin('')}>{tr('Clear')}</button>
              <button type="button" disabled={loggingIn} onClick={() => tapDigit('0')}>0</button>
              <button type="button" className="is-muted" disabled={loggingIn} onClick={() => setPin(pin.slice(0, -1))} aria-label={tr('Backspace')}>⌫</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const stations = board ? board.stations : [];
  const timing = board ? board.timing : { warnAfter: 10, lateAfter: 20 };
  const stationName = station === 'all' ? tr('All stations') : (stations.find((s) => s.id === station) || {}).name || '';
  function toneOf(t) {
    const m = (now - new Date(t.createdAt).getTime()) / 60000;
    return m >= timing.lateAfter ? 'late' : m >= timing.warnAfter ? 'warn' : 'ok';
  }

  return (
    <div className="dk kds" data-brand={session.companyCode}>
      <header className="kds-top">
        <div className="kds-who">
          {restaurantLogoUrl(session.companyCode) && <span className="kds-logo"><img src={restaurantLogoUrl(session.companyCode)} alt="" /></span>}
          <div className="kds-who-text">
            <strong>{tr('Kitchen')} · {stationName}</strong>
            <small>{session.companyName} · {session.employeeName}</small>
          </div>
        </div>
        <nav className="kds-stations" aria-label={tr('Station')}>
          <button type="button" className={station === 'all' ? 'is-on' : ''} onClick={() => pickStation('all')}>{tr('All stations')}</button>
          {stations.map((s) => <button key={s.id} type="button" className={station === s.id ? 'is-on' : ''} onClick={() => pickStation(s.id)}>{s.name}</button>)}
        </nav>
        <div className="kds-counts" aria-live="polite">
          <span className="is-cooking"><b>{board ? board.counts.cooking : '–'}</b>{tr('cooking')}</span>
          <span className="is-ready"><b>{board ? board.counts.ready : '–'}</b>{tr('ready')}</span>
        </div>
        <div className="kds-tools">
          <span className="kds-clock">{clock}</span>
          <button type="button" className={'kds-tool' + (sound ? ' is-on' : '')} onClick={toggleSound} aria-pressed={sound} title={sound ? tr('Sound on: a ding for each new ticket') : tr('Sound off')}>{sound ? '🔔' : '🔕'}</button>
          <button type="button" className="kds-tool" onClick={fullScreen} title={tr('Full screen')} aria-label={tr('Full screen')}>⛶</button>
          <DeviceLanguage className="kds-lang" />
          {themeButton}
          <button type="button" className="kds-tool is-text" onClick={signOut}>{tr('Log out')}</button>
        </div>
      </header>

      {offline && <div className="kds-banner is-offline" role="status">{tr('Cannot reach the server. Showing the last tickets; new ones will come in when it is back.')}</div>}
      {problem && <div className="kds-banner is-bad" role="alert">{problem}</div>}
      {board && stations.length === 0 && (
        <div className="kds-banner">{tr('No kitchen stations are set up yet, so the till sends nothing here. A manager sets them up in the app: Restaurants → Kitchen.')}</div>
      )}

      {allDay.length > 0 && (
        <div className="kds-allday" aria-label={tr('Still to cook')}>
          <span className="kds-allday-h">{tr('Still to cook')}</span>
          {allDay.slice(0, 12).map(([name, q]) => <span key={name} className="kds-allday-chip"><b>{qtyText(q)}</b>{name}</span>)}
        </div>
      )}

      <div className="kds-body">
        <main className="kds-board" aria-label={tr('Tickets cooking')}>
          {!board ? <p className="kds-empty">{tr('Loading…')}</p> : !board.cooking.length ? (
            <div className="kds-empty">
              <span className="kds-empty-art" aria-hidden="true">🍳</span>
              <strong>{tr('Nothing to cook right now')}</strong>
              <p>{tr('New orders from the till show here with a ding.')}</p>
            </div>
          ) : board.cooking.map((t, idx) => {
            const cancelled = t.status === 'cancelled';
            const mineLeft = t.items.filter((i) => i.status === 'cooking').length;
            const tone = cancelled ? 'cancelled' : toneOf(t);
            return (
              <article key={t.id} className={'kds-ticket is-' + tone + (fresh.has(t.id) ? ' is-fresh' : '')} style={{ '--d': Math.min(idx, 12) }}>
                <header className="kds-ticket-head">
                  <span className="kds-no">#{t.number}</span>
                  <span className="kds-where"><strong>{whereOf(t)}</strong><small>{[t.waiterName, tr('sent {time}', { time: timeOf(t.createdAt) })].filter(Boolean).join(' · ')}</small></span>
                  <span className="kds-timer">{cancelled ? tr('Cancelled') : mmss(now - new Date(t.createdAt).getTime())}</span>
                </header>
                {cancelled && <p className="kds-cancel">{tr('Taken off the order. Stop cooking it.')}</p>}
                {t.note && <p className="kds-note"><span aria-hidden="true">✎</span>{t.note}</p>}
                <ul className="kds-items">
                  {t.items.map((i) => (
                    <li key={i.id}>
                      <button type="button" className={'kds-item is-' + i.status} disabled={i.status === 'cancelled' || busy.has(i.id)} onClick={() => toggleItem(i)}
                        aria-pressed={i.status === 'done'} title={i.status === 'done' ? tr('Done. Tap to put it back') : i.status === 'cancelled' ? tr('Taken off the order') : tr('Tap when it is done')}>
                        <b>{qtyText(i.qty)}×</b>
                        <span className="kds-item-name">{i.name}{station === 'all' && i.stationName && <em>{i.stationName}</em>}</span>
                        <i className="kds-check" aria-hidden="true">{i.status === 'done' ? '✓' : i.status === 'cancelled' ? '✕' : ''}</i>
                      </button>
                    </li>
                  ))}
                </ul>
                {t.elsewhere.length > 0 && (
                  <p className="kds-elsewhere">{tr('Also on this order:')} {t.elsewhere.map((e) => qtyText(e.qty) + '× ' + e.name + (e.stationName ? ' (' + e.stationName + ')' : '')).join(', ')}</p>
                )}
                <footer className="kds-ticket-foot">
                  {cancelled
                    ? <button type="button" className="kds-btn is-clear" disabled={busy.has(t.id)} onClick={() => serve(t)}>{tr('OK, clear it')}</button>
                    : <button type="button" className="kds-btn is-done" disabled={busy.has(t.id) || !mineLeft} onClick={() => finish(t)}>{tr('Done')} ✓</button>}
                </footer>
              </article>
            );
          })}
        </main>

        <aside className="kds-side" aria-label={tr('Ready to serve')}>
          <h2 className="kds-side-h">{tr('Ready to serve')} <span>{board ? board.ready.length : 0}</span></h2>
          {board && !board.ready.length && <p className="kds-side-empty">{tr('Finished tickets wait here until they are taken out.')}</p>}
          {board && board.ready.map((t) => {
            const waitingFor = t.status === 'cooking';
            return (
              <div key={t.id} className={'kds-ready' + (waitingFor ? ' is-waiting' : '')}>
                <div className="kds-ready-top">
                  <span className="kds-no is-small">#{t.number}</span>
                  <strong>{whereOf(t)}</strong>
                  <small>{waitingFor ? tr('waiting for another station') : t.readyAt ? tr('ready {time} ago', { time: mmss(now - new Date(t.readyAt).getTime()) }) : ''}</small>
                </div>
                <p className="kds-ready-items">{t.items.filter((i) => i.status === 'done').map((i) => qtyText(i.qty) + '× ' + i.name).join(', ')}</p>
                <div className="kds-ready-acts">
                  {!waitingFor && <button type="button" className="kds-btn is-serve" disabled={busy.has(t.id)} onClick={() => serve(t)}>{tr('Mark served')}</button>}
                  {t.items.some((i) => i.status === 'done') && (
                    <button type="button" className="kds-btn is-ghost" disabled={busy.has(t.id)} onClick={() => act(t.id, 'POST', '/pos/kds/items/' + t.items.find((i) => i.status === 'done').id, { done: false })}>{tr('Back to cooking')}</button>
                  )}
                </div>
              </div>
            );
          })}
          {board && board.recent.length > 0 && (
            <div className="kds-recent">
              <button type="button" className="kds-recent-h" onClick={() => setShowRecent(!showRecent)} aria-expanded={showRecent}>
                {tr('Served lately')} <span>{board.recent.length}</span> <i aria-hidden="true">{showRecent ? '▴' : '▾'}</i>
              </button>
              {showRecent && board.recent.map((t) => (
                <div key={t.id} className="kds-recent-row">
                  <span className="kds-no is-small">#{t.number}</span>
                  <span>{whereOf(t)}<small>{t.servedAt ? timeOf(t.servedAt) : ''}</small></span>
                  <button type="button" className="kds-btn is-ghost" disabled={busy.has(t.id)} onClick={() => recall(t)}>{tr('Bring it back')}</button>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
