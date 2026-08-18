import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import './IntegrationsPage.css';

// Ported from Bamboo OS.dc.html's integrations screen (screens.integrations
// block + the integrations computed value), backed by
// GET/POST /api/settings/integrations. All three endpoints require
// settings.manage, same as the nav gate, so there's no read-only viewer
// case here to handle.
//
// Once connected, the API key field always shows a masked placeholder
// rather than the real stored key — matching the prototype's own
// keyValue: i.connected ? '••••••••••••' : draft, which never re-displays
// a secret once it's been saved, even though the backend's response does
// technically include the real value.

const MASK = '••••••••••••';

export default function IntegrationsPage() {
  const [integrations, setIntegrations] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setIntegrations(await api.get('/settings/integrations'));
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

  async function connect(item) {
    const key = (drafts[item.id] || '').trim();
    if (!key) {
      setToast('Enter an API key first.');
      return;
    }
    setBusyId(item.id);
    setError(null);
    try {
      const updated = await api.post('/settings/integrations/' + item.id + '/connect', { apiKey: key });
      setToast(updated.name + ' connected.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function disconnect(item) {
    setBusyId(item.id);
    setError(null);
    try {
      const updated = await api.post('/settings/integrations/' + item.id + '/disconnect', {});
      setToast(updated.name + ' disconnected.');
      setDrafts({ ...drafts, [item.id]: '' });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}
      <p className="integrations-intro">
        Store credentials for third-party systems here. This links them to Bamboo OS's data model
        (e.g. TimeStation clock events into Attendance, Square payments into Invoices) — going live
        with real syncing requires the backend integration itself, not just a connected key here.
      </p>

      <div className="integrations-grid">
        {integrations.map((i) => (
          <div key={i.id} className="integrations-card">
            <div className="integrations-card-top">
              <div>
                <div className="integrations-card-name">{i.name}</div>
                <div className="integrations-card-category">{i.category}</div>
              </div>
              <span className={'tag ' + (i.connected ? 'tag-neutral' : 'tag-outline')}>{i.connected ? 'Connected' : 'Not connected'}</span>
            </div>
            <p className="integrations-card-desc">{i.description}</p>
            <div className="field">
              <label htmlFor={'int-key-' + i.id}>API key</label>
              <input
                id={'int-key-' + i.id}
                className="input"
                value={i.connected ? MASK : (drafts[i.id] || '')}
                disabled={i.connected}
                onChange={(e) => setDrafts({ ...drafts, [i.id]: e.target.value })}
                placeholder="Paste API key"
              />
            </div>
            {i.connected ? (
              <button type="button" className="btn btn-secondary integrations-action" disabled={busyId === i.id} onClick={() => disconnect(i)}>Disconnect</button>
            ) : (
              <button type="button" className="btn btn-primary integrations-action" disabled={busyId === i.id} onClick={() => connect(i)}>Connect</button>
            )}
          </div>
        ))}
      </div>
      {!integrations.length && <p className="table-empty">No integrations configured.</p>}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
