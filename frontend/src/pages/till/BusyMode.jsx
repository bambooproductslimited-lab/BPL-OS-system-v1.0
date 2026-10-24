import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { posFetch } from '../../lib/posApi';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import './ninth.css';

// Busy mode for the website (More → Busy mode, and the pill at the top
// while it is on; backend restaurantDelivery busy/setBusy): when the
// kitchen is full, website orders take longer for a while — the website
// says so and an accepted order gets the longer time — or are paused, only
// orders for later taken. Over by itself when its time is up.

const EXTRAS = [10, 15, 20, 30, 45, 60];
const FOR = [15, 30, 60, 90, 120, 240];
function hhmm(iso) { return new Date(iso).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' }); }
function minutesLeft(iso) { return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000)); }
function forWords(m) { return m < 60 ? tr('{n} min', { n: m }) : m % 60 === 0 ? (m === 60 ? tr('1 hour') : tr('{n} hours', { n: m / 60 })) : tr('{h} h {m} min', { h: Math.floor(m / 60), m: m % 60 }); }

// The pill at the top of the till while busy mode is on.
export function BusyPill({ busy, onClick }) {
  if (!busy) return null;
  return (
    <button type="button" className={'pos-stat bzy-pill is-' + busy.mode} onClick={onClick}>
      <span className="pos-stat-ico" aria-hidden="true">{busy.mode === 'paused' ? '⏸️' : '🔥'}</span>
      <span className="pos-stat-text">
        <small>{busy.mode === 'paused' ? tr('Website paused') : tr('Busy: +{n} min', { n: busy.extraMinutes })}</small>
        <strong>{tr('until {time}', { time: hhmm(busy.until) })}</strong>
      </span>
    </button>
  );
}

export default function BusyMode({ token, onClose, onChanged, onToast }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState('busy');
  const [extra, setExtra] = useState(15);
  const [minutes, setMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  useEffect(() => { posFetch('GET', '/pos/busy', token).then(setD).catch((e) => setError(e.message)); }, [token]);
  async function set(body) {
    setBusy(true); setError(null);
    try {
      const r = await posFetch('POST', '/pos/busy', token, body);
      setD(r); onChanged(r.busy);
      onToast(!r.busy ? tr('Website orders are back to normal.') : r.busy.mode === 'paused' ? tr('Website orders paused until {time}.', { time: hhmm(r.busy.until) }) : tr('Website orders take {n} min longer until {time}.', { n: r.busy.extraMinutes, time: hhmm(r.busy.until) }));
      onClose();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const on = d && d.busy;
  return createPortal(
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog bzy-dlg" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="bzy-title">
        <div className="bzy-head">
          <span className={'bzy-flame' + (on ? ' is-' + on.mode : '')} aria-hidden="true">{on && on.mode === 'paused' ? '⏸️' : '🔥'}</span>
          <div><h2 id="bzy-title">{tr('Busy mode')}</h2><p className="dk-muted">{tr('Kitchen full? Tell the website: orders take longer, or pause them for a while.')}</p></div>
        </div>
        {!d ? <p className="dk-muted">{error || tr('Loading…')}</p> : !d.takesOnline ? (
          <p className="bzy-note">🌐 {tr('This restaurant does not take orders online yet: set it up in Deliveries.')}</p>
        ) : (
          <>
            {on && (
              <div className={'bzy-now is-' + on.mode}>
                <strong>{on.mode === 'paused' ? tr('Website orders are paused') : tr('Website orders take {n} min longer', { n: on.extraMinutes })}</strong>
                <span>{tr('Until {time} · {n} min left', { time: hhmm(on.until), n: minutesLeft(on.until) })}{on.by ? ' · ' + tr('by {name}', { name: on.by }) : ''}</span>
                <button type="button" className="btn btn-primary tl-btn" disabled={busy} onClick={() => set({ mode: 'off' })}>✓ {tr('Back to normal now')}</button>
              </div>
            )}
            {!d.open && <p className="bzy-note">🌙 {tr('The website is not taking orders now anyway (Deliveries → taking orders online).')}</p>}
            <div className="bzy-modes" role="radiogroup" aria-label={tr('Busy mode')}>
              <button type="button" role="radio" aria-checked={mode === 'busy'} className={mode === 'busy' ? 'is-on' : ''} onClick={() => setMode('busy')}>
                <span aria-hidden="true">🐢</span><strong>{tr('Orders take longer')}</strong><small>{tr('Usually {n} min: customers see the longer time', { n: d.readyMinutes })}</small>
              </button>
              <button type="button" role="radio" aria-checked={mode === 'paused'} className={mode === 'paused' ? 'is-on' : ''} onClick={() => setMode('paused')}>
                <span aria-hidden="true">⏸️</span><strong>{tr('Pause orders')}</strong><small>{tr('Only orders for later are taken')}</small>
              </button>
            </div>
            {mode === 'busy' && (
              <div className="bzy-field"><span>{tr('How much longer')}</span>
                <div className="bzy-chips">{EXTRAS.map((m) => <button key={m} type="button" className={extra === m ? 'is-on' : ''} onClick={() => setExtra(m)}>+{m}</button>)}</div>
                <small>{tr('Ready in about {n} min instead of {was}.', { n: Math.min(240, d.readyMinutes + extra), was: d.readyMinutes })}</small>
              </div>
            )}
            <div className="bzy-field"><span>{tr('For')}</span>
              <div className="bzy-chips">{FOR.map((m) => <button key={m} type="button" className={minutes === m ? 'is-on' : ''} onClick={() => setMinutes(m)}>{forWords(m)}</button>)}</div>
              <small>{tr('Back to normal by itself at {time}.', { time: hhmm(new Date(Date.now() + minutes * 60000).toISOString()) })}</small>
            </div>
          </>
        )}
        {error && d && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary tl-btn" onClick={onClose} disabled={busy}>{tr('Close')}</button>
          {d && d.takesOnline && <button type="button" className={'btn tl-btn bzy-go is-' + mode} disabled={busy} onClick={() => set({ mode, minutes, extraMinutes: extra })}>
            {mode === 'paused' ? '⏸️ ' + tr('Pause for {t}', { t: forWords(minutes) }) : '🔥 ' + tr('+{n} min for {t}', { n: extra, t: forWords(minutes) })}</button>}
        </div>
      </div>
    </div>, document.body
  );
}
