import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import SlideDeck, { addDays, mondayOf, recentWeeks, weekLabel } from '../../components/SlideDeck';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import CustomerProfile from './CustomerProfile';
import { LeadDialog, ghs, todayISO, useCrmBasics } from './crmShared';
import { channelLabel, useReps } from './crmHubShared';
import './SalesPresent.css';

// The sales team's Saturday review: one week as slides for the Saturday
// meeting (the slide show is components/SlideDeck.jsx; the figures are the
// backend's crmWeekly.service.js). New leads come first — how many against
// the weeks before, each day, where they came from, what they asked for,
// where they are now, and every one of them as a card, the ones nobody has
// answered yet marked — then what moved (new prospects, won, lost and why),
// sales and money in against last week, the team side by side, and what is
// due next week. A lead's card opens the lead over the slides; a new
// inbox writer's card opens their profile.

const PER_SLIDE = 8;
const PHASE_WORD = { lead: () => tr('Lead'), prospect: () => tr('Prospect'), won: () => tr('Won, waiting for payment'), customer: () => tr('Customer'), lost: () => tr('Lost') };
function chunk(list, n) { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; }
function weekday(iso, long) { return new Date(iso + 'T00:00').toLocaleDateString(activeIntlLocale(), long ? { weekday: 'long' } : { weekday: 'short' }); }
function dayMonth(iso) { return new Date(iso + 'T00:00').toLocaleDateString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short' }); }

// "3 more than last week", "same as last week".
function Change({ now, before, money }) {
  const d = Math.round((now - before) * 100) / 100;
  if (!d) return <span className="ssr-change">{tr('same as last week')}</span>;
  const amount = money ? ghs(Math.abs(d)) : String(Math.abs(d));
  return <span className={'ssr-change ' + (d > 0 ? 'is-up' : 'is-down')}>{d > 0 ? '▲ ' + tr('{n} more than last week', { n: amount }) : '▼ ' + tr('{n} less than last week', { n: amount })}</span>;
}

function HBars({ items, empty }) {
  const max = Math.max(1, ...items.map((x) => x.n));
  if (!items.length) return <p className="ssr-none">{empty}</p>;
  return (
    <ul className="ssr-hbars">
      {items.map((x) => (
        <li key={x.key}>
          <span className="ssr-hbar-label" title={x.label}>{x.label}</span>
          <span className="ssr-hbar-track"><span className={x.tone ? 'is-' + x.tone : ''} style={{ width: Math.max(x.n ? 3 : 0, (x.n / max) * 100) + '%' }} /></span>
          <b>{x.n}</b>
        </li>
      ))}
    </ul>
  );
}

// Stacked columns: leads from the list, and first-time inbox writers.
function Columns({ cols, current }) {
  const max = Math.max(1, ...cols.map((c) => c.leads + c.inbox));
  return (
    <div className="ssr-cols" role="img" aria-label={cols.map((c) => c.label + ' ' + (c.leads + c.inbox)).join(', ')}>
      {cols.map((c) => (
        <span key={c.key} className={'ssr-col' + (c.key === current ? ' is-now' : '')}>
          <span className="ssr-col-bar">
            <b>{c.leads + c.inbox || ''}</b>
            <i className="is-inbox" style={{ height: (c.inbox / max) * 82 + '%' }} />
            <i className="is-list" style={{ height: (c.leads / max) * 82 + '%' }} />
          </span>
          <small>{c.label}</small>
        </span>
      ))}
    </div>
  );
}
function ColumnsKey() {
  return (
    <ul className="ssr-key">
      <li><i className="is-list" />{tr('On the leads list')}</li>
      <li><i className="is-inbox" />{tr('New people who messaged us')}</li>
    </ul>
  );
}

function LeadCard({ x, onOpen }) {
  const waiting = !x.answered;
  return (
    <button type="button" className={'ssr-card' + (waiting ? ' is-waiting' : '')} onClick={() => onOpen(x)}>
      <span className="ssr-card-top">
        <span className="ssr-day">{dayMonth(x.receivedOn)}</span>
        <span className="ssr-src">{x.sourceLabel}</span>
      </span>
      <strong className="ssr-card-name">{x.name}</strong>
      {x.company && <span className="ssr-card-co">{x.company}</span>}
      <span className="ssr-card-item">{x.item || <em>{tr('Did not say what they want yet')}</em>}</span>
      <span className="ssr-card-foot">
        <span className="ssr-card-rep">{x.repName || tr('No one assigned')}</span>
        {waiting
          ? <span className="ssr-pill is-bad">{tr('Not answered yet')}</span>
          : <span className={'ssr-pill is-' + (x.phase || 'lead')}>{x.phase ? PHASE_WORD[x.phase]() : tr('Answered')}</span>}
      </span>
    </button>
  );
}

export default function SalesPresent({ onClose }) {
  const thisMonday = mondayOf(todayISO());
  const [weekFrom, setWeekFrom] = useState(thisMonday);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null); // { kind: 'lead' | 'customer', id }
  const { settings, people } = useCrmBasics();
  const { reps } = useReps();

  const load = useCallback(async () => {
    try { setData(await api.get('/crm/week?from=' + weekFrom)); setError(null); } catch (err) { setError(err.message); }
  }, [weekFrom]);
  useEffect(() => { setData(null); load(); }, [load]);

  // Every new lead of the week as one card: the leads list and the inbox.
  const cards = useMemo(() => {
    if (!data) return [];
    const list = data.leads.list.map((l) => ({
      key: 'l' + l.id, kind: 'lead', id: l.id, receivedOn: l.receivedOn, name: l.name, company: l.company, item: l.item,
      sourceLabel: l.source || tr('Source not given'), repName: l.repName, answered: l.contacted, phase: l.phase
    }));
    const inbox = data.leads.inbox.map((x) => ({
      key: 'c' + x.customerId, kind: 'customer', id: x.customerId, receivedOn: x.receivedOn, name: x.name, company: '', item: '',
      sourceLabel: tr('Inbox · {channel}', { channel: channelLabel(x.channel) }), repName: x.repName, answered: x.answered, phase: null
    }));
    return list.concat(inbox).sort((a, b) => a.receivedOn.localeCompare(b.receivedOn) || a.name.localeCompare(b.name));
  }, [data]);

  const slides = useMemo(() => {
    if (!data) return [];
    const s = [{ key: 'cover', kind: 'cover' }, { key: 'count', kind: 'count' }];
    if (cards.length) {
      s.push({ key: 'where', kind: 'where' });
      chunk(cards, PER_SLIDE).forEach((list, i, all) => s.push({ key: 'cards-' + i, kind: 'cards', list, page: i + 1, pages: all.length }));
    }
    s.push({ key: 'moved', kind: 'moved' }, { key: 'money', kind: 'money' });
    if (data.team.length) s.push({ key: 'team', kind: 'team' });
    s.push({ key: 'next', kind: 'next' }, { key: 'end', kind: 'end' });
    return s;
  }, [data, cards]);

  const weeks = recentWeeks(thisMonday);
  const range = weekLabel(weekFrom, addDays(weekFrom, 6));

  function render(sl) {
    const L = data.leads, m = data.money, b = data.moneyBefore, mv = data.moved;
    const sources = L.sources.map((x) => ({ key: 's' + x.source, label: x.source || tr('Source not given'), n: x.n }))
      .concat(L.channels.map((x) => ({ key: 'c' + x.channel, label: tr('Inbox · {channel}', { channel: channelLabel(x.channel) }), n: x.n, tone: 'inbox' })))
      .sort((p, q) => q.n - p.n);
    if (sl.kind === 'cover') {
      const busiest = L.days.slice().sort((p, q) => (q.leads + q.inbox) - (p.leads + p.inbox))[0];
      return (
        <div className="wop-cover">
          <span className="wop-eyebrow">{tr('Saturday review')} · {data.company || tr('Sales')}</span>
          <h1>{tr('Sales this week')}</h1>
          <p className="wop-range">{range}</p>
          <div className="wop-tiles">
            <div className="wop-tile is-lead"><b>{L.total}</b><span>{L.total === 1 ? tr('new lead') : tr('new leads')}</span><Change now={L.total} before={L.before} /></div>
            <div className="wop-tile is-prospect"><b>{mv.prospects.length}</b><span>{mv.prospects.length === 1 ? tr('became a prospect') : tr('became prospects')}</span></div>
            <div className="wop-tile is-good"><b>{mv.won.length}</b><span>{tr('won')}</span></div>
            <div className="wop-tile is-money"><b className="ssr-money">{ghs(m.sales)}</b><span>{tr('sold')}</span><Change now={m.sales} before={b.sales} money /></div>
          </div>
          <p className="wop-foot">{[
            L.total ? tr('{a} of {b} new leads answered', { a: L.contacted, b: L.total }) : null,
            L.notContacted ? tr('{n} not answered yet', { n: L.notContacted }) : null,
            busiest && busiest.leads + busiest.inbox ? tr('busiest day: {day}', { day: weekday(busiest.date, true) }) : null,
            sources[0] ? tr('most came from {source}', { source: sources[0].label }) : null
          ].filter(Boolean).join(' · ')}</p>
        </div>
      );
    }
    if (sl.kind === 'count') {
      const cols = L.weeks.map((w) => ({ key: w.from, label: new Date(w.from + 'T00:00').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' }), leads: w.leads, inbox: w.inbox }));
      const days = L.days.map((d) => ({ key: d.date, label: weekday(d.date), leads: d.leads, inbox: d.inbox }));
      return (
        <div className="wop-sum">
          <header className="wop-head">
            <span className="wop-eyebrow ssr-eb-lead">{tr('New leads')}</span>
            <h2>{L.total === 1 ? tr('1 new lead this week') : tr('{n} new leads this week', { n: L.total })}</h2>
            <p className="wop-sub">{tr('{a} on the leads list and {b} new people who messaged us for the first time.', { a: L.listed, b: L.fromInbox })}</p>
          </header>
          <div className="wop-sum-grid">
            <section className="wop-panel">
              <h3>{tr('The last 8 weeks')}</h3>
              <Columns cols={cols} current={weekFrom} />
              <ColumnsKey />
            </section>
            <section className="wop-panel">
              <h3>{tr('Each day')}</h3>
              <Columns cols={days} current={todayISO()} />
              <div className="ssr-facts">
                <div><b>{L.before}</b><span>{tr('last week')}</span></div>
                <div><b>{Math.round(L.average * 10) / 10}</b><span>{tr('a week, on average over the 4 weeks before')}</span></div>
              </div>
            </section>
          </div>
        </div>
      );
    }
    if (sl.kind === 'where') {
      const phases = ['lead', 'prospect', 'won', 'customer', 'lost'].map((k) => ({ key: k, label: PHASE_WORD[k](), n: (L.phases.find((p) => p.phase === k) || { n: 0 }).n, tone: k })).filter((x) => x.n);
      if (L.fromInbox) phases.unshift({ key: 'inbox', label: tr('New people who messaged us'), n: L.fromInbox, tone: 'inbox' });
      return (
        <div className="wop-sum">
          <header className="wop-head">
            <span className="wop-eyebrow ssr-eb-lead">{tr('New leads')}</span>
            <h2>{tr('Where they came from and what they want')}</h2>
          </header>
          <div className="ssr-three">
            <section className="wop-panel">
              <h3>{tr('Where they came from')}</h3>
              <HBars items={sources.slice(0, 7)} empty={tr('No sources given.')} />
            </section>
            <section className="wop-panel">
              <h3>{tr('What they asked for')}</h3>
              <HBars items={L.items.map((x) => ({ key: x.item, label: x.item, n: x.n }))} empty={tr('Nobody said what they want yet.')} />
            </section>
            <section className="wop-panel">
              <h3>{tr('Answered?')}</h3>
              <div className="wop-split" aria-hidden="true">
                <span className="is-good" style={{ flex: L.contacted }} />
                <span className="is-bad" style={{ flex: L.notContacted }} />
              </div>
              <ul className="wop-legend">
                <li><i className="is-good" />{tr('Answered')} <b>{L.contacted}</b></li>
                <li><i className="is-bad" />{tr('Not answered yet')} <b>{L.notContacted}</b></li>
              </ul>
              <h3 className="ssr-h3-gap">{tr('Where they are now')}</h3>
              <HBars items={phases} empty="—" />
            </section>
          </div>
        </div>
      );
    }
    if (sl.kind === 'cards') {
      const waiting = sl.list.filter((x) => !x.answered).length;
      return (
        <div className="wop-list">
          <header className="wop-head is-row">
            <span className="wop-eyebrow ssr-eb-lead">{tr('New leads')}</span>
            <h2>{tr('Every new lead this week')}{L.notContacted ? <span className="ssr-h2-note">{tr('{n} not answered yet', { n: L.notContacted })}</span> : null}</h2>
            {sl.pages > 1 && <span className="wop-page">{tr('{a} of {b}', { a: sl.page, b: sl.pages })}</span>}
          </header>
          <div className="ssr-cards" data-waiting={waiting}>
            {sl.list.map((x) => <LeadCard key={x.key} x={x} onOpen={(c) => setOpen({ kind: c.kind, id: c.id })} />)}
          </div>
        </div>
      );
    }
    if (sl.kind === 'moved') {
      const col = (list, tone, title, empty, extra) => (
        <section className={'wop-panel ssr-moved is-' + tone}>
          <h3><b>{list.length}</b> {title}</h3>
          {list.length ? (
            <ul className="ssr-names">
              {list.slice(0, 6).map((x) => (
                <li key={x.id}>
                  <button type="button" onClick={() => setOpen({ kind: 'lead', id: x.id })}>
                    <strong>{x.name}</strong>
                    <span>{extra(x)}</span>
                  </button>
                </li>
              ))}
              {list.length > 6 && <li className="ssr-more">{tr('and {n} more', { n: list.length - 6 })}</li>}
            </ul>
          ) : <p className="ssr-none">{empty}</p>}
        </section>
      );
      return (
        <div className="wop-sum">
          <header className="wop-head">
            <span className="wop-eyebrow ssr-eb-prospect">{tr('What moved')}</span>
            <h2>{tr('Lead → Prospect → Customer this week')}</h2>
          </header>
          <div className="ssr-three">
            {col(mv.prospects, 'prospect', tr('became prospects'), tr('No lead became a prospect this week.'), (x) => [x.item, x.repName].filter(Boolean).join(' · '))}
            {col(mv.won, 'good', tr('won'), tr('Nothing won this week.'), (x) => [x.dealValue ? ghs(x.dealValue) : x.item, x.repName].filter(Boolean).join(' · '))}
            {col(mv.lost, 'bad', tr('lost'), tr('Nothing lost this week.'), (x) => x.reason || tr('No reason given'))}
          </div>
        </div>
      );
    }
    if (sl.kind === 'money') {
      const fact = (label, value, now, before, isMoney, note) => (
        <div className="ssr-kpi">
          <span className="ssr-kpi-label">{label}</span>
          <b className={isMoney ? 'ssr-money' : ''}>{value}</b>
          {before !== undefined && <Change now={now} before={before} money={isMoney} />}
          {note && <span className="ssr-kpi-note">{note}</span>}
        </div>
      );
      return (
        <div className="wop-sum">
          <header className="wop-head">
            <span className="wop-eyebrow is-good">{tr('Sales and money in')}</span>
            <h2>{tr('{amount} sold this week', { amount: ghs(m.sales) })}</h2>
            <p className="wop-sub">{tr('Sale invoices and payments in GHS, against last week.')}</p>
          </header>
          <div className="ssr-kpis">
            {fact(tr('Sold'), ghs(m.sales), m.sales, b.sales, true, m.invoices === 1 ? tr('1 invoice') : tr('{n} invoices', { n: m.invoices }))}
            {fact(tr('Money in'), ghs(m.cash), m.cash, b.cash, true)}
            {fact(tr('Customers who bought'), String(m.buyers), m.buyers, b.buyers, false, tr('{new} new · {returning} came back', { new: m.newBuyers, returning: m.returningBuyers }))}
            {fact(tr('Quotations sent'), String(m.quotesSent), m.quotesSent, b.quotesSent, false, m.quotesSent ? tr('worth {amount}', { amount: ghs(m.quotesValue) }) : null)}
            {fact(tr('Quotations accepted'), String(m.quotesWon), m.quotesWon, b.quotesWon, false, m.quotesWon ? tr('worth {amount}', { amount: ghs(m.quotesWonValue) }) : null)}
            {fact(tr('Site visits made'), String(data.visits.done), undefined, undefined, false, data.visits.planned > data.visits.done ? tr('{n} booked this week', { n: data.visits.planned }) : null)}
          </div>
        </div>
      );
    }
    if (sl.kind === 'team') {
      return (
        <div className="wop-sum">
          <header className="wop-head"><span className="wop-eyebrow">{tr('The team')}</span><h2>{tr('Who did what this week')}</h2></header>
          <table className="wop-table">
            <thead><tr><th>{tr('Rep')}</th><th>{tr('New leads')}</th><th>{tr('Answered')}</th><th>{tr('From the inbox')}</th><th>{tr('New prospects')}</th><th>{tr('Won')}</th><th>{tr('Sold')}</th><th>{tr('Money in')}</th></tr></thead>
            <tbody>
              {data.team.slice(0, 8).map((r) => (
                <tr key={r.repId}>
                  <td>{r.name}</td>
                  <td><b>{r.newLeads}</b></td>
                  <td>{r.newLeads ? <b className={r.contacted < r.newLeads ? 'is-bad' : 'is-good'}>{r.contacted}</b> : <span className="wop-zero">—</span>}</td>
                  <td>{r.inbox || <span className="wop-zero">0</span>}</td>
                  <td>{r.prospects || <span className="wop-zero">0</span>}</td>
                  <td>{r.won ? <b className="is-good">{r.won}</b> : <span className="wop-zero">0</span>}</td>
                  <td>{r.sales ? ghs(r.sales) : <span className="wop-zero">—</span>}</td>
                  <td>{r.cash ? ghs(r.cash) : <span className="wop-zero">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.team.length > 8 && <p className="wop-note">{tr('and {n} more', { n: data.team.length - 8 })}</p>}
          {L.noRep > 0 && <p className="wop-note ssr-warn-note">{L.noRep === 1 ? tr('1 new lead has nobody assigned.') : tr('{n} new leads have nobody assigned.', { n: L.noRep })}</p>}
        </div>
      );
    }
    if (sl.kind === 'next') {
      const nextRange = weekLabel(data.next.from, data.next.to);
      return (
        <div className="wop-sum">
          <header className="wop-head">
            <span className="wop-eyebrow is-pend">{tr('Next week')}</span>
            <h2>{tr('What is coming: {dates}', { dates: nextRange })}</h2>
          </header>
          <div className="wop-sum-grid">
            <section className="wop-panel wop-facts">
              <div className="wop-fact is-warn"><b>{data.followUps.nextWeek}</b><span>{tr('follow-ups due next week')}</span></div>
              <div className={'wop-fact' + (data.followUps.overdue ? ' is-bad' : '')}><b>{data.followUps.overdue}</b><span>{tr('follow-ups already overdue')}</span></div>
              <div className="wop-fact"><b>{data.followUps.none}</b><span>{tr('open leads with no follow-up date')}</span></div>
              <div className="wop-fact"><b>{data.quotesExpiringNextWeek.n}</b><span>{data.quotesExpiringNextWeek.n ? tr('quotations running out next week, worth {amount}', { amount: ghs(data.quotesExpiringNextWeek.value) }) : tr('quotations running out next week')}</span></div>
            </section>
            <section className="wop-panel">
              <h3>{tr('Site visits next week')}</h3>
              {data.visits.nextWeek.length ? (
                <ul className="ssr-visits">
                  {data.visits.nextWeek.slice(0, 6).map((v) => <li key={v.id}><span>{dayMonth(v.date)}</span><strong>{v.client}</strong>{v.location && <em>{v.location}</em>}</li>)}
                  {data.visits.nextWeek.length > 6 && <li className="ssr-more">{tr('and {n} more', { n: data.visits.nextWeek.length - 6 })}</li>}
                </ul>
              ) : <p className="ssr-none">{tr('No site visits booked for next week.')}</p>}
            </section>
          </div>
        </div>
      );
    }
    return (
      <div className="wop-cover is-end">
        <span className="wop-eyebrow">{tr('Saturday review')} · {range}</span>
        <h1>{tr('Thank you')}</h1>
        <p className="wop-range">{L.notContacted
          ? (L.notContacted === 1 ? tr('Answer the 1 new lead still waiting before Monday.') : tr('Answer the {n} new leads still waiting before Monday.', { n: L.notContacted }))
          : tr('Every new lead has been answered. Keep it that way next week.')}</p>
      </div>
    );
  }

  return (
    <>
      <SlideDeck brand={tr('Saturday sales review')} className="is-sales" weeks={weeks} weekFrom={weekFrom} onWeek={setWeekFrom}
        slides={slides} render={render} onClose={onClose} paused={!!open} />
      {!data && (
        <div className="ssr-loading" role="status">{error || tr('Loading…')}</div>
      )}
      {open && open.kind === 'lead' && settings && (
        <LeadDialog leadId={open.id} settings={settings} people={people} onClose={() => setOpen(null)} onChanged={load} />
      )}
      {open && open.kind === 'customer' && <CustomerProfile id={open.id} reps={reps} onClose={() => setOpen(null)} onChanged={load} />}
    </>
  );
}

// The button that opens it (CRM Overview, Leads).
export function SalesReviewButton({ className = 'btn btn-secondary' }) {
  const [on, setOn] = useState(false);
  return (
    <>
      <button type="button" className={className + ' ssr-open-btn'} onClick={() => setOn(true)} title={tr('This week’s new leads, what moved, sales and the team as slides, for the Saturday meeting')}>
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" /></svg>
        {tr('Saturday review')}
      </button>
      {on && <SalesPresent onClose={() => setOn(false)} />}
    </>
  );
}
