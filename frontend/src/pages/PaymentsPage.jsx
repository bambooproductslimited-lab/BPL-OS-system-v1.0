import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { shareOrDownloadPdf } from '../lib/documentShare';
import ContactButtons from '../components/ContactButtons';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import RowMenu from '../components/RowMenu';
import ReceiptPreview from '../components/ReceiptPreview';
import { Glossary, Hero, Insights, Section, Status, avatarColor, fmtDate, initials, jump } from '../components/DashKit';
import { money, moneyBreakdown } from '../lib/currency';
import { tr, msg, docTr } from '../lib/i18n.jsx';
import './EmployeesPage.css';
import './ToolRoomPage.css';
import './RestaurantsPage.css';
import './PokiRentals.css';
import './CustomersPage.css';
import './EstimatesPage.css';
import './PaymentsPage.css';

// Payments — the money clients have paid against invoices. Same "explains
// itself" layout as the dashboards (components/DashKit.jsx): what came in
// this month and over the last 30 days against the 30 before, who paid
// most this year, bank and mobile money payments with no reference to
// match them on a statement, how the money came in (by method, last 90
// days), and the payments as cards or a list with a window for each one
// (payments.service.js list: Bamboo Products' invoices only, with the
// receipt each payment produced and where its invoice now stands).
//
// Removing a payment puts the amount back on its invoice and removes its
// receipt (payments.service.js remove). Every payment has exactly one
// receipt, so "preview the payment" is previewing its receipt.

const METHODS = [
  { key: 'cash', label: msg('Cash') }, { key: 'mobile_money', label: msg('Mobile Money') }, { key: 'bank_transfer', label: msg('Bank transfer') },
  { key: 'cheque', label: msg('Cheque') }, { key: 'card', label: msg('Card') }, { key: 'other', label: msg('Other') }
];
const NEEDS_REF = ['bank_transfer', 'mobile_money', 'cheque', 'card'];

function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function todayIso() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function dayNum(iso) { return Math.floor(new Date(String(iso).slice(0, 10) + 'T00:00:00Z').getTime() / 86400000); }
function ago(p) { return dayNum(todayIso()) - dayNum(p.date); }
function sumOf(list) {
  const m = {};
  list.forEach((x) => { m[x.currency] = (m[x.currency] || 0) + Number(x.amount || 0); });
  return Object.entries(m).map(([currency, amount]) => ({ currency, amount }));
}
function methodLabel(k) { return tr((METHODS.find((m) => m.key === k) || METHODS[5]).label); }
function noRef(p) { return NEEDS_REF.includes(p.method) && !String(p.reference || '').trim(); }

function Mark({ p, size = 44 }) {
  return <span className="pk-avatar cu-mark" style={{ width: size, height: size, background: avatarColor(p.customerName), fontSize: Math.round(size * 0.34) }} aria-hidden="true">{initials(p.customerName)}</span>;
}

export default function PaymentsPage() {
  const { can } = useAuth();
  const canManage = can('invoice.manage');
  const navigate = useNavigate();

  const [payments, setPayments] = useState([]);
  const [receiptByPaymentId, setReceiptByPaymentId] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [detail, setDetail] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState('month');
  const [method, setMethod] = useState('');
  const [view, setView] = useState(() => readPref('bos.paymentsView', 'cards'));
  const [previewR, setPreviewR] = useState(null);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState(null);
  const previewRef = useRef(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [paymentRows, receiptRows] = await Promise.all([api.get('/payments'), api.get('/receipts')]);
      setPayments(paymentRows);
      const map = {};
      receiptRows.forEach((r) => { map[r.paymentId] = r; });
      setReceiptByPaymentId(map);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  async function handleShare() {
    setShareError(null);
    setSharing(true);
    try {
      const filename = 'Receipt-' + previewR.receiptNo + '.pdf';
      await shareOrDownloadPdf(previewRef.current, filename, docTr('Receipt {no}', { no: previewR.receiptNo }), docTr('Receipt for {name}', { name: previewR.customerName }));
    } catch (err) {
      if (err.name !== 'AbortError') setShareError(err.message || tr('Could not share this receipt.'));
    } finally {
      setSharing(false);
    }
  }
  async function confirmDelete() {
    setDeleting(true);
    try {
      await api.del('/payments/' + deleteTarget.id);
      setToast(tr('Payment on {invoiceNo} deleted.', { invoiceNo: deleteTarget.invoiceNo }));
      setDeleteTarget(null);
      setDetail(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }
  function openReceipt(p) { setShareError(null); setPreviewR(receiptByPaymentId[p.id]); }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const monthKey = todayIso().slice(0, 7);
  const thisMonth = payments.filter((p) => String(p.date).slice(0, 7) === monthKey);
  const last30 = payments.filter((p) => ago(p) < 30);
  const prev30 = payments.filter((p) => ago(p) >= 30 && ago(p) < 60);
  const last90 = payments.filter((p) => ago(p) < 90);
  const year = payments.filter((p) => ago(p) < 365);
  const missingRef = payments.filter((p) => noRef(p) && ago(p) < 90);
  const cashMonth = thisMonth.filter((p) => p.method === 'cash');
  const byPayer = {};
  year.forEach((p) => { (byPayer[p.customerName] = byPayer[p.customerName] || []).push(p); });
  const payers = Object.entries(byPayer).map(([name, list]) => ({ name, list, sum: sumOf(list) })).sort((a, b) => (b.sum[0] ? b.sum[0].amount : 0) - (a.sum[0] ? a.sum[0].amount : 0));
  const main = (last30[0] || prev30[0] || payments[0] || {}).currency || 'GHS';
  const mainSum = (list) => list.filter((p) => p.currency === main).reduce((s, p) => s + p.amount, 0);
  const change = mainSum(prev30) > 0 ? Math.round(((mainSum(last30) - mainSum(prev30)) / mainSum(prev30)) * 100) : null;

  function showOnly(key) { setMethod(''); setChip(chip === key ? 'month' : key); jump('pm-list'); }
  const stats = [
    { icon: 'cash', value: moneyBreakdown(sumOf(thisMonth), money(0)), label: tr('received this month'), note: thisMonth.length === 1 ? tr('1 payment') : tr('{n} payments', { n: thisMonth.length }), tone: thisMonth.length ? 'good' : '', onClick: () => showOnly('month') },
    { icon: change !== null && change < 0 ? 'down' : 'up', value: moneyBreakdown(sumOf(last30), money(0)), label: tr('in the last 30 days'), note: change === null ? tr('nothing in the 30 days before') : change >= 0 ? tr('{pct}% more than the 30 days before', { pct: change }) : tr('{pct}% less than the 30 days before', { pct: -change }), tone: change !== null && change < 0 ? 'warn' : '', onClick: () => showOnly('d30') },
    { icon: 'people', value: payers.length ? payers[0].name : '—', label: tr('paid most in 12 months'), note: payers.length ? moneyBreakdown(payers[0].sum) : tr('nothing paid yet'), onClick: () => { if (payers.length) { setChip('all'); setMethod(''); setSearch(payers[0].name); jump('pm-list'); } } },
    { icon: 'warn', value: String(missingRef.length), label: tr('with no reference'), note: tr('bank, mobile money, cheque or card, last 90 days'), tone: missingRef.length ? 'warn' : 'good', onClick: () => showOnly('noref') }
  ];

  const insights = [];
  if (missingRef.length) insights.push({ tone: 'warn', icon: 'warn', text: missingRef.length === 1 ? tr('{amount} from {name} on {date} has no transaction reference. Add it so the statement can be matched.', { amount: money(missingRef[0].amount, missingRef[0].currency), name: missingRef[0].customerName, date: fmtDate(missingRef[0].date) }) : tr('{n} bank, mobile money, cheque or card payments have no transaction reference, so they are hard to match on a statement.', { n: missingRef.length }), action: { label: tr('Show them'), run: () => showOnly('noref') } });
  if (cashMonth.length) insights.push({ tone: 'info', icon: 'drawer', text: tr('{amount} came in as cash this month. Check it has been banked.', { amount: moneyBreakdown(sumOf(cashMonth)) }), action: { label: tr('Show them'), run: () => { setChip('month'); setMethod('cash'); jump('pm-list'); } } });
  if (change !== null && change <= -25) insights.push({ tone: 'warn', icon: 'down', text: tr('{pct}% less {currency} came in over the last 30 days than the 30 days before.', { pct: -change, currency: main }), action: { label: tr('Invoices'), run: () => navigate('/invoices') } });
  if (payers.length > 1) insights.push({ tone: 'good', icon: 'up', text: tr('{name} paid the most over the last 12 months: {amount}.', { name: payers[0].name, amount: moneyBreakdown(payers[0].sum) }), action: null });
  if (!thisMonth.length && payments.length) insights.push({ tone: 'warn', icon: 'clock', text: tr('Nothing has been paid yet this month.') });

  const chipTest = { month: (p) => thisMonth.includes(p), d30: (p) => ago(p) < 30, d90: (p) => ago(p) < 90, noref: (p) => missingRef.includes(p), all: () => true };
  const visible = payments.filter(chipTest[chip] || chipTest.month)
    .filter((p) => !method || p.method === method)
    .filter((p) => matchesQuery(search, p.invoiceNo, p.customerName, p.reference, p.receivedByName, p.receiptNo));
  const chips = [
    ['month', tr('This month'), thisMonth.length], ['d30', tr('Last 30 days'), last30.length], ['d90', tr('Last 90 days'), last90.length],
    ['noref', tr('No reference'), missingRef.length], ['all', tr('All'), payments.length]
  ].filter(([k, , c]) => c > 0 || k === 'month' || k === chip);
  const methodRows = METHODS.map((m) => { const list = last90.filter((p) => p.method === m.key); return { ...m, n: list.length, sum: sumOf(list) }; }).filter((m) => m.n > 0 || m.key !== 'other');

  function stateOf(p) {
    if (p.invoiceStatus === 'paid') return p.balanceAfter === 0 || p.balanceAfter === null ? { tone: 'good', text: tr('Paid it off') } : { tone: 'good', text: tr('Invoice now paid') };
    if (p.invoiceStatus === 'void') return { tone: 'muted', text: tr('Invoice voided') };
    return { tone: 'warn', text: tr('{amount} still owed', { amount: money(p.invoiceBalance, p.currency) }) };
  }
  function actionsFor(p) {
    return [
      { label: tr('Open'), onClick: () => setDetail(p.id) },
      receiptByPaymentId[p.id] && { label: tr('Preview receipt'), onClick: () => openReceipt(p) },
      canManage && { label: tr('Delete'), onClick: () => setDeleteTarget(p), danger: true }
    ].filter(Boolean);
  }
  const cur = detail ? payments.find((p) => p.id === detail) : null;

  return (
    <div className="dk tl pk cu pm">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('Quotations & Invoicing')}
        title={tr('Payments')}
        sub={tr('The money clients have paid against invoices: what came in, how, and what can\'t yet be matched to a statement. Press a number to show only those.')}
        actions={(
          <>
            <Link className="btn btn-primary" to="/invoices">{tr('Record a payment on an invoice')}</Link>
            <Link className="btn btn-secondary" to="/receipts">{tr('Receipts')}</Link>
          </>
        )}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      <Section id="pm-methods" title={tr('How the money came in')} sub={tr('The last 90 days, by payment method. Press one to show only those.')}>
        <div className="cu-stages pm-methods" role="radiogroup" aria-label={tr('Method')}>
          {methodRows.map((m) => (
            <button key={m.key} type="button" role="radio" aria-checked={method === m.key} className={'cu-stage pm-method is-' + m.key + (method === m.key ? ' is-on' : '')}
              onClick={() => { setChip('d90'); setMethod(method === m.key ? '' : m.key); jump('pm-list'); }}>
              <strong>{m.sum.length ? moneyBreakdown(m.sum) : '—'}</strong>
              <span>{tr(m.label)} · {m.n}</span>
            </button>
          ))}
        </div>
      </Section>

      <Section id="pm-list" title={tr('Payments')} sub={tr('Press a payment to see its invoice, its receipt and who took it.')}
        action={(
          <div className="ppl-view" role="radiogroup" aria-label={tr('View')}>
            {[['cards', tr('Cards')], ['list', tr('List')]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? 'is-on' : ''} onClick={() => { setView(k); writePref('bos.paymentsView', k); }}>{label}</button>
            ))}
          </div>
        )}>
        <div className="tl-tools"><div className="tl-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search payments…')} /></div></div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => { setChip(key); setMethod(''); }}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
          {method && <button type="button" className="ppl-chip is-on" onClick={() => setMethod('')}>{methodLabel(method)} ×</button>}
        </div>
        {!visible.length ? (
          <div className="dk-empty tl-empty">
            <p>{payments.length ? tr('Nothing matches. Try another search or filter.') : tr('No payments recorded yet')}</p>
          </div>
        ) : view === 'cards' ? (
          <div className="tl-grid">
            {visible.map((p) => {
              const st = stateOf(p);
              return (
                <article key={p.id} className={'tl-card' + (noRef(p) ? ' st-low' : '')}>
                  <button type="button" className="tl-card-open" onClick={() => setDetail(p.id)}>
                    <Mark p={p} />
                    <span className="tl-card-head">
                      <span className="dk-muted tl-small">{fmtDate(p.date)} · {p.invoiceNo}</span>
                      <span className="tl-name">{p.customerName}</span>
                    </span>
                  </button>
                  <span className="tl-menu"><RowMenu actions={actionsFor(p)} /></span>
                  <p className="dk-muted tl-small es-items">{methodLabel(p.method)}{p.reference ? ' · ' + tr('ref {reference}', { reference: p.reference }) : ''}{p.receiptNo ? ' · ' + p.receiptNo : ''}</p>
                  <div className="tl-tags"><Status tone={st.tone}>{st.text}</Status>{noRef(p) && <Status tone="warn">{tr('No reference')}</Status>}</div>
                  <div className="tl-foot">
                    <span className="es-total">{money(p.amount, p.currency)}</span>
                    <span className="dk-muted tl-small">{tr('taken by {name}', { name: p.receivedByName })}</span>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="tl-table-wrap">
            <table className="tl-table">
              <thead><tr><th>{tr('Customer')}</th><th>{tr('Date')}</th><th>{tr('Method')}</th><th>{tr('Reference')}</th><th className="is-num">{tr('Amount')}</th><th>{tr('Received by')}</th><th /></tr></thead>
              <tbody>
                {visible.map((p) => (
                  <tr key={p.id}>
                    <td><button type="button" className="tl-row-open" onClick={() => setDetail(p.id)}><Mark p={p} size={32} /><span><span className="tl-name">{p.customerName}</span><span className="dk-muted tl-small">{p.invoiceNo}{p.receiptNo ? ' · ' + p.receiptNo : ''}</span></span></button></td>
                    <td>{fmtDate(p.date)}</td>
                    <td>{methodLabel(p.method)}</td>
                    <td className={noRef(p) ? 'pk-owe' : ''}>{p.reference || (noRef(p) ? tr('missing') : '—')}</td>
                    <td className="is-num">{money(p.amount, p.currency)}</td>
                    <td>{p.receivedByName}</td>
                    <td className="tl-menu-cell"><RowMenu actions={actionsFor(p)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Glossary items={[
        [tr('Payment'), tr('Money a client paid against one invoice. Payments are recorded from the Invoices page.')],
        [tr('Reference'), tr('The transaction number from the bank, mobile money or cheque. It is what lets a payment be matched on a statement.')],
        [tr('Receipt'), tr('Made automatically for every payment, with what was still owed after it.')],
        [tr('Delete'), tr('Takes the payment off: the amount goes back on the invoice and its receipt is removed.')]
      ]} />

      {/* ── one payment ── */}
      {cur && (
        <div className="dialog-backdrop" onClick={() => setDetail(null)}>
          <div className="dialog tl-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="tl-detail-head">
              <Mark p={cur} size={56} />
              <div>
                <span className="dk-muted tl-small">{fmtDate(cur.date)} · {methodLabel(cur.method)}</span>
                <h2>{money(cur.amount, cur.currency)}</h2>
                <div className="tl-tags"><Status tone={stateOf(cur).tone}>{stateOf(cur).text}</Status></div>
              </div>
              <button type="button" className="tl-close" onClick={() => setDetail(null)} aria-label={tr('Close')}>×</button>
            </div>
            <dl className="tl-facts">
              <div><dt>{tr('From')}</dt><dd>{cur.customerName}</dd></div>
              <div><dt>{tr('Invoice')}</dt><dd><Link to={'/invoices?open=' + cur.invoiceId}>{cur.invoiceNo}</Link> · {money(cur.invoiceTotal, cur.currency)}</dd></div>
              <div><dt>{tr('Owed after this payment')}</dt><dd>{cur.balanceAfter === null ? '—' : money(cur.balanceAfter, cur.currency)}</dd></div>
              <div><dt>{tr('Reference')}</dt><dd className={noRef(cur) ? 'pk-owe' : ''}>{cur.reference || (noRef(cur) ? tr('missing') : '—')}</dd></div>
              <div><dt>{tr('Receipt')}</dt><dd>{cur.receiptNo || '—'}</dd></div>
              <div><dt>{tr('Received by')}</dt><dd>{cur.receivedByName}</dd></div>
            </dl>
            {cur.notes && <p className="tl-notes">{cur.notes}</p>}
            <div className="tl-holder is-inline">
              <div className="tl-holder-head">
                <span className="tl-holder-name"><strong>{cur.customerName}</strong><span className="dk-muted tl-small">{[cur.customerPhone, cur.customerEmail].filter(Boolean).join(' · ') || tr('no phone or email')}</span></span>
                <ContactButtons name={cur.customerName} phone={cur.customerPhone} email={cur.customerEmail} />
              </div>
            </div>
            <div className="dialog-actions tl-actions">
              {canManage && <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(cur)}>{tr('Delete')}</button>}
              <Link className="btn btn-secondary" to={'/invoices?open=' + cur.invoiceId}>{tr('Open {no}', { no: cur.invoiceNo })}</Link>
              {receiptByPaymentId[cur.id] && <button type="button" className="btn btn-primary" onClick={() => openReceipt(cur)}>{tr('Preview receipt')}</button>}
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="dialog-backdrop" onClick={() => !deleting && setDeleteTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Delete payment on {invoiceNo}', { invoiceNo: deleteTarget.invoiceNo })}</h2>
            <p className="dialog-body">{tr('{amount} goes back on {invoiceNo} and receipt {receiptNo} is removed. This cannot be undone.', { amount: money(deleteTarget.amount, deleteTarget.currency), invoiceNo: deleteTarget.invoiceNo, receiptNo: deleteTarget.receiptNo || '—' })}</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={confirmDelete}>{deleting ? tr('Deleting…') : tr('Delete')}</button>
            </div>
          </div>
        </div>
      )}

      {previewR && (
        <ReceiptPreview
          receipt={previewR}
          previewRef={previewRef}
          sharing={sharing}
          shareError={shareError}
          onClose={() => setPreviewR(null)}
          onShare={handleShare}
        />
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
