import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import './rota.css';
import './eighth.css';
import './tenth.css';

// The rota, in the till settings (Setup → Rota; backend
// restaurantRota.service.js): who works when this week, one row a person,
// one column a day. Tap a day to add a shift, a shift to change it. Drafts
// show dashed until the week is published; published, everyone on it is
// told their shifts, and the till shows who is on today. Last week can be
// copied in one go. Above it, the hours planned and what they cost, against
// what the same days sold last week. Shifts offered by one person and
// taken by another wait above it for a manager to approve or decline.

function addDays(day, n) { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function dayName(d, style) { return new Date(d + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), style); }
const ROLE_TONE = { Cashier: 'cash', Waiter: 'wait', Kitchen: 'kit', Bar: 'bar', Manager: 'mgr', Cleaner: 'cln', Delivery: 'dlv' };
const ROLE_WORD = { Cashier: () => tr('Cashier'), Waiter: () => tr('Waiter'), Kitchen: () => tr('Kitchen'), Bar: () => tr('Bar'), Manager: () => tr('Manager'), Cleaner: () => tr('Cleaner'), Delivery: () => tr('Delivery') };
function roleWord(r) { return ROLE_WORD[r] ? ROLE_WORD[r]() : r; }

function ShiftDialog({ data, shift, onSave, onRemove, onClose, busy, error }) {
  const [s, setS] = useState(shift);
  const hours = (() => {
    if (!/^\d\d:\d\d$/.test(s.starts) || !/^\d\d:\d\d$/.test(s.ends)) return 0;
    const a = +s.starts.slice(0, 2) * 60 + +s.starts.slice(3), b = +s.ends.slice(0, 2) * 60 + +s.ends.slice(3);
    return Math.round(((b > a ? b : b + 1440) - a) / 6) / 10;
  })();
  // At the page's root: the till settings scroll, and would hold it inside.
  return createPortal(
    <div className="dialog-backdrop ro-over" onClick={() => !busy && onClose()}>
      <form className="dialog ro-dlg" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); onSave(s); }} role="dialog" aria-modal="true" aria-labelledby="ro-dlg-title">
        <h3 id="ro-dlg-title">{s.id ? tr('Change the shift') : tr('A new shift')}</h3>
        <label className="ro-field">{tr('Who')}
          <select className="input" value={s.employeeId} onChange={(e) => setS({ ...s, employeeId: e.target.value })} required>
            <option value="">{tr('Pick someone')}</option>
            {data.staff.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="ro-field">{tr('Day')}<input className="input" type="date" value={s.day} onChange={(e) => setS({ ...s, day: e.target.value })} required /></label>
        {data.templates.length > 0 && (
          <div className="ro-tpls">
            {data.templates.map((t) => <button key={t.name + t.starts} type="button" className={'ro-tpl' + (s.starts === t.starts && s.ends === t.ends ? ' is-on' : '')} onClick={() => setS({ ...s, starts: t.starts, ends: t.ends })}>{t.name} <small>{t.starts}–{t.ends}</small></button>)}
          </div>
        )}
        <div className="ro-times">
          <label className="ro-field">{tr('From')}<input className="input" type="time" value={s.starts} onChange={(e) => setS({ ...s, starts: e.target.value })} required /></label>
          <label className="ro-field">{tr('To')}<input className="input" type="time" value={s.ends} onChange={(e) => setS({ ...s, ends: e.target.value })} required /></label>
          <span className="ro-hours">{tr('{n} h', { n: hours })}{s.ends && s.starts && s.ends < s.starts ? ' · ' + tr('past midnight') : ''}</span>
        </div>
        <div className="ro-roles" role="radiogroup" aria-label={tr('Doing')}>
          {data.roles.map((r) => <button key={r} type="button" role="radio" aria-checked={s.role === r} className={'ro-role is-' + ROLE_TONE[r] + (s.role === r ? ' is-on' : '')} onClick={() => setS({ ...s, role: s.role === r ? '' : r })}>{roleWord(r)}</button>)}
        </div>
        <label className="ro-field">{tr('Note')}<input className="input" value={s.note || ''} maxLength={200} onChange={(e) => setS({ ...s, note: e.target.value })} placeholder={tr('e.g. opens up, does the banking')} /></label>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions">
          {s.id && <button type="button" className="btn btn-secondary ro-remove" disabled={busy} onClick={() => onRemove(s)}>{tr('Remove')}</button>}
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !s.employeeId}>{busy ? tr('Saving…') : tr('Save')}</button>
        </div>
      </form>
    </div>, document.body
  );
}

export default function RotaTab({ token, pin, onFail }) {
  const [weekOf, setWeekOf] = useState(() => new Date().toISOString().slice(0, 10));
  const [data, setData] = useState(null);
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const call = useCallback((body) => posFetch('POST', '/pos/settings/rota', token, { managerPin: pin || undefined, weekOf, ...body }), [token, pin, weekOf]);
  useEffect(() => { call({ action: 'week' }).then(setData).catch(onFail); }, [call, onFail]);

  async function act(body, said) {
    setBusy(true); setError('');
    try { const d = await call(body); setData(d); setEdit(null); if (said) setFlash(said(d)); return d; }
    catch (e) { setError(e.message); return null; }
    finally { setBusy(false); }
  }
  if (!data) return <p className="dk-muted">{tr('Loading…')}</p>;
  const days = data.days.map((d) => d.day);
  const by = {};
  data.shifts.forEach((s) => { (by[s.employeeId + ':' + s.day] = by[s.employeeId + ':' + s.day] || []).push(s); });
  const thisWeek = data.weekStart <= data.today && data.today <= data.weekEnd;
  // Who is off when: time off (approved, or asked for) and leave from the OS.
  const offOf = (id, d) => (data.timeOff || []).find((t) => t.employeeId === id && t.from <= d && t.to >= d);
  const cantWork = (id, d) => { const a = (data.availability || {})[id]; return !!(a && a.daysOff.includes(new Date(d + 'T00:00:00Z').getUTCDay())); };

  return (
    <section className="ts-sec ro">
      <div className="ro-bar">
        <div className="ro-nav">
          <button type="button" className="pos-icon-btn" onClick={() => setWeekOf(addDays(data.weekStart, -7))} aria-label={tr('The week before')}>‹</button>
          <strong>{tr('Week of {date}', { date: dayName(data.weekStart, { day: 'numeric', month: 'long' }) })}</strong>
          <button type="button" className="pos-icon-btn" onClick={() => setWeekOf(addDays(data.weekStart, 7))} aria-label={tr('The week after')}>›</button>
          {!thisWeek && <button type="button" className="pos-link" onClick={() => setWeekOf(data.today)}>{tr('This week')}</button>}
        </div>
        <div className="ro-acts">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => act({ action: 'copy' }, (d) => (d.copied === 1 ? tr('1 shift copied from last week.') : tr('{n} shifts copied from last week.', { n: d.copied })))}>⧉ {tr('Copy last week')}</button>
          <button type="button" className="btn btn-primary" disabled={busy || !data.drafts} onClick={() => act({ action: 'publish' }, (d) => tr('Published: {n} people told their shifts.', { n: d.told }))}>
            📣 {data.drafts ? (data.drafts === 1 ? tr('Publish 1 change') : tr('Publish {n} changes', { n: data.drafts })) : tr('Published')}
          </button>
        </div>
      </div>
      {flash && <div className="ts-flash" role="status">✓ {flash}</div>}
      {error && !edit && <div className="error-banner" role="alert">{error}</div>}

      {data.swaps && data.swaps.length > 0 && (
        <div className="sw-strip">
          <strong>🔁 {tr('Shift swaps')}</strong>
          <ul>
            {data.swaps.map((w) => (
              <li key={w.id} className={'is-' + w.status}>
                <span className="sw-who"><b>{w.offeredBy.name}</b><i aria-hidden="true">→</i>{w.takenBy ? <b>{w.takenBy.name}</b> : <em>{tr('nobody yet')}</em>}
                  <small>{dayName(w.shift.day, { weekday: 'short', day: 'numeric', month: 'short' })} · {w.shift.starts}–{w.shift.ends}{w.shift.role ? ' · ' + roleWord(w.shift.role) : ''}{w.note ? ' · “' + w.note + '”' : ''}</small></span>
                {w.status === 'taken' ? (
                  <span className="sw-acts">
                    <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => act({ action: 'decide', swapId: w.id, approve: false }, () => tr('Declined: the shift stays {name}\'s.', { name: w.offeredBy.name }))}>{tr('Decline')}</button>
                    <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act({ action: 'decide', swapId: w.id, approve: true }, () => tr('Approved: the shift is {name}\'s now.', { name: w.takenBy.name }))}>✓ {tr('Approve')}</button>
                  </span>
                ) : <span className="sw-tag is-open">{tr('Up for grabs')}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.timeOffOpen && data.timeOffOpen.length > 0 && (
        <div className="sw-strip toff-strip">
          <strong>🌴 {tr('Time off to decide')}</strong>
          <ul>
            {data.timeOffOpen.map((t) => (
              <li key={t.id} className="is-taken">
                <span className="sw-who"><b>{t.name}</b>
                  <small>{t.from === t.to ? dayName(t.from, { weekday: 'short', day: 'numeric', month: 'short' }) : tr('{from} to {to}', { from: dayName(t.from, { weekday: 'short', day: 'numeric', month: 'short' }), to: dayName(t.to, { weekday: 'short', day: 'numeric', month: 'short' }) })} · {t.days === 1 ? tr('1 day') : tr('{n} days', { n: t.days })}{t.reason ? ' · “' + t.reason + '”' : ''}</small></span>
                <span className="sw-acts">
                  <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => act({ action: 'decideTimeOff', timeOffId: t.id, approve: false }, () => tr('Declined: {name} is told.', { name: t.name }))}>{tr('Decline')}</button>
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={() => act({ action: 'decideTimeOff', timeOffId: t.id, approve: true }, (d) => (d.clashes ? tr('Approved. {name} has {n} shifts on those days: change them on the rota.', { name: t.name, n: d.clashes }) : tr('Approved: {name} is off then.', { name: t.name })))}>✓ {tr('Approve')}</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="ro-cards">
        <div className="ro-card"><small>{tr('Hours planned')}</small><strong>{data.hours.toLocaleString(activeIntlLocale())}</strong><span>{tr('{n} shifts', { n: data.shifts.length })}</span></div>
        <div className="ro-card"><small>{tr('What they cost')}</small><strong>{money(data.cost)}</strong><span>{data.noRate ? tr('{n} shifts with no pay rate', { n: data.noRate }) : tr('at each person\'s rate')}</span></div>
        <div className="ro-card"><small>{tr('Same days last week')}</small><strong>{money(data.salesLastWeek)}</strong><span>{data.salesPerHour ? tr('{amount} of sales an hour planned', { amount: money(data.salesPerHour) }) : tr('sales')}</span></div>
        <div className={'ro-card' + (data.costShare > 30 ? ' is-warn' : '')}><small>{tr('Staff cost of sales')}</small><strong>{data.costShare != null ? data.costShare + '%' : '—'}</strong><span>{tr('planned, against last week')}</span></div>
      </div>

      <div className="ro-grid-wrap">
        <table className="ro-grid">
          <colgroup><col className="ro-col-who" />{data.days.map((d) => <col key={d.day} />)}</colgroup>
          <thead>
            <tr>
              <th className="ro-who-h">{tr('Who')}</th>
              {data.days.map((d) => (
                <th key={d.day} className={(d.day === data.today ? 'is-today' : '') + (d.holiday ? ' is-holiday' : '')}>
                  <span className="ro-dname">{dayName(d.day, { weekday: 'short' })}</span>
                  <span className="ro-ddate">{dayName(d.day, { day: 'numeric', month: 'short' })}</span>
                  {d.holiday && <span className="ro-holiday" title={tr('Public holiday: shifts are paid at the holiday rate.') + (d.holiday.estimated ? ' ' + tr('The date is still to be confirmed.') : '')}>🎉 {d.holiday.name}</span>}
                  {d.salesLastWeek > 0 && <small className="ro-dsales" title={tr('Sold the same day last week')}>{money(d.salesLastWeek)}</small>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.staff.map((p) => (
              <tr key={p.id}>
                <th className="ro-who"><span className="ro-av" aria-hidden="true">{p.name.replace(/^zq\s+/i, '').slice(0, 1)}</span><span><strong>{p.name}</strong><small>{p.hours ? tr('{n} h', { n: p.hours }) : tr('off all week')}</small></span></th>
                {days.map((d) => {
                  const off = offOf(p.id, d);
                  return (
                  <td key={d} className={(d === data.today ? 'is-today' : '') + (cantWork(p.id, d) ? ' is-cant' : '')}>
                    {off && <span className={'toff-chip' + (off.status === 'requested' ? ' is-asked' : '') + (off.kind === 'leave' ? ' is-leave' : '')} title={off.reason || ''}>{off.kind === 'leave' ? '🏖️ ' + tr('Leave') : off.status === 'requested' ? '🌴 ' + tr('Asked off') : '🌴 ' + tr('Off')}</span>}
                    {(by[p.id + ':' + d] || []).map((s) => (
                      <button key={s.id} type="button" className={'ro-shift is-' + (ROLE_TONE[s.role] || 'none') + (s.published ? '' : ' is-draft') + (s.off ? ' is-clash' : '')} onClick={() => { setError(''); setEdit(s); }} title={s.off ? tr('They are off that day') : s.unavailable ? tr('They said they cannot work this day') : s.note || ''}>
                        <b>{s.starts}–{s.ends}</b>{s.role && <small>{roleWord(s.role)}</small>}{(s.off || s.unavailable) && <i className="toff-warn" aria-hidden="true">⚠</i>}
                      </button>
                    ))}
                    {!(off && off.status === 'approved') && <button type="button" className="ro-add" onClick={() => { setError(''); setEdit({ employeeId: p.id, day: d, starts: data.templates[0] ? data.templates[0].starts : '08:00', ends: data.templates[0] ? data.templates[0].ends : '16:00', role: '', note: '' }); }} aria-label={tr('Add a shift for {name} on {day}', { name: p.name, day: dayName(d, { weekday: 'long' }) })}>+</button>}
                  </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th>{tr('On')}</th>
              {data.days.map((d) => <td key={d.day} className={d.day === data.today ? 'is-today' : ''}><b>{d.people}</b> <small>{tr('{n} h', { n: d.hours })}</small></td>)}
            </tr>
          </tfoot>
        </table>
      </div>
      {!data.staff.length && <p className="dk-muted">{tr('Nobody works here yet: add people under People.')}</p>}
      {edit && (
        <ShiftDialog data={data} shift={edit} busy={busy} error={error} onClose={() => setEdit(null)}
          onSave={(s) => act({ action: 'save', shift: s })}
          onRemove={(s) => act({ action: 'remove', id: s.id })} />
      )}
    </section>
  );
}

// For the till: who works today (published shifts).
export function OnToday({ shifts }) {
  if (!shifts || !shifts.length) return <p className="dk-muted">{tr('Nobody is on the rota today.')}</p>;
  const now = new Date().toTimeString().slice(0, 5);
  return (
    <ul className="ro-today">
      {shifts.map((s) => {
        const on = s.ends > s.starts ? now >= s.starts && now < s.ends : now >= s.starts || now < s.ends;
        return (
          <li key={s.id} className={on ? 'is-on' : now >= s.ends && s.ends > s.starts ? 'is-done' : ''}>
            <span className="ro-av" aria-hidden="true">{s.name.replace(/^zq\s+/i, '').slice(0, 1)}</span>
            <span className="ro-today-main"><strong>{s.name}</strong><small>{s.starts}–{s.ends}{s.role ? ' · ' + roleWord(s.role) : ''}{s.note ? ' · ' + s.note : ''}</small></span>
            {on && <em className="ro-now">{tr('on now')}</em>}
          </li>
        );
      })}
    </ul>
  );
}

// For the till: the shifts of whoever is signed in, to offer one to a
// colleague (or take it back), and the shifts others offer, to take.
export function MyShifts({ token, onToast }) {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const call = useCallback((body) => posFetch('POST', '/pos/rota/swaps', token, body), [token]);
  useEffect(() => { call({ action: 'mine' }).then(setD).catch((e) => setError(e.message)); }, [call]);
  async function act(body, said) {
    setBusy(true); setError('');
    try { setD(await call(body)); onToast(said); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  if (!d) return error ? <div className="error-banner" role="alert">{error}</div> : null;
  const when = (x) => dayName(x.day, { weekday: 'short', day: 'numeric', month: 'short' });
  return (
    <div className="sw">
      <h4>🙋 {tr('My shifts')}</h4>
      {!d.mine.length ? <p className="dk-muted">{tr('No shifts on the rota for you in the next four weeks.')}</p> : (
        <ul className="sw-list">
          {d.mine.map((s) => (
            <li key={s.id} className={s.swap ? 'is-' + s.swap.status : ''}>
              <span className="sw-when"><b>{when(s)}</b><small>{s.starts}–{s.ends}{s.role ? ' · ' + roleWord(s.role) : ''}</small></span>
              {s.swap && <span className={'sw-tag is-' + s.swap.status}>{s.swap.status === 'taken' ? tr('{name} would take it', { name: s.swap.takenBy.name }) : tr('Offered')}</span>}
              {s.swap
                ? <button type="button" className="btn btn-secondary sw-btn" disabled={busy} onClick={() => act({ action: 'cancel', swapId: s.swap.id }, tr('The shift is yours again.'))}>{tr('Take back')}</button>
                : <button type="button" className="btn btn-secondary sw-btn" disabled={busy} onClick={() => act({ action: 'offer', shiftId: s.id }, tr('Offered: a colleague can take it, then a manager approves.'))}>🔁 {tr('Offer it')}</button>}
            </li>
          ))}
        </ul>
      )}
      {d.open.length > 0 && (
        <>
          <h4>🎯 {tr('Shifts up for grabs')}</h4>
          <ul className="sw-list">
            {d.open.map((w) => (
              <li key={w.id} className="is-grab">
                <span className="sw-when"><b>{when(w.shift)}</b><small>{w.shift.starts}–{w.shift.ends}{w.shift.role ? ' · ' + roleWord(w.shift.role) : ''} · {tr('from {name}', { name: w.offeredBy.name })}</small></span>
                <button type="button" className="btn btn-primary sw-btn" disabled={busy} onClick={() => act({ action: 'take', swapId: w.id }, tr('Taken: a manager approves it, then it is yours.'))}>{tr('Take it')}</button>
              </li>
            ))}
          </ul>
        </>
      )}
      {d.waiting.length > 0 && <p className="sw-wait">⏳ {d.waiting.length === 1 ? tr('1 shift you took waits for a manager.') : tr('{n} shifts you took wait for a manager.', { n: d.waiting.length })}</p>}
      <TimeOff d={d} busy={busy} act={act} />
      {error && <div className="error-banner" role="alert">{error}</div>}
    </div>
  );
}

// Time off: ask for days off (a manager decides), see what was asked, take
// it back; and the weekdays you cannot work, for whoever plans the rota.
const TOFF = { requested: ['⏳', () => tr('Waiting')], approved: ['✅', () => tr('Approved')], declined: ['✖', () => tr('Declined')] };
function TimeOff({ d, busy, act }) {
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ from: '', to: '', reason: '' });
  const [daysOff, setDaysOff] = useState(d.availability ? d.availability.daysOff : []);
  const range = (t) => (t.from === t.to ? dayName(t.from, { weekday: 'short', day: 'numeric', month: 'short' }) : tr('{from} to {to}', { from: dayName(t.from, { day: 'numeric', month: 'short' }), to: dayName(t.to, { day: 'numeric', month: 'short' }) }));
  const changed = JSON.stringify(daysOff.slice().sort()) !== JSON.stringify(((d.availability && d.availability.daysOff) || []).slice().sort());
  return (
    <div className="toff">
      <h4>🌴 {tr('Time off')}</h4>
      {(d.timeOff || []).length > 0 && (
        <ul className="sw-list">
          {d.timeOff.map((t) => (
            <li key={t.id} className={'toff-' + t.status}>
              <span className="sw-when"><b>{range(t)}</b><small>{t.days === 1 ? tr('1 day') : tr('{n} days', { n: t.days })}{t.reason ? ' · ' + t.reason : ''}</small></span>
              <span className={'sw-tag toff-tag is-' + t.status}>{TOFF[t.status][0]} {TOFF[t.status][1]()}</span>
              {(t.status === 'requested' || t.status === 'approved') && t.to >= today && <button type="button" className="btn btn-secondary sw-btn" disabled={busy} onClick={() => act({ action: 'timeoffCancel', id: t.id }, tr('Your time off is cancelled.'))}>{tr('Cancel')}</button>}
            </li>
          ))}
        </ul>
      )}
      <form className="toff-form" onSubmit={(e) => { e.preventDefault(); act({ action: 'timeoff', from: f.from, to: f.to || f.from, reason: f.reason }, tr('Asked: a manager decides, and you are told.')); setF({ from: '', to: '', reason: '' }); }}>
        <label>{tr('From')}<input className="input" type="date" min={today} required value={f.from} onChange={(e) => setF({ ...f, from: e.target.value, to: f.to && f.to < e.target.value ? e.target.value : f.to })} /></label>
        <label>{tr('To')}<input className="input" type="date" min={f.from || today} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
        <label className="toff-why">{tr('Why (optional)')}<input className="input" maxLength={200} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder={tr('e.g. a wedding')} /></label>
        <button type="submit" className="btn btn-primary" disabled={busy || !f.from}>🌴 {tr('Ask for it')}</button>
      </form>
      <h4>🗓️ {tr('Days I cannot work')}</h4>
      <div className="toff-days" role="group" aria-label={tr('Days I cannot work')}>
        {[1, 2, 3, 4, 5, 6, 0].map((wd) => (
          <button key={wd} type="button" aria-pressed={daysOff.includes(wd)} className={daysOff.includes(wd) ? 'is-on' : ''} onClick={() => setDaysOff(daysOff.includes(wd) ? daysOff.filter((x) => x !== wd) : daysOff.concat([wd]))}>
            {new Date(Date.UTC(2024, 0, 7 + wd)).toLocaleDateString(activeIntlLocale(), { weekday: 'short', timeZone: 'UTC' })}
          </button>
        ))}
        {changed && <button type="button" className="btn btn-primary toff-save" disabled={busy} onClick={() => act({ action: 'availability', daysOff }, tr('Saved: the rota shows it.'))}>{tr('Save')}</button>}
      </div>
    </div>
  );
}
