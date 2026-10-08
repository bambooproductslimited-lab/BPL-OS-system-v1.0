import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import ContactButtons from '../../components/ContactButtons';
import SearchInput from '../../components/SearchInput';
import { Glossary, avatarColor, fmtDate, initials } from '../../components/DashKit';
import { money } from '../../lib/currency';
import { activeIntlLocale, msg, tr } from '../../lib/i18n.jsx';
import CustomerProfile from './CustomerProfile';
import { LEAD_STAGES, PROSPECT_STAGES, STAGES, LeadDialog, NewLeadDialog, Toast, VisitDialog, addDays, daysUntil, followUpText, stage, todayISO, useCrmBasics, usePerms } from './crmShared';
import { ago, channelLabel, useReps } from './crmHubShared';
import '../EmployeesPage.css';
import './CrmPage.css';
import './CrmBoard.css';

// A sales rep's board (GET /api/crm/board, backend crmBoard.service.js):
// their leads, prospects and paying customers in three lanes, each lane
// ranked from what needs them most to what is on track. Every card says
// why it is where it is (a message waiting, a follow-up date passed, a
// quotation running out, an invoice overdue …), how hot it is, and what to
// do next. "Do these first" pulls the top three from any lane.
// Open a card for the reasons in full, to log a call with the next
// follow-up, or to move a lead along; drag a lead to the prospects (and
// back). What the rep does earns points: a daily goal, a streak of days,
// a level, badges for the week and the team's weekly ranking. A manager
// can look at one rep's board, or everyone's.
// Heat colours are the OS's status colours (hot, warm, on track), always
// written beside the colour.

const LANES = [
  { key: 'lead', icon: 'spark', title: msg('Leads'), sub: msg('New enquiries. Call them and find out what they need.'), empty: msg('No open leads. New enquiries land here.') },
  { key: 'prospect', icon: 'target', title: msg('Prospects'), sub: msg('Real jobs: qualified, quoted or agreeing the price. Close them.'), empty: msg('No prospects yet. Drag a qualified lead here.') },
  { key: 'customer', icon: 'crown', title: msg('Customers'), sub: msg('Your paying accounts. Keep them buying, and paying.'), empty: msg('No paying customers in your name yet.') }
];
const HEAT = { hot: [msg('Hot'), msg('Act today')], warm: [msg('Warm'), msg('Soon')], cool: [msg('On track'), msg('Nothing urgent')] };
const SIGNAL = {
  waiting: [msg('Waiting for a reply'), 'chat'],
  untouched: [msg('Not called yet'), 'spark'],
  followup_overdue: [msg('Follow-up overdue'), 'calendar'],
  followup_today: [msg('Follow-up today'), 'calendar'],
  quote_expiring: [msg('Quotation running out'), 'doc'],
  quote_waiting: [msg('Quotation not answered'), 'doc'],
  negotiation: [msg('Agreeing the price'), 'scale'],
  won_unpaid: [msg('Won, not paid'), 'cash'],
  overdue_invoice: [msg('Invoice overdue'), 'cash'],
  quiet: [msg('Gone quiet'), 'moon'],
  stuck: [msg('Stuck'), 'pause'],
  no_next_step: [msg('No next step'), 'flag'],
  big_deal: [msg('Big deal'), 'gem'],
  vip: [msg('VIP'), 'crown'],
  referral: [msg('Referral'), 'people']
};
const NEXT = {
  reply: [msg('Reply now'), 'chat'], call: [msg('Call them'), 'phone'], chase_quote: [msg('Chase the quotation'), 'doc'],
  close: [msg('Close the deal'), 'scale'], collect: [msg('Collect the money'), 'cash'], check_in: [msg('Check in with them'), 'phone'],
  move_on: [msg('Move it on'), 'arrow'], plan: [msg('Plan the next step'), 'calendar'], touch: [msg('Keep in touch'), 'chat']
};
const LEVEL = { starter: msg('Starter'), bronze: msg('Bronze'), silver: msg('Silver'), gold: msg('Gold'), platinum: msg('Platinum') };
const BADGES = [
  { key: 'closer', name: msg('Closer'), goal: msg('Win a deal this week'), icon: 'trophy', have: (p) => p.weekDone.wins, need: 1 },
  { key: 'hunter', name: msg('Hunter'), goal: msg('3 new prospects this week'), icon: 'target', have: (p) => p.weekDone.prospects, need: 3 },
  { key: 'dialer', name: msg('Dialer'), goal: msg('15 calls this week'), icon: 'phone', have: (p) => p.weekDone.calls, need: 15 },
  { key: 'responder', name: msg('Fast replier'), goal: msg('10 replies this week'), icon: 'chat', have: (p) => p.weekDone.replies, need: 10 },
  { key: 'streak', name: msg('On fire'), goal: msg('The daily goal 3 days in a row'), icon: 'flame', have: (p) => p.streak, need: 3 },
  { key: 'clear', name: msg('All clear'), goal: msg('No hot cards left'), icon: 'check', have: (p, hot) => (hot ? 0 : 1), need: 1 }
];
const EARN = [
  ['won', msg('A deal won')], ['quote', msg('A quotation made')], ['prospect', msg('A lead made a prospect')], ['contacted', msg('A new lead contacted')],
  ['call', msg('A call logged on a lead')], ['reply', msg('A reply to a customer\'s message')], ['logged', msg('A call or visit logged with a customer')], ['note', msg('A note on a lead')]
];
const FILTERS = [['all', msg('Everything')], ['action', msg('Needs action')], ['hot', msg('Hot only')]];
const STEP = 25;

function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* this visit only */ } }
function whenText(iso) { const d = daysUntil(iso); return d <= 0 ? tr('today') : d === 1 ? tr('tomorrow') : tr('in {n} days', { n: d }); }
function weekdayLetter(iso) { return new Date(iso + 'T00:00:00Z').toLocaleDateString(activeIntlLocale(), { weekday: 'narrow', timeZone: 'UTC' }); }
function weekdayName(iso) { return new Date(iso + 'T00:00:00Z').toLocaleDateString(activeIntlLocale(), { weekday: 'long', timeZone: 'UTC' }); }
function pointsText(n) { return n === 1 ? tr('1 point') : tr('{n} points', { n }); }

// One reason a card is ranked where it is, in a sentence.
function signalText(s) {
  switch (s.type) {
    case 'waiting': return s.hours >= 48
      ? tr('Wrote on {channel} {n} days ago, no answer yet', { channel: channelLabel(s.channel), n: Math.floor(s.hours / 24) })
      : tr('Wrote on {channel} {n} h ago, no answer yet', { channel: channelLabel(s.channel), n: s.hours });
    case 'untouched': return s.hours >= 48 ? tr('New lead, nobody has called for {n} days', { n: Math.floor(s.hours / 24) }) : tr('New lead, nobody has called yet ({n} h)', { n: s.hours });
    case 'followup_overdue': return s.days === 1 ? tr('The follow-up was due yesterday') : tr('The follow-up is {n} days overdue', { n: s.days });
    case 'followup_today': return tr('A follow-up is planned for today');
    case 'quote_expiring': return tr('Quotation {ref} runs out {when}', { ref: s.ref, when: whenText(s.on) });
    case 'quote_waiting': return tr('Quotation {ref} sent {n} days ago, no answer yet', { ref: s.ref, n: s.days });
    case 'negotiation': return tr('Agreeing the price: the closest to a sale');
    case 'won_unpaid': return tr('Won, but the money has not come in yet');
    case 'overdue_invoice': return s.invoices > 1
      ? tr('{count} invoices overdue, {amount} in all; the oldest {n} days', { count: s.invoices, amount: money(s.amount, s.currency), n: s.days })
      : tr('Invoice {ref} is {n} days overdue: {amount}', { ref: s.ref, n: s.days, amount: money(s.amount, s.currency) });
    case 'quiet': return s.lastBought ? tr('No contact for {n} days; last bought {date}', { n: s.days, date: fmtDate(s.lastBought) }) : tr('No contact for {n} days', { n: s.days });
    case 'stuck': return tr('{n} days in this stage without a move', { n: s.days });
    case 'no_next_step': return tr('No next follow-up planned');
    case 'big_deal': return tr('A big deal: {amount}', { amount: money(s.amount, s.currency) });
    case 'vip': return tr('A VIP customer');
    case 'referral': return tr('Came through a referral');
    default: return s.type;
  }
}
function stageText(c) {
  if (c.kind === 'customer') return c.stage === 'lead' ? tr('Lead') : c.stage === 'prospect' ? tr('Prospect') : c.vip ? tr('VIP customer') : tr('Customer');
  if (c.stage === 'won') return tr('Won, waiting for payment');
  return tr(stage(c.stage).label);
}

// ── small pieces ──────────────────────────────────────────────────────
const GLYPH = {
  spark: <path d="M12 3.5 13.8 9l5.7 1.5-5.7 1.6L12 17.5l-1.8-5.4-5.7-1.6L10.2 9zM18.5 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />,
  target: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.8" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /></>,
  crown: <path d="M4 18h16M5 15.5 3.5 7l5 4L12 5l3.5 6 5-4L19 15.5z" />,
  chat: <path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V16.5H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5z" />,
  phone: <path d="M6.5 4h3l1.5 4-2 1.2a10 10 0 0 0 5.8 5.8L16 13l4 1.5v3a2 2 0 0 1-2.2 2A15.5 15.5 0 0 1 4.5 6.2 2 2 0 0 1 6.5 4z" />,
  calendar: <><rect x="4" y="5.5" width="16" height="14.5" rx="2" /><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" /></>,
  doc: <><rect x="5" y="3.5" width="14" height="17" rx="1.5" /><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" /></>,
  scale: <path d="M12 4v16M6 20h12M4.5 8h15M7 8l-3 6a3 3 0 0 0 6 0zM17 8l-3 6a3 3 0 0 0 6 0z" />,
  cash: <><rect x="3" y="6.5" width="18" height="11" rx="1.5" /><circle cx="12" cy="12" r="2.5" /></>,
  moon: <path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z" />,
  pause: <><circle cx="12" cy="12" r="8.5" /><path d="M10 9v6M14 9v6" /></>,
  flag: <path d="M6 21V4M6 4.5h11l-2 4 2 4H6" />,
  gem: <><path d="M7 4h10l4 5-9 11L3 9z" /><path d="M3 9h18M9.5 4 8 9l4 11 4-11-1.5-5" /></>,
  people: <><circle cx="9" cy="8.5" r="3" /><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8M15.5 5.8a3 3 0 0 1 0 5.4M17.5 14.6c1.6.7 2.6 2.2 3 4.4" /></>,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  flame: <path d="M12 21c-3.9 0-6.5-2.6-6.5-6.2 0-3.4 2.4-5.4 3.6-8.3.5 1.7 1.5 2.8 2.6 3.2C11.6 6.6 13 4.4 15 3c-.3 2.9 3.5 5.6 3.5 11.1 0 4-2.7 6.9-6.5 6.9zm0 0c-1.6 0-2.7-1.2-2.7-2.8 0-1.8 1.6-2.7 2.2-4.2.9 1.4 3.2 2.3 3.2 4.3 0 1.5-1.1 2.7-2.7 2.7z" />,
  trophy: <><path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H4.5c0 3 1.5 4.5 3.7 4.8M16 6h3.5c0 3-1.5 4.5-3.7 4.8M12 13v4M8.5 20.5h7M9.5 17h5v3.5h-5z" /></>,
  medal: <><circle cx="12" cy="14.5" r="5.5" /><path d="M8.5 10 6 3.5h4l2 5M15.5 10 18 3.5h-4l-1.1 2.8" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  bolt: <path d="M13 3 5 13.5h6L10 21l9-11h-6z" />,
  open: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  chevL: <path d="m15 5-7 7 7 7" />,
  chevR: <path d="m9 5 7 7-7 7" />,
  refresh: <path d="M20 11a8 8 0 0 0-14.6-4.5M4 4.5V8h3.5M4 13a8 8 0 0 0 14.6 4.5M20 19.5V16h-3.5" />
};
function Glyph({ name }) {
  return <svg className="sb-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{GLYPH[name] || GLYPH.spark}</svg>;
}
function Avatar({ name, big }) {
  return <span className={'sb-avatar' + (big ? ' is-big' : '')} style={{ background: avatarColor(name) }} aria-hidden="true">{initials(name)}</span>;
}
function HeatPill({ level, score }) {
  return <span className={'sb-heatpill is-' + level} title={tr(HEAT[level][1])}><i aria-hidden="true" />{tr(HEAT[level][0])}<b>{score}</b></span>;
}
// The goal ring: today's points out of the daily goal.
function GoalRing({ value, goal }) {
  const r = 30, c = 2 * Math.PI * r, part = Math.min(1, goal ? value / goal : 0);
  return (
    <svg className="sb-ring" viewBox="0 0 72 72" aria-hidden="true">
      <circle cx="36" cy="36" r={r} className="sb-ring-track" />
      <circle cx="36" cy="36" r={r} className={'sb-ring-fill' + (part >= 1 ? ' is-met' : '')} strokeDasharray={(c * part) + ' ' + c} transform="rotate(-90 36 36)" />
    </svg>
  );
}
// A card's score as a small ring in its heat colour.
function ScoreRing({ score, level }) {
  const r = 24, c = 2 * Math.PI * r;
  return (
    <span className={'sb-score is-' + level}>
      <svg viewBox="0 0 60 60" aria-hidden="true">
        <circle cx="30" cy="30" r={r} className="sb-score-track" />
        <circle cx="30" cy="30" r={r} className="sb-score-fill" strokeDasharray={(c * score / 100) + ' ' + c} transform="rotate(-90 30 30)" />
      </svg>
      <strong>{score}</strong>
    </span>
  );
}

// Celebrations: paper pieces falling, a burst per number (none when the
// device asks for less motion).
function Confetti({ burst }) {
  const [pieces, setPieces] = useState([]);
  useEffect(() => {
    if (!burst) return undefined;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const colors = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'];
    setPieces(Array.from({ length: 90 }, (_, i) => ({
      id: burst + '-' + i, left: Math.random() * 100, delay: Math.random() * 0.35, dur: 1.8 + Math.random() * 1.4,
      color: colors[i % colors.length], rot: Math.round(Math.random() * 720 - 360), drift: Math.round((Math.random() - 0.5) * 220), w: 6 + Math.random() * 7
    })));
    const t = setTimeout(() => setPieces([]), 3600);
    return () => clearTimeout(t);
  }, [burst]);
  if (!pieces.length) return null;
  return (
    <div className="sb-confetti" aria-hidden="true">
      {pieces.map((p) => <i key={p.id} style={{ left: p.left + '%', background: p.color, width: p.w, height: p.w * 0.45, animationDelay: p.delay + 's', animationDuration: p.dur + 's', '--rot': p.rot + 'deg', '--drift': p.drift + 'px' }} />)}
    </div>
  );
}

// ── the banner: greeting, goal, streak, level, the week ───────────────
function greeting(name) {
  const h = new Date().getHours();
  if (!name) return h < 12 ? tr('Good morning') : h < 17 ? tr('Good afternoon') : tr('Good evening');
  return h < 12 ? tr('Good morning, {name}', { name }) : h < 17 ? tr('Good afternoon, {name}', { name }) : tr('Good evening, {name}', { name });
}

function Banner({ data, meId, firstName, pop, onFirst, onNewLead, canManage, repPicker }) {
  const p = data.progress;
  const hot = data.counts.lead.hot + data.counts.prospect.hot + data.counts.customer.hot;
  const warm = data.counts.lead.warm + data.counts.prospect.warm + data.counts.customer.warm;
  const first = data.focus[0];
  const own = !data.all && data.rep;
  const whose = own && data.rep.id !== meId ? data.rep.name : null;
  let line;
  if (hot && (data.all || whose)) line = hot === 1 ? tr('1 needs the team now. Start with {name}.', { name: first.name }) : tr('{n} need the team now. Start with {name}.', { n: hot, name: first.name });
  else if (hot) line = hot === 1 ? tr('1 needs you now. Start with {name}.', { name: first.name }) : tr('{n} need you now. Start with {name}.', { n: hot, name: first.name });
  else if (warm) line = warm === 1 ? tr('Nothing on fire. 1 could use you soon.') : tr('Nothing on fire. {n} could use you soon.', { n: warm });
  else line = tr('All clear. A good time to call a quiet customer, or to find new leads.');
  const lv = p.level;
  const lvPct = lv.next ? Math.round((p.month - lv.from) / (lv.next.at - lv.from) * 100) : 100;
  const maxDay = Math.max(p.goal, ...p.days.map((d) => d.points));
  const pipeline = data.counts.lead.value + data.counts.prospect.value;
  const td = p.todayDone || {};
  const done = [
    td.calls && (td.calls === 1 ? tr('1 call') : tr('{n} calls', { n: td.calls })),
    td.replies && (td.replies === 1 ? tr('1 reply') : tr('{n} replies', { n: td.replies })),
    td.moves && (td.moves === 1 ? tr('1 move') : tr('{n} moves', { n: td.moves })),
    td.wins && (td.wins === 1 ? tr('1 win') : tr('{n} wins', { n: td.wins }))
  ].filter(Boolean).join(', ');
  return (
    <section className="sb-hero">
      <span className="sb-hero-glow" aria-hidden="true" />
      <div className="sb-hero-main">
        <p className="sb-eyebrow">{data.all ? tr('Everyone\'s sales board') : whose ? tr('{name}\'s sales board', { name: whose }) : tr('My sales board')}</p>
        <h1 className="sb-hero-title">{data.all || whose ? tr('Who needs the team today') : greeting(firstName)}</h1>
        <p className="sb-hero-sub">{line}</p>
        <div className="sb-hero-actions">
          {first && <button type="button" className="sb-btn is-primary" onClick={onFirst}><Glyph name="bolt" />{tr('Start with the first')}</button>}
          {canManage && <button type="button" className="sb-btn is-ghost" onClick={onNewLead}><Glyph name="plus" />{tr('New lead')}</button>}
          {repPicker}
        </div>
      </div>
      {own ? (
        <div className="sb-hero-tiles">
          <div className={'sb-tile is-goal' + (p.today >= p.goal ? ' is-met' : '')}>
            <span className="sb-tile-label">{tr('Today\'s goal')}</span>
            <div className="sb-goal">
              <GoalRing value={p.today} goal={p.goal} />
              <span className="sb-goal-n"><strong>{p.today}</strong><small>/ {p.goal}</small></span>
              {pop && <span key={pop.id} className="sb-pop">+{pop.n}</span>}
            </div>
            <span className="sb-tile-note">{p.today >= p.goal ? tr('Goal met. Great work!') : tr('{n} points to go', { n: p.goal - p.today })}{done ? ' · ' + done : ''}</span>
          </div>
          <div className={'sb-tile is-streak' + (p.streak ? ' is-on' : '')}>
            <span className="sb-tile-label">{tr('Streak')}</span>
            <span className="sb-flame"><Glyph name="flame" /><strong>{p.streak}</strong></span>
            <span className="sb-streak-days" role="img" aria-label={p.days.map((d) => weekdayName(d.day) + ': ' + (d.points >= p.goal ? tr('goal met') : tr('goal not met'))).join('; ')}>
              {p.days.map((d) => <i key={d.day} className={d.points >= p.goal ? 'is-met' : d.day === todayISO() ? 'is-today' : ''} title={weekdayName(d.day)}>{weekdayLetter(d.day)}</i>)}
            </span>
            <span className="sb-tile-note">{p.streak === 0 ? tr('Meet the goal today to start one') : p.today >= p.goal ? (p.streak === 1 ? tr('1 day at the goal') : tr('{n} days in a row at the goal', { n: p.streak })) : tr('Meet today\'s goal to keep it going')}</span>
          </div>
          <div className={'sb-tile is-level is-' + lv.key}>
            <span className="sb-tile-label">{tr('Level')}</span>
            <span className="sb-level"><Glyph name="medal" /><strong>{tr(LEVEL[lv.key])}</strong></span>
            <span className="sb-level-pts">{pointsText(p.month)}</span>
            <span className="sb-meter" role="img" aria-label={tr('{n}% of the way', { n: lvPct })}><i style={{ width: lvPct + '%' }} /></span>
            <span className="sb-tile-note">{lv.next ? tr('{n} points to {level}', { n: lv.next.at - p.month, level: tr(LEVEL[lv.next.key]) }) : tr('The top level')} · {tr('last 30 days')}</span>
          </div>
          <div className="sb-tile is-week">
            <span className="sb-tile-label">{tr('This week')}</span>
            <strong className="sb-tile-value">{p.week}</strong>
            <div className="sb-days" role="img" aria-label={p.days.map((d) => weekdayName(d.day) + ': ' + pointsText(d.points)).join('; ')}>
              <span className="sb-days-goal" style={{ bottom: (p.goal / maxDay * 100) + '%' }} title={tr('Daily goal')} />
              {p.days.map((d) => (
                <span key={d.day} className={'sb-day' + (d.points >= p.goal ? ' is-met' : '') + (d.day === todayISO() ? ' is-today' : '')} title={weekdayName(d.day) + ': ' + pointsText(d.points)}>
                  <i style={{ height: Math.max(4, d.points / maxDay * 100) + '%' }} />
                  <small>{weekdayLetter(d.day)}</small>
                </span>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="sb-hero-tiles">
          <div className="sb-tile"><span className="sb-tile-label">{tr('Need action now')}</span><strong className="sb-tile-value">{hot}</strong><span className="sb-tile-note">{tr('Hot cards: act today')}</span></div>
          <div className="sb-tile"><span className="sb-tile-label">{tr('Soon')}</span><strong className="sb-tile-value">{warm}</strong><span className="sb-tile-note">{tr('Warm cards: this week')}</span></div>
          <div className="sb-tile"><span className="sb-tile-label">{tr('Open quotations')}</span><strong className="sb-tile-value is-money">{money(pipeline, 'GHS')}</strong><span className="sb-tile-note">{tr('On leads and prospects')}</span></div>
          <div className="sb-tile"><span className="sb-tile-label">{tr('Team this week')}</span><strong className="sb-tile-value">{p.leaderboard.reduce((a, x) => a + x.points, 0)}</strong><span className="sb-tile-note">{tr('Points since Monday')}</span></div>
        </div>
      )}
    </section>
  );
}

// ── "do these first" ──────────────────────────────────────────────────
function Focus({ cards, onOpen, onNext }) {
  if (!cards.length) {
    return (
      <section className="sb-focus is-clear" aria-label={tr('Do these first')}>
        <span className="sb-focus-clear"><Glyph name="check" /></span>
        <div><h2>{tr('Nothing urgent')}</h2><p>{tr('No messages waiting, no dates passed, no money late. Use the time for a quiet customer or a new lead.')}</p></div>
      </section>
    );
  }
  return (
    <section className="sb-focus" aria-labelledby="sb-focus-title">
      <div className="sb-focus-head">
        <h2 id="sb-focus-title"><Glyph name="bolt" />{tr('Do these first')}</h2>
        <p>{tr('The most important cards from all three lanes.')}</p>
      </div>
      <ol className="sb-focus-list">
        {cards.map((c, i) => (
          <li key={c.key} className={'sb-focus-card is-' + c.level}>
            <button type="button" className="sb-focus-open" onClick={() => onOpen(c, cards)}>
              <span className="sb-focus-n" aria-hidden="true">{i + 1}</span>
              <span className="sb-focus-who">
                <span className="sb-focus-lane">{tr(LANES.find((l) => l.key === c.lane).title)}{c.kind === 'lead' ? ' · ' + stageText(c) : c.vip ? ' · ' + tr('VIP') : ''}</span>
                <strong>{c.name}</strong>
                <span className="sb-focus-why">{c.signals[0] ? signalText(c.signals[0]) : ''}</span>
              </span>
              <HeatPill level={c.level} score={c.score} />
            </button>
            <button type="button" className="sb-next is-strong" onClick={() => onNext(c, cards)}><Glyph name={NEXT[c.next][1]} />{tr(NEXT[c.next][0])}</button>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ── a card and a lane ─────────────────────────────────────────────────
function Card({ c, list, onOpen, onNext, showRep, canDrag: laneDrag, onDrag }) {
  const canDrag = laneDrag && c.kind === 'lead';
  const top = c.signals[0];
  const more = c.signals.slice(1, 3);
  const sub = [c.company, c.item].filter(Boolean).join(' · ') || c.location;
  return (
    <article
      className={'sb-card is-' + c.level} tabIndex={0} draggable={canDrag}
      onDragStart={canDrag ? (e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', c.key); onDrag(c); } : undefined}
      onDragEnd={canDrag ? () => onDrag(null) : undefined}
      onClick={() => onOpen(c, list)} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(c, list); }}
      aria-label={tr('Number {rank}: {name}', { rank: c.rank, name: c.name }) + ', ' + tr(HEAT[c.level][0]) + ' ' + c.score}
    >
      <header className="sb-card-head">
        <span className="sb-rank" aria-hidden="true">{c.rank}</span>
        <Avatar name={c.name} />
        <span className="sb-who"><strong>{c.name}</strong>{sub && <small>{sub}</small>}</span>
        <HeatPill level={c.level} score={c.score} />
      </header>
      {top ? <p className="sb-why"><Glyph name={SIGNAL[top.type][1]} /><span>{signalText(top)}</span></p>
        : <p className="sb-why is-calm"><Glyph name="check" /><span>{c.nextFollowUp ? tr('On track. Next follow-up {when}.', { when: followUpText(c.nextFollowUp) }) : tr('On track.')}</span></p>}
      <div className="sb-chips">
        {c.lane !== 'customer' && <span className="sb-chip is-stage">{stageText(c)}</span>}
        {c.value > 0 && <span className="sb-chip is-money">{c.lane === 'customer' ? tr('{amount} bought', { amount: money(c.value, c.currency) }) : tr('{amount} quoted', { amount: money(c.value, c.currency) })}</span>}
        {more.map((s) => <span key={s.type} className="sb-chip"><Glyph name={SIGNAL[s.type][1]} />{tr(SIGNAL[s.type][0])}</span>)}
        {showRep && c.rep && <span className="sb-chip is-rep"><Glyph name="people" />{c.rep.name}</span>}
      </div>
      <footer className="sb-card-foot">
        <button type="button" className="sb-next" onClick={(e) => { e.stopPropagation(); onNext(c, list); }}><Glyph name={NEXT[c.next][1]} />{tr(NEXT[c.next][0])}</button>
        <ContactButtons name={c.name} phone={c.phone} email={c.email} />
      </footer>
    </article>
  );
}

function Lane({ lane, cards, info, hidden, dragging, onDrop, ...rest }) {
  const [over, setOver] = useState(false);
  const [shown, setShown] = useState(STEP);
  const owed = lane.key === 'customer' ? cards.reduce((a, c) => a + c.signals.filter((s) => s.type === 'overdue_invoice').reduce((b, s) => b + s.amount, 0), 0) : 0;
  const droppable = dragging && dragging.lane !== lane.key;
  return (
    <section
      className={'sb-lane is-' + lane.key + (over ? ' is-over' : '') + (droppable ? ' is-target' : '') + (hidden ? ' is-hidden-phone' : '')}
      aria-labelledby={'sb-lane-' + lane.key}
      onDragOver={(e) => { if (droppable) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (!over) setOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); }}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (droppable) onDrop(lane.key); }}
    >
      <header className="sb-lane-head">
        <span className="sb-lane-icon"><Glyph name={lane.icon} /></span>
        <div className="sb-lane-title">
          <h2 id={'sb-lane-' + lane.key}>{tr(lane.title)} <span className="sb-count">{info.total}</span></h2>
          <p>{tr(lane.sub)}</p>
        </div>
      </header>
      <div className="sb-lane-stats">
        <span className="sb-stat is-hot"><i aria-hidden="true" />{tr('{n} hot', { n: info.hot })}</span>
        <span className="sb-stat is-warm"><i aria-hidden="true" />{tr('{n} warm', { n: info.warm })}</span>
        {lane.key !== 'customer' && info.value > 0 && <span className="sb-stat is-money">{tr('{amount} quoted', { amount: money(info.value, 'GHS') })}</span>}
        {owed > 0 && <span className="sb-stat is-money is-bad">{tr('{amount} overdue', { amount: money(owed, 'GHS') })}</span>}
      </div>
      {droppable && <p className="sb-drop-hint">{lane.key === 'prospect' ? tr('Drop here: qualified, a prospect now') : lane.key === 'lead' ? tr('Drop here: back to follow-up') : tr('Customers come by paying')}</p>}
      <div className="sb-lane-body">
        {cards.length === 0 && <p className="sb-lane-empty">{tr(lane.empty)}</p>}
        {cards.slice(0, shown).map((c) => <Card key={c.key} c={c} list={cards} {...rest} />)}
        {cards.length > shown && <button type="button" className="sb-more" onClick={() => setShown(shown + STEP)}>{tr('Show {n} more', { n: Math.min(STEP, cards.length - shown) })}</button>}
      </div>
    </section>
  );
}

// ── a card opened: why, what next, log it, move it ────────────────────
const WHEN = [[1, msg('Tomorrow')], [3, msg('In 3 days')], [7, msg('Next week')]];

function Sheet({ c, list, points, canManage, onClose, onPick, onLog, onMove, onFull, go }) {
  const isLead = c.kind === 'lead';
  const due = c.nextFollowUp && c.nextFollowUp <= todayISO();
  const [kind, setKind] = useState('call');
  const [body, setBody] = useState('');
  const [fu, setFu] = useState(null);   // null: leave the follow-up as it is; '': none; or a date
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const box = useRef(null);
  useEffect(() => {
    setKind('call'); setBody(''); setError(null);
    // A follow-up that was due is done once logged: a lead gets the next one, a customer none.
    setFu(due ? (isLead ? addDays(todayISO(), 3) : '') : null);
    if (box.current) box.current.scrollTop = 0;
  }, [c.key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const k = (e) => { if (e.key === 'Escape' && !busy) onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [busy, onClose]);
  const idx = list.findIndex((x) => x.key === c.key);
  const earn = isLead ? (kind === 'call' ? points.call : points.note) + (c.stage === 'new' ? points.contacted : 0) : points.logged;
  const waiting = c.signals.find((s) => s.type === 'waiting');
  const quote = c.signals.find((s) => s.quotationId);
  const invoice = c.signals.find((s) => s.type === 'overdue_invoice');

  async function save() {
    setBusy(true); setError(null);
    try { await onLog(c, { kind, body: body.trim(), fu }, earn); setBody(''); } catch (err) { setError(err.message); }
    setBusy(false);
  }
  async function move(to) {
    setBusy(true); setError(null);
    try { await onMove(c, to); } catch (err) { setError(err.message); }
    setBusy(false);
  }
  const facts = [
    [tr('Stage'), stageText(c)],
    [tr('Next follow-up'), c.nextFollowUp ? fmtDate(c.nextFollowUp) + ' · ' + followUpText(c.nextFollowUp) : tr('None planned')],
    isLead && [tr('Came in on'), c.receivedOn ? fmtDate(c.receivedOn) + (c.source ? ' · ' + c.source : '') : '—'],
    isLead && c.daysInStage !== null && [tr('In this stage'), c.daysInStage === 1 ? tr('1 day') : tr('{n} days', { n: c.daysInStage })],
    [tr('Last contact'), c.lastTouchAt ? ago(c.lastTouchAt) : tr('None yet')],
    c.value ? [c.lane === 'customer' ? tr('Bought in all') : tr('Quoted'), money(c.value, c.currency)] : null,
    c.location && [tr('Location'), c.location],
    c.rep && [tr('Sales rep'), c.rep.name]
  ].filter(Boolean);

  return (
    <div className="sb-sheet-backdrop" onClick={() => !busy && onClose()}>
      <aside className="sb-sheet" role="dialog" aria-modal="true" aria-labelledby="sb-sheet-title" onClick={(e) => e.stopPropagation()}>
        <header className={'sb-sheet-band is-' + c.level}>
          <button type="button" className="sb-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
          <Avatar name={c.name} big />
          <div className="sb-sheet-who">
            <p className="sb-eyebrow">{tr(LANES.find((l) => l.key === c.lane).title)} · {tr('number {n}', { n: c.rank })}</p>
            <h2 id="sb-sheet-title">{c.name}</h2>
            <p>{[c.company, c.item, c.ref].filter(Boolean).join(' · ') || stageText(c)}</p>
          </div>
          <ScoreRing score={c.score} level={c.level} />
        </header>
        <div className="sb-sheet-body" ref={box}>
          <section className="sb-block">
            <h3>{tr('Why it is ranked here')}</h3>
            {c.signals.length ? (
              <ul className="sb-reasons">
                {c.signals.map((s) => (
                  <li key={s.type}>
                    <span className="sb-reason-icon"><Glyph name={SIGNAL[s.type][1]} /></span>
                    <span>{signalText(s)}</span>
                    <b title={tr('Adds {n} to the score', { n: s.points })}>+{s.points}</b>
                  </li>
                ))}
              </ul>
            ) : <p className="sb-calm">{tr('Nothing needs doing now: no message waiting, no date passed, no money late.')}</p>}
            <p className="sb-score-note">{tr('Score {n} of 100', { n: c.score })} · <strong>{tr(HEAT[c.level][0])}</strong>: {tr(HEAT[c.level][1])}</p>
          </section>

          <section className="sb-block">
            <h3>{tr('What to do next: {action}', { action: tr(NEXT[c.next][0]) })}</h3>
            <div className="sb-do">
              {waiting && <button type="button" className="sb-btn is-primary is-small" onClick={() => go('/crminbox?c=' + waiting.conversationId)}><Glyph name="chat" />{tr('Open the conversation')}</button>}
              {quote && <button type="button" className="sb-btn is-ghost is-small" onClick={() => go('/quotations?open=' + quote.quotationId)}><Glyph name="doc" />{tr('Open quotation {ref}', { ref: quote.ref })}</button>}
              {invoice && <button type="button" className="sb-btn is-ghost is-small" onClick={() => go('/invoices?open=' + invoice.invoiceId)}><Glyph name="cash" />{tr('Open invoice {ref}', { ref: invoice.ref })}</button>}
              <ContactButtons name={c.name} phone={c.phone} email={c.email} />
            </div>
          </section>

          {canManage && (
            <section className="sb-block">
              <h3>{tr('Log what happened')}</h3>
              <div className="sb-seg" role="radiogroup" aria-label={tr('What it was')}>
                {(isLead ? [['call', tr('A call')], ['note', tr('A note')]] : [['call', tr('A call')], ['visit', tr('A visit')]]).map(([k, label]) => (
                  <button key={k} type="button" role="radio" aria-checked={kind === k} className={'sb-seg-opt' + (kind === k ? ' is-on' : '')} onClick={() => setKind(k)}>{label}</button>
                ))}
              </div>
              <label className="sr-only" htmlFor="sb-log">{tr('What was said')}</label>
              <textarea id="sb-log" className="input sb-log" rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder={tr('What did they say? What was agreed?')} />
              <div className="sb-when">
                <span className="sb-when-label">{tr('Next follow-up')}</span>
                {WHEN.map(([n, label]) => {
                  const d = addDays(todayISO(), n);
                  return <button key={n} type="button" className={'sb-when-opt' + (fu === d ? ' is-on' : '')} onClick={() => setFu(fu === d ? null : d)}>{tr(label)}</button>;
                })}
                <input type="date" className="input sb-when-date" value={fu || ''} min={todayISO()} onChange={(e) => setFu(e.target.value || null)} aria-label={tr('Pick a date')} />
                <button type="button" className={'sb-when-opt' + (fu === '' ? ' is-on' : '')} onClick={() => setFu(fu === '' ? null : '')}>{tr('No follow-up')}</button>
              </div>
              <p className="sb-when-now">{fu === null ? (c.nextFollowUp ? tr('The follow-up stays on {date}.', { date: fmtDate(c.nextFollowUp) }) : tr('No follow-up will be planned.')) : fu === '' ? tr('No follow-up will be planned.') : tr('Next follow-up: {date}.', { date: fmtDate(fu) })}</p>
              {error && <p className="error-banner" role="alert">{error}</p>}
              <button type="button" className="sb-btn is-primary sb-save" disabled={busy || !body.trim()} onClick={save}>
                <Glyph name="check" />{busy ? tr('Saving…') : tr('Save')}<span className="sb-earn">+{earn}</span>
              </button>
            </section>
          )}

          {canManage && isLead && (
            <section className="sb-block">
              <h3>{tr('Move it along')}</h3>
              <div className="sb-stages">
                {STAGES.filter((s) => s.key !== 'lost').map((s) => {
                  const bonus = s.key === 'won' ? points.won : PROSPECT_STAGES.includes(s.key) && LEAD_STAGES.includes(c.stage) ? points.prospect : s.key === 'contacted' && c.stage === 'new' ? points.contacted : 0;
                  return (
                    <button key={s.key} type="button" className={'sb-stage' + (s.key === c.stage ? ' is-on' : '') + (PROSPECT_STAGES.includes(s.key) || s.key === 'won' ? ' is-prospect' : '')} disabled={busy || s.key === c.stage} onClick={() => move(s.key)} title={tr(s.help)}>
                      {tr(s.label)}{bonus > 0 && <small>+{bonus}</small>}
                    </button>
                  );
                })}
              </div>
              <p className="sb-hint">{tr('Lost it? Open the full record to say why.')}</p>
            </section>
          )}

          <section className="sb-block">
            <h3>{tr('The facts')}</h3>
            <dl className="sb-facts">{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
            {c.lastNote && <p className="sb-lastnote">“{c.lastNote.body}” <small>{ago(c.lastNote.at)}</small></p>}
          </section>
        </div>
        <footer className="sb-sheet-foot">
          <button type="button" className="sb-btn is-ghost is-small" onClick={onFull}><Glyph name="open" />{tr('Open the full record')}</button>
          <span className="sb-sheet-step">
            <button type="button" className="sb-icon-btn" disabled={idx <= 0} onClick={() => onPick(list[idx - 1], list)} aria-label={tr('Previous card')}><Glyph name="chevL" /></button>
            <span>{tr('{n} of {total}', { n: idx + 1, total: list.length })}</span>
            <button type="button" className="sb-icon-btn" disabled={idx < 0 || idx >= list.length - 1} onClick={() => onPick(list[idx + 1], list)} aria-label={tr('Next card')}><Glyph name="chevR" /></button>
          </span>
        </footer>
      </aside>
    </div>
  );
}

// ── the side panels: the team's week, badges, points ──────────────────
function Leaders({ p, meId }) {
  const top = p.leaderboard[0] ? p.leaderboard[0].points : 1;
  return (
    <section className="sb-panel">
      <header className="sb-panel-head"><h3><Glyph name="trophy" />{tr('This week\'s team')}</h3><p>{tr('Points since Monday. Calls, replies, moves and wins all count.')}</p></header>
      {p.leaderboard.length ? (
        <ol className="sb-leaders">
          {p.leaderboard.map((x, i) => (
            <li key={x.id} className={x.id === meId ? 'is-me' : ''}>
              <span className={'sb-medal is-' + (i + 1)}>{i + 1}</span>
              <Avatar name={x.name} />
              <span className="sb-leader-name">{x.name}{x.id === meId && <em>{tr('you')}</em>}{x.wins > 0 && <small>{x.wins === 1 ? tr('1 win') : tr('{n} wins', { n: x.wins })}</small>}</span>
              <span className="sb-leader-bar" aria-hidden="true"><i style={{ width: Math.max(4, x.points / top * 100) + '%' }} /></span>
              <b>{x.points}</b>
            </li>
          ))}
        </ol>
      ) : <p className="sb-lane-empty">{tr('No points yet this week. The first call puts you on the board.')}</p>}
      {p.rank > p.leaderboard.length && <p className="sb-panel-note">{tr('You are number {rank} of {of}.', { rank: p.rank, of: p.of })}</p>}
    </section>
  );
}
function Badges({ p, hot }) {
  return (
    <section className="sb-panel">
      <header className="sb-panel-head"><h3><Glyph name="medal" />{tr('Badges this week')}</h3><p>{tr('Earned badges light up. Each starts again on Monday.')}</p></header>
      <ul className="sb-badges">
        {BADGES.map((b) => {
          const have = Math.min(b.need, b.have(p, hot));
          const won = p.badges.some((x) => x.key === b.key);
          return (
            <li key={b.key} className={'sb-badge is-' + b.key + (won ? ' is-won' : '')}>
              <span className="sb-badge-icon"><Glyph name={b.icon} /></span>
              <strong>{tr(b.name)}</strong>
              <small>{tr(b.goal)}</small>
              {won ? <span className="sb-badge-state"><Glyph name="check" />{tr('Earned')}</span> : <span className="sb-meter is-small" role="img" aria-label={have + ' / ' + b.need}><i style={{ width: (have / b.need * 100) + '%' }} /></span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
function Earn({ p }) {
  return (
    <section className="sb-panel">
      <header className="sb-panel-head"><h3><Glyph name="bolt" />{tr('How to earn points')}</h3><p>{tr('The daily goal is {n} points. Reach it every day for a streak.', { n: p.goal })}</p></header>
      <ul className="sb-earn-list">{EARN.map(([k, label]) => <li key={k}><span>{tr(label)}</span><b>+{p.points[k]}</b></li>)}</ul>
      <p className="sb-panel-note">{tr('Levels count the last 30 days: Bronze at 300, Silver at 800, Gold at 1,600, Platinum at 3,000.')}</p>
    </section>
  );
}

// ── the page ──────────────────────────────────────────────────────────
export default function CrmBoardPage() {
  const navigate = useNavigate();
  const { session, can } = useAuth();
  const meId = session && session.employee ? session.employee.id : null;
  const firstName = session && session.employee ? (session.employee.firstName || session.employee.first_name || '') : '';
  const { canManage } = usePerms();
  const canAssign = can('crm.assign');
  const { settings, people } = useCrmBasics();
  const { reps } = useReps(canAssign);
  const [params, setParams] = useSearchParams();
  const rep = params.get('rep') || 'me';
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState(() => readPref('sb.filter', 'all'));
  const [phoneLane, setPhoneLane] = useState('lead');
  const [open, setOpen] = useState(null);     // { key, list }
  const [dialog, setDialog] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [toast, setToast] = useState(null);
  const [burst, setBurst] = useState(0);
  const [pop, setPop] = useState(null);
  const lastToday = useRef(null);
  const clearToast = useCallback(() => setToast(null), []);

  const load = useCallback(async () => {
    try {
      const d = await api.get('/crm/board' + (rep !== 'me' ? '?rep=' + encodeURIComponent(rep) : ''));
      // Reaching the daily goal is worth a party.
      const before = lastToday.current;
      if (before !== null && d.rep && before < d.progress.goal && d.progress.today >= d.progress.goal) {
        setBurst((b) => b + 1);
        setToast(d.progress.streak > 1 ? tr('Daily goal reached! {n} days in a row.', { n: d.progress.streak }) : tr('Daily goal reached!'));
      }
      lastToday.current = d.rep ? d.progress.today : null;
      setData(d); setError(null);
    } catch (err) { setError(err.message); }
  }, [rep]);
  useEffect(() => { lastToday.current = null; load(); }, [load]);
  useEffect(() => { const t = setInterval(load, 120000); return () => clearInterval(t); }, [load]);

  function pickRep(v) { const p = new URLSearchParams(params); if (v && v !== 'me') p.set('rep', v); else p.delete('rep'); setParams(p, { replace: true }); setOpen(null); }
  function pickFilter(v) { setFilter(v); writePref('sb.filter', v); }
  function earned(n) { if (n > 0) setPop({ id: Date.now(), n }); }

  const lanes = useMemo(() => {
    if (!data) return { lead: [], prospect: [], customer: [] };
    const needle = q.trim().toLowerCase();
    const keep = (c) => (filter === 'all' || (filter === 'hot' ? c.level === 'hot' : c.level !== 'cool'))
      && (!needle || [c.name, c.company, c.item, c.phone, c.ref, c.location].some((x) => x && String(x).toLowerCase().includes(needle)));
    return { lead: data.lanes.lead.filter(keep), prospect: data.lanes.prospect.filter(keep), customer: data.lanes.customer.filter(keep) };
  }, [data, q, filter]);
  const all = data ? data.lanes.lead.concat(data.lanes.prospect, data.lanes.customer) : [];
  const openCard = open ? all.find((c) => c.key === open.key) : null;
  const openList = open ? open.list.map((x) => all.find((c) => c.key === x.key) || x) : [];
  const hotLeft = data ? data.counts.lead.hot + data.counts.prospect.hot + data.counts.customer.hot : 0;

  function openSheet(c, list) { setOpen({ key: c.key, list: list || [c] }); }
  function next(c, list) {
    const w = c.next === 'reply' && c.signals.find((s) => s.type === 'waiting');
    if (w) navigate('/crminbox?c=' + w.conversationId);
    else openSheet(c, list);
  }

  async function log(c, { kind, body, fu }, earn) {
    if (c.kind === 'lead') {
      const payload = { kind, body };
      if (fu !== null) payload.nextFollowUp = fu || null;
      await api.post('/crm/leads/' + c.leadId + '/notes', payload);
    } else {
      await api.post('/crm/profiles/' + c.customerId + '/log', { channel: kind, body, direction: 'out' });
      if (fu !== null) await api.put('/crm/profiles/' + c.customerId + '/follow-up', { on: fu || null, note: fu ? body.slice(0, 200) : '' });
    }
    earned(earn);
    setToast(tr('Logged. +{n} points.', { n: earn }));
    await load();
  }

  async function move(c, to) {
    const from = c.stage;
    await api.post('/crm/leads/' + c.leadId + '/stage', { stage: to });
    const p = data.progress.points;
    if (to === 'won') { setBurst((b) => b + 1); earned(p.won); setToast(tr('Deal won with {name}! +{n} points.', { name: c.name, n: p.won })); }
    else if (PROSPECT_STAGES.includes(to) && LEAD_STAGES.includes(from)) { setBurst((b) => b + 1); earned(p.prospect); setToast(tr('{name} is a prospect now. +{n} points.', { name: c.name, n: p.prospect })); }
    else if (to === 'contacted' && from === 'new') { earned(p.contacted); setToast(tr('Moved to {stage}. +{n} points.', { stage: tr(stage(to).label), n: p.contacted })); }
    else setToast(tr('Moved to {stage}.', { stage: tr(stage(to).label) }));
    await load();
  }

  async function drop(laneKey) {
    const c = dragging;
    setDragging(null);
    if (!c || c.lane === laneKey) return;
    if (laneKey === 'customer') { setToast(tr('{name} becomes a customer when their first payment comes in.', { name: c.name })); return; }
    if (c.kind !== 'lead') { setToast(tr('Make a lead for {name} first: open the full record.', { name: c.name })); return; }
    if (c.stage === 'won') { setToast(tr('A won deal stays with the prospects until it is paid.')); return; }
    try { await move(c, laneKey === 'prospect' ? 'qualified' : 'follow_up'); } catch (err) { setToast(err.message); }
  }

  function full(c) {
    setOpen(null);
    if (c.kind === 'lead') setDialog({ kind: 'lead', id: c.leadId });
    else setDialog({ kind: 'customer', id: c.customerId });
  }

  const repPicker = canAssign ? (
    <label className="sb-rep">
      <span className="sr-only">{tr('Whose board')}</span>
      <Glyph name="people" />
      <select value={rep} onChange={(e) => pickRep(e.target.value)} aria-label={tr('Whose board')}>
        <option value="me">{tr('My board')}</option>
        <option value="all">{tr('Everyone')}</option>
        {(data ? data.reps : []).filter((r) => r.id !== meId).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
    </label>
  ) : null;

  if (error && !data) return <div className="page sb"><p className="error-banner" role="alert">{error}</p></div>;
  if (!data) return <div className="page sb"><div className="sb-skeleton" aria-busy="true"><span /><span /><span /></div></div>;
  if (!data.all && !data.rep) {
    return (
      <div className="page sb">
        <div className="sb-panel sb-nolink"><Glyph name="people" /><p>{tr('Your sign-in is not linked to a staff record, so there is no board to show.')}</p>{repPicker}</div>
      </div>
    );
  }
  const total = data.lanes.lead.length + data.lanes.prospect.length + data.lanes.customer.length;
  const own = !data.all && data.rep;

  return (
    <div className="page sb">
      <Banner data={data} meId={meId} firstName={firstName} pop={pop} canManage={canManage} repPicker={repPicker}
        onFirst={() => openSheet(data.focus[0], data.focus)} onNewLead={() => setDialog({ kind: 'new' })} />

      <Focus cards={data.focus} onOpen={openSheet} onNext={next} />

      <div className="sb-toolbar">
        <SearchInput value={q} onChange={setQ} placeholder={tr('Find a name, company, phone…')} />
        <div className="sb-filters" role="radiogroup" aria-label={tr('Show')}>
          {FILTERS.map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={filter === k} className={'sb-filter' + (filter === k ? ' is-on' : '')} onClick={() => pickFilter(k)}>{tr(label)}</button>)}
        </div>
        <ul className="sb-legend" aria-label={tr('How hot a card is')}>
          {Object.keys(HEAT).map((k) => <li key={k} className={'is-' + k}><i aria-hidden="true" /><strong>{tr(HEAT[k][0])}</strong> {tr(HEAT[k][1])}</li>)}
        </ul>
        <button type="button" className="sb-icon-btn" onClick={load} aria-label={tr('Refresh')} title={tr('Refresh')}><Glyph name="refresh" /></button>
      </div>

      <div className="sb-lanetabs" role="tablist" aria-label={tr('Lanes')}>
        {LANES.map((l) => (
          <button key={l.key} type="button" role="tab" aria-selected={phoneLane === l.key} className={'sb-lanetab' + (phoneLane === l.key ? ' is-on' : '')} onClick={() => setPhoneLane(l.key)}>
            {tr(l.title)} <span className="sb-count">{lanes[l.key].length}</span>
            {data.counts[l.key].hot > 0 && <span className="sb-hotdot" aria-label={tr('{n} hot', { n: data.counts[l.key].hot })}>{data.counts[l.key].hot}</span>}
          </button>
        ))}
      </div>

      <div className="sb-lanes">
        {LANES.map((l) => (
          <Lane key={l.key} lane={l} cards={lanes[l.key]} info={data.counts[l.key]} hidden={phoneLane !== l.key}
            dragging={dragging} onDrop={drop} onOpen={openSheet} onNext={next} showRep={data.all}
            canDrag={canManage && l.key !== 'customer'} onDrag={setDragging} />
        ))}
      </div>
      {total === 0 && <p className="sb-panel-note">{tr('Nothing on this board yet. Leads given to this rep, and customers they look after, show here.')}</p>}

      <div className="sb-panels">
        <Leaders p={data.progress} meId={own ? data.rep.id : meId} />
        {own && <Badges p={data.progress} hot={hotLeft} />}
        <Earn p={data.progress} />
      </div>

      <Glossary items={[
        [tr('Hot'), tr('A score of 55 and up: act today.')],
        [tr('Warm'), tr('25 to 54: soon, this week.')],
        [tr('On track'), tr('Under 25: nothing urgent.')],
        [tr('Score'), tr('Each card adds up what needs doing, up to 100: a message waiting for a reply (45 and more the longer it waits), a new lead nobody has called (30+), a follow-up date passed (25+) or today (22), an invoice overdue (25+), a won deal not paid (30), a quotation running out (25) or not answered (20+), a customer gone quiet for 45 days (15+), agreeing the price (15), stuck in a stage for 14 days (10+), no next step (10), a big deal (up to 20), a VIP (10) or a referral (5).')],
        [tr('Lanes'), tr('Leads are new enquiries (new, contacted, follow-up). Prospects are real jobs (qualified, quote sent, negotiation, or won and waiting for the money). Customers have paid, and you look after their account.')],
        [tr('Drag and drop'), tr('Drag a lead to the prospects to make it qualified, or a prospect back to the leads for a follow-up. A customer is made by their first payment.')]
      ]} />

      {openCard && (
        <Sheet c={openCard} list={openList} points={data.progress.points} canManage={canManage}
          onClose={() => setOpen(null)} onPick={openSheet} onLog={log} onMove={move} onFull={() => full(openCard)} go={(path) => { setOpen(null); navigate(path); }} />
      )}
      {dialog && dialog.kind === 'new' && settings && <NewLeadDialog settings={settings} people={people} meId={meId} onClose={() => setDialog(null)} onSaved={(l) => { setDialog(null); setToast(tr('Lead {ref} added.', { ref: l.ref })); load(); }} />}
      {dialog && dialog.kind === 'lead' && settings && <LeadDialog leadId={dialog.id} settings={settings} people={people} onClose={() => { setDialog(null); load(); }} onChanged={load} onVisit={(v) => setDialog({ kind: 'visit', visit: v })} />}
      {dialog && dialog.kind === 'visit' && <VisitDialog visit={dialog.visit} people={people} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); load(); }} onDeleted={() => { setDialog(null); load(); }} />}
      {dialog && dialog.kind === 'customer' && <CustomerProfile id={dialog.id} reps={reps} onClose={() => { setDialog(null); load(); }} onChanged={load} />}
      <Confetti burst={burst} />
      <Toast text={toast} onDone={clearToast} />
    </div>
  );
}
