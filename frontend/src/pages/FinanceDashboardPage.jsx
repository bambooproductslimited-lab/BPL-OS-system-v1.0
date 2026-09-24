import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { money, moneyBreakdown } from '../lib/currency';
import { rowsToCsv, downloadCsv } from '../lib/csvExport';
import { shareOrDownloadPdf } from '../lib/documentShare';
import { tr } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import {
  Change, CompanySwitcher, Empty, Glossary, Hero, Icon, Insights, LinkButton, PairBars, Phone, RankList, Row, Section,
  avatarColor, fmtDate, initials, jump, pctChange, useCompany
} from '../components/DashKit';
import './FinanceDashboardPage.css';

// Backed by GET /api/reports/finance (reportsService.financeDashboard,
// report.read), one company at a time like the marketing dashboard: the
// switcher at the top picks it (?company=SB, remembered on this device).
//
// Bamboo Products (and Poki, with its own invoices) get the invoices view:
// cash collected, money owed and how late it is, who owes the most, what
// falls due soon, and spending. The restaurants get the till view: sales,
// how guests paid, the last 14 days, cash drawers that did not balance,
// voided orders, and spending. Both lead with a "what stands out" list
// written from the numbers and end with what the words mean.

const PERIOD_OPTIONS = [3, 6, 9, 12];

function csvRows(fin) {
  const rows = [[tr('Finance dashboard'), fin.company.name, new Date().toISOString().slice(0, 10)], []];
  rows.push([tr('Period'), fin.kind === 'restaurant' ? tr('Sales ({currency})', { currency: fin.baseCurrency }) : tr('Revenue collected ({currency})', { currency: fin.baseCurrency }), tr('Expenses approved ({currency})', { currency: fin.baseCurrency })]);
  fin.monthlyTrend.forEach((m) => rows.push([m.month, m.revenue, m.expense]));
  rows.push([], [tr('Metric'), tr('Value')]);
  if (fin.kind === 'restaurant') {
    rows.push([tr('Sales this month'), fin.salesThisMonth], [tr('Orders this month'), fin.ordersThisMonth], [tr('Voided orders this month'), fin.voidedThisMonth]);
    fin.byMethod.forEach((m) => rows.push([tr('Paid by {method}', { method: codeLabel(m.method) }), m.amount]));
  } else {
    (fin.cashCollectedThisMonthByCurrency || []).forEach((r) => rows.push([tr('Cash collected this month ({currency})', { currency: r.currency }), r.amount]));
    (fin.outstandingByCurrency || []).forEach((r) => rows.push([tr('Outstanding ({currency})', { currency: r.currency }), r.amount]));
    (fin.overdueTotalByCurrency || []).forEach((r) => rows.push([tr('Overdue total ({currency})', { currency: r.currency }), r.amount]));
  }
  rows.push([tr('Net position this month ({currency})', { currency: fin.baseCurrency }), fin.netPositionThisMonth]);
  rows.push([tr('Expenses approved this month'), fin.approvedExpensesThisMonth], [tr('Pending expense claims'), fin.pendingExpensesTotal]);
  if (fin.kind !== 'restaurant' && fin.overdueInvoices.length) {
    rows.push([], [tr('Overdue invoices')], [tr('Invoice'), tr('Customer'), tr('Currency'), tr('Amount'), tr('Days overdue')]);
    fin.overdueInvoices.forEach((i) => rows.push([i.invoiceNo, i.customerName, i.currency, i.amount, i.daysOverdue]));
  }
  if (fin.pendingExpenses.length) {
    rows.push([], [tr('Expense claims awaiting a decision')], [tr('Category'), tr('Amount'), tr('Requester'), tr('Group'), tr('Days waiting')]);
    fin.pendingExpenses.forEach((e) => rows.push([e.category, e.amount, e.requesterName, e.departmentName, e.daysWaiting]));
  }
  return rows;
}

export default function FinanceDashboardPage() {
  const { company, companies, switchTo } = useCompany('bos.financeCompany', '/reports/finance/companies');
  const [fin, setFin] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [periodType, setPeriodType] = useState('months');
  const [periodCount, setPeriodCount] = useState(6);
  const printRef = useRef(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setFin(await api.get('/reports/finance?company=' + encodeURIComponent(company) + '&periodType=' + periodType + '&periodCount=' + periodCount));
    } catch (err) {
      setError(err.message);
      setFin(null);
    } finally {
      setLoading(false);
    }
  }, [company, periodType, periodCount]);
  useEffect(() => { load(); }, [load]);

  function pick(code) { setLoading(true); switchTo(code); }

  async function downloadPdf() {
    setExporting(true);
    try {
      await shareOrDownloadPdf(printRef.current, 'finance-' + company.toLowerCase() + '-' + new Date().toISOString().slice(0, 10) + '.pdf', tr('Finance dashboard') + ' — ' + fin.company.name, tr('Finance dashboard'));
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  }
  function downloadCsvReport() {
    downloadCsv('finance-' + company.toLowerCase() + '-' + new Date().toISOString().slice(0, 10) + '.csv', rowsToCsv(csvRows(fin)));
  }

  const switcher = (
    <CompanySwitcher companies={companies} company={company} onPick={pick}
      describe={(co) => (co.kind === 'restaurant' ? tr('Restaurant: till & costs') : tr('Invoices, payments & costs'))} />
  );
  if (loading) return <div className="dk">{switcher}<div className="eyebrow">{tr('Loading…')}</div></div>;
  if (!fin) return <div className="dk">{switcher}<div className="error-banner">{error || tr('No data yet.')}</div></div>;

  const actions = (
    <>
      <button type="button" className="btn btn-secondary" onClick={downloadCsvReport}>{tr('Download CSV')}</button>
      <button type="button" className="btn btn-secondary" disabled={exporting} onClick={downloadPdf}>{exporting ? tr('Preparing…') : tr('Download PDF')}</button>
    </>
  );
  const trend = (
    <TrendSection fin={fin} periodType={periodType} periodCount={periodCount}
      onType={(v) => setPeriodType(v)} onCount={(v) => setPeriodCount(v)} />
  );
  const Shared = fin.kind === 'restaurant' ? RestaurantFinance : TradeFinance;
  return (
    <div className="dk">
      {error && <div className="error-banner" role="alert">{error}</div>}
      {switcher}
      <Shared fin={fin} actions={actions} trend={trend} printRef={printRef} />
      <Glossary items={fin.kind === 'restaurant' ? [
        [tr('Sales'), tr('Completed orders rung up on the till. Voided orders never count.')],
        [tr('Net this month'), tr('Sales so far this month minus the expenses approved for this restaurant this month.')],
        [tr('Cash drawer'), tr('At the end of a shift the cashier counts the cash. It should match the starting cash plus cash sales plus money paid in, minus money paid out.')],
        [tr('Short / over'), tr('Short means less cash was counted than expected; over means more.')],
        [tr('Voided order'), tr('An order cancelled after it was rung up. A few are normal; many are worth a look.')],
        [tr('The arrows'), tr('This month so far is compared with the same days of last month.')]
      ] : [
        [tr('Collected'), tr('Payments received against invoices, on the day they came in.')],
        [tr('Owed to us'), tr('What customers still have to pay on invoices that are not fully paid.')],
        [tr('Overdue'), tr('Owed on an invoice whose due date has passed.')],
        [tr('Net this month'), tr('Collected this month minus expenses approved this month, in {currency}.', { currency: fin.baseCurrency })],
        [tr('How late the money owed is'), tr('Owed money grouped by how long past its due date it is. The older it gets, the harder it is to collect.')],
        [tr('The arrows'), tr('This month so far is compared with the same days of last month.')]
      ]} />
    </div>
  );
}

// Money in against money out, month by month (or year by year).
function TrendSection({ fin, periodType, periodCount, onType, onCount }) {
  const m = (n) => money(n, fin.baseCurrency);
  const totalIn = fin.monthlyTrend.reduce((s, r) => s + r.revenue, 0);
  const totalOut = fin.monthlyTrend.reduce((s, r) => s + r.expense, 0);
  const inLabel = fin.kind === 'restaurant' ? tr('Sales') : tr('Collected');
  return (
    <Section card title={fin.kind === 'restaurant' ? tr('Sales against costs') : tr('Money in against money out')}
      sub={periodType === 'years' ? tr('Year by year, in {currency}.', { currency: fin.baseCurrency }) : tr('Month by month, in {currency}.', { currency: fin.baseCurrency })}
      action={
        <div className="fd-period no-print">
          <div className="dk-segment" role="group" aria-label={tr('Period')}>
            <button type="button" aria-pressed={periodType === 'months'} className={periodType === 'months' ? 'is-on' : ''} onClick={() => onType('months')}>{tr('Months')}</button>
            <button type="button" aria-pressed={periodType === 'years'} className={periodType === 'years' ? 'is-on' : ''} onClick={() => onType('years')}>{tr('Years')}</button>
          </div>
          <select className="input fd-period-count" aria-label={tr('How many')} value={periodCount} onChange={(e) => onCount(Number(e.target.value))}>
            {PERIOD_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
      }>
      <PairBars rows={fin.monthlyTrend.map((r) => ({ label: r.month, a: r.revenue, b: r.expense }))} aLabel={inLabel} bLabel={tr('Expenses')} format={m} />
      <dl className="dk-sum">
        <div><dt>{inLabel}</dt><dd>{m(totalIn)}</dd></div>
        <div><dt>{tr('Expenses')}</dt><dd>{m(totalOut)}</dd></div>
        <div><dt>{tr('Difference')}</dt><dd className={totalIn - totalOut < 0 ? 'is-bad' : 'is-good'}>{m(totalIn - totalOut)}</dd></div>
      </dl>
    </Section>
  );
}

// Pending claims and this month's spending by category, for both kinds.
function Spending({ fin }) {
  const navigate = useNavigate();
  const m = (n) => money(n, fin.baseCurrency);
  return (
    <div className="dk-two">
      <Section card id="fd-claims" title={tr('Expense claims awaiting a decision')} sub={tr('Oldest first. Staff are waiting on these.')}
        action={<LinkButton onClick={() => navigate('/expenses')}>{tr('Open expenses')}</LinkButton>}>
        {fin.pendingExpenses.length ? (
          <ul className="dk-rows">
            {fin.pendingExpenses.slice(0, 8).map((e, i) => (
              <Row key={i}
                lead={<span className="dk-avatar" style={{ background: avatarColor(e.requesterName) }} aria-hidden="true">{initials(e.requesterName)}</span>}
                title={e.category} meta={e.requesterName + ' · ' + e.departmentName}
                amount={m(e.amount)}
                side={e.daysWaiting === 0 ? tr('sent today') : e.daysWaiting === 1 ? tr('waiting 1 day') : tr('waiting {n} days', { n: e.daysWaiting })}
                sideClass={e.daysWaiting > 7 ? 'is-warn' : ''} />
            ))}
          </ul>
        ) : <Empty>{tr('Nothing waiting for a decision.')}</Empty>}
      </Section>
      <Section card title={tr('Spending this month')} sub={tr('Approved expenses so far this month, by category.')}>
        {fin.expenseByCategoryThisMonth.length ? (
          <>
            <RankList barClass="is-out" rows={fin.expenseByCategoryThisMonth.map((c) => ({ key: c.category, name: c.category, value: c.amount, amount: m(c.amount) }))} />
            <p className="dk-muted"><Change now={fin.approvedExpensesThisMonth} before={fin.approvedExpensesLastMonthSameDays} upIsGood={false} label={tr('the same days last month')} /></p>
          </>
        ) : <Empty icon="receipt">{tr('No expenses approved yet this month.')}</Empty>}
      </Section>
    </div>
  );
}

function TradeFinance({ fin, actions, trend, printRef }) {
  const navigate = useNavigate();
  const cur = fin.baseCurrency;
  const m = (n) => money(n, cur);
  const oldest = fin.overdueInvoices[0];
  const aging = fin.aging;
  const owedBase = aging.current + aging.d1to30 + aging.d31to60 + aging.d61to90 + aging.d90plus;
  const dueSoonTotal = fin.dueSoon.filter((d) => d.currency === cur).reduce((s, d) => s + d.amount, 0);
  const longWaiting = fin.pendingExpenses.filter((e) => e.daysWaiting > 7);

  const insights = [];
  const collectPct = pctChange(fin.cashCollectedThisMonth, fin.cashCollectedLastMonthSameDays);
  if (collectPct !== null && collectPct !== 0) {
    insights.push({ tone: collectPct > 0 ? 'good' : 'warn', icon: collectPct > 0 ? 'up' : 'down', text: collectPct > 0
      ? tr('{amount} collected so far this month, {pct}% more than by this day last month.', { amount: m(fin.cashCollectedThisMonth), pct: collectPct })
      : tr('{amount} collected so far this month, {pct}% less than by this day last month.', { amount: m(fin.cashCollectedThisMonth), pct: -collectPct }) });
  } else if (!fin.cashCollectedThisMonth) {
    insights.push({ tone: 'info', icon: 'cash', text: tr('No payments have come in yet this month.') });
  }
  if (oldest) {
    insights.push({ tone: 'bad', icon: 'warn', text: fin.overdueCount === 1
      ? tr('1 invoice is overdue: {customer}, {days} days late.', { customer: oldest.customerName, days: oldest.daysOverdue })
      : tr('{n} invoices are overdue. The oldest is {customer}\'s, {days} days late.', { n: fin.overdueCount, customer: oldest.customerName, days: oldest.daysOverdue }),
      action: { label: tr('See them'), run: () => jump('fd-overdue') } });
  }
  if (aging.d90plus > 0) {
    insights.push({ tone: 'bad', icon: 'owed', text: tr('{amount} has been owed for more than 90 days: the hardest money to collect.', { amount: m(aging.d90plus) }) });
  }
  if (fin.dueSoon.length) {
    insights.push({ tone: 'info', icon: 'calendar', text: fin.dueSoon.length === 1
      ? tr('1 invoice worth {amount} falls due in the next 14 days.', { amount: m(dueSoonTotal) })
      : tr('{n} invoices worth {amount} fall due in the next 14 days.', { n: fin.dueSoon.length, amount: m(dueSoonTotal) }) });
  }
  if (fin.netPositionThisMonth < 0) {
    insights.push({ tone: 'warn', icon: 'scale', text: tr('More went out than came in this month: {amount}.', { amount: m(fin.netPositionThisMonth) }) });
  } else if (fin.netPositionThisMonth > 0) {
    insights.push({ tone: 'good', icon: 'scale', text: tr('More came in than went out this month: {amount} ahead.', { amount: m(fin.netPositionThisMonth) }) });
  }
  if (fin.topDebtors[0]) {
    const d = fin.topDebtors[0];
    insights.push({ tone: 'info', icon: 'people', text: tr('{name} owes the most: {amount} across {n} invoice(s).', { name: d.name, amount: m(d.owed), n: d.invoices }) });
  }
  if (longWaiting.length) {
    insights.push({ tone: 'warn', icon: 'receipt', text: longWaiting.length === 1 ? tr('1 expense claim has waited more than a week for a decision.') : tr('{n} expense claims have waited more than a week for a decision.', { n: longWaiting.length }), action: { label: tr('See them'), run: () => jump('fd-claims') } });
  }

  const ageBands = [
    { key: 'current', cls: 'age-0', label: tr('Not due yet'), value: aging.current },
    { key: 'd1', cls: 'age-1', label: tr('1–30 days late'), value: aging.d1to30 },
    { key: 'd31', cls: 'age-2', label: tr('31–60 days'), value: aging.d31to60 },
    { key: 'd61', cls: 'age-3', label: tr('61–90 days'), value: aging.d61to90 },
    { key: 'd90', cls: 'age-4', label: tr('Over 90 days'), value: aging.d90plus }
  ];

  return (
    <>
      <Hero eyebrow={fin.company.name} title={tr('Where the money is')}
        sub={tr('Cash coming in, money still owed and how late it is, and what is being spent: this month and over time.')}
        actions={actions}
        stats={[
          { icon: 'cash', value: moneyBreakdown(fin.cashCollectedThisMonthByCurrency, m(0)), label: tr('collected this month'), note: <Change now={fin.cashCollectedThisMonth} before={fin.cashCollectedLastMonthSameDays} label={tr('last month')} /> },
          { icon: 'owed', value: moneyBreakdown(fin.outstandingByCurrency, m(0)), label: tr('owed to us'), note: fin.unpaidCount === 1 ? tr('on 1 invoice') : tr('on {n} invoices', { n: fin.unpaidCount }), onClick: () => jump('fd-owed') },
          { icon: 'warn', value: moneyBreakdown(fin.overdueTotalByCurrency, m(0)), label: tr('overdue'), note: fin.overdueCount ? (fin.overdueCount === 1 ? tr('1 invoice past its due date') : tr('{n} invoices past their due date', { n: fin.overdueCount })) : tr('nothing overdue'), tone: fin.overdueCount ? 'bad' : '', onClick: () => jump('fd-overdue') },
          { icon: 'scale', value: m(fin.netPositionThisMonth), label: tr('net this month'), note: tr('collected minus expenses'), tone: fin.netPositionThisMonth < 0 ? 'bad' : '' }
        ]} />

      <div ref={printRef} className="dk-body">
        <Insights items={insights} />
        {trend}

        <Section id="fd-owed" card title={tr('How late the money owed is')} sub={tr('Everything customers still owe in {currency}, by how far past the due date it is.', { currency: cur })}
          action={<LinkButton onClick={() => navigate('/invoices')}>{tr('Open invoices')}</LinkButton>}>
          {owedBase > 0 ? (
            <>
              <div className="dk-stack-bar" role="img" aria-label={ageBands.map((b) => b.label + ': ' + m(b.value)).join(', ')}>
                {ageBands.filter((b) => b.value > 0).map((b) => <span key={b.key} className={b.cls} style={{ width: (b.value / owedBase) * 100 + '%' }} />)}
              </div>
              <dl className="dk-age-legend">
                {ageBands.map((b) => (
                  <div key={b.key}><dt><i className={'dk-swatch ' + b.cls} />{b.label}</dt><dd>{m(b.value)}</dd></div>
                ))}
              </dl>
            </>
          ) : <Empty>{tr('Nothing is owed right now.')}</Empty>}
        </Section>

        <div className="dk-two">
          <Section card id="fd-overdue" title={tr('Overdue invoices')} sub={tr('The longest overdue first, with a number to call.')}>
            {fin.overdueInvoices.length ? (
              <ul className="dk-rows">
                {fin.overdueInvoices.slice(0, 10).map((i) => (
                  <Row key={i.invoiceNo}
                    lead={<span className="dk-lead-icon is-bad"><Icon name="doc" /></span>}
                    title={i.customerName} meta={i.invoiceNo + ' · ' + tr('due {date}', { date: fmtDate(i.dueDate) })}
                    extra={<Phone number={i.phone} />}
                    amount={money(i.amount, i.currency)}
                    side={i.daysOverdue === 1 ? tr('1 day late') : tr('{n} days late', { n: i.daysOverdue })} sideClass="is-bad" />
                ))}
              </ul>
            ) : <Empty>{tr('No overdue invoices.')}</Empty>}
          </Section>
          <Section card title={tr('Falling due in the next 14 days')} sub={tr('A reminder now saves chasing later.')}>
            {fin.dueSoon.length ? (
              <ul className="dk-rows">
                {fin.dueSoon.map((i) => (
                  <Row key={i.invoiceNo}
                    lead={<span className="dk-lead-icon is-warn"><Icon name="calendar" /></span>}
                    title={i.customerName} meta={i.invoiceNo + ' · ' + fmtDate(i.dueDate)}
                    amount={money(i.amount, i.currency)}
                    side={i.daysLeft === 0 ? tr('due today') : i.daysLeft === 1 ? tr('due tomorrow') : tr('in {n} days', { n: i.daysLeft })} sideClass={i.daysLeft <= 3 ? 'is-warn' : ''} />
                ))}
              </ul>
            ) : <Empty>{tr('Nothing falls due in the next 14 days.')}</Empty>}
          </Section>
        </div>

        <div className="dk-two">
          <Section card title={tr('Who owes the most')} sub={tr('Customers with the most unpaid, in {currency}.', { currency: cur })}>
            {fin.topDebtors.length ? (
              <RankList barClass="is-bad" rows={fin.topDebtors.map((d) => ({
                key: d.name, name: d.name, value: d.owed, amount: m(d.owed),
                meta: (d.invoices === 1 ? tr('1 invoice') : tr('{n} invoices', { n: d.invoices })) + (d.oldestDue ? ' · ' + tr('oldest due {date}', { date: fmtDate(d.oldestDue) }) : '')
              }))} />
            ) : <Empty>{tr('Nobody owes anything right now.')}</Empty>}
          </Section>
          <Section card title={tr('Recent payments')} sub={tr('The latest money received.')}>
            {fin.recentPayments.length ? (
              <ul className="dk-rows">
                {fin.recentPayments.map((p, i) => (
                  <Row key={i}
                    lead={<span className="dk-lead-icon is-good"><Icon name="cash" /></span>}
                    title={p.customerName} meta={p.invoiceNo + ' · ' + codeLabel(p.method)}
                    amount={money(p.amount, p.currency)} side={fmtDate(p.date)} />
                ))}
              </ul>
            ) : <Empty icon="cash">{tr('No payments recorded yet.')}</Empty>}
          </Section>
        </div>

        <Spending fin={fin} />
      </div>
    </>
  );
}

function RestaurantFinance({ fin, actions, trend, printRef }) {
  const cur = fin.baseCurrency;
  const m = (n) => money(n, cur);
  const dr = fin.drawers;
  const maxDay = Math.max(1, ...fin.daily.map((d) => d.sales));
  const topMethod = fin.byMethod[0];
  const longWaiting = fin.pendingExpenses.filter((e) => e.daysWaiting > 7);

  const insights = [];
  const salesPct = pctChange(fin.salesThisMonth, fin.salesLastMonthSameDays);
  if (!fin.salesThisMonth) {
    insights.push({ tone: 'info', icon: 'bag', text: tr('No sales have been rung up on the till yet this month.') });
  } else if (salesPct !== null && salesPct !== 0) {
    insights.push({ tone: salesPct > 0 ? 'good' : 'warn', icon: salesPct > 0 ? 'up' : 'down', text: salesPct > 0
      ? tr('{amount} in sales so far this month, {pct}% more than by this day last month.', { amount: m(fin.salesThisMonth), pct: salesPct })
      : tr('{amount} in sales so far this month, {pct}% less than by this day last month.', { amount: m(fin.salesThisMonth), pct: -salesPct }) });
  }
  if (fin.netPositionThisMonth < 0) {
    insights.push({ tone: 'warn', icon: 'scale', text: tr('Costs are ahead of sales this month: {amount}.', { amount: m(fin.netPositionThisMonth) }) });
  } else if (fin.salesThisMonth) {
    insights.push({ tone: 'good', icon: 'scale', text: tr('After this month\'s approved expenses, {amount} is left from sales.', { amount: m(fin.netPositionThisMonth) }) });
  }
  if (topMethod && fin.salesThisMonth) {
    insights.push({ tone: 'info', icon: 'card', text: tr('{pct}% of sales this month were paid by {method}.', { pct: Math.round((topMethod.amount / fin.salesThisMonth) * 100), method: codeLabel(topMethod.method).toLowerCase() }) });
  }
  if (dr.closed && dr.closed > dr.balanced) {
    const vals = { n: dr.closed - dr.balanced, closed: dr.closed, short: m(Math.abs(dr.short)), over: m(dr.over) };
    insights.push({ tone: 'bad', icon: 'drawer', text: dr.short && dr.over
      ? tr('{n} of {closed} cash drawers closed in the last 30 days did not balance: {short} short, {over} over.', vals)
      : dr.short
        ? tr('{n} of {closed} cash drawers closed in the last 30 days were short: {short} in total.', vals)
        : tr('{n} of {closed} cash drawers closed in the last 30 days were over: {over} in total.', vals),
      action: { label: tr('See them'), run: () => jump('fd-drawers') } });
  } else if (dr.closed) {
    insights.push({ tone: 'good', icon: 'drawer', text: tr('All {n} cash drawers closed in the last 30 days balanced.', { n: dr.closed }) });
  }
  if (fin.voidedThisMonth) {
    insights.push({ tone: fin.voidedThisMonth >= 5 ? 'warn' : 'info', icon: 'void', text: fin.voidedThisMonth === 1
      ? tr('1 order worth {amount} was voided this month.', { amount: m(fin.voidedAmountThisMonth) })
      : tr('{n} orders worth {amount} were voided this month: worth checking who and why.', { n: fin.voidedThisMonth, amount: m(fin.voidedAmountThisMonth) }) });
  }
  if (longWaiting.length) {
    insights.push({ tone: 'warn', icon: 'receipt', text: longWaiting.length === 1 ? tr('1 expense claim has waited more than a week for a decision.') : tr('{n} expense claims have waited more than a week for a decision.', { n: longWaiting.length }), action: { label: tr('See them'), run: () => jump('fd-claims') } });
  }

  return (
    <>
      <Hero eyebrow={fin.company.name} title={tr('The till and the costs')}
        sub={tr('What the till took, how guests paid, what was spent, and whether the cash drawers balanced.')}
        actions={actions}
        stats={[
          { icon: 'cash', value: m(fin.salesThisMonth), label: tr('sales this month'), note: <Change now={fin.salesThisMonth} before={fin.salesLastMonthSameDays} label={tr('last month')} /> },
          { icon: 'bag', value: String(fin.ordersThisMonth), label: tr('orders this month'), note: tr('average {amount}', { amount: m(fin.avgOrderThisMonth) }) },
          { icon: 'receipt', value: m(fin.approvedExpensesThisMonth), label: tr('expenses this month'), note: <Change now={fin.approvedExpensesThisMonth} before={fin.approvedExpensesLastMonthSameDays} upIsGood={false} label={tr('last month')} /> },
          { icon: 'scale', value: m(fin.netPositionThisMonth), label: tr('net this month'), note: tr('sales minus expenses'), tone: fin.netPositionThisMonth < 0 ? 'bad' : '' }
        ]} />

      <div ref={printRef} className="dk-body">
        <Insights items={insights} />

        <Section card title={tr('The last 14 days')} sub={tr('Sales day by day. Today is the last bar.')}>
          <div className="dk-days" role="img" aria-label={fin.daily.map((d) => fmtDate(d.date) + ': ' + m(d.sales)).join(', ')}>
            {fin.daily.map((d, i) => (
              <div key={d.date} className={'dk-day' + (i === fin.daily.length - 1 ? ' is-today' : '')} title={fmtDate(d.date) + '\n' + m(d.sales) + '\n' + tr('{n} orders', { n: d.orders })}>
                <div className="dk-day-bar"><span style={{ height: Math.max(d.sales ? 3 : 0, Math.round((d.sales / maxDay) * 100)) + '%' }} /></div>
                <span className="dk-day-label">{new Date(d.date + 'T00:00').getDate()}</span>
              </div>
            ))}
          </div>
        </Section>

        {trend}

        <div className="dk-two">
          <Section card title={tr('How guests paid')} sub={tr('Sales so far this month, by payment method.')}>
            {fin.byMethod.length ? (
              <RankList barClass="is-info" rows={fin.byMethod.map((x) => ({
                key: x.method, name: codeLabel(x.method), value: x.amount, amount: m(x.amount),
                meta: (x.orders === 1 ? tr('1 order') : tr('{n} orders', { n: x.orders })) + ' · ' + tr('{pct}% of sales', { pct: fin.salesThisMonth ? Math.round((x.amount / fin.salesThisMonth) * 100) : 0 })
              }))} />
            ) : <Empty icon="card">{tr('No sales yet this month.')}</Empty>}
          </Section>
          <Section card id="fd-drawers" title={tr('Cash drawers')} sub={tr('Shifts closed in the last 30 days: did the cash counted match what the till expected?')}>
            <dl className="dk-sum">
              <div><dt>{tr('Balanced')}</dt><dd className="is-good">{dr.balanced}/{dr.closed}</dd></div>
              <div><dt>{tr('Short')}</dt><dd className={dr.short < 0 ? 'is-bad' : ''}>{m(Math.abs(dr.short))}</dd></div>
              <div><dt>{tr('Over')}</dt><dd>{m(dr.over)}</dd></div>
            </dl>
            {dr.mismatches.length ? (
              <ul className="dk-rows">
                {dr.mismatches.map((x, i) => (
                  <Row key={i}
                    lead={<span className="dk-avatar" style={{ background: avatarColor(x.cashierName) }} aria-hidden="true">{initials(x.cashierName)}</span>}
                    title={x.cashierName} meta={fmtDate(x.date) + ' · ' + tr('expected {expected}, counted {actual}', { expected: m(x.expected), actual: m(x.actual) }) + (x.note ? ' · ' + x.note : '')}
                    amount={(x.difference > 0 ? '+' : '−') + m(Math.abs(x.difference))}
                    side={x.difference < 0 ? tr('short') : tr('over')} sideClass={x.difference < 0 ? 'is-bad' : 'is-warn'} />
                ))}
              </ul>
            ) : <Empty icon="drawer">{dr.closed ? tr('Every drawer closed in the last 30 days balanced.') : tr('No cash drawer has been closed in the last 30 days.')}</Empty>}
            {dr.open > 0 && <p className="dk-muted">{dr.open === 1 ? tr('1 drawer is still open.') : tr('{n} drawers are still open.', { n: dr.open })}</p>}
          </Section>
        </div>

        <Spending fin={fin} />
      </div>
    </>
  );
}
