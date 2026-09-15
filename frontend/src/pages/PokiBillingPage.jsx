import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { money } from '../lib/currency';
import DocPreview from '../components/DocPreview';
import { groupPackageItems } from '../lib/packages';
import { formatPaymentSchedule } from '../lib/paymentSchedule';
import './PokiPages.css';

// Rent & utilities — the billing desk. Three tabs because the three jobs
// are genuinely separate: raising the period's rent, turning meter
// readings and shared bills into invoices, and looking at what's been
// raised.

function todayISO() { return new Date().toISOString().slice(0, 10); }
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(String(iso).length > 10 ? iso : iso + 'T00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function PokiBillingPage() {
  const { can } = useAuth();
  const canManage = can('poki.manage');

  const [tab, setTab] = useState('rent');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);

  const [previewInv, setPreviewInv] = useState(null);
  const [payFor, setPayFor] = useState(null);
  const [payForm, setPayForm] = useState({ amount: '', method: 'bank_transfer', reference: '', notes: '' });
  const [newInv, setNewInv] = useState(null);
  const [invError, setInvError] = useState(null);

  const [asOf, setAsOf] = useState(todayISO());
  const [preview, setPreview] = useState([]);
  const [selected, setSelected] = useState({});

  const [units, setUnits] = useState([]);
  const [meters, setMeters] = useState([]);
  const [readings, setReadings] = useState([]);
  const [masterBills, setMasterBills] = useState([]);
  const [properties, setProperties] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [leases, setLeases] = useState([]);

  const [dialog, setDialog] = useState(null);
  const [form, setForm] = useState({});
  const [dialogError, setDialogError] = useState(null);
  const [split, setSplit] = useState(null);

  const loadPreview = useCallback(async (date) => {
    try {
      setPreview(await api.get('/poki/rent-run/preview?asOf=' + (date || asOf)));
    } catch (err) {
      setError(err.message);
    }
  }, [asOf]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [p, u, m, r, mb, inv, tn, ls] = await Promise.all([
        api.get('/poki/rent-run/preview?asOf=' + asOf),
        api.get('/poki/units'),
        api.get('/poki/meters'),
        api.get('/poki/readings'),
        api.get('/poki/master-bills'),
        api.get('/poki/invoices'),
        api.get('/poki/tenants'),
        api.get('/poki/leases')
      ]);
      setPreview(p);
      setUnits(u);
      setMeters(m);
      setReadings(r);
      setMasterBills(mb);
      setInvoices(inv);
      setTenants(tn);
      setLeases(ls);
      setProperties(await api.get('/poki/properties'));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
    // asOf intentionally excluded — changing the date refreshes only the
    // preview (loadPreview), not the whole screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // The list row carries enough to display, but the printable invoice needs
  // its line items and the tenant's contact block, so fetch the full record.
  async function openPreview(inv) {
    setError(null);
    try {
      setPreviewInv(await api.get('/poki/invoices/' + inv.id));
    } catch (err) {
      setError(err.message);
    }
  }

  function openPay(inv) {
    setInvError(null);
    setPayForm({ amount: String(inv.balanceDue), method: 'bank_transfer', reference: '', notes: '' });
    setPayFor(inv);
  }

  async function submitPayment(e) {
    e.preventDefault();
    setBusy(true);
    setInvError(null);
    try {
      await api.post('/poki/invoices/' + payFor.id + '/payments', payForm);
      setToast('Payment recorded on ' + payFor.invoiceNo + '.');
      setPayFor(null);
      await load();
    } catch (err) {
      setInvError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function voidInvoice(inv) {
    if (!window.confirm('Void ' + inv.invoiceNo + '? The number stays used, but the charge is cancelled.')) return;
    setBusy(true);
    try {
      await api.post('/poki/invoices/' + inv.id + '/void', {});
      setToast(inv.invoiceNo + ' voided.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function openNewInvoice() {
    setInvError(null);
    setNewInv({
      tenantId: '', leaseId: '', docKind: 'other', dueDate: '',
      notes: '', items: [{ description: '', qty: 1, unitPrice: '' }]
    });
  }

  async function submitNewInvoice(e) {
    e.preventDefault();
    setBusy(true);
    setInvError(null);
    try {
      const res = await api.post('/poki/invoices', {
        ...newInv,
        leaseId: newInv.leaseId || undefined,
        dueDate: newInv.dueDate || undefined,
        items: newInv.items.filter((i) => String(i.description).trim())
      });
      setToast('Raised ' + res.invoiceNo + '.');
      setNewInv(null);
      setTab('invoices');
      await load();
    } catch (err) {
      setInvError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function runRent() {
    const ids = Object.keys(selected).filter((k) => selected[k]);
    if (!window.confirm('Raise ' + (ids.length || preview.length) + ' rent invoice(s)?')) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/poki/rent-run', { asOf, leaseIds: ids.length ? ids : undefined });
      setToast('Raised ' + res.created + ' rent invoice(s).');
      setSelected({});
      await load();
      await loadPreview(asOf);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitDialog(e) {
    e.preventDefault();
    setBusy(true);
    setDialogError(null);
    try {
      if (dialog === 'meter') {
        await api.post('/poki/meters', form);
        setToast('Meter added.');
      } else if (dialog === 'reading') {
        await api.post('/poki/readings', form);
        setToast('Reading recorded.');
      } else if (dialog === 'master') {
        await api.post('/poki/master-bills', form);
        setToast('Master bill recorded.');
      }
      setDialog(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function billSelectedReadings() {
    const ids = readings.filter((r) => !r.invoiceId && selected['r_' + r.id]).map((r) => r.id);
    if (!ids.length) { setError('Select at least one unbilled reading.'); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await api.post('/poki/readings/bill', { readingIds: ids });
      setToast('Raised ' + res.created + ' utility invoice(s).' +
        (res.skippedUnits && res.skippedUnits.length ? ' Skipped ' + res.skippedUnits.join(', ') + ' — no active lease.' : ''));
      setSelected({});
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function showSplit(bill) {
    try {
      setSplit(await api.get('/poki/master-bills/' + bill.id + '/split'));
      setDialog('split');
    } catch (err) {
      setError(err.message);
    }
  }

  async function billMaster() {
    setBusy(true);
    try {
      const res = await api.post('/poki/master-bills/' + split.billId + '/bill');
      setToast('Apportioned to ' + res.created + ' tenant(s).');
      setDialog(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const unbilled = readings.filter((r) => !r.invoiceId);
  const previewTotal = preview
    .filter((p) => !Object.keys(selected).some((k) => selected[k]) || selected[p.leaseId])
    .reduce((s, p) => s + p.total, 0);

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="poki-toolbar">
        <button type="button" className={'btn ' + (tab === 'rent' ? 'btn-primary' : 'btn-secondary')} onClick={() => setTab('rent')}>Rent run</button>
        <button type="button" className={'btn ' + (tab === 'utilities' ? 'btn-primary' : 'btn-secondary')} onClick={() => setTab('utilities')}>Utilities</button>
        <button type="button" className={'btn ' + (tab === 'invoices' ? 'btn-primary' : 'btn-secondary')} onClick={() => setTab('invoices')}>Invoices</button>
      </div>

      {tab === 'rent' && (
        <div>
          <div className="poki-toolbar">
            <label className="poki-muted" htmlFor="pb-asof">Bill everything due as at</label>
            <input id="pb-asof" className="input" type="date" value={asOf}
              onChange={(e) => { setAsOf(e.target.value); loadPreview(e.target.value); }} />
            <div className="poki-toolbar-spacer" />
            {canManage && preview.length > 0 && (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={runRent}>
                {busy ? 'Raising…' : 'Raise ' + money(previewTotal, preview[0].currency)}
              </button>
            )}
          </div>

          {preview.length === 0 ? (
            <div className="poki-empty">
              <p className="poki-empty-title">Nothing due</p>
              <p className="poki-empty-sub">
                No active lease has a rent period starting on or before {fmtDate(asOf)} that hasn't already been billed.
              </p>
            </div>
          ) : (
            <div className="poki-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 32 }}></th>
                  <th>Unit</th><th>Tenant</th><th>Period</th><th>Due</th>
                  <th className="poki-num">Rent</th><th className="poki-num">Utilities</th><th className="poki-num">Total</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((p) => (
                  <tr key={p.leaseId}>
                    <td>
                      <input type="checkbox" checked={!!selected[p.leaseId]}
                        onChange={(e) => setSelected({ ...selected, [p.leaseId]: e.target.checked })}
                        aria-label={'Select ' + p.unitCode} />
                    </td>
                    <td>
                      <div className="poki-strong">{p.unitCode}</div>
                      <div className="poki-muted">{p.propertyName}</div>
                    </td>
                    <td>{p.tenantName}</td>
                    <td className="poki-nowrap">
                      {fmtDate(p.periodStart)} → {fmtDate(p.periodEnd)}
                      {p.partial && (
                        <div className="poki-muted">
                          part period · {p.billedDays} of {p.fullDays} days
                        </div>
                      )}
                    </td>
                    <td className="poki-nowrap">{fmtDate(p.dueDate)}</td>
                    <td className="poki-num">
                      {money(p.rentAmount, p.currency)}
                      {/* The reduced figure is deliberate, so say why next to
                          it rather than leaving it looking like a mispriced
                          lease. */}
                      {p.partial && (
                        <div className="poki-muted">pro-rated from {money(p.fullRentAmount, p.currency)}</div>
                      )}
                    </td>
                    <td className="poki-num">{p.fixedUtility ? money(p.fixedUtility, p.currency) : <span className="poki-muted">—</span>}</td>
                    <td className="poki-num poki-strong">{money(p.total, p.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
          {preview.length > 0 && (
            <p className="poki-section-sub" style={{ marginTop: 10 }}>
              Tick rows to bill only those; with nothing ticked, the button raises all of them. Each lease then advances to its
              next period, so running twice can't double-bill.
              {preview.some((p) => p.partial) && ' A lease ending mid-period is charged only for the days up to its end date.'}
            </p>
          )}
        </div>
      )}

      {tab === 'utilities' && (
        <div>
          <div className="poki-section" style={{ marginTop: 0 }}>
            <div className="poki-toolbar">
              <h2 className="poki-section-title" style={{ margin: 0 }}>Meter readings</h2>
              <div className="poki-toolbar-spacer" />
              {canManage && <button type="button" className="btn btn-secondary" onClick={() => { setForm({ utilityType: 'electricity', measureUnit: 'kWh', rate: '' }); setDialogError(null); setDialog('meter'); }}>Add meter</button>}
              {canManage && meters.length > 0 && (
                <button type="button" className="btn btn-secondary" onClick={() => { setForm({ meterId: meters[0].id, periodStart: '', periodEnd: '', currentReading: '' }); setDialogError(null); setDialog('reading'); }}>Record reading</button>
              )}
              {canManage && unbilled.length > 0 && (
                <button type="button" className="btn btn-primary" disabled={busy} onClick={billSelectedReadings}>Bill selected</button>
              )}
            </div>

            {meters.length === 0 ? (
              <div className="poki-empty">
                <p className="poki-empty-title">No meters yet</p>
                <p className="poki-empty-sub">
                  Add a sub-meter to any unit set to "metered" utilities, then record its readings each period to bill consumption.
                </p>
              </div>
            ) : readings.length === 0 ? (
              <div className="poki-empty">
                <p className="poki-empty-title">No readings recorded</p>
                <p className="poki-empty-sub">Record a reading against a meter to bill the consumption.</p>
              </div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 32 }}></th>
                    <th>Unit</th><th>Utility</th><th>Period</th>
                    <th className="poki-num">Previous</th><th className="poki-num">Current</th><th className="poki-num">Used</th>
                    <th className="poki-num">Amount</th><th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {readings.map((r) => (
                    <tr key={r.id}>
                      <td>
                        {!r.invoiceId && (
                          <input type="checkbox" checked={!!selected['r_' + r.id]}
                            onChange={(e) => setSelected({ ...selected, ['r_' + r.id]: e.target.checked })}
                            aria-label={'Select reading for ' + r.unitCode} />
                        )}
                      </td>
                      <td className="poki-strong">{r.unitCode}</td>
                      <td style={{ textTransform: 'capitalize' }}>{r.utilityType}</td>
                      <td>{fmtDate(r.periodStart)} → {fmtDate(r.periodEnd)}</td>
                      <td className="poki-num">{r.previousReading}</td>
                      <td className="poki-num">{r.currentReading}</td>
                      <td className="poki-num">{r.consumption} {r.measureUnit}</td>
                      <td className="poki-num poki-strong">{money(r.amount, 'GHS')}</td>
                      <td>
                        {r.invoiceId
                          ? <span className="poki-chip poki-chip-active">{r.invoiceNo}</span>
                          : <span className="poki-chip poki-chip-open">unbilled</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="poki-section">
            <div className="poki-toolbar">
              <h2 className="poki-section-title" style={{ margin: 0 }}>Shared (master) bills</h2>
              <div className="poki-toolbar-spacer" />
              {canManage && properties.length > 0 && (
                <button type="button" className="btn btn-secondary"
                  onClick={() => { setForm({ propertyId: properties[0].id, utilityType: 'electricity', splitMethod: 'share', periodStart: '', periodEnd: '', totalAmount: '' }); setDialogError(null); setDialog('master'); }}>
                  Record master bill
                </button>
              )}
            </div>
            <p className="poki-section-sub">
              The whole-building ECG or Ghana Water bill, split across the units set to "apportioned". Review the split before
              charging it — apportioned utilities are the line tenants query most.
            </p>
            {masterBills.length === 0 ? (
              <div className="poki-empty">
                <p className="poki-empty-title">No master bills recorded</p>
                <p className="poki-empty-sub">Only needed if some units share a building meter rather than having their own.</p>
              </div>
            ) : (
              <table className="table">
                <thead>
                  <tr><th>Property</th><th>Utility</th><th>Period</th><th className="poki-num">Total</th><th>Split by</th><th>Status</th><th></th></tr>
                </thead>
                <tbody>
                  {masterBills.map((b) => (
                    <tr key={b.id}>
                      <td className="poki-strong">{b.propertyName}</td>
                      <td style={{ textTransform: 'capitalize' }}>{b.utilityType}</td>
                      <td>{fmtDate(b.periodStart)} → {fmtDate(b.periodEnd)}</td>
                      <td className="poki-num">{money(b.totalAmount, 'GHS')}</td>
                      <td className="poki-muted">{b.splitMethod === 'share' ? 'unit share %' : b.splitMethod === 'sqm' ? 'floor area' : 'equally'}</td>
                      <td>
                        {b.billedAt
                          ? <span className="poki-chip poki-chip-active">apportioned</span>
                          : <span className="poki-chip poki-chip-open">not billed</span>}
                      </td>
                      <td className="table-actions">
                        <button type="button" className="btn btn-secondary poki-row-btn" onClick={() => showSplit(b)}>
                          {b.billedAt ? 'View split' : 'Review & bill'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {tab === 'invoices' && (
        invoices.length === 0 ? (
          <div className="poki-empty">
            <p className="poki-empty-title">No invoices raised yet</p>
            <p className="poki-empty-sub">Rent, utility and repair invoices raised for Poki tenants appear here.</p>
            {canManage && (
              <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} onClick={openNewInvoice}>
                New invoice
              </button>
            )}
          </div>
        ) : (
          <>
          <div className="poki-toolbar">
            <span className="poki-muted">{invoices.length} invoice(s)</span>
            <div className="poki-toolbar-spacer" />
            {canManage && <button type="button" className="btn btn-primary" onClick={openNewInvoice}>New invoice</button>}
          </div>
          <div className="poki-table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Invoice</th><th>Kind</th><th>Tenant</th><th>Unit</th><th>Period</th><th>Due</th>
                <th className="poki-num">Total</th><th className="poki-num">Balance</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id}>
                  <td className="poki-strong poki-nowrap">{i.invoiceNo}</td>
                  <td><span className="poki-chip poki-chip-open">{i.docKind}</span></td>
                  <td className="poki-nowrap">{i.customerName}</td>
                  <td className="poki-nowrap">{i.unitCode || <span className="poki-muted">—</span>}</td>
                  <td className="poki-muted poki-nowrap">
                    {i.periodStart ? (
                      <>
                        <div>{fmtDate(i.periodStart)}</div>
                        <div>→ {fmtDate(i.periodEnd)}</div>
                      </>
                    ) : '—'}
                  </td>
                  <td className={'poki-nowrap' + (i.overdue ? ' poki-overdue' : '')}>{fmtDate(i.dueDate)}</td>
                  <td className="poki-num">{money(i.grandTotal, i.currency)}</td>
                  <td className={'poki-num' + (i.balanceDue > 0 ? ' poki-overdue' : '')}>{money(i.balanceDue, i.currency)}</td>
                  <td>
                    <span className={'poki-chip poki-chip-' + (i.status === 'void' ? 'expired' : i.status === 'paid' ? 'active' : i.overdue ? 'expired' : 'open')}>
                      {i.status === 'void' ? 'void' : i.overdue && i.status !== 'paid' ? 'overdue' : i.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td className="table-actions">
                    <button type="button" className="btn btn-secondary poki-row-btn" onClick={() => openPreview(i)}>Print</button>
                    {canManage && i.status !== 'paid' && i.status !== 'void' && (
                      <button type="button" className="btn btn-secondary poki-row-btn" disabled={busy} onClick={() => openPay(i)}>Record payment</button>
                    )}
                    {canManage && i.status !== 'void' && Number(i.amountPaid) === 0 && (
                      <button type="button" className="btn btn-secondary poki-row-btn" disabled={busy} onClick={() => voidInvoice(i)}>Void</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          </>
        )
      )}

      {(dialog === 'meter' || dialog === 'reading' || dialog === 'master') && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <form className="dialog poki-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitDialog}>
            <h2 className="poki-dialog-title">
              {dialog === 'meter' && 'Add meter'}
              {dialog === 'reading' && 'Record meter reading'}
              {dialog === 'master' && 'Record master utility bill'}
            </h2>
            {dialogError && <div className="error-banner poki-dialog-span">{dialogError}</div>}

            {dialog === 'meter' && (
              <>
                <div className="field">
                  <label htmlFor="pm-unit">Unit</label>
                  <select id="pm-unit" className="input" value={form.unitId || ''} onChange={set('unitId')} required>
                    <option value="">Choose a unit…</option>
                    {units.map((u) => <option key={u.id} value={u.id}>{u.propertyName} · {u.code}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="pm-type">Utility</label>
                  <select id="pm-type" className="input" value={form.utilityType} onChange={set('utilityType')}>
                    <option value="electricity">Electricity</option>
                    <option value="water">Water</option>
                    <option value="gas">Gas</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="pm-no">Meter number</label>
                  <input id="pm-no" className="input" value={form.meterNumber || ''} onChange={set('meterNumber')} />
                </div>
                <div className="field">
                  <label htmlFor="pm-unitlbl">Measured in</label>
                  <input id="pm-unitlbl" className="input" value={form.measureUnit} onChange={set('measureUnit')} placeholder="kWh, m³" />
                </div>
                <div className="field">
                  <label htmlFor="pm-rate">Rate per unit</label>
                  <input id="pm-rate" className="input" type="number" step="0.0001" value={form.rate} onChange={set('rate')} required />
                </div>
              </>
            )}

            {dialog === 'reading' && (
              <>
                <div className="field poki-dialog-span">
                  <label htmlFor="prd-meter">Meter</label>
                  <select id="prd-meter" className="input" value={form.meterId || ''} onChange={set('meterId')} required>
                    {meters.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.propertyName} · {m.unitCode} — {m.utilityType} ({m.meterNumber || 'no number'}) · last {m.lastReading}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="prd-start">Period start</label>
                  <input id="prd-start" className="input" type="date" value={form.periodStart} onChange={set('periodStart')} required />
                </div>
                <div className="field">
                  <label htmlFor="prd-end">Period end</label>
                  <input id="prd-end" className="input" type="date" value={form.periodEnd} onChange={set('periodEnd')} required />
                </div>
                <div className="field">
                  <label htmlFor="prd-prev">Previous reading</label>
                  <input id="prd-prev" className="input" type="number" step="0.001" value={form.previousReading || ''} onChange={set('previousReading')}
                    placeholder={String((meters.find((m) => m.id === form.meterId) || {}).lastReading || 0)} />
                </div>
                <div className="field">
                  <label htmlFor="prd-cur">Current reading</label>
                  <input id="prd-cur" className="input" type="number" step="0.001" value={form.currentReading} onChange={set('currentReading')} required />
                </div>
                <p className="poki-dialog-hint">
                  Leave the previous reading blank to carry forward this meter's last recorded figure.
                </p>
              </>
            )}

            {dialog === 'master' && (
              <>
                <div className="field">
                  <label htmlFor="pmb-prop">Property</label>
                  <select id="pmb-prop" className="input" value={form.propertyId} onChange={set('propertyId')} required>
                    {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="pmb-type">Utility</label>
                  <select id="pmb-type" className="input" value={form.utilityType} onChange={set('utilityType')}>
                    <option value="electricity">Electricity</option>
                    <option value="water">Water</option>
                    <option value="gas">Gas</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="pmb-start">Period start</label>
                  <input id="pmb-start" className="input" type="date" value={form.periodStart} onChange={set('periodStart')} required />
                </div>
                <div className="field">
                  <label htmlFor="pmb-end">Period end</label>
                  <input id="pmb-end" className="input" type="date" value={form.periodEnd} onChange={set('periodEnd')} required />
                </div>
                <div className="field">
                  <label htmlFor="pmb-total">Bill total</label>
                  <input id="pmb-total" className="input" type="number" step="0.01" value={form.totalAmount} onChange={set('totalAmount')} required />
                </div>
                <div className="field">
                  <label htmlFor="pmb-split">Split by</label>
                  <select id="pmb-split" className="input" value={form.splitMethod} onChange={set('splitMethod')}>
                    <option value="share">Each unit's share %</option>
                    <option value="equal">Equally between units</option>
                    <option value="sqm">Floor area</option>
                  </select>
                </div>
                <div className="field poki-dialog-span">
                  <label htmlFor="pmb-ref">Reference</label>
                  <input id="pmb-ref" className="input" value={form.reference || ''} onChange={set('reference')} placeholder="e.g. ECG account / bill number" />
                </div>
              </>
            )}

            <div className="poki-dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </div>
      )}

      {dialog === 'split' && split && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <div className="dialog poki-dialog" onClick={(e) => e.stopPropagation()}>
            <h2 className="poki-dialog-title">Split — {split.propertyName}</h2>
            <p className="poki-dialog-hint">
              {money(split.totalAmount, 'GHS')} for {fmtDate(split.periodStart)} → {fmtDate(split.periodEnd)}, split by{' '}
              {split.splitMethod === 'share' ? "each unit's share %" : split.splitMethod === 'sqm' ? 'floor area' : 'equal shares'}.
            </p>
            {dialogError && <div className="error-banner poki-dialog-span">{dialogError}</div>}
            {split.weightBasisMissing && (
              <p className="poki-dialog-hint poki-overdue">
                No usable shares or floor areas are recorded on these units, so the bill is being split equally.
              </p>
            )}
            <div className="poki-dialog-span">
              {split.lines.length === 0 ? (
                <p className="poki-muted">{split.note || 'No apportioned units in this property.'}</p>
              ) : (
                <table className="table">
                  <thead><tr><th>Unit</th><th>Tenant</th><th className="poki-num">Share</th><th className="poki-num">Amount</th></tr></thead>
                  <tbody>
                    {split.lines.map((l) => (
                      <tr key={l.unitId}>
                        <td className="poki-strong">{l.unitCode}</td>
                        <td>{l.tenantName || <span className="poki-muted">vacant — not billed</span>}</td>
                        <td className="poki-num">{l.sharePercent}%</td>
                        <td className="poki-num">{money(l.amount, l.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="poki-dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>Close</button>
              {canManage && !split.billedAt && split.lines.some((l) => l.billable) && (
                <button type="button" className="btn btn-primary" disabled={busy} onClick={billMaster}>
                  {busy ? 'Billing…' : 'Charge to tenants'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {payFor && (
        <div className="dialog-backdrop" onClick={() => setPayFor(null)}>
          <form className="dialog poki-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitPayment}>
            <h2 className="poki-dialog-title">Record payment — {payFor.invoiceNo}</h2>
            <p className="poki-dialog-hint poki-dialog-span">
              {payFor.customerName} · outstanding {money(payFor.balanceDue, payFor.currency)}. A receipt is generated
              automatically, and part payments are fine.
            </p>
            {invError && <div className="error-banner poki-dialog-span">{invError}</div>}
            <div className="field">
              <label htmlFor="pp-amount">Amount</label>
              <input id="pp-amount" className="input" type="number" step="0.01" value={payForm.amount}
                onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="pp-method">Method</label>
              <select id="pp-method" className="input" value={payForm.method}
                onChange={(e) => setPayForm({ ...payForm, method: e.target.value })}>
                <option value="bank_transfer">Bank transfer</option>
                <option value="mobile_money">Mobile money</option>
                <option value="cash">Cash</option>
                <option value="cheque">Cheque</option>
                <option value="card">Card</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div className="field poki-dialog-span">
              <label htmlFor="pp-ref">Reference</label>
              <input id="pp-ref" className="input" value={payForm.reference}
                onChange={(e) => setPayForm({ ...payForm, reference: e.target.value })}
                placeholder="momo transaction id, cheque no…" />
            </div>
            <div className="poki-dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setPayFor(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Record payment'}</button>
            </div>
          </form>
        </div>
      )}

      {newInv && (
        <div className="dialog-backdrop" onClick={() => setNewInv(null)}>
          <form className="dialog poki-dialog poki-offer-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitNewInvoice}>
            <h2 className="poki-dialog-title">New invoice</h2>
            <p className="poki-dialog-hint poki-dialog-span">
              For one-off charges — service charge, late fee, cleaning, damages. Rent and metered utilities are raised
              from the Rent run and Utilities tabs so their bookkeeping stays in step.
            </p>
            {invError && <div className="error-banner poki-dialog-span">{invError}</div>}

            <div className="field">
              <label htmlFor="pn-tenant">Tenant</label>
              <select id="pn-tenant" className="input" value={newInv.tenantId}
                onChange={(e) => setNewInv({ ...newInv, tenantId: e.target.value, leaseId: '' })} required>
                <option value="">Choose a tenant…</option>
                {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="pn-kind">Charge kind</label>
              <select id="pn-kind" className="input" value={newInv.docKind}
                onChange={(e) => setNewInv({ ...newInv, docKind: e.target.value })}>
                <option value="other">Other</option>
                <option value="deposit">Deposit</option>
                <option value="maintenance">Maintenance</option>
              </select>
            </div>
            <div className="field poki-dialog-span">
              <label htmlFor="pn-lease">Against lease (optional)</label>
              <select id="pn-lease" className="input" value={newInv.leaseId}
                onChange={(e) => setNewInv({ ...newInv, leaseId: e.target.value })}>
                <option value="">Not tied to a lease</option>
                {leases.filter((l) => !newInv.tenantId || l.tenantId === newInv.tenantId).map((l) => (
                  <option key={l.id} value={l.id}>{l.leaseNo} · {l.propertyName} · {l.unitCode}</option>
                ))}
              </select>
              <p className="poki-dialog-hint">Attaching the lease makes the charge show in that tenancy&rsquo;s arrears.</p>
            </div>

            <div className="poki-dialog-span">
              <div className="poki-lines-head">
                <span>Lines</span>
                <span className="poki-muted">
                  Total {money(newInv.items.reduce((sum, it) => sum + (Number(it.qty) || 0) * (Number(it.unitPrice) || 0), 0), 'GHS')}
                </span>
              </div>
              {newInv.items.map((it, idx) => (
                <div className="poki-line-row" key={idx}>
                  <input className="input" placeholder="Description" value={it.description}
                    aria-label={'Line ' + (idx + 1) + ' description'}
                    onChange={(e) => setNewInv({ ...newInv, items: newInv.items.map((x, j) => (j === idx ? { ...x, description: e.target.value } : x)) })} />
                  <input className="input" type="number" step="0.01" placeholder="Qty" value={it.qty}
                    aria-label={'Line ' + (idx + 1) + ' quantity'}
                    onChange={(e) => setNewInv({ ...newInv, items: newInv.items.map((x, j) => (j === idx ? { ...x, qty: e.target.value } : x)) })} />
                  <input className="input" placeholder="Unit" value={it.unit || ''}
                    aria-label={'Line ' + (idx + 1) + ' unit'}
                    onChange={(e) => setNewInv({ ...newInv, items: newInv.items.map((x, j) => (j === idx ? { ...x, unit: e.target.value } : x)) })} />
                  <input className="input" type="number" step="0.01" placeholder="Price" value={it.unitPrice}
                    aria-label={'Line ' + (idx + 1) + ' price'}
                    onChange={(e) => setNewInv({ ...newInv, items: newInv.items.map((x, j) => (j === idx ? { ...x, unitPrice: e.target.value } : x)) })} />
                  <span className="poki-line-total">{money((Number(it.qty) || 0) * (Number(it.unitPrice) || 0), 'GHS')}</span>
                  <button type="button" className="btn btn-secondary poki-row-btn" aria-label={'Remove line ' + (idx + 1)}
                    onClick={() => setNewInv({ ...newInv, items: newInv.items.length > 1 ? newInv.items.filter((_, j) => j !== idx) : newInv.items })}>×</button>
                </div>
              ))}
              <button type="button" className="btn btn-secondary poki-row-btn"
                onClick={() => setNewInv({ ...newInv, items: [...newInv.items, { description: '', qty: 1, unitPrice: '' }] })}>Add line</button>
            </div>

            <div className="field">
              <label htmlFor="pn-due">Due date</label>
              <input id="pn-due" className="input" type="date" value={newInv.dueDate}
                onChange={(e) => setNewInv({ ...newInv, dueDate: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="pn-notes">Note on the invoice</label>
              <input id="pn-notes" className="input" value={newInv.notes}
                onChange={(e) => setNewInv({ ...newInv, notes: e.target.value })} />
            </div>

            <div className="poki-dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setNewInv(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Raising…' : 'Raise invoice'}</button>
            </div>
          </form>
        </div>
      )}

      {previewInv && (
        <DocPreview
          documentType="invoice" documentId={previewInv.id}
          company={previewInv.company}
          // Poki managers hold poki.manage, not invoice.manage, so share
          // links go through Poki's own endpoints.
          shareApi={{
            create: (expiresInDays) => api.post('/poki/invoices/' + previewInv.id + '/share', { expiresInDays: expiresInDays || undefined }),
            whatsapp: (url) => api.post('/poki/invoices/' + previewInv.id + '/share/whatsapp', { url })
          }}
          docLabel={'Invoice #' + previewInv.invoiceNo}
          dateLabel="Issue date"
          dateValue={fmtDate(previewInv.issuedAt)}
          heading={'Invoice for ' + previewInv.customerName}
          subHeading={'Due ' + fmtDate(previewInv.dueDate)}
          blocks={[
            { title: 'Tenant', lines: [previewInv.customerName, previewInv.customerEmail || previewInv.customerPhone || ''] },
            {
              title: 'Property',
              lines: previewInv.unitCode
                ? [previewInv.propertyName + ' · ' + previewInv.unitCode, previewInv.leaseNo || '']
                : ['—', '']
            },
            {
              title: previewInv.periodStart ? 'Period' : 'Invoice',
              lines: previewInv.periodStart
                ? [fmtDate(previewInv.periodStart) + ' → ' + fmtDate(previewInv.periodEnd), money(previewInv.grandTotal, previewInv.currency)]
                : ['Issued ' + fmtDate(previewInv.issuedAt), money(previewInv.grandTotal, previewInv.currency)]
            }
          ]}
          items={groupPackageItems(previewInv.items, previewInv.currency)}
          subtotal={money(previewInv.subtotal, previewInv.currency)}
          isPartial={previewInv.amountPaid > 0 && previewInv.balanceDue > 0}
          amountPaid={money(previewInv.amountPaid, previewInv.currency)}
          totalLabel="Total Due"
          total={money(previewInv.balanceDue, previewInv.currency)}
          notesLabel="Payment instructions"
          notesValue={previewInv.bankInstructions}
          paymentSchedule={formatPaymentSchedule(previewInv.paymentSchedule, previewInv.currency)}
          onClose={() => setPreviewInv(null)}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
