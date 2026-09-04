import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { shareOrDownloadPdf } from '../lib/documentShare';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import ReceiptPreview from '../components/ReceiptPreview';
import { money } from '../lib/currency';
import './ReceiptsPage.css';

// Ported from Bamboo OS.dc.html's receipts screen (screens.receipts block)
// and dialog.receiptPreview. Receipts are read-only — a pure byproduct of
// invoices.recordPayment (backend/src/services/invoices.service.js) — so
// there is no create/edit/delete here, only Preview.
//
// Redesigned around the icon language established elsewhere: an icon'd
// empty state (mirroring Payments — this is likewise a flat ledger with
// no natural per-row category, so no badge is added).

function ReceiptIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4v-17Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M8.5 8h7M8.5 11.5h7M8.5 15h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso.length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function ReceiptsPage() {
  const [receipts, setReceipts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [previewR, setPreviewR] = useState(null);
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState(null);
  const previewRef = useRef(null);
  const [search, setSearch] = useState('');

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

  if (loading) return <div className="eyebrow">Loading…</div>;

  const visibleReceipts = receipts.filter((r) => matchesQuery(search, r.receiptNo, r.invoiceNo, r.customerName));

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <SearchInput value={search} onChange={setSearch} placeholder="Search receipts…" />

      <table className="table" style={{ marginTop: 16 }}>
        <thead>
          <tr><th>Receipt</th><th>Invoice</th><th>Customer</th><th>Amount</th><th>Date</th><th>Method</th><th>Balance after</th><th></th></tr>
        </thead>
        <tbody>
          {visibleReceipts.map((r) => (
            <tr key={r.id}>
              <td style={{ fontWeight: 600 }}>{r.receiptNo}</td>
              <td>{r.invoiceNo}</td>
              <td>{r.customerName}</td>
              <td>{money(r.amount, r.currency)}</td>
              <td>{fmtDate(r.date)}</td>
              <td className="receipts-method">{r.method.replace('_', ' ')}</td>
              <td>{money(r.balanceAfter, r.currency)}</td>
              <td className="table-actions">
                <button type="button" className="btn btn-secondary receipts-row-btn" onClick={() => { setShareError(null); setPreviewR(r); }}>Preview</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!receipts.length && (
        <div className="receipts-empty-state">
          <span className="receipts-empty-icon"><ReceiptIcon /></span>
          <p className="receipts-empty-title">No receipts issued yet</p>
        </div>
      )}
      {!!receipts.length && !visibleReceipts.length && (
        <div className="receipts-empty-state">
          <span className="receipts-empty-icon"><ReceiptIcon /></span>
          <p className="receipts-empty-title">No receipts match "{search}"</p>
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
