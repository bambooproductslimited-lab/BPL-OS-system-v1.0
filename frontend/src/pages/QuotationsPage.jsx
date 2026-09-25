import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { blankDocItem } from '../components/DocItemsEditor';
import DocWizard from '../components/DocWizard';
import CustomerPicker from '../components/CustomerPicker';
import DocPreview from '../components/DocPreview';
import ContactButtons from '../components/ContactButtons';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import RowMenu from '../components/RowMenu';
import { Glossary, Hero, Insights, Section, Status, avatarColor, fmtDate, initials, jump } from '../components/DashKit';
import { adjustmentRows, lineAmount, totalsForDialog } from '../lib/docItems';
import { money, moneyBreakdown } from '../lib/currency';
import { groupPackageItems } from '../lib/packages';
import { formatPaymentSchedule } from '../lib/paymentSchedule';
import { tr, msg, docTr } from '../lib/i18n.jsx';
import { formatDocDate } from '../lib/dates';
import { codeLabel } from '../lib/codeLabels.js';
import './EmployeesPage.css';
import './ToolRoomPage.css';
import './RestaurantsPage.css';
import './PokiRentals.css';
import './CustomersPage.css';
import './EstimatesPage.css';
import './QuotationsPage.css';

// Quotations — the formal offers sent to clients. Same "explains itself"
// layout as the dashboards (components/DashKit.jsx): what is waiting for
// an answer, what was won lately and how often, what was accepted but not
// yet invoiced, what stands out (waiting long, running out of time, drafts
// not sent, expired unanswered), the path from draft to invoice, and the
// quotations as cards or a list with a window for each one
// (quotations.service.js list: sent and answered dates, contact details,
// the estimate it came from and the invoice made from it).
//
// Only a draft can be changed; an invoiced quotation stays accepted until
// that invoice is voided. "New quotation" needs customer.read as well as
// quotation.manage, since the dialog can't work without a client list.
// /quotations?open=<id> opens that quotation's window (from Estimates).

const STAGES = [
  { key: 'draft', label: msg('Draft') }, { key: 'sent', label: msg('Waiting for an answer') }, { key: 'accepted', label: msg('Accepted') },
  { key: 'invoiced', label: msg('Invoiced') }, { key: 'lost', label: msg('Lost') }
];
const LONG_WAIT = 7;
const SOON_DAYS = 7;
const RECENT_DAYS = 90;
const EMPTY_FORM = { customerId: '', title: '', validUntil: '', notes: '', currency: '' };

function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function dayNum(iso) { return Math.floor(new Date(String(iso).slice(0, 10) + 'T00:00').getTime() / 86400000); }
function todayNum() { const t = new Date(); return Math.floor(new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime() / 86400000); }
function localDay(ts) { if (!ts) return null; const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function daysSince(ts) { return ts ? todayNum() - dayNum(localDay(ts)) : null; }
function daysLeft(iso) { return iso ? dayNum(iso) - todayNum() : null; }

function isWaiting(q) { return q.status === 'sent' || q.status === 'viewed'; }
function isLost(q) { return q.status === 'rejected' || q.status === 'expired' || q.status === 'cancelled'; }
function liveInvoice(q) { return q.invoice && q.invoice.status !== 'void' ? q.invoice : null; }
function toInvoice(q) { return q.status === 'accepted' && !liveInvoice(q); }
function stageOf(q) { return q.status === 'accepted' ? (liveInvoice(q) ? 'invoiced' : 'accepted') : isWaiting(q) ? 'sent' : isLost(q) ? 'lost' : 'draft'; }
function waitedDays(q) { return daysSince(q.sentAt || q.createdAt); }
function sumBy(list) {
  const m = {};
  list.forEach((q) => { m[q.currency] = (m[q.currency] || 0) + Number(q.grandTotal || 0); });
  return Object.entries(m).map(([currency, amount]) => ({ currency, amount }));
}
function itemsLine(q) { return (q.items || []).map((i) => i.description).filter(Boolean).join(', '); }
// The title, unless it is only the default "Quotation for <client>"; then the items.
function whatFor(q) { return (q.title && !/^Quotation for /.test(q.title) ? q.title : itemsLine(q)) || '—'; }

function Mark({ q, size = 44 }) {
  return <span className="pk-avatar cu-mark" style={{ width: size, height: size, background: avatarColor(q.customerName), fontSize: Math.round(size * 0.34) }} aria-hidden="true">{initials(q.customerName)}</span>;
}

export default function QuotationsPage() {
  const { can } = useAuth();
  const canManage = can('quotation.manage');
  const canInvoice = can('invoice.manage');
  const canSeeCustomers = can('customer.read');
  const canSeeCatalog = can('catalog.read');
  const canOpenNew = canManage && canSeeCustomers;
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const [quotations, setQuotations] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [currencies, setCurrencies] = useState(['GHS']);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [items, setItems] = useState([blankDocItem()]);
  const [docDiscount, setDocDiscount] = useState({ value: 0, type: 'fixed' });
  const [docTaxRate, setDocTaxRate] = useState(0);
  const [paymentSchedule, setPaymentSchedule] = useState([]);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [detail, setDetail] = useState(() => params.get('open'));
  const [previewQ, setPreviewQ] = useState(null);
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState('open');
  const [stage, setStage] = useState('');
  const [view, setView] = useState(() => readPref('bos.quotationsView', 'cards'));

  const load = useCallback(async () => {
    setError(null);
    try {
      const [qs, cust, cat] = await Promise.all([
        api.get('/quotations'),
        canSeeCustomers ? api.get('/customers') : Promise.resolve([]),
        canSeeCatalog ? api.get('/catalog') : Promise.resolve([])
      ]);
      setQuotations(qs);
      setCustomers(cust);
      setCatalog(cat);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
    // Best-effort: the currency picker falls back to just GHS if this fails
    // (a role without employee.read, which /settings requires since it also
    // carries integration keys) rather than blocking the page over a field
    // that only matters inside the dialog.
    try {
      const settings = await api.get('/settings');
      if (settings.commercial && settings.commercial.currencies) setCurrencies(settings.commercial.currencies);
    } catch { /* ignore */ }
  }, [canSeeCustomers, canSeeCatalog]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  function closeDetail() {
    setDetail(null);
    if (params.get('open')) { params.delete('open'); setParams(params, { replace: true }); }
  }

  function openNew() {
    setDialogError(null);
    setEditId(null);
    setForm(EMPTY_FORM);
    setItems([blankDocItem()]);
    setDocDiscount({ value: 0, type: 'fixed' });
    setDocTaxRate(0);
    setPaymentSchedule([]);
    setDialogOpen(true);
  }
  function openEdit(q) {
    setDialogError(null);
    setEditId(q.id);
    setForm({ customerId: q.customerId, title: q.title || '', validUntil: q.validUntil || '', notes: q.notes || '', currency: q.currency || '' });
    setItems(q.items.map((it) => ({ ...it })));
    setDocDiscount(q.discount || { value: 0, type: 'fixed' });
    setDocTaxRate(q.taxRate || 0);
    setPaymentSchedule((q.paymentSchedule || []).map((r) => ({ label: r.label, type: r.type, value: r.value, dueDate: r.dueDate || '' })));
    closeDetail();
    setDialogOpen(true);
  }

  async function handleSubmit() {
    setSaving(true);
    setDialogError(null);
    try {
      const payload = {
        customerId: form.customerId, title: form.title, items, validUntil: form.validUntil, notes: form.notes,
        currency: form.currency || undefined, discount: docDiscount, taxRate: docTaxRate, paymentSchedule
      };
      if (editId) await api.put('/quotations/' + editId, payload);
      else await api.post('/quotations', payload);
      setToast(editId ? tr('Quotation updated.') : tr('Quotation created.'));
      setDialogOpen(false);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function run(q, fn, done) {
    setBusyId(q.id);
    setError(null);
    try {
      const r = await fn();
      setToast(done(r));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }
  const setStatus = (q, status) => run(q, () => api.post('/quotations/' + q.id + '/status', { status }), () => tr('{quoteNo} set to {status}.', { quoteNo: q.quoteNo, status: codeLabel(status) }));
  const convertToInvoice = (q) => run(q, () => api.post('/invoices/from-quotation', { quotationId: q.id }), (inv) => tr('{invoiceNo} issued from quotation.', { invoiceNo: inv.invoiceNo }));

  function openPreview(q) {
    const cust = customers.find((c) => c.id === q.customerId) || {};
    setPreviewQ({ ...q, customerName: cust.name || q.customerName, customerEmail: cust.email || q.customerEmail || '' });
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const drafts = quotations.filter((q) => q.status === 'draft');
  const waiting = quotations.filter(isWaiting).sort((a, b) => waitedDays(b) - waitedDays(a));
  const longWait = waiting.filter((q) => waitedDays(q) > LONG_WAIT);
  const endingSoon = waiting.filter((q) => { const d = daysLeft(q.validUntil); return d !== null && d >= 0 && d <= SOON_DAYS; });
  const accepted = quotations.filter((q) => q.status === 'accepted');
  const notInvoiced = accepted.filter(toInvoice);
  const invoiced = accepted.filter(liveInvoice);
  const lost = quotations.filter(isLost);
  const recent = (q) => { const d = daysSince(q.answeredAt || q.createdAt); return d !== null && d <= RECENT_DAYS; };
  const wonRecent = accepted.filter(recent);
  const lostRecent = quotations.filter((q) => (q.status === 'rejected' || q.status === 'expired') && recent(q));
  const expiredUnanswered = quotations.filter((q) => q.status === 'expired' && todayNum() - dayNum(q.validUntil) <= 30);
  const winRate = wonRecent.length + lostRecent.length ? Math.round((wonRecent.length / (wonRecent.length + lostRecent.length)) * 100) : null;

  function showOnly(key) { setStage(''); setChip(chip === key ? 'open' : key); jump('qt-list'); }
  const stats = [
    { icon: 'send', value: String(waiting.length), label: tr('waiting for an answer'), note: waiting.length ? tr('worth {amount}', { amount: moneyBreakdown(sumBy(waiting)) }) : tr('nothing out right now'), tone: longWait.length ? 'warn' : '', onClick: () => showOnly('waiting') },
    { icon: 'up', value: moneyBreakdown(sumBy(wonRecent), money(0)), label: tr('won in the last 90 days'), note: tr('{n} quotations accepted', { n: wonRecent.length }), tone: wonRecent.length ? 'good' : '', onClick: () => showOnly('accepted') },
    { icon: 'percent', value: winRate === null ? '—' : winRate + '%', label: tr('of answered quotations won'), note: tr('{won} won, {lost} lost or expired, last 90 days', { won: wonRecent.length, lost: lostRecent.length }), onClick: () => showOnly(lostRecent.length ? 'lost' : 'accepted') },
    { icon: 'receipt', value: String(notInvoiced.length), label: tr('accepted, not yet invoiced'), note: notInvoiced.length ? tr('worth {amount}', { amount: moneyBreakdown(sumBy(notInvoiced)) }) : tr('every accepted quotation is invoiced'), tone: notInvoiced.length ? 'bad' : '', onClick: () => showOnly('toinvoice') }
  ];

  const insights = [];
  if (notInvoiced.length) insights.push({ tone: 'bad', icon: 'receipt', text: notInvoiced.length === 1 ? tr('{no} for {name} was accepted but has no invoice yet.', { no: notInvoiced[0].quoteNo, name: notInvoiced[0].customerName }) : tr('{n} accepted quotations have no invoice yet.', { n: notInvoiced.length }), action: { label: notInvoiced.length === 1 ? tr('Open') : tr('Show them'), run: () => (notInvoiced.length === 1 ? setDetail(notInvoiced[0].id) : showOnly('toinvoice')) } });
  if (longWait.length) insights.push({ tone: 'warn', icon: 'phone', text: longWait.length === 1 ? tr('{name} has had {no} for {days} days without an answer. Call to follow up.', { name: longWait[0].customerName, no: longWait[0].quoteNo, days: waitedDays(longWait[0]) }) : tr('{n} quotations have waited more than a week for an answer; the longest {days} days. Call to follow up.', { n: longWait.length, days: waitedDays(longWait[0]) }), action: { label: longWait.length === 1 ? tr('Open') : tr('Show them'), run: () => (longWait.length === 1 ? setDetail(longWait[0].id) : showOnly('long')) } });
  if (endingSoon.length) insights.push({ tone: 'warn', icon: 'calendar', text: endingSoon.length === 1 ? tr('{no} for {name} stops being valid on {date}.', { no: endingSoon[0].quoteNo, name: endingSoon[0].customerName, date: fmtDate(endingSoon[0].validUntil) }) : tr('{n} quotations stop being valid within a week.', { n: endingSoon.length }), action: { label: tr('Show them'), run: () => showOnly('soon') } });
  if (drafts.length) insights.push({ tone: 'info', icon: 'doc', text: drafts.length === 1 ? tr('{no} for {name} is still a draft. Send it when it is ready.', { no: drafts[0].quoteNo, name: drafts[0].customerName }) : tr('{n} drafts haven\'t been sent yet.', { n: drafts.length }), action: { label: tr('Show them'), run: () => showOnly('draft') } });
  if (expiredUnanswered.length) insights.push({ tone: 'bad', icon: 'clock', text: expiredUnanswered.length === 1 ? tr('{no} for {name} ran out of time without an answer on {date}.', { no: expiredUnanswered[0].quoteNo, name: expiredUnanswered[0].customerName, date: fmtDate(expiredUnanswered[0].validUntil) }) : tr('{n} quotations ran out of time without an answer in the last 30 days.', { n: expiredUnanswered.length }), action: { label: tr('Show them'), run: () => showOnly('lost') } });
  if (!insights.length && quotations.length) insights.push({ tone: 'good', icon: 'check', text: tr('Every quotation has been answered and every accepted one is invoiced.') });

  const chipTest = {
    open: (q) => q.status === 'draft' || isWaiting(q) || toInvoice(q), draft: (q) => q.status === 'draft', waiting: isWaiting,
    long: (q) => longWait.includes(q), soon: (q) => endingSoon.includes(q), accepted: (q) => q.status === 'accepted',
    toinvoice: toInvoice, invoiced: (q) => !!(q.status === 'accepted' && liveInvoice(q)), lost: isLost, all: () => true
  };
  const visible = quotations.filter(chipTest[chip] || chipTest.open)
    .filter((q) => !stage || stageOf(q) === stage)
    .filter((q) => matchesQuery(search, q.quoteNo, q.customerName, q.title, itemsLine(q), q.estimateNo, q.invoice && q.invoice.invoiceNo, q.createdByName));
  const chips = [
    ['open', tr('Needs something'), quotations.filter(chipTest.open).length], ['draft', tr('Drafts'), drafts.length], ['waiting', tr('Waiting'), waiting.length],
    ['long', tr('Waiting over a week'), longWait.length], ['soon', tr('Running out of time'), endingSoon.length], ['accepted', tr('Accepted'), accepted.length],
    ['toinvoice', tr('To invoice'), notInvoiced.length], ['invoiced', tr('Invoiced'), invoiced.length], ['lost', tr('Lost'), lost.length], ['all', tr('All'), quotations.length]
  ].filter(([k, , c]) => c > 0 || k === 'open' || k === chip);
  const counts = { draft: drafts.length, sent: waiting.length, accepted: notInvoiced.length, invoiced: invoiced.length, lost: lost.length };

  function stateOf(q, short) {
    const inv = liveInvoice(q);
    if (q.status === 'accepted' && inv) return { tone: inv.status === 'paid' ? 'good' : 'info', text: inv.invoiceNo + ' · ' + codeLabel(inv.status) };
    if (q.status === 'accepted') return { tone: 'bad', text: tr('Accepted · not invoiced') };
    if (isWaiting(q)) {
      const d = waitedDays(q);
      const left = daysLeft(q.validUntil);
      if (!short && left !== null && left >= 0 && left <= SOON_DAYS) return { tone: 'warn', text: tr('Waiting {days} days · {left} days left', { days: d, left }) };
      return { tone: d > LONG_WAIT ? 'warn' : 'info', text: q.status === 'viewed' ? tr('Seen · waiting {days} days', { days: d }) : tr('Sent · waiting {days} days', { days: d }) };
    }
    if (q.status === 'rejected') return { tone: 'bad', text: tr('Turned down') };
    if (q.status === 'expired') return { tone: 'bad', text: short ? tr('Expired') : tr('Expired {date}', { date: fmtDate(q.validUntil) }) };
    if (q.status === 'cancelled') return { tone: 'muted', text: tr('Cancelled') };
    return { tone: 'muted', text: tr('Draft · not sent') };
  }
  // Shared by the row menu and the window so the two cannot drift.
  function actionsFor(q) {
    const inv = liveInvoice(q);
    return [
      { label: tr('Open'), onClick: () => setDetail(q.id) },
      { label: tr('Preview'), onClick: () => openPreview(q) },
      canManage && q.status === 'draft' && { label: tr('Edit'), onClick: () => openEdit(q) },
      canManage && q.status === 'draft' && { label: tr('Mark as sent'), onClick: () => setStatus(q, 'sent') },
      canManage && q.status === 'sent' && { label: tr('Client has seen it'), onClick: () => setStatus(q, 'viewed') },
      canManage && (isWaiting(q) || q.status === 'draft') && { label: tr('Client accepted'), onClick: () => setStatus(q, 'accepted') },
      canManage && isWaiting(q) && { label: tr('Client turned it down'), onClick: () => setStatus(q, 'rejected') },
      canInvoice && toInvoice(q) && { label: tr('Make the invoice'), onClick: () => convertToInvoice(q) },
      inv && { label: tr('Open {no}', { no: inv.invoiceNo }), to: '/invoices?open=' + inv.id },
      canManage && (isLost(q) || (q.status === 'accepted' && !inv)) && { label: tr('Reopen as a draft'), onClick: () => setStatus(q, 'draft') },
      canManage && (q.status === 'draft' || isWaiting(q)) && { label: tr('Cancel'), onClick: () => setStatus(q, 'cancelled'), danger: true }
    ].filter(Boolean).map((a) => (a.to ? { label: a.label, onClick: () => navigate(a.to) } : a));
  }

  const cur = detail ? quotations.find((q) => q.id === detail) : null;
  const curTotals = cur ? totalsForDialog(cur, cur.currency).filter((r, i, all) => all.length > 2 || r.strong) : [];
  const curInv = cur ? liveInvoice(cur) : null;
  const pathSteps = cur ? [
    { label: tr('Draft'), done: true },
    { label: cur.status === 'viewed' ? tr('Seen') : tr('Sent'), done: !!cur.sentAt || (cur.status !== 'draft' && cur.status !== 'cancelled') },
    { label: isLost(cur) ? codeLabel(cur.status) : tr('Accepted'), done: cur.status === 'accepted', failed: isLost(cur) },
    { label: tr('Invoiced'), done: !!curInv }
  ] : [];

  return (
    <div className="dk tl pk cu qt">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('Quotations & Invoicing')}
        title={tr('Quotations')}
        sub={tr('The offers sent to clients: what is waiting for an answer, what was won and what still needs an invoice. Press a number to show only those.')}
        actions={(
          <>
            {canOpenNew && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('New quotation')}</button>}
            <Link className="btn btn-secondary" to="/estimates">{tr('Estimates')}</Link>
          </>
        )}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      <Section id="qt-stages" title={tr('From draft to invoice')} sub={tr('Where the quotations are. Press one to show only those.')}>
        <div className="cu-stages qt-stages" role="radiogroup" aria-label={tr('Stage')}>
          {STAGES.map((s, i) => (
            <button key={s.key} type="button" role="radio" aria-checked={stage === s.key} className={'cu-stage qt-stage is-' + s.key + (stage === s.key ? ' is-on' : '')}
              onClick={() => { setChip('all'); setStage(stage === s.key ? '' : s.key); jump('qt-list'); }}>
              <strong>{counts[s.key] || 0}</strong>
              <span>{tr(s.label)}</span>
              {i < 3 && <i className="cu-stage-arrow" aria-hidden="true">→</i>}
            </button>
          ))}
        </div>
      </Section>

      <Section id="qt-list" title={tr('Quotations')} sub={tr('Press a quotation to see its lines, dates and what came of it.')}
        action={(
          <div className="ppl-view" role="radiogroup" aria-label={tr('View')}>
            {[['cards', tr('Cards')], ['list', tr('List')]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? 'is-on' : ''} onClick={() => { setView(k); writePref('bos.quotationsView', k); }}>{label}</button>
            ))}
          </div>
        )}>
        <div className="tl-tools"><div className="tl-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search quotations…')} /></div></div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => { setChip(key); setStage(''); }}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
          {stage && <button type="button" className="ppl-chip is-on" onClick={() => setStage('')}>{tr(STAGES.find((s) => s.key === stage).label)} ×</button>}
        </div>
        {!visible.length ? (
          <div className="dk-empty tl-empty">
            <p>{quotations.length ? tr('Nothing matches. Try another search or filter.') : tr('No quotations yet')}</p>
            {canOpenNew && !quotations.length && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('New quotation')}</button>}
          </div>
        ) : view === 'cards' ? (
          <div className="tl-grid">
            {visible.map((q) => {
              const st = stateOf(q);
              return (
                <article key={q.id} className={'tl-card' + (st.tone === 'bad' && !isLost(q) ? ' st-late' : '') + (isLost(q) ? ' st-retired' : '')}>
                  <button type="button" className="tl-card-open" onClick={() => setDetail(q.id)}>
                    <Mark q={q} />
                    <span className="tl-card-head">
                      <span className="dk-muted tl-small">{q.quoteNo} · {fmtDate(q.createdAt)}</span>
                      <span className="tl-name">{q.customerName}</span>
                    </span>
                  </button>
                  <span className="tl-menu"><RowMenu disabled={busyId === q.id} actions={actionsFor(q)} /></span>
                  <p className="dk-muted tl-small es-items">{whatFor(q)}</p>
                  <div className="tl-tags"><Status tone={st.tone}>{st.text}</Status></div>
                  <div className="tl-foot">
                    <span className="es-total">{money(q.grandTotal, q.currency)}</span>
                    <ContactButtons name={q.customerName} phone={q.customerPhone} email={q.customerEmail} />
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="tl-table-wrap">
            <table className="tl-table">
              <thead><tr><th>{tr('Quotation')}</th><th>{tr('What for')}</th><th className="is-num">{tr('Total')}</th><th>{tr('Where it stands')}</th><th>{tr('Valid until')}</th><th /></tr></thead>
              <tbody>
                {visible.map((q) => {
                  const st = stateOf(q, true);
                  const left = daysLeft(q.validUntil);
                  return (
                    <tr key={q.id} className={isLost(q) ? 'st-retired' : ''}>
                      <td><button type="button" className="tl-row-open" onClick={() => setDetail(q.id)}><Mark q={q} size={32} /><span><span className="tl-name">{q.customerName}</span><span className="dk-muted tl-small">{q.quoteNo}</span></span></button></td>
                      <td className="es-items-cell">{whatFor(q)}</td>
                      <td className="is-num">{money(q.grandTotal, q.currency)}</td>
                      <td><Status tone={st.tone}>{st.text}</Status></td>
                      <td className={isWaiting(q) && left !== null && left <= SOON_DAYS ? 'pk-owe' : ''}>{fmtDate(q.validUntil)}</td>
                      <td className="tl-menu-cell"><RowMenu disabled={busyId === q.id} actions={actionsFor(q)} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Glossary items={[
        [tr('Quotation'), tr('A formal offer to a client: these items at these prices, until the valid-until date.')],
        [tr('Waiting for an answer'), tr('Sent (or seen) and the client hasn\'t said yes or no. Counted from the day it was sent.')],
        [tr('Accepted'), tr('The client said yes. The next step is the invoice.')],
        [tr('Invoiced'), tr('An invoice was made from it. Its status then stays accepted unless that invoice is voided.')],
        [tr('Lost'), tr('Turned down, cancelled, or it passed its valid-until date without an answer (expired). It can be reopened as a draft to update the prices.')],
        [tr('Won in the last 90 days'), tr('Quotations accepted in the last 90 days, added up in each currency. The share won counts only those answered or expired in that time.')]
      ]} />

      {/* ── one quotation ── */}
      {cur && (
        <div className="dialog-backdrop" onClick={closeDetail}>
          <div className="dialog tl-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="tl-detail-head">
              <Mark q={cur} size={56} />
              <div>
                <span className="dk-muted tl-small">{cur.quoteNo}{cur.title ? ' · ' + cur.title : ''}</span>
                <h2>{cur.customerName}</h2>
                <div className="tl-tags"><Status tone={stateOf(cur).tone}>{stateOf(cur).text}</Status></div>
              </div>
              <button type="button" className="tl-close" onClick={closeDetail} aria-label={tr('Close')}>×</button>
            </div>
            <ol className="es-path" aria-label={tr('Where it stands')}>
              {pathSteps.map((s, i) => <li key={i} className={(s.done ? 'is-done' : '') + (s.failed ? ' is-failed' : '')}>{s.label}</li>)}
            </ol>
            <ul className="rs-lines">
              {cur.items.map((it, i) => <li key={i}><span className="rs-qty">{it.qty}×</span><span>{it.description}<span className="dk-muted tl-small"> · {money(it.unitPrice, cur.currency)}</span></span><strong>{money(lineAmount(it), cur.currency)}</strong></li>)}
              {curTotals.map((r) => <li key={r.label} className={r.strong ? 'rs-total' : ''}><span /><span>{r.label}</span><strong>{r.value}</strong></li>)}
            </ul>
            <dl className="tl-facts">
              <div><dt>{tr('Made')}</dt><dd>{fmtDate(cur.createdAt)}{cur.createdByName ? ' · ' + cur.createdByName : ''}</dd></div>
              <div><dt>{tr('Sent')}</dt><dd>{cur.sentAt ? fmtDate(cur.sentAt) : '—'}</dd></div>
              <div><dt>{tr('Answered')}</dt><dd>{cur.answeredAt ? fmtDate(cur.answeredAt) : '—'}</dd></div>
              <div><dt>{tr('Valid until')}</dt><dd className={isWaiting(cur) && daysLeft(cur.validUntil) <= SOON_DAYS ? 'pk-owe' : ''}>{fmtDate(cur.validUntil)}</dd></div>
              {cur.estimateNo && <div><dt>{tr('From estimate')}</dt><dd><Link to="/estimates">{cur.estimateNo}</Link></dd></div>}
              {cur.invoice && <div><dt>{tr('Invoice')}</dt><dd><Link to={'/invoices?open=' + cur.invoice.id}>{cur.invoice.invoiceNo}</Link> · {codeLabel(cur.invoice.status)}{curInv && curInv.balanceDue > 0 ? ' · ' + tr('{amount} still to pay', { amount: money(curInv.balanceDue, cur.currency) }) : ''}</dd></div>}
            </dl>
            <div className="tl-holder is-inline">
              <div className="tl-holder-head">
                <span className="tl-holder-name"><strong>{cur.customerName}</strong><span className="dk-muted tl-small">{[cur.customerPhone, cur.customerEmail].filter(Boolean).join(' · ') || tr('no phone or email')}</span></span>
                <ContactButtons name={cur.customerName} phone={cur.customerPhone} email={cur.customerEmail} />
              </div>
            </div>
            {cur.notes && <><h3 className="tl-h3">{tr('Message to customer')}</h3><p className="tl-notes">{cur.notes}</p></>}
            {cur.terms && <details className="qt-terms"><summary>{tr('Terms & conditions')}</summary><p className="tl-notes">{cur.terms}</p></details>}
            <div className="dialog-actions tl-actions">
              {canManage && (cur.status === 'draft' || isWaiting(cur)) && <button type="button" className="btn btn-secondary" disabled={busyId === cur.id} onClick={() => setStatus(cur, 'cancelled')}>{tr('Cancel quotation')}</button>}
              {canManage && (isLost(cur) || toInvoice(cur)) && <button type="button" className="btn btn-secondary" disabled={busyId === cur.id} onClick={() => setStatus(cur, 'draft')}>{tr('Reopen as a draft')}</button>}
              {canManage && cur.status === 'draft' && <button type="button" className="btn btn-secondary" onClick={() => openEdit(cur)}>{tr('Edit')}</button>}
              <button type="button" className="btn btn-secondary" onClick={() => openPreview(cur)}>{tr('Preview')}</button>
              {canManage && isWaiting(cur) && <button type="button" className="btn btn-secondary" disabled={busyId === cur.id} onClick={() => setStatus(cur, 'rejected')}>{tr('Client turned it down')}</button>}
              {canManage && isWaiting(cur) && <button type="button" className="btn btn-primary" disabled={busyId === cur.id} onClick={() => setStatus(cur, 'accepted')}>{tr('Client accepted')}</button>}
              {canManage && cur.status === 'draft' && <button type="button" className="btn btn-primary" disabled={busyId === cur.id} onClick={() => setStatus(cur, 'sent')}>{tr('Mark as sent')}</button>}
              {canInvoice && toInvoice(cur) && <button type="button" className="btn btn-primary" disabled={busyId === cur.id} onClick={() => convertToInvoice(cur)}>{tr('Make the invoice')}</button>}
              {curInv && <Link className="btn btn-primary" to={'/invoices?open=' + curInv.id}>{tr('Open {no}', { no: curInv.invoiceNo })}</Link>}
            </div>
          </div>
        </div>
      )}

      {dialogOpen && (
        <DocWizard
          title={editId ? tr('Edit quotation') : tr('New quotation')} docKind="quotation"
          detailsSlot={
            <div className="quotations-dialog-fields">
              <div className="field">
                <label htmlFor="q-customer">{tr('Customer')}</label>
                <CustomerPicker id="q-customer" customers={customers} value={form.customerId} onChange={(id) => setForm({ ...form, customerId: id })} required />
              </div>
              <div className="field">
                <label htmlFor="q-title">{tr('Title')}</label>
                <input id="q-title" className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={tr('Quotation for ...')} />
              </div>
              <div className="field">
                <label htmlFor="q-currency">{tr('Currency')}</label>
                <select id="q-currency" className="input" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                  <option value="">{tr('Customer\'s default')}</option>
                  {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="q-valid">{tr('Valid until')}</label>
                <input id="q-valid" className="input" type="date" value={form.validUntil} onChange={(e) => setForm({ ...form, validUntil: e.target.value })} />
              </div>
            </div>
          }
          message={form.notes} onMessageChange={(v) => setForm({ ...form, notes: v })} messageLabel={tr('Message to customer')}
          items={items} onItemsChange={setItems} catalogOptions={catalog}
          currency={form.currency || (customers.find((c) => c.id === form.customerId) || {}).preferredCurrency || 'GHS'}
          docDiscount={docDiscount} onDocDiscountChange={setDocDiscount}
          docTaxRate={docTaxRate} onDocTaxRateChange={setDocTaxRate}
          paymentSchedule={paymentSchedule} onPaymentScheduleChange={setPaymentSchedule}
          recapBlocks={[
            { label: tr('Customer'), value: (customers.find((c) => c.id === form.customerId) || {}).name || '—' },
            { label: tr('Valid until'), value: form.validUntil ? fmtDate(form.validUntil) : '—' }
          ]}
          submitLabel={editId ? tr('Save changes') : tr('Create quotation')} saving={saving} error={dialogError}
          onSubmit={handleSubmit} onClose={() => setDialogOpen(false)}
        />
      )}

      {previewQ && (
        <DocPreview
          documentType="quotation" documentId={previewQ.id}
          docLabel={docTr('Quotation #{quoteNo}', { quoteNo: previewQ.quoteNo })}
          dateLabel={docTr('Issue date')}
          dateValue={formatDocDate(previewQ.createdAt)}
          heading={previewQ.title || (docTr('Quotation for {customerName}', { customerName: previewQ.customerName }))}
          subHeading={docTr('Valid until {date}', { date: formatDocDate(previewQ.validUntil) })}
          blocks={[
            { title: docTr('Customer'), lines: [previewQ.customerName, previewQ.customerEmail] },
            { title: docTr('Quotation Details'), lines: [docTr('Created {date}', { date: formatDocDate(previewQ.createdAt) }), money(previewQ.grandTotal, previewQ.currency)] },
            { title: docTr('Validity'), lines: [docTr('Valid until {date}', { date: formatDocDate(previewQ.validUntil) }), money(previewQ.grandTotal, previewQ.currency)] }
          ]}
          items={groupPackageItems(previewQ.items, previewQ.currency)}
          subtotal={money(previewQ.subtotal, previewQ.currency)}
          discountRows={adjustmentRows(previewQ, previewQ.currency).discountRows}
          taxRows={adjustmentRows(previewQ, previewQ.currency).taxRows}
          totalLabel={docTr('Grand Total')}
          total={money(previewQ.grandTotal, previewQ.currency)}
          notesLabel={docTr('Notes')}
          notesValue={previewQ.notes}
          termsLabel={docTr('Terms & conditions')}
          termsValue={previewQ.terms}
          paymentSchedule={formatPaymentSchedule(previewQ.paymentSchedule, previewQ.currency)}
          onClose={() => setPreviewQ(null)}
        />
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
