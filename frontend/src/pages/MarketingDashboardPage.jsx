import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { rowsToCsv, downloadCsv } from '../lib/csvExport';
import { shareOrDownloadPdf } from '../lib/documentShare';
import MarketingRecommendations from '../components/MarketingRecommendations';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './MarketingDashboardPage.css';
import { codeLabel } from '../lib/codeLabels.js';

// Ported from Bamboo OS.dc.html's marketing screen, backed by
// GET /api/reports/marketing (reportsService.marketingDashboard, requires
// customer.read — same permission navModel.js gates this nav entry on).
//
// Laid out to explain itself, like the social tracker: a header with the
// four numbers that matter, a "what stands out" list written from them,
// the customer journey stage by stage with what each stage means, the
// quotation funnel as bars plus the quotations still waiting for an
// answer (soonest to expire first), top customers, and the leads and
// prospects to follow up as cards with a way to reach each one.

const AVATAR_COLORS = ['#3f7d3b', '#2f5f2c', '#7d5c3f', '#3f5a7d', '#7d3f5c', '#5c3f7d', '#7d6b3f', '#3f7d6b'];
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return ((parts[0] ? parts[0][0] : '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function avatarColor(name) { return AVATAR_COLORS[hashStr(name || '') % AVATAR_COLORS.length]; }

function Icon({ name }) {
  const paths = {
    people: <><circle cx="9" cy="8.5" r="3" /><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8M15.5 5.8a3 3 0 0 1 0 5.4M17.5 14.6c1.6.7 2.6 2.2 3 4.4" /></>,
    target: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" fill="currentColor" /></>,
    doc: <><rect x="5" y="3.5" width="14" height="17" rx="1.5" /><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" /></>,
    clock: <><circle cx="12" cy="12" r="8" /><path d="M12 7.5V12l3 2" /></>,
    percent: <><path d="M6 18 18 6" /><circle cx="7.5" cy="7.5" r="2" /><circle cx="16.5" cy="16.5" r="2" /></>,
    building: <><rect x="5" y="3.5" width="9" height="17" /><rect x="14" y="9" width="5.5" height="11.5" /><path d="M8 7.5h1M8 11h1M8 14.5h1M11 7.5h.5M11 11h.5M11 14.5h.5" /></>,
    trophy: <><path d="M8 4.5h8v4a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 3.5M16 6h3a3 3 0 0 1-3 3.5M12 12.5V16M8.5 20h7M9.5 16h5v4h-5z" /></>,
    spark: <path d="M12 3.5 13.8 9l5.7 1.5-5.7 1.6L12 17.5l-1.8-5.4-5.7-1.6L10.2 9zM18.5 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />,
    info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8v.1" /></>,
    arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
    up: <path d="M12 19V5M6 11l6-6 6 6" />,
    warn: <><path d="M12 4 21 19.5H3z" /><path d="M12 10v4.5M12 17v.1" /></>,
    mail: <><rect x="3.5" y="5.5" width="17" height="13" rx="1.5" /><path d="m4 6.5 8 6 8-6" /></>,
    phone: <path d="M6.5 4h3l1.5 4-2 1.2a10 10 0 0 0 5.8 5.8L16 13l4 1.5v3a2 2 0 0 1-2.2 2A15.5 15.5 0 0 1 4.5 6.2 2 2 0 0 1 6.5 4z" />,
    user: <><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" /></>,
    social: <path d="M4.5 18.5 5.6 15A7 7 0 1 1 8.9 17.6z" />,
    check: <path d="m5 12.5 4.5 4.5L19 7.5" />
  };
  return (
    <svg className="md-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

// Each stage of the customer journey, in order, with what it means.
const STAGES = [
  { key: 'lead', label: msg('Lead'), help: msg('First contact: we know of them, but no business talk yet.') },
  { key: 'prospect', label: msg('Prospect'), help: msg('Interested and talking business, often with a quotation.') },
  { key: 'active', label: msg('Active'), help: msg('Buying from us.') },
  { key: 'vip', label: msg('VIP'), help: msg('Our most valuable, regular customers.') },
  { key: 'inactive', label: msg('Inactive'), help: msg('Have not bought in a while: worth winning back.') }
];

const LEAD_FILTERS = [
  { key: 'all', label: msg('All') },
  { key: 'lead', label: msg('Leads') },
  { key: 'prospect', label: msg('Prospects') },
  { key: 'nomanager', label: msg('No account manager') }
];

function todayIso() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function daysUntil(iso) {
  if (!iso) return null;
  return Math.round((new Date(iso + 'T00:00').getTime() - new Date(todayIso() + 'T00:00').getTime()) / 86400000);
}
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso + 'T00:00').toLocaleDateString(activeIntlLocale(), { day: '2-digit', month: 'short', year: 'numeric' });
}
// How urgent a waiting quotation is, by its valid-until date.
function expiry(q) {
  const d = daysUntil(q.validUntil);
  if (d === null) return { cls: 'is-none', label: tr('No expiry date') };
  if (d < 0) return { cls: 'is-late', label: d === -1 ? tr('Expired yesterday') : tr('Expired {n} days ago', { n: -d }) };
  if (d === 0) return { cls: 'is-late', label: tr('Expires today') };
  if (d <= 7) return { cls: 'is-soon', label: d === 1 ? tr('Expires tomorrow') : tr('Expires in {n} days', { n: d }) };
  return { cls: 'is-ok', label: tr('Valid until {date}', { date: fmtDate(q.validUntil) }) };
}
function quoteTone(status) {
  if (status === 'accepted') return 'is-good';
  if (status === 'rejected' || status === 'expired' || status === 'cancelled') return 'is-bad';
  if (status === 'draft') return 'is-muted';
  return 'is-info';
}

export default function MarketingDashboardPage() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [recommendation, setRecommendation] = useState(null);
  const [leadFilter, setLeadFilter] = useState('all');
  const printRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        setData(await api.get('/reports/marketing'));
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function downloadPdf() {
    setExporting(true);
    try {
      await shareOrDownloadPdf(printRef.current, 'marketing-dashboard-' + new Date().toISOString().slice(0, 10) + '.pdf', tr('Marketing dashboard'), tr('Marketing dashboard'));
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  }

  function downloadCsvReport() {
    const rows = [
      [tr('Marketing Dashboard'), new Date().toISOString().slice(0, 10)],
      [],
      [tr('Customer pipeline')],
      [tr('Category'), tr('Customers')],
      ...data.pipeline.map((p) => [p.category, p.count]),
      [],
      [tr('Quotation funnel')],
      [tr('Sent'), data.funnel.sent], [tr('Accepted'), data.funnel.accepted], [tr('Waiting for an answer'), data.funnel.waiting || 0], [tr('Rejected/expired'), data.funnel.rejected],
      [tr('Conversion rate'), data.funnel.conversionRate + '%'],
      [],
      [tr('Quotations waiting for an answer')],
      [tr('Quote'), tr('Customer'), tr('Currency'), tr('Total'), tr('Status'), tr('Valid until')],
      ...(data.waitingQuotes || []).map((q) => [q.quoteNo, q.customerName, q.currency, q.total, q.status, q.validUntil || '']),
      [],
      [tr('Top customers by sales value')],
      [tr('Customer'), tr('Currency'), tr('Total'), tr('Orders')],
      ...data.topCustomers.map((c) => [c.name, c.currency, c.total, c.orders || '']),
      [],
      [tr('Recent quotations')],
      [tr('Quote'), tr('Customer'), tr('Currency'), tr('Total'), tr('Status')],
      ...data.recentQuotes.map((q) => [q.quoteNo, q.customerName, q.currency, q.total, q.status]),
      [],
      [tr('Leads & prospects to follow up')],
      [tr('Customer'), tr('Contact'), tr('Email'), tr('Phone'), tr('Category'), tr('Account manager'), tr('Open quotations')],
      ...data.leads.map((l) => [l.name, l.contactPerson, l.email, l.phone, l.category, l.managerName, l.openQuotes || 0])
    ];
    if (recommendation) {
      rows.push([], [tr('Content recommendations')], [recommendation.recommendation]);
    }
    downloadCsv('marketing-dashboard-' + new Date().toISOString().slice(0, 10) + '.csv', rowsToCsv(rows));
  }

  function jump(id) {
    const el = document.getElementById(id);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); el.focus({ preventScroll: true }); }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;
  if (error && !data) return <div className="error-banner">{error}</div>;
  if (!data) return null;

  const f = data.funnel;
  const waiting = data.waitingQuotes || [];
  const countOf = (key) => (data.pipeline.find((p) => p.category === key) || { count: 0 }).count;
  const toFollow = countOf('lead') + countOf('prospect');
  const buying = countOf('active') + countOf('vip');
  const maxStage = Math.max(1, ...data.pipeline.map((p) => p.count));
  const expiringSoon = waiting.filter((q) => { const d = daysUntil(q.validUntil); return d !== null && d >= 0 && d <= 7; });
  const overdue = waiting.filter((q) => { const d = daysUntil(q.validUntil); return d !== null && d < 0; });
  const noManager = data.leads.filter((l) => l.hasManager === false || l.managerName === '—');
  const neverQuoted = data.leads.filter((l) => l.lastQuoteAt === null);
  const leads = data.leads.filter((l) => leadFilter === 'all' ? true : leadFilter === 'nomanager' ? (l.hasManager === false || l.managerName === '—') : l.category === leadFilter);

  // A few plain sentences written from the numbers.
  const insights = [];
  if (f.sent > 0) {
    const tone = f.conversionRate >= 40 ? 'good' : f.conversionRate < 20 ? 'warn' : 'info';
    insights.push({ tone, icon: 'percent', text: tr('{rate}% of quotations sent were accepted ({accepted} of {sent}).', { rate: f.conversionRate, accepted: f.accepted, sent: f.sent }) });
  } else {
    insights.push({ tone: 'info', icon: 'doc', text: tr('No quotation has been sent yet, so there is no conversion rate to show.'), action: { label: tr('Open quotations'), run: () => navigate('/quotations') } });
  }
  if (overdue.length) {
    insights.push({ tone: 'warn', icon: 'clock', text: overdue.length === 1 ? tr('1 quotation passed its valid-until date without an answer.') : tr('{n} quotations passed their valid-until date without an answer.', { n: overdue.length }), action: { label: tr('See them'), run: () => jump('md-chase') } });
  }
  if (expiringSoon.length) {
    insights.push({ tone: 'warn', icon: 'clock', text: expiringSoon.length === 1 ? tr('1 quotation expires within a week: a good moment to call.') : tr('{n} quotations expire within a week: a good moment to call.', { n: expiringSoon.length }), action: { label: tr('See them'), run: () => jump('md-chase') } });
  }
  if (f.rejected > f.accepted && f.rejected > 0) {
    insights.push({ tone: 'warn', icon: 'warn', text: tr('More quotations were turned down or expired ({rejected}) than accepted ({accepted}). Worth reviewing prices and how quickly quotes are followed up.', { rejected: f.rejected, accepted: f.accepted }) });
  }
  if (noManager.length) {
    insights.push({ tone: 'warn', icon: 'user', text: noManager.length === 1 ? tr('1 lead or prospect has no account manager, so nobody owns the follow-up.') : tr('{n} leads and prospects have no account manager, so nobody owns the follow-up.', { n: noManager.length }), action: { label: tr('Show them'), run: () => { setLeadFilter('nomanager'); jump('md-leads'); } } });
  }
  if (neverQuoted.length && data.leads.length && data.leads[0].lastQuoteAt !== undefined) {
    insights.push({ tone: 'info', icon: 'doc', text: neverQuoted.length === 1 ? tr('1 lead or prospect has never had a quotation.') : tr('{n} leads and prospects have never had a quotation.', { n: neverQuoted.length }) });
  }
  if (data.topCustomers[0]) {
    const top = data.topCustomers[0];
    insights.push({ tone: 'good', icon: 'trophy', text: top.orders
      ? tr('{name} is the biggest customer: {amount} across {orders} orders.', { name: top.name, amount: money(top.total, top.currency), orders: top.orders })
      : tr('{name} is the biggest customer: {amount} in sales.', { name: top.name, amount: money(top.total, top.currency) }) });
  }

  const funnelBars = [
    { key: 'sent', label: tr('Sent'), help: tr('Every quotation that left the office (not drafts).'), value: f.sent, cls: 'is-sent' },
    { key: 'waiting', label: tr('Waiting for an answer'), help: tr('Sent or opened by the customer, no decision yet.'), value: f.waiting || 0, cls: 'is-waiting' },
    { key: 'accepted', label: tr('Accepted'), help: tr('The customer said yes.'), value: f.accepted, cls: 'is-accepted' },
    { key: 'rejected', label: tr('Rejected or expired'), help: tr('Turned down, or ran past its valid-until date.'), value: f.rejected, cls: 'is-rejected' }
  ];
  const ring = 2 * Math.PI * 42;

  return (
    <div className="md">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <header className="md-hero">
        <div className="md-hero-text">
          <p className="md-eyebrow">{tr('Marketing dashboard')}</p>
          <h2 className="md-hero-title">{tr('From first contact to regular customer')}</h2>
          <p className="md-hero-sub">{tr('Where every customer is in the journey, how quotations turn into sales, and who to follow up next.')}</p>
          <div className="md-hero-actions no-print">
            <button type="button" className="btn btn-secondary" onClick={downloadCsvReport}>{tr('Download CSV')}</button>
            <button type="button" className="btn btn-secondary" disabled={exporting} onClick={downloadPdf}>
              {exporting ? tr('Preparing…') : tr('Download PDF')}
            </button>
          </div>
        </div>
        <div className="md-hero-stats">
          <button type="button" className="md-hero-stat" onClick={() => jump('md-journey')}>
            <span className="md-hero-stat-icon"><Icon name="people" /></span>
            <strong>{data.totalCustomers}</strong>
            <span>{tr('customers in total')}</span>
            <small>{tr('{n} buying now', { n: buying })}</small>
          </button>
          <button type="button" className="md-hero-stat" onClick={() => jump('md-leads')}>
            <span className="md-hero-stat-icon"><Icon name="target" /></span>
            <strong>{toFollow}</strong>
            <span>{tr('leads & prospects')}</span>
            <small>{tr('to follow up')}</small>
          </button>
          <button type="button" className={'md-hero-stat' + (overdue.length || expiringSoon.length ? ' is-alert' : '')} onClick={() => jump('md-chase')}>
            <span className="md-hero-stat-icon"><Icon name="clock" /></span>
            <strong>{f.waiting || 0}</strong>
            <span>{tr('quotations waiting')}</span>
            <small>{overdue.length || expiringSoon.length ? tr('{n} need a call soon', { n: overdue.length + expiringSoon.length }) : tr('for an answer')}</small>
          </button>
          <button type="button" className="md-hero-stat" onClick={() => jump('md-funnel')}>
            <span className="md-hero-stat-icon"><Icon name="percent" /></span>
            <strong>{f.conversionRate}%</strong>
            <span>{tr('conversion rate')}</span>
            <small>{tr('of quotations accepted')}</small>
          </button>
        </div>
      </header>

      <div ref={printRef} className="md-body">
        {insights.length > 0 && (
          <section className="md-insights" aria-label={tr('What stands out')}>
            <h3 className="md-h3"><Icon name="spark" /> {tr('What stands out')}</h3>
            <ul>
              {insights.map((it, i) => (
                <li key={i} className={'md-insight is-' + it.tone}>
                  <span className="md-insight-icon"><Icon name={it.icon} /></span>
                  <span className="md-insight-text">{it.text}</span>
                  {it.action && <button type="button" className="md-link no-print" onClick={it.action.run}>{it.action.label} <Icon name="arrow" /></button>}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section id="md-journey" tabIndex={-1} className="md-section">
          <div className="md-section-head">
            <div>
              <h3 className="md-h3">{tr('Customer journey')}</h3>
              <p className="md-muted">{tr('How many customers are at each stage. The aim is to move people along, from lead to active and VIP.')}</p>
            </div>
            <button type="button" className="md-link no-print" onClick={() => navigate('/customers')}>{tr('Open customers')} <Icon name="arrow" /></button>
          </div>
          <ol className="md-journey">
            {STAGES.map((s, i) => {
              const n = countOf(s.key);
              const share = data.totalCustomers ? Math.round((n / data.totalCustomers) * 100) : 0;
              return (
                <li key={s.key} className={'md-stage is-' + s.key}>
                  <div className="md-stage-top">
                    <span className="md-stage-step" aria-hidden="true">{s.key === 'inactive' ? '·' : i + 1}</span>
                    <span className="md-stage-name">{tr(s.label)}</span>
                  </div>
                  <div className="md-stage-n">{n}</div>
                  <div className="md-stage-bar" aria-hidden="true"><span style={{ width: Math.round((n / maxStage) * 100) + '%' }} /></div>
                  <div className="md-stage-share">{tr('{n}% of customers', { n: share })}</div>
                  <p className="md-stage-help">{tr(s.help)}</p>
                </li>
              );
            })}
          </ol>
        </section>

        <div className="md-two">
          <section id="md-funnel" tabIndex={-1} className="md-section md-card">
            <div className="md-section-head">
              <div>
                <h3 className="md-h3">{tr('Quotation funnel')}</h3>
                <p className="md-muted">{tr('What happened to every quotation sent so far.')}</p>
              </div>
            </div>
            <div className="md-funnel">
              <div className="md-ring" role="img" aria-label={tr('{rate}% of quotations sent were accepted', { rate: f.conversionRate })}>
                <svg viewBox="0 0 100 100" aria-hidden="true">
                  <circle cx="50" cy="50" r="42" className="md-ring-track" />
                  <circle cx="50" cy="50" r="42" className="md-ring-fill" strokeDasharray={ring} strokeDashoffset={ring * (1 - Math.min(100, f.conversionRate) / 100)} />
                </svg>
                <div className="md-ring-text">
                  <strong>{f.conversionRate}%</strong>
                  <span>{tr('accepted')}</span>
                </div>
              </div>
              <ul className="md-funnel-bars">
                {funnelBars.map((b) => (
                  <li key={b.key} className={b.cls}>
                    <div className="md-funnel-row">
                      <span className="md-funnel-label">{b.label}</span>
                      <span className="md-funnel-value">{b.value}</span>
                    </div>
                    <div className="md-funnel-track" aria-hidden="true"><span style={{ width: (f.sent ? Math.round((b.value / f.sent) * 100) : 0) + '%' }} /></div>
                    <p className="md-funnel-help">{b.help}</p>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section id="md-chase" tabIndex={-1} className="md-section md-card">
            <div className="md-section-head">
              <div>
                <h3 className="md-h3">{tr('Quotations to chase')}</h3>
                <p className="md-muted">{tr('Waiting for the customer\'s answer, the soonest to expire first.')}</p>
              </div>
              <button type="button" className="md-link no-print" onClick={() => navigate('/quotations')}>{tr('Open quotations')} <Icon name="arrow" /></button>
            </div>
            {waiting.length ? (
              <ul className="md-quote-list">
                {waiting.slice(0, 8).map((q) => {
                  const ex = expiry(q);
                  return (
                    <li key={q.quoteNo} className="md-quote">
                      <span className={'md-quote-dot ' + ex.cls} aria-hidden="true" />
                      <div className="md-quote-main">
                        <div className="md-quote-title">{q.customerName}</div>
                        <div className="md-muted md-quote-meta">{q.quoteNo} · {codeLabel(q.status)}{q.createdAt ? ' · ' + tr('sent {date}', { date: fmtDate(q.createdAt) }) : ''}</div>
                      </div>
                      <div className="md-quote-side">
                        <div className="md-quote-amount">{money(q.total, q.currency)}</div>
                        <div className={'md-expiry ' + ex.cls}>{ex.label}</div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="md-empty"><Icon name="check" /><p>{tr('Nothing waiting: every quotation sent has an answer.')}</p></div>
            )}
          </section>
        </div>

        <div className="md-two">
          <section className="md-section md-card">
            <div className="md-section-head">
              <div>
                <h3 className="md-h3">{tr('Top customers by sales value')}</h3>
                <p className="md-muted">{tr('All sales orders to date, biggest first.')}</p>
              </div>
            </div>
            {data.topCustomers.length ? (
              <ol className="md-top">
                {data.topCustomers.map((c, i) => {
                  const max = Math.max(...data.topCustomers.filter((x) => x.currency === c.currency).map((x) => x.total), 1);
                  return (
                    <li key={c.name + c.currency}>
                      <span className={'md-rank' + (i === 0 ? ' is-first' : '')}>{i + 1}</span>
                      <div className="md-top-main">
                        <div className="md-top-row">
                          <span className="md-top-name">{c.name}</span>
                          <span className="md-top-amount">{money(c.total, c.currency)}</span>
                        </div>
                        <div className="md-top-track" aria-hidden="true"><span style={{ width: Math.round((c.total / max) * 100) + '%' }} /></div>
                        {c.orders ? <div className="md-muted md-top-meta">{c.orders === 1 ? tr('1 order') : tr('{n} orders', { n: c.orders })}</div> : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : <div className="md-empty"><Icon name="trophy" /><p>{tr('No sales orders yet.')}</p></div>}
          </section>

          <section className="md-section md-card">
            <div className="md-section-head">
              <div>
                <h3 className="md-h3">{tr('Recent quotations')}</h3>
                <p className="md-muted">{tr('The five latest, whatever their status.')}</p>
              </div>
            </div>
            {data.recentQuotes.length ? (
              <ul className="md-quote-list">
                {data.recentQuotes.map((q) => (
                  <li key={q.quoteNo} className="md-quote">
                    <span className="md-quote-icon" aria-hidden="true"><Icon name="doc" /></span>
                    <div className="md-quote-main">
                      <div className="md-quote-title">{q.customerName}</div>
                      <div className="md-muted md-quote-meta">{q.quoteNo}{q.createdAt ? ' · ' + fmtDate(q.createdAt) : ''}</div>
                    </div>
                    <div className="md-quote-side">
                      <div className="md-quote-amount">{money(q.total, q.currency)}</div>
                      <span className={'md-status ' + quoteTone(q.status)}>{codeLabel(q.status)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : <div className="md-empty"><Icon name="doc" /><p>{tr('No quotations yet.')}</p></div>}
          </section>
        </div>

        <section id="md-leads" tabIndex={-1} className="md-section">
          <div className="md-section-head">
            <div>
              <h3 className="md-h3">{tr('Leads & prospects to follow up')}</h3>
              <p className="md-muted">{tr('The people most likely to become customers next. Reach out, send a quotation, and move them along.')}</p>
            </div>
            <div className="md-segment no-print" role="group" aria-label={tr('Show')}>
              {LEAD_FILTERS.map((lf) => (
                <button key={lf.key} type="button" aria-pressed={leadFilter === lf.key} className={leadFilter === lf.key ? 'is-on' : ''} onClick={() => setLeadFilter(lf.key)}>
                  {tr(lf.label)}
                </button>
              ))}
            </div>
          </div>
          {leads.length ? (
            <div className="md-lead-grid">
              {leads.map((l) => (
                <article key={l.id || l.name} className="md-card md-lead">
                  <div className="md-lead-top">
                    <span className="md-lead-badge" style={{ background: avatarColor(l.name) }} aria-hidden="true"><Icon name="building" /></span>
                    <div className="md-lead-id">
                      <div className="md-lead-name">{l.name}</div>
                      <div className="md-muted">{l.contactPerson || tr('No contact person')}</div>
                    </div>
                    <span className={'md-status ' + (l.category === 'prospect' ? 'is-info' : 'is-muted')}>{codeLabel(l.category)}</span>
                  </div>
                  <div className="md-lead-reach">
                    {l.phone ? <a href={'tel:' + l.phone.replace(/\s+/g, '')}><Icon name="phone" /> {l.phone}</a> : <span className="md-muted"><Icon name="phone" /> {tr('No phone')}</span>}
                    {l.email ? <a href={'mailto:' + l.email}><Icon name="mail" /> {l.email}</a> : <span className="md-muted"><Icon name="mail" /> {tr('No email')}</span>}
                  </div>
                  <dl className="md-lead-facts">
                    <div>
                      <dt>{tr('Account manager')}</dt>
                      <dd className={l.managerName === '—' ? 'is-missing' : ''}>{l.managerName === '—' ? tr('Nobody yet') : l.managerName}</dd>
                    </div>
                    <div>
                      <dt>{tr('Open quotations')}</dt>
                      <dd>{l.openQuotes || 0}</dd>
                    </div>
                    <div>
                      <dt>{tr('Last quotation')}</dt>
                      <dd>{l.lastQuoteAt ? fmtDate(l.lastQuoteAt) : tr('Never')}</dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
          ) : (
            <div className="md-empty"><Icon name="target" /><p>{leadFilter === 'all' ? tr('No leads or prospects to follow up right now.') : tr('Nothing matches this filter.')}</p></div>
          )}
        </section>

        <MarketingRecommendations onGenerated={setRecommendation} />

        <button type="button" className="md-social no-print" onClick={() => navigate('/socialtracker')}>
          <span className="md-social-icon"><Icon name="social" /></span>
          <span>
            <strong>{tr('Social media and website')}</strong>
            <span className="md-muted">{tr('Followers, reach and messages for each company are on the social & campaign tracker.')}</span>
          </span>
          <Icon name="arrow" />
        </button>
      </div>

      <details className="md-glossary">
        <summary><Icon name="info" /> {tr('What do these words mean?')}</summary>
        <dl>
          {STAGES.map((s) => <div key={s.key}><dt>{tr(s.label)}</dt><dd>{tr(s.help)}</dd></div>)}
          <div><dt>{tr('Quotation')}</dt><dd>{tr('A priced offer sent to a customer. It is "waiting" until they accept or reject it, and expires after its valid-until date.')}</dd></div>
          <div><dt>{tr('Conversion rate')}</dt><dd>{tr('Accepted quotations out of all quotations sent. Higher means more offers turn into sales.')}</dd></div>
          <div><dt>{tr('Account manager')}</dt><dd>{tr('The person responsible for a customer and their follow-up. Set it on the customer\'s record.')}</dd></div>
        </dl>
      </details>
    </div>
  );
}
