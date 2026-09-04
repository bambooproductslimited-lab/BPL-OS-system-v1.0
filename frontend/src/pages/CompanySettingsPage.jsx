import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import './CompanySettingsPage.css';

// Ported from Bamboo OS.dc.html's settings screen (screens.settings block).
// Viewing requires only employee.read (the nav gate), but saving requires
// the narrower settings.manage — a real gap in this app's seed (most
// employee.read holders, e.g. hr_manager, don't have settings.manage), so
// the form renders read-only with an explanatory note for anyone without
// it, exactly like the prototype's own settingsLocked/settingsNote.
//
// Deliberate omission: the prototype also shows "Data schema v{{
// schemaVersion }}" next to the leave approval chain — schemaVersion is a
// property of the design tool's own in-memory kernel (this.K.schemaVersion())
// with no equivalent in the real Postgres-backed backend, so it's left out
// rather than inventing a fake version number.
//
// Redesigned lightly: this page is a single settings form with no list of
// entities, so the icon/avatar language doesn't apply directly — the only
// addition is a small building-icon accent on the section header, for
// visual consistency with the rest of the redesigned app.

function BuildingIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="3" width="9" height="18" stroke="currentColor" strokeWidth="1.6" />
      <rect x="14" y="9" width="6" height="12" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 7h1M8 11h1M8 15h1M11 7h1M11 11h1M11 15h1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

const FIELDS = ['companyName', 'shortName', 'country', 'currency', 'workWeek', 'lateAfter'];

export default function CompanySettingsPage() {
  const { can } = useAuth();
  const locked = !can('settings.manage');

  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [saving, setSaving] = useState(false);

  const [currencyDraft, setCurrencyDraft] = useState('');
  const [currencyError, setCurrencyError] = useState(null);
  const [currencySaving, setCurrencySaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const s = await api.get('/settings');
      setSettings(s);
      const f = {};
      FIELDS.forEach((k) => { f[k] = s[k] || ''; });
      setForm(f);
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

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.patch('/settings', form);
      setToast('Company settings saved.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const currencyList = (settings && settings.commercial && settings.commercial.currencies) || ['GHS'];

  async function addCurrency(e) {
    e.preventDefault();
    const code = currencyDraft.trim().toUpperCase();
    if (!code) return;
    if (currencyList.includes(code)) { setCurrencyError('"' + code + '" is already enabled.'); return; }
    setCurrencySaving(true);
    setCurrencyError(null);
    try {
      await api.patch('/settings', { currencies: [...currencyList, code] });
      setCurrencyDraft('');
      await load();
    } catch (err) {
      setCurrencyError(err.message);
    } finally {
      setCurrencySaving(false);
    }
  }

  async function removeCurrency(code) {
    if (currencyList.length <= 1) { setCurrencyError('Keep at least one currency enabled.'); return; }
    setCurrencySaving(true);
    setCurrencyError(null);
    try {
      await api.patch('/settings', { currencies: currencyList.filter((c) => c !== code) });
      await load();
    } catch (err) {
      setCurrencyError(err.message);
    } finally {
      setCurrencySaving(false);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;
  if (!settings) return <div className="error-banner">{error}</div>;

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="cs-header">
        <span className="cs-header-icon"><BuildingIcon /></span>
        <h2 className="cs-header-title">Company profile</h2>
      </div>

      <form className="cs-form" onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="cs-cn">Registered company name</label>
          <input id="cs-cn" className="input" value={form.companyName} disabled={locked} onChange={(e) => setForm({ ...form, companyName: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="cs-sn">Short name</label>
          <input id="cs-sn" className="input" value={form.shortName} disabled={locked} onChange={(e) => setForm({ ...form, shortName: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="cs-cy">Country</label>
          <input id="cs-cy" className="input" value={form.country} disabled={locked} onChange={(e) => setForm({ ...form, country: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="cs-cu">Default currency</label>
          <select id="cs-cu" className="input" value={form.currency} disabled={locked} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
            {currencyList.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <span className="field-hint">Used for P&amp;L, cash flow, balance sheet and tax reports, which only ever total one currency at a time.</span>
        </div>
        <div className="field">
          <label htmlFor="cs-ww">Work week</label>
          <input id="cs-ww" className="input" value={form.workWeek} disabled={locked} onChange={(e) => setForm({ ...form, workWeek: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="cs-la">Counted late after</label>
          <input id="cs-la" className="input" value={form.lateAfter} disabled={locked} onChange={(e) => setForm({ ...form, lateAfter: e.target.value })} placeholder="07:20" />
        </div>
        <div className="cs-form-footer">
          <button className="btn btn-primary" type="submit" disabled={locked || saving}>Save settings</button>
          <span className="cs-note">{locked ? 'Read-only — your role cannot change company settings.' : 'Changes are written to the audit log.'}</span>
        </div>
      </form>

      <div className="cs-header" style={{ marginTop: 32 }}>
        <h2 className="cs-header-title">Enabled currencies</h2>
      </div>
      <p className="field-hint">
        Every quotation, estimate and invoice picks one of these when it's created. Removing a currency here only
        stops it being offered for new documents — existing documents already in that currency are unaffected.
      </p>
      {currencyError && <div className="error-banner" style={{ marginBottom: 12 }}>{currencyError}</div>}
      <div className="cs-currency-list">
        {currencyList.map((c) => (
          <span key={c} className="tag tag-outline cs-currency-chip">
            {c}
            {!locked && (
              <button type="button" className="cs-currency-remove" disabled={currencySaving} onClick={() => removeCurrency(c)} aria-label={'Remove ' + c}>×</button>
            )}
          </span>
        ))}
      </div>
      {!locked && (
        <form className="cs-currency-add" onSubmit={addCurrency}>
          <input
            className="input" style={{ width: 100 }} maxLength={6} placeholder="e.g. NGN"
            value={currencyDraft} onChange={(e) => setCurrencyDraft(e.target.value)}
          />
          <button type="submit" className="btn btn-secondary" disabled={currencySaving || !currencyDraft.trim()}>+ Add currency</button>
        </form>
      )}

      <div className="cs-meta">Leave approval chain: {(settings.leaveApprovalChain || []).join(' → ')}</div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
