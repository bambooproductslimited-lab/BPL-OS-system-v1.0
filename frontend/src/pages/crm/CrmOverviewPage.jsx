import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Change, Empty, Glossary, Hero, Icon, Insights, LinkButton, RankList, Row, Section, Status, fmtDate, jump, pctChange } from '../../components/DashKit';
import { activeIntlLocale, tr, msg } from '../../lib/i18n.jsx';
import { PROSPECT_STAGES, STAGES, ImportDialog, LeadDialog, NewLeadDialog, Toast, VisitDialog, WhoIsThisDialog, useUnmatchedNames, addDays, followUpText, ghs, monthLabel, stage, todayISO, useCrmBasics, usePerms, visitLabel } from './crmShared';
import { channelLabel } from './crmHubShared';
import { SalesReviewButton } from './SalesPresent';
import '../EmployeesPage.css';
import '../ToolRoomPage.css';
import './CrmPage.css';
import './CrmOverview.css';

// The Sales & CRM front page, written for the CEO or a sales manager first:
// how much was sold and collected against the period before, what customers
// owe and how late, what is quoted and won, each rep side by side, the best
// customers and the good ones who have stopped buying, what sells, and how
// fast customers get an answer (GET /api/crm/executive,
// crmExecutive.service.js). Below that, the sales team's day-to-day: the
// lead pipeline, follow-ups, site visits and where leads come from
// (GET /api/crm/overview, crm.service.js overview()).

function quarter(offset) {
  const d = new Date();
  const q = Math.floor(d.getUTCMonth() / 3) + offset;
  const y = d.getUTCFullYear() + Math.floor(q / 4);
  const qq = ((q % 4) + 4) % 4;
  const from = new Date(Date.UTC(y, qq * 3, 1));
  const to = new Date(Date.UTC(y, qq * 3 + 3, 0));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}
const PERIODS = {
  quarter: () => quarter(0),
  lastQuarter: () => quarter(-1),
  year: () => ({ from: new Date().getUTCFullYear() + '-01-01', to: new Date().getUTCFullYear() + '-12-31' }),
  twelve: () => ({ from: addDays(todayISO(), -364).slice(0, 8) + '01', to: todayISO() })
};
const AGES = [
  ['current', 'age-0', msg('Not due yet')], ['d30', 'age-1', msg('1–30 days late')], ['d60', 'age-2', msg('31–60 days late')],
  ['d90', 'age-3', msg('61–90 days late')], ['d365', 'age-4', msg('3 months to a year late')], ['older', 'age-5', msg('Over a year late')]
];

// 75 → "1 h 15 min"; a day and more in days.
function dur(min) {
  if (min === null || min === undefined) return '—';
  if (min < 60) return tr('{n} min', { n: Math.round(min) });
  if (min < 48 * 60) { const h = Math.floor(min / 60), m = Math.round(min % 60); return m ? tr('{h} h {m} min', { h, m }) : tr('{h} h', { h }); }
  return tr('{n} days', { n: Math.round(min / 1440) });
}
// "N" for a phone's narrow chart; the full "Nov 25" elsewhere.
const shortMonth = (ym) => new Date(ym + '-01T00:00:00').toLocaleDateString(activeIntlLocale(), { month: 'narrow' });
const pctOf = (a, b) => (b > 0 ? Math.round(a / b * 100) : null);

// One figure on the scorecard: what it is, the number, and what it means.
function Kpi({ icon, label, value, note, change, tone, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick} className={'ex-kpi' + (tone ? ' is-' + tone : '') + (onClick ? ' is-link' : '')}>
      <span className="ex-kpi-head"><span className="ex-kpi-icon"><Icon name={icon} /></span>{label}</span>
      <strong className="ex-kpi-value">{value}</strong>
      {change}
      {note && <span className="ex-kpi-note">{note}</span>}
    </Tag>
  );
}

export default function CrmOverviewPage() {
  const navigate = useNavigate();
  const { session, can } = useAuth();
  const meId = session && session.employee ? session.employee.id : null;
  const { canManage } = usePerms();
  const { settings, people } = useCrmBasics();
  const [period, setPeriod] = useState('quarter');
  const [d, setD] = useState(null);
  const [x, setX] = useState(null);
  const [error, setError] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [toast, setToast] = useState(null);
  const unmatched = useUnmatchedNames();

  const load = useCallback(async () => {
    const p = PERIODS[period]();
    const qs = '?from=' + p.from + '&to=' + p.to;
    try {
      const [ops, exec] = await Promise.all([api.get('/crm/overview' + qs), api.get('/crm/executive' + qs)]);
      setD(ops); setX(exec); setError(null);
    } catch (err) { setError(err.message); }
  }, [period]);
  useEffect(() => { load(); }, [load]);

  if (!d || !x) return <div className="dk">{error ? <div className="error-banner">{error}</div> : <div className="eyebrow">{tr('Loading…')}</div>}</div>;

  const periodName = { quarter: tr('this quarter'), lastQuarter: tr('last quarter'), year: tr('this year'), twelve: tr('the last 12 months') }[period];
  const prevName = { quarter: tr('last quarter'), lastQuarter: tr('the quarter before'), year: tr('last year'), twelve: tr('the 12 months before') }[period];
  const n = x.now, b = x.before, rec = x.receivables, pipe = x.pipeline, svc = x.service, cust = x.customers;
  const f = d.followUps;
  const toLeads = (q) => navigate('/crmleads' + (q ? '?' + q : ''));
  const canInvoices = can('invoice.read');
  const collectedPct = pctOf(n.cash, n.sales);
  const late90 = rec.aging.filter((a) => a.key === 'd365' || a.key === 'older').reduce((s, a) => s + a.amount, 0);
  const quietWorth = cust.quiet.reduce((s, c) => s + c.lifetime, 0);
  const decided = n.quotesWon + n.quotesLost;

  // What the CEO should know first, then what the team should do.
  const insights = [];
  const salesPct = pctChange(n.sales, b.sales);
  if (salesPct !== null && salesPct !== 0) insights.push({ tone: salesPct > 0 ? 'good' : 'bad', icon: salesPct > 0 ? 'up' : 'down', text: salesPct > 0
    ? tr('Sales are up {pct}% on {prev}: {now} against {before}.', { pct: salesPct, prev: prevName, now: ghs(n.sales), before: ghs(b.sales) })
    : tr('Sales are down {pct}% on {prev}: {now} against {before}.', { pct: -salesPct, prev: prevName, now: ghs(n.sales), before: ghs(b.sales) }) });
  if (svc.waiting) insights.push({ tone: 'bad', icon: 'send', text: svc.waiting === 1 ? tr('1 customer is waiting for a reply, for {time}.', { time: dur(svc.oldestWaitingHours * 60) }) : tr('{n} customers are waiting for a reply; the longest for {time}.', { n: svc.waiting, time: dur(svc.oldestWaitingHours * 60) }), action: { label: tr('Open the inbox'), run: () => navigate('/crminbox?waiting=1') } });
  if (late90 > 0) insights.push({ tone: 'bad', icon: 'owed', text: tr('{amount} has been owed for more than 3 months. The longer it waits, the less likely it comes in.', { amount: ghs(late90) }), action: canInvoices ? { label: tr('Open invoices'), run: () => navigate('/invoices') } : null });
  if (collectedPct !== null && collectedPct < 70) insights.push({ tone: 'warn', icon: 'cash', text: tr('Only {pct}% of what was sold {period} has come in so far: {cash} of {sales}.', { pct: collectedPct, period: periodName, cash: ghs(n.cash), sales: ghs(n.sales) }) });
  if (cust.quiet.length) insights.push({ tone: 'warn', icon: 'people', text: cust.quiet.length === 1 ? tr('1 good customer hasn\'t bought for over {days} days; they bought {amount} before.', { days: cust.quietAfterDays, amount: ghs(quietWorth) }) : tr('{n} good customers haven\'t bought for over {days} days; together they bought {amount} before.', { n: cust.quiet.length, days: cust.quietAfterDays, amount: ghs(quietWorth) }), action: { label: tr('Show them'), run: () => jump('ex-quiet') } });
  if (pipe.expiringSoon) insights.push({ tone: 'warn', icon: 'calendar', text: pipe.expiringSoon === 1 ? tr('1 open quotation runs out within a week. A call now can still win it.') : tr('{n} open quotations run out within a week. A call now can still win them.', { n: pipe.expiringSoon }), action: can('quotation.read') ? { label: tr('Open quotations'), run: () => navigate('/quotations') } : null });
  if (cust.topFiveShare !== null && cust.topFiveShare >= 60 && cust.top.length >= 5) insights.push({ tone: 'info', icon: 'scale', text: tr('Five customers made {pct}% of sales {period}. Losing one of them would be felt; winning new ones spreads the risk.', { pct: cust.topFiveShare, period: periodName }) });
  if (svc.medianMinutes !== null && svc.medianMinutes > 240) insights.push({ tone: 'warn', icon: 'clock', text: tr('Half of the customers who wrote waited more than {time} for an answer.', { time: dur(svc.medianMinutes) }) });
  if (n.winRate !== null) insights.push({ tone: n.winRate >= 40 ? 'good' : 'info', icon: 'percent', text: tr('{pct}% of the quotations decided {period} were won: {won} of {n}, worth {amount}.', { pct: n.winRate, period: periodName, won: n.quotesWon, n: decided, amount: ghs(n.quotesWonValue) }) });
  if (d.mine.overdue || d.mine.dueToday) insights.push({ tone: d.mine.overdue ? 'bad' : 'warn', icon: 'phone', text: tr('Your follow-ups: {overdue} overdue and {today} due today.', { overdue: d.mine.overdue, today: d.mine.dueToday }), action: { label: tr('Call them'), run: () => toLeads('rep=me&followUp=' + (d.mine.overdue ? 'overdue' : 'today')) } });
  if (canManage && unmatched.names.length) insights.push({ tone: 'warn', icon: 'people', text: unmatched.names.length === 1 ? tr('1 name from the spreadsheet isn\'t linked to anyone on the staff list, so their leads and commission show under a name only.') : tr('{n} names from the spreadsheet aren\'t linked to anyone on the staff list, so their leads and commission show under a name only.', { n: unmatched.names.length }), action: { label: tr('Who is this?'), run: () => setDialog({ kind: 'who' }) } });
  if (d.seeAllCommission && d.commission.readyCount) insights.push({ tone: 'info', icon: 'cash', text: tr('{n} commissions worth {amount} are on paid-up sales and can be paid.', { n: d.commission.readyCount, amount: ghs(d.commission.ready) }), action: { label: tr('Open commissions'), run: () => navigate('/crmcommissions') } });
  if (!n.sales && !d.totalLeads) insights.push({ tone: 'info', icon: 'info', text: tr('No sales or leads in this period yet.') });

  // Lead → Prospect → Customer, for the leads that came in in the period.
  const stepPct = (a, from) => (from ? tr('{pct}% of the step before', { pct: Math.round(a / from * 100) }) : '');
  const funnel = [
    { key: 'leads', label: tr('Leads'), count: n.leads, note: tr('came in {period}', { period: periodName }), onClick: () => navigate('/crmleads') },
    { key: 'quotes', label: tr('Became prospects'), count: n.leadsProspects, note: stepPct(n.leadsProspects, n.leads), onClick: () => navigate('/crmcustomers?tab=prospects') },
    { key: 'won', label: tr('Won'), count: n.leadsWon, note: stepPct(n.leadsWon, n.leadsProspects), onClick: () => navigate('/crmcustomers?tab=prospects&stage=won') },
    { key: 'sales', label: tr('Became paying customers'), count: n.leadsCustomers, note: stepPct(n.leadsCustomers, n.leadsWon), onClick: () => navigate('/crmcustomers?tab=prospects&stage=customer') }
  ];
  const funnelMax = Math.max(1, ...funnel.map((s) => s.count));
  // A stage's leads are on the Leads page, or with the prospects.
  const stageLink = (key) => (PROSPECT_STAGES.includes(key) || key === 'won' ? navigate('/crmcustomers?tab=prospects&stage=' + key) : toLeads('stage=' + key));
  const trendMax = Math.max(1, ...x.trend.map((m) => Math.max(m.sales, m.cash)));
  const ages = AGES.map(([key, cls, label]) => ({ key, cls, label, ...(rec.aging.find((a) => a.key === key) || { amount: 0, invoices: 0 }) }));
  const flow = STAGES.map((s) => {
    const c = (d.stages.find((y) => y.stage === s.key) || {}).count || 0;
    return { ...s, n: c, pct: d.totalLeads ? Math.round(c / d.totalLeads * 100) : 0 };
  });

  return (
    <div className="dk crm ex">
      {error && <div className="error-banner" role="alert">{error}</div>}
      <div className="crm-toolbar">
        <div className="dk-segment" role="radiogroup" aria-label={tr('Period')}>
          {[['quarter', tr('This quarter')], ['lastQuarter', tr('Last quarter')], ['year', tr('This year')], ['twelve', tr('Last 12 months')]].map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={period === k} className={period === k ? 'is-on' : ''} onClick={() => setPeriod(k)}>{label}</button>
          ))}
        </div>
        <span className="dk-muted tl-small">{fmtDate(x.period.from)} – {fmtDate(x.period.to)} · {tr('compared with {from} – {to}', { from: fmtDate(x.previous.from), to: fmtDate(x.previous.to) })}</span>
      </div>

      <Hero eyebrow={x.company || tr('Sales')} title={tr('How sales are going')}
        sub={tr('Sales, money in, what customers owe, the team and the customers, against {prev}. Every figure comes from the OS invoices, payments, quotations and inbox. Press a number to see behind it.', { prev: prevName })}
        actions={<>
          {canManage && <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: 'new' })}>{tr('Add a lead')}</button>}
          <SalesReviewButton />
          {canManage && <button type="button" className="btn btn-secondary" onClick={() => setDialog({ kind: 'import' })}>{tr('Import from a spreadsheet')}</button>}
        </>}
        stats={[
          { icon: 'cash', value: ghs(n.sales), label: tr('sold {period}', { period: periodName }), note: <Change now={n.sales} before={b.sales} label={prevName} />, onClick: () => jump('ex-trend') },
          { icon: 'drawer', value: ghs(n.cash), label: tr('money in'), note: <Change now={n.cash} before={b.cash} label={prevName} />, onClick: () => jump('ex-trend') },
          { icon: 'owed', value: ghs(rec.owed), label: tr('owed to us now'), note: tr('{amount} of it overdue', { amount: ghs(rec.overdue) }), tone: rec.overdue > 0 ? 'bad' : '', onClick: () => jump('ex-owed') },
          { icon: 'doc', value: ghs(pipe.value), label: tr('in open quotations'), note: pipe.count === 1 ? tr('1 quotation waiting for an answer') : tr('{n} quotations waiting for an answer', { n: pipe.count }), onClick: () => jump('ex-funnel') }
        ]} />

      <Insights items={insights.slice(0, 7)} />

      <Section id="ex-score" title={tr('Scorecard')} sub={tr('The numbers that show how healthy sales are, {period} against {prev}.', { period: periodName, prev: prevName })}>
        <div className="ex-kpis">
          <Kpi icon="receipt" label={tr('Average sale')} value={n.averageInvoice !== null ? ghs(n.averageInvoice) : '—'}
            change={<Change now={n.averageInvoice || 0} before={b.averageInvoice || 0} label={prevName} />} note={n.invoices === 1 ? tr('1 invoice') : tr('{n} invoices', { n: n.invoices })} />
          <Kpi icon="people" label={tr('Customers who bought')} value={String(n.buyers)} change={<Change now={n.buyers} before={b.buyers} label={prevName} />}
            note={tr('{new} new · {returning} came back', { new: n.newBuyers, returning: n.returningBuyers })} onClick={() => jump('ex-customers')} />
          <Kpi icon="drawer" label={tr('Collected of what was sold')} value={collectedPct !== null ? collectedPct + '%' : '—'} tone={collectedPct !== null && collectedPct < 70 ? 'warn' : collectedPct !== null && collectedPct >= 90 ? 'good' : ''}
            note={tr('{cash} in, of {sales} sold', { cash: ghs(n.cash), sales: ghs(n.sales) })} />
          <Kpi icon="percent" label={tr('Quotations won')} value={n.winRate !== null ? n.winRate + '%' : '—'} tone={n.winRate !== null && n.winRate < 25 ? 'warn' : ''}
            note={decided ? tr('{won} of {n} decided · {amount}', { won: n.quotesWon, n: decided, amount: ghs(n.quotesWonValue) }) : tr('none decided yet')}
            change={b.winRate !== null ? <span className="dk-change">{tr('{pct}% {prev}', { pct: b.winRate, prev: prevName })}</span> : null} onClick={() => jump('ex-funnel')} />
          <Kpi icon="clock" label={tr('Time to answer a customer')} value={dur(svc.medianMinutes)} tone={svc.medianMinutes !== null && svc.medianMinutes > 240 ? 'warn' : ''}
            change={svc.medianMinutes !== null && svc.before.medianMinutes !== null ? <Change now={svc.medianMinutes} before={svc.before.medianMinutes} upIsGood={false} label={prevName} /> : null}
            note={tr('half of the customers waited less than this')} onClick={() => jump('ex-service')} />
          <Kpi icon="send" label={tr('Answered within an hour')} value={svc.withinHour !== null ? svc.withinHour + '%' : '—'}
            note={tr('{answered} of {asked} messages answered', { answered: svc.answered, asked: svc.asked })} tone={svc.withinHour === null ? '' : svc.withinHour < 50 ? 'warn' : svc.withinHour >= 80 ? 'good' : ''} onClick={() => jump('ex-service')} />
          <Kpi icon="spark" label={tr('New leads')} value={String(n.leads)} change={<Change now={n.leads} before={b.leads} label={prevName} />}
            note={tr('{p} became prospects · {c} paying customers', { p: n.leadsProspects, c: n.leadsCustomers })} onClick={() => jump('ex-funnel')} />
          <Kpi icon="scale" label={tr('Top 5 customers\' share')} value={cust.topFiveShare !== null ? cust.topFiveShare + '%' : '—'} tone={cust.topFiveShare >= 60 && cust.top.length >= 5 ? 'warn' : ''}
            note={tr('of everything sold {period}', { period: periodName })} onClick={() => jump('ex-customers')} />
        </div>
      </Section>

      <Section card id="ex-trend" title={tr('Sales and money in, the last 12 months')} sub={tr('What was invoiced each month, and the payments that came in that month, in GHS. Hover a month for the figures.')}>
        <div className="ex-trend" role="img" aria-label={x.trend.map((m) => monthLabel(m.month) + ': ' + tr('Sales') + ' ' + ghs(m.sales) + ', ' + tr('Money in') + ' ' + ghs(m.cash)).join('; ')}>
          {x.trend.map((m) => {
            const inPeriod = m.month >= x.period.from.slice(0, 7) && m.month <= x.period.to.slice(0, 7);
            return (
              <div key={m.month} className={'ex-trend-col' + (inPeriod ? ' is-now' : '')} title={monthLabel(m.month) + '\n' + tr('Sales') + ': ' + ghs(m.sales) + '\n' + tr('Money in') + ': ' + ghs(m.cash)}>
                <div className="ex-trend-bars">
                  <span className="ex-bar is-sales" style={{ height: Math.max(m.sales ? 2 : 0, Math.round(m.sales / trendMax * 100)) + '%' }} />
                  <span className="ex-bar is-cash" style={{ height: Math.max(m.cash ? 2 : 0, Math.round(m.cash / trendMax * 100)) + '%' }} />
                </div>
                <span className="ex-trend-label"><span className="ex-long">{monthLabel(m.month)}</span><span className="ex-short">{shortMonth(m.month)}</span></span>
              </div>
            );
          })}
        </div>
        <div className="dk-legend">
          <span><i className="dk-swatch ex-bar is-sales" />{tr('Sales')}</span>
          <span><i className="dk-swatch ex-bar is-cash" />{tr('Money in')}</span>
          <span><i className="dk-swatch ex-now-swatch" />{tr('The months of {period}', { period: periodName })}</span>
        </div>
      </Section>

      <div className="dk-two">
        <Section card id="ex-funnel" title={tr('Lead → Prospect → Customer')} sub={tr('The leads that came in {period}: how many became prospects, were won, and have paid.', { period: periodName })}>
          <ol className="ex-funnel">
            {funnel.map((s) => {
              const Tag = s.onClick ? 'button' : 'div';
              return (
                <li key={s.key}>
                  <Tag type={s.onClick ? 'button' : undefined} className="ex-step" onClick={s.onClick || undefined}>
                    <span className="ex-step-head"><span>{s.label}</span><strong>{s.count}</strong></span>
                    <span className="ex-step-track" aria-hidden="true"><span className={'is-' + s.key} style={{ width: Math.max(s.count ? 3 : 0, Math.round(s.count / funnelMax * 100)) + '%' }} /></span>
                    <span className="ex-kpi-note">{s.note}</span>
                  </Tag>
                </li>
              );
            })}
          </ol>
          <p className="dk-muted tl-small ex-hint">{tr('Quotations sent {period}: {n}, worth {amount}; {won} accepted. One not answered by its end date counts as lost.', { period: periodName, n: n.quotesSent, amount: ghs(n.quotesValue), won: n.quotesWon })}</p>
          {pipe.biggest.length > 0 && (
            <>
              <h4 className="ex-h4">{tr('Biggest quotations still open')}</h4>
              <ul className="dk-rows">
                {pipe.biggest.map((q) => (
                  <Row key={q.id} lead={<span className="dk-lead-icon is-info"><Icon name="doc" /></span>} title={q.customer} meta={q.quoteNo + (q.validUntil ? ' · ' + tr('valid until {date}', { date: fmtDate(q.validUntil) }) : '')}
                    amount={ghs(q.amount)} side={q.validUntil && q.validUntil <= addDays(todayISO(), 7) ? tr('runs out soon') : ''} sideClass="is-warn" />
                ))}
              </ul>
            </>
          )}
        </Section>

        <Section card id="ex-owed" title={tr('Owed to us, by how late')} sub={tr('Everything customers still owe on sales, today, by how far past the due date.')}
          action={canInvoices ? <LinkButton onClick={() => navigate('/invoices')}>{tr('Open invoices')}</LinkButton> : null}>
          <dl className="dk-sum ex-sum">
            <div><dt>{tr('Owed')}</dt><dd>{ghs(rec.owed)}</dd></div>
            <div><dt>{tr('Overdue')}</dt><dd className={rec.overdue > 0 ? 'is-bad' : 'is-good'}>{ghs(rec.overdue)}</dd></div>
            <div><dt>{tr('Invoices')}</dt><dd>{rec.invoices}</dd></div>
          </dl>
          {rec.owed > 0 && (
            <div className="dk-stack-bar" role="img" aria-label={ages.map((a) => tr(a.label) + ': ' + ghs(a.amount)).join('; ')}>
              {ages.filter((a) => a.amount > 0).map((a) => <span key={a.key} className={a.cls} style={{ width: (a.amount / rec.owed * 100) + '%' }} title={tr(a.label) + ': ' + ghs(a.amount)} />)}
            </div>
          )}
          <ul className="ex-ages">
            {ages.map((a) => (
              <li key={a.key}>
                <i className={'dk-swatch ' + a.cls} aria-hidden="true" />
                <span className="ex-ages-name">{tr(a.label)}</span>
                <span className="dk-muted tl-small">{a.invoices === 1 ? tr('1 invoice') : tr('{n} invoices', { n: a.invoices })}</span>
                <strong>{ghs(a.amount)}</strong>
              </li>
            ))}
          </ul>
          {canInvoices && late90 > 0 && <p className="dk-muted tl-small ex-hint">{tr('Debts that will never come in, or that were paid and never recorded, can be cleared on Invoices → Clean up old invoices.')}</p>}
        </Section>
      </div>

      <Section card id="ex-team" title={tr('The team')} sub={tr('Each sales rep side by side {period}. A sale counts for its sales order\'s rep, else the customer\'s. Press a name to see their customers.', { period: periodName })}>
        {x.team.length ? (
          <div className="tl-table-wrap">
            <table className="tl-table ex-team">
              <thead>
                <tr>
                  <th>{tr('Sales rep')}</th><th className="is-num">{tr('Sold')}</th><th className="is-num">{tr('Money in')}</th><th className="is-num">{tr('Customers')}</th>
                  <th className="is-num">{tr('Open quotations')}</th><th className="is-num">{tr('Overdue')}</th><th className="is-num">{tr('Customer messages')}</th>
                  <th className="is-num">{tr('Follow-ups due')}</th>
                </tr>
              </thead>
              <tbody>
                {x.team.map((r) => (
                  <tr key={r.repId || 'none'}>
                    <td><button type="button" className="ex-rep" onClick={() => navigate('/crmcustomers?rep=' + (r.repId || 'none'))}>{r.name || tr('No rep')}</button></td>
                    <td className="is-num"><strong>{ghs(r.sales)}</strong><span className="ex-share" aria-hidden="true"><span style={{ width: r.share + '%' }} /></span><span className="dk-muted tl-small">{tr('{pct}% of sales', { pct: r.share })}</span></td>
                    <td className="is-num">{ghs(r.cash)}</td>
                    <td className="is-num">{r.customers}</td>
                    <td className="is-num">{r.openQuotes ? ghs(r.openQuotes) : '—'}</td>
                    <td className={'is-num' + (r.overdue > 0 ? ' ex-owe' : '')}>{r.overdue ? ghs(r.overdue) : '—'}</td>
                    <td className="is-num">
                      {r.waiting ? <Status tone="bad">{tr('{n} waiting', { n: r.waiting })}</Status> : <span className="dk-muted">{tr('none waiting')}</span>}
                      <span className="dk-muted tl-small">{tr('answers in {time}', { time: dur(r.replyMedianMinutes) })}</span>
                    </td>
                    <td className="is-num">{r.followUpsDue ? <Status tone="warn">{r.followUpsDue}</Status> : '0'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty icon="people">{tr('No sales reps yet. Give customers a rep on their profile.')}</Empty>}
      </Section>

      <div className="dk-two">
        <Section card id="ex-customers" title={tr('Best customers')} sub={tr('Who bought the most {period}, and how much of all sales that is.', { period: periodName })}>
          {cust.top.length ? (
            <RankList rows={cust.top.map((c) => ({
              key: c.id, name: c.name, value: c.sales, amount: ghs(c.sales),
              meta: [tr('{pct}% of sales', { pct: c.share }), c.invoices === 1 ? tr('1 invoice') : tr('{n} invoices', { n: c.invoices }), c.owes > 0 ? tr('owes {amount}', { amount: ghs(c.owes) }) : null, c.repName].filter(Boolean).join(' · ')
            }))} />
          ) : <Empty icon="people">{tr('Nothing sold {period}.', { period: periodName })}</Empty>}
        </Section>
        <Section card id="ex-quiet" title={tr('Good customers who have stopped buying')} sub={tr('Bought from us at least twice in the last two years, but nothing for over {days} days. Biggest first: a call may bring them back.', { days: cust.quietAfterDays })}>
          {cust.quiet.length ? (
            <ul className="dk-rows">
              {cust.quiet.map((c) => (
                <li key={c.id} className="dk-row crm-row-btn">
                  <button type="button" onClick={() => navigate('/crmcustomers?id=' + c.id)}>
                    <span className="dk-lead-icon is-warn"><Icon name="clock" /></span>
                    <div className="dk-row-main">
                      <div className="dk-row-title">{c.name}</div>
                      <div className="dk-muted dk-row-meta">{[tr('last bought {date}', { date: fmtDate(c.lastBought) }), c.invoices === 1 ? tr('1 invoice') : tr('{n} invoices', { n: c.invoices }), c.repName || tr('No rep')].join(' · ')}</div>
                    </div>
                    <div className="dk-row-side"><div className="dk-row-amount">{ghs(c.lifetime)}</div><div className="dk-row-note">{tr('bought before')}</div></div>
                  </button>
                </li>
              ))}
            </ul>
          ) : <Empty>{tr('Every regular customer has bought in the last {days} days.', { days: cust.quietAfterDays })}</Empty>}
        </Section>
      </div>

      <div className="dk-two">
        <Section card title={tr('What sells')} sub={tr('The invoice lines of {period}, by what was sold, before tax.', { period: periodName })}>
          {x.products.length ? (
            <RankList barClass="is-info" rows={x.products.map((p) => ({
              key: p.name, name: p.name, value: p.amount, amount: ghs(p.amount),
              meta: [tr('{qty} sold', { qty: p.qty.toLocaleString() }), p.buyers === 1 ? tr('1 customer') : tr('{n} customers', { n: p.buyers })].join(' · ')
            }))} />
          ) : <Empty icon="bag">{tr('Nothing sold {period}.', { period: periodName })}</Empty>}
        </Section>
        <Section card id="ex-service" title={tr('Customer service')} sub={tr('How fast customers who write to us get an answer, {period}, on every channel in the inbox.', { period: periodName })}
          action={<LinkButton onClick={() => navigate('/crminbox')}>{tr('Open the inbox')}</LinkButton>}>
          <dl className="dk-sum ex-sum">
            <div><dt>{tr('Messages from customers')}</dt><dd>{svc.asked}</dd></div>
            <div><dt>{tr('Within an hour')}</dt><dd className={svc.withinHour !== null && svc.withinHour >= 70 ? 'is-good' : ''}>{svc.withinHour !== null ? svc.withinHour + '%' : '—'}</dd></div>
            <div><dt>{tr('Waiting now')}</dt><dd className={svc.waiting ? 'is-bad' : 'is-good'}>{svc.waiting}</dd></div>
          </dl>
          {svc.channels.length ? (
            <RankList rows={svc.channels.map((c) => ({
              key: c.channel, name: channelLabel(c.channel), value: c.asked, amount: dur(c.medianMinutes),
              meta: [c.asked === 1 ? tr('1 message') : tr('{n} messages', { n: c.asked }), c.withinHour !== null ? tr('{pct}% within an hour', { pct: c.withinHour }) : null, c.asked > c.answered ? tr('{n} not answered', { n: c.asked - c.answered }) : null].filter(Boolean).join(' · ')
            }))} />
          ) : <Empty icon="send">{tr('No customer messages {period}.', { period: periodName })}</Empty>}
        </Section>
      </div>

      <div className="ex-divider" id="ex-day" tabIndex={-1}>
        <h3 className="dk-h3">{tr('The sales team\'s day-to-day')}</h3>
        <p className="dk-muted">{tr('Leads, follow-ups and site visits: the work that turns enquiries into the sales above.')}</p>
      </div>

      <Section id="crm-pipeline" title={tr('The pipeline')} sub={tr('Every lead, by the stage it has reached ({n} in all, {open} still open). Press a stage to see its leads.', { n: d.totalLeads, open: d.openLeads })}
        action={<LinkButton onClick={() => toLeads('view=board')}>{tr('Open the board')}</LinkButton>}>
        <ul className="dk-flow crm-flow">
          {flow.map((s) => (
            <li key={s.key} className={'is-' + (s.tone === 'good' ? 'good' : s.tone === 'bad' ? 'bad' : s.tone === 'warn' ? 'warn' : 'info')}>
              <button type="button" className="crm-flow-btn" onClick={() => stageLink(s.key)}>
                <span className="dk-flow-name">{tr(s.label)}</span>
                <span className="dk-flow-n">{s.n}</span>
                <span className="dk-flow-value">{tr('{pct}% of all leads', { pct: s.pct })}</span>
                <span className="dk-flow-help">{tr(s.help)}</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>

      <div className="dk-two">
        <Section card id="crm-follow" title={tr('Follow-ups due')} sub={tr('Overdue first. Press one to open it.')} action={<LinkButton onClick={() => toLeads('followUp=overdue')}>{tr('All overdue')}</LinkButton>}>
          {f.list.length ? (
            <ul className="dk-rows">
              {f.list.map((l) => (
                <li key={l.id} className="dk-row crm-row-btn">
                  <button type="button" onClick={() => setDialog({ kind: 'lead', id: l.id })}>
                    <span className={'dk-lead-icon ' + (l.nextFollowUp < todayISO() ? 'is-bad' : 'is-warn')}><Icon name="phone" /></span>
                    <div className="dk-row-main">
                      <div className="dk-row-title">{l.name}</div>
                      <div className="dk-muted dk-row-meta">{[l.item, l.repName, tr(stage(l.stage).label)].filter(Boolean).join(' · ')}</div>
                    </div>
                    <div className="dk-row-side"><div className={'dk-row-note ' + (l.nextFollowUp < todayISO() ? 'is-bad' : 'is-warn')}>{followUpText(l.nextFollowUp)}</div></div>
                  </button>
                </li>
              ))}
            </ul>
          ) : <Empty>{tr('Nobody is waiting for a call back today.')}</Empty>}
        </Section>
        <Section card title={tr('Site visits')} sub={tr('{visited} of {n} visits {period} done; {cancelled} cancelled.', { visited: d.visits.visited, n: d.visits.scheduled, period: periodName, cancelled: d.visits.cancelled })}
          action={<LinkButton onClick={() => navigate('/crmvisits')}>{tr('Open site visits')}</LinkButton>}>
          {d.visits.upcoming.length ? (
            <ul className="dk-rows">
              {d.visits.upcoming.map((v) => (
                <Row key={v.id} lead={<span className="dk-lead-icon is-info"><Icon name="calendar" /></span>} title={v.client}
                  meta={[v.location, v.assessors.map((a) => a.name).concat(v.assessorsText ? [v.assessorsText] : []).join(', ')].filter(Boolean).join(' · ')}
                  side={<Status tone="info">{visitLabel(v.status)}</Status>} amount={fmtDate(v.scheduledOn)} />
              ))}
            </ul>
          ) : <Empty icon="calendar">{tr('No visit booked for the next two weeks.')}</Empty>}
        </Section>
      </div>

      <div className="dk-two">
        <Section card title={tr('Where leads come from')} sub={tr('Leads received {period} by how they found us, and how many were won.', { period: periodName })}>
          {d.sources.length ? (
            <RankList barClass="is-info" rows={d.sources.map((s) => ({ key: s.source || '-', name: s.source || tr('Not known'), value: s.leads, amount: s.leads === 1 ? tr('1 lead') : tr('{n} leads', { n: s.leads }), meta: s.leads ? tr('{won} won · {pct}%', { won: s.won, pct: Math.round(s.won / s.leads * 100) }) : '' }))} />
          ) : <Empty icon="spark">{tr('No leads received {period}.', { period: periodName })}</Empty>}
        </Section>
        <Section card title={tr('Lead → Prospect → Customer')} sub={tr('Where every lead stands now. A lead becomes a prospect once qualified or quoted, and a customer when they pay.')}>
          <ul className="ex-phases">
            {[['lead', tr('Leads'), d.phases.lead, () => navigate('/crmleads')], ['prospect', tr('Prospects'), d.phases.prospect, () => navigate('/crmcustomers?tab=prospects')],
              ['won', tr('Won, waiting for payment'), d.phases.won, () => navigate('/crmcustomers?tab=prospects&stage=won')], ['customer', tr('Customers'), d.phases.customer, () => navigate('/crmcustomers?tab=prospects&stage=customer')],
              ['lost', tr('Lost'), d.phases.lost, () => navigate('/crmleads?stage=lost')]].map(([k, label, count, go]) => (
              <li key={k}><button type="button" className={'ex-phase is-' + k} onClick={go}><strong>{count}</strong><span>{label}</span></button></li>
            ))}
          </ul>
          {d.unlinkedSales.count > 0 && <p className="dk-muted tl-small">{tr('{n} sales invoices worth {amount} {period} aren\'t linked to a lead, so they don\'t count for a lead or a commission.', { n: d.unlinkedSales.count, amount: ghs(d.unlinkedSales.total), period: periodName })}</p>}
        </Section>
      </div>

      <Glossary items={[
        [tr('Sold'), tr('Sale invoices of {company} issued in the period, less credit notes, in GHS. Voided invoices don\'t count.', { company: x.company || tr('the company') })],
        [tr('Money in'), tr('Payments received in the period on those invoices, less refunds, whenever the invoice was issued.')],
        [tr('Owed to us'), tr('What customers still have to pay on sale invoices today; overdue is past its due date.')],
        [tr('Quotations won'), tr('Accepted quotations out of those sent in the period that have been decided: accepted, refused, or past their end date with no answer.')],
        [tr('Time to answer'), tr('From a customer\'s message to our first reply on the same conversation. Half of the customers waited less than this (the median).')],
        [tr('Good customer who stopped buying'), tr('Two or more sales in the last two years, and none for over {days} days.', { days: cust.quietAfterDays })],
        [tr('Lead'), tr('Someone who asked about a product. It moves through the stages until it is won or lost.')],
        [tr('Follow-up'), tr('The date someone should get back to the lead. Overdue means that date has passed.')],
        [tr('Commission'), tr('The rep\'s share of a sale: {rate}% minus the discount given, on the price after discount. 5% off leaves 15%.', { rate: settings ? settings.commissionRate : 20 })]
      ]} />
      {x.otherCurrency > 0 && <p className="dk-muted tl-small">{x.otherCurrency === 1 ? tr('1 invoice in another currency is left out of these GHS figures.') : tr('{n} invoices in other currencies are left out of these GHS figures.', { n: x.otherCurrency })}</p>}

      {dialog && dialog.kind === 'new' && settings && <NewLeadDialog settings={settings} people={people} meId={meId} onClose={() => setDialog(null)} onSaved={(l) => { setDialog({ kind: 'lead', id: l.id }); setToast(tr('Lead {ref} added.', { ref: l.ref })); load(); }} />}
      {dialog && dialog.kind === 'import' && <ImportDialog onClose={() => setDialog(null)} onDone={() => { load(); unmatched.reload(); }} />}
      {dialog && dialog.kind === 'who' && <WhoIsThisDialog people={people} onClose={() => setDialog(null)} onDone={() => { load(); unmatched.reload(); }} />}
      {dialog && dialog.kind === 'lead' && settings && <LeadDialog leadId={dialog.id} settings={settings} people={people} onClose={() => setDialog(null)} onChanged={load} onVisit={(v) => setDialog({ kind: 'visit', visit: v, back: dialog.id })} />}
      {dialog && dialog.kind === 'visit' && <VisitDialog visit={dialog.visit} people={people} onClose={() => setDialog(dialog.back ? { kind: 'lead', id: dialog.back } : null)} onSaved={() => { setToast(tr('Site visit saved.')); load(); setDialog(dialog.back ? { kind: 'lead', id: dialog.back } : null); }} />}
      <Toast text={toast} onDone={() => setToast(null)} />
    </div>
  );
}
