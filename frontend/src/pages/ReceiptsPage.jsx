import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { shareOrDownloadPdf } from '../lib/documentShare';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import ReceiptPreview from '../components/ReceiptPreview';
import { money } from '../lib/currency';
import './ReceiptsPage.css';
import RowMenu from '../components/RowMenu';
import RecordDialog from '../components/RecordDialog';

import { tr, docTr, activeIntlLocale } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
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
  return d.toLocaleDateString(activeIntlLocale(), { day: '2-digit', month: 'short', year: 'numeric' });
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

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  const visibleReceipts = receipts.filter((r) => matchesQuery(search, r.receiptNo, r.invoiceNo, r.customerName));

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <SearchInput value={search} onChange={setSearch} placeholder={tr('Search receipts…')} />

      <table className="table table-clickable" style={{ marginTop: 16 }}>
        <thead>
          <tr><th>{tr('Receipt')}</th><th>{tr('Invoice')}</th><th>{tr('Customer')}</th><th>{tr('Amount')}</th><th>{tr('Date')}</th><th>{tr('Method')}</th><th>{tr('Balance after')}</th><th></th></tr>
        </thead>
        <tbody>
          {visibleReceipts.map((r) => (
            <tr
              key={r.id}
              tabIndex={0}
              onClick={() => setDetail(r)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetail(r); } }}
            >
              <td style={{ fontWeight: 600 }}>{r.receiptNo}</td>
              <td>{r.invoiceNo}</td>
              <td>{r.customerName}</td>
              <td>{money(r.amount, r.currency)}</td>
              <td className="col-mid">{fmtDate(r.date)}</td>
              <td className="receipts-method col-wide">{codeLabel(r.method)}</td>
              <td>{money(r.balanceAfter, r.currency)}</td>
              <td className="table-actions" onClick={(e) => e.stopPropagation()}>
                <RowMenu actions={[
                  { label: tr('Preview'), onClick: () => { setShareError(null); setPreviewR(r); } },
                ]} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!receipts.length && (
        <div className="receipts-empty-state">
          <span className="receipts-empty-icon"><ReceiptIcon /></span>
          <p className="receipts-empty-title">{tr('No receipts issued yet')}</p>
        </div>
      )}
      {!!receipts.length && !visibleReceipts.length && (
        <div className="receipts-empty-state">
          <span className="receipts-empty-icon"><ReceiptIcon /></span>
          <p className="receipts-empty-title">{tr('No receipts match "{search}"', { search })}</p>
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
      {detail && (
        <RecordDialog
          title={detail.receiptNo}
          subtitle={detail.customerName}
          actions={[{ label: tr('Preview'), onClick: () => { setShareError(null); setPreviewR(detail); } }]}
          onClose={() => setDetail(null)}
          fields={[
            { label: tr('Amount'), value: money(detail.amount, detail.currency) },
            { label: tr('Date'), value: fmtDate(detail.date) },
            { label: tr('Method'), value: codeLabel(detail.method) },
            { label: tr('Reference'), value: detail.reference },
            { label: tr('Invoice'), value: detail.invoiceNo },
            { label: tr('Balance after'), value: money(detail.balanceAfter, detail.currency) },
            { label: tr('Received by'), value: detail.receivedByName },
            { label: tr('Billing address'), value: detail.customerAddress, wide: true },
          ]}
        />
      )}

    </div>
  );
}
