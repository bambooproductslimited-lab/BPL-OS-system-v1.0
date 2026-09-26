import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import { enqueueTap, peekQueue, removeFromQueue, queueLength } from '../kiosk/offlineQueue';
import { unlockAudio, playClockIn, playClockOut, playWrongPin } from '../kiosk/kioskSounds';
import { cameraPermissionState, primeCamera } from '../kiosk/cameraReady';
import FaceCapture from '../components/FaceCapture';
import { tr, activeIntlLocale } from '../lib/i18n.jsx';
import { applyTheme, clearTheme, getInitialTheme, THEME_KEY } from '../lib/theme';
import '../components/DashKit.css';
import './KioskPage.css';

// The clock-in/out kiosk — a full-screen, standalone page meant to be
// opened in a browser on a shared iPad mounted at the entrance/factory
// floor, with no login of any kind. An employee taps a 4-digit PIN (no
// name/code needed — the PIN alone identifies them, see kiosk.service.js)
// and the pad clocks them in or out automatically depending on whether
// they already have an open clock-in today. Mounted at /kiosk, outside
// ProtectedRoute/AppShell in App.jsx — deliberately reachable without a
// Bamboo OS login, since the device itself never logs in as anyone.
//
// Offline support: a factory floor or gate can lose connectivity for
// stretches at a time, and a kiosk is exactly the kind of device that has
// to keep working through that. kiosk-sw.js caches the page itself so it
// still loads with zero network; a tap that fails at the network level
// (not a rejection — a real PIN just can't be verified without the
// server, see kiosk-sw.js's comment on why nothing tries to check it
// locally) queues in localStorage and replays automatically once back
// online, backdated to when it actually happened (occurredAt — see
// attendance.service.js's resolveOccurredAt).
//
// For a real deployment, put the iPad's Safari into Guided Access (Settings
// > Accessibility > Guided Access) pointed at this URL, so it can't be
// swiped away to another app or tab — that's a device-level iOS setting,
// nothing this page can enforce on its own.
//
// Built from the OS's own tokens and DashKit pieces, like the restaurant
// till, and following the device's light/dark choice. Readable from a few
// feet away: a big clock and keypad while idle, and after a tap a full
// colour wash (green in, blue out, red error, amber offline) that says who
// was clocked, when, and what it means — their shift, whether they were
// late, the hours worked, and the week so far (kiosk.service.js's
// tapSummary).

const PIN_LENGTH = 4;
const RESULT_DISPLAY_MS = 3500;
// A clock-in that comes with news about a previous shift stays up until the
// employee taps OK — long enough to read — but never leaves the kiosk stuck
// on one person's result if they walk away.
const NOTICE_DISPLAY_MS = 20000;

// "Tuesday 22 September" in the kiosk's language, from the server's
// YYYY-MM-DD.
function noticeDate(iso) {
  return new Date(iso + 'T12:00:00').toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long' });
}
function shiftHours(s) {
  const start = new Date(s.date + 'T' + s.clockIn + ':00Z').getTime();
  const end = new Date(s.clockOutDate + 'T' + s.clockOut + ':00Z').getTime();
  const h = (end - start) / 3600000;
  return Number.isInteger(h) ? h : Math.round(h * 10) / 10;
}
// "5 h 47 min", "47 min", "8 h"
function duration(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  if (!h) return tr('{m} min', { m });
  if (!m) return tr('{h} h', { h });
  return tr('{h} h {m} min', { h, m });
}
const FLUSH_INTERVAL_MS = 20000;
// requiresFace came back true from /kiosk/identify — the server knows this
// PIN belongs to an enrolled employee, so a face capture is mandatory
// before we're willing to try again. Kept generous since these kiosks run
// on a real spread of hardware (iPadOS 15 through 26 — as old as an iPad
// Air 2), and the lightweight detector chosen for exactly that reason (see
// lib/faceModels.js) can still take a few extra seconds on the oldest
// devices, especially before its models are cached by the service worker.
const FACE_TIMEOUT_REQUIRED_MS = 20000;
// We couldn't reach /kiosk/identify at all (offline) so we don't actually
// know whether this PIN needs a face — try briefly anyway (see
// handlePinComplete's comment), but don't hold up a PIN-only employee's
// tap for long while the device has no connectivity regardless.
const FACE_TIMEOUT_OFFLINE_MS = 12000;
// Whether anyone at this company is enrolled for face verification, as last
// answered by /kiosk/config. Remembered on the device because the kiosk has
// to decide whether to prime the camera at startup (see kiosk/cameraReady.js)
// and startup is exactly when it might have no connectivity — a kiosk that
// boots during an outage should still behave the way it did yesterday
// rather than forgetting it needs a camera.
const FACE_IN_USE_KEY = 'bamboo-kiosk-face-in-use';
function rememberFaceInUse(inUse) {
  try { localStorage.setItem(FACE_IN_USE_KEY, inUse ? '1' : '0'); } catch { /* private mode — just don't remember */ }
}
function recallFaceInUse() {
  try { return localStorage.getItem(FACE_IN_USE_KEY) === '1'; } catch { return false; }
}

const ICON_PATHS = {
  checkCircle: <><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.6" /><path d="M7.5 12.5l3 3 6-6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></>,
  exit: <><path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M20 12H9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /><path d="M16 8l4 4-4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></>,
  cloud: <path d="M7 18a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17.2 8.06 4.5 4.5 0 0 1 17 17H7Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />,
  xCircle: <><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.6" /><path d="M9 9l6 6M15 9l-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></>,
  clock: <><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" /><path d="M12 7.5V12l3 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></>,
  sun: <><circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.7" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></>,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />,
  calendar: <><rect x="3.5" y="5" width="17" height="15" stroke="currentColor" strokeWidth="1.7" /><path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></>,
  warn: <><path d="M12 3.5 2.5 20h19L12 3.5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /><path d="M12 10v4.5M12 17.2v.3" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" /></>,
  backspace: <><path d="M8 6h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8l-6-6 6-6Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /><path d="M13 10l4 4m0-4l-4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></>
};
function Icon({ name }) { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">{ICON_PATHS[name]}</svg>; }

function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export default function KioskPage() {
  const [pin, setPin] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null); // { kind: 'ok'|'error'|'pending', action, employeeName, time, status, minutesLate, message }
  const [pendingCount, setPendingCount] = useState(0);
  const [faceStage, setFaceStage] = useState(null); // { pin, optional } while the camera step is showing
  const [cameraBlocked, setCameraBlocked] = useState(false); // camera needed here, but this device hasn't granted it
  const resultTimerRef = useRef(null);
  const flushingRef = useRef(false);
  const locationRef = useRef(null); // latest GPS fix, kept fresh by watchPosition below
  const now = useClock();
  // The kiosk follows the OS's light/dark choice on this device, with a
  // small switch in the corner.
  const [theme, setTheme] = useState(getInitialTheme);
  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* remembered for this visit only */ }
  }, [theme]);
  useEffect(() => () => clearTheme(), []);

  useEffect(() => () => { if (resultTimerRef.current) clearTimeout(resultTimerRef.current); }, []);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/kiosk-sw.js', { scope: '/kiosk' }).catch(() => {});
    }
  }, []);

  // Gets the camera permission dealt with at startup, on the idle screen,
  // instead of mid-clock-in — see kiosk/cameraReady.js for the whole story.
  // Only runs at all where face verification is actually in use: a company
  // with nobody enrolled never gets asked for a camera it will never open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let inUse;
      try {
        const cfg = await api.get('/kiosk/config');
        inUse = !!cfg.faceVerificationInUse;
        rememberFaceInUse(inUse);
      } catch {
        inUse = recallFaceInUse(); // offline at boot — go with what this device saw last
      }
      if (cancelled || !inUse) return;

      const state = await cameraPermissionState();
      if (cancelled) return;
      if (state === 'granted' || state === 'unavailable') return; // nothing to ask for
      if (state === 'denied') { setCameraBlocked(true); return; }

      // 'prompt' or 'unknown' (Safari) — ask now, while nobody is waiting.
      const outcome = await primeCamera();
      if (!cancelled && outcome !== 'granted') setCameraBlocked(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // The kiosk is a fixed, plugged-in device, so every fix reports roughly
  // the same spot — this exists to timestamp clock events with the
  // kiosk's own location for the record, not to track the tapping
  // employee. watchPosition (not a one-off getCurrentPosition per tap)
  // keeps locationRef current in the background without adding latency
  // to a clock-in/out; a tap just uses whatever fix is on hand. Denied
  // permission or no fix yet simply means location stays null — never
  // something that blocks or fails a clock event.
  useEffect(() => {
    if (!('geolocation' in navigator)) return;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        locationRef.current = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 60000, timeout: 20000 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  useEffect(() => {
    setPendingCount(queueLength());
    flushQueue();
    window.addEventListener('online', flushQueue);
    const interval = setInterval(flushQueue, FLUSH_INTERVAL_MS);
    return () => {
      window.removeEventListener('online', flushQueue);
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Replays queued taps in the order they happened. A network failure mid-
  // replay means we're still offline — stop and leave the rest queued for
  // the next attempt. A rejection from the server (wrong/stale PIN by now,
  // already clocked out that day, timestamp too old to backdate) is
  // permanent — nothing to gain by retrying it, so it's dropped.
  async function flushQueue() {
    if (flushingRef.current) return;
    flushingRef.current = true;
    try {
      const items = peekQueue();
      for (const item of items) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await api.post('/kiosk/clock', {
            pin: item.pin, occurredAt: item.occurredAt, location: item.location, faceDescriptor: item.faceDescriptor
          });
          removeFromQueue(item.tempId);
        } catch (err) {
          if (err instanceof ApiError) removeFromQueue(item.tempId);
          else break;
        }
      }
    } finally {
      setPendingCount(queueLength());
      flushingRef.current = false;
    }
  }

  async function submitPin(fullPin, faceDescriptor) {
    let noticeShown = false;
    setSubmitting(true);
    try {
      const r = await api.post('/kiosk/clock', { pin: fullPin, location: locationRef.current, faceDescriptor: faceDescriptor || null });
      noticeShown = !!(r.autoClosedShifts && r.autoClosedShifts.length);
      setResult({
        kind: 'ok', action: r.action, employeeName: r.employeeName, firstName: r.firstName || r.employeeName, time: r.time, status: r.status, minutesLate: r.minutesLate,
        autoClosedShifts: r.autoClosedShifts || [], shift: r.shift || null, workedMinutes: r.workedMinutes, week: r.week || null, lateThisMonth: r.lateThisMonth || 0,
        ms: noticeShown ? NOTICE_DISPLAY_MS : RESULT_DISPLAY_MS + 2500
      });
      if (r.action === 'in') playClockIn(); else playClockOut();
      flushQueue(); // a live tap just succeeded, so we're online — try any backlog too
    } catch (err) {
      if (err instanceof ApiError) {
        setResult({ kind: 'error', message: err.message || tr('Something went wrong.'), ms: RESULT_DISPLAY_MS });
        playWrongPin();
      } else {
        enqueueTap(fullPin, new Date().toISOString(), locationRef.current, faceDescriptor);
        setPendingCount(queueLength());
        setResult({ kind: 'pending', ms: RESULT_DISPLAY_MS });
      }
    } finally {
      setSubmitting(false);
      setPin('');
      resultTimerRef.current = setTimeout(() => setResult(null), noticeShown ? NOTICE_DISPLAY_MS : RESULT_DISPLAY_MS + 2500);
    }
  }

  function dismissResult() {
    clearTimeout(resultTimerRef.current);
    setResult(null);
  }

  function showErrorResult(message) {
    setPin('');
    setResult({ kind: 'error', message, ms: RESULT_DISPLAY_MS });
    playWrongPin();
    resultTimerRef.current = setTimeout(() => setResult(null), RESULT_DISPLAY_MS);
  }

  // A PIN alone used to be enough to clock in/out; now, for an employee HR
  // has enrolled a face for, it also has to be their face. /kiosk/identify
  // resolves the PIN without clocking anything, purely so we know whether
  // to bother with the camera at all — most employees still have no face
  // on file (see migration 0039), and they should keep tapping in exactly
  // as fast as before.
  async function handlePinComplete(fullPin) {
    if (submitting || result || faceStage) return;
    setSubmitting(true);
    try {
      const r = await api.post('/kiosk/identify', { pin: fullPin });
      setSubmitting(false);
      if (r.requiresFace) {
        setFaceStage({ pin: fullPin, optional: false });
      } else {
        submitPin(fullPin);
      }
    } catch (err) {
      setSubmitting(false);
      if (err instanceof ApiError) {
        showErrorResult(err.message || tr('Something went wrong.'));
      } else {
        // Offline — we can't ask the server whether this PIN needs a face,
        // so try briefly for one anyway (covers an enrolled employee
        // tapping during an outage) without holding up everyone else long.
        setFaceStage({ pin: fullPin, optional: true });
      }
    }
  }

  function tapDigit(d) {
    if (submitting || result || faceStage) return;
    unlockAudio();
    const next = pin + d;
    setPin(next);
    if (next.length === PIN_LENGTH) handlePinComplete(next);
  }
  // The banner's own tap. Safari will refuse to prompt at all in some
  // situations unless the request comes straight out of a user gesture, so
  // this path matters beyond just being a retry button: it's the one that
  // reliably works after an automatic prime came back denied.
  async function enableCamera() {
    const outcome = await primeCamera();
    setCameraBlocked(outcome !== 'granted');
  }

  function tapClear() { if (!submitting) setPin(''); }
  function tapBackspace() { if (!submitting) setPin(pin.slice(0, -1)); }
  // A kiosk with a keyboard can type the PIN as well as tap it; Enter or
  // Escape clears a result early.
  useEffect(() => {
    function onKey(e) {
      if (result && (e.key === 'Enter' || e.key === 'Escape')) { dismissResult(); return; }
      if (faceStage) return;
      if (/^[0-9]$/.test(e.key)) tapDigit(e.key);
      else if (e.key === 'Backspace') tapBackspace();
      else if (e.key === 'Escape') tapClear();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const tone = result ? (result.kind === 'ok' ? (result.action === 'in' ? 'clockin' : 'clockout') : result.kind) : '';
  const clock = now.toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' });
  const dateLine = now.toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  function facts(r) {
    const out = [];
    if (r.action === 'in') {
      if (r.status === 'late') out.push({ icon: 'warn', tone: 'warn', text: tr('{time} late for your shift', { time: duration(r.minutesLate || 0) }) });
      else if (r.status) out.push({ icon: 'checkCircle', tone: 'good', text: tr('On time') });
      if (r.shift) out.push({ icon: 'clock', text: r.shift.end ? tr('Your shift: {start} to {end}', { start: r.shift.start, end: r.shift.end }) : tr('Your shift starts at {start}', { start: r.shift.start }) });
    } else if (r.workedMinutes != null) {
      out.push({ icon: 'clock', tone: 'good', text: tr('You worked {time} this shift', { time: duration(r.workedMinutes) }) });
    }
    if (r.week && r.week.days) {
      out.push({ icon: 'calendar', text: r.week.hours > 0
        ? (r.week.days === 1 ? tr('This week: 1 day, {h} hours', { h: r.week.hours }) : tr('This week: {n} days, {h} hours', { n: r.week.days, h: r.week.hours }))
        : (r.week.days === 1 ? tr('This week: 1 day') : tr('This week: {n} days', { n: r.week.days })) });
    }
    if (r.action === 'in' && r.lateThisMonth > 1) out.push({ icon: 'warn', tone: 'warn', text: tr('Late {n} times this month', { n: r.lateThisMonth }) });
    return out;
  }

  return (
    <div className={'dk kiosk' + (tone ? ' is-' + tone : '')}>
      <div className="kiosk-top">
        <div className="kiosk-brand">CHOU AND ASSOCIATES</div>
        <div className="kiosk-top-tools">
          {pendingCount > 0 && (
            <span className="kiosk-pending">
              <Icon name="cloud" />
              {pendingCount === 1 ? tr('1 tap syncing…') : tr('{n} taps syncing…', { n: pendingCount })}
            </span>
          )}
          <button type="button" className="kiosk-theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? tr('Light mode') : tr('Dark mode')}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
          </button>
        </div>
      </div>

      {result ? (
        <div className={'kiosk-card kiosk-result is-' + tone} role="status" aria-live="assertive">
          <div className="kiosk-result-mark">
            <Icon name={result.kind === 'ok' ? (result.action === 'in' ? 'checkCircle' : 'exit') : result.kind === 'pending' ? 'cloud' : 'xCircle'} />
          </div>
          {result.kind === 'ok' && (
            <>
              <p className="kiosk-result-kicker">{result.action === 'in' ? tr('Clocked in at {time}', { time: result.time }) : tr('Clocked out at {time}', { time: result.time })}</p>
              <h1 className="kiosk-result-title">{result.action === 'in' ? tr('Welcome, {name}', { name: result.firstName }) : tr('Goodbye, {name}', { name: result.firstName })}</h1>
              <p className="kiosk-result-name">{result.employeeName}</p>
              {facts(result).length > 0 && (
                <ul className="kiosk-facts">
                  {facts(result).map((f, i) => <li key={i} className={f.tone ? 'is-' + f.tone : ''}><Icon name={f.icon} /><span>{f.text}</span></li>)}
                </ul>
              )}
              {result.autoClosedShifts && result.autoClosedShifts.length > 0 && (() => {
                const last = result.autoClosedShifts[0];
                const earlier = result.autoClosedShifts.length - 1;
                return (
                  <div className="kiosk-notice" role="alertdialog" aria-labelledby="kiosk-notice-title">
                    <div className="kiosk-notice-title" id="kiosk-notice-title">
                      <Icon name="clock" /> {tr('Your last shift was not clocked out')}
                    </div>
                    <p className="kiosk-notice-body">
                      {tr('You clocked in at {clockIn} on {date} but didn\'t clock out, so the system clocked you out automatically at {clockOut}, {hours} hours later.', {
                        clockIn: last.clockIn, date: noticeDate(last.date), clockOut: last.clockOut, hours: shiftHours(last)
                      })}
                    </p>
                    {earlier > 0 && (
                      <p className="kiosk-notice-body">
                        {earlier === 1
                          ? tr('One earlier shift was also clocked out automatically.')
                          : tr('{n} earlier shifts were also clocked out automatically.', { n: earlier })}
                      </p>
                    )}
                    <p className="kiosk-notice-body kiosk-notice-hint">
                      {tr('If you left at a different time, tell your supervisor so they can correct it. Remember to clock out at the end of every shift.')}
                    </p>
                  </div>
                );
              })()}
            </>
          )}
          {result.kind === 'pending' && (
            <>
              <p className="kiosk-result-kicker">{tr('No connection')}</p>
              <h1 className="kiosk-result-title">{tr('Recorded')}</h1>
              <p className="kiosk-result-name">{tr('No connection — this will sync automatically once you\'re back online.')}</p>
            </>
          )}
          {result.kind === 'error' && (
            <>
              <p className="kiosk-result-kicker">{tr('Not clocked')}</p>
              <h1 className="kiosk-result-title">{result.message}</h1>
              <p className="kiosk-result-name">{tr('Check your PIN and try again. If it keeps happening, ask your supervisor.')}</p>
            </>
          )}
          <button type="button" className="kiosk-done" onClick={dismissResult} autoFocus>{result.autoClosedShifts && result.autoClosedShifts.length ? tr('OK, got it') : tr('Done')}</button>
          <span className="kiosk-timer" aria-hidden="true"><span key={result.time + result.kind} style={{ animationDuration: (result.ms || RESULT_DISPLAY_MS) + 'ms' }} /></span>
        </div>
      ) : (
        <div className="kiosk-card">
          <div className="kiosk-side">
            <p className="dk-eyebrow">{dateLine}</p>
            <div className="kiosk-clock">{clock}</div>
            <h1 className="kiosk-title">{tr('Clock in or out')}</h1>
            <p className="dk-muted">{tr('Tap your 4-digit PIN. The same PIN clocks you in when you arrive and out when you leave.')}</p>
            <ol className="kiosk-steps">
              <li><span>1</span>{tr('Tap your PIN')}</li>
              <li><span>2</span>{tr('Look at the camera if it asks')}</li>
              <li><span>3</span>{tr('Check your name on the screen')}</li>
            </ol>
            {cameraBlocked && (
              <button type="button" className="kiosk-camera-warning" onClick={enableCamera}>
                <Icon name="xCircle" />
                <span>
                  <strong>{tr('This kiosk can’t use its camera.')}</strong>
                  {tr('Tap here and choose Allow. Staff who clock in by face can’t use this device until someone does.')}
                </span>
              </button>
            )}
          </div>
          <div className="kiosk-main">
            {faceStage ? (
              <div className="kiosk-face-wrap">
                <FaceCapture
                  mode="kiosk"
                  title={tr('Confirm it\'s you')}
                  subtitle={tr('Hold still and look at the camera to finish clocking in or out.')}
                  timeoutMs={faceStage.optional ? FACE_TIMEOUT_OFFLINE_MS : FACE_TIMEOUT_REQUIRED_MS}
                  onCapture={(descriptor) => {
                    const p = faceStage.pin;
                    setFaceStage(null);
                    submitPin(p, descriptor);
                  }}
                  onCancel={() => { setFaceStage(null); setPin(''); }}
                  onTimeout={() => {
                    const p = faceStage.pin, optional = faceStage.optional;
                    setFaceStage(null);
                    if (optional) submitPin(p);
                    else showErrorResult(tr("Couldn't see your face clearly — try again."));
                  }}
                  onError={(message, name) => {
                    const p = faceStage.pin, optional = faceStage.optional;
                    setFaceStage(null);
                    if (name === 'NotAllowedError') setCameraBlocked(true);
                    if (optional) submitPin(p);
                    else showErrorResult(message);
                  }}
                />
              </div>
            ) : (
              <>
                <div className="kiosk-pin" aria-label={tr('PIN')}>
                  {Array.from({ length: PIN_LENGTH }).map((_, i) => <span key={i} className={i < pin.length ? 'is-on' : ''} />)}
                </div>
                <p className="kiosk-pin-note" role="status">{submitting ? tr('Checking…') : pin.length ? tr('{n} of 4', { n: pin.length }) : tr('Enter your PIN')}</p>
                <div className="kiosk-keypad">
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                    <button key={d} type="button" disabled={submitting} onClick={() => tapDigit(d)}>{d}</button>
                  ))}
                  <button type="button" className="is-muted" disabled={submitting} onClick={tapClear}>{tr('Clear')}</button>
                  <button type="button" disabled={submitting} onClick={() => tapDigit('0')}>0</button>
                  <button type="button" className="is-muted" disabled={submitting} onClick={tapBackspace} aria-label={tr('Backspace')}><Icon name="backspace" /></button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
