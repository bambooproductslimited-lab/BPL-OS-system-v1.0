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

  if (loading) return <div className="eyebrow">Loading…</div>;
  if (!settings) return <div className="error-banner">{error}</div>;

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

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
          <label htmlFor="cs-cu">Currency</label>
          <input id="cs-cu" className="input" value={form.currency} disabled={locked} onChange={(e) => setForm({ ...form, currency: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="cs-ww">Work week</label>
          <input id="cs-ww" className="input" value={form.workWeek} disabled={locked} onChange={(e) => setForm({ ...form, workWeek: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="cs-la">Counted late after</label>
          <input id="cs-la" className="input" value={form.lateAfter} disabled={locked} onChange={(e) => setForm({ ...form, lateAfter: e.target.value })} placeholder="08:15" />
        </div>
        <div className="cs-form-footer">
          <button className="btn btn-primary" type="submit" disabled={locked || saving}>Save settings</button>
          <span className="cs-note">{locked ? 'Read-only — your role cannot change company settings.' : 'Changes are written to the audit log.'}</span>
        </div>
      </form>

      <div className="cs-meta">Leave approval chain: {(settings.leaveApprovalChain || []).join(' → ')}</div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
