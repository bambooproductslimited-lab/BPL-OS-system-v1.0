import { useEffect, useRef, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import './eighth.css';

// The time clock on the till's PIN screen (backend restaurantTimecards
// timeclock): a PIN, then where that person stands — out, on shift, on a
// break — with today's shift on the rota, and one tap to clock in, start
// or end a break, or clock out. Back to the PIN pad by itself after a
// little while, the PIN forgotten.

const PIN_LENGTH = 4;
const IDLE_MS = 20000;
const DONE_MS = 6000;

function timeOf(iso) { return new Date(iso).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' }); }
function hoursText(m) { const h = Math.floor(m / 60), r = m % 60; return h ? tr('{h} h {m} min', { h, m: r }) : tr('{n} min', { n: r }); }
const SAID = {
  in: () => tr('Clocked in. Have a good shift!'),
  break: () => tr('Enjoy your break.'),
  back: () => tr('Welcome back.'),
  out: () => tr('Clocked out. Thank you, see you next time!')
};

export default function TimeClock({ onClose }) {
  const [pin, setPin] = useState('');
  const [who, setWho] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const pinRef = useRef('');
  const timer = useRef(null);

  function reset() { pinRef.current = ''; setPin(''); setWho(null); setDone(null); setError(null); }
  function later(ms, fn) { clearTimeout(timer.current); timer.current = setTimeout(fn, ms); }
  useEffect(() => () => clearTimeout(timer.current), []);

  async function ask(action, fullPin) {
    setBusy(true); setError(null);
    try {
      const s = await posFetch('POST', '/pos/timeclock', null, { pin: fullPin || pinRef.current, action });
      setWho(s);
      if (action === 'status') later(IDLE_MS, reset);
      else { setDone(action); later(DONE_MS, reset); }
    } catch (e) {
      setError(e.message);
      if (action === 'status') { pinRef.current = ''; setPin(''); }
    } finally { setBusy(false); }
  }
  function tap(d) {
    if (busy || who) return;
    const next = (pinRef.current + d).slice(0, PIN_LENGTH);
    pinRef.current = next; setPin(next);
    if (next.length === PIN_LENGTH) ask('status', next);
  }
  function back() { if (!busy && !who) { pinRef.current = pinRef.current.slice(0, -1); setPin(pinRef.current); } }
  useEffect(() => {
    function onKey(e) {
      if (who) { if (e.key === 'Escape') reset(); return; }
      if (/^[0-9]$/.test(e.key)) tap(e.key);
      else if (e.key === 'Backspace') back();
      else if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (who) {
    const first = String(who.name || '').replace(/^zq\s+/i, '').split(' ')[0] || who.firstName;
    const p = who.planned;
    return (
      <div className={'tc-who tc-' + who.state + (done ? ' is-done' : '')}>
        <span className="tc-av" aria-hidden="true">{first.slice(0, 1).toUpperCase()}</span>
        <h2>{done ? SAID[done]() : tr('Hi {name}', { name: first })}</h2>
        <p className={'tc-state tc-' + who.state}>
          <i aria-hidden="true" />
          {who.state === 'out' ? tr('Not clocked in')
            : who.state === 'break' ? tr('On a break since {time}', { time: timeOf(who.since) })
              : tr('On shift since {time}', { time: timeOf(who.since) })}
        </p>
        {who.state !== 'out' && (
          <div className="tc-figs">
            <span><b>{hoursText(who.workedMinutes)}</b><small>{tr('worked')}</small></span>
            <span><b>{hoursText(who.breakMinutes)}</b><small>{tr('on breaks')}</small></span>
          </div>
        )}
        <p className="tc-plan">📅 {p ? tr('Today on the rota: {from}–{to}', { from: p.starts, to: p.ends }) + (p.role ? ' · ' + p.role : '') : tr('Not on the rota today')}</p>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {!done && (
          <div className="tc-acts">
            {who.state === 'out' && <button type="button" className="tc-go tc-go-in" disabled={busy} onClick={() => ask('in')}>▶ {tr('Clock in')}</button>}
            {who.state === 'in' && <button type="button" className="tc-go tc-go-break" disabled={busy} onClick={() => ask('break')}>☕ {tr('Start a break')}</button>}
            {who.state === 'break' && <button type="button" className="tc-go tc-go-back" disabled={busy} onClick={() => ask('back')}>↩ {tr('End my break')}</button>}
            {who.state !== 'out' && <button type="button" className="tc-go tc-go-out" disabled={busy} onClick={() => { if (window.confirm(tr('Clock out now?'))) ask('out'); }}>■ {tr('Clock out')}</button>}
          </div>
        )}
        <button type="button" className="btn btn-secondary tc-done" onClick={reset}>{done ? tr('Done') : tr('Not me')}</button>
      </div>
    );
  }
  return (
    <div className="tc-pad">
      <div className={'pos-pin' + (error ? ' is-bad' : '')} aria-label={tr('PIN')}>
        {Array.from({ length: PIN_LENGTH }).map((_, i) => <span key={i} className={i < pin.length ? 'is-on' : ''} />)}
      </div>
      <p className={'pos-pin-note' + (error ? ' is-bad' : '')} role="status">{busy ? tr('Checking…') : error || tr('Your PIN to clock in or out, or for a break.')}</p>
      <div className="pos-keypad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button key={d} type="button" disabled={busy} onClick={() => tap(d)}>{d}</button>)}
        <button type="button" className="is-muted" disabled={busy} onClick={() => { pinRef.current = ''; setPin(''); }}>{tr('Clear')}</button>
        <button type="button" disabled={busy} onClick={() => tap('0')}>0</button>
        <button type="button" className="is-muted" disabled={busy} onClick={back} aria-label={tr('Backspace')}>⌫</button>
      </div>
    </div>
  );
}
