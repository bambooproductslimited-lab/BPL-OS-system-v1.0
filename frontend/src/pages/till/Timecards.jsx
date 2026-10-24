import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import './eighth.css';

// Timecards, in the till settings (Setup → Timecards; backend
// restaurantTimecards week / correct): the week's clock-ins against the
// rota — late, left early, overtime, not on the rota, still on, closed by
// itself — each person's hours and what they cost, the shifts nobody came
// to; a manager corrects a card with a reason kept on it. A download for
// payroll.

function addDays(day, n) { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function dayName(d, style) { return new Date(d + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), style); }
function hrs(m) { const h = Math.floor(m / 60), r = m % 60; return h + ':' + String(r).padStart(2, '0'); }
const FLAG = {
  late: ['🐢', 'warn', (c) => tr('{n} min late', { n: c.lateMinutes })],
  early: ['🏃', 'warn', (c) => tr('left {n} min early', { n: c.earlyMinutes })],
  overtime: ['⏫', 'info', (c) => tr('{n} min over', { n: c.overtimeMinutes })],
  unplanned: ['❔', 'muted', () => tr('not on the rota')],
  open: ['🟢', 'ok', () => tr('on now')],
  auto: ['🤖', 'bad', () => tr('closed by itself')]
};

function CorrectDialog({ card, busy, error, onSave, onClose }) {
  const [v, setV] = useState({ in: card.in, out: card.out || '', breakMinutes: card.breakMinutes, reason: '' });
  return createPortal(
    <div className="dialog-backdrop tcr-over" onClick={() => !busy && onClose()}>
      <form className="dialog tcr-dlg" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onSave(v); }} role="dialog" aria-modal="true" aria-labelledby="tcr-title">
        <h3 id="tcr-title">{tr('Correct {name}\'s timecard', { name: card.name })}</h3>
        <p className="dk-muted">{dayName(card.day, { weekday: 'long', day: 'numeric', month: 'long' })}{card.planned ? ' · ' + tr('on the rota {from}–{to}', { from: card.planned.starts, to: card.planned.ends }) : ''}</p>
        <div className="tcr-times">
          <label className="ro-field">{tr('In')}<input className="input" type="time" required value={v.in} onChange={(e) => setV({ ...v, in: e.target.value })} /></label>
          <label className="ro-field">{tr('Out')}<input className="input" type="time" value={v.out} onChange={(e) => setV({ ...v, out: e.target.value })} /></label>
          <label className="ro-field">{tr('Breaks (min)')}<input className="input" type="number" min="0" max="600" step="5" value={v.breakMinutes} onChange={(e) => setV({ ...v, breakMinutes: e.target.value })} /></label>
        </div>
        {v.out && v.out <= v.in && <p className="dk-muted">🌙 {tr('Out the next day.')}</p>}
        <label className="ro-field">{tr('Why')}<input className="input" required minLength={3} maxLength={200} value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} placeholder={tr('e.g. forgot to clock out; came in at 8 as agreed')} /></label>
        {card.note && <p className="tcr-note">{card.note}</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? tr('Saving…') : tr('Save')}</button>
        </div>
      </form>
    </div>, document.body
  );
}

export default function TimecardsTab({ token, pin, onFail }) {
  const [weekOf, setWeekOf] = useState(() => new Date().toISOString().slice(0, 10));
  const [data, setData] = useState(null);
  const [who, setWho] = useState('');
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const call = useCallback((body) => posFetch('POST', '/pos/settings/timecards', token, { managerPin: pin || undefined, weekOf, ...body }), [token, pin, weekOf]);
  useEffect(() => { call({ action: 'week' }).then(setData).catch(onFail); }, [call, onFail]);

  async function save(v) {
    setBusy(true); setError('');
    try {
      setData(await call({ action: 'correct', card: { id: edit.id, in: v.in, out: v.out || null, breakMinutes: Number(v.breakMinutes) || 0 }, reason: v.reason }));
      setFlash(tr('{name}\'s timecard corrected.', { name: edit.name })); setEdit(null);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  function download() {
    const rows = [['Day', 'Name', 'In', 'Out', 'Break minutes', 'Hours worked', 'Rota', 'Notes']].concat(data.cards.map((c) => [
      c.day, c.name, c.in, c.out || '', c.breakMinutes, (c.workedMinutes / 60).toFixed(2), c.planned ? c.planned.starts + '-' + c.planned.ends : '', c.flags.join(' ') + (c.edited ? ' corrected' : '')]));
    const csv = rows.map((r) => r.map((x) => '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"').join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = 'timecards-' + data.weekStart + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  if (!data) return <p className="dk-muted">{tr('Loading…')}</p>;
  const thisWeek = data.weekStart <= data.today && data.today <= data.weekEnd;
  const cards = who ? data.cards.filter((c) => c.employeeId === who) : data.cards;
  const missed = who ? data.missed.filter((m) => m.employeeId === who) : data.missed;
  const onNow = data.staff.filter((p) => p.onNow).length;
  const days = Array.from({ length: 7 }, (_, i) => addDays(data.weekStart, i)).filter((d) => cards.some((c) => c.day === d) || missed.some((m) => m.day === d));

  return (
    <section className="ts-sec tcr">
      <div className="ro-bar">
        <div className="ro-nav">
          <button type="button" className="pos-icon-btn" onClick={() => setWeekOf(addDays(data.weekStart, -7))} aria-label={tr('The week before')}>‹</button>
          <strong>{tr('Week of {date}', { date: dayName(data.weekStart, { day: 'numeric', month: 'long' }) })}</strong>
          <button type="button" className="pos-icon-btn" onClick={() => setWeekOf(addDays(data.weekStart, 7))} aria-label={tr('The week after')}>›</button>
          {!thisWeek && <button type="button" className="pos-link" onClick={() => setWeekOf(data.today)}>{tr('This week')}</button>}
        </div>
        <button type="button" className="btn btn-secondary" disabled={!data.cards.length} onClick={download}>⬇ {tr('Download for payroll')}</button>
      </div>
      {flash && <div className="ts-flash" role="status">✓ {flash}</div>}

      <div className="ro-cards">
        <div className="ro-card"><small>{tr('Hours worked')}</small><strong>{data.hours.toLocaleString(activeIntlLocale())}</strong><span>{tr('of {n} h on the rota', { n: data.plannedHours })}</span>
          <i className="tcr-bar" aria-hidden="true"><b style={{ width: Math.min(100, data.plannedHours ? (data.hours / data.plannedHours) * 100 : 0) + '%' }} /></i></div>
        <div className="ro-card"><small>{tr('What they cost')}</small><strong>{money(data.cost)}</strong><span>{tr('at each person\'s rate')}</span></div>
        <div className={'ro-card' + (data.late ? ' is-warn' : '')}><small>{tr('Late arrivals')}</small><strong>{data.late}</strong><span>{tr('more than 5 minutes after the rota')}</span></div>
        <div className={'ro-card' + (data.missed.length ? ' is-warn' : '')}><small>{tr('Shifts missed')}</small><strong>{data.missed.length}</strong><span>{onNow ? tr('{n} on shift now', { n: onNow }) : tr('nobody on shift now')}</span></div>
      </div>

      {data.staff.length > 0 && (
        <div className="tcr-people" role="tablist" aria-label={tr('Whose timecards')}>
          <button type="button" role="tab" aria-selected={!who} className={'tcr-person' + (!who ? ' is-on' : '')} onClick={() => setWho('')}><span className="ro-av" aria-hidden="true">★</span><span><strong>{tr('Everyone')}</strong><small>{tr('{n} people', { n: data.staff.length })}</small></span></button>
          {data.staff.map((p) => (
            <button key={p.id} type="button" role="tab" aria-selected={who === p.id} className={'tcr-person' + (who === p.id ? ' is-on' : '')} onClick={() => setWho(who === p.id ? '' : p.id)}>
              <span className="ro-av" aria-hidden="true">{p.name.replace(/^zq\s+/i, '').slice(0, 1)}{p.onNow && <i className="tcr-live" />}</span>
              <span><strong>{p.name}</strong><small>{tr('{a} of {b} h', { a: p.hours, b: p.plannedHours })}{p.cost != null ? ' · ' + money(p.cost) : ''}</small>
                {(p.late > 0 || p.missed > 0 || p.overtimeHours > 0) && <em>{[p.late ? tr('{n} late', { n: p.late }) : null, p.missed ? tr('{n} missed', { n: p.missed }) : null, p.overtimeHours ? tr('{n} h over', { n: p.overtimeHours }) : null].filter(Boolean).join(' · ')}</em>}</span>
            </button>
          ))}
        </div>
      )}

      {!days.length ? <div className="dk-empty"><p>{tr('Nobody clocked in this week yet. Staff clock in on the till\'s PIN screen: Time clock.')}</p></div> : days.map((d) => (
        <div key={d} className="tcr-day">
          <h4>{dayName(d, { weekday: 'long', day: 'numeric', month: 'short' })}{d === data.today && <span className="tcr-today">{tr('Today')}</span>}</h4>
          <ul className="tcr-list">
            {cards.filter((c) => c.day === d).map((c) => (
              <li key={c.id} className={c.flags.includes('open') ? 'is-open' : ''}>
                <span className="ro-av" aria-hidden="true">{c.name.replace(/^zq\s+/i, '').slice(0, 1)}</span>
                <span className="tcr-main"><strong>{c.name}</strong>
                  <small>{c.planned ? tr('rota {from}–{to}', { from: c.planned.starts, to: c.planned.ends }) : tr('not on the rota')}{c.edited ? ' · ✎ ' + tr('corrected') : ''}</small></span>
                <span className="tcr-span"><b>{c.in}</b><i aria-hidden="true">→</i><b>{c.out || '…'}</b>{c.breakMinutes > 0 && <small>☕ {tr('{n} min', { n: c.breakMinutes })}</small>}</span>
                <span className="tcr-flags">{c.flags.map((f) => FLAG[f] && <span key={f} className={'tcr-flag is-' + FLAG[f][1]}>{FLAG[f][0]} {FLAG[f][2](c)}</span>)}</span>
                <b className="tcr-worked">{hrs(c.workedMinutes)}</b>
                <button type="button" className="btn btn-secondary tcr-fix" onClick={() => { setError(''); setEdit(c); }}>✎ {tr('Correct')}</button>
              </li>
            ))}
            {missed.filter((m) => m.day === d).map((m) => (
              <li key={m.employeeId + m.starts} className="is-missed">
                <span className="ro-av is-missed" aria-hidden="true">!</span>
                <span className="tcr-main"><strong>{m.name}</strong><small>{tr('rota {from}–{to}', { from: m.starts, to: m.ends })}</small></span>
                <span className="tcr-flags"><span className="tcr-flag is-bad">🚫 {tr('did not clock in')}</span></span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {edit && <CorrectDialog card={edit} busy={busy} error={error} onSave={save} onClose={() => setEdit(null)} />}
    </section>
  );
}
