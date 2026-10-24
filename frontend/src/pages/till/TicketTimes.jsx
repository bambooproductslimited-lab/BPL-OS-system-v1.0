import { useEffect, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import { RANGES, rangeOf, useTip } from './ranges';
import './growth.css';
import './tenth.css';

// Back office → Reports → Ticket times (backend restaurantTicketTimes): how
// long the kitchen took from a ticket reaching it to ready, against its own
// targets (Setup → Kitchen: slow after, late after). The median and the
// slowest tenth, beside the days before; by day, by hour, by station and
// by order type; the slowest dishes and tickets. Colour says on time, slow
// or late (status colours, always with their sign and a legend); the
// slowest tenth is the grey tick.

const STATE = { ok: ['✓', () => tr('On time')], slow: ['⚠', () => tr('Slow')], late: ['⏰', () => tr('Late')] };
const KIND = { dine_in: ['🍽️', () => tr('Dine in')], pickup: ['🛍️', () => tr('Pickup')], delivery: ['🛵', () => tr('Delivery')], takeaway: ['🥡', () => tr('Takeaway')] };
function num(n) { return Number(n).toLocaleString(activeIntlLocale(), { maximumFractionDigits: 1 }); }
function mins(n) { return n == null ? '—' : tr('{n} min', { n: num(n) }); }
function stateOf(m, t) { return m == null ? 'none' : m > t.lateAfter ? 'late' : m > t.warnAfter ? 'slow' : 'ok'; }
function short(day) { return new Date(day + 'T12:00:00').toLocaleDateString(activeIntlLocale(), { weekday: 'short', day: 'numeric' }); }
function when(s) { return new Date(s).toLocaleString(activeIntlLocale(), { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function hourText(h) { return String(h).padStart(2, '0') + ':00'; }
function kindOf(f) { return KIND[f] || ['🧾', () => f]; }

// One row of a horizontal chart: the median (coloured by how it stands) and
// the slowest tenth as a tick.
function Row({ label, s, t, max, tipOn, sub }) {
  const st = stateOf(s.median, t);
  return (
    <li>
      <span className="in-bar-name">{label}</span>
      <span className="in-bar-track" {...tipOn(label + ' · ' + tr('Median') + ' ' + mins(s.median) + ' · ' + tr('Slowest tenth') + ' ' + mins(s.p90) + ' · ' + tr('{n} tickets', { n: s.tickets }) + (st !== 'none' ? ' · ' + STATE[st][1]() : ''))}>
        <span className={'in-bar tt-bar is-' + st} style={{ width: Math.max(2, (s.median || 0) / max * 100) + '%' }} />
        {s.p90 != null && <span className="in-tick" style={{ left: 'calc(' + Math.min(100, s.p90 / max * 100) + '% - 1.5px)' }} />}
      </span>
      <span className="in-bar-val">{st !== 'none' && <i className={'tt-sign is-' + st} aria-hidden="true">{STATE[st][0]}</i>}{mins(s.median)}<small>{sub}</small></span>
    </li>
  );
}

export default function TicketTimes({ token, pin, onFail }) {
  const [range, setRange] = useState('7');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [asTable, setAsTable] = useState(false);
  const [tipOn, tipNode] = useTip();
  const r = rangeOf(range);
  useEffect(() => {
    setBusy(true);
    posFetch('POST', '/pos/settings/tickettimes', token, { managerPin: pin || undefined, from: r.from, to: r.to })
      .then(setData).catch(onFail).finally(() => setBusy(false));
  }, [range, token, pin]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <section className="ts-sec"><p className="dk-muted">{busy ? tr('Loading…') : ''}</p></section>;
  const t = data.targets, T = data.totals, B = data.before;
  const delta = T.median != null && B.median != null ? Math.round((T.median - B.median) * 10) / 10 : null;
  const top = Math.max(t.lateAfter * 1.2, ...data.byDay.map((d) => d.p90 || 0), ...data.byHour.map((h) => h.p90 || 0), ...data.byStation.map((s) => s.p90 || 0), 1);
  const dayMax = Math.max(t.lateAfter * 1.2, ...data.byDay.map((d) => d.p90 || d.median || 0), 1);
  const st = stateOf(T.median, t);
  return (
    <section className={'ts-sec in tt' + (busy ? ' is-busy' : '')}>
      <div className="in-filters">
        <div className="ts-chips" role="radiogroup" aria-label={tr('When')}>
          {RANGES.map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={range === k} className={range === k ? 'is-on' : ''} onClick={() => setRange(k)}>{tr(label)}</button>)}
        </div>
        <button type="button" className="btn btn-secondary in-table-btn" onClick={() => setAsTable(!asTable)}>{asTable ? tr('Show charts') : tr('Show as a table')}</button>
      </div>

      <div className={'tt-hero is-' + st}>
        <span className="tt-clock" aria-hidden="true"><i style={{ '--turn': Math.min(1, (T.median || 0) / (t.lateAfter * 1.5)) }} /></span>
        <div className="tt-hero-main">
          <small>{tr('Half the tickets were ready within')}</small>
          <strong>{mins(T.median)}</strong>
          <span>{st !== 'none' ? STATE[st][0] + ' ' + STATE[st][1]() + ' · ' : ''}{tr('slow after {warn} min, late after {late} min', { warn: t.warnAfter, late: t.lateAfter })}</span>
        </div>
        {delta != null && <span className={'in-delta tt-delta ' + (delta < 0 ? 'is-good' : delta > 0 ? 'is-bad' : 'is-flat')}>{delta < 0 ? '▼ ' + tr('{n} min faster than the days before', { n: num(-delta) }) : delta > 0 ? '▲ ' + tr('{n} min slower than the days before', { n: num(delta) }) : tr('The same as the days before')}</span>}
      </div>

      <div className="in-kpis">
        {[['🎟️', tr('Tickets'), T.tickets, B.tickets ? tr('{n} the days before', { n: B.tickets }) : null],
          ['✓', tr('On time'), T.onTime != null ? T.onTime + '%' : '—', B.onTime != null ? tr('{n}% the days before', { n: B.onTime }) : null],
          ['🐢', tr('Slowest tenth'), mins(T.p90), tr('1 ticket in 10 took longer')],
          ['⏰', tr('Late'), T.late, T.slow ? tr('{n} slow', { n: T.slow }) : null]].map(([art, label, value, sub]) => (
          <div key={label} className={'in-kpi' + (label === tr('Late') && T.late > 0 ? ' is-alert' : '')}><span className="in-kpi-ico" aria-hidden="true">{art}</span><span className="in-kpi-label">{label}</span><strong>{value}</strong>{sub && <small className="dk-muted">{sub}</small>}</div>
        ))}
      </div>
      {T.forgotten > 0 && <p className="ts-note">💡 {T.forgotten === 1 ? tr('1 ticket stayed on the screen over 4 hours: left there, not cooking, so it is not counted.') : tr('{n} tickets stayed on the screen over 4 hours: left there, not cooking, so they are not counted.', { n: T.forgotten })}</p>}

      {!T.tickets ? (
        <div className="dk-empty tt-empty"><span aria-hidden="true">👩‍🍳</span><p>{tr('No ticket was bumped ready on the kitchen screen in these days. Ticket times come from the kitchen screen.')}</p></div>
      ) : asTable ? (
        <div className="in-card">
          <table className="ga-table"><thead><tr><th>{tr('Day')}</th><th className="is-num">{tr('Tickets')}</th><th className="is-num">{tr('Median')}</th><th className="is-num">{tr('Slowest tenth')}</th><th className="is-num">{tr('On time')}</th><th className="is-num">{tr('Late')}</th></tr></thead>
            <tbody>{data.byDay.map((d) => <tr key={d.day}><td>{short(d.day)}</td><td className="is-num">{d.tickets}</td><td className="is-num">{mins(d.median)}</td><td className="is-num">{mins(d.p90)}</td><td className="is-num">{d.onTime != null ? d.onTime + '%' : '—'}</td><td className="is-num">{d.late}</td></tr>)}</tbody></table>
        </div>
      ) : (
        <>
          <p className="in-legend tt-legend">
            {['ok', 'slow', 'late'].map((k) => <span key={k}><i className={'in-key tt-key is-' + k} aria-hidden="true" />{STATE[k][0]} {STATE[k][1]()}</span>)}
            <span><i className="in-key is-before" aria-hidden="true" />{tr('Slowest tenth')}</span>
          </p>
          <div className="in-card">
            <h3>{tr('Each day')}<small>{tr('The median ticket; the dashed lines are slow and late')}</small></h3>
            <div className="tt-days">
              <span className="tt-line is-slow" style={{ bottom: (t.warnAfter / dayMax * 100) + '%' }}><em>{tr('{n} min', { n: t.warnAfter })}</em></span>
              <span className="tt-line is-late" style={{ bottom: (t.lateAfter / dayMax * 100) + '%' }}><em>{tr('{n} min', { n: t.lateAfter })}</em></span>
              {data.byDay.map((d) => {
                const s = stateOf(d.median, t);
                return (
                  <div key={d.day} className="in-day tt-day" {...tipOn(short(d.day) + ' · ' + (d.tickets ? tr('Median') + ' ' + mins(d.median) + ' · ' + tr('Slowest tenth') + ' ' + mins(d.p90) + ' · ' + tr('{n} tickets', { n: d.tickets }) + ' · ' + STATE[s][1]() : tr('No tickets')))}>
                    <span className="in-day-col">
                      {d.tickets > 0 && <span className={'in-day-bar tt-bar is-' + s} style={{ height: (d.median / dayMax * 100) + '%' }} />}
                      {d.p90 != null && <span className="tt-dtick" style={{ bottom: (Math.min(d.p90, dayMax) / dayMax * 100) + '%' }} />}
                    </span>
                    <small>{data.byDay.length <= 14 ? short(d.day) : new Date(d.day + 'T12:00:00').getDate()}</small>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="in-grid">
            <article className="in-card">
              <h3>{tr('By hour')}<small>{tr('When the ticket reached the kitchen')}</small></h3>
              <ul className="in-bars is-plain">
                {data.byHour.map((h) => <Row key={h.hour} label={hourText(h.hour)} s={h} t={t} max={top} tipOn={tipOn} sub={tr('{n} tickets', { n: h.tickets })} />)}
              </ul>
            </article>
            <article className="in-card">
              <h3>{tr('By station')}<small>{tr('Each dish, until it was bumped there')}</small></h3>
              {!data.byStation.length ? <p className="dk-muted">{tr('No dish was bumped at a station.')}</p> : (
                <ul className="in-bars is-plain">
                  {data.byStation.map((s) => <Row key={s.station} label={s.station} s={s} t={t} max={top} tipOn={tipOn} sub={tr('{n} dishes', { n: s.tickets })} />)}
                </ul>
              )}
              {data.byFulfillment.length > 1 && (
                <div className="in-mini tt-kinds">
                  {data.byFulfillment.map((f) => { const k = kindOf(f.fulfillment); return <div key={f.fulfillment} className={stateOf(f.median, t) === 'late' ? 'is-warn' : ''}><span>{k[0]} {k[1]()}</span><b>{mins(f.median)}</b><small>{tr('{n} tickets', { n: f.tickets })}</small></div>; })}
                </div>
              )}
            </article>
            <article className="in-card">
              <h3>{tr('The slowest dishes')}<small>{tr('On average, made at least twice')}</small></h3>
              {!data.slowestDishes.length ? <p className="dk-muted">{tr('Not enough dishes yet.')}</p> : (
                <ol className="tt-list">
                  {data.slowestDishes.map((d, i) => {
                    const s = stateOf(d.average, t);
                    return <li key={d.name}><b className="tt-rank">{i + 1}</b><span className="tt-main"><strong>{d.name}</strong><small>{tr('Made {n} times', { n: d.made })}{d.late ? ' · ' + tr('{n} late', { n: d.late }) : ''} · {tr('slowest tenth {m}', { m: mins(d.p90) })}</small></span><span className={'tt-pill is-' + s}>{STATE[s][0]} {mins(d.average)}</span></li>;
                  })}
                </ol>
              )}
            </article>
            <article className="in-card">
              <h3>{tr('The slowest tickets')}</h3>
              <ol className="tt-list">
                {data.slowestTickets.map((k) => {
                  const s = stateOf(k.minutes, t), kd = kindOf(k.fulfillment || 'dine_in');
                  return <li key={k.number + k.sentAt}><span className="tt-rank is-ico" aria-hidden="true">{kd[0]}</span><span className="tt-main"><strong>#{k.number}{k.label ? ' · ' + k.label : ''}</strong><small>{when(k.sentAt)} · {kd[1]()}</small></span><span className={'tt-pill is-' + s}>{STATE[s][0]} {mins(k.minutes)}</span></li>;
                })}
              </ol>
            </article>
          </div>
        </>
      )}
      {tipNode}
    </section>
  );
}
