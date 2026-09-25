import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
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
import { adjustmentRows, lineAmount, paymentsForDocument, totalsForDialog } from '../lib/docItems';
import { money, moneyBreakdown } from '../lib/currency';
import { groupPackageItems } from '../lib/packages';
import { formatPaymentSchedule } from '../lib/paymentSchedule';
import { activeIntlLocale, tr, msg, docTr } from '../lib/i18n.jsx';
import { formatDocDate } from '../lib/dates';
import { codeLabel } from '../lib/codeLabels.js';
import './EmployeesPage.css';
import './ToolRoomPage.css';
import './RestaurantsPage.css';
import './PokiRentals.css';
import './CustomersPage.css';
import './EstimatesPage.css';
import './InvoicesPage.css';

// Invoices — what clients have been billed and what they still owe. Same
// "explains itself" layout as the dashboards (components/DashKit.jsx): what
// is owed and how much of it is overdue, what came in over the last 30 days
// and what falls due this week, what stands out (overdue with no reminder,
// the longest overdue, part-paid), how late the money is, and the invoices
// as cards or a list with a window for each one — its lines, the payments
// that brought the balance down, reminders sent and a WhatsApp reminder
// button (invoices.service.js list: overdue counts part-paid invoices too,
// with contact details, the quotation or order it came from and reminders).
//
// invoice.manage roles in this app's seed may lack customer.read and
// sales.read, so "New invoice" also needs customer.read and "From a sales
// order" also needs sales.read: a control that can't fill its picker is
// not shown. /invoices?open=<id> opens that invoice's window.

const AGES = [
  { key: 'notdue', label: msg('Not yet due'), test: (d) => d <= 0 },
  { key: 'a30', label: msg('1–30 days late'), test: (d) => d >= 1 && d <= 30 },
  { key: 'a60', label: msg('31–60 days late'), test: (d) => d >= 31 && d <= 60 },
  { key: 'a90', label: msg('61–90 days late'), test: (d) => d >= 61 && d <= 90 },
  { key: 'a90p', label: msg('Over 90 days late'), test: (d) => d > 90 }
];
const WEEK = 7;
const EMPTY_FORM = { customerId: '', dueDate: '', poReference: '', currency: '', notes: '' };
const EMPTY_EDIT = { dueDate: '', poReference: '' };
const METHODS = [['cash', msg('Cash')], ['bank_transfer', msg('Bank transfer')], ['mobile_money', msg('Mobile Money')], ['card', msg('Card')], ['cheque', msg('Cheque')], ['other', msg('Other')]];

function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function todayIso() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function dayNum(iso) { return Math.floor(new Date(String(iso).slice(0, 10) + 'T00:00:00Z').getTime() / 86400000); }
function daysLate(inv) { return inv.dueDate ? dayNum(todayIso()) - dayNum(inv.dueDate) : 0; }
function isOwing(inv) { return inv.status === 'unpaid' || inv.status === 'partially_paid'; }
function sumOf(list, key) {
  const m = {};
  list.forEach((x) => { m[x.currency] = (m[x.currency] || 0) + Number(x[key] || 0); });
  return Object.entries(m).filter(([, a]) => a > 0.005).map(([currency, amount]) => ({ currency, amount }));
}
function itemsLine(inv) { return (inv.items || []).map((i) => i.description).filter(Boolean).join(', '); }
function paidShare(inv) { return inv.grandTotal > 0 ? Math.min(100, Math.round((inv.amountPaid / inv.grandTotal) * 100)) : 0; }

function Mark({ inv, size = 44 }) {
  return <span className="pk-avatar cu-mark" style={{ width: size, height: size, background: avatarColor(inv.customerName), fontSize: Math.round(size * 0.34) }} aria-hidden="true">{initials(inv.customerName)}</span>;
}
function PaidBar({ inv }) {
  if (inv.status === 'void') return null;
  const pct = paidShare(inv);
  return (
    <span className={'iv-bar' + (inv.overdue ? ' is-late' : '')} role="img" aria-label={tr('{pct}% paid', { pct })}>
      <span style={{ width: pct + '%' }} />
    </span>
  );
}

export default function InvoicesPage() {
  const { can } = useAuth();
  const canManage = can('invoice.manage');
  const canSeeCustomers = can('customer.read');
  const canSeeCatalog = can('catalog.read');
  const canSeeSalesOrders = can('sales.read');
  const canOpenManual = canManage && canSeeCustomers;
  const [params, setParams] = useSearchParams();

  const [invoices, setInvoices] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [orders, setOrders] = useState([]);
  const [currencies, setCurrencies] = useState(['GHS']);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [items, setItems] = useState([blankDocItem()]);
  const [docDiscount, setDocDiscount] = useState({ value: 0, type: 'fixed' });
  const [docTaxRate, setDocTaxRate] = useState(0);
  const [paymentSchedule, setPaymentSchedule] = useState([]);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [detail, setDetail] = useState(() => params.get('open'));

  const [orderOpen, setOrderOpen] = useState(false);
  const [orderId, setOrderId] = useState('');
  const [orderBusy, setOrderBusy] = useState(false);

  const [payTarget, setPayTarget] = useState(null);
  const [payForm, setPayForm] = useState(null);
  const [payError, setPayError] = useState(null);
  const [paying, setPaying] = useState(false);

  const [editTarget, setEditTarget] = useState(null);
  const [editForm, setEditForm] = useState(EMPTY_EDIT);
  const [editError, setEditError] = useState(null);
  const [editSaving, setEditSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [previewInv, setPreviewInv] = useState(null);
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState('owing');
  const [age, setAge] = useState('');
  const [view, setView] = useState(() => readPref('bos.invoicesView', 'cards'));

  const load = useCallback(async () => {
    setError(null);
    try {
      const [inv, cust, cat, ord] = await Promise.all([
        api.get('/invoices'),
        canSeeCustomers ? api.get('/customers') : Promise.resolve([]),
        canSeeCatalog ? api.get('/catalog') : Promise.resolve([]),
        canSeeSalesOrders ? api.get('/sales-orders') : Promise.resolve([])
      ]);
      setInvoices(inv);
      setCustomers(cust);
      setCatalog(cat);
      setOrders(ord);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
    try {
      const settings = await api.get('/settings');
      if (settings.commercial && settings.commercial.currencies) setCurrencies(settings.commercial.currencies);
    } catch { /* falls back to GHS only, see QuotationsPage's identical comment */ }
  }, [canSeeCustomers, canSeeCatalog, canSeeSalesOrders]);

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
    setForm(EMPTY_FORM);
    setItems([blankDocItem()]);
    setDocDiscount({ value: 0, type: 'fixed' });
    setDocTaxRate(0);
    setPaymentSchedule([]);
    setDialogOpen(true);
  }
  async function handleSubmit() {
    setSaving(true);
    setDialogError(null);
    try {
      await api.post('/invoices', {
        customerId: form.customerId, items, dueDate: form.dueDate, poReference: form.poReference, notes: form.notes,
        currency: form.currency || undefined, discount: docDiscount, taxRate: docTaxRate, paymentSchedule
      });
      setToast(tr('Invoice created.'));
      setDialogOpen(false);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function createFromOrder(e) {
    e.preventDefault();
    if (!orderId) return;
    setOrderBusy(true);
    setError(null);
    try {
      const inv = await api.post('/invoices/from-order', { salesOrderId: orderId });
      setToast(tr('{invoiceNo} issued for the order.', { invoiceNo: inv.invoiceNo }));
      setOrderId('');
      setOrderOpen(false);
      await load();
    } catch (err) {
      setError(err.message);
      setOrderOpen(false);
    } finally {
      setOrderBusy(false);
    }
  }

  async function voidInvoice(inv) {
    setBusyId(inv.id);
    setError(null);
    try {
      await api.post('/invoices/' + inv.id + '/void', {});
      setToast(tr('{invoiceNo} voided.', { invoiceNo: inv.invoiceNo }));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }
  async function confirmDelete() {
    setDeleting(true);
    try {
      await api.del('/invoices/' + deleteTarget.id);
      setToast(tr('{invoiceNo} deleted.', { invoiceNo: deleteTarget.invoiceNo }));
      setDeleteTarget(null);
      closeDetail();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  function openPay(inv) {
    setPayError(null);
    setPayTarget(inv);
    setPayForm({ amount: inv.balanceDue, method: 'cash', date: todayIso(), reference: '', notes: '' });
  }
  async function submitPayment(e) {
    e.preventDefault();
    setPaying(true);
    setPayError(null);
    try {
      const r = await api.post('/invoices/' + payTarget.id + '/payments', payForm);
      setToast(tr('Payment recorded — receipt {receiptNo} generated.', { receiptNo: r.receipt.receiptNo }));
      setPayTarget(null);
      await load();
    } catch (err) {
      setPayError(err.message);
    } finally {
      setPaying(false);
    }
  }

  function openEdit(inv) {
    setEditError(null);
    setEditTarget(inv);
    setEditForm({ dueDate: inv.dueDate || '', poReference: inv.poReference || '' });
  }
  async function submitEdit(e) {
    e.preventDefault();
    setEditSaving(true);
    setEditError(null);
    try {
      const updated = await api.patch('/invoices/' + editTarget.id, editForm);
      setToast(tr('{invoiceNo} updated.', { invoiceNo: updated.invoiceNo }));
      setEditTarget(null);
      await load();
    } catch (err) {
      setEditError(err.message);
    } finally {
      setEditSaving(false);
    }
  }

  // Same as the Payment reminders page: the tab is opened on the click
  // itself (a window opened after waiting for the server is blocked as a
  // pop-up), then pointed at WhatsApp with the message the server wrote.
  async function remind(inv) {
    const win = window.open('', '_blank');
    setBusyId(inv.id);
    setError(null);
    try {
      const r = await api.post('/reminders/' + inv.id + '/whatsapp', { origin: window.location.origin });
      if (win) win.location.href = r.whatsappUrl;
      else window.location.href = r.whatsappUrl;
      setToast(tr('WhatsApp opened for {name} — press send there.', { name: inv.customerName }));
      await load();
    } catch (err) {
      if (win) win.close();
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  function openPreview(inv) {
    const cust = customers.find((c) => c.id === inv.customerId) || {};
    setPreviewInv({ ...inv, customerName: cust.name || inv.customerName, customerEmail: cust.email || inv.customerEmail || '' });
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const owing = invoices.filter(isOwing);
  const overdue = owing.filter((inv) => inv.overdue).sort((a, b) => b.daysOverdue - a.daysOverdue);
  const partPaid = owing.filter((inv) => inv.status === 'partially_paid');
  const dueSoon = owing.filter((inv) => !inv.overdue && inv.dueDate && daysLate(inv) > -WEEK - 1 && daysLate(inv) <= 0);
  const unreminded = overdue.filter((inv) => !inv.reminders);
  const since = dayNum(todayIso()) - 30;
  const recentPays = [];
  invoices.forEach((inv) => (inv.payments || []).forEach((p) => { if (dayNum(p.date) > since) recentPays.push({ currency: inv.currency, amount: p.amount }); }));
  const collected = sumOf(recentPays, 'amount');

  function showOnly(key) { setAge(''); setChip(chip === key ? 'owing' : key); jump('iv-list'); }
  const stats = [
    { icon: 'owed', value: moneyBreakdown(sumOf(owing, 'balanceDue'), money(0)), label: tr('owed to us'), note: owing.length === 1 ? tr('on 1 invoice') : tr('on {n} invoices', { n: owing.length }), onClick: () => showOnly('owing') },
    { icon: 'warn', value: moneyBreakdown(sumOf(overdue, 'balanceDue'), money(0)), label: tr('overdue'), note: overdue.length ? (overdue.length === 1 ? tr('1 invoice, {days} days late', { days: overdue[0].daysOverdue }) : tr('{n} invoices; the oldest {days} days late', { n: overdue.length, days: overdue[0].daysOverdue })) : tr('nothing past its due date'), tone: overdue.length ? 'bad' : 'good', onClick: () => showOnly('overdue') },
    { icon: 'cash', value: moneyBreakdown(collected, money(0)), label: tr('collected in the last 30 days'), note: recentPays.length === 1 ? tr('1 payment') : tr('{n} payments', { n: recentPays.length }), tone: collected.length ? 'good' : '', onClick: () => showOnly('paid') },
    { icon: 'calendar', value: moneyBreakdown(sumOf(dueSoon, 'balanceDue'), money(0)), label: tr('falls due this week'), note: dueSoon.length === 1 ? tr('1 invoice') : tr('{n} invoices', { n: dueSoon.length }), tone: dueSoon.length ? 'warn' : '', onClick: () => showOnly('soon') }
  ];

  const insights = [];
  if (unreminded.length) insights.push({ tone: 'bad', icon: 'send', text: unreminded.length === 1 ? tr('{name} is {days} days overdue on {no} and hasn\'t been reminded.', { name: unreminded[0].customerName, days: unreminded[0].daysOverdue, no: unreminded[0].invoiceNo }) : tr('{n} overdue invoices have never had a reminder.', { n: unreminded.length }), action: { label: unreminded.length === 1 ? tr('Open') : tr('Show them'), run: () => (unreminded.length === 1 ? setDetail(unreminded[0].id) : showOnly('noremind')) } });
  if (overdue.length && overdue[0].daysOverdue > 30) insights.push({ tone: 'bad', icon: 'clock', text: tr('{no} for {name} is {days} days overdue; {amount} still to pay.', { no: overdue[0].invoiceNo, name: overdue[0].customerName, days: overdue[0].daysOverdue, amount: money(overdue[0].balanceDue, overdue[0].currency) }), action: { label: tr('Open'), run: () => setDetail(overdue[0].id) } });
  if (dueSoon.length) insights.push({ tone: 'warn', icon: 'calendar', text: dueSoon.length === 1 ? tr('{no} for {name} falls due on {date}.', { no: dueSoon[0].invoiceNo, name: dueSoon[0].customerName, date: fmtDate(dueSoon[0].dueDate) }) : tr('{n} invoices fall due in the next seven days.', { n: dueSoon.length }), action: { label: tr('Show them'), run: () => showOnly('soon') } });
  if (partPaid.length) insights.push({ tone: 'info', icon: 'receipt', text: partPaid.length === 1 ? tr('{name} has paid part of {no}; {amount} still to come.', { name: partPaid[0].customerName, no: partPaid[0].invoiceNo, amount: money(partPaid[0].balanceDue, partPaid[0].currency) }) : tr('{n} invoices are part-paid; {amount} still to come.', { n: partPaid.length, amount: moneyBreakdown(sumOf(partPaid, 'balanceDue')) }), action: { label: tr('Show them'), run: () => showOnly('part') } });
  if (!overdue.length && invoices.length) insights.push({ tone: 'good', icon: 'check', text: owing.length ? tr('Nothing is overdue. Everything owed is still within its due date.') : tr('Every invoice is paid.') });

  const ageOf = (inv) => (AGES.find((a) => a.test(daysLate(inv))) || AGES[0]).key;
  const chipTest = {
    owing: isOwing, overdue: (inv) => overdue.includes(inv), soon: (inv) => dueSoon.includes(inv), part: (inv) => inv.status === 'partially_paid',
    noremind: (inv) => unreminded.includes(inv), paid: (inv) => inv.status === 'paid', void: (inv) => inv.status === 'void', all: () => true
  };
  const visible = invoices.filter(chipTest[chip] || chipTest.owing)
    .filter((inv) => !age || (isOwing(inv) && ageOf(inv) === age))
    .filter((inv) => matchesQuery(search, inv.invoiceNo, inv.customerName, itemsLine(inv), inv.poReference, inv.quoteNo, inv.orderNo));
  const chips = [
    ['owing', tr('Owing'), owing.length], ['overdue', tr('Overdue'), overdue.length], ['soon', tr('Due this week'), dueSoon.length],
    ['part', tr('Part-paid'), partPaid.length], ['noremind', tr('Not reminded'), unreminded.length], ['paid', tr('Paid'), invoices.filter(chipTest.paid).length],
    ['void', tr('Voided'), invoices.filter(chipTest.void).length], ['all', tr('All'), invoices.length]
  ].filter(([k, , c]) => c > 0 || k === 'owing' || k === chip);
  const ageRows = AGES.map((a) => { const list = owing.filter((inv) => ageOf(inv) === a.key); return { ...a, n: list.length, sum: sumOf(list, 'balanceDue') }; });

  function stateOf(inv) {
    if (inv.status === 'void') return { tone: 'muted', text: tr('Voided') };
    if (inv.status === 'paid') return { tone: 'good', text: inv.paidAt ? tr('Paid {date}', { date: fmtDate(inv.paidAt) }) : tr('Paid') };
    if (inv.overdue) return { tone: 'bad', text: tr('{days} days overdue', { days: inv.daysOverdue }) };
    const d = -daysLate(inv);
    const due = !inv.dueDate ? tr('No due date') : d === 0 ? tr('Due today') : d <= WEEK ? tr('Due in {n} days', { n: d }) : tr('Due {date}', { date: fmtDate(inv.dueDate) });
    return { tone: inv.status === 'partially_paid' ? 'warn' : d <= WEEK ? 'warn' : 'info', text: inv.status === 'partially_paid' ? tr('Part-paid') + ' · ' + due : due };
  }
  const canDelete = (inv) => canManage && inv.status === 'unpaid' && !(inv.amountPaid > 0);
  // Shared by the row menu and the window so the two cannot drift.
  function actionsFor(inv) {
    return [
      { label: tr('Open'), onClick: () => setDetail(inv.id) },
      { label: tr('Preview'), onClick: () => openPreview(inv) },
      canManage && isOwing(inv) && { label: tr('Record payment'), onClick: () => openPay(inv) },
      canManage && isOwing(inv) && inv.customerPhone && { label: tr('Remind on WhatsApp'), onClick: () => remind(inv) },
      canManage && inv.status !== 'void' && { label: tr('Change due date or PO'), onClick: () => openEdit(inv) },
      canManage && inv.status === 'unpaid' && { label: tr('Void'), onClick: () => voidInvoice(inv) },
      canDelete(inv) && { label: tr('Delete'), onClick: () => setDeleteTarget(inv), danger: true }
    ].filter(Boolean);
  }

  const cur = detail ? invoices.find((inv) => inv.id === detail) : null;
  const curTotals = cur ? totalsForDialog(cur, cur.currency).filter((r, i, all) => all.length > 2 || r.strong) : [];
  const orderChoices = orders.filter((o) => o.status !== 'cancelled' && !invoices.some((inv) => inv.salesOrderId === o.id && inv.status !== 'void'));

  return (
    <div className="dk tl pk cu iv">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('Quotations & Invoicing')}
        title={tr('Invoices')}
        sub={tr('What clients have been billed and what they still owe: what is overdue, what came in and what falls due next. Press a number to show only those.')}
        actions={(
          <>
            {canOpenManual && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('New invoice')}</button>}
            {canManage && canSeeSalesOrders && orderChoices.length > 0 && <button type="button" className="btn btn-secondary" onClick={() => setOrderOpen(true)}>{tr('From a sales order')}</button>}
            <Link className="btn btn-secondary" to="/reminders">{tr('Payment reminders')}</Link>
          </>
        )}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      <Section id="iv-ages" title={tr('How late the money is')} sub={tr('What is still owed, by how far past the due date. Press one to show only those.')}>
        <div className="cu-stages iv-ages" role="radiogroup" aria-label={tr('How late')}>
          {ageRows.map((a) => (
            <button key={a.key} type="button" role="radio" aria-checked={age === a.key} className={'cu-stage iv-age is-' + a.key + (age === a.key ? ' is-on' : '')}
              onClick={() => { setChip('owing'); setAge(age === a.key ? '' : a.key); jump('iv-list'); }}>
              <strong>{a.sum.length ? moneyBreakdown(a.sum) : '—'}</strong>
              <span>{tr(a.label)} · {a.n}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section id="iv-list" title={tr('Invoices')} sub={tr('Press an invoice to see its lines, the payments made and to send a reminder.')}
        action={(
          <div className="ppl-view" role="radiogroup" aria-label={tr('View')}>
            {[['cards', tr('Cards')], ['list', tr('List')]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? 'is-on' : ''} onClick={() => { setView(k); writePref('bos.invoicesView', k); }}>{label}</button>
            ))}
          </div>
        )}>
        <div className="tl-tools"><div className="tl-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search invoices…')} /></div></div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => { setChip(key); setAge(''); }}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
          {age && <button type="button" className="ppl-chip is-on" onClick={() => setAge('')}>{tr(AGES.find((a) => a.key === age).label)} ×</button>}
        </div>
        {!visible.length ? (
          <div className="dk-empty tl-empty">
            <p>{invoices.length ? tr('Nothing matches. Try another search or filter.') : tr('No invoices yet')}</p>
            {canOpenManual && !invoices.length && <button type="button" className="btn btn-primary" onClick={openNew}>{tr('New invoice')}</button>}
          </div>
        ) : view === 'cards' ? (
          <div className="tl-grid">
            {visible.map((inv) => {
              const st = stateOf(inv);
              return (
                <article key={inv.id} className={'tl-card' + (inv.overdue ? ' st-late' : '') + (inv.status === 'void' ? ' st-retired' : '')}>
                  <button type="button" className="tl-card-open" onClick={() => setDetail(inv.id)}>
                    <Mark inv={inv} />
                    <span className="tl-card-head">
                      <span className="dk-muted tl-small">{inv.invoiceNo} · {fmtDate(inv.issuedAt)}</span>
                      <span className="tl-name">{inv.customerName}</span>
                    </span>
                  </button>
                  <span className="tl-menu"><RowMenu disabled={busyId === inv.id} actions={actionsFor(inv)} /></span>
                  <p className="dk-muted tl-small es-items">{itemsLine(inv) || '—'}</p>
                  <div className="tl-tags"><Status tone={st.tone}>{st.text}</Status>{inv.reminders > 0 && isOwing(inv) && <Status tone="muted">{tr('Reminded {n}×', { n: inv.reminders })}</Status>}</div>
                  <PaidBar inv={inv} />
                  <div className="tl-foot">
                    <span className="iv-owe">
                      {isOwing(inv) ? <><span className="es-total">{money(inv.balanceDue, inv.currency)}</span><span className="dk-muted tl-small">{tr('of {amount}', { amount: money(inv.grandTotal, inv.currency) })}</span></> : <span className="es-total">{money(inv.grandTotal, inv.currency)}</span>}
                    </span>
                    <ContactButtons name={inv.customerName} phone={inv.customerPhone} email={inv.customerEmail} />
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="tl-table-wrap">
            <table className="tl-table">
              <thead><tr><th>{tr('Invoice')}</th><th>{tr('What for')}</th><th className="is-num">{tr('Total')}</th><th className="is-num">{tr('Still to pay')}</th><th>{tr('Where it stands')}</th><th /></tr></thead>
              <tbody>
                {visible.map((inv) => {
                  const st = stateOf(inv);
                  return (
                    <tr key={inv.id} className={inv.status === 'void' ? 'st-retired' : ''}>
                      <td><button type="button" className="tl-row-open" onClick={() => setDetail(inv.id)}><Mark inv={inv} size={32} /><span><span className="tl-name">{inv.customerName}</span><span className="dk-muted tl-small">{inv.invoiceNo}</span></span></button></td>
                      <td className="es-items-cell">{itemsLine(inv) || '—'}</td>
                      <td className="is-num">{money(inv.grandTotal, inv.currency)}</td>
                      <td className={'is-num' + (inv.overdue ? ' pk-owe' : '')}>{isOwing(inv) ? money(inv.balanceDue, inv.currency) : '—'}</td>
                      <td><Status tone={st.tone}>{st.text}</Status></td>
                      <td className="tl-menu-cell"><RowMenu disabled={busyId === inv.id} actions={actionsFor(inv)} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Glossary items={[
        [tr('Owed'), tr('What is still to pay on invoices that are not paid or voided, added up in each currency.')],
        [tr('Overdue'), tr('Still owed after the due date, including invoices that have been part-paid.')],
        [tr('Part-paid'), tr('Some money has come in, but not all of it.')],
        [tr('Collected'), tr('Payments recorded against invoices, by the date the money came in.')],
        [tr('Reminder'), tr('A WhatsApp or text message asking the client to pay, sent from here or the Payment reminders page.')],
        [tr('Voided'), tr('Cancelled and kept for the record. Only an invoice with no payments can be voided.')]
      ]} />

      {/* ── one invoice ── */}
      {cur && (
        <div className="dialog-backdrop" onClick={closeDetail}>
          <div className="dialog tl-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="tl-detail-head">
              <Mark inv={cur} size={56} />
              <div>
                <span className="dk-muted tl-small">{cur.invoiceNo} · {tr('Issued {date}', { date: fmtDate(cur.issuedAt) })}</span>
                <h2>{cur.customerName}</h2>
                <div className="tl-tags"><Status tone={stateOf(cur).tone}>{stateOf(cur).text}</Status></div>
              </div>
              <button type="button" className="tl-close" onClick={closeDetail} aria-label={tr('Close')}>×</button>
            </div>
            {cur.status !== 'void' && (
              <div className="iv-paid">
                <div className="iv-paid-nums">
                  <span><strong>{money(cur.amountPaid, cur.currency)}</strong> <span className="dk-muted">{tr('paid')}</span></span>
                  <span className={cur.overdue ? 'pk-owe' : ''}><strong>{money(cur.balanceDue, cur.currency)}</strong> <span className="dk-muted">{tr('still to pay')}</span></span>
                </div>
                <PaidBar inv={cur} />
              </div>
            )}
            <ul className="rs-lines">
              {cur.items.map((it, i) => <li key={i}><span className="rs-qty">{it.qty}×</span><span>{it.description}<span className="dk-muted tl-small"> · {money(it.unitPrice, cur.currency)}</span></span><strong>{money(lineAmount(it), cur.currency)}</strong></li>)}
              {curTotals.map((r) => <li key={r.label} className={r.strong ? 'rs-total' : ''}><span /><span>{r.label}</span><strong>{r.value}</strong></li>)}
            </ul>
            <dl className="tl-facts">
              <div><dt>{tr('Due')}</dt><dd className={cur.overdue ? 'pk-owe' : ''}>{cur.dueDate ? fmtDate(cur.dueDate) : '—'}</dd></div>
              {cur.poReference && <div><dt>{tr('PO reference')}</dt><dd>{cur.poReference}</dd></div>}
              {cur.quoteNo && <div><dt>{tr('From quotation')}</dt><dd><Link to={'/quotations?open=' + cur.quotationId}>{cur.quoteNo}</Link></dd></div>}
              {cur.orderNo && <div><dt>{tr('From sales order')}</dt><dd>{cur.orderNo}</dd></div>}
              <div><dt>{tr('Reminders')}</dt><dd>{cur.reminders ? tr('{n} sent, the last on {date}', { n: cur.reminders, date: fmtDate(cur.lastRemindedAt) }) : tr('none sent')}</dd></div>
              <div><dt>{tr('Currency')}</dt><dd>{cur.currency}</dd></div>
            </dl>
            <h3 className="tl-h3">{tr('Payments received')}</h3>
            {cur.payments && cur.payments.length ? (
              <ul className="tl-log">
                {cur.payments.map((p, i) => {
                  const d = new Date(String(p.date).slice(0, 10) + 'T00:00');
                  const shown = paymentsForDocument([p], cur.currency)[0];
                  return (
                    <li key={p.id || i} className="tl-log-row is-restock">
                      <span className="tl-date" aria-hidden="true"><strong>{d.getDate()}</strong><span>{d.toLocaleDateString(activeIntlLocale(), { month: 'short' })}</span></span>
                      <span className="tl-log-main">
                        <span className="tl-log-title">{shown.amount} · {codeLabel(p.method)}</span>
                        <span className="dk-muted tl-small">{[p.reference && tr('ref {reference}', { reference: p.reference }), p.receivedByName && tr('taken by {name}', { name: p.receivedByName })].filter(Boolean).join(' · ') || fmtDate(p.date)}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="dk-muted tl-small">{cur.status === 'void' ? tr('Voided before anything was paid.') : tr('Nothing paid yet.')}</p>}
            {cur.paymentSchedule && cur.paymentSchedule.length > 0 && (
              <>
                <h3 className="tl-h3">{tr('Payment schedule')}</h3>
                <ul className="rs-lines iv-schedule">
                  {formatPaymentSchedule(cur.paymentSchedule, cur.currency).map((row) => <li key={row.label}><span /><span>{row.label}<span className="dk-muted tl-small"> · {row.dueDate}</span></span><strong>{row.amount}</strong></li>)}
                </ul>
              </>
            )}
            <div className="tl-holder is-inline">
              <div className="tl-holder-head">
                <span className="tl-holder-name"><strong>{cur.customerName}</strong><span className="dk-muted tl-small">{[cur.customerPhone, cur.customerEmail].filter(Boolean).join(' · ') || tr('no phone or email')}</span></span>
                <ContactButtons name={cur.customerName} phone={cur.customerPhone} email={cur.customerEmail} />
              </div>
            </div>
            {cur.notes && <><h3 className="tl-h3">{tr('Message to customer')}</h3><p className="tl-notes">{cur.notes}</p></>}
            <div className="dialog-actions tl-actions">
              {canDelete(cur) && <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(cur)}>{tr('Delete')}</button>}
              {canManage && cur.status === 'unpaid' && <button type="button" className="btn btn-secondary" disabled={busyId === cur.id} onClick={() => voidInvoice(cur)}>{tr('Void')}</button>}
              {canManage && cur.status !== 'void' && <button type="button" className="btn btn-secondary" onClick={() => openEdit(cur)}>{tr('Change due date or PO')}</button>}
              <button type="button" className="btn btn-secondary" onClick={() => openPreview(cur)}>{tr('Preview')}</button>
              {canManage && isOwing(cur) && cur.customerPhone && <button type="button" className="btn btn-secondary" disabled={busyId === cur.id} onClick={() => remind(cur)}>{tr('Remind on WhatsApp')}</button>}
              {canManage && isOwing(cur) && <button type="button" className="btn btn-primary" onClick={() => openPay(cur)}>{tr('Record payment')}</button>}
            </div>
          </div>
        </div>
      )}

      {dialogOpen && (
        <DocWizard
          title={tr('New invoice')} docKind="invoice"
          detailsSlot={
            <div className="invoices-dialog-fields">
              <div className="field">
                <label htmlFor="iv-customer">{tr('Customer')}</label>
                <CustomerPicker id="iv-customer" customers={customers} value={form.customerId} onChange={(id) => setForm({ ...form, customerId: id })} required />
              </div>
              <div className="field">
                <label htmlFor="iv-currency">{tr('Currency')}</label>
                <select id="iv-currency" className="input" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                  <option value="">{tr('Customer\'s default')}</option>
                  {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="iv-due">{tr('Due date')}</label>
                <input id="iv-due" className="input" type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="iv-po">{tr('PO / reference')}</label>
                <input id="iv-po" className="input" value={form.poReference} onChange={(e) => setForm({ ...form, poReference: e.target.value })} />
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
            { label: tr('Due date'), value: form.dueDate ? fmtDate(form.dueDate) : '—' }
          ]}
          submitLabel={tr('Create invoice')} saving={saving} error={dialogError}
          onSubmit={handleSubmit} onClose={() => setDialogOpen(false)}
        />
      )}

      {orderOpen && (
        <div className="dialog-backdrop" onClick={() => !orderBusy && setOrderOpen(false)}>
          <form className="dialog tl-dialog" onClick={(e) => e.stopPropagation()} onSubmit={createFromOrder}>
            <h2>{tr('Issue invoice for a sales order')}</h2>
            <p className="dk-muted tl-small">{tr('Only orders without an invoice are listed. The invoice copies the order\'s lines.')}</p>
            <div className="field">
              <label htmlFor="iv-order">{tr('Sales order')}</label>
              <select id="iv-order" className="input" value={orderId} onChange={(e) => setOrderId(e.target.value)} required>
                <option value="">{tr('Choose a sales order')}</option>
                {orderChoices.map((o) => <option key={o.id} value={o.id}>{o.orderNo} — {o.customerName}</option>)}
              </select>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setOrderOpen(false)}>{tr('Cancel')}</button>
              <button className="btn btn-primary" type="submit" disabled={!orderId || orderBusy}>{tr('Issue invoice')}</button>
            </div>
          </form>
        </div>
      )}

      {payTarget && (
        <div className="dialog-backdrop" onClick={() => !paying && setPayTarget(null)}>
          <form className="dialog tl-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitPayment}>
            <h2>{tr('Record payment')}</h2>
            <p className="dk-muted tl-small">{payTarget.invoiceNo} · {payTarget.customerName} · {tr('Outstanding balance:')} <strong>{money(payTarget.balanceDue, payTarget.currency)}</strong></p>
            {payError && <div className="error-banner">{payError}</div>}
            <div className="tl-form">
              <div className="field">
                <label htmlFor="pay-amount">{tr('Amount ({currency})', { currency: payTarget.currency })}</label>
                <input id="pay-amount" className="input" type="number" min="0.01" step="0.01" max={payTarget.balanceDue} value={payForm.amount} onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })} required />
              </div>
              <div className="field">
                <label htmlFor="pay-date">{tr('Date')}</label>
                <input id="pay-date" className="input" type="date" max={todayIso()} value={payForm.date} onChange={(e) => setPayForm({ ...payForm, date: e.target.value })} />
              </div>
              <div className="field tl-span">
                <span className="iv-label" id="pay-method-l">{tr('Method')}</span>
                <div className="tl-seg" role="radiogroup" aria-labelledby="pay-method-l">
                  {METHODS.map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={payForm.method === k} className={'tl-seg-btn' + (payForm.method === k ? ' is-on' : '')} onClick={() => setPayForm({ ...payForm, method: k })}>{tr(label)}</button>)}
                </div>
              </div>
              <div className="field">
                <label htmlFor="pay-ref">{tr('Transaction / reference')}</label>
                <input id="pay-ref" className="input" value={payForm.reference} onChange={(e) => setPayForm({ ...payForm, reference: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="pay-notes">{tr('Notes')}</label>
                <input id="pay-notes" className="input" value={payForm.notes} onChange={(e) => setPayForm({ ...payForm, notes: e.target.value })} />
              </div>
            </div>
            <p className="dk-muted tl-small">{tr('A receipt is made for every payment.')}</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setPayTarget(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={paying}>{paying ? tr('Saving…') : tr('Record payment')}</button>
            </div>
          </form>
        </div>
      )}

      {editTarget && (
        <div className="dialog-backdrop" onClick={() => !editSaving && setEditTarget(null)}>
          <form className="dialog tl-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitEdit}>
            <h2>{tr('Change due date or PO')}</h2>
            <p className="dk-muted tl-small">{editTarget.invoiceNo} · {editTarget.customerName}</p>
            {editError && <div className="error-banner">{editError}</div>}
            <div className="tl-form">
              <div className="field">
                <label htmlFor="ivedit-due">{tr('Due date')}</label>
                <input id="ivedit-due" className="input" type="date" value={editForm.dueDate} onChange={(e) => setEditForm({ ...editForm, dueDate: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="ivedit-po">{tr('PO / reference')}</label>
                <input id="ivedit-po" className="input" value={editForm.poReference} onChange={(e) => setEditForm({ ...editForm, poReference: e.target.value })} />
              </div>
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setEditTarget(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={editSaving}>{tr('Save changes')}</button>
            </div>
          </form>
        </div>
      )}

      {deleteTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Delete {invoiceNo}', { invoiceNo: deleteTarget.invoiceNo })}</h2>
            <p className="dialog-body">{tr('This cannot be undone.')}</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={confirmDelete}>{deleting ? tr('Deleting…') : tr('Delete')}</button>
            </div>
          </div>
        </div>
      )}

      {previewInv && (
        <DocPreview
          documentType="invoice" documentId={previewInv.id}
          docLabel={docTr('Invoice #{invoiceNo}', { invoiceNo: previewInv.invoiceNo })}
          dateLabel={docTr('Issue date')}
          dateValue={formatDocDate(previewInv.issuedAt)}
          heading={docTr('Invoice for {customerName}', { customerName: previewInv.customerName })}
          subHeading={docTr('Due {date}', { date: formatDocDate(previewInv.dueDate) })}
          blocks={[
            { title: docTr('Customer'), lines: [previewInv.customerName, previewInv.customerEmail] },
            { title: docTr('Invoice Details'), lines: [docTr('Issued {date}', { date: formatDocDate(previewInv.issuedAt) }), money(previewInv.grandTotal, previewInv.currency)] },
            { title: docTr('Payment'), lines: [docTr('Due {date}', { date: formatDocDate(previewInv.dueDate) }), money(previewInv.balanceDue, previewInv.currency)] }
          ]}
          items={groupPackageItems(previewInv.items, previewInv.currency)}
          subtotal={money(previewInv.subtotal, previewInv.currency)}
          discountRows={adjustmentRows(previewInv, previewInv.currency).discountRows}
          taxRows={adjustmentRows(previewInv, previewInv.currency).taxRows}
          payments={paymentsForDocument(previewInv.payments, previewInv.currency)}
          isPartial={previewInv.amountPaid > 0 && previewInv.balanceDue > 0}
          amountPaid={money(previewInv.amountPaid, previewInv.currency)}
          totalLabel={docTr('Total Due')}
          total={money(previewInv.balanceDue, previewInv.currency)}
          notesLabel={docTr('Payment instructions')}
          notesValue={previewInv.bankInstructions}
          paymentSchedule={formatPaymentSchedule(previewInv.paymentSchedule, previewInv.currency)}
          onClose={() => setPreviewInv(null)}
        />
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
