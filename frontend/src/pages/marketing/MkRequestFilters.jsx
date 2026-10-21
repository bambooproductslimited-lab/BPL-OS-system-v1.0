import { useEffect, useState } from 'react';
import { msg, tr } from '../../lib/i18n.jsx';
import { Glyph, REQUEST_KINDS, todayIso } from './mkKit';
import { DATE_BY, UNITS, activeFilters, rangeName, rangeOf, stepRange } from './mkReqFilter';

// The filter bar over Ask marketing's board (MkRequestsPage.jsx): when —
// all time, a day, a week, a month, a year (stepped back and forth with
// ‹ ›) or days picked by hand — on the date it was asked for, needed by or
// done; then words, its type, a person on it, its company, and urgent,
// late or from a routine. What is on reads as a line of chips, each taken
// off by pressing it, with how many of all the requests show.

const UNIT_LABEL = { all: msg('All time'), day: msg('Day'), week: msg('Week'), month: msg('Month'), year: msg('Year'), custom: msg('Pick days') };
const NOW_LABEL = { day: msg('Today'), week: msg('This week'), month: msg('This month'), year: msg('This year') };
const DATE_BY_LABEL = { asked: msg('By the day it was asked for'), needed: msg('By the day it is needed'), done: msg('By the day it was done') };

// f: the filters (mkReqFilter.noFilters); onSet(patch) changes some,
// onClear() takes them all off. shown / total: requests on the board, of all.
export default function RequestFilters({ f, onSet, onClear, people, companies, showCompany, shown, total }) {
  const today = todayIso();
  // Words are sent once typing stops.
  const [words, setWords] = useState(f.q);
  useEffect(() => { setWords(f.q); }, [f.q]);
  useEffect(() => {
    if (words === f.q) return undefined;
    const t = setTimeout(() => onSet({ q: words }), 300);
    return () => clearTimeout(t);
  }, [words]); // eslint-disable-line react-hooks/exhaustive-deps

  const stepped = f.unit !== 'all' && f.unit !== 'custom';
  const range = stepped ? rangeOf(f.unit, f.at) : null;
  const next = stepped ? stepRange(f.unit, f.at, 1) : null;
  // Nothing is asked for or done in the days to come; needed by, it can be.
  const noFuture = stepped && f.dateBy !== 'needed' && next.from > today;
  const isNow = stepped && today >= range.from && today <= range.to;
  const active = activeFilters(f, people, companies);

  return (
    <div className="mk-rf">
      <div className="mk-rf-row">
        <span className="mk-rf-label"><Glyph name="calendar" size={15} />{tr('When')}</span>
        <div className="mk-chippick" role="radiogroup" aria-label={tr('When')}>
          {UNITS.map((u) => (
            <button key={u} type="button" role="radio" aria-checked={f.unit === u} className={'mk-chipopt' + (f.unit === u ? ' is-on' : '')}
              onClick={() => onSet({ unit: u, at: u === f.unit ? f.at : today })}>{tr(UNIT_LABEL[u])}</button>
          ))}
        </div>
        {stepped && (
          <div className="mk-rf-step">
            <button type="button" className="mk-btn is-ghost is-small" onClick={() => onSet({ at: stepRange(f.unit, f.at, -1).from })} aria-label={tr('Earlier')}>‹</button>
            <strong>{rangeName(f.unit, f.at)}</strong>
            <button type="button" className="mk-btn is-ghost is-small" disabled={noFuture} onClick={() => onSet({ at: next.from })} aria-label={tr('Later')}>›</button>
            {!isNow && <button type="button" className="mk-btn is-ghost is-small" onClick={() => onSet({ at: today })}>{tr(NOW_LABEL[f.unit])}</button>}
          </div>
        )}
        {f.unit === 'custom' && (
          <div className="mk-rf-days">
            <input className="input" type="date" value={f.from} max={f.to || undefined} onChange={(e) => onSet({ from: e.target.value })} aria-label={tr('From')} />
            <span aria-hidden="true">→</span>
            <input className="input" type="date" value={f.to} min={f.from || undefined} onChange={(e) => onSet({ to: e.target.value })} aria-label={tr('To')} />
          </div>
        )}
        {f.unit !== 'all' && (
          <select className="input mk-rf-by" value={f.dateBy} onChange={(e) => onSet({ dateBy: e.target.value })} aria-label={tr('Which date')}>
            {DATE_BY.map((k) => <option key={k} value={k}>{tr(DATE_BY_LABEL[k])}</option>)}
          </select>
        )}
      </div>
      <div className="mk-rf-row">
        <label className="mk-rf-search">
          <Glyph name="search" size={15} />
          <input value={words} onChange={(e) => setWords(e.target.value)} placeholder={tr('Search: title, brief, MR-0012, who asked…')} aria-label={tr('Search the requests')} />
          {words && <button type="button" onClick={() => { setWords(''); onSet({ q: '' }); }} aria-label={tr('Clear the search')}><Glyph name="x" size={14} /></button>}
        </label>
        <select className="input mk-rf-sel" value={f.kind} onChange={(e) => onSet({ kind: e.target.value })} aria-label={tr('Type')}>
          <option value="">{tr('Every type')}</option>
          {Object.keys(REQUEST_KINDS).map((k) => <option key={k} value={k}>{tr(REQUEST_KINDS[k])}</option>)}
        </select>
        <select className="input mk-rf-sel" value={f.person} onChange={(e) => onSet({ person: e.target.value })} aria-label={tr('Person')}>
          <option value="">{tr('Anyone')}</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {showCompany && (
          <select className="input mk-rf-sel" value={f.company} onChange={(e) => onSet({ company: e.target.value })} aria-label={tr('Company')}>
            <option value="">{tr('All companies')}</option>
            {companies.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
        )}
        <div className="mk-rf-toggles">
          {[['urgent', 'fire', tr('Urgent')], ['late', 'clock', tr('Late')], ['routine', 'repeat', tr('From a routine')]].map(([k, g, label]) => (
            <button key={k} type="button" aria-pressed={f[k]} className={'mk-chipopt mk-rf-tog is-' + k + (f[k] ? ' is-on' : '')} onClick={() => onSet({ [k]: !f[k] })}>
              <Glyph name={g} size={14} />{label}
            </button>
          ))}
        </div>
      </div>
      {active.length > 0 && (
        <div className="mk-rf-on" aria-live="polite">
          <span className="mk-rf-count">{tr('Showing {n} of {total}', { n: shown, total })}</span>
          {active.map((a) => (
            <button key={a.key} type="button" className={'mk-rf-chip is-' + a.key} onClick={() => onSet(a.off)} title={tr('Take this filter off')}>
              {a.label}<Glyph name="x" size={12} />
            </button>
          ))}
          <button type="button" className="mk-btn is-ghost is-small" onClick={onClear}>{tr('Clear all')}</button>
        </div>
      )}
    </div>
  );
}
