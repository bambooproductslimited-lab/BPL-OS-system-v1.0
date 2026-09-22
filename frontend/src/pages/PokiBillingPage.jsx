import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { money } from '../lib/currency';
import DocPreview from '../components/DocPreview';
import { groupPackageItems } from '../lib/packages';
import { formatPaymentSchedule } from '../lib/paymentSchedule';
import './PokiPages.css';
import RowMenu from '../components/RowMenu';

import { tr } from '../lib/i18n.jsx';
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

  const [tab, setTab] = useState('utilities');
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
  const [selected, setSelected] = useState({});

  const [units, setUnits] = useState([]);
  const [meters, setMeters] = useState([]);
  const [readings, setReadings] = useState([]);
  const [masterBills, setMasterBills] = useState([]);
  const [properties, setProperties] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [tenants, setTenants] = useState([]);
  const [bookings, setBookings] = useState([]);

  const [dialog, setDialog] = useState(null);
  const [form, setForm] = useState({});
  const [dialogError, setDialogError] = useState(null);
  const [split, setSplit] = useState(null);

  const loadPreview = useCallback(async (date) => {
    try {
    } catch (err) {
      setError(err.message);
    }
  }, [asOf]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [u, m, r, mb, inv, tn, ls] = await Promise.all([
        api.get('/poki/units'),
        api.get('/poki/meters'),
        api.get('/poki/readings'),
        api.get('/poki/master-bills'),
        api.get('/poki/invoices'),
        api.get('/poki/tenants'),
        api.get('/poki/bookings')
      ]);
      setUnits(u);
      setMeters(m);
      setReadings(r);
      setMasterBills(mb);
      setInvoices(inv);
      setTenants(tn);
      setBookings(ls);
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
      tenantId: '', bookingId: '', docKind: 'other', dueDate: '',
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
        bookingId: newInv.bookingId || undefined,
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
        (res.skippedUnits && res.skippedUnits.length ? ' Skipped ' + res.skippedUnits.join(', ') + ' — no active booking.' : ''));
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

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const unbilled = readings.filter((r) => !r.invoiceId);
  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="poki-toolbar">
        <button type="button" className={'btn ' + (tab === 'utilities' ? 'btn-primary' : 'btn-secondary')} onClick={() => setTab('utilities')}>{tr('Utilities')}</button>
        <button type="button" className={'btn ' + (tab === 'invoices' ? 'btn-primary' : 'btn-secondary')} onClick={() => setTab('invoices')}>{tr('Invoices')}</button>
      </div>

      {tab === 'utilities' && (
        <div>
          <p className="poki-muted" style={{ marginBottom: 12 }}>
            {tr('Rent is invoiced when a booking is made, not from here — a booking is paid for up front. Utilities are the only charge still raised after the fact.')}
          </p>
          <div className="poki-section" style={{ marginTop: 0 }}>
            <div className="poki-toolbar">
              <h2 className="poki-section-title" style={{ margin: 0 }}>{tr('Meter readings')}</h2>
              <div className="poki-toolbar-spacer" />
              {canManage && <button type="button" className="btn btn-secondary" onClick={() => { setForm({ utilityType: 'electricity', measureUnit: 'kWh', rate: '' }); setDialogError(null); setDialog('meter'); }}>{tr('Add meter')}</button>}
              {canManage && meters.length > 0 && (
                <button type="button" className="btn btn-secondary" onClick={() => { setForm({ meterId: meters[0].id, periodStart: '', periodEnd: '', currentReading: '' }); setDialogError(null); setDialog('reading'); }}>{tr('Record reading')}</button>
              )}
              {canManage && unbilled.length > 0 && (
                <button type="button" className="btn btn-primary" disabled={busy} onClick={billSelectedReadings}>{tr('Bill selected')}</button>
              )}
            </div>

            {meters.length === 0 ? (
              <div className="poki-empty">
                <p className="poki-empty-title">{tr('No meters yet')}</p>
                <p className="poki-empty-sub">
                  {tr('Add a sub-meter to any unit set to "metered" utilities, then record its readings each period to bill consumption.')}
                </p>
              </div>
            ) : readings.length === 0 ? (
              <div className="poki-empty">
                <p className="poki-empty-title">{tr('No readings recorded')}</p>
                <p className="poki-empty-sub">{tr('Record a reading against a meter to bill the consumption.')}</p>
              </div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 32 }}></th>
                    <th>{tr('Unit')}</th><th>{tr('Utility')}</th><th>{tr('Period')}</th>
                    <th className="poki-num">{tr('Previous')}</th><th className="poki-num">{tr('Current')}</th><th className="poki-num">{tr('Used')}</th>
                    <th className="poki-num">{tr('Amount')}</th><th>{tr('Status')}</th>
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
                          : <span className="poki-chip poki-chip-open">{tr('unbilled')}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="poki-section">
            <div className="poki-toolbar">
              <h2 className="poki-section-title" style={{ margin: 0 }}>{tr('Shared (master) bills')}</h2>
              <div className="poki-toolbar-spacer" />
              {canManage && properties.length > 0 && (
                <button type="button" className="btn btn-secondary"
                  onClick={() => { setForm({ propertyId: properties[0].id, utilityType: 'electricity', splitMethod: 'share', periodStart: '', periodEnd: '', totalAmount: '' }); setDialogError(null); setDialog('master'); }}>
                  {tr('Record master bill')}
                </button>
              )}
            </div>
            <p className="poki-section-sub">
              {tr('The whole-building ECG or Ghana Water bill, split across the units set to "apportioned". Review the split before charging it — apportioned utilities are the line tenants query most.')}
            </p>
            {masterBills.length === 0 ? (
              <div className="poki-empty">
                <p className="poki-empty-title">{tr('No master bills recorded')}</p>
                <p className="poki-empty-sub">{tr('Only needed if some units share a building meter rather than having their own.')}</p>
              </div>
            ) : (
              <table className="table">
                <thead>
                  <tr><th>{tr('Property')}</th><th>{tr('Utility')}</th><th>{tr('Period')}</th><th className="poki-num">{tr('Total')}</th><th>{tr('Split by')}</th><th>{tr('Status')}</th><th></th></tr>
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
                          ? <span className="poki-chip poki-chip-active">{tr('apportioned')}</span>
                          : <span className="poki-chip poki-chip-open">{tr('not billed')}</span>}
                      </td>
                      <td className="table-actions" onClick={(e) => e.stopPropagation()}>
                        <RowMenu actions={[
                          { label: b.billedAt ? 'View split' : 'Review & bill', onClick: () => showSplit(b) },
                        ]} />
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
            <p className="poki-empty-title">{tr('No invoices raised yet')}</p>
            <p className="poki-empty-sub">{tr('Rent, utility and repair invoices raised for Poki tenants appear here.')}</p>
            {canManage && (
              <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} onClick={openNewInvoice}>
                {tr('New invoice')}
              </button>
            )}
          </div>
        ) : (
          <>
          <div className="poki-toolbar">
            <span className="poki-muted">{invoices.length} {tr('invoice(s)')}</span>
            <div className="poki-toolbar-spacer" />
            {canManage && <button type="button" className="btn btn-primary" onClick={openNewInvoice}>{tr('New invoice')}</button>}
          </div>
          <div className="poki-table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{tr('Invoice')}</th><th>{tr('Kind')}</th><th>{tr('Tenant')}</th><th>{tr('Unit')}</th><th>{tr('Period')}</th><th>{tr('Due')}</th>
                <th className="poki-num">{tr('Total')}</th><th className="poki-num">{tr('Balance')}</th><th>{tr('Status')}</th><th></th>
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
                  <td className="table-actions" onClick={(e) => e.stopPropagation()}>
                    <RowMenu actions={[
                      { label: "Print", onClick: () => openPreview(i) },
                      { label: "Record payment", onClick: () => openPay(i), disabled: busy, hidden: !(canManage && i.status !== 'paid' && i.status !== 'void') },
                      { label: "Void", onClick: () => voidInvoice(i), disabled: busy, danger: true, hidden: !(canManage && i.status !== 'void' && Number(i.amountPaid) === 0) },
                    ]} />
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
                  <label htmlFor="pm-unit">{tr('Unit')}</label>
                  <select id="pm-unit" className="input" value={form.unitId || ''} onChange={set('unitId')} required>
                    <option value="">{tr('Choose a unit…')}</option>
                    {units.map((u) => <option key={u.id} value={u.id}>{u.propertyName} · {u.code}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="pm-type">{tr('Utility')}</label>
                  <select id="pm-type" className="input" value={form.utilityType} onChange={set('utilityType')}>
                    <option value="electricity">{tr('Electricity')}</option>
                    <option value="water">{tr('Water')}</option>
                    <option value="gas">{tr('Gas')}</option>
                    <option value="other">{tr('Other')}</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="pm-no">{tr('Meter number')}</label>
                  <input id="pm-no" className="input" value={form.meterNumber || ''} onChange={set('meterNumber')} />
                </div>
                <div className="field">
                  <label htmlFor="pm-unitlbl">{tr('Measured in')}</label>
                  <input id="pm-unitlbl" className="input" value={form.measureUnit} onChange={set('measureUnit')} placeholder={tr('kWh, m³')} />
                </div>
                <div className="field">
                  <label htmlFor="pm-rate">{tr('Rate per unit')}</label>
                  <input id="pm-rate" className="input" type="number" step="0.0001" value={form.rate} onChange={set('rate')} required />
                </div>
              </>
            )}

            {dialog === 'reading' && (
              <>
                <div className="field poki-dialog-span">
                  <label htmlFor="prd-meter">{tr('Meter')}</label>
                  <select id="prd-meter" className="input" value={form.meterId || ''} onChange={set('meterId')} required>
                    {meters.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.propertyName} · {m.unitCode} — {m.utilityType} ({m.meterNumber || 'no number'}{tr(') · last')} {m.lastReading}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="prd-start">{tr('Period start')}</label>
                  <input id="prd-start" className="input" type="date" value={form.periodStart} onChange={set('periodStart')} required />
                </div>
                <div className="field">
                  <label htmlFor="prd-end">{tr('Period end')}</label>
                  <input id="prd-end" className="input" type="date" value={form.periodEnd} onChange={set('periodEnd')} required />
                </div>
                <div className="field">
                  <label htmlFor="prd-prev">{tr('Previous reading')}</label>
                  <input id="prd-prev" className="input" type="number" step="0.001" value={form.previousReading || ''} onChange={set('previousReading')}
                    placeholder={String((meters.find((m) => m.id === form.meterId) || {}).lastReading || 0)} />
                </div>
                <div className="field">
                  <label htmlFor="prd-cur">{tr('Current reading')}</label>
                  <input id="prd-cur" className="input" type="number" step="0.001" value={form.currentReading} onChange={set('currentReading')} required />
                </div>
                <p className="poki-dialog-hint">
                  {tr('Leave the previous reading blank to carry forward this meter\'s last recorded figure.')}
                </p>
              </>
            )}

            {dialog === 'master' && (
              <>
                <div className="field">
                  <label htmlFor="pmb-prop">{tr('Property')}</label>
                  <select id="pmb-prop" className="input" value={form.propertyId} onChange={set('propertyId')} required>
                    {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="pmb-type">{tr('Utility')}</label>
                  <select id="pmb-type" className="input" value={form.utilityType} onChange={set('utilityType')}>
                    <option value="electricity">{tr('Electricity')}</option>
                    <option value="water">{tr('Water')}</option>
                    <option value="gas">{tr('Gas')}</option>
                    <option value="other">{tr('Other')}</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="pmb-start">{tr('Period start')}</label>
                  <input id="pmb-start" className="input" type="date" value={form.periodStart} onChange={set('periodStart')} required />
                </div>
                <div className="field">
                  <label htmlFor="pmb-end">{tr('Period end')}</label>
                  <input id="pmb-end" className="input" type="date" value={form.periodEnd} onChange={set('periodEnd')} required />
                </div>
                <div className="field">
                  <label htmlFor="pmb-total">{tr('Bill total')}</label>
                  <input id="pmb-total" className="input" type="number" step="0.01" value={form.totalAmount} onChange={set('totalAmount')} required />
                </div>
                <div className="field">
                  <label htmlFor="pmb-split">{tr('Split by')}</label>
                  <select id="pmb-split" className="input" value={form.splitMethod} onChange={set('splitMethod')}>
                    <option value="share">{tr('Each unit\'s share %')}</option>
                    <option value="equal">{tr('Equally between units')}</option>
                    <option value="sqm">{tr('Floor area')}</option>
                  </select>
                </div>
                <div className="field poki-dialog-span">
                  <label htmlFor="pmb-ref">{tr('Reference')}</label>
                  <input id="pmb-ref" className="input" value={form.reference || ''} onChange={set('reference')} placeholder={tr('e.g. ECG account / bill number')} />
                </div>
              </>
            )}

            <div className="poki-dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </div>
      )}

      {dialog === 'split' && split && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <div className="dialog poki-dialog" onClick={(e) => e.stopPropagation()}>
            <h2 className="poki-dialog-title">{tr('Split —')} {split.propertyName}</h2>
            <p className="poki-dialog-hint">
              {money(split.totalAmount, 'GHS')} {tr('for')} {fmtDate(split.periodStart)} → {fmtDate(split.periodEnd)}{tr(', split by')}{' '}
              {split.splitMethod === 'share' ? "each unit's share %" : split.splitMethod === 'sqm' ? 'floor area' : 'equal shares'}.
            </p>
            {dialogError && <div className="error-banner poki-dialog-span">{dialogError}</div>}
            {split.weightBasisMissing && (
              <p className="poki-dialog-hint poki-overdue">
                {tr('No usable shares or floor areas are recorded on these units, so the bill is being split equally.')}
              </p>
            )}
            <div className="poki-dialog-span">
              {split.lines.length === 0 ? (
                <p className="poki-muted">{split.note || 'No apportioned units in this property.'}</p>
              ) : (
                <table className="table">
                  <thead><tr><th>{tr('Unit')}</th><th>{tr('Tenant')}</th><th className="poki-num">{tr('Share')}</th><th className="poki-num">{tr('Amount')}</th></tr></thead>
                  <tbody>
                    {split.lines.map((l) => (
                      <tr key={l.unitId}>
                        <td className="poki-strong">{l.unitCode}</td>
                        <td>{l.tenantName || <span className="poki-muted">{tr('vacant — not billed')}</span>}</td>
                        <td className="poki-num">{l.sharePercent}%</td>
                        <td className="poki-num">{money(l.amount, l.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="poki-dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>{tr('Close')}</button>
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
            <h2 className="poki-dialog-title">{tr('Record payment —')} {payFor.invoiceNo}</h2>
            <p className="poki-dialog-hint poki-dialog-span">
              {payFor.customerName} {tr('· outstanding')} {money(payFor.balanceDue, payFor.currency)}{tr('. A receipt is generated automatically, and part payments are fine.')}
            </p>
            {invError && <div className="error-banner poki-dialog-span">{invError}</div>}
            <div className="field">
              <label htmlFor="pp-amount">{tr('Amount')}</label>
              <input id="pp-amount" className="input" type="number" step="0.01" value={payForm.amount}
                onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="pp-method">{tr('Method')}</label>
              <select id="pp-method" className="input" value={payForm.method}
                onChange={(e) => setPayForm({ ...payForm, method: e.target.value })}>
                <option value="bank_transfer">{tr('Bank transfer')}</option>
                <option value="mobile_money">{tr('Mobile money')}</option>
                <option value="cash">{tr('Cash')}</option>
                <option value="cheque">{tr('Cheque')}</option>
                <option value="card">{tr('Card')}</option>
                <option value="other">{tr('Other')}</option>
              </select>
            </div>
            <div className="field poki-dialog-span">
              <label htmlFor="pp-ref">{tr('Reference')}</label>
              <input id="pp-ref" className="input" value={payForm.reference}
                onChange={(e) => setPayForm({ ...payForm, reference: e.target.value })}
                placeholder={tr('momo transaction id, cheque no…')} />
            </div>
            <div className="poki-dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setPayFor(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Record payment'}</button>
            </div>
          </form>
        </div>
      )}

      {newInv && (
        <div className="dialog-backdrop" onClick={() => setNewInv(null)}>
          <form className="dialog poki-dialog poki-offer-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitNewInvoice}>
            <h2 className="poki-dialog-title">{tr('New invoice')}</h2>
            <p className="poki-dialog-hint poki-dialog-span">
              {tr('For one-off charges — service charge, late fee, cleaning, damages. Rent and metered utilities are raised from the Rent run and Utilities tabs so their bookkeeping stays in step.')}
            </p>
            {invError && <div className="error-banner poki-dialog-span">{invError}</div>}

            <div className="field">
              <label htmlFor="pn-tenant">{tr('Tenant')}</label>
              <select id="pn-tenant" className="input" value={newInv.tenantId}
                onChange={(e) => setNewInv({ ...newInv, tenantId: e.target.value, bookingId: '' })} required>
                <option value="">{tr('Choose a tenant…')}</option>
                {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="pn-kind">{tr('Charge kind')}</label>
              <select id="pn-kind" className="input" value={newInv.docKind}
                onChange={(e) => setNewInv({ ...newInv, docKind: e.target.value })}>
                <option value="other">{tr('Other')}</option>
                <option value="deposit">{tr('Deposit')}</option>
                <option value="maintenance">{tr('Maintenance')}</option>
              </select>
            </div>
            <div className="field poki-dialog-span">
              <label htmlFor="pn-booking">{tr('Against booking (optional)')}</label>
              <select id="pn-booking" className="input" value={newInv.bookingId}
                onChange={(e) => setNewInv({ ...newInv, bookingId: e.target.value })}>
                <option value="">{tr('Not tied to a booking')}</option>
                {bookings.filter((l) => !newInv.tenantId || l.tenantId === newInv.tenantId).map((l) => (
                  <option key={l.id} value={l.id}>{l.bookingNo} · {l.propertyName} · {l.unitCode}</option>
                ))}
              </select>
              <p className="poki-dialog-hint">{tr('Attaching the booking makes the charge show in that tenancy’s arrears.')}</p>
            </div>

            <div className="poki-dialog-span">
              <div className="poki-lines-head">
                <span>{tr('Lines')}</span>
                <span className="poki-muted">
                  {tr('Total')} {money(newInv.items.reduce((sum, it) => sum + (Number(it.qty) || 0) * (Number(it.unitPrice) || 0), 0), 'GHS')}
                </span>
              </div>
              {newInv.items.map((it, idx) => (
                <div className="poki-line-row" key={idx}>
                  <input className="input" placeholder={tr('Description')} value={it.description}
                    aria-label={'Line ' + (idx + 1) + ' description'}
                    onChange={(e) => setNewInv({ ...newInv, items: newInv.items.map((x, j) => (j === idx ? { ...x, description: e.target.value } : x)) })} />
                  <input className="input" type="number" step="0.01" placeholder={tr('Qty')} value={it.qty}
                    aria-label={'Line ' + (idx + 1) + ' quantity'}
                    onChange={(e) => setNewInv({ ...newInv, items: newInv.items.map((x, j) => (j === idx ? { ...x, qty: e.target.value } : x)) })} />
                  <input className="input" placeholder={tr('Unit')} value={it.unit || ''}
                    aria-label={'Line ' + (idx + 1) + ' unit'}
                    onChange={(e) => setNewInv({ ...newInv, items: newInv.items.map((x, j) => (j === idx ? { ...x, unit: e.target.value } : x)) })} />
                  <input className="input" type="number" step="0.01" placeholder={tr('Price')} value={it.unitPrice}
                    aria-label={'Line ' + (idx + 1) + ' price'}
                    onChange={(e) => setNewInv({ ...newInv, items: newInv.items.map((x, j) => (j === idx ? { ...x, unitPrice: e.target.value } : x)) })} />
                  <span className="poki-line-total">{money((Number(it.qty) || 0) * (Number(it.unitPrice) || 0), 'GHS')}</span>
                  <button type="button" className="btn btn-secondary poki-row-btn" aria-label={'Remove line ' + (idx + 1)}
                    onClick={() => setNewInv({ ...newInv, items: newInv.items.length > 1 ? newInv.items.filter((_, j) => j !== idx) : newInv.items })}>×</button>
                </div>
              ))}
              <button type="button" className="btn btn-secondary poki-row-btn"
                onClick={() => setNewInv({ ...newInv, items: [...newInv.items, { description: '', qty: 1, unitPrice: '' }] })}>{tr('Add line')}</button>
            </div>

            <div className="field">
              <label htmlFor="pn-due">{tr('Due date')}</label>
              <input id="pn-due" className="input" type="date" value={newInv.dueDate}
                onChange={(e) => setNewInv({ ...newInv, dueDate: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="pn-notes">{tr('Note on the invoice')}</label>
              <input id="pn-notes" className="input" value={newInv.notes}
                onChange={(e) => setNewInv({ ...newInv, notes: e.target.value })} />
            </div>

            <div className="poki-dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setNewInv(null)}>{tr('Cancel')}</button>
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
                ? [previewInv.propertyName + ' · ' + previewInv.unitCode, previewInv.bookingNo || '']
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
