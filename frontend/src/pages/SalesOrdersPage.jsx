import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { money } from '../lib/currency';
import './SalesOrdersPage.css';

// Ported from Bamboo OS.dc.html's sales orders screen (screens.salesorders
// block + createOrderFromQuote/setOrderStatus handlers and the salesOrders
// computed values), backed by GET/POST /api/sales-orders and
// POST /api/sales-orders/:id/status (salesOrders.service.js).
//
// Deviation: the prototype's row action (`hasNext`/`advance` — the single
// "Start processing" / "Mark delivered" button that walks an order through
// its status lifecycle) has no permission check at all, unlike the create
// form above it, which is wrapped in `can.salesManage`. Real seeded roles
// have sales.read without sales.manage (supervisor), so literal fidelity
// would show a button that always 403s. Gated on sales.manage here,
// matching the backend's actual enforcement (salesOrders.setStatus
// requires sales.manage).
//
// The create-order form is additionally gated on quotation.read, since its
// dropdown is populated from GET /quotations filtered to accepted — every
// sales.manage role in this app's seed also has quotation.read, but the
// code shouldn't silently assume that holds forever (same reasoning as
// the customer.read/catalog.read/sales.read gates on the Quotations &
// Invoicing screens).

// Redesigned around the icon language established elsewhere: a
// status-toned document badge per row (mirrors Documents' file-type
// tone-mix treatment), an icon'd empty state.

function DocIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="3.5" width="14" height="17" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
function statusTone(bucket) {
  if (bucket === 'approved') return 'people';
  if (bucket === 'rejected') return 'danger';
  return 'warning';
}

function statusLabel(s) { return String(s || '').replace(/_/g, ' '); }

function docTagClass(bucket) {
  if (bucket === 'approved') return 'tag-neutral';
  if (bucket === 'rejected') return 'tag-accent';
  return 'tag-outline';
}

function orderBucket(status) {
  return status === 'delivered' ? 'approved' : status === 'cancelled' ? 'rejected' : 'pending';
}
function orderTagClass(status) { return docTagClass(orderBucket(status)); }

export default function SalesOrdersPage() {
  const { can } = useAuth();
  const canManage = can('sales.manage');
  const canSeeQuotations = can('quotation.read');
  const canOpenCreateForm = canManage && canSeeQuotations;

  const [orders, setOrders] = useState([]);
  const [quotations, setQuotations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [quotationId, setQuotationId] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [search, setSearch] = useState('');

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

  async function createOrder(e) {
    e.preventDefault();
    if (!quotationId) return;
    setCreating(true);
    setError(null);
    try {
      const o = await api.post('/sales-orders', { quotationId });
      setToast(o.orderNo + ' created.');
      setQuotationId('');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function advance(order) {
    setBusyId(order.id);
    setError(null);
    try {
      const nextStatus = order.status === 'pending' ? 'processing' : 'delivered';
      await api.post('/sales-orders/' + order.id + '/status', { status: nextStatus });
      setToast(order.orderNo + ' set to ' + statusLabel(nextStatus) + '.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const acceptedQuoteOptions = quotations.filter((q) => q.status === 'accepted');
  const visibleOrders = orders.filter((o) => matchesQuery(search, o.orderNo, o.customerName, o.status));

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      {canOpenCreateForm && (
        <form className="salesorders-form" onSubmit={createOrder}>
          <div className="field">
            <label htmlFor="so-quote">Create order from an accepted quotation</label>
            <select id="so-quote" className="input" value={quotationId} onChange={(e) => setQuotationId(e.target.value)}>
              <option value="">Choose a quotation</option>
              {acceptedQuoteOptions.map((q) => <option key={q.id} value={q.id}>{q.quoteNo} — {q.customerName}</option>)}
            </select>
          </div>
          <button className="btn btn-primary" type="submit" disabled={!quotationId || creating}>Create order</button>
        </form>
      )}

      <SearchInput value={search} onChange={setSearch} placeholder="Search sales orders…" />

      <table className="table" style={{ marginTop: 16 }}>
        <thead>
          <tr><th>Order</th><th>Customer</th><th>Total</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
          {visibleOrders.map((o) => {
            const hasNext = o.status !== 'delivered' && o.status !== 'cancelled' && canManage;
            const nextLabel = o.status === 'pending' ? 'Start processing' : o.status === 'processing' ? 'Mark delivered' : '';
            return (
              <tr key={o.id}>
                <td>
                  <div className="salesorders-no-cell">
                    <span className={'salesorders-badge salesorders-badge-' + statusTone(orderBucket(o.status))}><DocIcon /></span>
                    <span style={{ fontWeight: 600 }}>{o.orderNo}</span>
                  </div>
                </td>
                <td>{o.customerName}</td>
                <td>{money(o.total, o.currency)}</td>
                <td><span className={'tag ' + orderTagClass(o.status)}>{statusLabel(o.status)}</span></td>
                <td className="table-actions">
                  {hasNext && <button type="button" className="btn btn-secondary salesorders-row-btn" disabled={busyId === o.id} onClick={() => advance(o)}>{nextLabel}</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!orders.length && (
        <div className="salesorders-empty-state">
          <span className="salesorders-empty-icon"><DocIcon /></span>
          <p className="salesorders-empty-title">No sales orders yet</p>
        </div>
      )}
      {!!orders.length && !visibleOrders.length && (
        <div className="salesorders-empty-state">
          <span className="salesorders-empty-icon"><DocIcon /></span>
          <p className="salesorders-empty-title">No sales orders match "{search}"</p>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
