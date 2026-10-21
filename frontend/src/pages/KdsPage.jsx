import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { posFetch } from '../lib/posApi';
import { restaurantLogoUrl } from '../lib/restaurantLogos';
import DeviceLanguage from '../components/DeviceLanguage';
import { unlockAudio, playNewTicket } from '../kiosk/kioskSounds';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import { applyTheme, clearTheme, getInitialTheme, THEME_KEY } from '../lib/theme';
import { buildRunnerTicketBytes, bluetoothSupported, reconnectBluetoothPrinter, reconnectUsbPrinter, requestBluetoothPrinter, requestUsbPrinter, usbSupported } from '../lib/thermalPrinter';
import { FulfillmentIcon, fulfillmentName } from './till/tillShared';
import './till/till.css';
import '../components/DashKit.css';
import './RestaurantPosPage.css';
import './KdsPage.css';

// The kitchen display (KDS) — a full-screen page for a screen in the
// kitchen, at /kds, outside the app's sign-in like the till and the kiosk.
// A new screen shows a code and waits until a manager sets it up in the
// till settings (Kitchen screens: restaurantKdsScreens.service.js), giving
// it a name and its station ("Grill", "Bar"…, or all of them). Cooks then
// sign in on it with their own staff PIN (restaurantPos.service.js login),
// so we know who cooked; the station is the manager's, not picked here.
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
//
// Each ticket says dine in, pickup or delivery (with the address and
// phone), and each dish its note. When the till settings ask for it
// (kitchen.printReady), finishing a ticket prints one for the runner: the
// number, who it is for and where it goes, every dish — on a thermal
// printer connected here, else through the device's print dialog.

const SESSION_KEY = 'bamboo.kds.session';
const SCREEN_KEY = 'bamboo.kds.screen';
const SETUP_POLL_MS = 4000;
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
function whereOf(t) {
  if (t.fulfillment === 'pickup') return (t.label || t.guestName || '') + ' · ' + tr('Counter');
  if (t.fulfillment === 'delivery') return t.guestName || t.label || tr('Delivery');
  return t.tableName || t.label || t.guestName || tr('Counter');
}

export default function KdsPage() {
  const [session, setSession] = useState(null);
  const [checked, setChecked] = useState(false);
  const [pin, setPin] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState(null);
  const [screen, setScreen] = useState(null); // this screen as the server knows it: waiting (a code) or set up
  const [screenProblem, setScreenProblem] = useState(null);
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
  // A thermal printer at the kitchen, and the ticket being printed through
  // the print dialog when there is none.
  const [printer, setPrinter] = useState(null);
  const [printing, setPrinting] = useState(null);
  const [paper, setPaper] = useState(null);
  const seenRef = useRef(null); // ticket ids already shown, to ding only for new ones
  const soundRef = useRef(sound);
  useEffect(() => { soundRef.current = sound; }, [sound]);

  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* remembered for this visit only */ }
  }, [theme]);
  useEffect(() => () => clearTheme(), []);
  useEffect(() => { const t = setInterval(() => setTick(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => {
    (async () => {
      const usb = await reconnectUsbPrinter();
      if (usb) { setPrinter(usb); return; }
      const bt = await reconnectBluetoothPrinter();
      if (bt) setPrinter(bt);
    })();
  }, []);
  // The ticket in the print dialog: printed once it is on the page.
  useEffect(() => {
    if (!paper) return undefined;
    const t = setTimeout(() => { window.print(); setPaper(null); }, 60);
    return () => clearTimeout(t);
  }, [paper]);

  // Hello to the server: is this screen set up, and as what? The first
  // time, it gets its secret and a code to show.
  // One hello at a time, so a new screen is never registered twice.
  const helloRef = useRef(null);
  const hello = useCallback(() => {
    if (helloRef.current) return helloRef.current;
    helloRef.current = (async () => {
      try {
        const h = await posFetch('POST', '/pos/kds/screen', null, { screenToken: readKey(SCREEN_KEY, '') || undefined });
        if (h.screenToken) writeKey(SCREEN_KEY, h.screenToken);
        setScreen(h); setScreenProblem(null);
        return h;
      } catch (err) {
        setScreenProblem(err.status ? err.message : tr('Cannot reach the server. Check the internet and reload.'));
        return null;
      } finally { helloRef.current = null; }
    })();
    return helloRef.current;
  }, []);
  useEffect(() => { hello(); }, [hello]);
  // Waiting for a manager: ask again every few seconds.
  useEffect(() => {
    if (!screen || screen.status !== 'waiting') return undefined;
    const t = setInterval(hello, SETUP_POLL_MS);
    return () => clearInterval(t);
  }, [screen, hello]);

  const signOut = useCallback(() => {
    try { localStorage.removeItem(SESSION_KEY); } catch { /* nothing kept */ }
    setSession(null); setBoard(null); seenRef.current = null;
    hello();
  }, [hello]);

  const load = useCallback(async (s) => {
    try {
      const b = await posFetch('GET', '/pos/kds', s.token);
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
    load(saved).then((r) => { if (r !== 'signed-out') setSession(saved); setChecked(true); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ask again every few seconds (a manager may move the screen to another station).
  useEffect(() => {
    if (!session) return undefined;
    load(session);
    const t = setInterval(() => load(session), POLL_MS);
    return () => clearInterval(t);
  }, [session, load]);

  async function signIn(full) {
    setLoggingIn(true); setLoginError(null);
    try {
      const s = await posFetch('POST', '/pos/login', null, { pin: full, app: 'kds', screenToken: readKey(SCREEN_KEY, '') || undefined });
      writeKey(SESSION_KEY, JSON.stringify(s));
      seenRef.current = null;
      setSession(s);
    } catch (err) {
      setLoginError(err.message);
      // Taken off or not set up after all: back to its code.
      if (err.status === 403) hello();
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
    try { await posFetch(method, path, session.token, body); await load(session); } catch (err) {
      if (err.status === 401) signOut(); else if (err.status) setProblem(err.message); else setOffline(true);
    } finally { setBusy((b) => { const n = new Set(b); n.delete(key); return n; }); }
  }
  const printReady = !!(board && board.printReady);
  async function printTicket(t) {
    setPrinting(t.id);
    try {
      const full = await posFetch('POST', '/pos/kds/tickets/' + t.id + '/printed', session.token);
      if (printer) await printer.write(buildRunnerTicketBytes(full, session.companyName));
      else setPaper(full);
    } catch (err) {
      if (err.status === 401) signOut(); else setProblem(tr('Could not print the ticket: {message}', { message: err.message }));
    } finally { setPrinting(null); }
  }
  async function toggleItem(i) {
    unlockAudio();
    setBusy((b) => new Set(b).add(i.id));
    try {
      const r = await posFetch('POST', '/pos/kds/items/' + i.id, session.token, { done: i.status !== 'done' });
      await load(session);
      // The last dish done: the ticket is ready — print it if asked.
      if (printReady && r.status === 'ready' && i.status !== 'done') { const t = (board.cooking || []).find((x) => x.id === r.ticketId); if (t) printTicket(t); }
    } catch (err) {
      if (err.status === 401) signOut(); else if (err.status) setProblem(err.message); else setOffline(true);
    } finally { setBusy((b) => { const n = new Set(b); n.delete(i.id); return n; }); }
  }
  async function finish(t) {
    unlockAudio();
    setBusy((b) => new Set(b).add(t.id));
    try {
      const r = await posFetch('POST', '/pos/kds/tickets/' + t.id + '/done', session.token, { station: board ? board.station : 'all' });
      await load(session);
      if (printReady && r.status === 'ready') printTicket(t);
    } catch (err) {
      if (err.status === 401) signOut(); else if (err.status) setProblem(err.message); else setOffline(true);
    } finally { setBusy((b) => { const n = new Set(b); n.delete(t.id); return n; }); }
  }
  const serve = (t) => act(t.id, 'POST', '/pos/kds/tickets/' + t.id + '/served', { from: 'kds' });
  async function pair(kind) {
    try { setPrinter(kind === 'usb' ? await requestUsbPrinter() : await requestBluetoothPrinter()); } catch (err) { setProblem(err.message); }
  }
  const recall = (t) => act(t.id, 'POST', '/pos/kds/tickets/' + t.id + '/recall');
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
  // A screen not set up yet: its code, for a manager to set it up.
  if (!session && (!screen || screen.status !== 'active')) {
    const code = screen && screen.code ? screen.code.slice(0, 3) + ' ' + screen.code.slice(3) : '';
    return (
      <div className="dk pos-shell pos-gate kds-gate">
        <span className="pos-orb is-a" aria-hidden="true" /><span className="pos-orb is-b" aria-hidden="true" />
        <div className="pos-gate-top"><DeviceLanguage className="pos-lang" />{themeButton}</div>
        <div className="pos-gate-card kds-setup">
          <div className="pos-gate-side">
            <p className="dk-eyebrow">{tr('Kitchen screen')}</p>
            <h1 className="pos-gate-title">{tr('This screen is new')}</h1>
            <p className="dk-muted">{tr('A manager sets it up once: which kitchen or bar it stands in. After that, cooks sign in on it with their own PIN.')}</p>
            <ol className="kds-setup-steps">
              <li><b>1</b>{tr('On the till, a manager opens More → Till settings → Kitchen screens.')}</li>
              <li><b>2</b>{tr('This screen shows there under "New screens on this network", or they type its code.')}</li>
              <li><b>3</b>{tr('They name it and pick its station. This screen opens by itself.')}</li>
            </ol>
          </div>
          <div className="pos-gate-pad kds-setup-code">
            {screenProblem ? <p className="pos-pin-note is-bad" role="alert">{screenProblem}</p> : !screen ? <p className="dk-muted">{tr('Opening…')}</p> : (
              <>
                <small>{tr('Code for the manager')}</small>
                <strong aria-label={screen.code.split('').join(' ')}>{code}</strong>
                <span className="kds-setup-wait"><i aria-hidden="true" />{tr('Waiting for a manager…')}</span>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }
  if (!session) {
    return (
      <div className="dk pos-shell pos-gate kds-gate">
        <span className="pos-orb is-a" aria-hidden="true" /><span className="pos-orb is-b" aria-hidden="true" />
        <div className="pos-gate-top"><DeviceLanguage className="pos-lang" />{themeButton}</div>
        <div className="pos-gate-card">
          <div className="pos-gate-side">
            <p className="dk-eyebrow">{new Date(now).toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long' })}</p>
            <div className="pos-clock">{clock}</div>
            <h1 className="pos-gate-title">{screen.name}</h1>
            <p className="kds-gate-station">{screen.stationName || tr('All stations')} · {screen.companyName}</p>
            <p className="dk-muted">{tr('Enter your 4-digit PIN, the same one you clock in with. Orders from the till then show here as tickets, and what you mark done is in your name.')}</p>
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
  // The station is the manager's (Till settings → Kitchen screens), not picked here.
  const station = board ? board.station : 'all';
  const here = (board && board.screen) || session.screen || null;
  const stationName = here && here.stationName ? here.stationName : tr('All stations');
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
            <strong>{here ? here.name : tr('Kitchen')} · {stationName}</strong>
            <small>{session.companyName} · {session.employeeName}</small>
          </div>
        </div>
        <span className="kds-station-pill" title={tr('A manager sets this screen\'s station in Till settings → Kitchen screens.')}>{stationName}</span>
        <div className="kds-counts" aria-live="polite">
          <span className="is-cooking"><b>{board ? board.counts.cooking : '–'}</b>{tr('cooking')}</span>
          <span className="is-ready"><b>{board ? board.counts.ready : '–'}</b>{tr('ready')}</span>
        </div>
        <div className="kds-tools">
          <span className="kds-clock">{clock}</span>
          <button type="button" className={'kds-tool' + (sound ? ' is-on' : '')} onClick={toggleSound} aria-pressed={sound} title={sound ? tr('Sound on: a ding for each new ticket') : tr('Sound off')}>{sound ? '🔔' : '🔕'}</button>
          <button type="button" className="kds-tool" onClick={fullScreen} title={tr('Full screen')} aria-label={tr('Full screen')}>⛶</button>
          {printReady && (printer
            ? <span className="kds-tool is-text kds-printer" title={printer.name}>🖨 {tr('Printer ready')}</span>
            : (usbSupported() || bluetoothSupported()) && (
              <button type="button" className="kds-tool is-text" onClick={() => pair(usbSupported() ? 'usb' : 'bluetooth')} title={tr('Tickets print through the print dialog until a printer is connected.')}>🖨 {tr('Connect printer')}</button>
            ))}
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
                {t.fulfillment && (
                  <p className={'kds-ful is-' + t.fulfillment}>
                    <span className={'tl-ful is-' + t.fulfillment}><FulfillmentIcon kind={t.fulfillment} />{fulfillmentName(t.fulfillment)}</span>
                    {t.fulfillment === 'delivery' && <span className="kds-deliver">{t.deliveryAddress}{t.customerPhone ? ' · ' + t.customerPhone : ''}</span>}
                  </p>
                )}
                {cancelled && <p className="kds-cancel">{tr('Taken off the order. Stop cooking it.')}</p>}
                {t.note && <p className="kds-note"><span aria-hidden="true">✎</span>{t.note}</p>}
                <ul className="kds-items">
                  {t.items.map((i) => (
                    <li key={i.id}>
                      <button type="button" className={'kds-item is-' + i.status} disabled={i.status === 'cancelled' || busy.has(i.id)} onClick={() => toggleItem(i)}
                        aria-pressed={i.status === 'done'} title={i.status === 'done' ? tr('Done. Tap to put it back') : i.status === 'cancelled' ? tr('Taken off the order') : tr('Tap when it is done')}>
                        <b>{qtyText(i.qty)}×</b>
                        <span className="kds-item-name">{i.name}{station === 'all' && i.stationName && <em>{i.stationName}</em>}{i.note && <small className="kds-item-note">✎ {i.note}</small>}</span>
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
                    : <button type="button" className="kds-btn is-done" disabled={busy.has(t.id) || !mineLeft} onClick={() => finish(t)}>{printReady ? tr('Done · print ticket') : tr('Done')} ✓</button>}
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
                {t.fulfillment && t.fulfillment !== 'dine_in' && <p className="kds-ready-ful"><span className={'tl-ful is-' + t.fulfillment}><FulfillmentIcon kind={t.fulfillment} />{fulfillmentName(t.fulfillment)}</span>{t.fulfillment === 'delivery' && <small>{t.deliveryAddress}</small>}</p>}
                <p className="kds-ready-items">{t.items.filter((i) => i.status === 'done').map((i) => qtyText(i.qty) + '× ' + i.name).join(', ')}</p>
                <div className="kds-ready-acts">
                  {!waitingFor && <button type="button" className="kds-btn is-serve" disabled={busy.has(t.id)} onClick={() => serve(t)}>{tr('Mark served')}</button>}
                  {printReady && !waitingFor && (
                    <button type="button" className="kds-btn is-ghost" disabled={printing === t.id} onClick={() => printTicket(t)}>
                      🖨 {printing === t.id ? tr('Printing…') : t.printedAt ? tr('Print again') : tr('Print ticket')}
                    </button>
                  )}
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

      {/* The runner's ticket, for the print dialog when no printer is connected. */}
      {paper && (
        <div className="kds-print" aria-hidden="true">
          <p className="kds-print-co">{session.companyName}</p>
          <p className="kds-print-no">#{paper.number} · {tr('READY')}</p>
          <p className="kds-print-where">{paper.fulfillment === 'pickup' ? tr('Counter') : paper.fulfillment === 'delivery' ? tr('Delivery') : (paper.tableName || paper.label || tr('Counter'))}</p>
          {paper.fulfillment === 'dine_in' && <p>{fulfillmentName(paper.fulfillment)}</p>}
          {(paper.guestName || paper.label) && <p><b>{tr('For:')}</b> {paper.guestName || paper.label}</p>}
          {paper.fulfillment === 'delivery' && <p><b>{tr('To:')}</b> {paper.deliveryAddress}<br />{paper.customerPhone}</p>}
          {paper.waiterName && <p>{tr('Waiter: {name}', { name: paper.waiterName })}</p>}
          <ul>{paper.items.map((i) => <li key={i.id}><b>{qtyText(i.qty)} ×</b> {i.name}{i.note && <em> — {i.note}</em>}</li>)}</ul>
          {paper.note && <p>✎ {paper.note}</p>}
          <p className="kds-print-time">{tr('Sent {time}', { time: timeOf(paper.createdAt) })}{paper.sentBy ? ' · ' + paper.sentBy : ''} · {tr('Ready {time}', { time: timeOf(new Date().toISOString()) })}</p>
        </div>
      )}
    </div>
  );
}
