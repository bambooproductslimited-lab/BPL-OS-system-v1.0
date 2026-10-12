import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import Photo from '../../components/Photo';
import { Insights, Section } from '../../components/DashKit';
import { activeIntlLocale, msg, tr } from '../../lib/i18n.jsx';
import { ChannelChips, Glyph, L, MOMENTS, Meter, MkBanner, MkCompanies, MkEmpty, OBJECTIVES, OBJECTIVE_GLYPH, PHASES, PHASE_TONE, Pill, campaignReturn, cedis, dayLabel, short, todayIso, useMkCompany, whole } from './mkKit';

// The marketing department's home (backend mkHome.service.js): the month
// at a glance for the head of marketing — leads against last month, spend
// against the year's budget and its pace, cost per lead, campaigns live,
// posts, requests waiting — what stands out, the campaigns on now as a
// scoreboard, the week ahead, where leads come from, the last 90 days'
// leads by where they got to, and every part of the department one press
// away with what it is for.

export const KIND_WORD = { campaign: msg('Campaign'), post: msg('Post'), event: msg('Event'), promotion: msg('Promotion'), request: msg('Request due'), task: msg('Event task'), holiday: msg('Public holiday'), moment: msg('Marketing moment') };
export function itemTitle(it) {
  if (it.kind === 'moment') return tr(MOMENTS[it.key] || it.key);
  if (it.kind === 'task') return it.title + (it.event ? ' · ' + it.event : '');
  if (it.kind === 'request') return it.ref + ' ' + it.title;
  return it.title;
}
export function itemLink(it) {
  if (it.kind === 'campaign') return '/mkcampaigns?open=' + it.id;
  if (it.kind === 'event') return '/mkevents?open=' + it.id;
  if (it.kind === 'task') return '/mkevents?open=' + it.eventId;
  if (it.kind === 'promotion') return '/mkpromotions?open=' + it.id;
  if (it.kind === 'request') return '/mkrequests?open=' + it.id;
  if (it.kind === 'post') return '/socialtracker?tab=calendar';
  return null;
}

function insightText(i) {
  const v = i.values || {};
  switch (i.kind) {
    case 'requests_late': return v.n === 1 ? tr('1 request to marketing is past the date it was needed by.') : tr('{n} requests to marketing are past the date they were needed by.', { n: v.n });
    case 'requests_new': return v.n === 1 ? tr('1 new request is waiting for someone to take it on.') : tr('{n} new requests are waiting for someone to take them on.', { n: v.n });
    case 'spend_ahead': return tr('{spent} spent this year: ahead of the budget\'s pace ({pace} by now).', { spent: cedis(v.spent), pace: cedis(v.pace) });
    case 'no_budget': return tr('No marketing budget is set for this year yet. Set one to see spending against it.');
    case 'campaign_overdue': return tr('"{name}" is past its end date but not marked finished. Finish it and note what was learned.', { name: v.name });
    case 'campaign_behind': return tr('"{name}" has {leads} of its {target} leads and ends within two weeks.', v);
    case 'campaign_best': return tr('"{name}" is paying back best: a {roi}% return on what it cost.', v);
    case 'posts_late': return v.n === 1 ? tr('1 planned post is past its date and not published.') : tr('{n} planned posts are past their date and not published.', { n: v.n });
    case 'posts_none': return tr('Nothing is published or planned on social media this month.');
    case 'leads_down': return tr('Leads are down: {now} this month against {before} by this time last month.', v);
    case 'leads_up': return tr('Leads are up: {now} this month against {before} by this time last month.', v);
    case 'promos_ending': return v.n === 1 ? tr('1 promotion ends in the next 7 days.') : tr('{n} promotions end in the next 7 days.', { n: v.n });
    case 'event_soon': return v.days === 0 ? tr('"{name}" is today.', v) : tr('"{name}" is in {days} days. Check its checklist.', v);
    default: return '';
  }
}
const INSIGHT_ICON = { bad: 'warn', warn: 'warn', good: 'spark', info: 'info' };
const INSIGHT_ACTION = { mkrequests: msg('Open the requests'), mkbudget: msg('Open the budget'), mkcampaigns: msg('Open it'), socialtracker: msg('Open social & content'), mkpromotions: msg('Open promotions'), mkevents: msg('Open the event') };

const PARTS = [
  ['mkcampaigns', 'target', msg('Campaigns'), msg('Plan each one with a goal, budget and targets; see what it brought in.')],
  ['mkcalendar', 'calendar', msg('Marketing calendar'), msg('Every campaign, post, event, promotion and deadline in one month.')],
  ['socialtracker', 'chat', msg('Social & content'), msg('Posts, followers and messages on every social account.')],
  ['mkrequests', 'inbox', msg('Requests to marketing'), msg('What the company has asked marketing for, and where each is.')],
  ['mkbudget', 'wallet', msg('Budget & spend'), msg('The year\'s budget by category against every cedi spent.')],
  ['mkevents', 'flag', msg('Events'), msg('Fairs, launches and tastings, with their checklists and results.')],
  ['mkpromotions', 'ticket', msg('Promotions & offers'), msg('Codes and offers, how often they were used and what they brought.')],
  ['mkaudiences', 'users', msg('Audiences'), msg('Who to talk to: customers by what they bought and when.')],
  ['mkbrand', 'palette', msg('Brand kit'), msg('Logos, colours, fonts and templates for everyone.')],
  ['mkmarket', 'binoculars', msg('Competitors & market'), msg('Who we compete with, their prices and what they are up to.')]
];

export default function MkHomePage() {
  const { session } = useAuth();
  const mk = useMkCompany();
  const navigate = useNavigate();
  const [h, setH] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!mk.company) return;
    setError(null);
    api.get('/mk/home?company=' + mk.company).then(setH).catch((e) => setError(e.message));
  }, [mk.company]);

  const first = session && session.employee ? session.employee.firstName : '';
  const hour = new Date().getHours();
  const hello = hour < 12 ? tr('Good morning, {name}', { name: first }) : hour < 17 ? tr('Good afternoon, {name}', { name: first }) : tr('Good evening, {name}', { name: first });
  const month = new Date().toLocaleDateString(activeIntlLocale(), { month: 'long', year: 'numeric' });

  if (error) return <div className="dk mk"><MkCompanies mk={mk} /><div className="error-banner">{error}</div></div>;
  if (!h) return <div className="dk mk"><MkCompanies mk={mk} /><p className="eyebrow">{tr('Loading…')}</p></div>;

  const leadsDelta = h.leads.before ? Math.round(((h.leads.month - h.leads.before) / h.leads.before) * 100) : null;
  const ring = h.spend.budget
    ? { value: h.spend.year, max: h.spend.budget, big: h.spend.pct + '%', small: tr('of the year\'s budget'), tone: h.spend.onPace !== null && h.spend.year > h.spend.onPace * 1.1 ? 'hot' : 'good',
      caption: tr('{spent} of {budget}; the year is {through}% gone.', { spent: cedis(h.spend.year), budget: cedis(h.spend.budget), through: h.spend.yearThrough }) }
    : { value: 0, max: 1, big: '—', small: tr('no budget set'), caption: tr('{spent} spent this year.', { spent: cedis(h.spend.year) }) };
  const stats = [
    { glyph: 'magnet', value: whole(h.leads.month), label: h.allLeads ? tr('leads this month') : tr('leads from campaigns this month'),
      note: leadsDelta === null ? tr('nothing to compare with last month') : leadsDelta >= 0 ? tr('{n}% up on last month by now', { n: leadsDelta }) : tr('{n}% down on last month by now', { n: -leadsDelta }),
      tone: leadsDelta !== null && leadsDelta < -20 ? 'alert' : leadsDelta > 0 ? 'good' : '', onClick: () => navigate('/mkcampaigns') },
    { glyph: 'wallet', value: h.costPerLead ? cedis(h.costPerLead) : '—', label: tr('cost per lead'), note: tr('{amount} spent this month', { amount: cedis(h.spend.month) }), onClick: () => navigate('/mkbudget') },
    { glyph: 'target', value: String(h.live), label: tr('campaigns running'), note: h.campaigns.length > h.live ? tr('{n} more planned or paused', { n: h.campaigns.length - h.live }) : tr('nothing else planned'), onClick: () => navigate('/mkcampaigns') },
    { glyph: 'inbox', value: String(h.requests.open), label: tr('requests open'), note: h.requests.late ? tr('{n} past their date', { n: h.requests.late }) : h.requests.fresh ? tr('{n} not taken on yet', { n: h.requests.fresh }) : tr('all on track'),
      tone: h.requests.late ? 'bad' : h.requests.fresh ? 'alert' : '', onClick: () => navigate('/mkrequests') }
  ];
  const insights = (h.insights || []).map((i) => ({
    tone: i.tone, icon: INSIGHT_ICON[i.tone] || 'info', text: insightText(i),
    action: { label: tr(INSIGHT_ACTION[i.link] || 'Open it'), run: () => navigate('/' + i.link + (i.id ? '?open=' + i.id : '')) }
  }));
  if (!insights.length) insights.push({ tone: 'good', icon: 'check', text: tr('Nothing needs attention: requests are on track and spending is on budget.') });
  // Each thing on the day it starts; what is already under way is left out.
  const week = {};
  h.week.forEach((it) => {
    if (it.start < h.today) return;
    (week[it.start] = week[it.start] || []).push(it);
  });
  const weekDays = Object.keys(week).sort().slice(0, 8);
  const srcMax = Math.max(1, ...h.sources.map((s) => s.n));
  const funnel = h.funnel || { leads: 0, prospects: 0, won: 0, lost: 0, total: 0 };
  const fMax = Math.max(1, funnel.total);

  return (
    <div className="dk mk">
      <MkCompanies mk={mk} />
      <MkBanner
        eyebrow={tr('Marketing · {month}', { month })}
        title={first ? hello : tr('Marketing')}
        sub={tr('{company}: how marketing is doing this month, what needs you today and every part of the department one press away.', { company: h.company.name })}
        actions={h.canManage && (
          <>
            <button type="button" className="mk-btn is-primary" onClick={() => navigate('/mkcampaigns?new=1')}><Glyph name="plus" size={16} />{tr('Plan a campaign')}</button>
            <button type="button" className="mk-btn is-ghost" onClick={() => navigate('/mkcalendar')}><Glyph name="calendar" size={16} />{tr('Open the calendar')}</button>
          </>
        )}
        ring={ring} stats={stats} />

      <Insights items={insights} />

      <Section title={tr('Campaigns on now')} sub={tr('Each campaign running, planned or paused: its budget used, its leads against its target, and what it has paid back so far.')}
        action={<Link className="mk-link" to="/mkcampaigns">{tr('All campaigns')} <Glyph name="arrowR" size={14} /></Link>}>
        {h.campaigns.length ? (
          <div className="mk-grid">
            {h.campaigns.slice(0, 6).map((c) => <CampaignMini key={c.id} c={c} onOpen={() => navigate('/mkcampaigns?open=' + c.id)} />)}
          </div>
        ) : <MkEmpty glyph="target" title={tr('No campaign on')} action={h.canManage && <button type="button" className="mk-btn is-primary" onClick={() => navigate('/mkcampaigns?new=1')}>{tr('Plan a campaign')}</button>}>{tr('A campaign is a push with one goal: a launch, a season, more leads for one product. Plan it here and the OS keeps its score.')}</MkEmpty>}
      </Section>

      <div className="mk-two">
        <Section card title={tr('The week ahead')} sub={tr('The next 7 days: posts, events, promotions starting, requests due and the year\'s moments.')}
          action={<Link className="mk-link" to="/mkcalendar">{tr('Calendar')} <Glyph name="arrowR" size={14} /></Link>}>
          {weekDays.length ? (
            <div className="mk-agenda">
              {weekDays.map((d) => (
                <div key={d} className="mk-agenda-day">
                  <h4>{d === h.today ? tr('Today') : dayLabel(d, { weekday: 'long' })}<small>{dayLabel(d)}</small></h4>
                  <div className="mk-chips" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                    {week[d].map((it, i) => {
                      const link = itemLink(it);
                      return (
                        <button key={i} type="button" className={'mk-cal-item mk-k-' + it.kind + (it.status === 'done' ? ' is-done' : '')} onClick={() => link && navigate(link)} disabled={!link}>
                          <span>{tr(KIND_WORD[it.kind])}: {itemTitle(it)}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : <p className="mk-muted">{tr('Nothing on the calendar for the next 7 days.')}</p>}
        </Section>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Section card title={tr('Where leads came from')} sub={h.allLeads ? tr('The last 90 days, by the source on each lead.') : tr('The last 90 days, leads credited to this company\'s campaigns.')}>
            {h.sources.length ? (
              <div className="mk-sources">
                {h.sources.map((s) => (
                  <div key={s.source} className="mk-source">
                    <span title={s.source}>{s.source === 'Not recorded' ? tr('Not recorded') : s.source}</span>
                    <Meter value={s.n} max={srcMax} />
                    <span>{s.n}</span>
                  </div>
                ))}
              </div>
            ) : <p className="mk-muted">{tr('No leads in the last 90 days.')}</p>}
          </Section>
          <Section card title={tr('Where those leads got to')} sub={tr('The last 90 days\' leads by the stage they are at now.')}>
            <div className="mk-funnel">
              {[[tr('Still leads'), funnel.leads], [tr('Prospects (quoted)'), funnel.prospects], [tr('Won'), funnel.won], [tr('Lost'), funnel.lost]].map(([label, n]) => (
                <div key={label} className="mk-funnel-row"><span>{label}</span><span className="mk-funnel-bar"><i style={{ width: Math.round((n / fMax) * 100) + '%' }} /></span><span>{n}</span></div>
              ))}
            </div>
          </Section>
        </div>
      </div>

      <div className="mk-facts">
        <span className="mk-fact"><small>{tr('Posts published')}</small><strong>{h.posts.published}</strong><em>{tr('{n} more planned this month', { n: h.posts.planned })}</em></span>
        <span className="mk-fact"><small>{tr('People reached')}</small><strong>{short(h.posts.reach)}</strong><em>{tr('by this month\'s posts')}</em></span>
        <span className={'mk-fact' + (h.followers.now > h.followers.before ? ' is-good' : '')}><small>{tr('Followers')}</small><strong>{short(h.followers.now)}</strong>
          <em>{h.followers.before ? tr('{n} more than a month ago', { n: whole(h.followers.now - h.followers.before) }) : tr('on {n} accounts', { n: h.followers.channels })}</em></span>
        <span className="mk-fact"><small>{tr('Promotions running')}</small><strong>{h.promotions.running}</strong><em>{h.promotions.ending ? tr('{n} ending this week', { n: h.promotions.ending }) : tr('none ending this week')}</em></span>
        <span className="mk-fact"><small>{tr('Next event')}</small><strong>{h.nextEvent ? dayLabel(h.nextEvent.startsOn) : '—'}</strong><em>{h.nextEvent ? h.nextEvent.name : tr('none planned')}</em></span>
      </div>

      <Section title={tr('The department')} sub={tr('Every part of marketing, and what it is for.')}>
        <div className="mk-quick">
          {PARTS.map(([key, glyph, title, body]) => (
            <Link key={key} to={'/' + key} className="mk-q">
              <span className="mk-icon"><Glyph name={glyph} size={18} /></span>
              <span><strong>{tr(title)}</strong><small>{tr(body)}</small></span>
              {key === 'mkrequests' && h.requests.fresh > 0 && <b>{h.requests.fresh}</b>}
            </Link>
          ))}
        </div>
      </Section>
    </div>
  );
}

// A campaign as a small scoreboard card (home and the campaigns page).
export function CampaignMini({ c, onOpen }) {
  const r = c.results || {};
  const today = todayIso();
  const span = c.startDate && c.endDate ? Math.max(1, (new Date(c.endDate) - new Date(c.startDate)) / 86400000) : null;
  const done = span ? Math.min(1, Math.max(0, (new Date(today) - new Date(c.startDate)) / 86400000 / span)) : null;
  const ret = campaignReturn(c);
  return (
    <button type="button" className={'mk-card mk-camp is-' + c.objective} onClick={onOpen}>
      <div className="mk-card-head">
        <span className="mk-row">
          <span className="mk-icon"><Glyph name={OBJECTIVE_GLYPH[c.objective]} size={18} /></span>
          <span className="mk-fill"><h3 className="mk-card-title">{c.name}</h3><span className="mk-card-sub">{L(OBJECTIVES, c.objective)}</span></span>
        </span>
        <Pill tone={PHASE_TONE[c.phase]}>{L(PHASES, c.phase)}</Pill>
      </div>
      {done !== null && <span className="mk-timeline" title={tr('How far through its dates')}><i style={{ width: Math.round(done * 100) + '%' }} /></span>}
      <span className="mk-card-sub">{c.startDate || c.endDate ? [dayLabel(c.startDate), dayLabel(c.endDate)].join(' – ') : tr('No dates yet')}{c.code ? ' · ' + tr('code {code}', { code: c.code }) : ''}</span>
      <div className="mk-camp-nums">
        <span className="mk-camp-num"><small>{tr('Spent')}</small><strong>{short(r.spend)}</strong></span>
        <span className="mk-camp-num"><small>{tr('Leads')}</small><strong>{r.leads}{c.targetLeads ? ' / ' + c.targetLeads : ''}</strong></span>
        <span className="mk-camp-num" title={ret.note}><small>{ret.label}</small><strong className={'mk-roi' + (ret.tone ? ' is-' + ret.tone : '')}>{ret.value}</strong></span>
      </div>
      {c.budget > 0 && <Meter value={r.spend} max={c.budget} tone={r.spend > c.budget ? 'bad' : ''} label={tr('{spent} of {budget} budget', { spent: cedis(r.spend), budget: cedis(c.budget) })} />}
      <span className="mk-row">
        <ChannelChips list={c.channels.slice(0, 4)} />
        <span className="mk-fill" />
        {c.owner && <Photo id={c.owner.id} name={c.owner.name} photo={c.owner.photo} size={26} />}
      </span>
    </button>
  );
}
