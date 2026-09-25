import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { CompanySwitcher, Glossary, Hero, Insights, PairBars, RankList, Section, jump } from '../components/DashKit';
import { money, moneyBreakdown } from '../lib/currency';
import { downloadCsv, rowsToCsv } from '../lib/csvExport';
import { activeIntlLocale, tr, msg } from '../lib/i18n.jsx';
import { formatDate } from '../lib/dates';
import './ToolRoomPage.css';
import './EmployeesPage.css';
import './ReportsPage.css';

// Reports — how one company did over a period (reports.service.js summary):
// what it invoiced and collected, what is still owed, what it spent on
// expense claims and payroll, how its quotations went and who it invoiced
// most, with twelve months of money in against money out. Same "explains
// itself" layout as the dashboards (components/DashKit.jsx). Money is kept
// per currency; the monthly chart and table are in the base currency.
// The Finance dashboard shows this month as it happens; this page answers
// "how did we do" for any period, and downloads it as a spreadsheet.

const PRESETS = [
  { key: 'month', label: msg('This month') }, { key: 'last', label: msg('Last month') }, { key: 'quarter', label: msg('This quarter') },
  { key: 'year', label: msg('This year') }, { key: 'twelve', label: msg('Last 12 months') }, { key: 'custom', label: msg('Choose dates') }
];

function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function rangeFor(key) {
  const t = new Date(); const y = t.getFullYear(); const m = t.getMonth();
  if (key === 'last') return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
  if (key === 'quarter') return { from: iso(new Date(y, m - (m % 3), 1)), to: iso(t) };
  if (key === 'year') return { from: iso(new Date(y, 0, 1)), to: iso(t) };
  if (key === 'twelve') return { from: iso(new Date(y, m - 11, 1)), to: iso(t) };
  return { from: iso(new Date(y, m, 1)), to: iso(t) };
}
function monthLabel(key) { return new Date(key + '-01T00:00').toLocaleDateString(activeIntlLocale(), { month: 'short', year: '2-digit' }); }
function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function inBase(list, base) { return (list.find((r) => r.currency === base) || { amount: 0 }).amount; }

export default function ReportsPage() {
  const navigate = useNavigate();
  const [companies, setCompanies] = useState([]);
  const [company, setCompany] = useState(() => readPref('bos.reportsCompany', 'BPL'));
  const [preset, setPreset] = useState('month');
  const [range, setRange] = useState(() => rangeFor('month'));
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { api.get('/reports/commercial/companies').then(setCompanies).catch(() => setCompanies([])); }, []);
  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get('/reports/summary?company=' + encodeURIComponent(company) + '&from=' + range.from + '&to=' + range.to));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [company, range]);
  useEffect(() => { load(); }, [load]);

  function pickPreset(key) { setPreset(key); if (key !== 'custom') setRange(rangeFor(key)); }
  function pickCompany(code) { setCompany(code); writePref('bos.reportsCompany', code); }

  if (loading && !data) return <div className="eyebrow">{tr('Loading…')}</div>;
  if (!data) return <div className="error-banner">{error}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const d = data;
  const base = d.baseCurrency;
  const spent = d.expenses.total + d.payroll.cost;
  const overdue = d.owed.filter((r) => r.overdue > 0).map((r) => ({ currency: r.currency, amount: r.overdue }));
  const inv = inBase(d.invoiced, base), col = inBase(d.collected, base);
  const answered = d.quotations.accepted + d.quotations.rejected + d.quotations.expired;
  const winRate = answered ? Math.round((d.quotations.accepted / answered) * 100) : null;
  const periodText = formatDate(d.from) + ' – ' + formatDate(d.to);

  const stats = [
    { icon: 'doc', value: moneyBreakdown(d.invoiced, money(0)), label: tr('invoiced'), note: tr('{n} invoices, voided ones left out', { n: d.invoiced.reduce((s, r) => s + r.count, 0) }), onClick: () => navigate('/invoices') },
    { icon: 'cash', value: moneyBreakdown(d.collected, money(0)), label: tr('collected'), note: inv > 0 ? tr('{pct}% of what was invoiced', { pct: Math.round((col / inv) * 100) }) : tr('{n} payments', { n: d.collected.reduce((s, r) => s + r.count, 0) }), tone: d.collected.length ? 'good' : '', onClick: () => navigate('/payments') },
    { icon: 'owed', value: moneyBreakdown(d.owed, money(0)), label: tr('owed to us now'), note: overdue.length ? tr('{amount} of it overdue', { amount: moneyBreakdown(overdue) }) : tr('nothing overdue'), tone: overdue.length ? 'bad' : '', onClick: () => navigate('/invoices') },
    { icon: 'down', value: money(spent), label: tr('spent'), note: tr('claims {a} · payroll {b}', { a: money(d.expenses.total), b: money(d.payroll.cost) }), onClick: () => jump('rp-spend') }
  ];

  const insights = [];
  if (inv > 0 && col < inv * 0.6) insights.push({ tone: 'warn', icon: 'owed', text: tr('Only {pct}% of what was invoiced in {base} came in over the period.', { pct: Math.round((col / inv) * 100), base }), action: { label: tr('Payment reminders'), run: () => navigate('/reminders') } });
  if (overdue.length) insights.push({ tone: 'bad', icon: 'warn', text: tr('{amount} is overdue right now.', { amount: moneyBreakdown(overdue) }), action: { label: tr('Invoices'), run: () => navigate('/invoices') } });
  if (col > 0 && spent > col) insights.push({ tone: 'warn', icon: 'down', text: tr('More went out ({out}) than came in ({in}) over the period, counting claims and payroll.', { out: money(spent), in: money(col, base) }), action: null });
  if (d.expenses.byCategory.length) insights.push({ tone: 'info', icon: 'receipt', text: tr('{category} was the biggest expense: {amount}.', { category: d.expenses.byCategory[0].category, amount: money(d.expenses.byCategory[0].amount) }), action: { label: tr('Expenses'), run: () => navigate('/expenses') } });
  if (winRate !== null) insights.push({ tone: winRate >= 50 ? 'good' : 'info', icon: 'percent', text: tr('{won} of {n} quotations answered in the period were won ({pct}%).', { won: d.quotations.accepted, n: answered, pct: winRate }), action: { label: tr('Quotations'), run: () => navigate('/quotations') } });
  if (d.expenses.pendingCount) insights.push({ tone: 'info', icon: 'clock', text: d.expenses.pendingCount === 1 ? tr('1 expense claim ({amount}) is still waiting for a decision and isn\'t counted yet.', { amount: money(d.expenses.pending) }) : tr('{n} expense claims ({amount}) are still waiting for a decision and aren\'t counted yet.', { n: d.expenses.pendingCount, amount: money(d.expenses.pending) }), action: { label: tr('Expenses'), run: () => navigate('/expenses') } });
  if (!d.invoiced.length && !d.collected.length && !spent) insights.push({ tone: 'info', icon: 'info', text: tr('Nothing was invoiced, collected or spent in this period.') });

  const spendRows = d.expenses.byCategory.map((r) => ({ key: r.category, name: r.category, amount: money(r.amount), value: r.amount }));
  if (d.payroll.cost > 0) spendRows.push({ key: '__payroll', name: tr('Payroll (cost)'), amount: money(d.payroll.cost), value: d.payroll.cost });
  spendRows.sort((a, b) => b.value - a.value);

  function exportCsv() {
    const rows = [[tr('Report'), d.company.name, periodText], [], [tr('Invoiced')].concat(d.invoiced.map((r) => r.currency + ' ' + r.amount)),
      [tr('Collected')].concat(d.collected.map((r) => r.currency + ' ' + r.amount)), [tr('Owed now')].concat(d.owed.map((r) => r.currency + ' ' + r.amount)),
      [tr('Expense claims'), d.expenses.total], [tr('Payroll cost'), d.payroll.cost], [tr('Take-home pay'), d.payroll.net], ['PAYE', d.payroll.paye], [tr('SSNIT, staff + employer'), d.payroll.ssnitEmployee + d.payroll.ssnitEmployer], [],
      [tr('Month'), tr('Invoiced') + ' (' + base + ')', tr('Collected') + ' (' + base + ')', tr('Expense claims'), tr('Payroll cost')]]
      .concat(d.months.map((m) => [m.month, m.invoiced, m.collected, m.expenses, m.payroll]))
      .concat([[], [tr('Category'), tr('Amount')]]).concat(d.expenses.byCategory.map((r) => [r.category, r.amount]))
      .concat([[], [tr('Customer'), tr('Currency'), tr('Invoiced')]]).concat(d.topCustomers.map((r) => [r.name, r.currency, r.amount]));
    downloadCsv('report-' + d.company.code.toLowerCase() + '-' + d.from + '-' + d.to + '.csv', rowsToCsv(rows));
  }

  return (
    <div className={'dk tl rp' + (loading ? ' is-loading' : '')}>
      {error && <div className="error-banner" role="alert">{error}</div>}

      <CompanySwitcher companies={companies} company={company} onPick={pickCompany} />

      <Hero
        eyebrow={tr('Finance')}
        title={tr('Reports')}
        sub={tr('How {company} did over {period}: what was invoiced and collected, what is still owed, and what went out on expense claims and payroll.', { company: d.company.name, period: periodText })}
        actions={<button type="button" className="btn btn-secondary" onClick={exportCsv}>{tr('Download CSV')}</button>}
        stats={stats} />

      <div className="rp-period" role="radiogroup" aria-label={tr('Period')}>
        {PRESETS.map((p) => <button key={p.key} type="button" role="radio" aria-checked={preset === p.key} className={'ppl-chip' + (preset === p.key ? ' is-on' : '')} onClick={() => pickPreset(p.key)}>{tr(p.label)}</button>)}
        {preset === 'custom' && (
          <span className="rp-dates">
            <input className="input" type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} aria-label={tr('From')} />
            <span aria-hidden="true">–</span>
            <input className="input" type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} aria-label={tr('To')} />
          </span>
        )}
      </div>

      <Insights items={insights.slice(0, 5)} />

      <Section id="rp-months" title={tr('Money in and money out, by month')} sub={tr('The twelve months ending with the period, in {base}. Money out is approved expense claims plus payroll cost.', { base })} card>
        <PairBars rows={d.months.map((m) => ({ label: monthLabel(m.month), a: m.collected, b: m.expenses + m.payroll }))} aLabel={tr('Collected')} bLabel={tr('Expense claims and payroll')} format={(n) => money(n, base)} />
        <details className="rp-table">
          <summary>{tr('Show the figures')}</summary>
          <div className="tl-table-wrap">
            <table className="tl-table">
              <thead><tr><th>{tr('Month')}</th><th className="is-num">{tr('Invoiced')}</th><th className="is-num">{tr('Collected')}</th><th className="is-num">{tr('Expense claims')}</th><th className="is-num">{tr('Payroll cost')}</th><th className="is-num">{tr('In less out')}</th></tr></thead>
              <tbody>
                {d.months.map((m) => {
                  const net = m.collected - m.expenses - m.payroll;
                  return (
                    <tr key={m.month}>
                      <td>{monthLabel(m.month)}</td>
                      <td className="is-num">{money(m.invoiced, base)}</td>
                      <td className="is-num">{money(m.collected, base)}</td>
                      <td className="is-num">{money(m.expenses, base)}</td>
                      <td className="is-num">{money(m.payroll, base)}</td>
                      <td className={'is-num' + (net < 0 ? ' pk-owe' : '')}>{money(net, base)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      </Section>

      <div className="rp-pair">
        <Section id="rp-spend" title={tr('Where the money went')} sub={tr('Approved expense claims by category, and payroll, over the period.')} card>
          {spendRows.length ? <RankList rows={spendRows.slice(0, 10)} /> : <p className="dk-muted tl-small">{tr('Nothing spent in this period.')}</p>}
          {d.payroll.runs > 0 && (
            <dl className="tl-facts rp-facts">
              <div><dt>{tr('Take-home pay')}</dt><dd>{money(d.payroll.net)}</dd></div>
              <div><dt>PAYE</dt><dd>{money(d.payroll.paye)}</dd></div>
              <div><dt>{tr('SSNIT, staff + employer')}</dt><dd>{money(d.payroll.ssnitEmployee + d.payroll.ssnitEmployer)}</dd></div>
            </dl>
          )}
        </Section>
        <Section id="rp-clients" title={tr('Clients invoiced most')} sub={tr('Voided invoices left out.')} card>
          {d.topCustomers.length ? <RankList rows={d.topCustomers.map((c) => ({ key: c.id + c.currency, name: c.name, amount: money(c.amount, c.currency) + ' · ' + (c.invoices === 1 ? tr('1 invoice') : tr('{n} invoices', { n: c.invoices })), value: c.currency === base ? c.amount : 0 }))} /> : <p className="dk-muted tl-small">{tr('Nothing invoiced in this period.')}</p>}
        </Section>
      </div>

      <Section id="rp-quotes" title={tr('Quotations and orders')} sub={tr('Counted by when they were sent or answered in the period.')} card>
        <dl className="tl-facts rp-facts">
          <div><dt>{tr('Sent')}</dt><dd><strong>{d.quotations.sent}</strong></dd></div>
          <div><dt>{tr('Accepted')}</dt><dd><strong>{d.quotations.accepted}</strong></dd></div>
          <div><dt>{tr('Turned down')}</dt><dd>{d.quotations.rejected}</dd></div>
          <div><dt>{tr('Expired unanswered')}</dt><dd>{d.quotations.expired}</dd></div>
          <div><dt>{tr('Won')}</dt><dd>{winRate === null ? '—' : winRate + '%'}</dd></div>
          <div><dt>{tr('Sales orders')}</dt><dd>{d.orders}</dd></div>
        </dl>
      </Section>

      <Glossary items={[
        [tr('Invoiced'), tr('Invoices issued in the period, voided ones left out, added up in each currency.')],
        [tr('Collected'), tr('Payments received in the period, by the day the money came in, part-payments included.')],
        [tr('Owed to us now'), tr('What is still to pay on unpaid and part-paid invoices today, whatever the period.')],
        [tr('Spent'), tr('Approved and paid expense claims dated in the period, plus payroll cost: gross pay and the employer\'s SSNIT for runs approved or paid with a pay date in the period.')],
        [tr('In less out'), tr('Money collected less expense claims and payroll cost, in the base currency. It leaves out purchases and other costs, so it isn\'t profit — see Financial reports for that.')]
      ]} />
    </div>
  );
}
