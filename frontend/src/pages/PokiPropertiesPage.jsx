import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { money } from '../lib/currency';
import './PokiPages.css';
import RowMenu from '../components/RowMenu';

import { tr, msg } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
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
  { value: 'none', label: msg('Tenant pays provider directly') },
  { value: 'metered', label: msg('Sub-meter — billed on consumption') },
  { value: 'fixed', label: msg('Fixed charge per period') },
  { value: 'apportioned', label: msg('Share of the building master bill') }
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
        setToast(editId ? tr('Property updated.') : tr('Property added.'));
      } else {
        if (editId) await api.patch('/poki/units/' + editId, form);
        else await api.post('/poki/units', form);
        setToast(editId ? tr('Unit updated.') : tr('Unit added.'));
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
    if (!window.confirm(tr('Delete unit {code}? This cannot be undone.', { code: u.code }))) return;
    try {
      await api.del('/poki/units/' + u.id);
      setToast(tr('Unit deleted.'));
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

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
        <SearchInput value={search} onChange={setSearch} placeholder={tr('Search units, tenants…')} />
        <select className="input" value={propertyFilter} onChange={(e) => setPropertyFilter(e.target.value)} aria-label={tr('Filter by property')}>
          <option value="">{tr('All properties')}</option>
          {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label={tr('Filter by status')}>
          <option value="">{tr('All statuses')}</option>
          <option value="occupied">{tr('Occupied')}</option>
          <option value="vacant">{tr('Vacant')}</option>
          <option value="reserved">{tr('Reserved')}</option>
          <option value="maintenance">{tr('Maintenance')}</option>
          <option value="unavailable">{tr('Unavailable')}</option>
        </select>
        <div className="poki-toolbar-spacer" />
        {canManage && <button type="button" className="btn btn-secondary" onClick={() => openProperty(null)}>{tr('Add property')}</button>}
        {canManage && <button type="button" className="btn btn-primary" disabled={!properties.length} onClick={() => openUnit(null)}>{tr('Add unit')}</button>}
      </div>

      {properties.length === 0 ? (
        <div className="poki-empty">
          <p className="poki-empty-title">{tr('No properties yet')}</p>
          <p className="poki-empty-sub">
            {tr('Start with a property (the building or site), then add the units inside it that you actually let.')}
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
                  {p.unitCount === 1 ? tr('1 unit') : tr('{n} units', { n: p.unitCount })} · {tr('{occupied} let · {vacant} vacant', { occupied: p.occupiedCount, vacant: p.vacantCount })}
                </div>
                {canManage && (
                  <button type="button" className="btn btn-secondary poki-row-btn" style={{ marginTop: 8 }} onClick={() => openProperty(p)}>
                    {tr('Edit property')}
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="poki-section">
            <h2 className="poki-section-title">{tr('Units')}</h2>
            {visibleUnits.length === 0 ? (
              <div className="poki-empty">
                <p className="poki-empty-title">{tr('No units match')}</p>
                <p className="poki-empty-sub">{tr('Adjust the filters, or add a unit to this property.')}</p>
              </div>
            ) : (
              <div className="poki-table-wrap">
<table className="table">
                <thead>
                  <tr>
                    <th>{tr('Unit')}</th><th>{tr('Type')}</th><th>{tr('Property')}</th><th>{tr('Status')}</th><th>{tr('Tenant')}</th>
                    <th className="poki-num">{tr('Rent')}</th><th>{tr('Utilities')}</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleUnits.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <div className="poki-strong">{u.code}</div>
                        {u.name && <div className="poki-muted">{u.name}</div>}
                      </td>
                      <td>{codeLabel(u.unitType)}</td>
                      <td>{u.propertyName}</td>
                      <td><span className={'poki-chip poki-chip-' + u.status}>{codeLabel(u.status)}</span></td>
                      <td>{u.tenantName || <span className="poki-muted">—</span>}</td>
                      <td className="poki-num">
                        {money(u.baseRent, u.currency)}
                        {u.currency !== BASE_CURRENCY && Number(u.fxRate) > 0 && (
                          <div className="poki-muted poki-fx-hint">= {money(u.baseRent * u.fxRate, BASE_CURRENCY)}</div>
                        )}
                        <div className="poki-muted">{tr('per month')}</div>
                      </td>
                      <td className="poki-muted">
                        {u.utilityMode === 'none' && tr('Direct to provider')}
                        {u.utilityMode === 'metered' && tr('Sub-metered')}
                        {u.utilityMode === 'fixed' && tr('Fixed {amount}', { amount: money(u.fixedUtilityAmount, u.currency) })}
                        {u.utilityMode === 'apportioned' && tr('{apportionShare}% of master bill', { apportionShare: u.apportionShare })}
                      </td>
                      <td className="table-actions" onClick={(e) => e.stopPropagation()}>
                        <RowMenu actions={[
                          { label: tr('Edit'), onClick: () => openUnit(u), hidden: !(canManage) },
                          { label: tr('Delete'), onClick: () => removeUnit(u), danger: true, hidden: !(canManage && !u.bookingId) },
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
            <h2 className="poki-dialog-title">{editId ? tr('Edit property') : tr('Add property')}</h2>
            {dialogError && <div className="error-banner poki-dialog-span">{dialogError}</div>}
            <div className="field">
              <label htmlFor="pp-code">{tr('Code')}</label>
              <input id="pp-code" className="input" value={form.code} onChange={set('code')} placeholder={tr('e.g. PH')} required disabled={!!editId} />
            </div>
            <div className="field">
              <label htmlFor="pp-name">{tr('Name')}</label>
              <input id="pp-name" className="input" value={form.name} onChange={set('name')} placeholder={tr('e.g. Poki House')} required />
            </div>
            <div className="field">
              <label htmlFor="pp-type">{tr('Type')}</label>
              <select id="pp-type" className="input" value={form.propertyType} onChange={set('propertyType')}>
                <option value="residential">{tr('Residential')}</option>
                <option value="commercial">{tr('Commercial')}</option>
                <option value="mixed">{tr('Mixed use')}</option>
                <option value="land">{tr('Land')}</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="pp-gps">GhanaPost GPS</label>
              <input id="pp-gps" className="input" value={form.ghanaPostGps} onChange={set('ghanaPostGps')} placeholder="GT-191-1859" />
            </div>
            <div className="field poki-dialog-span">
              <label htmlFor="pp-address">{tr('Address')}</label>
              <input id="pp-address" className="input" value={form.address} onChange={set('address')} />
            </div>
            <div className="field">
              <label htmlFor="pp-city">{tr('City')}</label>
              <input id="pp-city" className="input" value={form.city} onChange={set('city')} />
            </div>
            <div className="field">
              <label htmlFor="pp-region">{tr('Region')}</label>
              <input id="pp-region" className="input" value={form.region} onChange={set('region')} />
            </div>
            <div className="field poki-dialog-span">
              <label htmlFor="pp-notes">{tr('Notes')}</label>
              <textarea id="pp-notes" className="input" rows={2} value={form.notes} onChange={set('notes')} />
            </div>
            <div className="poki-dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Save')}</button>
            </div>
          </form>
        </div>
      )}

      {dialog === 'unit' && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <form className="dialog poki-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
            <h2 className="poki-dialog-title">{editId ? tr('Edit unit') : tr('Add unit')}</h2>
            {dialogError && <div className="error-banner poki-dialog-span">{dialogError}</div>}
            <div className="field">
              <label htmlFor="pu-property">{tr('Property')}</label>
              <select id="pu-property" className="input" value={form.propertyId} onChange={set('propertyId')} required disabled={!!editId}>
                {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="pu-code">{tr('Unit code')}</label>
              <input id="pu-code" className="input" value={form.code} onChange={set('code')} placeholder={tr('e.g. OF-1, APT-2B')} required />
            </div>
            <div className="field">
              <label htmlFor="pu-name">{tr('Description')}</label>
              <input id="pu-name" className="input" value={form.name} onChange={set('name')} placeholder={tr('e.g. Ground floor office')} />
            </div>
            <div className="field">
              <label htmlFor="pu-type">{tr('Unit type')}</label>
              <select id="pu-type" className="input" value={form.unitType} onChange={set('unitType')}>
                {UNIT_TYPES.map((t) => <option key={t} value={t} style={{ textTransform: 'capitalize' }}>{t}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="pu-floor">{tr('Floor')}</label>
              <input id="pu-floor" className="input" value={form.floor} onChange={set('floor')} placeholder={tr('e.g. Ground, 2nd')} />
            </div>
            <div className="field">
              <label htmlFor="pu-size">{tr('Size (m²)')}</label>
              <input id="pu-size" className="input" type="number" step="0.01" value={form.sizeSqm} onChange={set('sizeSqm')} />
            </div>
            {(form.unitType === 'apartment' || form.unitType === 'room') && (
              <>
                <div className="field">
                  <label htmlFor="pu-bed">{tr('Bedrooms')}</label>
                  <input id="pu-bed" className="input" type="number" value={form.bedrooms} onChange={set('bedrooms')} />
                </div>
                <div className="field">
                  <label htmlFor="pu-bath">{tr('Bathrooms')}</label>
                  <input id="pu-bath" className="input" type="number" value={form.bathrooms} onChange={set('bathrooms')} />
                </div>
              </>
            )}
            <div className="field">
              <label htmlFor="pu-currency">{tr('Currency')}</label>
              <select id="pu-currency" className="input" value={form.currency} onChange={set('currency')}>
                {UNIT_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            {form.currency !== BASE_CURRENCY && (
              <div className="field">
                <label htmlFor="pu-fx">{tr('Your rate — 1 {currency} = ? {base}', { currency: form.currency, base: BASE_CURRENCY })}</label>
                <input
                  id="pu-fx" className="input" type="number" step="0.000001" min="0"
                  value={form.fxRate} onChange={set('fxRate')}
                  placeholder={tr('e.g. 15.50')} required
                />
              </div>
            )}
            <div className="field">
              <label htmlFor="pu-rent">{tr('Asking rent, per month')}</label>
              <input id="pu-rent" className="input" type="number" step="0.01" value={form.baseRent} onChange={set('baseRent')} />
              {equivalent(form.baseRent) && <div className="poki-fx-hint">{equivalent(form.baseRent)}</div>}
            </div>
            <div className="field">
              <label htmlFor="pu-daily">{tr('Rent per day')}</label>
              <input id="pu-daily" className="input" type="number" step="0.01" value={form.dailyRate} onChange={set('dailyRate')} placeholder={tr('optional')} />
              {equivalent(form.dailyRate) && <div className="poki-fx-hint">{equivalent(form.dailyRate)}</div>}
              <p className="poki-dialog-hint">
                {tr('For bookings measured in days. Left blank, a day is charged at a thirtieth of the monthly rate.')}
              </p>
            </div>
            <div className="field poki-dialog-span">
              <label htmlFor="pu-utility">{tr('Utilities')}</label>
              <select id="pu-utility" className="input" value={form.utilityMode} onChange={set('utilityMode')}>
                {UTILITY_MODES.map((m) => <option key={m.value} value={m.value}>{tr(m.label)}</option>)}
              </select>
            </div>
            {form.utilityMode === 'fixed' && (
              <div className="field">
                <label htmlFor="pu-fixed">{tr('Fixed utility charge')}</label>
                <input id="pu-fixed" className="input" type="number" step="0.01" value={form.fixedUtilityAmount} onChange={set('fixedUtilityAmount')} />
              </div>
            )}
            {form.utilityMode === 'apportioned' && (
              <div className="field">
                <label htmlFor="pu-share">{tr('Share of master bill (%)')}</label>
                <input id="pu-share" className="input" type="number" step="0.01" value={form.apportionShare} onChange={set('apportionShare')} />
              </div>
            )}
            {form.utilityMode === 'metered' && (
              <p className="poki-dialog-hint">
                {tr('Add this unit\'s meter(s) and record readings on the Rent & utilities screen — consumption is billed there.')}
              </p>
            )}
            <div className="field poki-dialog-span">
              <label htmlFor="pu-amen">{tr('Amenities')}</label>
              <input id="pu-amen" className="input" value={form.amenities} onChange={set('amenities')} placeholder={tr('e.g. A/C, parking, water tank')} />
            </div>
            {editId && (
              <p className="poki-dialog-hint">
                {tr('Occupancy isn\'t set here — a unit becomes occupied when a booking on it is activated, and frees up when that booking ends.')}
              </p>
            )}
            <div className="poki-dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Save')}</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
