import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { money, moneyBreakdown } from '../lib/currency';
import { tr, activeIntlLocale } from '../lib/i18n.jsx';
import { CompanySwitcher, Empty, Glossary, Insights, LinkButton, Section, fmtDate, jump, pctChange } from '../components/DashKit';
import { accentStyle, companyOrder } from './CompaniesFun';
import { Activity, Arrivals, Celebrations, GroupCard, OvBanner, OvTile, PeopleCard, RestaurantCard, WaitTile, WeekTrend, skyOf } from './DashboardFun';
import './DashboardFun.css';

// The OS overview (GET /api/dashboard): a morning briefing that explains
// itself, with some fun in it. Every company together by default, or one
// company at a time from the switcher (?company=SB, remembered on this
// device). A banner whose sky follows the time of day, with today's people
// as a ring; four number tiles; "what stands out" written from today's
// figures; how the morning's arrivals went and the last seven days; a card
// per group; who came in late, who has not clocked in, who is away and
// who is off soon; birthdays, work anniversaries and new joiners; the
// restaurants' takings through the day; what is waiting across the
// business; and the latest activity. Everything is only what the person
// may see.

const COMPANY_KEY = 'bos.overviewCompany';
function initialCompany() {
  const q = new URLSearchParams(window.location.search).get('company');
  if (q) return q.toUpperCase();
  try { return localStorage.getItem(COMPANY_KEY) || 'ALL'; } catch { return 'ALL'; }
}

function greeting(now) {
  const h = now.getHours();
  if (h < 12) return tr('Good morning');
  if (h < 17) return tr('Good afternoon');
  return tr('Good evening');
}
function fmtToday() {
  return new Date().toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long' });
}
function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return tr('just now');
  if (mins < 60) return tr('{mins}m ago', { mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return tr('{hours}h ago', { hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return tr('{days}d ago', { days });
  return new Date(iso).toLocaleDateString(activeIntlLocale(), { day: '2-digit', month: 'short' });
}
function lastWeekday() {
  return new Date(Date.now() - 7 * 86400000).toLocaleDateString(activeIntlLocale(), { weekday: 'long' });
}
function dayMonth(iso) {
  return new Date(iso + 'T12:00').toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long' });
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const [company, setCompany] = useState(initialCompany);
  const [dash, setDash] = useState(null);
  const [lateAfter, setLateAfter] = useState('08:15');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async () => {
    setError(null);
    try {
      setDash(await api.get('/dashboard?company=' + encodeURIComponent(company)));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [company]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  // /settings also carries integration API keys, so it's gated behind
  // employee.read; the overview now brings the "late after" time itself,
  // and this is only the fallback for an older server.
  useEffect(() => {
    api.get('/settings').then((s) => { if (s.lateAfter) setLateAfter(s.lateAfter); }).catch(() => {});
  }, []);

  function pick(code) {
    if (code === company) return;
    setLoading(true);
    setCompany(code);
    try { localStorage.setItem(COMPANY_KEY, code); } catch { /* remembered for this visit only */ }
    window.history.replaceState({}, '', window.location.pathname + (code !== 'ALL' ? '?company=' + code : ''));
  }

  const choices = dash && dash.companies.length > 1
    ? [{ code: 'ALL', name: tr('All companies'), kind: 'all' }, ...dash.companies]
    : [];
  const switcher = (
    <CompanySwitcher companies={choices} company={dash ? dash.company.code : company} onPick={pick}
      describe={(co) => (co.kind === 'all' ? tr('Everything together') : co.kind === 'restaurant' ? tr('Restaurant') : tr('Company'))} />
  );

  if (loading && !dash) return <div className="eyebrow">{tr('Loading…')}</div>;
  if (!dash) return <div className="error-banner">{error}</div>;

  const d = dash;
  const late = d.lateAfter || lateAfter;
  const arrivals = d.arrivals || [];
  const week = d.week || [];
  const firstName = session && session.employee ? session.employee.firstName : '';
  const scopeName = d.company.code === 'ALL' ? tr('the business') : d.company.name;
  // People, not clock-ins: someone on two shifts counts once.
  const inNow = d.arrivals ? arrivals.length : d.presentToday;
  const rate = d.headcount ? Math.round((inNow / d.headcount) * 100) : 0;
  const waiting = d.approvalQueue + (d.pendingLeave || 0);
  const lowestGroup = d.departments.filter((g) => g.headcount >= 3).sort((a, b) => a.rate - b.rate)[0];
  const showCompany = d.company.code === 'ALL' && d.companies.length > 1;
  const crowd = d.headcount > 1;
  const sky = skyOf(now);
  const finance = '/financedash' + (d.company.code !== 'ALL' ? '?company=' + d.company.code : '');

  // Each company keeps its colour (the Companies page's order).
  const accents = {};
  companyOrder(d.companies).forEach((c, i) => { accents[c.code] = accentStyle(i); });

  const insights = [];
  if (crowd) {
    insights.push({ tone: rate >= 90 ? 'good' : rate < 70 ? 'warn' : 'info', icon: 'people', text: tr('{present} of {headcount} people have clocked in today ({rate}%).', { present: inNow, headcount: d.headcount, rate }) });
  }
  if (d.lateToday) {
    insights.push({ tone: 'warn', icon: 'clock', text: d.lateToday === 1 ? tr('1 person came in late today.') : tr('{n} people came in late today.', { n: d.lateToday }), action: { label: tr('See who'), run: () => jump('ov-late') } });
  }
  if (lowestGroup && lowestGroup.rate < 80 && d.departments.length > 1) {
    insights.push({ tone: 'warn', icon: 'people', text: tr('{group} has the lowest attendance today: {rate}% ({present} of {headcount}).', { group: lowestGroup.name, rate: lowestGroup.rate, present: lowestGroup.present, headcount: lowestGroup.headcount }) });
  }
  if (d.approvalQueue) {
    insights.push({ tone: 'warn', icon: 'check', text: d.approvalQueue === 1 ? tr('1 item is waiting for your approval.') : tr('{n} items are waiting for your approval.', { n: d.approvalQueue }), action: { label: tr('Open approvals'), run: () => navigate('/approvals') } });
  }
  if (d.pendingLeave) {
    insights.push({ tone: 'info', icon: 'calendar', text: d.pendingLeave === 1 ? tr('1 leave request is waiting for a decision.') : tr('{n} leave requests are waiting for a decision.', { n: d.pendingLeave }), action: { label: tr('Open leave'), run: () => navigate('/leave') } });
  }
  if (d.myOverdueTasks) {
    insights.push({ tone: 'bad', icon: 'doc', text: d.myOverdueTasks === 1 ? tr('1 of your work orders is past its due date.') : tr('{n} of your work orders are past their due date.', { n: d.myOverdueTasks }), action: { label: tr('Open work orders'), run: () => navigate('/tasks') } });
  }
  if (d.overdueInvoices) {
    insights.push({ tone: 'bad', icon: 'warn', text: d.overdueInvoices === 1 ? tr('1 invoice is overdue.') : tr('{n} invoices are overdue.', { n: d.overdueInvoices }), action: { label: tr('Finance dashboard'), run: () => navigate(finance) } });
  }
  (d.restaurants || []).forEach((r) => {
    if (r.salesToday) {
      const pct = pctChange(r.salesToday, r.salesSameDayLastWeek);
      insights.push({ tone: 'info', icon: 'cash', text: pct === null
        ? tr('{name} has taken {amount} today from {n} orders.', { name: r.name, amount: money(r.salesToday, d.currency), n: r.ordersToday })
        : tr('{name} has taken {amount} today from {n} orders, {pct}% against last {day}.', { name: r.name, amount: money(r.salesToday, d.currency), n: r.ordersToday, pct: (pct > 0 ? '+' : '') + pct, day: lastWeekday() }) });
    }
    if (r.expiringSoon) {
      insights.push({ tone: 'warn', icon: 'warn', text: tr('{name}: {n} ingredient(s) expire within 3 days.', { name: r.name, n: r.expiringSoon }), action: { label: tr('Open restaurants'), run: () => navigate('/restaurant') } });
    }
  });
  if (d.lowStockCount) {
    insights.push({ tone: 'warn', icon: 'bag', text: d.lowStockCount === 1 ? tr('1 product is at or below its reorder level.') : tr('{n} products are at or below their reorder level.', { n: d.lowStockCount }), action: { label: tr('Open inventory'), run: () => navigate('/inventory') } });
  }
  const todayCele = (d.celebrations || []).filter((c) => c.daysTo === 0 && !c.me);
  if (todayCele.length) {
    const c = todayCele[0];
    insights.push({ tone: 'good', icon: 'spark', text: c.kind === 'birthday' ? tr('It is {name}\'s birthday today. Say happy birthday!', { name: c.name }) : tr('{name} has been with us {n} years today.', { name: c.name, n: c.years }), action: { label: tr('See celebrations'), run: () => jump('ov-cele') } });
  }

  const tiles = [];
  if (d.lowStockCount != null) tiles.push({ key: 'stock', icon: 'bag', value: d.lowStockCount, label: tr('Products to reorder'), help: tr('Bamboo Products stock at or below its reorder level.'), route: '/inventory', alert: d.lowStockCount > 0 });
  (d.restaurants || []).forEach((r) => tiles.push({ key: 'r-' + r.code, icon: 'bag', value: r.lowStock, label: tr('{name}: kitchen stock to reorder', { name: r.name }), help: r.expiringSoon ? tr('{n} ingredient(s) expire within 3 days.', { n: r.expiringSoon }) : tr('Ingredients and supplies at or below their reorder level.'), route: '/restaurant', alert: r.lowStock > 0 || r.expiringSoon > 0 }));
  if (d.pendingProcurement != null) tiles.push({ key: 'proc', icon: 'receipt', value: d.pendingProcurement, label: tr('Purchase requests waiting'), help: tr('Requests to buy something, waiting for a decision.'), route: '/procurement', alert: d.pendingProcurement > 0 });
  if (d.pendingExpenses != null) tiles.push({ key: 'exp', icon: 'receipt', value: d.pendingExpenses, label: tr('Expense claims waiting'), help: tr('Staff waiting to be paid back.'), route: '/expenses', alert: d.pendingExpenses > 0 });
  if (d.assetsDueService != null) tiles.push({ key: 'assets', icon: 'clock', value: d.assetsDueService, label: tr('Assets due for service'), help: tr('Machines and vehicles due within 7 days.'), route: '/assets', alert: d.assetsDueService > 0 });
  if (d.outstandingInvoices != null && d.company.kind !== 'restaurant') tiles.push({ key: 'inv', icon: 'owed', value: moneyBreakdown(d.outstandingInvoices, money(0, d.currency)), label: tr('Owed by customers'), help: d.overdueInvoices ? tr('{n} invoice(s) overdue.', { n: d.overdueInvoices }) : tr('Nothing overdue.'), route: '/invoices', alert: d.overdueInvoices > 0 });

  // The four numbers under the banner.
  const restaurantHere = d.company.kind === 'restaurant' && d.restaurants && d.restaurants[0];
  const cele = d.celebrations || [];
  const stats = [
    { icon: 'check', value: String(waiting), label: tr('waiting for you'), note: tr('{a} approvals · {l} leave requests', { a: d.approvalQueue, l: d.pendingLeave || 0 }), tone: waiting ? 'warn' : 'good', onClick: () => navigate('/approvals') },
    { icon: 'doc', value: String(d.myOpenTasks), label: tr('your open work orders'), note: d.myOverdueTasks ? tr('{n} overdue', { n: d.myOverdueTasks }) : d.myTasksDueToday ? tr('{n} due today', { n: d.myTasksDueToday }) : tr('nothing overdue'),
      ring: d.myOpenTasks ? (d.myOpenTasks - d.myOverdueTasks) / d.myOpenTasks : null, tone: d.myOverdueTasks ? 'bad' : 'info', onClick: () => navigate('/tasks') }
  ];
  if (restaurantHere) {
    const pct = pctChange(restaurantHere.salesToday, restaurantHere.salesSameDayLastWeek);
    stats.push({ icon: 'cash', value: money(restaurantHere.salesToday, d.currency), label: tr('sales today'), note: pct === null ? tr('{n} orders today', { n: restaurantHere.ordersToday }) : tr('{pct}% against last {day}', { pct: (pct > 0 ? '+' : '') + pct, day: lastWeekday() }), tone: 'money', onClick: () => jump('ov-rest') });
  } else if (d.outstandingInvoices != null) {
    stats.push({ icon: 'owed', value: moneyBreakdown(d.outstandingInvoices, money(0, d.currency)), label: tr('owed by customers'), note: d.overdueInvoices ? tr('{n} invoice(s) overdue', { n: d.overdueInvoices }) : tr('nothing overdue'), tone: d.overdueInvoices ? 'bad' : 'money', onClick: () => navigate(finance) });
  }
  stats.push({ icon: 'calendar', value: String(d.onLeaveToday), label: tr('away on leave'), note: d.upcomingLeave.length ? tr('{n} more in the next 7 days', { n: d.upcomingLeave.length }) : tr('nobody else in the next 7 days'), tone: 'leave', onClick: () => jump('ov-away') });
  if (stats.length < 4) {
    stats.push({ icon: 'spark', value: String(cele.length + (d.newJoiners || []).length), label: tr('celebrations this week'), note: tr('birthdays, work anniversaries and new faces'), tone: 'party', onClick: () => jump('ov-cele') });
  }

  const onTime = Math.max(0, inNow - d.lateToday);
  const absent = Math.max(0, d.headcount - inNow - d.onLeaveToday - d.notClockedIn);
  const pulse = crowd ? {
    total: d.headcount,
    center: inNow + '/' + d.headcount,
    caption: tr('in today'),
    parts: [
      { key: 'ontime', label: tr('On time'), n: onTime },
      { key: 'late', label: tr('Late'), n: d.lateToday, onClick: () => jump('ov-late') },
      { key: 'away', label: tr('On leave'), n: d.onLeaveToday, onClick: () => jump('ov-away') },
      { key: 'notin', label: tr('Not in yet'), n: d.notClockedIn, onClick: () => jump('ov-notin') },
      ...(absent ? [{ key: 'absent', label: tr('Marked absent'), n: absent }] : [])
    ]
  } : null;
  const mySide = (
    <div className="ovx-myday">
      <strong>{d.myOpenTasks}</strong>
      <span>{tr('your open work orders')}{d.myTasksDueToday ? ' · ' + tr('{n} due today', { n: d.myTasksDueToday }) : ''}</span>
      <button type="button" className="ovx-hero-btn" onClick={() => navigate('/myspace')}>{tr('Open My Space')}</button>
    </div>
  );

  const celeItems = [
    ...cele.map((c) => ({
      key: c.kind + c.id, glyph: c.kind === 'birthday' ? 'cake' : 'medal', tone: c.kind === 'birthday' ? 'birthday' : 'years', person: c, days: c.daysTo,
      title: c.kind === 'birthday' ? (c.me ? tr('Your birthday') : tr('Birthday')) : (c.years === 1 ? tr('1 year with us') : tr('{n} years with us', { n: c.years })),
      when: dayMonth(c.date) + (c.department ? ' · ' + c.department : '')
    })),
    ...(d.newJoiners || []).map((p) => ({
      key: 'new' + p.id, glyph: 'wave', tone: 'new', person: p, days: null,
      title: tr('New: say welcome!'), when: [p.title, p.department].filter(Boolean).join(' · ') + ' · ' + tr('joined {date}', { date: fmtDate(p.hireDate) })
    }))
  ];

  const nowHour = now.getHours();

  return (
    <div className="dk ovx">
      {error && <div className="error-banner" role="alert">{error}</div>}
      {switcher}

      <OvBanner sky={sky} now={now} me={d.me}
        eyebrow={fmtToday() + ' · ' + (d.company.code === 'ALL' ? tr('All companies') : d.company.name)}
        title={greeting(now) + (firstName ? ', ' + firstName : '')}
        sub={tr('Here is how {scope} is doing today: who is in, what is waiting for you, and what needs attention.', { scope: scopeName })}
        online={d.online} onOnline={() => navigate('/messages')}
        announcement={d.latestAnnouncement} onAnnouncement={() => navigate('/announcements')}
        pulse={pulse} side={mySide} />

      <div className="ovx-tiles">{stats.map((t, i) => <OvTile key={i} {...t} />)}</div>

      <Insights items={insights.slice(0, 9)} />

      {crowd && (
        <Section id="ov-people" title={tr('How today is going')} sub={tr('When people arrived this morning, and the last seven days.')}
          action={<LinkButton onClick={() => navigate('/attendance')}>{tr('Open attendance')}</LinkButton>}>
          <div className="ovx-two">
            <div className="ovx-card">
              <h4 className="ovx-h4">{tr('This morning\'s arrivals')}</h4>
              <Arrivals arrivals={arrivals} lateAfter={late} firstIn={d.firstInToday} />
            </div>
            <div className="ovx-card">
              <h4 className="ovx-h4">{tr('The last seven days')}</h4>
              <WeekTrend week={week} headcount={d.headcount} today={d.today} />
            </div>
          </div>
        </Section>
      )}

      <Section id="ov-groups" title={tr('Groups today')} sub={tr('Each group\'s share in today, lowest first. Press a group to see its people.')}>
        {d.departments.length ? (
          <div className="ovx-groups">
            {d.departments.slice().sort((a, b) => a.rate - b.rate || a.name.localeCompare(b.name)).map((g) => (
              <GroupCard key={g.companyCode + g.code} g={g} accent={accents[g.companyCode]} showCompany={showCompany} onOpen={() => navigate('/people?company=' + encodeURIComponent(g.companyCode) + (g.id ? '&department=' + encodeURIComponent(g.id) : ''))} />
            ))}
          </div>
        ) : <Empty icon="people">{tr('No group attendance is visible to your role. Your own record is on My Space.')}</Empty>}
      </Section>

      {crowd && (
        <div className="ovx-boards">
          <PeopleCard id="ov-late" tone="late" icon="clock" title={tr('Came in late')} sub={tr('After their start time ({time} unless they have their own shift).', { time: late })}
            rows={d.lateList.map((p) => ({ ...p, meta: p.department, side: p.clockIn + (p.shiftStart ? ' · ' + tr('starts {time}', { time: p.shiftStart }) : ''), sideTone: 'late' }))}
            more={Math.max(0, d.lateToday - d.lateList.length)} empty={tr('Nobody was late today.')} />
          <PeopleCard id="ov-notin" tone="notin" icon="eye" title={tr('Not clocked in yet')} sub={tr('Not on leave and not clocked in. Some may simply start later.')}
            rows={d.notClockedInList.map((p) => ({ ...p, meta: p.department, side: p.shiftStart ? tr('starts {time}', { time: p.shiftStart }) : '' }))}
            more={Math.max(0, d.notClockedIn - d.notClockedInList.length)} empty={tr('Everyone expected today has clocked in.')} />
          <PeopleCard id="ov-away" tone="away" icon="calendar" title={tr('Away today')} sub={tr('On approved leave.')}
            rows={d.onLeaveList.map((p) => ({ ...p, meta: [p.department, p.type].filter(Boolean).join(' · '), side: p.until === d.today ? tr('back tomorrow') : tr('until {date}', { date: fmtDate(p.until) }) }))}
            empty={tr('Nobody is on leave today.')} />
          <PeopleCard tone="soon" icon="send" title={tr('Leave coming up')} sub={tr('Starting in the next 7 days, so cover can be planned.')}
            rows={d.upcomingLeave.map((p) => ({ ...p, meta: [p.department, p.type].filter(Boolean).join(' · '), side: fmtDate(p.from) + ' – ' + fmtDate(p.until) }))}
            empty={tr('No leave starts in the next 7 days.')} />
        </div>
      )}

      {celeItems.length > 0 && (
        <Section id="ov-cele" title={tr('Celebrations and new faces')} sub={tr('Birthdays and work anniversaries in the next 7 days, and who joined in the last 30.')}>
          <Celebrations items={celeItems} />
        </Section>
      )}

      {d.restaurants && d.restaurants.length > 0 && (
        <Section id="ov-rest" title={tr('Restaurants today')} sub={tr('What each till has taken so far today, hour by hour, against the same day last week.')}
          action={<LinkButton onClick={() => navigate('/restaurant')}>{tr('Open restaurants')}</LinkButton>}>
          <div className="ovx-rests">
            {d.restaurants.map((r) => (
              <RestaurantCard key={r.code} r={r} currency={d.currency} lastDay={lastWeekday()} nowHour={nowHour}
                change={pctChange(r.salesToday, r.salesSameDayLastWeek)} onOpen={() => navigate('/financedash?company=' + r.code)} />
            ))}
          </div>
        </Section>
      )}

      {tiles.length > 0 && (
        <Section title={tr('Waiting across the business')} sub={tr('Things that need someone to act. Press one to open it.')}>
          <div className="ovx-waits">
            {tiles.slice().sort((a, b) => (b.alert ? 1 : 0) - (a.alert ? 1 : 0)).map((t) => <WaitTile key={t.key} t={t} onOpen={() => navigate(t.route)} />)}
          </div>
        </Section>
      )}

      {d.recentAudit.length > 0 && (
        <Section card title={tr('Latest activity')} sub={tr('The most recent changes made in the OS.')}>
          <Activity logs={d.recentAudit} ago={timeAgo} />
        </Section>
      )}

      <Glossary items={[
        [tr('In today'), tr('People who have clocked in today, out of everyone you can see.')],
        [tr('Late'), tr('Clocked in after their start time: {time}, or their own shift start if they have one.', { time: late })],
        [tr('Not clocked in yet'), tr('Not on leave and no clock-in today. Night-shift and later-shift staff show here until they arrive.')],
        [tr('First in today'), tr('Whoever clocked in earliest today, of everyone you can see.')],
        [tr('Online now'), tr('Others with the OS open in the last two minutes.')],
        [tr('Waiting for you'), tr('Approvals in your queue (leave, expenses, purchases) and leave requests you can decide.')],
        [tr('Reorder level'), tr('The stock level at which more should be ordered.')],
        [tr('All companies'), tr('Every company you can see, together. Pick a company at the top to see only its people and figures.')]
      ]} />
    </div>
  );
}
