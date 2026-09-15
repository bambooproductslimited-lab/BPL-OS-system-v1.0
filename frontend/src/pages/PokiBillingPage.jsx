import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { money } from '../lib/currency';
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

  const [asOf, setAsOf] = useState(todayISO());
  const [preview, setPreview] = useState([]);
  const [selected, setSelected] = useState({});

  const [units, setUnits] = useState([]);
  const [meters, setMeters] = useState([]);
  const [readings, setReadings] = useState([]);
  const [masterBills, setMasterBills] = useState([]);
  const [properties, setProperties] = useState([]);
  const [invoices, setInvoices] = useState([]);

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
      const [p, u, m, r, mb, inv] = await Promise.all([
        api.get('/poki/rent-run/preview?asOf=' + asOf),
        api.get('/poki/units'),
        api.get('/poki/meters'),
        api.get('/poki/readings'),
        api.get('/poki/master-bills'),
        api.get('/poki/invoices')
      ]);
      setPreview(p);
      setUnits(u);
      setMeters(m);
      setReadings(r);
      setMasterBills(mb);
      setInvoices(inv);
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
                    <td>{fmtDate(p.periodStart)} → {fmtDate(p.periodEnd)}</td>
                    <td>{fmtDate(p.dueDate)}</td>
                    <td className="poki-num">{money(p.rentAmount, p.currency)}</td>
                    <td className="poki-num">{p.fixedUtility ? money(p.fixedUtility, p.currency) : <span className="poki-muted">—</span>}</td>
                    <td className="poki-num poki-strong">{money(p.total, p.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {preview.length > 0 && (
            <p className="poki-section-sub" style={{ marginTop: 10 }}>
              Tick rows to bill only those; with nothing ticked, the button raises all of them. Each lease then advances to its
              next period, so running twice can't double-bill.
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
          </div>
        ) : (
          <div className="poki-table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Invoice</th><th>Kind</th><th>Tenant</th><th>Unit</th><th>Period</th><th>Due</th>
                <th className="poki-num">Total</th><th className="poki-num">Balance</th><th>Status</th>
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
                    <span className={'poki-chip poki-chip-' + (i.status === 'paid' ? 'active' : i.overdue ? 'expired' : 'open')}>
                      {i.overdue && i.status !== 'paid' ? 'overdue' : i.status.replace('_', ' ')}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
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

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
