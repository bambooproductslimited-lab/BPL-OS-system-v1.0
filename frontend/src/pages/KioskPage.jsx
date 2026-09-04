import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import { enqueueTap, peekQueue, removeFromQueue, queueLength } from '../kiosk/offlineQueue';
import { unlockAudio, playClockIn, playClockOut, playWrongPin } from '../kiosk/kioskSounds';
import FaceCapture from '../components/FaceCapture';
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
// Redesigned to match the visual language established for Login/Messages/
// Dashboard: hand-drawn SVG icons (no emoji — inconsistent across devices,
// and this runs on whatever browser is on the mounted iPad), a gradient +
// bamboo-grove decoration instead of flat color, and a full-screen color
// wash on the result screen (green/red/amber) — the same "big confident
// feedback" pattern real POS/kiosk terminals use, since the whole point of
// this screen is being readable at a glance from a few feet away while
// walking past it.

const PIN_LENGTH = 4;
const RESULT_DISPLAY_MS = 3500;
const FLUSH_INTERVAL_MS = 20000;
// requiresFace came back true from /kiosk/identify — the server knows this
// PIN belongs to an enrolled employee, so a face capture is mandatory
// before we're willing to try again.
const FACE_TIMEOUT_REQUIRED_MS = 15000;
// We couldn't reach /kiosk/identify at all (offline) so we don't actually
// know whether this PIN needs a face — try briefly anyway (see
// handlePinComplete's comment), but don't hold up a PIN-only employee's
// tap for long while the device has no connectivity regardless.
const FACE_TIMEOUT_OFFLINE_MS = 10000;

const ICON_PATHS = {
  checkCircle: <><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.6" /><path d="M7.5 12.5l3 3 6-6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></>,
  exit: <><path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M20 12H9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /><path d="M16 8l4 4-4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></>,
  cloud: <path d="M7 18a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17.2 8.06 4.5 4.5 0 0 1 17 17H7Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />,
  xCircle: <><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.6" /><path d="M9 9l6 6M15 9l-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></>,
  backspace: <><path d="M8 6h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8l-6-6 6-6Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /><path d="M13 10l4 4m0-4l-4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></>
};
function Icon({ name }) { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">{ICON_PATHS[name]}</svg>; }

function KioskDecoration() {
  // Same abstract bamboo-grove motif as the login page's brand panel —
  // plain lines only, purely decorative, tuned for a full dark canvas.
  const canes = [
    { x: 60, top: 90 }, { x: 150, top: 220 }, { x: 250, top: 40 }, { x: 340, top: 180 },
    { x: 430, top: 100 }, { x: 520, top: 250 }, { x: 610, top: 60 }, { x: 700, top: 190 }
  ];
  return (
    <svg className="kiosk-deco" viewBox="0 0 760 500" fill="none" aria-hidden="true" preserveAspectRatio="xMidYMax slice">
      <g stroke="#ffffff" strokeOpacity="0.06" strokeWidth="14" strokeLinecap="round">
        {canes.map((c) => <line key={c.x} x1={c.x} y1="520" x2={c.x} y2={c.top} />)}
      </g>
      <g stroke="#ffffff" strokeOpacity="0.09" strokeWidth="14">
        {canes.map((c) => [260, 380].filter((y) => y > c.top).map((y) => (
          <line key={c.x + '-' + y} x1={c.x - 22} y1={y} x2={c.x + 22} y2={y} />
        )))}
      </g>
    </svg>
  );
}

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
  const [result, setResult] = useState(null); // { kind: 'ok'|'error'|'pending', action, employeeName, time, status, message }
  const [pendingCount, setPendingCount] = useState(0);
  const [faceStage, setFaceStage] = useState(null); // { pin, optional } while the camera step is showing
  const resultTimerRef = useRef(null);
  const flushingRef = useRef(false);
  const locationRef = useRef(null); // latest GPS fix, kept fresh by watchPosition below
  const now = useClock();

  useEffect(() => () => { if (resultTimerRef.current) clearTimeout(resultTimerRef.current); }, []);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/kiosk-sw.js', { scope: '/kiosk' }).catch(() => {});
    }
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
    setSubmitting(true);
    try {
      const r = await api.post('/kiosk/clock', { pin: fullPin, location: locationRef.current, faceDescriptor: faceDescriptor || null });
      setResult({ kind: 'ok', action: r.action, employeeName: r.employeeName, time: r.time, status: r.status });
      if (r.action === 'in') playClockIn(); else playClockOut();
      flushQueue(); // a live tap just succeeded, so we're online — try any backlog too
    } catch (err) {
      if (err instanceof ApiError) {
        setResult({ kind: 'error', message: err.message || 'Something went wrong.' });
        playWrongPin();
      } else {
        enqueueTap(fullPin, new Date().toISOString(), locationRef.current, faceDescriptor);
        setPendingCount(queueLength());
        setResult({ kind: 'pending' });
      }
    } finally {
      setSubmitting(false);
      setPin('');
      resultTimerRef.current = setTimeout(() => setResult(null), RESULT_DISPLAY_MS);
    }
  }

  function showErrorResult(message) {
    setPin('');
    setResult({ kind: 'error', message });
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
        showErrorResult(err.message || 'Something went wrong.');
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
  function tapClear() { if (!submitting) setPin(''); }
  function tapBackspace() { if (!submitting) setPin(pin.slice(0, -1)); }

  return (
    <div className={'kiosk-root' + (result ? ' kiosk-root-' + result.kind : '')}>
      <KioskDecoration />
      <div className="kiosk-content">
        <div className="kiosk-header">
          <div>
            <div className="kiosk-brand">CHOU AND ASSOCIATES</div>
            {pendingCount > 0 && (
              <div className="kiosk-pending-badge">
                <Icon name="cloud" />
                {pendingCount} tap{pendingCount === 1 ? '' : 's'} syncing…
              </div>
            )}
          </div>
          <div className="kiosk-clock">
            <div className="kiosk-time">{now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</div>
            <div className="kiosk-date">{now.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}</div>
          </div>
        </div>

        {result ? (
          <div className="kiosk-result">
            <div className="kiosk-result-badge">
              <Icon name={result.kind === 'ok' ? (result.action === 'in' ? 'checkCircle' : 'exit') : result.kind === 'pending' ? 'cloud' : 'xCircle'} />
            </div>
            {result.kind === 'ok' && (
              <>
                <div className="kiosk-result-title">{result.action === 'in' ? 'Clocked in' : 'Clocked out'}</div>
                <div className="kiosk-result-name">{result.employeeName}</div>
                <div className="kiosk-result-time">{result.time}</div>
                {result.action === 'in' && result.status && (
                  <div className={'kiosk-result-late' + (result.status === 'late' ? ' kiosk-result-late-yes' : '')}>
                    {result.status === 'late' ? "You're late" : "You're on time"}
                  </div>
                )}
              </>
            )}
            {result.kind === 'pending' && (
              <>
                <div className="kiosk-result-title">Recorded</div>
                <div className="kiosk-result-name">No connection — this will sync automatically once you're back online.</div>
              </>
            )}
            {result.kind === 'error' && (
              <div className="kiosk-result-title">{result.message}</div>
            )}
          </div>
        ) : faceStage ? (
          <div className="kiosk-face-wrap">
            <FaceCapture
              mode="kiosk"
              title="Confirm it's you"
              subtitle="Hold still and look at the camera to finish clocking in or out."
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
                else showErrorResult("Couldn't see your face clearly — try again.");
              }}
              onError={(message) => {
                const p = faceStage.pin, optional = faceStage.optional;
                setFaceStage(null);
                if (optional) submitPin(p);
                else showErrorResult(message);
              }}
            />
          </div>
        ) : (
          <div className="kiosk-pad-wrap">
            <div className="kiosk-prompt">Enter your PIN to clock in or out</div>
            <div className="kiosk-pin-dots">
              {Array.from({ length: PIN_LENGTH }).map((_, i) => (
                <span key={i} className={'kiosk-pin-dot' + (i < pin.length ? ' kiosk-pin-dot-filled' : '')} />
              ))}
            </div>
            <div className="kiosk-keypad">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                <button key={d} type="button" className="kiosk-key" disabled={submitting} onClick={() => tapDigit(d)}>{d}</button>
              ))}
              <button type="button" className="kiosk-key kiosk-key-muted" disabled={submitting} onClick={tapClear}>Clear</button>
              <button type="button" className="kiosk-key" disabled={submitting} onClick={() => tapDigit('0')}>0</button>
              <button type="button" className="kiosk-key kiosk-key-muted" disabled={submitting} onClick={tapBackspace} aria-label="Backspace"><Icon name="backspace" /></button>
            </div>
            {submitting && <div className="kiosk-loading">Checking…</div>}
          </div>
        )}
      </div>
    </div>
  );
}
