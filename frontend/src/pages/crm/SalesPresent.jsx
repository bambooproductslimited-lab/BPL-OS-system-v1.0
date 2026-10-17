import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import Photo from '../../components/Photo';
import SlideDeck, { addDays, mondayOf, recentWeeks, weekLabel } from '../../components/SlideDeck';
import { CountUp, Delta, Ring } from '../../components/SlideKit';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import CustomerProfile from './CustomerProfile';
import { LeadDialog, todayISO, useCrmBasics } from './crmShared';
import { channelLabel, useReps } from './crmHubShared';
import './SalesPresent.css';

// The sales team's Saturday review: one week as slides for the Saturday
// meeting, on the fancy slide stage (components/SlideDeck.jsx and
// SlideKit.jsx; the figures are the backend's crmWeekly.service.js). It
// shows the team no money — no sales, money in or deal values — only
// counts. It opens on the week at a glance — new leads, prospects, won and
// customers who bought, each against last week, and the share of new leads
// answered as a ring — then the week's highlights (star salesperson, top
// source, most asked for, busiest day, quotations, new buyers); new leads
// over 8 weeks and each day; where they came from and what they want; every
// one of them as a card, the ones nobody has answered marked; the week from
// lead to customer, step by step; what moved (new prospects, won, lost and
// why); customers and quotations against last week; the team on a podium;
// next week day by day (follow-ups by name, site visits); and a thank-you
// with the week's shout-outs. A lead's card opens the lead over the slides;
// a new inbox writer's card opens their profile.

const PER_SLIDE = 8;

const PHASE_WORD = { lead: () => tr('Lead'), prospect: () => tr('Prospect'), won: () => tr('Won, waiting for payment'), customer: () => tr('Customer'), lost: () => tr('Lost') };
function chunk(list, n) { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; }
function weekday(iso, long) { return new Date(iso + 'T00:00').toLocaleDateString(activeIntlLocale(), long ? { weekday: 'long' } : { weekday: 'short' }); }
function dayMonth(iso) { return new Date(iso + 'T00:00').toLocaleDateString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short' }); }

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


const MEDAL = ['is-gold', 'is-silver', 'is-bronze'];
const HL_ICON = {
  quote: <><path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10.5A.5.5 0 0 1 6.5 20V4a.5.5 0 0 1 .5-.5z" /><path d="M13.5 3.5V8h4.5M9.5 12.5h5M9.5 16h5" /></>,
  star: <path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z" />,
  pin: <><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.3" /></>,
  chat: <><path d="M4.5 18.5 5.6 15A7 7 0 1 1 9 18" /><path d="M8.5 10.5h7M8.5 13.5h4.5" /></>,
  cal: <><rect x="4" y="5.5" width="16" height="14.5" rx="2" /><path d="M8 3.5v4M16 3.5v4M4 10h16M9 14h2M13 14h2M9 17h2" /></>,
  people: <><circle cx="9" cy="8.5" r="3" /><path d="M3.5 19c.6-3.3 2.8-5.2 5.5-5.2s4.9 1.9 5.5 5.2" /><circle cx="16.5" cy="9.5" r="2.4" /><path d="M15.5 13.9c2.5.3 4.4 2 5 5.1" /></>
};

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
    const s = [{ key: 'cover', kind: 'cover' }, { key: 'highlights', kind: 'highlights' }, { key: 'count', kind: 'count' }];
    if (cards.length) {
      s.push({ key: 'where', kind: 'where' });
      chunk(cards, PER_SLIDE).forEach((list, i, all) => s.push({ key: 'cards-' + i, kind: 'cards', list, page: i + 1, pages: all.length }));
    }
    s.push({ key: 'flow', kind: 'flow' }, { key: 'moved', kind: 'moved' }, { key: 'bought', kind: 'bought' });
    if (data.team.length) s.push({ key: 'team', kind: 'team' });
    s.push({ key: 'next', kind: 'next' }, { key: 'end', kind: 'end' });
    return s;
  }, [data, cards]);

  const weeks = recentWeeks(thisMonday);
  const range = weekLabel(weekFrom, addDays(weekFrom, 6));

  function render(sl) {
    const L = data.leads, m = data.sales, b = data.salesBefore, mv = data.moved;
    const answeredPct = L.total ? Math.round((L.contacted / L.total) * 100) : null;
    const sources = L.sources.map((x) => ({ key: 's' + x.source, label: x.source || tr('Source not given'), n: x.n }))
      .concat(L.channels.map((x) => ({ key: 'c' + x.channel, label: tr('Inbox · {channel}', { channel: channelLabel(x.channel) }), n: x.n, tone: 'inbox' })))
      .sort((p, q) => q.n - p.n);
    const busiest = L.days.slice().sort((p, q) => (q.leads + q.inbox) - (p.leads + p.inbox))[0];
    const star = data.team.slice().sort((p, q) => q.won - p.won || q.prospects - p.prospects || (q.newLeads + q.inbox) - (p.newLeads + p.inbox))[0] || null;
    const starOk = star && (star.won || star.prospects || star.newLeads + star.inbox);
    if (sl.kind === 'cover') {
      const mood = !L.total && !m.buyers && !mv.won.length ? tr('A quiet week for sales.')
        : tr('{n} new leads, {w} won and {b} customers who bought this week.', { n: L.total, w: mv.won.length, b: m.buyers });
      return (
        <div className="wop-cover sk-cover">
          <span className="sk-orb is-a" aria-hidden="true" /><span className="sk-orb is-b" aria-hidden="true" /><span className="sk-orb is-c" aria-hidden="true" />
          <div className="sk-cover-top">
            <div>
              <span className="wop-eyebrow">{tr('Saturday review')} · {data.company || tr('Sales')}</span>
              <h1>{tr('Sales this week')}</h1>
              <p className="wop-range">{range}</p>
              <p className="sk-mood">{mood}</p>
            </div>
            <Ring pct={answeredPct} label={tr('of new leads answered')} />
          </div>
          <div className="wop-tiles">
            <div className="wop-tile is-lead"><b><CountUp value={L.total} /></b><span>{L.total === 1 ? tr('new lead') : tr('new leads')}</span><Delta now={L.total} before={L.before} /></div>
            <div className="wop-tile is-prospect"><b><CountUp value={mv.prospects.length} /></b><span>{mv.prospects.length === 1 ? tr('became a prospect') : tr('became prospects')}</span><span className="sk-delta">{m.quotesSent ? (m.quotesSent === 1 ? tr('1 quotation sent') : tr('{n} quotations sent', { n: m.quotesSent })) : '\u00a0'}</span></div>
            <div className="wop-tile is-good"><b><CountUp value={mv.won.length} /></b><span>{tr('won')}</span><span className="sk-delta">{mv.lost.length ? tr('{n} lost', { n: mv.lost.length }) : '\u00a0'}</span></div>
            <div className="wop-tile is-buyers"><b><CountUp value={m.buyers} /></b><span>{m.buyers === 1 ? tr('customer bought') : tr('customers bought')}</span><Delta now={m.buyers} before={b.buyers} /></div>
          </div>
        </div>
      );
    }
    if (sl.kind === 'highlights') {
      const topSource = sources[0] || null, topItem = L.items[0] || null;
      const cardsHl = [
        starOk && { key: 'star', icon: 'star', tone: 'gold', label: tr('Star salesperson'), value: star.name, person: star,
          sub: [star.won ? (star.won === 1 ? tr('1 won') : tr('{n} won', { n: star.won })) : null, star.prospects ? tr('{n} new prospects', { n: star.prospects }) : null, star.newLeads + star.inbox ? tr('{n} new leads', { n: star.newLeads + star.inbox }) : null].filter(Boolean).join(' · ') },
        topSource && { key: 'src', icon: 'pin', tone: 'open', label: tr('Top source'), value: topSource.label, sub: topSource.n === 1 ? tr('1 new lead') : tr('{n} new leads', { n: topSource.n }) },
        topItem && { key: 'item', icon: 'chat', tone: 'violet', label: tr('Most asked for'), value: topItem.item, sub: topItem.n === 1 ? tr('asked once') : tr('asked {n} times', { n: topItem.n }) },
        busiest && busiest.leads + busiest.inbox ? { key: 'day', icon: 'cal', tone: 'warn', label: tr('Busiest day'), value: weekday(busiest.date, true), sub: tr('{n} new leads', { n: busiest.leads + busiest.inbox }) } : null,
        { key: 'quotes', icon: 'quote', tone: 'good', label: tr('Quotations sent'), value: String(m.quotesSent), sub: m.quotesWon === 1 ? tr('1 accepted') : tr('{n} accepted', { n: m.quotesWon }) },
        { key: 'buyers', icon: 'people', tone: 'hot', label: tr('New buyers'), value: String(m.newBuyers), sub: tr('{n} came back to buy again', { n: m.returningBuyers }) }
      ].filter(Boolean).slice(0, 6);
      return (
        <div className="wop-sum">
          <header className="wop-head"><span className="wop-eyebrow ssr-eb-lead">{tr('Highlights')}</span><h2>{tr('The week in highlights')}</h2></header>
          <div className="sk-hl">
            {cardsHl.map((c, i) => (
              <div key={c.key} className={'sk-hl-card is-' + c.tone} style={{ '--d': i }}>
                <span className="sk-hl-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{HL_ICON[c.icon]}</svg></span>
                <small>{c.label}</small>
                <b>{c.person ? <span className="sk-hl-person"><Photo id={c.person.repId} name={c.person.name} photo={c.person.photo} size={34} />{c.value}</span> : c.value}</b>
                <span>{c.sub}</span>
              </div>
            ))}
          </div>
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
            {sl.list.map((x, i) => <div key={x.key} className="sk-in" style={{ '--d': i }}><LeadCard x={x} onOpen={(c) => setOpen({ kind: c.kind, id: c.id })} /></div>)}
          </div>
        </div>
      );
    }
    if (sl.kind === 'flow') {
      const steps = [
        { key: 'leads', n: L.total, label: tr('New leads'), hint: tr('{a} on the list, {b} from the inbox', { a: L.listed, b: L.fromInbox }) },
        { key: 'answered', n: L.contacted, label: tr('Answered'), hint: L.notContacted ? tr('{n} not answered yet', { n: L.notContacted }) : tr('every new lead answered') },
        { key: 'prospects', n: mv.prospects.length, label: tr('Became prospects'), hint: tr('qualified, quoted or agreeing terms') },
        { key: 'won', n: mv.won.length, label: tr('Won'), hint: mv.lost.length ? tr('{n} lost', { n: mv.lost.length }) : '' }
      ];
      const max = Math.max(1, ...steps.map((x) => x.n));
      return (
        <div className="wop-sum">
          <header className="wop-head">
            <span className="wop-eyebrow ssr-eb-lead">{tr('From lead to customer')}</span>
            <h2>{tr('The week, step by step')}</h2>
            <p className="wop-sub">{tr('New leads this week, how many were answered, the leads that moved on, and the customers who bought.')}</p>
          </header>
          <div className="sk-flow is-five">
            {steps.map((x, i) => (
              <div key={x.key} className={'sk-step is-s-' + x.key + (x.n ? '' : ' is-empty')} style={{ '--d': i }}>
                <b><CountUp value={x.n} /></b>
                <strong>{x.label}</strong>
                <small>{x.hint}</small>
                <span className="sk-step-bar"><i style={{ height: (x.n / max) * 100 + '%' }} /></span>
              </div>
            ))}
            <div className="sk-step is-s-buyers is-goal" style={{ '--d': steps.length }}>
              <b><CountUp value={m.buyers} /></b>
              <strong>{tr('Customers who bought')}</strong>
              <small>{tr('{new} new · {returning} came back', { new: m.newBuyers, returning: m.returningBuyers })}</small>
            </div>
          </div>
        </div>
      );
    }
    if (sl.kind === 'moved') {
      const col = (list, tone, title, empty, extra) => (
        <section className={'wop-panel ssr-moved is-' + tone}>
          <h3><b><CountUp value={list.length} /></b> {title}</h3>
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
            {col(mv.won, 'good', tr('won'), tr('Nothing won this week.'), (x) => [x.item, x.repName].filter(Boolean).join(' · '))}
            {col(mv.lost, 'bad', tr('lost'), tr('Nothing lost this week.'), (x) => x.reason || tr('No reason given'))}
          </div>
          {data.moved.lostReasons.length > 0 && mv.lost.length > 1 && <p className="wop-note">{tr('Lost mostly because: {reason}', { reason: data.moved.lostReasons[0].reason || tr('No reason given') })}</p>}
        </div>
      );
    }
    if (sl.kind === 'bought') {
      const fact = (label, now, before, note) => (
        <div className="ssr-kpi">
          <span className="ssr-kpi-label">{label}</span>
          <b><CountUp value={now} /></b>
          {before !== undefined && <Delta now={now} before={before} />}
          {note && <span className="ssr-kpi-note">{note}</span>}
        </div>
      );
      return (
        <div className="wop-sum">
          <header className="wop-head">
            <span className="wop-eyebrow is-good">{tr('Customers and quotations')}</span>
            <h2>{m.buyers === 1 ? tr('1 customer bought this week') : tr('{n} customers bought this week', { n: m.buyers })}</h2>
            <p className="wop-sub">{tr('Counted against last week.')}</p>
          </header>
          <div className="ssr-kpis">
            {fact(tr('Customers who bought'), m.buyers, b.buyers, tr('{new} new · {returning} came back', { new: m.newBuyers, returning: m.returningBuyers }))}
            {fact(tr('Sale invoices'), m.invoices, b.invoices)}
            {fact(tr('Site visits made'), data.visits.done, undefined, data.visits.planned > data.visits.done ? tr('{n} booked this week', { n: data.visits.planned }) : null)}
            {fact(tr('Quotations sent'), m.quotesSent, b.quotesSent)}
            {fact(tr('Quotations accepted'), m.quotesWon, b.quotesWon)}
            {fact(tr('Quotations lost or run out'), m.quotesLost, b.quotesLost)}
          </div>
        </div>
      );
    }
    if (sl.kind === 'team') {
      const ranked = data.team.slice().sort((p, q) => q.won - p.won || q.prospects - p.prospects || (q.newLeads + q.inbox) - (p.newLeads + p.inbox) || p.name.localeCompare(q.name));
      const podium = ranked.filter((r) => r.won || r.prospects || r.newLeads + r.inbox).slice(0, 3);
      const order = podium.length === 3 ? [podium[1], podium[0], podium[2]] : podium;
      const rows = podium.length ? 5 : 8;
      return (
        <div className="wop-sum">
          <header className="wop-head"><span className="wop-eyebrow">{tr('The team')}</span><h2>{tr('Who did what this week')}</h2></header>
          <div className={'sk-team' + (podium.length ? '' : ' is-flat')}>
            {podium.length > 0 && (
              <div className="sk-podium">
                {order.map((r) => {
                  const place = podium.indexOf(r);
                  return (
                    <div key={r.repId} className={'sk-place ' + MEDAL[place]}>
                      <Photo id={r.repId} name={r.name} photo={r.photo} size={place === 0 ? 64 : 52} />
                      <strong>{r.name}</strong>
                      <span>{[r.won ? (r.won === 1 ? tr('1 won') : tr('{n} won', { n: r.won })) : null, r.prospects ? tr('{n} new prospects', { n: r.prospects }) : null].filter(Boolean).join(' · ') || tr('{n} new leads', { n: r.newLeads + r.inbox })}</span>
                      <div className="sk-block"><b>{place + 1}</b></div>
                    </div>
                  );
                })}
              </div>
            )}
            <table className="wop-table">
              <thead><tr><th>{tr('Rep')}</th><th>{tr('New leads')}</th><th>{tr('Answered')}</th><th>{tr('New prospects')}</th><th>{tr('Won')}</th></tr></thead>
              <tbody>
                {ranked.slice(0, rows).map((r) => (
                  <tr key={r.repId}>
                    <td><span className="wop-pm"><Photo id={r.repId} name={r.name} photo={r.photo} size={26} />{r.name}</span></td>
                    <td><b>{r.newLeads + r.inbox}</b></td>
                    <td>{r.newLeads ? <b className={r.contacted < r.newLeads ? 'is-bad' : 'is-good'}>{r.contacted}</b> : <span className="wop-zero">—</span>}</td>
                    <td>{r.prospects || <span className="wop-zero">0</span>}</td>
                    <td>{r.won ? <b className="is-good">{r.won}</b> : <span className="wop-zero">0</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.team.length > rows && <p className="wop-note">{tr('and {n} more', { n: data.team.length - rows })}</p>}
          {L.noRep > 0 && <p className="wop-note ssr-warn-note">{L.noRep === 1 ? tr('1 new lead has nobody assigned.') : tr('{n} new leads have nobody assigned.', { n: L.noRep })}</p>}
        </div>
      );
    }
    if (sl.kind === 'next') {
      const nextRange = weekLabel(data.next.from, data.next.to);
      const list = (data.followUps.nextList || []);
      const days = Array.from({ length: 7 }, (_, i) => {
        const d = addDays(data.next.from, i);
        return { key: d, fu: list.filter((f) => f.date === d), visits: data.visits.nextWeek.filter((v) => v.date === d) };
      });
      return (
        <div className="wop-sum">
          <header className="wop-head">
            <span className="wop-eyebrow is-pend">{tr('Next week')}</span>
            <h2>{tr('What is coming: {dates}', { dates: nextRange })}</h2>
            <p className="wop-sub">{[
              data.followUps.nextWeek === 1 ? tr('1 follow-up due') : tr('{n} follow-ups due', { n: data.followUps.nextWeek }),
              data.followUps.overdue ? tr('{n} follow-ups already overdue', { n: data.followUps.overdue }) : null,
              data.quotesExpiringNextWeek.n ? (data.quotesExpiringNextWeek.n === 1 ? tr('1 quotation running out') : tr('{n} quotations running out', { n: data.quotesExpiringNextWeek.n })) : null,
              data.followUps.none ? tr('{n} open leads with no follow-up date', { n: data.followUps.none }) : null
            ].filter(Boolean).join(' · ')}</p>
          </header>
          <div className="sk-week">
            {days.map((d, i) => {
              const items = d.visits.map((v) => ({ key: 'v' + v.id, kind: 'visit', title: v.client, sub: v.location || tr('Site visit') }))
                .concat(d.fu.map((f) => ({ key: 'f' + f.id, kind: 'fu', id: f.id, title: f.name, sub: [f.item, f.repName].filter(Boolean).join(' · ') || tr('Follow-up') })));
              return (
                <div key={d.key} className={'sk-wday' + (items.length ? ' is-busy' : '')} style={{ '--d': i }}>
                  <span className="sk-wday-head"><b>{weekday(d.key)}</b><small>{new Date(d.key + 'T00:00').toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' })}</small></span>
                  {items.slice(0, 4).map((it) => (
                    <button key={it.key} type="button" className={'sk-chip is-' + it.kind} disabled={!it.id} onClick={() => it.id && setOpen({ kind: 'lead', id: it.id })}>
                      <span className="sk-chip-tag">{it.kind === 'visit' ? tr('Site visit') : tr('Follow-up')}</span>
                      <span className="sk-chip-title">{it.title}</span>
                      <small>{it.sub}</small>
                    </button>
                  ))}
                  {items.length > 4 && <span className="sk-more">{tr('+{n} more', { n: items.length - 4 })}</span>}
                  {!items.length && <span className="sk-free">{tr('Nothing booked')}</span>}
                </div>
              );
            })}
          </div>
        </div>
      );
    }
    const good = L.total > 0 && !L.notContacted && mv.won.length > 0;
    const shout = [
      starOk ? tr('Star salesperson: {name}', { name: star.name }) : null,
      sources[0] ? tr('Top source: {source}', { source: sources[0].label }) : null,
      L.items[0] ? tr('Most asked for: {item}', { item: L.items[0].item }) : null
    ].filter(Boolean);
    return (
      <div className="wop-cover is-end sk-end">
        <span className="sk-orb is-a" aria-hidden="true" /><span className="sk-orb is-b" aria-hidden="true" />
        {good ? <span className="sk-confetti" aria-hidden="true">{Array.from({ length: 36 }, (_, i) => <i key={i} style={{ '--i': i }} />)}</span> : null}
        <span className="wop-eyebrow">{tr('Saturday review')} · {range}</span>
        <h1>{tr('Thank you, team')}</h1>
        {shout.length > 0 && <ul className="sk-shout">{shout.map((x) => <li key={x}>{x}</li>)}</ul>}
        <p className="wop-range">{L.notContacted
          ? (L.notContacted === 1 ? tr('Answer the 1 new lead still waiting before Monday.') : tr('Answer the {n} new leads still waiting before Monday.', { n: L.notContacted }))
          : tr('Every new lead has been answered. Keep it that way next week.')}</p>
      </div>
    );
  }

  return (
    <>
      <SlideDeck brand={tr('Saturday sales review')} className="is-fancy is-sales" weeks={weeks} weekFrom={weekFrom} onWeek={setWeekFrom}
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
