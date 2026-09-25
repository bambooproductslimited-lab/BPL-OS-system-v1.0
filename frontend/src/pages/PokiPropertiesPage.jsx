import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import ContactButtons from '../components/ContactButtons';
import RowMenu from '../components/RowMenu';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { Glossary, Hero, Insights, Section, Status, fmtDate, jump } from '../components/DashKit';
import { money } from '../lib/currency';
import { msg, tr } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
import './EmployeesPage.css';
import './ToolRoomPage.css';
import './RestaurantsPage.css';
import './PokiRentals.css';

// Properties and the units inside them. A unit is the thing that actually
// gets let — a flat, a room, an office, a shop, a warehouse bay — so this is
// where the asking rent and the utility arrangement are set. Same "explains
// itself" layout as the dashboards (components/DashKit.jsx): the key numbers
// (properties, how much is let, what stands empty and the rent it would
// bring, what is held back), what stands out (units empty a long time, a
// property with nothing let, units with no rent set), the properties as
// cards with their occupancy, and the units as cards or a list. A unit
// opens with who is in it, when that ends, and every booking it has had.
// Occupancy is never set by hand: it follows the unit's bookings
// (poki.service.js). A unit can be held back — reserved, under maintenance,
// unavailable — when nobody is in it.

const UNIT_TYPES = ['apartment', 'room', 'office', 'shop', 'warehouse', 'land', 'other'];
const PROPERTY_TYPES = [{ key: 'residential', label: msg('Residential') }, { key: 'commercial', label: msg('Commercial') }, { key: 'mixed', label: msg('Mixed use') }, { key: 'land', label: msg('Land') }];
const HOLD = [{ key: 'reserved', label: msg('Reserved') }, { key: 'maintenance', label: msg('Maintenance') }, { key: 'unavailable', label: msg('Unavailable') }];
// The company keeps its books in GHS. A unit let in USD stores its rent in
// USD; fxRate says what one USD is worth in GHS, shown beside the amount.
const BASE_CURRENCY = 'GHS';
const UNIT_CURRENCIES = ['GHS', 'USD', 'EUR', 'GBP', 'CNY'];
// Exactly what the backend accepts (V.oneOf in poki.service.js).
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

function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch { /* remembered for this visit only */ } }
function daysSince(iso) {
  if (!iso) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((t - new Date(String(iso).slice(0, 10) + 'T00:00')) / 86400000);
}
function isHeld(u) { return u.status === 'reserved' || u.status === 'maintenance' || u.status === 'unavailable'; }
function emptyDays(u) { return u.status === 'vacant' ? daysSince(u.lastLetEnd || u.createdAt) : null; }
function unitState(u) {
  if (u.status === 'occupied') {
    const left = -daysSince(u.bookingEnd);
    return { tone: left <= 30 ? 'warn' : 'good', text: left <= 30 ? tr('Let · ends in {n} days', { n: Math.max(0, left) }) : tr('Let until {date}', { date: fmtDate(u.bookingEnd) }) };
  }
  if (isHeld(u)) return { tone: 'muted', text: codeLabel(u.status) };
  if (u.nextBookingStart) return { tone: 'info', text: tr('Empty · booked from {date}', { date: fmtDate(u.nextBookingStart) }) };
  const d = emptyDays(u);
  if (!u.lastLetEnd) return { tone: 'muted', text: tr('Empty · never let') };
  return { tone: d >= 60 ? 'bad' : d >= 30 ? 'warn' : 'muted', text: d === 1 ? tr('Empty 1 day') : tr('Empty {n} days', { n: d }) };
}
function specs(u) {
  return [codeLabel(u.unitType), u.bedrooms ? (u.bedrooms === 1 ? tr('1 bed') : tr('{n} beds', { n: u.bedrooms })) : null, u.sizeSqm ? u.sizeSqm + ' m²' : null, u.floor ? tr('floor {f}', { f: u.floor }) : null].filter(Boolean).join(' · ');
}
function utilityText(u) {
  if (u.utilityMode === 'metered') return tr('Sub-metered');
  if (u.utilityMode === 'fixed') return tr('Fixed {amount}', { amount: money(u.fixedUtilityAmount, u.currency) });
  if (u.utilityMode === 'apportioned') return tr('{apportionShare}% of master bill', { apportionShare: u.apportionShare });
  return tr('Direct to provider');
}

export default function PokiPropertiesPage() {
  const { can } = useAuth();
  const canManage = can('poki.manage');
  const navigate = useNavigate();

  const [properties, setProperties] = useState([]);
  const [units, setUnits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [search, setSearch] = useState('');
  const [propertyFilter, setPropertyFilter] = useState('');
  const [chip, setChip] = useState('all');
  const [view, setView] = useState(() => readPref('bos.pokiUnitsView', 'cards'));
  const [showArchived, setShowArchived] = useState(false);

  const [dialog, setDialog] = useState(null); // 'property' | 'unit'
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_PROPERTY);
  const [dialogError, setDialogError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState(null); // unit id
  const [history, setHistory] = useState(null);

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
  useEffect(() => {
    setHistory(null);
    if (!detail) return;
    api.get('/poki/bookings?unitId=' + detail).then(setHistory).catch(() => setHistory([]));
  }, [detail]);

  const liveUnits = useMemo(() => units.filter((u) => u.active !== false), [units]);

  // "= GHS 7,750.00" under an amount, when the unit is let in another currency
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
  function openUnit(u, propertyId) {
    setDialogError(null);
    setEditId(u ? u.id : null);
    setForm(u
      ? { ...EMPTY_UNIT, ...u, sizeSqm: u.sizeSqm || '', baseRent: u.baseRent || '', bedrooms: u.bedrooms || '', bathrooms: u.bathrooms || '', dailyRate: u.dailyRate || '',
          fxRate: u.currency && u.currency !== BASE_CURRENCY ? (u.fxRate || '') : '' }
      : { ...EMPTY_UNIT, propertyId: propertyId || propertyFilter || (properties[0] && properties[0].id) || '' });
    setDetail(null);
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
  async function act(fn, ok) {
    try { await fn(); if (ok) setToast(ok); await load(); } catch (err) { setError(err.message); }
  }
  function removeUnit(u) {
    if (!window.confirm(tr('Delete unit {code}? This cannot be undone.', { code: u.code }))) return;
    setDetail(null);
    act(() => api.del('/poki/units/' + u.id), tr('Unit deleted.'));
  }
  function removeProperty(p) {
    if (!window.confirm(tr('Delete property {name}? This cannot be undone.', { name: p.name }))) return;
    act(() => api.del('/poki/properties/' + p.id), tr('Property deleted.'));
  }
  function showProperty(id) { setPropertyFilter(id); setChip('all'); jump('pk-units'); }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  // ── what the page shows ────────────────────────────────────────────
  const activeProps = properties.filter((p) => p.status !== 'archived');
  const let_ = liveUnits.filter((u) => u.status === 'occupied');
  const empty = liveUnits.filter((u) => u.status === 'vacant');
  const held = liveUnits.filter(isHeld);
  const longEmpty = empty.filter((u) => !u.nextBookingStart && emptyDays(u) >= 30).sort((x, y) => emptyDays(y) - emptyDays(x));
  const noRent = liveUnits.filter((u) => !u.baseRent);
  const endingSoon = let_.filter((u) => -daysSince(u.bookingEnd) <= 30);
  const emptyRent = empty.reduce((m, u) => { m[u.currency] = (m[u.currency] || 0) + u.baseRent; return m; }, {});
  const emptyRentText = Object.entries(emptyRent).filter(([, a]) => a).map(([c, a]) => money(a, c)).join(' · ');
  const nothingLet = activeProps.filter((p) => p.unitCount > 0 && p.occupiedCount === 0);
  const pct = liveUnits.length ? Math.round((let_.length / liveUnits.length) * 100) : 0;

  function showOnly(key) { setChip(chip === key ? 'all' : key); jump('pk-units'); }
  const stats = [
    { icon: 'drawer', value: String(activeProps.length), label: activeProps.length === 1 ? tr('property') : tr('properties'), note: liveUnits.length === 1 ? tr('1 unit') : tr('{n} units', { n: liveUnits.length }), onClick: () => jump('pk-props') },
    { icon: 'check', value: pct + '%', label: tr('of units let'), note: tr('{occupied} of {total} units let', { occupied: let_.length, total: liveUnits.length }), tone: pct >= 90 ? 'good' : '', onClick: () => showOnly('let') },
    { icon: 'warn', value: String(empty.length), label: tr('units empty'), note: emptyRentText ? tr('{rent} a month not coming in', { rent: emptyRentText }) : tr('nothing empty'), tone: longEmpty.length ? 'alert' : '', onClick: () => showOnly('empty') },
    { icon: 'clock', value: String(held.length), label: tr('held back'), note: tr('reserved, maintenance or unavailable'), onClick: () => showOnly('held') }
  ];

  const insights = [];
  if (longEmpty.length) insights.push({ tone: 'warn', icon: 'drawer', text: longEmpty.length === 1 ? tr('{unit} at {property} has stood empty for {days} days — {rent} a month not coming in.', { unit: longEmpty[0].code, property: longEmpty[0].propertyName, days: emptyDays(longEmpty[0]), rent: money(longEmpty[0].baseRent, longEmpty[0].currency) }) : tr('{n} units have stood empty for over a month — {rent} a month not coming in.', { n: longEmpty.length, rent: emptyRentText }), action: canManage ? { label: tr('Make a letting offer'), run: () => navigate('/pokiestimates') } : { label: tr('Show them'), run: () => showOnly('empty') } });
  if (endingSoon.length) insights.push({ tone: 'info', icon: 'calendar', text: endingSoon.length === 1 ? tr('{unit}: {tenant}\'s booking ends {date}.', { unit: endingSoon[0].code, tenant: endingSoon[0].tenantName, date: fmtDate(endingSoon[0].bookingEnd) }) : tr('{n} units come free in the next 30 days.', { n: endingSoon.length }), action: { label: tr('Show them'), run: () => showOnly('ending') } });
  if (nothingLet.length) insights.push({ tone: 'warn', icon: 'warn', text: nothingLet.length === 1 ? tr('Nothing at {property} is let.', { property: nothingLet[0].name }) : tr('{n} properties have nothing let.', { n: nothingLet.length }), action: { label: tr('Show it'), run: () => showProperty(nothingLet[0].id) } });
  if (noRent.length) insights.push({ tone: 'info', icon: 'cash', text: noRent.length === 1 ? tr('{unit} has no asking rent set, so a booking on it would be priced at nothing.', { unit: noRent[0].code }) : tr('{n} units have no asking rent set.', { n: noRent.length }), action: canManage && noRent.length === 1 ? { label: tr('Set it'), run: () => openUnit(noRent[0]) } : { label: tr('Show them'), run: () => showOnly('norent') } });
  if (!insights.length && liveUnits.length) insights.push({ tone: 'good', icon: 'check', text: tr('Everything that can be let is let, and nothing ends in the next month.') });

  const chipTest = {
    all: () => true, let: (u) => u.status === 'occupied', empty: (u) => u.status === 'vacant', held: isHeld,
    ending: (u) => endingSoon.includes(u), norent: (u) => !u.baseRent
  };
  const visible = liveUnits.filter(chipTest[chip] || chipTest.all)
    .filter((u) => !propertyFilter || u.propertyId === propertyFilter)
    .filter((u) => matchesQuery(search, u.code, u.name, u.propertyName, u.tenantName, u.amenities));
  const chips = [
    ['all', tr('All'), liveUnits.length], ['let', tr('Let'), let_.length], ['empty', tr('Empty'), empty.length],
    ['ending', tr('Coming free'), endingSoon.length], ['held', tr('Held back'), held.length], ['norent', tr('No rent set'), noRent.length]
  ].filter(([k, , c]) => c > 0 || k === 'all' || k === chip);

  function unitActions(u) {
    return [
      { label: tr('Open'), onClick: () => setDetail(u.id) },
      canManage && { label: tr('Edit'), onClick: () => openUnit(u) },
      canManage && u.status === 'vacant' && { label: tr('Hold back (maintenance)'), onClick: () => act(() => api.patch('/poki/units/' + u.id, { status: 'maintenance' }), tr('{code} held back.', { code: u.code })) },
      canManage && isHeld(u) && { label: tr('Make available to let'), onClick: () => act(() => api.patch('/poki/units/' + u.id, { status: 'vacant' }), tr('{code} is available to let.', { code: u.code })) },
      canManage && !u.bookingId && { label: tr('Delete'), onClick: () => removeUnit(u), danger: true }
    ].filter(Boolean);
  }

  const cur = detail ? units.find((u) => u.id === detail) : null;
  const shownProps = showArchived ? properties : activeProps;

  return (
    <div className="dk tl pk">
      {error && <div className="error-banner" role="alert">{error}</div>}

      <Hero
        eyebrow={tr('Poki Rentals')}
        title={tr('Properties & units')}
        sub={tr('Every building and the units in it that are let: who is in each one, when that ends, what stands empty and what it would bring in. Press a number to show only those.')}
        actions={canManage && (
          <>
            <button type="button" className="btn btn-primary" disabled={!properties.length} onClick={() => openUnit(null)}>{tr('Add unit')}</button>
            <button type="button" className="btn btn-secondary" onClick={() => openProperty(null)}>{tr('Add property')}</button>
          </>
        )}
        stats={stats} />

      <Insights items={insights.slice(0, 5)} />

      <Section id="pk-props" title={tr('Properties')} sub={tr('Press a property to see its units.')}
        action={properties.length > activeProps.length && (
          <label className="checkbox-field"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> {tr('Show archived')}</label>
        )}>
        {!properties.length ? (
          <div className="dk-empty tl-empty">
            <p>{tr('Start with a property (the building or site), then add the units inside it that you actually let.')}</p>
            {canManage && <button type="button" className="btn btn-primary" onClick={() => openProperty(null)}>{tr('Add property')}</button>}
          </div>
        ) : (
          <div className="tl-grid">
            {shownProps.map((p) => {
              const occ = p.unitCount ? Math.round((p.occupiedCount / p.unitCount) * 100) : 0;
              return (
                <article key={p.id} className={'tl-card' + (p.status === 'archived' ? ' st-retired' : '') + (propertyFilter === p.id ? ' pk-picked' : '')}>
                  <button type="button" className="tl-card-open" onClick={() => showProperty(p.id)}>
                    <span className={'tl-badge pk-prop is-' + p.propertyType} style={{ width: 44, height: 44 }} aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20V9l8-5 8 5v11M9 20v-6h6v6M3 20h18" /></svg>
                    </span>
                    <span className="tl-card-head">
                      <span className="dk-muted tl-small">{p.code} · {tr((PROPERTY_TYPES.find((t) => t.key === p.propertyType) || PROPERTY_TYPES[2]).label)}{p.city ? ' · ' + p.city : ''}</span>
                      <span className="tl-name">{p.name}</span>
                    </span>
                  </button>
                  {canManage && <span className="tl-menu"><RowMenu actions={[
                    { label: tr('Add a unit here'), onClick: () => openUnit(null, p.id) },
                    { label: tr('Edit property'), onClick: () => openProperty(p) },
                    p.status === 'archived'
                      ? { label: tr('Bring back'), onClick: () => act(() => api.patch('/poki/properties/' + p.id, { status: 'active' }), tr('Property updated.')) }
                      : { label: tr('Archive'), onClick: () => act(() => api.patch('/poki/properties/' + p.id, { status: 'archived' }), tr('Property archived.')) },
                    { label: tr('Delete'), onClick: () => removeProperty(p), danger: true }
                  ]} /></span>}
                  <span className="tl-stock">
                    <span className="tl-stock-row"><strong>{p.unitCount ? tr('{occupied} of {total} let', { occupied: p.occupiedCount, total: p.unitCount }) : tr('No units yet')}</strong>{p.unitCount > 0 && <span className="dk-muted">{occ}%</span>}</span>
                    <span className="tl-stock-bar" aria-hidden="true"><span style={{ width: occ + '%' }} /></span>
                  </span>
                  <div className="tl-foot">
                    <span className="dk-muted tl-small">{p.vacantCount ? (p.vacantCount === 1 ? tr('1 empty') : tr('{n} empty', { n: p.vacantCount })) : p.unitCount ? tr('full') : ''}{p.address ? ' · ' + p.address : ''}</span>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </Section>

      {properties.length > 0 && (
        <Section id="pk-units" title={tr('Units')} sub={tr('Press a unit for who is in it and every booking it has had.')}
          action={(
            <div className="ppl-view" role="radiogroup" aria-label={tr('View')}>
              {[['cards', tr('Cards')], ['list', tr('List')]].map(([k, label]) => (
                <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? 'is-on' : ''} onClick={() => { setView(k); writePref('bos.pokiUnitsView', k); }}>{label}</button>
              ))}
            </div>
          )}>
          <div className="tl-tools">
            <div className="tl-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search units, tenants…')} /></div>
            <select className="input tl-select" value={propertyFilter} onChange={(e) => setPropertyFilter(e.target.value)} aria-label={tr('Filter by property')}>
              <option value="">{tr('All properties')}</option>
              {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="ppl-chips" role="radiogroup" aria-label={tr('Show')}>
            {chips.map(([key, label, c]) => (
              <button key={key} type="button" role="radio" aria-checked={chip === key} className={'ppl-chip' + (chip === key ? ' is-on' : '')} onClick={() => setChip(key)}>
                {label} <span className="ppl-chip-n">{c}</span>
              </button>
            ))}
          </div>
          {!visible.length ? (
            <div className="dk-empty tl-empty"><p>{tr('No units match')} — {tr('Adjust the filters, or add a unit to this property.')}</p></div>
          ) : view === 'cards' ? (
            <div className="tl-grid">
              {visible.map((u) => {
                const st = unitState(u);
                return (
                  <article key={u.id} className={'tl-card' + (st.tone === 'bad' ? ' st-late' : st.tone === 'warn' ? ' st-low' : '')}>
                    <button type="button" className="tl-card-open" onClick={() => setDetail(u.id)}>
                      <span className={'pk-unit-code' + (u.status === 'occupied' ? ' is-let' : '')}>{u.code}</span>
                      <span className="tl-card-head">
                        <span className="dk-muted tl-small">{u.propertyName}</span>
                        <span className="tl-name">{u.name || codeLabel(u.unitType)}</span>
                      </span>
                    </button>
                    <span className="tl-menu"><RowMenu actions={unitActions(u)} /></span>
                    <div className="tl-tags">
                      <Status tone={st.tone}>{st.text}</Status>
                      {u.openRequests > 0 && <Status tone="warn">{u.openRequests === 1 ? tr('1 repair open') : tr('{n} repairs open', { n: u.openRequests })}</Status>}
                    </div>
                    {u.status === 'occupied'
                      ? <div className="tl-who"><span className="tl-place" aria-hidden="true">☺</span><span>{u.tenantName}</span></div>
                      : <div className="tl-who dk-muted"><span>{specs(u)}</span></div>}
                    <div className="tl-foot">
                      <span className="tl-small"><strong>{money(u.status === 'occupied' && u.bookingMonthly ? u.bookingMonthly : u.baseRent, u.currency)}</strong> <span className="dk-muted">{tr('per month')}</span>
                        {u.currency !== BASE_CURRENCY && Number(u.fxRate) > 0 && <span className="dk-muted"> · = {money((u.status === 'occupied' && u.bookingMonthly ? u.bookingMonthly : u.baseRent) * u.fxRate, BASE_CURRENCY)}</span>}
                      </span>
                      {canManage && u.status === 'vacant' && !u.nextBookingStart && <Link className="btn btn-secondary tl-btn" to={'/pokibookings?unit=' + u.id}>{tr('Book it')}</Link>}
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="tl-table-wrap">
              <table className="tl-table">
                <thead><tr><th>{tr('Unit')}</th><th>{tr('Status')}</th><th>{tr('Tenant')}</th><th className="is-num">{tr('Rent')}</th><th>{tr('Utilities')}</th><th /></tr></thead>
                <tbody>
                  {visible.map((u) => {
                    const st = unitState(u);
                    return (
                      <tr key={u.id}>
                        <td><button type="button" className="tl-row-open" onClick={() => setDetail(u.id)}><span className={'pk-unit-code is-small' + (u.status === 'occupied' ? ' is-let' : '')}>{u.code}</span><span><span className="tl-name">{u.name || codeLabel(u.unitType)}</span><span className="dk-muted tl-small">{u.propertyName}</span></span></button></td>
                        <td><Status tone={st.tone}>{st.text}</Status></td>
                        <td>{u.tenantName || <span className="dk-muted">—</span>}</td>
                        <td className="is-num">{money(u.baseRent, u.currency)}{u.currency !== BASE_CURRENCY && Number(u.fxRate) > 0 && <div className="dk-muted tl-small">= {money(u.baseRent * u.fxRate, BASE_CURRENCY)}</div>}</td>
                        <td className="dk-muted">{utilityText(u)}</td>
                        <td className="tl-menu-cell"><RowMenu actions={unitActions(u)} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      <Glossary items={[
        [tr('Let'), tr('A booking on the unit is running. Occupancy follows the booking; it is never set by hand.')],
        [tr('Empty for'), tr('Days since the last booking on the unit ended, or since the unit was added if it was never let.')],
        [tr('Held back'), tr('Not offered for letting for now: reserved, under maintenance or unavailable. Only a unit nobody is in can be held back.')],
        [tr('Asking rent'), tr('The monthly rent a new booking starts from. A booking can agree a different rate.')],
        [tr('Utilities'), tr('How water and power are charged: paid by the tenant to the provider, read off a sub-meter, a fixed charge, or a share of the building\'s bill.')]
      ]} />

      {/* ── one unit ── */}
      {cur && (
        <div className="dialog-backdrop" onClick={() => setDetail(null)}>
          <div className="dialog tl-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="tl-detail-head">
              <span className={'pk-unit-code is-big' + (cur.status === 'occupied' ? ' is-let' : '')}>{cur.code}</span>
              <div>
                <span className="dk-muted tl-small">{cur.propertyName} · {specs(cur)}</span>
                <h2>{cur.name || codeLabel(cur.unitType)}</h2>
                <div className="tl-tags"><Status tone={unitState(cur).tone}>{unitState(cur).text}</Status>{cur.openRequests > 0 && <Status tone="warn">{cur.openRequests === 1 ? tr('1 repair open') : tr('{n} repairs open', { n: cur.openRequests })}</Status>}</div>
              </div>
              <button type="button" className="tl-close" onClick={() => setDetail(null)} aria-label={tr('Close')}>×</button>
            </div>
            {cur.status === 'occupied' && (
              <div className="tl-holder is-inline">
                <div className="tl-holder-head">
                  <span className="tl-holder-name">
                    <strong>{cur.tenantName}</strong>
                    <span className="dk-muted tl-small">{cur.bookingNo} · {tr('until {date}', { date: fmtDate(cur.bookingEnd) })}{cur.bookingMonthly ? ' · ' + tr('{amount} a month', { amount: money(cur.bookingMonthly, cur.currency) }) : ''}</span>
                  </span>
                  <ContactButtons name={cur.tenantName} phone={cur.tenantPhone} email={cur.tenantEmail} />
                </div>
              </div>
            )}
            <dl className="tl-facts">
              <div><dt>{tr('Asking rent, per month')}</dt><dd>{money(cur.baseRent, cur.currency)}{cur.currency !== BASE_CURRENCY && Number(cur.fxRate) > 0 ? ' · = ' + money(cur.baseRent * cur.fxRate, BASE_CURRENCY) : ''}</dd></div>
              <div><dt>{tr('Rent per day')}</dt><dd>{cur.dailyRate ? money(cur.dailyRate, cur.currency) : tr('a thirtieth of the month')}</dd></div>
              <div><dt>{tr('Utilities')}</dt><dd>{utilityText(cur)}</dd></div>
              {cur.amenities && <div><dt>{tr('Amenities')}</dt><dd>{cur.amenities}</dd></div>}
              {cur.lastLetEnd && <div><dt>{tr('Last let until')}</dt><dd>{fmtDate(cur.lastLetEnd)}</dd></div>}
              {cur.nextBookingStart && <div><dt>{tr('Next booking from')}</dt><dd>{fmtDate(cur.nextBookingStart)}</dd></div>}
            </dl>
            {cur.notes && <p className="tl-notes">{cur.notes}</p>}
            <h3 className="tl-h3">{tr('Bookings')}</h3>
            {history === null ? <p className="dk-muted tl-small">{tr('Loading…')}</p> : history.length ? (
              <ul className="pk-list">
                {history.map((b) => (
                  <li key={b.id}>
                    <span className="pk-list-main"><strong>{b.tenantName}</strong><span className="dk-muted tl-small">{b.bookingNo} · {fmtDate(b.startDate)} – {fmtDate(b.endDate)} · {b.durationLabel}</span></span>
                    <span className="pk-list-side"><strong>{money(b.rentTotal, b.currency)}</strong><Status tone={b.status === 'active' ? 'good' : b.status === 'draft' ? 'info' : 'muted'}>{codeLabel(b.status)}</Status></span>
                  </li>
                ))}
              </ul>
            ) : <p className="dk-muted tl-small">{tr('Never booked.')}</p>}
            <div className="dialog-actions tl-actions">
              {canManage && !cur.bookingId && <button type="button" className="btn btn-secondary" onClick={() => removeUnit(cur)}>{tr('Delete')}</button>}
              {canManage && <button type="button" className="btn btn-secondary" onClick={() => openUnit(cur)}>{tr('Edit')}</button>}
              {canManage && cur.status === 'vacant' && <Link className="btn btn-primary" to={'/pokibookings?unit=' + cur.id}>{tr('Book it')}</Link>}
              {(!canManage || cur.status !== 'vacant') && <button type="button" className="btn btn-primary" onClick={() => setDetail(null)}>{tr('Close')}</button>}
            </div>
          </div>
        </div>
      )}

      {/* ── property ── */}
      {dialog === 'property' && (
        <div className="dialog-backdrop" onClick={() => !saving && setDialog(null)}>
          <form className="dialog tl-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
            <h2>{editId ? tr('Edit property') : tr('Add property')}</h2>
            <div className="tl-form">
              <div className="field">
                <label htmlFor="pp-code">{tr('Code')}</label>
                <input id="pp-code" className="input" maxLength={40} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder={tr('e.g. PH')} required disabled={!!editId} />
              </div>
              <div className="field">
                <label htmlFor="pp-name">{tr('Name')}</label>
                <input id="pp-name" className="input" maxLength={160} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={tr('e.g. Poki House')} required />
              </div>
              <div className="field tl-span">
                <span className="tl-label">{tr('Type')}</span>
                <div className="tl-seg" role="radiogroup" aria-label={tr('Type')}>
                  {PROPERTY_TYPES.map((t) => <button key={t.key} type="button" role="radio" aria-checked={form.propertyType === t.key} className={'tl-seg-btn' + (form.propertyType === t.key ? ' is-on' : '')} onClick={() => setForm({ ...form, propertyType: t.key })}>{tr(t.label)}</button>)}
                </div>
              </div>
              <div className="field tl-span">
                <label htmlFor="pp-address">{tr('Address')}</label>
                <input id="pp-address" className="input" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="pp-city">{tr('City')}</label>
                <input id="pp-city" className="input" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="pp-region">{tr('Region')}</label>
                <input id="pp-region" className="input" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="pp-gps">GhanaPost GPS</label>
                <input id="pp-gps" className="input" value={form.ghanaPostGps} onChange={(e) => setForm({ ...form, ghanaPostGps: e.target.value })} placeholder="GT-191-1859" />
              </div>
              <div className="field tl-span">
                <label htmlFor="pp-notes">{tr('Notes (optional)')}</label>
                <textarea id="pp-notes" className="input tl-textarea" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </div>
            </div>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Save')}</button>
            </div>
          </form>
        </div>
      )}

      {/* ── unit ── */}
      {dialog === 'unit' && (
        <div className="dialog-backdrop" onClick={() => !saving && setDialog(null)}>
          <form className="dialog tl-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
            <h2>{editId ? tr('Edit unit') : tr('Add unit')}</h2>
            <div className="tl-form">
              <div className="field">
                <label htmlFor="pu-property">{tr('Property')}</label>
                <select id="pu-property" className="input" value={form.propertyId} onChange={(e) => setForm({ ...form, propertyId: e.target.value })} required disabled={!!editId}>
                  {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="pu-code">{tr('Unit code')}</label>
                <input id="pu-code" className="input" maxLength={40} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder={tr('e.g. OF-1, APT-2B')} required />
              </div>
              <div className="field tl-span">
                <label htmlFor="pu-name">{tr('Description')}</label>
                <input id="pu-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={tr('e.g. Ground floor office')} />
              </div>
              <div className="field">
                <label htmlFor="pu-type">{tr('Unit type')}</label>
                <select id="pu-type" className="input" value={form.unitType} onChange={(e) => setForm({ ...form, unitType: e.target.value })}>
                  {UNIT_TYPES.map((t) => <option key={t} value={t}>{codeLabel(t)}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="pu-floor">{tr('Floor')}</label>
                <input id="pu-floor" className="input" value={form.floor} onChange={(e) => setForm({ ...form, floor: e.target.value })} placeholder={tr('e.g. Ground, 2nd')} />
              </div>
              <div className="field">
                <label htmlFor="pu-size">{tr('Size (m²)')}</label>
                <input id="pu-size" className="input" type="number" min="0" step="0.01" value={form.sizeSqm} onChange={(e) => setForm({ ...form, sizeSqm: e.target.value })} />
              </div>
              {(form.unitType === 'apartment' || form.unitType === 'room') && (
                <>
                  <div className="field">
                    <label htmlFor="pu-bed">{tr('Bedrooms')}</label>
                    <input id="pu-bed" className="input" type="number" min="0" value={form.bedrooms} onChange={(e) => setForm({ ...form, bedrooms: e.target.value })} />
                  </div>
                  <div className="field">
                    <label htmlFor="pu-bath">{tr('Bathrooms')}</label>
                    <input id="pu-bath" className="input" type="number" min="0" value={form.bathrooms} onChange={(e) => setForm({ ...form, bathrooms: e.target.value })} />
                  </div>
                </>
              )}
              <div className="field">
                <label htmlFor="pu-currency">{tr('Currency')}</label>
                <select id="pu-currency" className="input" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                  {UNIT_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              {form.currency !== BASE_CURRENCY && (
                <div className="field">
                  <label htmlFor="pu-fx">{tr('Your rate — 1 {currency} = ? {base}', { currency: form.currency, base: BASE_CURRENCY })}</label>
                  <input id="pu-fx" className="input" type="number" step="0.000001" min="0" value={form.fxRate} onChange={(e) => setForm({ ...form, fxRate: e.target.value })} placeholder={tr('e.g. 15.50')} required />
                </div>
              )}
              <div className="field">
                <label htmlFor="pu-rent">{tr('Asking rent, per month')}</label>
                <input id="pu-rent" className="input" type="number" min="0" step="0.01" value={form.baseRent} onChange={(e) => setForm({ ...form, baseRent: e.target.value })} />
                {equivalent(form.baseRent) && <span className="dk-muted tl-small">{equivalent(form.baseRent)}</span>}
              </div>
              <div className="field">
                <label htmlFor="pu-daily">{tr('Rent per day')}</label>
                <input id="pu-daily" className="input" type="number" min="0" step="0.01" value={form.dailyRate} onChange={(e) => setForm({ ...form, dailyRate: e.target.value })} placeholder={tr('optional')} />
                <span className="dk-muted tl-small">{equivalent(form.dailyRate) || tr('For bookings measured in days. Left blank, a day is charged at a thirtieth of the monthly rate.')}</span>
              </div>
              <div className="field tl-span">
                <label htmlFor="pu-utility">{tr('Utilities')}</label>
                <select id="pu-utility" className="input" value={form.utilityMode} onChange={(e) => setForm({ ...form, utilityMode: e.target.value })}>
                  {UTILITY_MODES.map((m) => <option key={m.value} value={m.value}>{tr(m.label)}</option>)}
                </select>
                {form.utilityMode === 'metered' && <span className="dk-muted tl-small">{tr('Add this unit\'s meter(s) and record readings on the Rent & utilities screen — consumption is billed there.')}</span>}
              </div>
              {form.utilityMode === 'fixed' && (
                <div className="field">
                  <label htmlFor="pu-fixed">{tr('Fixed utility charge')}</label>
                  <input id="pu-fixed" className="input" type="number" min="0" step="0.01" value={form.fixedUtilityAmount} onChange={(e) => setForm({ ...form, fixedUtilityAmount: e.target.value })} />
                </div>
              )}
              {form.utilityMode === 'apportioned' && (
                <div className="field">
                  <label htmlFor="pu-share">{tr('Share of master bill (%)')}</label>
                  <input id="pu-share" className="input" type="number" min="0" step="0.01" value={form.apportionShare} onChange={(e) => setForm({ ...form, apportionShare: e.target.value })} />
                </div>
              )}
              <div className="field tl-span">
                <label htmlFor="pu-amen">{tr('Amenities')}</label>
                <input id="pu-amen" className="input" value={form.amenities} onChange={(e) => setForm({ ...form, amenities: e.target.value })} placeholder={tr('e.g. A/C, parking, water tank')} />
              </div>
              <div className="field tl-span">
                <label htmlFor="pu-notes">{tr('Notes (optional)')}</label>
                <textarea id="pu-notes" className="input tl-textarea" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </div>
              {editId && <p className="dk-muted tl-small tl-span">{tr('Occupancy isn\'t set here — a unit becomes occupied when a booking on it is activated, and frees up when that booking ends.')}</p>}
            </div>
            {dialogError && <div className="error-banner">{dialogError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? tr('Saving…') : tr('Save')}</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
