import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
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
// For a real deployment, put the iPad's Safari into Guided Access (Settings
// > Accessibility > Guided Access) pointed at this URL, so it can't be
// swiped away to another app or tab — that's a device-level iOS setting,
// nothing this page can enforce on its own.

const PIN_LENGTH = 4;
const RESULT_DISPLAY_MS = 3500;

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
  const [result, setResult] = useState(null); // { ok, action, employeeName, time, message }
  const resultTimerRef = useRef(null);
  const now = useClock();

  useEffect(() => () => { if (resultTimerRef.current) clearTimeout(resultTimerRef.current); }, []);

  async function submitPin(fullPin) {
    setSubmitting(true);
    try {
      const r = await api.post('/kiosk/clock', { pin: fullPin });
      setResult({ ok: true, action: r.action, employeeName: r.employeeName, time: r.time });
    } catch (err) {
      setResult({ ok: false, message: err.message || 'Something went wrong.' });
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
        <div className="kiosk-brand">Bamboo Products Limited</div>
        <div className="kiosk-clock">
          <div className="kiosk-time">{now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</div>
          <div className="kiosk-date">{now.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })}</div>
        </div>
      </div>

      {result ? (
        <div className={'kiosk-result ' + (result.ok ? 'kiosk-result-ok' : 'kiosk-result-error')}>
          {result.ok ? (
            <>
              <div className="kiosk-result-icon">{result.action === 'in' ? '✓' : '👋'}</div>
              <div className="kiosk-result-title">{result.action === 'in' ? 'Clocked in' : 'Clocked out'}</div>
              <div className="kiosk-result-name">{result.employeeName}</div>
              <div className="kiosk-result-time">{result.time}</div>
            </>
          ) : (
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
