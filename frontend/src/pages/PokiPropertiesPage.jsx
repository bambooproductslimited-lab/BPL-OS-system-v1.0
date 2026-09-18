import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { money } from '../lib/currency';
import './PokiPages.css';
import RowMenu from '../components/RowMenu';

// Properties and the units inside them. A unit is the thing that actually
// gets let — a flat, a single room, an office suite, a shop, a warehouse
// bay — so this is where the asking rent and the utility arrangement are
// set. Occupancy is read-only here: it follows the unit's booking.

const UNIT_TYPES = ['apartment', 'room', 'office', 'shop', 'warehouse', 'land', 'other'];

// The company keeps its books in GHS, so that is the currency every other one
// is shown against. A unit let in USD stores its rent in USD; fxRate says what
// one USD is worth in GHS, and the GHS figure is shown beside the amount
// rather than replacing it.
const BASE_CURRENCY = 'GHS';
const UNIT_CURRENCIES = ['GHS', 'USD', 'EUR', 'GBP', 'CNY'];
// How a unit's utilities are charged. These four values are exactly what the
// backend accepts (V.oneOf in poki.service.js), so adding a fifth here
// without adding it there would be rejected on save.
//
// Lost in the bookings rewrite, which removed the rent-cycle constants from
// this file and took this one with it. Nothing failed to build — an
// undefined identifier inside JSX only throws when that JSX renders, and
// this one is in the Add unit dialog, so the page itself was fine and only
// opening the dialog broke.
const UTILITY_MODES = [
  { value: 'none', label: 'Tenant pays provider directly' },
  { value: 'metered', label: 'Sub-meter — billed on consumption' },
  { value: 'fixed', label: 'Fixed charge per period' },
  { value: 'apportioned', label: 'Share of the building master bill' }
];

const EMPTY_PROPERTY = { code: '', name: '', propertyType: 'mixed', address: '', city: 'Tema', region: 'Greater Accra', ghanaPostGps: '', notes: '' };
const EMPTY_UNIT = {
  propertyId: '', code: '', name: '', unitType: 'room', floor: '', sizeSqm: '', bedrooms: '', bathrooms: '',
  baseRent: '', currency: 'GHS', fxRate: '', dailyRate: '', utilityMode: 'none', fixedUtilityAmount: '', apportionShare: '', amenities: '', notes: ''
};

export default function PokiPropertiesPage() {
  const { can } = useAuth();
  const canManage = can('poki.manage');

  const [properties, setProperties] = useState([]);
  const [units, setUnits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [search, setSearch] = useState('');
  const [propertyFilter, setPropertyFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [dialog, setDialog] = useState(null); // 'property' | 'unit'
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_PROPERTY);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [p, u] = await Promise.all([api.get('/poki/properties'), api.get('/poki/units')]);
      setProperties(p);
      setUnits(u);
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

  // "= GHS 7,750.00" under an amount, as soon as both a rate and a figure are
  // present. Returns nothing for a GHS unit, where converting to GHS would
  // just repeat the number, and nothing while the rate is still blank.
  function equivalent(amount) {
    if (form.currency === BASE_CURRENCY) return '';
    const rate = Number(form.fxRate);
    const value = Number(amount);
    if (!isFinite(rate) || rate <= 0 || !isFinite(value) || !value) return '';
    return '= ' + money(value * rate, BASE_CURRENCY);
  }

  function openProperty(p) {
    setDialogError(null);
    setEditId(p ? p.id : null);
    setForm(p ? { ...EMPTY_PROPERTY, ...p } : EMPTY_PROPERTY);
    setDialog('property');
  }
  function openUnit(u) {
    setDialogError(null);
    setEditId(u ? u.id : null);
    setForm(u
      ? { ...EMPTY_UNIT, ...u, sizeSqm: u.sizeSqm || '', baseRent: u.baseRent || '', bedrooms: u.bedrooms || '', bathrooms: u.bathrooms || '',
          fxRate: u.currency && u.currency !== BASE_CURRENCY ? (u.fxRate || '') : '' }
      : { ...EMPTY_UNIT, propertyId: propertyFilter || (properties[0] && properties[0].id) || '' });
    setDialog('unit');
  }

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setDialogError(null);
    try {
      if (dialog === 'property') {
        if (editId) await api.patch('/poki/properties/' + editId, form);
        else await api.post('/poki/properties', form);
        setToast(editId ? 'Property updated.' : 'Property added.');
      } else {
        if (editId) await api.patch('/poki/units/' + editId, form);
        else await api.post('/poki/units', form);
        setToast(editId ? 'Unit updated.' : 'Unit added.');
      }
      setDialog(null);
      await load();
    } catch (err) {
      setDialogError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function removeUnit(u) {
    if (!window.confirm('Delete unit ' + u.code + '? This cannot be undone.')) return;
    try {
      await api.del('/poki/units/' + u.id);
      setToast('Unit deleted.');
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const visibleUnits = units.filter((u) =>
    matchesQuery(search, u.code, u.name, u.propertyName, u.tenantName) &&
    (!propertyFilter || u.propertyId === propertyFilter) &&
    (!statusFilter || u.status === statusFilter)
  );

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="poki-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Search units, tenants…" />
        <select className="input" value={propertyFilter} onChange={(e) => setPropertyFilter(e.target.value)} aria-label="Filter by property">
          <option value="">All properties</option>
          {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          <option value="occupied">Occupied</option>
          <option value="vacant">Vacant</option>
          <option value="reserved">Reserved</option>
          <option value="maintenance">Maintenance</option>
          <option value="unavailable">Unavailable</option>
        </select>
        <div className="poki-toolbar-spacer" />
        {canManage && <button type="button" className="btn btn-secondary" onClick={() => openProperty(null)}>Add property</button>}
        {canManage && <button type="button" className="btn btn-primary" disabled={!properties.length} onClick={() => openUnit(null)}>Add unit</button>}
      </div>

      {properties.length === 0 ? (
        <div className="poki-empty">
          <p className="poki-empty-title">No properties yet</p>
          <p className="poki-empty-sub">
            Start with a property (the building or site), then add the units inside it that you actually let.
          </p>
        </div>
      ) : (
        <>
          <div className="poki-stats">
            {properties.map((p) => (
              <div className="poki-stat" key={p.id}>
                <div className="poki-stat-label">{p.code}</div>
                <div className="poki-stat-value" style={{ fontSize: 17 }}>{p.name}</div>
                <div className="poki-stat-sub">
                  {p.unitCount} unit{p.unitCount === 1 ? '' : 's'} · {p.occupiedCount} let · {p.vacantCount} vacant
                </div>
                {canManage && (
                  <button type="button" className="btn btn-secondary poki-row-btn" style={{ marginTop: 8 }} onClick={() => openProperty(p)}>
                    Edit property
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="poki-section">
            <h2 className="poki-section-title">Units</h2>
            {visibleUnits.length === 0 ? (
              <div className="poki-empty">
                <p className="poki-empty-title">No units match</p>
                <p className="poki-empty-sub">Adjust the filters, or add a unit to this property.</p>
              </div>
            ) : (
              <div className="poki-table-wrap">
<table className="table">
                <thead>
                  <tr>
                    <th>Unit</th><th>Type</th><th>Property</th><th>Status</th><th>Tenant</th>
                    <th className="poki-num">Rent</th><th>Utilities</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleUnits.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <div className="poki-strong">{u.code}</div>
                        {u.name && <div className="poki-muted">{u.name}</div>}
                      </td>
                      <td style={{ textTransform: 'capitalize' }}>{u.unitType}</td>
                      <td>{u.propertyName}</td>
                      <td><span className={'poki-chip poki-chip-' + u.status}>{u.status}</span></td>
                      <td>{u.tenantName || <span className="poki-muted">—</span>}</td>
                      <td className="poki-num">
                        {money(u.baseRent, u.currency)}
                        {u.currency !== BASE_CURRENCY && Number(u.fxRate) > 0 && (
                          <div className="poki-muted poki-fx-hint">= {money(u.baseRent * u.fxRate, BASE_CURRENCY)}</div>
                        )}
                        <div className="poki-muted">per month</div>
                      </td>
                      <td className="poki-muted">
                        {u.utilityMode === 'none' && 'Direct to provider'}
                        {u.utilityMode === 'metered' && 'Sub-metered'}
                        {u.utilityMode === 'fixed' && 'Fixed ' + money(u.fixedUtilityAmount, u.currency)}
                        {u.utilityMode === 'apportioned' && u.apportionShare + '% of master bill'}
                      </td>
                      <td className="table-actions" onClick={(e) => e.stopPropagation()}>
                        <RowMenu actions={[
                          { label: "Edit", onClick: () => openUnit(u), hidden: !(canManage) },
                          { label: "Delete", onClick: () => removeUnit(u), danger: true, hidden: !(canManage && !u.bookingId) },
                        ]} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
</div>
            )}
          </div>
        </>
      )}

      {dialog === 'property' && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <form className="dialog poki-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
            <h2 className="poki-dialog-title">{editId ? 'Edit property' : 'Add property'}</h2>
            {dialogError && <div className="error-banner poki-dialog-span">{dialogError}</div>}
            <div className="field">
              <label htmlFor="pp-code">Code</label>
              <input id="pp-code" className="input" value={form.code} onChange={set('code')} placeholder="e.g. PH" required disabled={!!editId} />
            </div>
            <div className="field">
              <label htmlFor="pp-name">Name</label>
              <input id="pp-name" className="input" value={form.name} onChange={set('name')} placeholder="e.g. Poki House" required />
            </div>
            <div className="field">
              <label htmlFor="pp-type">Type</label>
              <select id="pp-type" className="input" value={form.propertyType} onChange={set('propertyType')}>
                <option value="residential">Residential</option>
                <option value="commercial">Commercial</option>
                <option value="mixed">Mixed use</option>
                <option value="land">Land</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="pp-gps">GhanaPost GPS</label>
              <input id="pp-gps" className="input" value={form.ghanaPostGps} onChange={set('ghanaPostGps')} placeholder="GT-191-1859" />
            </div>
            <div className="field poki-dialog-span">
              <label htmlFor="pp-address">Address</label>
              <input id="pp-address" className="input" value={form.address} onChange={set('address')} />
            </div>
            <div className="field">
              <label htmlFor="pp-city">City</label>
              <input id="pp-city" className="input" value={form.city} onChange={set('city')} />
            </div>
            <div className="field">
              <label htmlFor="pp-region">Region</label>
              <input id="pp-region" className="input" value={form.region} onChange={set('region')} />
            </div>
            <div className="field poki-dialog-span">
              <label htmlFor="pp-notes">Notes</label>
              <textarea id="pp-notes" className="input" rows={2} value={form.notes} onChange={set('notes')} />
            </div>
            <div className="poki-dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </div>
      )}

      {dialog === 'unit' && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <form className="dialog poki-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
            <h2 className="poki-dialog-title">{editId ? 'Edit unit' : 'Add unit'}</h2>
            {dialogError && <div className="error-banner poki-dialog-span">{dialogError}</div>}
            <div className="field">
              <label htmlFor="pu-property">Property</label>
              <select id="pu-property" className="input" value={form.propertyId} onChange={set('propertyId')} required disabled={!!editId}>
                {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="pu-code">Unit code</label>
              <input id="pu-code" className="input" value={form.code} onChange={set('code')} placeholder="e.g. OF-1, APT-2B" required />
            </div>
            <div className="field">
              <label htmlFor="pu-name">Description</label>
              <input id="pu-name" className="input" value={form.name} onChange={set('name')} placeholder="e.g. Ground floor office" />
            </div>
            <div className="field">
              <label htmlFor="pu-type">Unit type</label>
              <select id="pu-type" className="input" value={form.unitType} onChange={set('unitType')}>
                {UNIT_TYPES.map((t) => <option key={t} value={t} style={{ textTransform: 'capitalize' }}>{t}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="pu-floor">Floor</label>
              <input id="pu-floor" className="input" value={form.floor} onChange={set('floor')} placeholder="e.g. Ground, 2nd" />
            </div>
            <div className="field">
              <label htmlFor="pu-size">Size (m²)</label>
              <input id="pu-size" className="input" type="number" step="0.01" value={form.sizeSqm} onChange={set('sizeSqm')} />
            </div>
            {(form.unitType === 'apartment' || form.unitType === 'room') && (
              <>
                <div className="field">
                  <label htmlFor="pu-bed">Bedrooms</label>
                  <input id="pu-bed" className="input" type="number" value={form.bedrooms} onChange={set('bedrooms')} />
                </div>
                <div className="field">
                  <label htmlFor="pu-bath">Bathrooms</label>
                  <input id="pu-bath" className="input" type="number" value={form.bathrooms} onChange={set('bathrooms')} />
                </div>
              </>
            )}
            <div className="field">
              <label htmlFor="pu-currency">Currency</label>
              <select id="pu-currency" className="input" value={form.currency} onChange={set('currency')}>
                {UNIT_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            {form.currency !== BASE_CURRENCY && (
              <div className="field">
                <label htmlFor="pu-fx">Your rate — 1 {form.currency} = ? {BASE_CURRENCY}</label>
                <input
                  id="pu-fx" className="input" type="number" step="0.000001" min="0"
                  value={form.fxRate} onChange={set('fxRate')}
                  placeholder="e.g. 15.50" required
                />
              </div>
            )}
            <div className="field">
              <label htmlFor="pu-rent">Asking rent, per month</label>
              <input id="pu-rent" className="input" type="number" step="0.01" value={form.baseRent} onChange={set('baseRent')} />
              {equivalent(form.baseRent) && <div className="poki-fx-hint">{equivalent(form.baseRent)}</div>}
            </div>
            <div className="field">
              <label htmlFor="pu-daily">Rent per day</label>
              <input id="pu-daily" className="input" type="number" step="0.01" value={form.dailyRate} onChange={set('dailyRate')} placeholder="optional" />
              {equivalent(form.dailyRate) && <div className="poki-fx-hint">{equivalent(form.dailyRate)}</div>}
              <p className="poki-dialog-hint">
                For bookings measured in days. Left blank, a day is charged at a thirtieth of the monthly rate.
              </p>
            </div>
            <div className="field poki-dialog-span">
              <label htmlFor="pu-utility">Utilities</label>
              <select id="pu-utility" className="input" value={form.utilityMode} onChange={set('utilityMode')}>
                {UTILITY_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            {form.utilityMode === 'fixed' && (
              <div className="field">
                <label htmlFor="pu-fixed">Fixed utility charge</label>
                <input id="pu-fixed" className="input" type="number" step="0.01" value={form.fixedUtilityAmount} onChange={set('fixedUtilityAmount')} />
              </div>
            )}
            {form.utilityMode === 'apportioned' && (
              <div className="field">
                <label htmlFor="pu-share">Share of master bill (%)</label>
                <input id="pu-share" className="input" type="number" step="0.01" value={form.apportionShare} onChange={set('apportionShare')} />
              </div>
            )}
            {form.utilityMode === 'metered' && (
              <p className="poki-dialog-hint">
                Add this unit's meter(s) and record readings on the Rent &amp; utilities screen — consumption is billed there.
              </p>
            )}
            <div className="field poki-dialog-span">
              <label htmlFor="pu-amen">Amenities</label>
              <input id="pu-amen" className="input" value={form.amenities} onChange={set('amenities')} placeholder="e.g. A/C, parking, water tank" />
            </div>
            {editId && (
              <p className="poki-dialog-hint">
                Occupancy isn't set here — a unit becomes occupied when a booking on it is activated, and frees up when that booking ends.
              </p>
            )}
            <div className="poki-dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
