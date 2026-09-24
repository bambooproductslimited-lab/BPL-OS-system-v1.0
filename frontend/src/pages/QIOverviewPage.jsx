import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { money, moneyBreakdown } from '../lib/currency';
import { rowsToCsv, downloadCsv } from '../lib/csvExport';
import { shareOrDownloadPdf } from '../lib/documentShare';
import { tr } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import {
  CompanySwitcher, Empty, Glossary, Hero, Icon, Insights, LinkButton, PairBars, Phone, Row, Section, Status,
  fmtDate, jump, useCompany
} from '../components/DashKit';

// Backed by GET /api/reports/commercial (reportsService.commercialDashboard,
// report.read), one company at a time — Bamboo Products and any company
// with its own customers and invoices (Poki); the restaurants have no
// quotations or invoices. The switcher at the top picks the company
// (?company=PKI, remembered on this device).
//
// Follows a sale from quote to cash: how many quotations are drafts,
// waiting or won; what was invoiced and what came in; how long customers
// take to pay; and the invoices falling due or overdue — led by a "what
// stands out" list written from the numbers, ending with what the words
// mean.

function quoteTone(status) {
  if (status === 'accepted') return 'good';
  if (status === 'rejected' || status === 'expired') return 'bad';
  if (status === 'draft') return 'muted';
  return 'info';
}
function invoiceTone(iv) {
  if (iv.status === 'paid') return 'good';
  if (iv.status === 'void') return 'muted';
  if (iv.status === 'partially_paid') return 'warn';
  return 'info';
}

function csvRows(d) {
  return [
    [tr('Quotations & invoicing overview'), d.company.name, new Date().toISOString().slice(0, 10)],
    [],
    [tr('Quotations')],
    [tr('Total'), d.totalQuotations], [tr('Drafts'), d.draftQuotations], [tr('Waiting for an answer'), d.awaitingResponse],
    [tr('Accepted'), d.acceptedQuotations], [tr('Rejected'), d.rejectedQuotations], [tr('Expired'), d.expiredQuotations], [tr('Conversion rate'), d.conversionRate + '%'],
    [],
    [tr('Invoices')],
    [tr('Total'), d.totalInvoices], [tr('Paid'), d.paidInvoices], [tr('Overdue'), d.overdueCount],
    ...d.outstandingByCurrency.map((r) => [tr('Outstanding ({currency})', { currency: r.currency }), r.amount]),
    [tr('Average days to pay'), d.averageDaysToPay === null ? '' : d.averageDaysToPay],
    [],
    [tr('Month'), tr('Invoiced ({currency})', { currency: d.baseCurrency }), tr('Collected ({currency})', { currency: d.baseCurrency })],
    ...d.monthly.map((m) => [m.month, m.invoiced, m.paid]),
    [],
    [tr('Overdue invoices')],
    [tr('Invoice'), tr('Customer'), tr('Currency'), tr('Balance due'), tr('Due')],
    ...d.overdueInvoices.map((i) => [i.invoiceNo, i.customerName, i.currency, i.balanceDue, i.dueDate || ''])
  ];
}

export default function QIOverviewPage() {
  const navigate = useNavigate();
  const { company, companies, switchTo } = useCompany('bos.qiCompany', '/reports/commercial/companies');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);
  const printRef = useRef(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get('/reports/commercial?company=' + encodeURIComponent(company)));
    } catch (err) {
      setError(err.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [company]);
  useEffect(() => { load(); }, [load]);

  async function downloadPdf() {
    setExporting(true);
    try {
      await shareOrDownloadPdf(printRef.current, 'quotations-invoicing-' + company.toLowerCase() + '-' + new Date().toISOString().slice(0, 10) + '.pdf', tr('Quotations & invoicing overview') + ' — ' + data.company.name, tr('Quotations & invoicing overview'));
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  }

  const switcher = <CompanySwitcher companies={companies} company={company} onPick={(c) => { setLoading(true); switchTo(c); }} />;
  if (loading) return <div className="dk">{switcher}<div className="eyebrow">{tr('Loading…')}</div></div>;
  if (!data) return <div className="dk">{switcher}<div className="error-banner">{error}</div></div>;

  const d = data;
  const cur = d.baseCurrency;
  const m = (n) => money(n, cur);
  const soon = d.upcomingDue.filter((i) => i.days !== null && i.days <= 7);
  const oldest = d.overdueInvoices[0];
  const last = d.monthly[d.monthly.length - 1];

  const insights = [];
  if (d.sentQuotations) {
    insights.push({ tone: d.conversionRate >= 40 ? 'good' : d.conversionRate < 20 ? 'warn' : 'info', icon: 'percent', text: tr('{rate}% of quotations sent were accepted ({accepted} of {sent}).', { rate: d.conversionRate, accepted: d.acceptedQuotations, sent: d.sentQuotations }) });
  }
  if (d.awaitingResponse) {
    insights.push({ tone: 'info', icon: 'clock', text: d.awaitingResponse === 1
      ? tr('1 quotation worth {amount} is waiting for the customer\'s answer.', { amount: moneyBreakdown(d.awaitingValueByCurrency) })
      : tr('{n} quotations worth {amount} are waiting for the customer\'s answer.', { n: d.awaitingResponse, amount: moneyBreakdown(d.awaitingValueByCurrency) }),
      action: { label: tr('Open quotations'), run: () => navigate('/quotations') } });
  }
  if (d.draftQuotations) {
    insights.push({ tone: 'warn', icon: 'send', text: d.draftQuotations === 1 ? tr('1 quotation is still a draft: not sent to the customer yet.') : tr('{n} quotations are still drafts: not sent to the customers yet.', { n: d.draftQuotations }) });
  }
  if (oldest) {
    insights.push({ tone: 'bad', icon: 'warn', text: d.overdueCount === 1
      ? tr('1 invoice is overdue: {customer}, {days} days late.', { customer: oldest.customerName, days: -oldest.days })
      : tr('{n} invoices are overdue. The oldest is {customer}\'s, {days} days late.', { n: d.overdueCount, customer: oldest.customerName, days: -oldest.days }),
      action: { label: tr('See them'), run: () => jump('qi-overdue') } });
  }
  if (soon.length) {
    insights.push({ tone: 'info', icon: 'calendar', text: soon.length === 1 ? tr('1 invoice falls due within a week.') : tr('{n} invoices fall due within a week.', { n: soon.length }) });
  }
  if (d.averageDaysToPay !== null && d.averageDaysToPay !== undefined) {
    insights.push({ tone: d.averageDaysToPay > 45 ? 'warn' : 'info', icon: 'owed', text: tr('Customers take {n} days on average to pay an invoice (payments in the last 6 months).', { n: d.averageDaysToPay }) });
  }
  if (d.collectionRate !== null && d.collectionRate !== undefined) {
    insights.push({ tone: d.collectionRate >= 80 ? 'good' : 'info', icon: 'cash', text: tr('{pct}% of everything invoiced in {currency} has been paid.', { pct: d.collectionRate, currency: cur }) });
  }
  if (last && last.invoiced > 0 && last.paid < last.invoiced / 2) {
    insights.push({ tone: 'warn', icon: 'down', text: tr('This month {collected} has come in against {invoiced} invoiced.', { collected: m(last.paid), invoiced: m(last.invoiced) }) });
  }

  const quoteFlow = [
    { key: 'draft', cls: 'is-muted', label: tr('Drafts'), n: d.draftQuotations, help: tr('Being prepared, not sent yet.') },
    { key: 'waiting', cls: '', label: tr('Waiting for an answer'), n: d.awaitingResponse, value: moneyBreakdown(d.awaitingValueByCurrency, ''), help: tr('Sent or opened by the customer.') },
    { key: 'accepted', cls: 'is-good', label: tr('Accepted'), n: d.acceptedQuotations, value: moneyBreakdown(d.acceptedValueByCurrency, ''), help: tr('Won: ready to invoice.') },
    { key: 'lost', cls: 'is-bad', label: tr('Rejected or expired'), n: d.rejectedQuotations + d.expiredQuotations, help: tr('{r} turned down, {e} ran out of time.', { r: d.rejectedQuotations, e: d.expiredQuotations }) }
  ];
  const invoiceFlow = [
    { key: 'issued', cls: '', label: tr('Invoiced'), n: d.totalInvoices, value: moneyBreakdown(d.totalInvoicedByCurrency, ''), help: tr('Every invoice issued (not voided).') },
    { key: 'paid', cls: 'is-good', label: tr('Collected'), n: d.paidInvoices, value: moneyBreakdown(d.totalPaidByCurrency, ''), help: tr('Paid so far, including part-payments.') },
    { key: 'open', cls: 'is-warn', label: tr('Still owed'), value: moneyBreakdown(d.outstandingByCurrency, m(0)), help: tr('Not fully paid yet.') },
    { key: 'overdue', cls: 'is-bad', label: tr('Overdue'), n: d.overdueCount, value: moneyBreakdown(d.overdueAmountByCurrency, ''), help: tr('Past the due date.') }
  ];

  return (
    <div className="dk">
      {error && <div className="error-banner" role="alert">{error}</div>}
      {switcher}
      <Hero eyebrow={d.company.name} title={tr('From quote to cash')}
        sub={tr('Every sale\'s path: the quotation, whether it was won, the invoice, and whether it has been paid.')}
        actions={<>
          <button type="button" className="btn btn-secondary" onClick={() => downloadCsv('quotations-invoicing-' + company.toLowerCase() + '-' + new Date().toISOString().slice(0, 10) + '.csv', rowsToCsv(csvRows(d)))}>{tr('Download CSV')}</button>
          <button type="button" className="btn btn-secondary" disabled={exporting} onClick={downloadPdf}>{exporting ? tr('Preparing…') : tr('Download PDF')}</button>
        </>}
        stats={[
          { icon: 'clock', value: String(d.awaitingResponse), label: tr('quotations waiting'), note: moneyBreakdown(d.awaitingValueByCurrency, tr('nothing waiting')), onClick: () => jump('qi-flow') },
          { icon: 'percent', value: d.conversionRate + '%', label: tr('conversion rate'), note: tr('{accepted} of {sent} sent were accepted', { accepted: d.acceptedQuotations, sent: d.sentQuotations }) },
          { icon: 'owed', value: moneyBreakdown(d.outstandingByCurrency, m(0)), label: tr('still owed'), note: d.overdueCount ? tr('{n} overdue', { n: d.overdueCount }) : tr('nothing overdue'), tone: d.overdueCount ? 'bad' : '', onClick: () => jump('qi-overdue') },
          { icon: 'cash', value: d.averageDaysToPay === null || d.averageDaysToPay === undefined ? '—' : tr('{n} days', { n: d.averageDaysToPay }), label: tr('average time to pay'), note: d.collectionRate === null || d.collectionRate === undefined ? tr('no payments yet') : tr('{pct}% of invoiced collected', { pct: d.collectionRate }) }
        ]} />

      <div ref={printRef} className="dk-body">
        <Insights items={insights} />

        <Section id="qi-flow" title={tr('Quotations')} sub={tr('Where every quotation stands.')} action={<LinkButton onClick={() => navigate('/quotations')}>{tr('Open quotations')}</LinkButton>}>
          <ul className="dk-flow">
            {quoteFlow.map((s) => (
              <li key={s.key} className={s.cls}>
                <span className="dk-flow-name">{s.label}</span>
                <span className="dk-flow-n">{s.n}</span>
                {s.value && <span className="dk-flow-value">{s.value}</span>}
                <span className="dk-flow-help">{s.help}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title={tr('Invoices')} sub={tr('What was billed and what has come in.')} action={<LinkButton onClick={() => navigate('/invoices')}>{tr('Open invoices')}</LinkButton>}>
          <ul className="dk-flow">
            {invoiceFlow.map((s) => (
              <li key={s.key} className={s.cls}>
                <span className="dk-flow-name">{s.label}</span>
                {s.n !== undefined && <span className="dk-flow-n">{s.n}</span>}
                {s.value && <span className={s.n === undefined ? 'dk-flow-n' : 'dk-flow-value'}>{s.value}</span>}
                <span className="dk-flow-help">{s.help}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section card title={tr('Invoiced against collected')} sub={tr('The last 6 months, in {currency}. When the green bar keeps up with the blue, customers are paying on time.', { currency: cur })}>
          <PairBars rows={d.monthly.map((x) => ({ label: x.month, a: x.invoiced, b: x.paid }))} aLabel={tr('Invoiced')} bLabel={tr('Collected')} aClass="is-info-bar" bClass="is-in" format={m} />
        </Section>

        <div className="dk-two">
          <Section card id="qi-overdue" title={tr('Overdue invoices')} sub={tr('The longest overdue first, with a number to call.')}>
            {d.overdueInvoices.length ? (
              <ul className="dk-rows">
                {d.overdueInvoices.slice(0, 10).map((i) => (
                  <Row key={i.invoiceNo}
                    lead={<span className="dk-lead-icon is-bad"><Icon name="doc" /></span>}
                    title={i.customerName} meta={i.invoiceNo + ' · ' + tr('due {date}', { date: fmtDate(i.dueDate) })}
                    extra={<Phone number={i.phone} />}
                    amount={money(i.balanceDue, i.currency)}
                    side={-i.days === 1 ? tr('1 day late') : tr('{n} days late', { n: -i.days })} sideClass="is-bad" />
                ))}
              </ul>
            ) : <Empty>{tr('No overdue invoices.')}</Empty>}
          </Section>
          <Section card title={tr('Falling due next')} sub={tr('Unpaid invoices by due date.')}>
            {d.upcomingDue.length ? (
              <ul className="dk-rows">
                {d.upcomingDue.map((i) => (
                  <Row key={i.invoiceNo}
                    lead={<span className="dk-lead-icon is-warn"><Icon name="calendar" /></span>}
                    title={i.customerName} meta={i.invoiceNo + ' · ' + fmtDate(i.dueDate)}
                    amount={money(i.balanceDue, i.currency)}
                    side={i.days === 0 ? tr('due today') : i.days === 1 ? tr('due tomorrow') : tr('in {n} days', { n: i.days })} sideClass={i.days <= 3 ? 'is-warn' : ''} />
                ))}
              </ul>
            ) : <Empty>{tr('No unpaid invoice is coming due.')}</Empty>}
          </Section>
        </div>

        <div className="dk-two">
          <Section card title={tr('Recent quotations')} sub={tr('The five latest.')}>
            {d.recentQuotes.length ? (
              <ul className="dk-rows">
                {d.recentQuotes.map((q) => (
                  <Row key={q.quoteNo}
                    lead={<span className="dk-lead-icon"><Icon name="doc" /></span>}
                    title={q.customerName} meta={q.quoteNo + (q.createdAt ? ' · ' + fmtDate(q.createdAt) : '')}
                    amount={money(q.grandTotal, q.currency)} side={<Status tone={quoteTone(q.status)}>{codeLabel(q.status)}</Status>} />
                ))}
              </ul>
            ) : <Empty icon="doc">{tr('No quotations yet.')}</Empty>}
          </Section>
          <Section card title={tr('Recent invoices')} sub={tr('The five latest, with what is left to pay.')}>
            {d.recentInvoices.length ? (
              <ul className="dk-rows">
                {d.recentInvoices.map((iv) => (
                  <Row key={iv.invoiceNo}
                    lead={<span className="dk-lead-icon is-good"><Icon name="receipt" /></span>}
                    title={iv.customerName} meta={iv.invoiceNo + (iv.issuedAt ? ' · ' + fmtDate(iv.issuedAt) : '') + (iv.balanceDue && iv.status !== 'paid' && iv.status !== 'void' ? ' · ' + tr('{amount} left', { amount: money(iv.balanceDue, iv.currency) }) : '')}
                    amount={money(iv.grandTotal, iv.currency)} side={<Status tone={invoiceTone(iv)}>{codeLabel(iv.status)}</Status>} />
                ))}
              </ul>
            ) : <Empty icon="receipt">{tr('No invoices yet.')}</Empty>}
          </Section>
        </div>

        <Section card title={tr('Recent payments')} sub={tr('The latest money received.')}>
          {d.recentPayments.length ? (
            <ul className="dk-rows">
              {d.recentPayments.map((p, i) => (
                <Row key={i}
                  lead={<span className="dk-lead-icon is-good"><Icon name="cash" /></span>}
                  title={p.customerName} meta={p.invoiceNo + (p.method ? ' · ' + codeLabel(p.method) : '')}
                  amount={money(p.amount, p.currency)} side={fmtDate(p.date)} />
              ))}
            </ul>
          ) : <Empty icon="cash">{tr('No payments recorded yet.')}</Empty>}
        </Section>
      </div>

      <Glossary items={[
        [tr('Quotation'), tr('A priced offer to a customer. It waits for their answer until they accept or reject it, or it passes its valid-until date and expires.')],
        [tr('Conversion rate'), tr('Accepted quotations out of all quotations sent. Higher means more offers turn into sales.')],
        [tr('Invoice'), tr('The bill for work or goods, with a due date.')],
        [tr('Still owed'), tr('What customers have not paid yet on their invoices.')],
        [tr('Overdue'), tr('Still owed on an invoice whose due date has passed.')],
        [tr('Average time to pay'), tr('Days from the invoice date to the payment, averaged over payments in the last 6 months.')]
      ]} />
    </div>
  );
}
