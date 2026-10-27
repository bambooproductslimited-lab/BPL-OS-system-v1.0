import Photo from '../components/Photo';
import { Icon, fmtDate } from '../components/DashKit';
import { money } from '../lib/currency';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';

// My space's livelier pieces (MySpacePage.jsx): a banner whose sky follows
// the time of day (sunrise, day, sunset, night) with the person, their live
// clock and how far through their shift they are; the number tiles with
// rings; the fortnight as coloured days with the on-time streak; this
// week's hours as bars; what is coming up for them as countdowns; the
// latest payslip split into take-home, SSNIT and PAYE; and an ID card.
// Styles in MySpaceFun.css (.msx-*).

export function skyOf(now) {
  const h = now.getHours();
  return h >= 5 && h < 11 ? 'dawn' : h >= 11 && h < 16 ? 'day' : h >= 16 && h < 20 ? 'dusk' : 'night';
}
export function minutesOf(hhmm) { const [h, m] = String(hhmm || '0:0').split(':').map(Number); return h * 60 + (m || 0); }
export function duration(mins) { const m = Math.max(0, Math.round(mins)); return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'; }
export function longDay(iso) { return new Date(String(iso).slice(0, 10) + 'T12:00').toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long' }); }

const SKY_ART = {
  dawn: <><circle cx="120" cy="120" r="44" className="msx-sun" /><path d="M40 120h-26M226 120h-26M120 40V14M63 63 45 45M177 63l18-18" className="msx-rays" /><path d="M0 150h240" className="msx-horizon" /></>,
  day: <><circle cx="120" cy="96" r="40" className="msx-sun" /><path d="M120 34V14M120 178v-20M58 96H38M202 96h-20M76 52 62 38M164 52l14-14M76 140l-14 14M164 140l14 14" className="msx-rays" /><path d="M150 150c0-14 12-24 26-24 6-14 30-16 40 0 14 0 24 10 24 24z" className="msx-cloud" /></>,
  dusk: <><circle cx="120" cy="138" r="46" className="msx-sun" /><path d="M0 150h240" className="msx-horizon" /><path d="M30 120h40M168 110h50M50 96h30" className="msx-rays" /></>,
  night: <><path d="M150 50a52 52 0 1 0 40 84 44 44 0 1 1-40-84z" className="msx-moon" /><circle cx="50" cy="40" r="3" className="msx-star" /><circle cx="80" cy="96" r="2" className="msx-star" /><circle cx="30" cy="130" r="2.5" className="msx-star" /><circle cx="210" cy="30" r="2" className="msx-star" /><circle cx="226" cy="150" r="3" className="msx-star" /></>
};

// ── the banner ─────────────────────────────────────────────────────────
// clock: { now, att, shift, onDuty, canSelf, clocking, onIn, onOut }
export function MeBanner({ sky, eyebrow, title, sub, person, clock }) {
  const { now, att, shift, onDuty, canSelf, clocking, onIn, onOut } = clock;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const start = shift.start ? minutesOf(shift.start) : null;
  let end = shift.end ? minutesOf(shift.end) : null;
  if (start !== null && end !== null && end <= start) end += 1440;
  const length = start !== null && end !== null ? end - start : null;
  let done = null, text = '';
  if (onDuty) {
    const since = minutesOf(att.clockIn);
    const worked = (nowMin - since + 1440) % 1440;
    done = length ? Math.min(1, worked / length) : null;
    text = tr('{elapsed} so far', { elapsed: duration(worked) }) + (shift.end ? ' · ' + tr('your shift ends at {time}', { time: shift.end }) : '');
  } else if (att && att.clockOut) {
    done = 1;
    text = tr('Done for today: {from} → {to}', { from: att.clockIn, to: att.clockOut }) + ' · ' + duration((minutesOf(att.clockOut) - minutesOf(att.clockIn) + 1440) % 1440);
  } else if (start !== null) {
    text = nowMin < start ? tr('Your shift starts at {time}, in {left}', { time: shift.start, left: duration(start - nowMin) }) : tr('Your shift started at {time}', { time: shift.start });
  }
  return (
    <section className={'msx-hero is-' + sky}>
      <svg className="msx-hero-art" viewBox="0 0 240 180" aria-hidden="true">{SKY_ART[sky]}</svg>
      <div className="msx-hero-main">
        <div className="msx-hero-who">
          <span className="msx-avatar"><Photo id={person.id} name={person.name} photo={person.photo} size={72} /></span>
          <div>
            <p className="msx-eyebrow">{eyebrow}</p>
            <h1 className="msx-hero-title">{title}</h1>
          </div>
        </div>
        <p className="msx-hero-sub">{sub}</p>
      </div>
      <div className="msx-clock">
        <div className="msx-clock-top">
          <span className={'msx-pill' + (onDuty ? ' is-on' : att ? ' is-done' : '')}><i />{onDuty ? tr('On duty') : att ? tr('Shift complete') : tr('Not clocked in')}</span>
          <span className="msx-shift-name">{shift.start ? (shift.name && !shift.name.includes(shift.start) ? shift.name + ' · ' : '') + shift.start + '–' + (shift.end || '?') : tr('No shift set')}</span>
        </div>
        <div className="msx-time">{now.toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' })}<small>{String(now.getSeconds()).padStart(2, '0')}</small></div>
        {done !== null && <span className="msx-progress" role="img" aria-label={tr('{n}% of your shift', { n: Math.round(done * 100) })}><i style={{ width: Math.round(done * 100) + '%' }} /></span>}
        {text && <p className="msx-clock-text">{text}</p>}
        {canSelf && !(att && att.clockOut) && (
          onDuty
            ? <button type="button" className="msx-clock-btn is-out" disabled={clocking} onClick={onOut}>{tr('Clock out')}</button>
            : <button type="button" className="msx-clock-btn" disabled={clocking} onClick={onIn}>{tr('Clock in')}</button>
        )}
      </div>
    </section>
  );
}

// A number tile with a ring (or none).
export function Tile({ icon, value, label, note, ring, tone, onClick }) {
  const r = 26, c = 2 * Math.PI * r;
  return (
    <button type="button" className={'msx-tile' + (tone ? ' is-' + tone : '')} onClick={onClick}>
      {ring !== undefined && ring !== null ? (
        <span className="msx-tile-ring" aria-hidden="true">
          <svg viewBox="0 0 64 64" width="64" height="64"><circle cx="32" cy="32" r={r} className="msx-ring-track" /><circle cx="32" cy="32" r={r} className="msx-ring-fill" strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0, Math.min(1, ring)))} transform="rotate(-90 32 32)" /></svg>
          <span className="msx-tile-icon"><Icon name={icon} /></span>
        </span>
      ) : <span className="msx-tile-icon is-solo"><Icon name={icon} /></span>}
      <span className="msx-tile-body">
        <strong>{value}</strong>
        <span className="msx-tile-label">{label}</span>
        {note && <small>{note}</small>}
      </span>
    </button>
  );
}

// ── the fortnight ───────────────────────────────────────────────────────
const STATUS_WORD = { present: 'On time', late: 'Late', absent: 'Absent', half_day: 'Half day' };
export function Fortnight({ strip, month, streak, best }) {
  return (
    <div className="msx-card msx-fortnight">
      <div className="msx-streak">
        <span className="msx-flame" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 22c-4.4 0-7-2.9-7-6.6 0-3.8 3.2-6 3.8-9.9 2.2 1.4 3.3 3.3 3.3 5.5 1.1-.9 1.8-2.2 1.9-3.6 2.6 2 5 4.7 5 8 0 3.7-2.6 6.6-7 6.6z" /></svg></span>
        <span>
          <strong>{streak === 1 ? tr('1 on-time clock-in in a row') : tr('{n} on-time clock-ins in a row', { n: streak })}</strong>
          <small>{best > streak ? tr('Your best in the last four months: {n}. Keep going!', { n: best }) : streak > 0 ? tr('That is your best run in the last four months.') : tr('Clock in on time to start a run.')}</small>
        </span>
      </div>
      <ol className="msx-days" aria-label={tr('The last 14 days')}>
        {strip.map((d) => {
          const st = d.row ? d.row.status : d.weekday === 0 ? 'off' : 'none';
          return (
            <li key={d.date} className={'msx-dayc is-' + st + (d.today ? ' is-today' : '')} title={fmtDate(d.date) + (d.row ? ': ' + tr(STATUS_WORD[d.row.status] || d.row.status) + ' ' + (d.row.clockIn || '') + (d.row.clockOut ? '–' + d.row.clockOut : '') : '')}>
              <small>{new Date(d.date + 'T12:00').toLocaleDateString(activeIntlLocale(), { weekday: 'narrow' })}</small>
              <b>{new Date(d.date + 'T12:00').getDate()}</b>
              <em>{d.row && d.row.clockIn ? d.row.clockIn : ''}</em>
            </li>
          );
        })}
      </ol>
      <div className="msx-legend">
        <span><i className="is-present" />{tr('On time')}</span><span><i className="is-late" />{tr('Late')}</span><span><i className="is-absent" />{tr('Absent')}</span><span><i className="is-none" />{tr('No record')}</span>
      </div>
      <dl className="msx-month">
        <div><dt>{tr('days worked this month')}</dt><dd>{month.days}</dd></div>
        <div><dt>{tr('late')}</dt><dd>{month.late}</dd></div>
        <div><dt>{tr('hours')}</dt><dd>{month.hours}</dd></div>
        {month.autoOut > 0 && <div><dt>{tr('clocked out by the system')}</dt><dd>{month.autoOut}</dd></div>}
      </dl>
    </div>
  );
}

// ── this week ───────────────────────────────────────────────────────────
// live: hours of today's shift still open (counted so far).
export function Week({ week, total, last, today, live }) {
  const days = week.map((d) => (d.date === today && live ? { ...d, hours: Math.round((d.hours + live) * 10) / 10, live: true } : d));
  total = Math.round((total + (live || 0)) * 10) / 10;
  const max = Math.max(9, ...days.map((d) => d.hours));
  const diff = Math.round((total - last) * 10) / 10;
  return (
    <div className="msx-card msx-week">
      <div className="msx-week-head">
        <span><strong>{tr('{n} hours', { n: total })}</strong><small>{tr('this week so far')}</small></span>
        <span className={'msx-week-vs' + (diff > 0 ? ' is-up' : diff < 0 ? ' is-down' : '')}>{last ? (diff === 0 ? tr('the same as by this time last week') : diff > 0 ? tr('{n} h more than by this time last week', { n: diff }) : tr('{n} h less than by this time last week', { n: -diff })) : tr('nothing last week to compare with')}</span>
      </div>
      <div className="msx-bars" role="img" aria-label={days.map((d) => d.date + ': ' + d.hours + 'h').join(', ')}>
        {days.map((d) => (
          <div key={d.date} className={'msx-bar' + (d.date === today ? ' is-today' : '') + (d.future ? ' is-future' : '') + (d.status === 'late' ? ' is-late' : '') + (d.live ? ' is-live' : '')} title={fmtDate(d.date) + ': ' + d.hours + 'h'}>
            <span className="msx-bar-n">{d.hours ? d.hours : d.open ? '…' : ''}</span>
            <span className="msx-bar-track"><i style={{ height: Math.round((d.hours / max) * 100) + '%' }} /></span>
            <small>{new Date(d.date + 'T12:00').toLocaleDateString(activeIntlLocale(), { weekday: 'short' })}</small>
          </div>
        ))}
      </div>
      <p className="msx-muted">{tr('Hours between clock-in and clock-out each day, today\'s so far while you are on duty. Amber is a late day.')}</p>
    </div>
  );
}

// ── coming up ───────────────────────────────────────────────────────────
// items: [{ key, glyph, days, label, date, tone }]
const GLYPH = {
  plane: <path d="M3 13.5 21 6l-3.5 14-5-5.5L9 18v-5l-6-.5zM12.5 14.5 21 6" />,
  flag: <><path d="M5 21V4M5 4h11l-2 3.5L16 11H5" /></>,
  cake: <><path d="M4 20h16v-7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2z" /><path d="M4 15c2 1.5 4 1.5 5.3 0 1.4 1.5 4 1.5 5.4 0 1.3 1.5 3.3 1.5 5.3 0M12 11V8M12 6.5c-1 0-1.5-.8-1.5-1.5S12 3 12 3s1.5 1.3 1.5 2-.5 1.5-1.5 1.5z" /></>,
  medal: <><circle cx="12" cy="15" r="5" /><path d="M8.5 11 6 3h4l2 5 2-5h4l-2.5 8M12 13v4" /></>,
  cash: <><rect x="3" y="6.5" width="18" height="11" rx="2" /><circle cx="12" cy="12" r="2.5" /></>
};
export function ComingUp({ items }) {
  return (
    <div className="msx-coming">
      {items.map((it) => (
        <div key={it.key} className={'msx-count is-' + it.tone + (it.days === 0 ? ' is-today' : '')}>
          <span className="msx-count-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{GLYPH[it.glyph]}</svg></span>
          <span className="msx-count-n">{it.days === 0 ? <b>{tr('Today!')}</b> : <><b>{it.days}</b><small>{it.days === 1 ? tr('day') : tr('days')}</small></>}</span>
          <span className="msx-count-label">{it.label}</span>
          <small className="msx-count-date">{it.date}</small>
        </div>
      ))}
    </div>
  );
}

// ── the latest payslip, split ───────────────────────────────────────────
export function PayCard({ slip }) {
  const parts = [
    { key: 'net', label: tr('Take-home'), value: slip.net },
    { key: 'advance', label: tr('Advance repaid'), value: slip.advance || 0 },
    { key: 'ssnit', label: 'SSNIT', value: slip.ssnit },
    ...(slip.payeByCompany ? [] : [{ key: 'paye', label: 'PAYE', value: slip.paye }])
  ].filter((p) => p.value > 0);
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  return (
    <div className="msx-pay">
      <div className="msx-pay-top">
        <span><small>{tr('Latest take-home pay')}</small><strong>{money(slip.net, 'GHS')}</strong></span>
        <span className="msx-pay-when">{fmtDate(slip.periodStart)} – {fmtDate(slip.periodEnd)}<br />{slip.status === 'paid' ? tr('paid {date}', { date: fmtDate(slip.payDate) }) : tr('to be paid {date}', { date: fmtDate(slip.payDate) })}</span>
      </div>
      <span className="msx-pay-bar" role="img" aria-label={parts.map((p) => p.label + ' ' + money(p.value, 'GHS')).join(', ')}>
        {parts.map((p) => <i key={p.key} className={'is-' + p.key} style={{ flexGrow: p.value / total }} />)}
      </span>
      <div className="msx-pay-legend">
        {parts.map((p) => <span key={p.key}><i className={'is-' + p.key} />{p.label} <b>{money(p.value, 'GHS')}</b></span>)}
        <span className="msx-muted">{tr('of {gross} gross · {days} days', { gross: money(slip.gross, 'GHS'), days: slip.daysWorked })}{slip.payeByCompany ? ' · ' + tr('PAYE paid by the company') : ''}</span>
      </div>
    </div>
  );
}
