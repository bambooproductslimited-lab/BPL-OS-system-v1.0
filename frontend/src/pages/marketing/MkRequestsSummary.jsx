import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Insights, Section } from '../../components/DashKit';
import Photo from '../../components/Photo';
import { tr } from '../../lib/i18n.jsx';
import { Glyph, L, REQUEST_GLYPH, REQUEST_KINDS, dayLabel, todayIso } from './mkKit';
import { againstWhat, changeText, columnLabel, daysText, insightText, pct, periodName, periodOf, shiftPeriod } from './mkReqSum';
import MkRequestsPresent from './MkRequestsPresent';

// Ask marketing's Summary section (MkRequestsPage.jsx): a week or a month
// at a glance — asked for and done against the period before, how many on
// time, what is late now, how long a request takes; the eight periods up to
// it; what was asked for; who asked and who did the work; what needs
// attention and what is coming up; what stands out. Present turns the same
// figures into slides for a meeting (MkRequestsPresent.jsx). The backend is
// mkRequestSummary.service.js; whose requests follow the board's scope.

const INSIGHT_ICON = { bad: 'warn', warn: 'warn', good: 'spark', info: 'info' };
const short = (iso) => dayLabel(iso, { weekday: 'short', day: 'numeric', month: 'short' });

function Ring({ value }) {
  const r = 22, c = 2 * Math.PI * r, v = value === null ? 0 : value;
  return (
    <svg className="mk-sum-ring" viewBox="0 0 56 56" aria-hidden="true">
      <circle cx="28" cy="28" r={r} className="is-track" />
      <circle cx="28" cy="28" r={r} className="is-fill" strokeDasharray={c} strokeDashoffset={c - (c * v) / 100} transform="rotate(-90 28 28)" />
    </svg>
  );
}

export default function RequestsSummary({ scope, companies, version, onOpen, presenting, onPresenting, paused }) {
  const today = todayIso();
  const [kind, setKind] = useState('month');
  const [from, setFrom] = useState(() => periodOf('month', today).from);
  const [company, setCompany] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let off = false;
    setError(null);
    const q = new URLSearchParams({ scope, period: kind, from });
    if (company) q.set('company', company);
    api.get('/mk/requests/summary?' + q.toString()).then((d) => { if (!off) setData(d); }).catch((e) => { if (!off) setError(e.message); });
    return () => { off = true; };
  }, [scope, kind, from, company, version]);

  function pickKind(k) { setKind(k); setFrom(periodOf(k, today).from); }
  const next = shiftPeriod(kind, from, 1);
  const s = data && data.period.kind === kind && data.period.from === periodOf(kind, from).from ? data : null;
  const cur = s ? s.period.current : false;

  const controls = (
    <div className="mk-sum-controls">
      <div className="mk-chippick" role="radiogroup" aria-label={tr('Summary for')}>
        {[['week', tr('Week')], ['month', tr('Month')]].map(([k, label]) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} className={'mk-chipopt' + (kind === k ? ' is-on' : '')} onClick={() => pickKind(k)}>{label}</button>
        ))}
      </div>
      <div className="mk-sum-step">
        <button type="button" className="mk-btn is-ghost is-small" onClick={() => setFrom(shiftPeriod(kind, from, -1).from)} aria-label={kind === 'week' ? tr('The week before') : tr('The month before')}>‹</button>
        <strong>{periodName(kind, from)}</strong>
        <button type="button" className="mk-btn is-ghost is-small" disabled={next.from > today} onClick={() => setFrom(next.from)} aria-label={kind === 'week' ? tr('The week after') : tr('The month after')}>›</button>
      </div>
      {scope === 'all' && companies.length > 1 && (
        <select className="input mk-sum-co" value={company} onChange={(e) => setCompany(e.target.value)} aria-label={tr('Company')}>
          <option value="">{tr('All companies')}</option>
          {companies.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
        </select>
      )}
      <button type="button" className="mk-btn is-primary is-small" disabled={!s} onClick={() => onPresenting(true)}><Glyph name="play" size={14} />{tr('Present as slides')}</button>
    </div>
  );

  let body = null;
  if (error) body = <div className="error-banner">{error}</div>;
  else if (!s) body = <p className="mk-muted">{tr('Loading…')}</p>;
  else {
    const madeCh = changeText(s.made, s.madeBefore, kind, cur);
    const doneCh = changeText(s.done, s.doneBefore, kind, cur);
    const onPct = pct(s.onTime, s.done);
    const fasterBy = s.days !== null && s.daysBefore !== null ? Math.round((s.daysBefore - s.days) * 10) / 10 : null;
    const max = Math.max(1, ...s.trend.map((t) => Math.max(t.made, t.done)));
    const kMax = Math.max(1, ...s.kinds.map((k) => k.made));
    const coming = s.coming.due.map((r) => ({ key: 'r' + r.id, date: r.dueOn, title: r.title, ref: r.ref, company: r.company.name, lead: r.lead && r.lead.name, id: r.id }))
      .concat(s.coming.routines.map((u, i) => ({ key: 'u' + i, date: u.dueOn, title: u.title, company: u.company.name, lead: u.lead, routine: true, on: u.on })))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const insights = (s.insights || []).map((i) => ({ tone: i.tone, icon: INSIGHT_ICON[i.tone] || 'info', text: insightText(i, kind, cur) }));
    if (!insights.length) insights.push({ tone: 'good', icon: 'check', text: tr('Nothing stands out: no request is late.') });
    body = (
      <>
        <div className="mk-sum-tiles">
          <div className="mk-sum-tile is-asked">
            <span className="mk-sum-glyph"><Glyph name="inbox" size={18} /></span>
            <b>{s.made}</b><span>{s.made === 1 ? tr('request asked for') : tr('requests asked for')}</span>
            <em className={'mk-sum-change is-' + madeCh.dir}>{madeCh.text}</em>
          </div>
          <div className="mk-sum-tile is-done">
            <span className="mk-sum-glyph"><Glyph name="check" size={18} /></span>
            <b>{s.done}</b><span>{tr('requests done')}</span>
            <em className={'mk-sum-change is-' + doneCh.dir}>{doneCh.text}</em>
          </div>
          <div className={'mk-sum-tile is-ontime' + (onPct !== null && onPct < 60 ? ' is-low' : '')}>
            <span className="mk-sum-ringwrap"><Ring value={onPct} /><b>{onPct === null ? '—' : onPct + '%'}</b></span>
            <span>{tr('done by the day needed')}</span>
            <em>{s.done ? tr('{n} of {of}', { n: s.onTime, of: s.done }) : tr('nothing done yet')}</em>
          </div>
          <div className={'mk-sum-tile is-late' + (s.late ? ' is-on' : '')}>
            <span className="mk-sum-glyph"><Glyph name="clock" size={18} /></span>
            <b>{s.late}</b><span>{tr('late right now')}</span>
            <em>{s.fresh ? (s.fresh === 1 ? tr('1 not taken on yet') : tr('{n} not taken on yet', { n: s.fresh })) : tr('none waiting to be taken on')}</em>
          </div>
          <div className="mk-sum-tile is-speed">
            <span className="mk-sum-glyph"><Glyph name="fire" size={18} /></span>
            <b className="is-words">{daysText(s.days)}</b><span>{tr('on average to get one done')}</span>
            <em className={fasterBy ? 'mk-sum-change is-' + (fasterBy > 0 ? 'up' : 'down') : 'mk-sum-change'}>
              {fasterBy ? (fasterBy > 0 ? tr('{days} faster than {when}', { days: daysText(fasterBy), when: againstWhat(kind, cur) }) : tr('{days} slower than {when}', { days: daysText(-fasterBy), when: againstWhat(kind, cur) }))
                : s.days === null ? tr('nothing done yet') : tr('nothing to compare with')}
            </em>
          </div>
        </div>

        <div className="mk-sum-grid">
          <div className="mk-card mk-sum-panel">
            <h4 className="mk-h4"><Glyph name="chart" size={16} />{tr('Asked for and done')}</h4>
            <div className="mk-sum-cols" role="img" aria-label={s.trend.map((t) => columnLabel(kind, t.from) + ': ' + t.made + ' / ' + t.done).join(', ')}>
              {s.trend.map((t) => (
                <div key={t.from} className={'mk-sum-col' + (t.from === s.period.from ? ' is-now' : '')} title={periodName(kind, t.from) + ' · ' + tr('{a} asked for, {b} done', { a: t.made, b: t.done })}>
                  <div className="mk-sum-pair">
                    <i className="is-asked" style={{ height: (t.made / max) * 100 + '%' }}><b>{t.made || ''}</b></i>
                    <i className="is-done" style={{ height: (t.done / max) * 100 + '%' }}><b>{t.done || ''}</b></i>
                  </div>
                  <small>{columnLabel(kind, t.from)}</small>
                </div>
              ))}
            </div>
            <ul className="mk-sum-key"><li><i className="is-asked" />{tr('Asked for')}</li><li><i className="is-done" />{tr('Done')}</li></ul>
          </div>

          <div className="mk-card mk-sum-panel">
            <h4 className="mk-h4"><Glyph name="sparkle" size={16} />{tr('What was asked for')}</h4>
            {s.kinds.length ? (
              <ul className="mk-sum-kinds">
                {s.kinds.slice(0, 7).map((k) => (
                  <li key={k.kind}>
                    <span className="mk-sum-kind"><Glyph name={REQUEST_GLYPH[k.kind]} size={14} />{L(REQUEST_KINDS, k.kind)}</span>
                    <span className="mk-sum-track"><span style={{ width: Math.max(k.made ? 4 : 0, (k.made / kMax) * 100) + '%' }} /></span>
                    <b>{k.made}</b>
                    <small>{tr('{n} done', { n: k.done })}</small>
                  </li>
                ))}
              </ul>
            ) : <p className="mk-muted">{tr('Nothing was asked for in this period.')}</p>}
            {s.companies.length > 1 && (
              <div className="mk-sum-cos">
                {s.companies.map((c) => <span key={c.code} className="mk-sum-cochip"><strong>{c.name}</strong>{tr('{a} asked · {b} done', { a: c.made, b: c.done })}{c.late ? <em> · {tr('{n} past due', { n: c.late })}</em> : null}</span>)}
              </div>
            )}
          </div>

          <div className="mk-card mk-sum-panel">
            <h4 className="mk-h4"><Glyph name="users" size={16} />{tr('Who asked, who did the work')}</h4>
            <div className="mk-sum-people">
              <div>
                <small>{tr('Asked for the most')}</small>
                {s.askers.length ? s.askers.slice(0, 4).map((p) => (
                  <span key={p.id} className="mk-sum-person"><Photo id={p.id} name={p.name} photo={p.photo} size={26} /><span>{p.name}</span><b>{p.n}</b></span>
                )) : <span className="mk-muted">—</span>}
              </div>
              <div>
                <small>{tr('Did the work')}</small>
                {s.team.length ? s.team.slice(0, 4).map((p) => (
                  <span key={p.id} className="mk-sum-person"><Photo id={p.id} name={p.name} photo={p.photo} size={26} /><span>{p.name}<em>{[p.done ? tr('{n} done', { n: p.done }) : null, p.helped ? tr('helped on {n}', { n: p.helped }) : null, p.open ? tr('{n} open', { n: p.open }) : null].filter(Boolean).join(' · ')}</em></span>{p.late ? <i className="mk-sum-late">{tr('{n} past due', { n: p.late })}</i> : null}</span>
                )) : <span className="mk-muted">—</span>}
              </div>
            </div>
          </div>
        </div>

        <div className="mk-sum-grid is-two">
          <div className="mk-card mk-sum-panel">
            <h4 className="mk-h4"><Glyph name="clock" size={16} />{tr('Needs attention now')}</h4>
            {s.lateList.length ? (
              <ul className="mk-sum-list">
                {s.lateList.slice(0, 4).map((r) => (
                  <li key={r.id}><button type="button" onClick={() => onOpen(r.id)}>
                    <span className="mk-sum-ref">{r.ref}</span>
                    <span className="mk-sum-what"><strong>{r.title}</strong><small>{[r.company.name, r.lead ? r.lead.name : tr('nobody leading it')].join(' · ')}</small></span>
                    <i className="mk-sum-late">{r.daysLate === 1 ? tr('1 day late') : tr('{n} days late', { n: r.daysLate })}</i>
                  </button></li>
                ))}
              </ul>
            ) : <p className="mk-sum-ok"><Glyph name="check" size={15} /> {tr('Nothing is late.')}</p>}
            <p className="mk-muted mk-sum-foot">{[
              s.fresh ? (s.fresh === 1 ? tr('1 not taken on yet') : tr('{n} not taken on yet', { n: s.fresh })) : null,
              s.review ? (s.review === 1 ? tr('1 ready for the one who asked to check') : tr('{n} ready for the ones who asked to check', { n: s.review })) : null,
              s.lateList.length > 4 ? tr('and {n} more late', { n: s.lateList.length - 4 }) : null
            ].filter(Boolean).join(' · ') || tr('Nothing waiting.')}</p>
          </div>
          <div className="mk-card mk-sum-panel">
            <h4 className="mk-h4"><Glyph name="calendar" size={16} />{kind === 'week' ? tr('Coming up in the next 7 days') : tr('Coming up in the next 30 days')}</h4>
            {coming.length ? (
              <ul className="mk-sum-list">
                {coming.slice(0, 5).map((c) => (
                  <li key={c.key} className={c.routine ? 'is-routine' : ''}>
                    <button type="button" disabled={!c.id} onClick={() => c.id && onOpen(c.id)}>
                      <span className="mk-sum-ref">{short(c.date)}</span>
                      <span className="mk-sum-what"><strong>{c.routine && <Glyph name="repeat" size={12} />}{c.title}</strong>
                        <small>{[c.company, c.lead, c.routine ? tr('made by a routine on {date}', { date: short(c.on) }) : c.ref].filter(Boolean).join(' · ')}</small></span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p className="mk-muted">{tr('Nothing is due.')}</p>}
            {coming.length > 5 && <p className="mk-muted mk-sum-foot">{tr('and {n} more coming up', { n: coming.length - 5 })}</p>}
          </div>
        </div>
        <Insights items={insights} />
      </>
    );
  }

  return (
    <Section id="mk-summary" title={tr('Summary')}
      sub={tr('{period}: what was asked of marketing and what it delivered, against {when}.', { period: periodName(kind, from), when: againstWhat(kind, s ? cur : periodOf(kind, from).to >= today) })}
      action={controls}>
      {body}
      {presenting && data && (
        <MkRequestsPresent s={s} kind={kind} from={periodOf(kind, from).from} onPeriod={setFrom} onOpen={onOpen} paused={paused} onClose={() => onPresenting(false)} />
      )}
    </Section>
  );
}
