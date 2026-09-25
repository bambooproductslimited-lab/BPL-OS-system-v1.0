import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { shareOrDownloadPdf } from '../lib/documentShare';
import ContactButtons from '../components/ContactButtons';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import RowMenu from '../components/RowMenu';
import ReceiptPreview from '../components/ReceiptPreview';
import { Glossary, Hero, Insights, Section, Status, avatarColor, fmtDate, initials, jump } from '../components/DashKit';
import { money, moneyBreakdown } from '../lib/currency';
import { tr, docTr } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import './EmployeesPage.css';
import './ToolRoomPage.css';
import './PokiRentals.css';
import './CustomersPage.css';
import './EstimatesPage.css';
import './PaymentsPage.css';

// Receipts — the paper trail for every payment. Receipts are made by
// invoices.recordPayment, one per payment, so there is nothing to create,
// change or delete here: open one, preview it, share it as a PDF. Same
// "explains itself" layout as the dashboards (components/DashKit.jsx):
// what was receipted this month, which receipts cleared an invoice and
// which left something owing, and the receipts as cards or a list
// (receipts.service.js list: Bamboo Products' invoices only).

function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function todayIso() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function dayNum(iso) { return Math.floor(new Date(String(iso).slice(0, 10) + 'T00:00:00Z').getTime() / 86400000); }
function ago(r) { return dayNum(todayIso()) - dayNum(r.date); }
function sumOf(list, key) {
  const m = {};
  list.forEach((x) => { m[x.currency] = (m[x.currency] || 0) + Number(x[key] || 0); });
  return Object.entries(m).map(([currency, amount]) => ({ currency, amount }));
}
function cleared(r) { return r.balanceAfter <= 0.005; }

function Mark({ r, size = 44 }) {
  return <span className="pk-avatar cu-mark" style={{ width: size, height: size, background: avatarColor(r.customerName), fontSize: Math.round(size * 0.34) }} aria-hidden="true">{initials(r.customerName)}</span>;
}

export default function ReceiptsPage() {
  const [receipts, setReceipts] = useState([]);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [previewR, setPreviewR] = useState(null);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState(null);
  const previewRef = useRef(null);
  const [search, setSearch] = useState('');
  const [chip, setChip] = useState('month');
  const [view, setView] = useState(() => readPref('bos.receiptsView', 'cards'));

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
  const load = useCallback(async () => {
    setError(null);
    try {
      setReceipts(await api.get('/receipts'));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  function preview(r) { setShareError(null); setPreviewR(r); }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const monthKey = todayIso().slice(0, 7);
  const thisMonth = receipts.filter((r) => String(r.date).slice(0, 7) === monthKey);
  const recent = receipts.filter((r) => ago(r) < 90);
  const final = recent.filter(cleared);
  const partial = recent.filter((r) => !cleared(r));
  const stillOwing = partial.filter((r) => r.invoiceStatus === 'unpaid' || r.invoiceStatus === 'partially_paid');
  const latest = receipts[0];

  function showOnly(key) { setChip(chip === key ? 'month' : key); jump('rc-list'); }
  const stats = [
    { icon: 'receipt', value: String(thisMonth.length), label: tr('receipts this month'), note: thisMonth.length ? tr('for {amount}', { amount: moneyBreakdown(sumOf(thisMonth, 'amount')) }) : tr('none yet this month'), onClick: () => showOnly('month') },
    { icon: 'check', value: String(final.length), label: tr('cleared an invoice'), note: tr('paid in full, last 90 days'), tone: final.length ? 'good' : '', onClick: () => showOnly('final') },
    { icon: 'owed', value: String(partial.length), label: tr('part-payments'), note: partial.length ? tr('{amount} was still owed after them', { amount: moneyBreakdown(sumOf(partial, 'balanceAfter')) }) : tr('last 90 days'), tone: stillOwing.length ? 'warn' : '', onClick: () => showOnly('partial') },
    { icon: 'doc', value: latest ? latest.receiptNo : '—', label: tr('latest receipt'), note: latest ? fmtDate(latest.date) + ' · ' + latest.customerName : tr('none issued yet'), onClick: () => { if (latest) setDetail(latest.id); } }
  ];

  const insights = [];
  if (stillOwing.length) {
    const names = [...new Set(stillOwing.map((r) => r.customerName))];
    insights.push({ tone: 'warn', icon: 'owed', text: names.length === 1 ? tr('{name} has paid part and still owes on {no}.', { name: names[0], no: stillOwing[0].invoiceNo }) : tr('{n} clients have paid part of an invoice and still owe the rest.', { n: names.length }), action: { label: tr('Show them'), run: () => showOnly('owing') } });
  }
  if (thisMonth.length) insights.push({ tone: 'info', icon: 'send', text: tr('Clients can be sent their receipt as a PDF: open one and press Share.'), action: null });

  const chipTest = { month: (r) => thisMonth.includes(r), final: (r) => final.includes(r), partial: (r) => partial.includes(r), owing: (r) => stillOwing.includes(r), all: () => true };
  const visible = receipts.filter(chipTest[chip] || chipTest.month).filter((r) => matchesQuery(search, r.receiptNo, r.invoiceNo, r.customerName, r.reference));
  const chips = [
    ['month', tr('This month'), thisMonth.length], ['final', tr('Paid in full'), final.length], ['partial', tr('Part-payments'), partial.length],
    ['owing', tr('Still owing'), stillOwing.length], ['all', tr('All'), receipts.length]
  ].filter(([k, , c]) => c > 0 || k === 'month' || k === chip);

  function stateOf(r) { return cleared(r) ? { tone: 'good', text: tr('Paid in full') } : { tone: 'warn', text: tr('{amount} left to pay', { amount: money(r.balanceAfter, r.currency) }) }; }
  function actionsFor(r) {
    return [
      { label: tr('Open'), onClick: () => setDetail(r.id) },
      { label: tr('Preview and share'), onClick: () => preview(r) }
    ];
  }
  const cur = detail ? receipts.find((r) => r.id === detail) : null;

  return (
    <div className="dk tl pk cu rc">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('Quotations & Invoicing')}
        title={tr('Receipts')}
        sub={tr('One receipt for every payment, made automatically. Open one to preview it or share it with the client as a PDF. Press a number to show only those.')}
        actions={<Link className="btn btn-secondary" to="/payments">{tr('Payments')}</Link>}
        stats={stats} />

      <Insights items={insights} />

      <Section id="rc-list" title={tr('Receipts')} sub={tr('Press a receipt to see it and share it.')}
        action={(
          <div className="ppl-view" role="radiogroup" aria-label={tr('View')}>
            {[['cards', tr('Cards')], ['list', tr('List')]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? 'is-on' : ''} onClick={() => { setView(k); writePref('bos.receiptsView', k); }}>{label}</button>
            ))}
          </div>
        )}>
        <div className="tl-tools"><div className="tl-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search receipts…')} /></div></div>
        <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
          {chips.map(([key, label, c]) => (
            <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
              {label} <span className="ppl-chip-n">{c}</span>
            </button>
          ))}
        </div>
        {!visible.length ? (
          <div className="dk-empty tl-empty"><p>{receipts.length ? tr('Nothing matches. Try another search or filter.') : tr('No receipts issued yet')}</p></div>
        ) : view === 'cards' ? (
          <div className="tl-grid">
            {visible.map((r) => {
              const st = stateOf(r);
              return (
                <article key={r.id} className="tl-card">
                  <button type="button" className="tl-card-open" onClick={() => setDetail(r.id)}>
                    <Mark r={r} />
                    <span className="tl-card-head">
                      <span className="dk-muted tl-small">{r.receiptNo} · {fmtDate(r.date)}</span>
                      <span className="tl-name">{r.customerName}</span>
                    </span>
                  </button>
                  <span className="tl-menu"><RowMenu actions={actionsFor(r)} /></span>
                  <p className="dk-muted tl-small es-items">{tr('For {no}', { no: r.invoiceNo })} · {codeLabel(r.method)}</p>
                  <div className="tl-tags"><Status tone={st.tone}>{st.text}</Status></div>
                  <div className="tl-foot">
                    <span className="es-total">{money(r.amount, r.currency)}</span>
                    <ContactButtons name={r.customerName} phone={r.customerPhone} email={r.customerEmail} />
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="tl-table-wrap">
            <table className="tl-table">
              <thead><tr><th>{tr('Receipt')}</th><th>{tr('Invoice')}</th><th>{tr('Date')}</th><th>{tr('Method')}</th><th className="is-num">{tr('Amount')}</th><th className="is-num">{tr('Balance after')}</th><th /></tr></thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.id}>
                    <td><button type="button" className="tl-row-open" onClick={() => setDetail(r.id)}><Mark r={r} size={32} /><span><span className="tl-name">{r.customerName}</span><span className="dk-muted tl-small">{r.receiptNo}</span></span></button></td>
                    <td>{r.invoiceNo}</td>
                    <td>{fmtDate(r.date)}</td>
                    <td>{codeLabel(r.method)}</td>
                    <td className="is-num">{money(r.amount, r.currency)}</td>
                    <td className="is-num">{cleared(r) ? tr('Paid in full') : money(r.balanceAfter, r.currency)}</td>
                    <td className="tl-menu-cell"><RowMenu actions={actionsFor(r)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Glossary items={[
        [tr('Receipt'), tr('Proof for the client that a payment was received. One is made for every payment recorded on an invoice.')],
        [tr('Balance after'), tr('What was still owed on the invoice right after this payment.')],
        [tr('Paid in full'), tr('The payment that cleared the invoice.')]
      ]} />

      {/* ── one receipt ── */}
      {cur && (
        <div className="dialog-backdrop" onClick={() => setDetail(null)}>
          <div className="dialog tl-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="tl-detail-head">
              <Mark r={cur} size={56} />
              <div>
                <span className="dk-muted tl-small">{cur.receiptNo} · {fmtDate(cur.date)}</span>
                <h2>{money(cur.amount, cur.currency)}</h2>
                <div className="tl-tags"><Status tone={stateOf(cur).tone}>{stateOf(cur).text}</Status></div>
              </div>
              <button type="button" className="tl-close" onClick={() => setDetail(null)} aria-label={tr('Close')}>×</button>
            </div>
            <dl className="tl-facts">
              <div><dt>{tr('From')}</dt><dd>{cur.customerName}</dd></div>
              <div><dt>{tr('Invoice')}</dt><dd><Link to={'/invoices?open=' + cur.invoiceId}>{cur.invoiceNo}</Link> · {money(cur.invoiceTotal, cur.currency)}</dd></div>
              <div><dt>{tr('Balance after')}</dt><dd>{money(cur.balanceAfter, cur.currency)}</dd></div>
              <div><dt>{tr('Method')}</dt><dd>{codeLabel(cur.method)}</dd></div>
              <div><dt>{tr('Reference')}</dt><dd>{cur.reference || '—'}</dd></div>
              <div><dt>{tr('Received by')}</dt><dd>{cur.receivedByName}</dd></div>
              {cur.customerAddress && <div><dt>{tr('Billing address')}</dt><dd>{cur.customerAddress}</dd></div>}
            </dl>
            <div className="tl-holder is-inline">
              <div className="tl-holder-head">
                <span className="tl-holder-name"><strong>{cur.customerName}</strong><span className="dk-muted tl-small">{[cur.customerPhone, cur.customerEmail].filter(Boolean).join(' · ') || tr('no phone or email')}</span></span>
                <ContactButtons name={cur.customerName} phone={cur.customerPhone} email={cur.customerEmail} />
              </div>
            </div>
            <div className="dialog-actions tl-actions">
              <Link className="btn btn-secondary" to={'/invoices?open=' + cur.invoiceId}>{tr('Open {no}', { no: cur.invoiceNo })}</Link>
              <button type="button" className="btn btn-primary" onClick={() => preview(cur)}>{tr('Preview and share')}</button>
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
    </div>
  );
}
