import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { shareOrDownloadPdf } from '../lib/documentShare';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import RowMenu from '../components/RowMenu';
import RecordDialog from '../components/RecordDialog';
import ReceiptPreview from '../components/ReceiptPreview';
import { money } from '../lib/currency';
import { tr } from '../lib/i18n.jsx';
import './PaymentsPage.css';

// Ported from Bamboo OS.dc.html's payments screen (screens.payments block).
// Payments are a read-only ledger with one action: delete (which also
// removes the linked receipt and rolls back the invoice balance server-side
// — see backend/src/services/payments.service.js's remove()). Preview
// reuses the Receipts module's own preview dialog — every payment has
// exactly one receipt (recordPayment creates both together), matched here
// by receipt.paymentId, so "preview the payment" and "preview its receipt"
// are the same document.
//
// Redesigned around the icon language established elsewhere: an avatar
// for whoever recorded the payment, an icon'd empty state.

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

function CashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2.5" y="6" width="19" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5.5 9v0M18.5 15v0" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function PaymentsPage() {
  const { can } = useAuth();
  const canManage = can('invoice.manage');

  const [payments, setPayments] = useState([]);
  const [receiptByPaymentId, setReceiptByPaymentId] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [detail, setDetail] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [search, setSearch] = useState('');

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

  async function handleShare() {
    setShareError(null);
    setSharing(true);
    try {
      const filename = 'Receipt-' + previewR.receiptNo + '.pdf';
      await shareOrDownloadPdf(previewRef.current, filename, 'Receipt ' + previewR.receiptNo, 'Receipt for ' + previewR.customerName);
    } catch (err) {
      if (err.name !== 'AbortError') setShareError(err.message || 'Could not share this receipt.');
    } finally {
      setSharing(false);
    }
  }

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  async function confirmDelete() {
    setDeleting(true);
    try {
      await api.del('/payments/' + deleteTarget.id);
      setToast('Payment on ' + deleteTarget.invoiceNo + ' deleted.');
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  const visiblePayments = payments.filter((p) => matchesQuery(search, p.invoiceNo, p.customerName, p.reference, p.receivedByName));

  // Shared by the row menu and the record panel.
  function rowActions(p) {
    return [
      { label: 'Preview receipt', onClick: () => { setShareError(null); setPreviewR(receiptByPaymentId[p.id]); }, hidden: !receiptByPaymentId[p.id] },
      { label: 'Delete', onClick: () => setDeleteTarget(p), danger: true, hidden: !canManage },
    ];
  }

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <SearchInput value={search} onChange={setSearch} placeholder={tr('Search payments…')} />

      <table className="table table-clickable" style={{ marginTop: 16 }}>
        <thead>
          <tr><th>{tr('Invoice')}</th><th>{tr('Customer')}</th><th>{tr('Amount')}</th><th className="col-mid">{tr('Date')}</th><th className="col-wide">{tr('Method')}</th><th className="col-wide">{tr('Reference')}</th><th className="col-wide">{tr('Received by')}</th><th></th></tr>
        </thead>
        <tbody>
          {visiblePayments.map((p) => (
            <tr
              key={p.id}
              tabIndex={0}
              onClick={() => setDetail(p)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetail(p); } }}
            >
              <td style={{ fontWeight: 600 }}>{p.invoiceNo}</td>
              <td>{p.customerName}</td>
              <td>{money(p.amount, p.currency)}</td>
              <td className="col-mid">{fmtDate(p.date)}</td>
              <td className="payments-method col-wide">{p.method.replace('_', ' ')}</td>
              <td className="col-wide">{p.reference || '—'}</td>
              <td className="col-wide">
                <div className="payments-receiver-cell">
                  <span className="payments-avatar" style={{ background: avatarColor(p.receivedByName) }}>{initials(p.receivedByName)}</span>
                  {p.receivedByName}
                </div>
              </td>
              <td className="table-actions" onClick={(e) => e.stopPropagation()}>
                <RowMenu actions={rowActions(p)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!payments.length && (
        <div className="payments-empty-state">
          <span className="payments-empty-icon"><CashIcon /></span>
          <p className="payments-empty-title">{tr('No payments recorded yet')}</p>
        </div>
      )}
      {!!payments.length && !visiblePayments.length && (
        <div className="payments-empty-state">
          <span className="payments-empty-icon"><CashIcon /></span>
          <p className="payments-empty-title">{tr('No payments match "')}{search}"</p>
        </div>
      )}

      {deleteTarget && (
        <div className="dialog-backdrop" onClick={() => setDeleteTarget(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Delete payment on')} {deleteTarget.invoiceNo}</h2>
            <p className="dialog-body">{tr('This cannot be undone.')}</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={deleting} onClick={confirmDelete}>{deleting ? 'Deleting…' : 'Delete'}</button>
            </div>
          </div>
        </div>
      )}

      {detail && (
        <RecordDialog
          title={money(detail.amount, detail.currency)}
          subtitle={detail.customerName + ' · ' + detail.invoiceNo}
          actions={rowActions(detail)}
          onClose={() => setDetail(null)}
          fields={[
            { label: 'Date', value: fmtDate(detail.date) },
            { label: 'Method', value: detail.method.replace('_', ' ') },
            { label: 'Reference', value: detail.reference },
            { label: 'Received by', value: detail.receivedByName },
            { label: 'Invoice', value: detail.invoiceNo },
            { label: 'Currency', value: detail.currency },
          ]}
        />
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

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
