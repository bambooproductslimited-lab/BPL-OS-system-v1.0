import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import { enqueueTap, peekQueue, removeFromQueue, queueLength } from '../kiosk/offlineQueue';
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

const PIN_LENGTH = 4;
const RESULT_DISPLAY_MS = 3500;
const FLUSH_INTERVAL_MS = 20000;

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
  const [result, setResult] = useState(null); // { kind: 'ok'|'error'|'pending', action, employeeName, time, message }
  const [pendingCount, setPendingCount] = useState(0);
  const resultTimerRef = useRef(null);
  const flushingRef = useRef(false);
  const now = useClock();

  useEffect(() => () => { if (resultTimerRef.current) clearTimeout(resultTimerRef.current); }, []);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/kiosk-sw.js', { scope: '/kiosk' }).catch(() => {});
    }
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
          await api.post('/kiosk/clock', { pin: item.pin, occurredAt: item.occurredAt });
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

  async function submitPin(fullPin) {
    setSubmitting(true);
    try {
      const r = await api.post('/kiosk/clock', { pin: fullPin });
      setResult({ kind: 'ok', action: r.action, employeeName: r.employeeName, time: r.time });
      flushQueue(); // a live tap just succeeded, so we're online — try any backlog too
    } catch (err) {
      if (err instanceof ApiError) {
        setResult({ kind: 'error', message: err.message || 'Something went wrong.' });
      } else {
        enqueueTap(fullPin, new Date().toISOString());
        setPendingCount(queueLength());
        setResult({ kind: 'pending' });
      }
    } finally {
      setSubmitting(false);
      setPin('');
      resultTimerRef.current = setTimeout(() => setResult(null), RESULT_DISPLAY_MS);
    }
  }

  function tapDigit(d) {
    if (submitting || result) return;
    const next = pin + d;
    setPin(next);
    if (next.length === PIN_LENGTH) submitPin(next);
  }
  function tapClear() { if (!submitting) setPin(''); }
  function tapBackspace() { if (!submitting) setPin(pin.slice(0, -1)); }

  return (
    <div className="kiosk-root">
      <div className="kiosk-header">
        <div>
          <div className="kiosk-brand">CHOU AND ASSOCIATES</div>
          {pendingCount > 0 && (
            <div className="kiosk-pending-badge">{pendingCount} tap{pendingCount === 1 ? '' : 's'} syncing…</div>
          )}
        </div>
        <div className="kiosk-clock">
          <div className="kiosk-time">{now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</div>
          <div className="kiosk-date">{now.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}</div>
        </div>
      </div>

      {result ? (
        <div className={'kiosk-result ' + (result.kind === 'ok' ? 'kiosk-result-ok' : result.kind === 'pending' ? 'kiosk-result-pending' : 'kiosk-result-error')}>
          {result.kind === 'ok' && (
            <>
              <div className="kiosk-result-icon">{result.action === 'in' ? '✓' : '👋'}</div>
              <div className="kiosk-result-title">{result.action === 'in' ? 'Clocked in' : 'Clocked out'}</div>
              <div className="kiosk-result-name">{result.employeeName}</div>
              <div className="kiosk-result-time">{result.time}</div>
            </>
          )}
          {result.kind === 'pending' && (
            <>
              <div className="kiosk-result-icon">☁</div>
              <div className="kiosk-result-title">Recorded</div>
              <div className="kiosk-result-name">No connection — this will sync automatically once you're back online.</div>
            </>
          )}
          {result.kind === 'error' && (
            <>
              <div className="kiosk-result-icon">✕</div>
              <div className="kiosk-result-title">{result.message}</div>
            </>
          )}
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
            <button type="button" className="kiosk-key kiosk-key-muted" disabled={submitting} onClick={tapBackspace}>⌫</button>
          </div>
          {submitting && <div className="kiosk-loading">Checking…</div>}
        </div>
      )}
    </div>
  );
}
