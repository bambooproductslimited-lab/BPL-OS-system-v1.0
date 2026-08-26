import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { shareOrDownloadPdf } from '../lib/documentShare';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import './ReceiptsPage.css';

// Ported from Bamboo OS.dc.html's receipts screen (screens.receipts block)
// and dialog.receiptPreview. Receipts are read-only — a pure byproduct of
// invoices.recordPayment (backend/src/services/invoices.service.js) — so
// there is no create/edit/delete here, only Preview.

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
              <td>GHS {r.amount.toLocaleString()}</td>
              <td>{fmtDate(r.date)}</td>
              <td className="receipts-method">{r.method.replace('_', ' ')}</td>
              <td>GHS {r.balanceAfter.toLocaleString()}</td>
              <td className="table-actions">
                <button type="button" className="btn btn-secondary receipts-row-btn" onClick={() => { setShareError(null); setPreviewR(r); }}>Preview</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!receipts.length && <p className="table-empty">No receipts issued yet.</p>}
      {!!receipts.length && !visibleReceipts.length && <p className="table-empty">No receipts match "{search}".</p>}

      {previewR && (
        <div className="dialog-backdrop" onClick={() => setPreviewR(null)}>
          <div className="dialog receipt-preview" ref={previewRef} onClick={(e) => e.stopPropagation()}>
            <div className="receipt-preview-head">
              <div className="receipt-preview-brand">
                <img src="/logo.png" alt="" className="receipt-preview-logo" />
                <div>
                  <div className="receipt-preview-brand-name">Bamboo Products Limited</div>
                  <div className="receipt-preview-brand-address">
                    Poki House, GT-191-1859 (GhanaPostGPS)<br />
                    35 J K Siaw St, Community 9, Tema, Ghana<br />
                    P.O. Box CO 131, Tema, Ghana<br />
                    Tel: 0591933925 / 0249186859
                  </div>
                </div>
              </div>
              <div className="receipt-preview-headright">
                <div className="receipt-preview-eyebrow">Receipt</div>
                <div className="receipt-preview-no">{previewR.receiptNo}</div>
                <div className="receipt-preview-date">Date {fmtDate(previewR.date)}</div>
              </div>
            </div>
            <div>
              <div className="receipt-preview-eyebrow receipt-preview-eyebrow-block">Received from</div>
              <div className="receipt-preview-customer">{previewR.customerName}</div>
              <div className="receipt-preview-address">{previewR.customerAddress || '—'}</div>
            </div>
            <div className="receipt-preview-grid">
              <div>Invoice <strong>{previewR.invoiceNo}</strong></div>
              <div>Payment method <strong className="receipts-method">{previewR.method.replace('_', ' ')}</strong></div>
              <div>Transaction reference <strong>{previewR.reference || '—'}</strong></div>
              <div>Received by <strong>{previewR.receivedByName}</strong></div>
            </div>
            <div className="receipt-preview-amounts">
              <div>Remaining balance &nbsp; <strong>GHS {previewR.balanceAfter.toLocaleString()}</strong></div>
              <div className="receipt-preview-amount-received">Amount received &nbsp; <strong>GHS {previewR.amount.toLocaleString()}</strong></div>
            </div>
            {shareError && <div className="error-banner no-print">{shareError}</div>}
            <div className="dialog-actions no-print">
              <button type="button" className="btn btn-secondary" onClick={() => setPreviewR(null)}>Close</button>
              <button type="button" className="btn btn-secondary" onClick={() => window.print()}>Print</button>
              <button type="button" className="btn btn-primary" disabled={sharing} onClick={handleShare}>
                {sharing ? 'Preparing…' : 'Share'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
