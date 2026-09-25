import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import ContactButtons from '../components/ContactButtons';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import RowMenu from '../components/RowMenu';
import { Glossary, Hero, Insights, Section, Status, avatarColor, fmtDate, initials, jump } from '../components/DashKit';
import { lineAmount } from '../lib/docItems';
import { money, moneyBreakdown } from '../lib/currency';
import { tr, msg } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import './EmployeesPage.css';
import './ToolRoomPage.css';
import './RestaurantsPage.css';
import './PokiRentals.css';
import './CustomersPage.css';
import './EstimatesPage.css';
import './SalesOrdersPage.css';

// Sales orders — accepted quotations turned into work to deliver. Same
// "explains itself" layout as the dashboards (components/DashKit.jsx):
// what is still to deliver and what is late against the date promised to
// the client, what was delivered but not invoiced, accepted quotations that
// never became an order, the path from order to invoice, and the orders as
// cards or a list with a window for each one (salesOrders.service.js:
// promised and delivered dates, notes, the quotation it came from and the
// invoice made from it).
//
// An order moves pending → processing → delivered; it can go one step back,
// be cancelled (not while an invoice stands on it) and a cancelled one can
// be reopened. The promised date and notes can change until delivery.
// Status buttons need sales.manage, "Make the invoice" invoice.manage and
// "New order" quotation.read as well, since its list comes from the
// quotations. /sales-orders?open=<id> opens that order's window.

const STAGES = [
  { key: 'pending', label: msg('Not started') }, { key: 'processing', label: msg('Being made') }, { key: 'delivered', label: msg('Delivered') },
  { key: 'invoiced', label: msg('Invoiced') }, { key: 'cancelled', label: msg('Cancelled') }
];
const SOON_DAYS = 7;
const IDLE_DAYS = 7;
const RECENT_DAYS = 90;
const EMPTY_NEW = { quotationId: '', promisedDate: '', notes: '' };

function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function dayNum(iso) { return Math.floor(new Date(String(iso).slice(0, 10) + 'T00:00').getTime() / 86400000); }
function todayNum() { const t = new Date(); return Math.floor(new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime() / 86400000); }
function localDay(ts) { if (!ts) return null; const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function daysSince(ts) { return ts ? todayNum() - dayNum(localDay(ts)) : null; }
function daysLeft(iso) { return iso ? dayNum(iso) - todayNum() : null; }

function isOpen(o) { return o.status === 'pending' || o.status === 'processing'; }
function liveInvoice(o) { return o.invoice && o.invoice.status !== 'void' ? o.invoice : null; }
function toInvoice(o) { return o.status === 'delivered' && !liveInvoice(o); }
function isLate(o) { return isOpen(o) && o.promisedDate && daysLeft(o.promisedDate) < 0; }
function isSoon(o) { const d = daysLeft(o.promisedDate); return isOpen(o) && d !== null && d >= 0 && d <= SOON_DAYS; }
function stageOf(o) { return o.status === 'delivered' && liveInvoice(o) ? 'invoiced' : o.status; }
function sumBy(list) {
  const m = {};
  list.forEach((o) => { m[o.currency] = (m[o.currency] || 0) + Number(o.total || o.grandTotal || 0); });
  return Object.entries(m).map(([currency, amount]) => ({ currency, amount }));
}
function itemsLine(o) { return (o.items || []).map((i) => i.description).filter(Boolean).join(', ') || '—'; }

function Mark({ o, size = 44 }) {
  return <span className="pk-avatar cu-mark" style={{ width: size, height: size, background: avatarColor(o.customerName), fontSize: Math.round(size * 0.34) }} aria-hidden="true">{initials(o.customerName)}</span>;
}

export default function SalesOrdersPage() {
  const { can } = useAuth();
  const canManage = can('sales.manage');
  const canInvoice = can('invoice.manage');
  const canSeeQuotations = can('quotation.read');
  const canOpenNew = canManage && canSeeQuotations;
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const [orders, setOrders] = useState([]);
  const [quotations, setQuotations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [detail, setDetail] = useState(() => params.get('open'));
  const [edit, setEdit] = useState(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newForm, setNewForm] = useState(EMPTY_NEW);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState('open');
  const [stage, setStage] = useState('');
  const [view, setView] = useState(() => readPref('bos.salesOrdersView', 'cards'));

  const load = useCallback(async () => {
    setError(null);
    try {
      const [ords, qs] = await Promise.all([
        api.get('/sales-orders'),
        canSeeQuotations ? api.get('/quotations') : Promise.resolve([])
      ]);
      setOrders(ords);
      setQuotations(qs);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [canSeeQuotations]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  function closeDetail() {
    setDetail(null);
    setEdit(null);
    if (params.get('open')) { params.delete('open'); setParams(params, { replace: true }); }
  }

  async function run(o, fn, done) {
    setBusyId(o.id);
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
  const setStatus = (o, status) => run(o, () => api.post('/sales-orders/' + o.id + '/status', { status }), () => tr('{orderNo} set to {status}.', { orderNo: o.orderNo, status: codeLabel(status) }));
  const makeInvoice = (o) => run(o, () => api.post('/invoices/from-order', { salesOrderId: o.id }), (inv) => tr('{invoiceNo} issued for the order.', { invoiceNo: inv.invoiceNo }));

  function openNew(quotationId) {
    setDialogError(null);
    setNewForm({ ...EMPTY_NEW, quotationId: quotationId || '' });
    setNewOpen(true);
  }
  async function createOrder(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      const o = await api.post('/sales-orders', newForm);
      setToast(tr('{orderNo} created.', { orderNo: o.orderNo }));
      setNewOpen(false);
      await load();
      setDetail(o.id);
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }
  async function saveEdit(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      await api.patch('/sales-orders/' + detail, edit);
      setToast(tr('Order updated.'));
      setEdit(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const open = orders.filter(isOpen);
  const late = open.filter(isLate).sort((a, b) => dayNum(a.promisedDate) - dayNum(b.promisedDate));
  const soon = open.filter(isSoon).sort((a, b) => dayNum(a.promisedDate) - dayNum(b.promisedDate));
  const idle = orders.filter((o) => o.status === 'pending' && daysSince(o.createdAt) > IDLE_DAYS);
  const noDate = open.filter((o) => !o.promisedDate);
  const notInvoiced = orders.filter(toInvoice);
  const invoiced = orders.filter((o) => o.status === 'delivered' && liveInvoice(o));
  const cancelled = orders.filter((o) => o.status === 'cancelled');
  const deliveredRecent = orders.filter((o) => o.status === 'delivered' && daysSince(o.deliveredAt || o.createdAt) <= RECENT_DAYS);
  const onTime = deliveredRecent.filter((o) => o.promisedDate && o.deliveredAt);
  const onTimeShare = onTime.length ? Math.round((onTime.filter((o) => localDay(o.deliveredAt) <= o.promisedDate).length / onTime.length) * 100) : null;
  // Accepted quotations that never became an order and were not invoiced directly.
  const ordered = new Set(orders.filter((o) => o.status !== 'cancelled').map((o) => o.quotationId));
  const waitingQuotes = quotations.filter((q) => q.status === 'accepted' && !ordered.has(q.id) && !(q.invoice && q.invoice.status !== 'void'));

  function showOnly(key) { setStage(''); setChip(chip === key ? 'open' : key); jump('so-list'); }
  const stats = [
    { icon: 'bag', value: String(open.length), label: tr('orders still to deliver'), note: open.length ? tr('worth {amount}', { amount: moneyBreakdown(sumBy(open)) }) : tr('nothing waiting to be delivered'), onClick: () => showOnly('todeliver') },
    { icon: 'clock', value: String(late.length), label: tr('past the promised date'), note: late.length ? tr('the oldest by {days} days', { days: -daysLeft(late[0].promisedDate) }) : soon.length ? tr('{n} due within a week', { n: soon.length }) : tr('none late'), tone: late.length ? 'bad' : soon.length ? 'warn' : 'good', onClick: () => showOnly(late.length ? 'late' : 'soon') },
    { icon: 'receipt', value: String(notInvoiced.length), label: tr('delivered, not yet invoiced'), note: notInvoiced.length ? tr('worth {amount}', { amount: moneyBreakdown(sumBy(notInvoiced)) }) : tr('every delivered order is invoiced'), tone: notInvoiced.length ? 'bad' : '', onClick: () => showOnly('toinvoice') },
    { icon: 'check', value: String(deliveredRecent.length), label: tr('delivered in the last 90 days'), note: onTimeShare === null ? tr('worth {amount}', { amount: moneyBreakdown(sumBy(deliveredRecent), money(0)) }) : tr('{pct}% on or before the promised date', { pct: onTimeShare }), tone: deliveredRecent.length ? 'good' : '', onClick: () => showOnly('delivered') }
  ];

  const insights = [];
  if (late.length) insights.push({ tone: 'bad', icon: 'clock', text: late.length === 1 ? tr('{no} for {name} was promised for {date} and isn\'t delivered yet.', { no: late[0].orderNo, name: late[0].customerName, date: fmtDate(late[0].promisedDate) }) : tr('{n} orders are past the date promised to the client. Call them with a new date.', { n: late.length }), action: { label: late.length === 1 ? tr('Open') : tr('Show them'), run: () => (late.length === 1 ? setDetail(late[0].id) : showOnly('late')) } });
  if (notInvoiced.length) insights.push({ tone: 'bad', icon: 'receipt', text: notInvoiced.length === 1 ? tr('{no} for {name} was delivered but has no invoice yet.', { no: notInvoiced[0].orderNo, name: notInvoiced[0].customerName }) : tr('{n} delivered orders have no invoice yet.', { n: notInvoiced.length }), action: { label: notInvoiced.length === 1 ? tr('Open') : tr('Show them'), run: () => (notInvoiced.length === 1 ? setDetail(notInvoiced[0].id) : showOnly('toinvoice')) } });
  if (soon.length) insights.push({ tone: 'warn', icon: 'calendar', text: soon.length === 1 ? tr('{no} for {name} is promised for {date}.', { no: soon[0].orderNo, name: soon[0].customerName, date: fmtDate(soon[0].promisedDate) }) : tr('{n} orders are promised within a week.', { n: soon.length }), action: { label: soon.length === 1 ? tr('Open') : tr('Show them'), run: () => (soon.length === 1 ? setDetail(soon[0].id) : showOnly('soon')) } });
  if (idle.length) insights.push({ tone: 'warn', icon: 'owed', text: idle.length === 1 ? tr('{no} for {name} was ordered {days} days ago and work hasn\'t started.', { no: idle[0].orderNo, name: idle[0].customerName, days: daysSince(idle[0].createdAt) }) : tr('{n} orders have waited more than a week without work starting.', { n: idle.length }), action: { label: idle.length === 1 ? tr('Open') : tr('Show them'), run: () => (idle.length === 1 ? setDetail(idle[0].id) : showOnly('pending')) } });
  if (waitingQuotes.length) insights.push({ tone: 'info', icon: 'doc', text: waitingQuotes.length === 1 ? tr('{no} for {name} was accepted but has no order or invoice yet.', { no: waitingQuotes[0].quoteNo, name: waitingQuotes[0].customerName }) : tr('{n} accepted quotations have no order or invoice yet, worth {amount}.', { n: waitingQuotes.length, amount: moneyBreakdown(sumBy(waitingQuotes)) }), action: canOpenNew ? { label: tr('Make an order'), run: () => openNew(waitingQuotes.length === 1 ? waitingQuotes[0].id : '') } : null });
  if (noDate.length) insights.push({ tone: 'info', icon: 'calendar', text: noDate.length === 1 ? tr('{no} has no promised date. Agree one with the client so it can\'t slip.', { no: noDate[0].orderNo }) : tr('{n} orders have no promised date. Agree one with each client so none can slip.', { n: noDate.length }), action: { label: noDate.length === 1 ? tr('Open') : tr('Show them'), run: () => (noDate.length === 1 ? setDetail(noDate[0].id) : showOnly('nodate')) } });
  if (!insights.length && orders.length) insights.push({ tone: 'good', icon: 'check', text: tr('Nothing is late and every delivered order is invoiced.') });

  const chipTest = {
    open: (o) => isOpen(o) || toInvoice(o), todeliver: isOpen, pending: (o) => o.status === 'pending', processing: (o) => o.status === 'processing',
    late: isLate, soon: isSoon, nodate: (o) => isOpen(o) && !o.promisedDate, delivered: (o) => deliveredRecent.includes(o),
    toinvoice: toInvoice, invoiced: (o) => invoiced.includes(o), cancelled: (o) => o.status === 'cancelled', all: () => true
  };
  const visible = orders.filter(chipTest[chip] || chipTest.open)
    .filter((o) => !stage || stageOf(o) === stage)
    .filter((o) => matchesQuery(search, o.orderNo, o.customerName, itemsLine(o), o.quoteNo, o.invoice && o.invoice.invoiceNo, o.notes, o.createdByName));
  const chips = [
    ['open', tr('Needs something'), orders.filter(chipTest.open).length], ['todeliver', tr('To deliver'), open.length],
    ['late', tr('Late'), late.length], ['soon', tr('Due within a week'), soon.length], ['nodate', tr('No promised date'), noDate.length],
    ['toinvoice', tr('To invoice'), notInvoiced.length], ['delivered', tr('Delivered lately'), deliveredRecent.length], ['cancelled', tr('Cancelled'), cancelled.length], ['all', tr('All'), orders.length]
  ].filter(([k, , c]) => c > 0 || k === 'open' || k === chip);
  const counts = { pending: orders.filter(chipTest.pending).length, processing: orders.filter(chipTest.processing).length, delivered: notInvoiced.length, invoiced: invoiced.length, cancelled: cancelled.length };

  function stateOf(o, short) {
    const inv = liveInvoice(o);
    if (o.status === 'cancelled') return { tone: 'muted', text: tr('Cancelled') };
    if (o.status === 'delivered' && inv) return { tone: inv.status === 'paid' ? 'good' : 'info', text: inv.invoiceNo + ' · ' + codeLabel(inv.status) };
    if (o.status === 'delivered') return { tone: 'bad', text: tr('Delivered · not invoiced') };
    const what = o.status === 'processing' ? tr('Being made') : tr('Not started');
    if (isLate(o)) return { tone: 'bad', text: tr('{what} · {days} days late', { what, days: -daysLeft(o.promisedDate) }) };
    if (isSoon(o)) return { tone: 'warn', text: daysLeft(o.promisedDate) === 0 ? tr('{what} · due today', { what }) : tr('{what} · due in {days} days', { what, days: daysLeft(o.promisedDate) }) };
    return { tone: o.status === 'processing' ? 'info' : 'muted', text: o.promisedDate && !short ? tr('{what} · due {date}', { what, date: fmtDate(o.promisedDate) }) : what };
  }
  // Shared by the row menu and the window so the two cannot drift.
  function actionsFor(o) {
    const inv = liveInvoice(o);
    return [
      { label: tr('Open'), onClick: () => setDetail(o.id) },
      canManage && o.status === 'pending' && { label: tr('Start work'), onClick: () => setStatus(o, 'processing') },
      canManage && o.status === 'processing' && { label: tr('Mark delivered'), onClick: () => setStatus(o, 'delivered') },
      canInvoice && o.status !== 'cancelled' && !inv && { label: tr('Make the invoice'), onClick: () => makeInvoice(o) },
      inv && { label: tr('Open {no}', { no: inv.invoiceNo }), to: '/invoices?open=' + inv.id },
      o.quotationId && { label: tr('Open {no}', { no: o.quoteNo }), to: '/quotations?open=' + o.quotationId },
      canManage && o.status === 'processing' && { label: tr('Back to not started'), onClick: () => setStatus(o, 'pending') },
      canManage && o.status === 'delivered' && { label: tr('Not delivered after all'), onClick: () => setStatus(o, 'processing') },
      canManage && o.status === 'cancelled' && { label: tr('Reopen'), onClick: () => setStatus(o, 'pending') },
      canManage && isOpen(o) && !inv && { label: tr('Cancel order'), onClick: () => setStatus(o, 'cancelled'), danger: true }
    ].filter(Boolean).map((a) => (a.to ? { label: a.label, onClick: () => navigate(a.to) } : a));
  }

  const cur = detail ? orders.find((o) => o.id === detail) : null;
  const curInv = cur ? liveInvoice(cur) : null;
  const pathSteps = cur ? [
    { label: tr('Ordered'), done: true },
    { label: tr('Being made'), done: cur.status === 'processing' || cur.status === 'delivered' },
    { label: cur.status === 'cancelled' ? tr('Cancelled') : tr('Delivered'), done: cur.status === 'delivered', failed: cur.status === 'cancelled' },
    { label: tr('Invoiced'), done: !!curInv }
  ] : [];
  const pickable = waitingQuotes;

  return (
    <div className="dk tl pk cu so">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('Insights')}
        title={tr('Sales orders')}
        sub={tr('Accepted quotations turned into work to deliver: what is still to make, what is late against the date promised to the client, and what was delivered but not invoiced. Press a number to show only those.')}
        actions={(
          <>
            {canOpenNew && <button type="button" className="btn btn-primary" onClick={() => openNew('')}>{tr('New order')}</button>}
            {canSeeQuotations && <Link className="btn btn-secondary" to="/quotations">{tr('Quotations')}</Link>}
          </>
        )}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      <Section id="so-stages" title={tr('From order to invoice')} sub={tr('Where the orders are. Press one to show only those.')}>
        <div className="cu-stages so-stages" role="radiogroup" aria-label={tr('Stage')}>
          {STAGES.map((s, i) => (
            <button key={s.key} type="button" role="radio" aria-checked={stage === s.key} className={'cu-stage so-stage is-' + s.key + (stage === s.key ? ' is-on' : '')}
              onClick={() => { setChip('all'); setStage(stage === s.key ? '' : s.key); jump('so-list'); }}>
              <strong>{counts[s.key] || 0}</strong>
              <span>{tr(s.label)}</span>
              {i < 3 && <i className="cu-stage-arrow" aria-hidden="true">→</i>}
            </button>
          ))}
        </div>
      </Section>

      <Section id="so-list" title={tr('Orders')} sub={tr('Press an order to see its lines, dates and what came of it.')}
        action={(
          <div className="ppl-view" role="radiogroup" aria-label={tr('View')}>
            {[['cards', tr('Cards')], ['list', tr('List')]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? 'is-on' : ''} onClick={() => { setView(k); writePref('bos.salesOrdersView', k); }}>{label}</button>
            ))}
          </div>
        )}>
        <div className="tl-tools"><div className="tl-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search sales orders…')} /></div></div>
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
            <p>{orders.length ? tr('Nothing matches. Try another search or filter.') : tr('No sales orders yet')}</p>
            {canOpenNew && !orders.length && <button type="button" className="btn btn-primary" onClick={() => openNew('')}>{tr('New order')}</button>}
          </div>
        ) : view === 'cards' ? (
          <div className="tl-grid">
            {visible.map((o) => {
              const st = stateOf(o);
              return (
                <article key={o.id} className={'tl-card' + (st.tone === 'bad' ? ' st-late' : '') + (o.status === 'cancelled' ? ' st-retired' : '')}>
                  <button type="button" className="tl-card-open" onClick={() => setDetail(o.id)}>
                    <Mark o={o} />
                    <span className="tl-card-head">
                      <span className="dk-muted tl-small">{o.orderNo} · {fmtDate(o.createdAt)}</span>
                      <span className="tl-name">{o.customerName}</span>
                    </span>
                  </button>
                  <span className="tl-menu"><RowMenu disabled={busyId === o.id} actions={actionsFor(o)} /></span>
                  <p className="dk-muted tl-small es-items">{itemsLine(o)}</p>
                  <div className="tl-tags"><Status tone={st.tone}>{st.text}</Status></div>
                  <div className="tl-foot">
                    <span className="es-total">{money(o.total, o.currency)}</span>
                    <ContactButtons name={o.customerName} phone={o.customerPhone} email={o.customerEmail} />
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="tl-table-wrap">
            <table className="tl-table">
              <thead><tr><th>{tr('Order')}</th><th>{tr('What for')}</th><th className="is-num">{tr('Total')}</th><th>{tr('Where it stands')}</th><th>{tr('Promised for')}</th><th /></tr></thead>
              <tbody>
                {visible.map((o) => {
                  const st = stateOf(o, true);
                  return (
                    <tr key={o.id} className={o.status === 'cancelled' ? 'st-retired' : ''}>
                      <td><button type="button" className="tl-row-open" onClick={() => setDetail(o.id)}><Mark o={o} size={32} /><span><span className="tl-name">{o.customerName}</span><span className="dk-muted tl-small">{o.orderNo}</span></span></button></td>
                      <td className="es-items-cell">{itemsLine(o)}</td>
                      <td className="is-num">{money(o.total, o.currency)}</td>
                      <td><Status tone={st.tone}>{st.text}</Status></td>
                      <td className={isLate(o) ? 'pk-owe' : ''}>{o.promisedDate ? fmtDate(o.promisedDate) : '—'}</td>
                      <td className="tl-menu-cell"><RowMenu disabled={busyId === o.id} actions={actionsFor(o)} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Glossary items={[
        [tr('Sales order'), tr('An accepted quotation turned into work to deliver: the same lines and total, with the date promised to the client.')],
        [tr('Not started'), tr('The order is in but work hasn\'t begun.')],
        [tr('Being made'), tr('Work has started. It can be moved back to not started if it was marked by mistake.')],
        [tr('Promised for'), tr('The date the client was told to expect the order. An order still not delivered after that day counts as late.')],
        [tr('Delivered'), tr('The client has the goods. The next step is the invoice, if one wasn\'t made earlier.')],
        [tr('Invoiced'), tr('An invoice was made from the order. While that invoice stands (not voided), the order can\'t be cancelled.')],
        [tr('On or before the promised date'), tr('Of the orders delivered in the last 90 days that had a promised date, the share delivered by that day.')]
      ]} />

      {/* ── one order ── */}
      {cur && (
        <div className="dialog-backdrop" onClick={closeDetail}>
          <div className="dialog tl-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="tl-detail-head">
              <Mark o={cur} size={56} />
              <div>
                <span className="dk-muted tl-small">{cur.orderNo}{cur.quoteNo ? ' · ' + tr('from {no}', { no: cur.quoteNo }) : ''}</span>
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
              <li className="rs-total"><span /><span>{tr('Total')}</span><strong>{money(cur.total, cur.currency)}</strong></li>
            </ul>
            {edit ? (
              <form className="so-edit" onSubmit={saveEdit}>
                <div className="field">
                  <label htmlFor="so-edit-date">{tr('Promised for')}</label>
                  <input id="so-edit-date" className="input" type="date" value={edit.promisedDate} onChange={(e) => setEdit({ ...edit, promisedDate: e.target.value })} />
                </div>
                <div className="field so-edit-notes">
                  <label htmlFor="so-edit-notes">{tr('Notes')}</label>
                  <textarea id="so-edit-notes" className="input" rows={3} maxLength={1000} value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} placeholder={tr('Delivery address, who to call, anything the team should know')} />
                </div>
                {dialogError && <div className="error-banner so-edit-notes" role="alert">{dialogError}</div>}
                <div className="so-edit-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setEdit(null)}>{tr('Cancel')}</button>
                  <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Save')}</button>
                </div>
              </form>
            ) : (
              <>
                <dl className="tl-facts">
                  <div><dt>{tr('Ordered')}</dt><dd>{fmtDate(cur.createdAt)}{cur.createdByName ? ' · ' + cur.createdByName : ''}</dd></div>
                  <div><dt>{tr('Promised for')}</dt><dd className={isLate(cur) ? 'pk-owe' : ''}>{cur.promisedDate ? fmtDate(cur.promisedDate) : '—'}</dd></div>
                  <div><dt>{tr('Delivered')}</dt><dd>{cur.deliveredAt ? fmtDate(cur.deliveredAt) : '—'}</dd></div>
                  {cur.quotationId && <div><dt>{tr('From quotation')}</dt><dd><Link to={'/quotations?open=' + cur.quotationId}>{cur.quoteNo}</Link></dd></div>}
                  {cur.invoice && <div><dt>{tr('Invoice')}</dt><dd><Link to={'/invoices?open=' + cur.invoice.id}>{cur.invoice.invoiceNo}</Link> · {codeLabel(cur.invoice.status)}{curInv && curInv.balanceDue > 0 ? ' · ' + tr('{amount} still to pay', { amount: money(curInv.balanceDue, cur.currency) }) : ''}</dd></div>}
                </dl>
                {cur.notes && <><h3 className="tl-h3">{tr('Notes')}</h3><p className="tl-notes">{cur.notes}</p></>}
              </>
            )}
            <div className="tl-holder is-inline">
              <div className="tl-holder-head">
                <span className="tl-holder-name"><strong>{cur.customerName}</strong><span className="dk-muted tl-small">{[cur.customerPhone, cur.customerEmail].filter(Boolean).join(' · ') || tr('no phone or email')}</span></span>
                <ContactButtons name={cur.customerName} phone={cur.customerPhone} email={cur.customerEmail} />
              </div>
            </div>
            {!edit && (
              <div className="dialog-actions tl-actions">
                {canManage && isOpen(cur) && !curInv && <button type="button" className="btn btn-secondary" disabled={busyId === cur.id} onClick={() => setStatus(cur, 'cancelled')}>{tr('Cancel order')}</button>}
                {canManage && cur.status === 'cancelled' && <button type="button" className="btn btn-secondary" disabled={busyId === cur.id} onClick={() => setStatus(cur, 'pending')}>{tr('Reopen')}</button>}
                {canManage && cur.status === 'delivered' && <button type="button" className="btn btn-secondary" disabled={busyId === cur.id} onClick={() => setStatus(cur, 'processing')}>{tr('Not delivered after all')}</button>}
                {canManage && isOpen(cur) && <button type="button" className="btn btn-secondary" onClick={() => { setDialogError(null); setEdit({ promisedDate: cur.promisedDate || '', notes: cur.notes || '' }); }}>{tr('Change date or notes')}</button>}
                {canInvoice && cur.status !== 'cancelled' && !curInv && <button type="button" className={'btn ' + (cur.status === 'delivered' ? 'btn-primary' : 'btn-secondary')} disabled={busyId === cur.id} onClick={() => makeInvoice(cur)}>{tr('Make the invoice')}</button>}
                {canManage && cur.status === 'pending' && <button type="button" className="btn btn-primary" disabled={busyId === cur.id} onClick={() => setStatus(cur, 'processing')}>{tr('Start work')}</button>}
                {canManage && cur.status === 'processing' && <button type="button" className="btn btn-primary" disabled={busyId === cur.id} onClick={() => setStatus(cur, 'delivered')}>{tr('Mark delivered')}</button>}
                {curInv && <Link className="btn btn-primary" to={'/invoices?open=' + curInv.id}>{tr('Open {no}', { no: curInv.invoiceNo })}</Link>}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── new order ── */}
      {newOpen && (
        <div className="dialog-backdrop" onClick={() => setNewOpen(false)}>
          <form className="dialog so-new" onClick={(e) => e.stopPropagation()} onSubmit={createOrder}>
            <h2>{tr('New sales order')}</h2>
            <p className="dk-muted tl-small">{tr('An order copies the lines and total of an accepted quotation. Only accepted quotations with no order or invoice yet are listed.')}</p>
            <div className="field">
              <label htmlFor="so-quote">{tr('Accepted quotation')}</label>
              <select id="so-quote" className="input" required value={newForm.quotationId} onChange={(e) => setNewForm({ ...newForm, quotationId: e.target.value })}>
                <option value="">{pickable.length ? tr('Choose a quotation') : tr('No accepted quotation is waiting for an order')}</option>
                {pickable.map((q) => <option key={q.id} value={q.id}>{q.quoteNo} — {q.customerName} — {money(q.grandTotal, q.currency)}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="so-promised">{tr('Promised for')}</label>
              <input id="so-promised" className="input" type="date" value={newForm.promisedDate} onChange={(e) => setNewForm({ ...newForm, promisedDate: e.target.value })} />
              <span className="dk-muted tl-small">{tr('The date the client was told to expect it. Leave empty if not agreed yet.')}</span>
            </div>
            <div className="field">
              <label htmlFor="so-notes">{tr('Notes')}</label>
              <textarea id="so-notes" className="input" rows={3} maxLength={1000} value={newForm.notes} onChange={(e) => setNewForm({ ...newForm, notes: e.target.value })} placeholder={tr('Delivery address, who to call, anything the team should know')} />
            </div>
            {dialogError && <div className="error-banner" role="alert">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setNewOpen(false)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={!newForm.quotationId || saving}>{saving ? tr('Saving…') : tr('Create order')}</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
