import { useMemo } from 'react';
import Photo from '../../components/Photo';
import SlideDeck from '../../components/SlideDeck';
import { tr } from '../../lib/i18n.jsx';
import { Glyph, L, REQUEST_GLYPH, REQUEST_KINDS, REQUEST_STATUS, dayLabel, todayIso } from './mkKit';
import { againstWhat, changeText, columnLabel, daysText, pct, periodName, recentPeriods } from './mkReqSum';
import '../crm/SalesPresent.css';
import './MkRequestsPresent.css';

// Ask marketing's summary as slides, for the marketing meeting (the slide
// show is components/SlideDeck.jsx; the figures are the Summary section's,
// mkRequestSummary.service.js): the period at a glance, asked for and done
// over the eight periods up to it, what was asked for and by whom, every
// request done (on time or how late), what needs attention now, who did the
// work, and what is coming up — the requests routines will make dashed.
// Pressing a request opens it over the slides (the page's request window).

const PER_SLIDE = 6;
function chunk(list, n) { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; }
const short = (iso) => dayLabel(iso, { weekday: 'short', day: 'numeric', month: 'short' });

function Bars({ items, empty }) {
  const max = Math.max(1, ...items.map((x) => x.n));
  if (!items.length) return <p className="ssr-none">{empty}</p>;
  return (
    <ul className="mkp-bars">
      {items.map((x) => (
        <li key={x.key}>
          <span className="mkp-bar-label">{x.glyph && <Glyph name={x.glyph} size={14} />}{x.label}</span>
          <span className="mkp-bar-track"><span style={{ width: Math.max(x.n ? 3 : 0, (x.n / max) * 100) + '%' }} /></span>
          <b>{x.n}</b>
          {x.note && <small>{x.note}</small>}
        </li>
      ))}
    </ul>
  );
}

export default function MkRequestsPresent({ s, kind, from, onPeriod, onOpen, paused, onClose }) {
  const today = todayIso();
  const periods = useMemo(() => {
    const list = recentPeriods(kind, today, 8);
    if (!list.some((p) => p.from === from)) list.push({ from, label: periodName(kind, from) });
    return list;
  }, [kind, from, today]);

  const slides = useMemo(() => {
    if (!s) return [];
    const out = [{ key: 'cover', kind: 'cover' }, { key: 'trend', kind: 'trend' }, { key: 'what', kind: 'what' }];
    chunk(s.doneList, PER_SLIDE).forEach((list, i, all) => out.push({ key: 'done-' + i, kind: 'done', list, page: i + 1, pages: all.length }));
    if (s.lateList.length || s.waiting.length) out.push({ key: 'attention', kind: 'attention' });
    if (s.team.length) out.push({ key: 'team', kind: 'team' });
    if (s.coming.due.length || s.coming.routines.length) out.push({ key: 'coming', kind: 'coming' });
    out.push({ key: 'end', kind: 'end' });
    return out;
  }, [s]);

  function render(sl) {
    const cur = s.period.current, name = periodName(kind, s.period.from), when = againstWhat(kind, cur);
    const onPct = pct(s.onTime, s.done);
    const where = s.company ? s.company.name : s.scope === 'all' ? tr('All companies') : tr('Your requests');
    if (sl.kind === 'cover') {
      const madeCh = changeText(s.made, s.madeBefore, kind, cur), doneCh = changeText(s.done, s.doneBefore, kind, cur);
      const top = s.kinds.slice().sort((a, b) => b.made - a.made)[0];
      return (
        <div className="wop-cover">
          <span className="wop-eyebrow">{tr('Ask marketing')} · {where}</span>
          <h1>{kind === 'week' ? tr('Marketing requests this week') : tr('Marketing requests this month')}</h1>
          <p className="wop-range">{name}{cur ? ' · ' + tr('so far') : ''}</p>
          <div className="wop-tiles">
            <div className="wop-tile is-asked"><b>{s.made}</b><span>{tr('asked for')}</span><span className={'ssr-change is-' + madeCh.dir}>{madeCh.text}</span></div>
            <div className="wop-tile is-good"><b>{s.done}</b><span>{tr('requests done')}</span><span className={'ssr-change is-' + doneCh.dir}>{doneCh.text}</span></div>
            <div className={'wop-tile ' + (onPct === null ? '' : onPct >= 80 ? 'is-good' : onPct >= 60 ? 'is-pend' : 'is-bad')}><b>{onPct === null ? '—' : onPct + '%'}</b><span>{tr('done by the day needed')}</span></div>
            <div className={'wop-tile ' + (s.late ? 'is-bad' : 'is-good')}><b>{s.late}</b><span>{tr('late right now')}</span></div>
          </div>
          <p className="wop-foot">{[
            s.days !== null ? tr('{days} on average to get one done', { days: daysText(s.days) }) : null,
            s.urgent ? (s.urgent === 1 ? tr('1 urgent') : tr('{n} urgent', { n: s.urgent })) : null,
            s.fromRoutines ? (s.fromRoutines === 1 ? tr('1 made by a routine') : tr('{n} made by routines', { n: s.fromRoutines })) : null,
            top && top.made ? tr('most asked for: {kind}', { kind: L(REQUEST_KINDS, top.kind) }) : null
          ].filter(Boolean).join(' · ')}</p>
        </div>
      );
    }
    if (sl.kind === 'trend') {
      const max = Math.max(1, ...s.trend.map((t) => Math.max(t.made, t.done)));
      const before = pct(s.onTimeBefore, s.doneBefore);
      return (
        <div className="wop-sum">
          <header className="wop-head">
            <span className="wop-eyebrow mkp-eb">{tr('Asked for and done')}</span>
            <h2>{tr('{a} asked for, {b} done', { a: s.made, b: s.done })}</h2>
            <p className="wop-sub">{kind === 'week' ? tr('The last 8 weeks.') : tr('The last 8 months.')}</p>
          </header>
          <div className="wop-sum-grid">
            <section className="wop-panel">
              <div className="mkp-cols" role="img" aria-label={s.trend.map((t) => columnLabel(kind, t.from) + ': ' + t.made + ' / ' + t.done).join(', ')}>
                {s.trend.map((t) => (
                  <span key={t.from} className={'mkp-col' + (t.from === s.period.from ? ' is-now' : '')}>
                    <span className="mkp-pair">
                      <i className="is-asked" style={{ height: (t.made / max) * 86 + '%' }}><b>{t.made || ''}</b></i>
                      <i className="is-done" style={{ height: (t.done / max) * 86 + '%' }}><b>{t.done || ''}</b></i>
                    </span>
                    <small>{columnLabel(kind, t.from)}</small>
                  </span>
                ))}
              </div>
              <ul className="ssr-key mkp-key"><li><i className="is-asked" />{tr('Asked for')}</li><li><i className="is-done" />{tr('Done')}</li></ul>
            </section>
            <section className="wop-panel wop-facts">
              <div className={'wop-fact' + (onPct !== null && onPct < 60 ? ' is-bad' : '')}><b>{onPct === null ? '—' : onPct + '%'}</b><span>{tr('done by the day needed')}{before !== null ? ' · ' + tr('{pct}% {when}', { pct: before, when }) : ''}</span></div>
              <div className="wop-fact"><b className="mkp-words">{daysText(s.days)}</b><span>{tr('on average to get one done')}{s.daysBefore !== null ? ' · ' + tr('{days} {when}', { days: daysText(s.daysBefore), when }) : ''}</span></div>
              <div className={'wop-fact' + (s.urgent ? ' is-warn' : '')}><b>{s.urgent}</b><span>{tr('asked for as urgent')}</span></div>
              <div className="wop-fact"><b>{s.fromRoutines}</b><span>{tr('made by routines')}</span></div>
            </section>
          </div>
        </div>
      );
    }
    if (sl.kind === 'what') {
      const kinds = s.kinds.map((k) => ({ key: k.kind, label: L(REQUEST_KINDS, k.kind), glyph: REQUEST_GLYPH[k.kind], n: k.made, note: tr('{n} done', { n: k.done }) }));
      const cos = s.companies.map((c) => ({ key: c.code, label: c.name, n: c.made, note: tr('{n} done', { n: c.done }) + (c.late ? ' · ' + tr('{n} past due', { n: c.late }) : '') }));
      return (
        <div className="wop-sum">
          <header className="wop-head">
            <span className="wop-eyebrow mkp-eb">{tr('What was asked for')}</span>
            <h2>{tr('What the company asked marketing for')}</h2>
          </header>
          <div className={cos.length > 1 ? 'ssr-three' : 'wop-sum-grid'}>
            <section className="wop-panel"><h3>{tr('By kind')}</h3><Bars items={kinds.slice(0, 8)} empty={tr('Nothing was asked for in this period.')} /></section>
            {cos.length > 1 && <section className="wop-panel"><h3>{tr('By company')}</h3><Bars items={cos} empty="—" /></section>}
            <section className="wop-panel">
              <h3>{tr('Who asked')}</h3>
              {s.askers.length ? (
                <ul className="mkp-people">
                  {s.askers.slice(0, 6).map((p) => <li key={p.id}><Photo id={p.id} name={p.name} photo={p.photo} size={34} /><span>{p.name}</span><b>{p.n}</b></li>)}
                </ul>
              ) : <p className="ssr-none">{tr('Nobody asked for anything in this period.')}</p>}
            </section>
          </div>
        </div>
      );
    }
    if (sl.kind === 'done') {
      return (
        <div className="wop-list">
          <header className="wop-head is-row">
            <span className="wop-eyebrow is-good">{tr('Done')}</span>
            <h2>{s.done === 1 ? tr('1 request done') : tr('{n} requests done', { n: s.done })}{s.done - s.onTime > 0 ? <span className="ssr-h2-note">{tr('{n} after the day needed', { n: s.done - s.onTime })}</span> : null}</h2>
            {sl.pages > 1 && <span className="wop-page">{tr('{a} of {b}', { a: sl.page, b: sl.pages })}</span>}
          </header>
          <div className="wop-cards">
            {sl.list.map((x) => (
              <button key={x.id} type="button" className={'wop-card mkp-card' + (x.onTime ? '' : ' is-late')} onClick={() => onOpen(x.id)}>
                <span className="wop-card-top">
                  <span className="wop-no">{x.ref}</span>
                  {x.fromRoutine && <span className="mkp-tag"><Glyph name="repeat" size={11} />{tr('routine')}</span>}
                  <span className="wop-st"><Glyph name={REQUEST_GLYPH[x.kind]} size={12} />{L(REQUEST_KINDS, x.kind)}</span>
                </span>
                <strong className="wop-card-title">{x.title}</strong>
                <span className="wop-for"><span>{x.company.name}</span></span>
                <span className={'wop-when ' + (x.onTime ? 'is-good' : 'is-bad')}>
                  {x.onTime ? tr('On time') : x.daysLate === 1 ? tr('1 day late') : tr('{n} days late', { n: x.daysLate })}
                  <b>{tr('done {date}', { date: short(x.doneOn) })}</b>
                </span>
                <span className="wop-people">
                  {x.lead ? <><Photo id={x.lead.id} name={x.lead.name} photo={x.lead.photo} size={22} /><span>{x.lead.name}</span></> : <span>{tr('Nobody led it')}</span>}
                  {x.delivered > 0 && <em>{x.delivered === 1 ? tr('1 file handed over') : tr('{n} files handed over', { n: x.delivered })}</em>}
                </span>
              </button>
            ))}
          </div>
        </div>
      );
    }
    if (sl.kind === 'attention') {
      return (
        <div className="wop-sum">
          <header className="wop-head">
            <span className="wop-eyebrow mkp-eb-bad">{tr('Needs attention now')}</span>
            <h2>{s.late ? (s.late === 1 ? tr('1 request is late') : tr('{n} requests are late', { n: s.late })) : tr('Nothing is late')}</h2>
            <p className="wop-sub">{tr('As things stand today, {date}.', { date: short(today) })}</p>
          </header>
          <div className="wop-sum-grid">
            <section className="wop-panel">
              <h3>{tr('Past the day needed')}</h3>
              {s.lateList.length ? (
                <ul className="mkp-rows">
                  {s.lateList.slice(0, 6).map((r) => (
                    <li key={r.id}><button type="button" onClick={() => onOpen(r.id)}>
                      <span className="wop-no">{r.ref}</span>
                      <span className="mkp-row-main"><strong>{r.title}</strong><small>{[r.company.name, r.lead ? r.lead.name : tr('nobody leading it'), L(REQUEST_STATUS, r.status)].join(' · ')}</small></span>
                      <b className="mkp-late">{r.daysLate === 1 ? tr('1 day late') : tr('{n} days late', { n: r.daysLate })}</b>
                    </button></li>
                  ))}
                  {s.lateList.length > 6 && <li className="ssr-more">{tr('and {n} more late', { n: s.lateList.length - 6 })}</li>}
                </ul>
              ) : <p className="ssr-none">{tr('Every open request is on time.')}</p>}
            </section>
            <section className="wop-panel">
              <h3>{tr('Waiting')}</h3>
              {s.waiting.length ? (
                <ul className="mkp-rows">
                  {s.waiting.slice(0, 6).map((r) => (
                    <li key={r.id}><button type="button" onClick={() => onOpen(r.id)}>
                      <span className={'mkp-state is-' + r.status}>{r.status === 'new' ? tr('Not taken on') : tr('To check')}</span>
                      <span className="mkp-row-main"><strong>{r.title}</strong><small>{[r.company.name, r.asker ? tr('asked by {name}', { name: r.asker.name }) : null, r.dueOn ? tr('needed {date}', { date: short(r.dueOn) }) : null].filter(Boolean).join(' · ')}</small></span>
                    </button></li>
                  ))}
                </ul>
              ) : <p className="ssr-none">{tr('Nothing is waiting.')}</p>}
            </section>
          </div>
        </div>
      );
    }
    if (sl.kind === 'team') {
      return (
        <div className="wop-sum">
          <header className="wop-head"><span className="wop-eyebrow mkp-eb">{tr('The team')}</span><h2>{tr('Who did the work')}</h2></header>
          <table className="wop-table">
            <thead><tr><th>{tr('Person')}</th><th>{tr('Led and done')}</th><th>{tr('On time')}</th><th>{tr('Helped on')}</th><th>{tr('Open now')}</th><th>{tr('Late now')}</th></tr></thead>
            <tbody>
              {s.team.slice(0, 8).map((p) => (
                <tr key={p.id}>
                  <td><span className="wop-pm"><Photo id={p.id} name={p.name} photo={p.photo} size={28} />{p.name}</span></td>
                  <td><b>{p.done || <span className="wop-zero">0</span>}</b></td>
                  <td>{p.done ? <b className={p.onTime < p.done ? 'is-bad' : 'is-good'}>{p.onTime}</b> : <span className="wop-zero">—</span>}</td>
                  <td>{p.helped || <span className="wop-zero">0</span>}</td>
                  <td>{p.open || <span className="wop-zero">0</span>}</td>
                  <td>{p.late ? <b className="is-bad">{p.late}</b> : <span className="wop-zero">0</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {s.team.length > 8 && <p className="wop-note">{tr('and {n} more', { n: s.team.length - 8 })}</p>}
        </div>
      );
    }
    if (sl.kind === 'coming') {
      const rows = s.coming.due.map((r) => ({ key: 'r' + r.id, id: r.id, date: r.dueOn, title: r.title, sub: [r.ref, r.company.name, r.lead ? r.lead.name : null, L(REQUEST_STATUS, r.status)] }))
        .concat(s.coming.routines.map((u, i) => ({ key: 'u' + i, date: u.dueOn, title: u.title, routine: true, sub: [u.company.name, u.lead, tr('made by a routine on {date}', { date: short(u.on) })] })))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      const half = Math.ceil(Math.min(rows.length, 12) / 2);
      const col = (list) => (
        <ul className="mkp-rows">
          {list.map((r) => (
            <li key={r.key} className={r.routine ? 'is-routine' : ''}><button type="button" disabled={!r.id} onClick={() => r.id && onOpen(r.id)}>
              <span className="mkp-date">{short(r.date)}</span>
              <span className="mkp-row-main"><strong>{r.routine && <Glyph name="repeat" size={12} />}{r.title}</strong><small>{r.sub.filter(Boolean).join(' · ')}</small></span>
            </button></li>
          ))}
        </ul>
      );
      return (
        <div className="wop-sum">
          <header className="wop-head">
            <span className="wop-eyebrow is-pend">{tr('Coming up')}</span>
            <h2>{tr('Needed between {a} and {b}', { a: short(s.coming.from), b: short(s.coming.to) })}</h2>
            <p className="wop-sub">{tr('Requests already asked for, and the ones routines will make (dashed).')}</p>
          </header>
          <div className="wop-sum-grid is-even">
            <section className="wop-panel">{col(rows.slice(0, half))}</section>
            <section className="wop-panel">{rows.length > half ? col(rows.slice(half, 12)) : <p className="ssr-none">—</p>}</section>
          </div>
          {rows.length > 12 && <p className="wop-note">{tr('and {n} more coming up', { n: rows.length - 12 })}</p>}
        </div>
      );
    }
    return (
      <div className="wop-cover is-end">
        <span className="wop-eyebrow">{tr('Ask marketing')} · {name}</span>
        <h1>{tr('Thank you')}</h1>
        <p className="wop-range">{s.late
          ? (s.late === 1 ? tr('First thing: the 1 late request.') : tr('First thing: the {n} late requests.', { n: s.late }))
          : s.fresh ? (s.fresh === 1 ? tr('Next: take on the 1 new request.') : tr('Next: take on the {n} new requests.', { n: s.fresh }))
            : tr('Everything is on track. Keep it that way.')}</p>
      </div>
    );
  }

  return (
    <>
      <SlideDeck brand={tr('Ask marketing · review')} className="is-mkreq" weeks={periods} weekFrom={from} onWeek={onPeriod}
        periodLabel={kind === 'week' ? tr('Which week') : tr('Which month')} slides={slides} render={render} onClose={onClose} paused={paused} />
      {!s && <div className="ssr-loading" role="status">{tr('Loading…')}</div>}
    </>
  );
}
