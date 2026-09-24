import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { money, moneyBreakdown } from '../lib/currency';
import { tr, activeIntlLocale } from '../lib/i18n.jsx';
import {
  CompanySwitcher, Empty, Glossary, Hero, Icon, Insights, LinkButton, Row, Section,
  avatarColor, fmtDate, initials, jump, pctChange
} from '../components/DashKit';
import './DashboardPage.css';

// The OS overview (GET /api/dashboard): a morning briefing that explains
// itself, in the language of the finance and marketing dashboards. Every
// company together by default, or one company at a time from the switcher
// (?company=SB, remembered on this device). Leads with a greeting and four
// numbers, then "what stands out" written from today's figures, today's
// people (by group, who came in late, who has not clocked in, who is
// away), the restaurants' tills, what is waiting across the business, and
// the latest activity. Everything is only what the person may see.

const COMPANY_KEY = 'bos.overviewCompany';
function initialCompany() {
  const q = new URLSearchParams(window.location.search).get('company');
  if (q) return q.toUpperCase();
  try { return localStorage.getItem(COMPANY_KEY) || 'ALL'; } catch { return 'ALL'; }
}

function greeting() {
  const h = new Date().getHours();
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

function Person({ name }) {
  return <span className="dk-avatar" style={{ background: avatarColor(name) }} aria-hidden="true">{initials(name)}</span>;
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const [company, setCompany] = useState(initialCompany);
  const [dash, setDash] = useState(null);
  const [lateAfter, setLateAfter] = useState('08:15');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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

  // /settings also carries integration API keys, so it's gated behind
  // employee.read (unlike /dashboard, which anyone signed in can load) — a
  // viewer without it just keeps the default lateAfter.
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
  const firstName = session && session.employee ? session.employee.firstName : '';
  const scopeName = d.company.code === 'ALL' ? tr('the business') : d.company.name;
  const rate = d.headcount ? Math.round((d.presentToday / d.headcount) * 100) : 0;
  const waiting = d.approvalQueue + (d.pendingLeave || 0);
  const lowestGroup = d.departments.filter((g) => g.headcount >= 3).sort((a, b) => a.rate - b.rate)[0];
  const showCompany = d.company.code === 'ALL' && d.companies.length > 1;

  const insights = [];
  if (d.headcount > 1) {
    insights.push({ tone: rate >= 90 ? 'good' : rate < 70 ? 'warn' : 'info', icon: 'people', text: tr('{present} of {headcount} people have clocked in today ({rate}%).', { present: d.presentToday, headcount: d.headcount, rate }) });
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
    insights.push({ tone: 'bad', icon: 'doc', text: d.myOverdueTasks === 1 ? tr('1 of your tasks is past its due date.') : tr('{n} of your tasks are past their due date.', { n: d.myOverdueTasks }), action: { label: tr('Open tasks'), run: () => navigate('/tasks') } });
  }
  if (d.overdueInvoices) {
    insights.push({ tone: 'bad', icon: 'warn', text: d.overdueInvoices === 1 ? tr('1 invoice is overdue.') : tr('{n} invoices are overdue.', { n: d.overdueInvoices }), action: { label: tr('Finance dashboard'), run: () => navigate('/financedash' + (d.company.code !== 'ALL' ? '?company=' + d.company.code : '')) } });
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

  const tiles = [];
  if (d.lowStockCount != null) tiles.push({ key: 'stock', icon: 'bag', value: d.lowStockCount, label: tr('Products to reorder'), help: tr('Bamboo Products stock at or below its reorder level.'), route: '/inventory', alert: d.lowStockCount > 0 });
  (d.restaurants || []).forEach((r) => tiles.push({ key: 'r-' + r.code, icon: 'bag', value: r.lowStock, label: tr('{name}: kitchen stock to reorder', { name: r.name }), help: r.expiringSoon ? tr('{n} ingredient(s) expire within 3 days.', { n: r.expiringSoon }) : tr('Ingredients and supplies at or below their reorder level.'), route: '/restaurant', alert: r.lowStock > 0 || r.expiringSoon > 0 }));
  if (d.pendingProcurement != null) tiles.push({ key: 'proc', icon: 'receipt', value: d.pendingProcurement, label: tr('Purchase requests waiting'), help: tr('Requests to buy something, waiting for a decision.'), route: '/procurement', alert: d.pendingProcurement > 0 });
  if (d.pendingExpenses != null) tiles.push({ key: 'exp', icon: 'receipt', value: d.pendingExpenses, label: tr('Expense claims waiting'), help: tr('Staff waiting to be paid back.'), route: '/expenses', alert: d.pendingExpenses > 0 });
  if (d.assetsDueService != null) tiles.push({ key: 'assets', icon: 'clock', value: d.assetsDueService, label: tr('Assets due for service'), help: tr('Machines and vehicles due within 7 days.'), route: '/assets', alert: d.assetsDueService > 0 });
  if (d.outstandingInvoices != null && d.company.kind !== 'restaurant') tiles.push({ key: 'inv', icon: 'owed', value: moneyBreakdown(d.outstandingInvoices, money(0, d.currency)), label: tr('Owed by customers'), help: d.overdueInvoices ? tr('{n} invoice(s) overdue.', { n: d.overdueInvoices }) : tr('Nothing overdue.'), route: '/invoices', alert: d.overdueInvoices > 0 });

  const restaurantHere = d.company.kind === 'restaurant' && d.restaurants && d.restaurants[0];
  const stats = [
    d.headcount
      ? { icon: 'people', value: d.presentToday + '/' + d.headcount, label: tr('in today'), note: d.lateToday ? tr('{rate}% · {n} late', { rate, n: d.lateToday }) : tr('{rate}% of people', { rate }), onClick: () => jump('ov-people') }
      : { icon: 'people', value: '—', label: tr('in today'), note: tr('no staff here that you can see') },
    { icon: 'check', value: String(waiting), label: tr('waiting for you'), note: tr('{a} approvals · {l} leave requests', { a: d.approvalQueue, l: d.pendingLeave || 0 }), tone: waiting ? 'alert' : '', onClick: () => navigate('/approvals') },
    { icon: 'doc', value: String(d.myOpenTasks), label: tr('your open tasks'), note: d.myOverdueTasks ? tr('{n} overdue', { n: d.myOverdueTasks }) : d.myTasksDueToday ? tr('{n} due today', { n: d.myTasksDueToday }) : tr('nothing overdue'), tone: d.myOverdueTasks ? 'bad' : '', onClick: () => navigate('/tasks') }
  ];
  if (restaurantHere) {
    const pct = pctChange(restaurantHere.salesToday, restaurantHere.salesSameDayLastWeek);
    stats.push({ icon: 'cash', value: money(restaurantHere.salesToday, d.currency), label: tr('sales today'), note: pct === null ? tr('{n} orders today', { n: restaurantHere.ordersToday }) : tr('{pct}% against last {day}', { pct: (pct > 0 ? '+' : '') + pct, day: lastWeekday() }), onClick: () => navigate('/financedash?company=' + restaurantHere.code) });
  } else if (d.outstandingInvoices != null) {
    stats.push({ icon: 'owed', value: moneyBreakdown(d.outstandingInvoices, money(0, d.currency)), label: tr('owed by customers'), note: d.overdueInvoices ? tr('{n} invoice(s) overdue', { n: d.overdueInvoices }) : tr('nothing overdue'), tone: d.overdueInvoices ? 'bad' : '', onClick: () => navigate('/financedash' + (d.company.code !== 'ALL' ? '?company=' + d.company.code : '')) });
  } else {
    stats.push({ icon: 'calendar', value: String(d.onLeaveToday), label: tr('away on leave'), note: d.upcomingLeave.length ? tr('{n} more in the next 7 days', { n: d.upcomingLeave.length }) : tr('today'), onClick: () => jump('ov-away') });
  }

  return (
    <div className="dk ov">
      {error && <div className="error-banner" role="alert">{error}</div>}
      {switcher}

      <Hero eyebrow={fmtToday()} title={greeting() + (firstName ? ', ' + firstName : '') + '.'}
        sub={tr('Here is how {scope} is doing today: who is in, what is waiting for you, and what needs attention.', { scope: scopeName })}
        stats={stats} />

      {d.latestAnnouncement && (
        <button type="button" className="ov-announcement" onClick={() => navigate('/announcements')}>
          <span className="ov-announcement-icon"><Icon name="send" /></span>
          <span className="ov-announcement-text"><strong>{tr('Latest announcement')}</strong> {d.latestAnnouncement}</span>
          <Icon name="arrow" />
        </button>
      )}

      <Insights items={insights.slice(0, 9)} />

      <Section id="ov-people" title={tr('Today\'s people')} sub={tr('Attendance by group. The bar shows how many have clocked in; late and away are counted separately.')}
        action={<LinkButton onClick={() => navigate('/attendance')}>{tr('Open attendance')}</LinkButton>}>
        {d.departments.length ? (
          <div className="ov-groups">
            {d.departments.slice().sort((a, b) => a.rate - b.rate).map((g) => (
              <div key={g.companyCode + g.code} className="ov-group">
                <div className="ov-group-top">
                  <div className="ov-group-name">
                    {g.name}
                    {showCompany && <span className="ov-group-co">{g.company}</span>}
                  </div>
                  <strong className={'ov-group-rate' + (g.rate < 70 ? ' is-low' : g.rate < 90 ? ' is-mid' : '')}>{g.rate}%</strong>
                </div>
                <div className="dk-track" aria-hidden="true"><span className={g.rate < 70 ? 'is-low' : g.rate < 90 ? 'is-mid' : ''} style={{ width: g.rate + '%' }} /></div>
                <div className="dk-muted ov-group-meta">
                  {tr('{present} of {headcount} in', { present: g.present, headcount: g.headcount })}
                  {g.late ? ' · ' + tr('{n} late', { n: g.late }) : ''}
                  {g.onLeave ? ' · ' + tr('{n} away', { n: g.onLeave }) : ''}
                </div>
              </div>
            ))}
          </div>
        ) : <Empty icon="people">{tr('No group attendance is visible to your role. Your own record is on My Space.')}</Empty>}
      </Section>

      {d.headcount > 1 && (
        <div className="dk-two">
          <Section card id="ov-late" title={tr('Came in late')} sub={tr('Clocked in after their start time ({time} unless they have their own shift).', { time: lateAfter })}>
            {d.lateList.length ? (
              <ul className="dk-rows">
                {d.lateList.map((p, i) => (
                  <Row key={i} lead={<Person name={p.name} />} title={p.name} meta={p.department}
                    amount={p.clockIn} side={p.shiftStart ? tr('starts {time}', { time: p.shiftStart }) : ''} sideClass="is-warn" />
                ))}
              </ul>
            ) : <Empty>{tr('Nobody was late today.')}</Empty>}
          </Section>
          <Section card title={tr('Not clocked in yet')} sub={tr('Not on leave and not clocked in. Some may simply start later.')}>
            {d.notClockedInList.length ? (
              <>
                <ul className="dk-rows">
                  {d.notClockedInList.map((p, i) => (
                    <Row key={i} lead={<Person name={p.name} />} title={p.name} meta={p.department}
                      side={p.shiftStart ? tr('starts {time}', { time: p.shiftStart }) : ''} />
                  ))}
                </ul>
                {d.notClockedIn > d.notClockedInList.length && <p className="dk-muted">{tr('and {n} more', { n: d.notClockedIn - d.notClockedInList.length })}</p>}
              </>
            ) : <Empty>{tr('Everyone expected today has clocked in.')}</Empty>}
          </Section>
        </div>
      )}

      {d.headcount > 1 && (
        <div className="dk-two">
          <Section card id="ov-away" title={tr('Away today')} sub={tr('On approved leave.')}>
            {d.onLeaveList.length ? (
              <ul className="dk-rows">
                {d.onLeaveList.map((p, i) => (
                  <Row key={i} lead={<Person name={p.name} />} title={p.name} meta={[p.department, p.type].filter(Boolean).join(' · ')}
                    side={p.until === d.today ? tr('back tomorrow') : tr('until {date}', { date: fmtDate(p.until) })} />
                ))}
              </ul>
            ) : <Empty>{tr('Nobody is on leave today.')}</Empty>}
          </Section>
          <Section card title={tr('Leave coming up')} sub={tr('Starting in the next 7 days, so cover can be planned.')}>
            {d.upcomingLeave.length ? (
              <ul className="dk-rows">
                {d.upcomingLeave.map((p, i) => (
                  <Row key={i} lead={<Person name={p.name} />} title={p.name} meta={[p.department, p.type].filter(Boolean).join(' · ')}
                    side={fmtDate(p.from) + ' – ' + fmtDate(p.until)} />
                ))}
              </ul>
            ) : <Empty icon="calendar">{tr('No leave starts in the next 7 days.')}</Empty>}
          </Section>
        </div>
      )}

      {d.restaurants && d.restaurants.length > 0 && (
        <Section title={tr('Restaurants today')} sub={tr('What each till has taken so far today, against the same day last week.')}
          action={<LinkButton onClick={() => navigate('/restaurant')}>{tr('Open restaurants')}</LinkButton>}>
          <div className="ov-restaurants">
            {d.restaurants.map((r) => {
              const pct = pctChange(r.salesToday, r.salesSameDayLastWeek);
              return (
                <button key={r.code} type="button" className="dk-card ov-restaurant" onClick={() => navigate('/financedash?company=' + r.code)}>
                  <span className="ov-restaurant-name">{r.name}</span>
                  <strong className="ov-restaurant-sales">{money(r.salesToday, d.currency)}</strong>
                  <span className="dk-muted">{r.ordersToday === 1 ? tr('1 order today') : tr('{n} orders today', { n: r.ordersToday })}</span>
                  <span className={'dk-change' + (pct === null ? ' is-none' : pct >= 0 ? ' is-good' : ' is-bad')}>
                    {pct === null ? tr('nothing to compare with yet') : tr('{pct}% against last {day}', { pct: (pct > 0 ? '+' : '') + pct, day: lastWeekday() })}
                  </span>
                  {(r.lowStock > 0 || r.expiringSoon > 0) && (
                    <span className="ov-restaurant-warn"><Icon name="warn" /> {[r.lowStock ? tr('{n} to reorder', { n: r.lowStock }) : '', r.expiringSoon ? tr('{n} expiring soon', { n: r.expiringSoon }) : ''].filter(Boolean).join(' · ')}</span>
                  )}
                </button>
              );
            })}
          </div>
        </Section>
      )}

      {tiles.length > 0 && (
        <Section title={tr('Waiting across the business')} sub={tr('Things that need someone to act. Press one to open it.')}>
          <div className="ov-tiles">
            {tiles.map((t) => (
              <button key={t.key} type="button" className={'ov-tile' + (t.alert ? ' is-alert' : '')} onClick={() => navigate(t.route)}>
                <span className="ov-tile-icon"><Icon name={t.icon} /></span>
                <span className="ov-tile-value">{t.value}</span>
                <span className="ov-tile-label">{t.label}</span>
                <span className="dk-muted ov-tile-help">{t.help}</span>
              </button>
            ))}
          </div>
        </Section>
      )}

      {d.recentAudit.length > 0 && (
        <Section card title={tr('Latest activity')} sub={tr('The most recent changes made in the OS.')}>
          <ol className="ov-activity">
            {d.recentAudit.map((log) => (
              <li key={log.id}>
                <span className="ov-activity-dot" aria-hidden="true" />
                <div>
                  <div className="ov-activity-summary">{log.summary}</div>
                  <div className="dk-muted ov-activity-meta">{(log.actorName || tr('System')) + ' · ' + timeAgo(log.at)}</div>
                </div>
              </li>
            ))}
          </ol>
        </Section>
      )}

      <Glossary items={[
        [tr('In today'), tr('People who have clocked in today, out of everyone you can see.')],
        [tr('Late'), tr('Clocked in after their start time: {time}, or their own shift start if they have one.', { time: lateAfter })],
        [tr('Not clocked in yet'), tr('Not on leave and no clock-in today. Night-shift and later-shift staff show here until they arrive.')],
        [tr('Waiting for you'), tr('Approvals in your queue (leave, expenses, purchases) and leave requests you can decide.')],
        [tr('Reorder level'), tr('The stock level at which more should be ordered.')],
        [tr('All companies'), tr('Every company you can see, together. Pick a company at the top to see only its people and figures.')]
      ]} />
    </div>
  );
}
