import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { Section } from '../../components/DashKit';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import { KIND_WORD, itemLink, itemTitle } from './MkHomePage';
import { Glyph, MkBanner, MkCompanies, addDays, dateRange, dayLabel, todayIso, useMkCompany } from './mkKit';

// The marketing calendar (backend mkHome.service.js calendar()): a month
// with everything that has a date — campaigns running, posts, events and
// their checklist, promotions, requests due, the requests routines will
// make (dashed, on the day each will be needed, until made), public
// holidays and the year's marketing moments (Valentine's, Mother's Day,
// Black Friday…) —
// each kind in its own colour with its name in the legend, which also
// turns kinds on and off. A long campaign or promotion shows on the day
// it starts and the day it ends; pressing anything opens it. On a phone,
// the month becomes a list of days.
//
// The sales team sees it too (the sales app; data.full false): what they
// sell around, and their own requests, without the events' checklists or
// the routines. What lives in marketing's own pages, which they cannot
// open, shows its details in a card instead: the dates, the venue, the
// promotion's code.

const KINDS = ['campaign', 'post', 'event', 'promotion', 'request', 'routine', 'task', 'holiday', 'moment'];
const SALES_KINDS = KINDS.filter((k) => k !== 'routine' && k !== 'task');

function monthOf(iso) { return iso.slice(0, 7) + '-01'; }
function mondayOn(iso) { const d = new Date(iso + 'T00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function shiftMonth(first, n) { const d = new Date(first + 'T00:00'); d.setMonth(d.getMonth() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-01'; }

export default function MkCalendarPage() {
  const mk = useMkCompany();
  const navigate = useNavigate();
  const today = todayIso();
  const [month, setMonth] = useState(monthOf(today));
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [hidden, setHidden] = useState(() => new Set());
  const [phone, setPhone] = useState(() => window.matchMedia && window.matchMedia('(max-width: 760px)').matches);
  const [peek, setPeek] = useState(null);

  const gridFrom = mondayOn(month);
  const gridTo = addDays(gridFrom, 41);
  useEffect(() => {
    if (!mk.company) return;
    setError(null);
    api.get('/mk/calendar?company=' + mk.company + '&from=' + gridFrom + '&to=' + gridTo).then(setData).catch((e) => setError(e.message));
  }, [mk.company, gridFrom, gridTo]);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const m = window.matchMedia('(max-width: 760px)');
    const f = () => setPhone(m.matches);
    if (m.addEventListener) m.addEventListener('change', f); else m.addListener(f);
    return () => (m.removeEventListener ? m.removeEventListener('change', f) : m.removeListener(f));
  }, []);

  // Each day's things: one-day ones on their day; a span on its first and
  // last day (and on the 1st of the month and each Monday, so a long one
  // is not lost between).
  const byDay = useMemo(() => {
    const out = {};
    if (!data) return out;
    data.items.filter((it) => !hidden.has(it.kind)).forEach((it) => {
      const days = new Set([it.start, it.end]);
      for (let d = it.start; d <= it.end && d <= gridTo; d = addDays(d, 1)) {
        if (d >= gridFrom && (d === gridFrom || new Date(d + 'T00:00').getDay() === 1 || d.endsWith('-01'))) days.add(d);
      }
      days.forEach((d) => { if (d >= gridFrom && d <= gridTo) (out[d] = out[d] || []).push({ ...it, edge: it.start === it.end ? '' : d === it.start ? 'start' : d === it.end ? 'end' : 'mid' }); });
    });
    return out;
  }, [data, hidden, gridFrom, gridTo]);

  const counts = {};
  (data ? data.items : []).forEach((it) => { if (it.start.slice(0, 7) === month.slice(0, 7) || it.end.slice(0, 7) === month.slice(0, 7)) counts[it.kind] = (counts[it.kind] || 0) + 1; });
  const label = new Date(month + 'T00:00').toLocaleDateString(activeIntlLocale(), { month: 'long', year: 'numeric' });
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridFrom, i));
  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(activeIntlLocale(), { weekday: 'short' }));
  const full = !data || data.full !== false;
  const kinds = full ? KINDS : SALES_KINDS;
  function toggle(k) { const n = new Set(hidden); if (n.has(k)) n.delete(k); else n.add(k); setHidden(n); }
  function itemButton(it, i) {
    const link = full || it.kind === 'request' ? itemLink(it) : null;
    const open = link ? () => navigate(link) : it.kind === 'holiday' || it.kind === 'moment' ? null : () => setPeek(it);
    const mark = it.edge === 'start' ? '▸ ' : it.edge === 'end' ? '◂ ' : it.edge === 'mid' ? '… ' : '';
    const repeats = it.kind === 'routine' || it.fromRoutine;
    const more = it.kind === 'routine' ? ' (' + tr('comes round {day}, needed {date}', { day: dayLabel(it.comesOn, { weekday: 'short', day: 'numeric', month: 'short' }), date: dayLabel(it.start, { weekday: 'short', day: 'numeric', month: 'short' }) }) + ')'
      : it.fromRoutine ? ' (' + tr('from a routine') + ')'
      : it.start !== it.end ? ' (' + dayLabel(it.start) + ' – ' + dayLabel(it.end) + ')' : '';
    return (
      <button key={i} type="button" className={'mk-cal-item mk-k-' + it.kind + (it.status === 'done' ? ' is-done' : '')} disabled={!open} onClick={() => open && open()}
        title={tr(KIND_WORD[it.kind]) + ': ' + itemTitle(it) + more}>
        {repeats && <Glyph name="repeat" size={11} />}<span>{mark}{itemTitle(it)}</span>
      </button>
    );
  }

  return (
    <div className="dk mk">
      <MkCompanies mk={mk} />
      <MkBanner art="calendar" eyebrow={tr('Marketing · Calendar')} title={tr('The marketing calendar')}
        sub={full ? tr('Everything with a date, in one month: campaigns, posts, events and their checklists, promotions, requests due and the ones routines will make, public holidays and the year\'s big moments to plan around.')
          : tr('What marketing has planned, in one month: campaigns, posts, events, promotions and their codes, your requests to marketing, public holidays and the year\'s big moments to sell around.')}
        stats={[
          { glyph: 'target', value: String(counts.campaign || 0), label: tr('campaigns this month') },
          { glyph: 'chat', value: String(counts.post || 0), label: tr('posts this month') },
          { glyph: 'flag', value: String((counts.event || 0) + (counts.promotion || 0)), label: tr('events and promotions') },
          { glyph: 'gift', value: String((counts.moment || 0) + (counts.holiday || 0)), label: tr('holidays and moments') }
        ]} />
      {error && <div className="error-banner">{error}</div>}
      <Section title={label} sub={full ? tr('Press anything to open it. The legend turns a kind on or off.') : tr('Press anything to see its details. The legend turns a kind on or off.')}>
        <div className="mk-cal-bar">
          <button type="button" className="mk-btn is-ghost is-small" onClick={() => setMonth(shiftMonth(month, -1))} aria-label={tr('Previous month')}>‹</button>
          <button type="button" className="mk-btn is-ghost is-small" onClick={() => setMonth(monthOf(today))}>{tr('This month')}</button>
          <button type="button" className="mk-btn is-ghost is-small" onClick={() => setMonth(shiftMonth(month, 1))} aria-label={tr('Next month')}>›</button>
          <span className="mk-fill" style={{ flex: 1 }} />
          <div className="mk-legend" role="group" aria-label={tr('Show')}>
            {kinds.map((k) => (
              <button key={k} type="button" className={'mk-k-' + k + (hidden.has(k) ? ' is-off' : '')} aria-pressed={!hidden.has(k)} onClick={() => toggle(k)}><i />{tr(KIND_WORD[k])}</button>
            ))}
          </div>
        </div>
        {!data ? <p className="mk-muted">{tr('Loading…')}</p> : phone ? (
          <div className="mk-agenda">
            {days.filter((d) => d.slice(0, 7) === month.slice(0, 7) && byDay[d]).map((d) => (
              <div key={d} className="mk-agenda-day">
                <h4>{d === today ? tr('Today') : dayLabel(d, { weekday: 'long' })}<small>{dayLabel(d)}</small></h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{byDay[d].map(itemButton)}</div>
              </div>
            ))}
            {!days.some((d) => d.slice(0, 7) === month.slice(0, 7) && byDay[d]) && <p className="mk-muted">{tr('Nothing on the calendar this month.')}</p>}
          </div>
        ) : (
          <div className="mk-cal" role="grid" aria-label={label}>
            {weekdays.map((w) => <span key={w} className="mk-cal-dow" role="columnheader">{w}</span>)}
            {days.map((d) => {
              const list = byDay[d] || [];
              return (
                <div key={d} role="gridcell" className={'mk-cal-day' + (d.slice(0, 7) !== month.slice(0, 7) ? ' is-out' : '') + (d === today ? ' is-today' : '')}>
                  <span className="mk-cal-n">{Number(d.slice(8))}</span>
                  {list.slice(0, 4).map(itemButton)}
                  {list.length > 4 && <span className="mk-cal-more" title={list.slice(4).map(itemTitle).join('\n')}>{tr('+{n} more', { n: list.length - 4 })}</span>}
                </div>
              );
            })}
          </div>
        )}
        <p className="mk-muted"><Glyph name="sparkle" size={13} /> {tr('▸ starts, ◂ ends, … still running. Public holidays come from the company\'s holiday list (Company settings).')}</p>
        {full && <p className="mk-muted"><Glyph name="repeat" size={13} /> {tr('Dashed: a request a routine will make, on the day it will be needed. On the day it comes round it becomes a request, and the people on it are reminded before it is needed.')}</p>}
      </Section>
      {peek && <Peek it={peek} onClose={() => setPeek(null)} />}
    </div>
  );
}

// A campaign, event, promotion or post for someone who cannot open
// marketing's pages: what it is and when, where, and the code to quote.
function Peek({ it, onClose }) {
  useEffect(() => {
    function key(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const rows = [
    ['when', tr('Dates'), dateRange(it.start, it.end)],
    it.venue ? ['venue', tr('Venue'), it.venue] : null,
    it.code ? ['code', tr('Promo code'), it.code] : null,
    it.channel ? ['channel', tr('Channel'), it.channel] : null
  ].filter(Boolean);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className={'dialog mk-peek mk-k-' + it.kind} role="dialog" aria-modal="true" aria-label={itemTitle(it)} onClick={(e) => e.stopPropagation()}>
        <span className="mk-peek-kind"><i />{tr(KIND_WORD[it.kind])}</span>
        <h3>{itemTitle(it)}</h3>
        <dl>{rows.map(([k, label, v]) => <div key={k}><dt>{label}</dt><dd className={k === 'code' ? 'mk-peek-code' : ''}>{v}</dd></div>)}</dl>
        <button type="button" className="mk-btn" onClick={onClose}>{tr('Close')}</button>
      </div>
    </div>
  );
}
