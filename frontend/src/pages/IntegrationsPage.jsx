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

  // Single-step OAuth platforms (one account = one channel, no page-picker
  // step like Meta's) — TikTok, YouTube and Twitch all follow this same
  // "start -> redirect -> land back connected" shape.
  const SINGLE_STEP_PLATFORMS = { tiktok: 'TikTok', youtube: 'YouTube', twitch: 'Twitch' };

  // WhatsApp Business and Google Analytics have no OAuth redirect and no
  // pasted API key at all — both are set up entirely as server env vars
  // (see backend/src/config.js), so there's nothing to click here. Status
  // is read straight off the live server config (see settings.service.js's
  // withLiveConfigState) rather than a DB flag.
  const ENV_CONFIGURED_PLATFORMS = {
    whatsappbusiness: 'Set WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_BUSINESS_ACCOUNT_ID, WHATSAPP_ACCESS_TOKEN and WHATSAPP_VERIFY_TOKEN on the server to enable.',
    googleanalytics: 'Set GA4_PROPERTY_ID, GA4_SERVICE_ACCOUNT_EMAIL and GA4_SERVICE_ACCOUNT_PRIVATE_KEY on the server to enable.'
  };
  async function connectSingleStep(id) {
    setBusyId(id);
    setError(null);
    try {
      const { url } = await api.post('/marketing/oauth/' + id + '/start', {});
      window.location.href = url;
    } catch (err) {
      setError(err.message);
      setBusyId(null);
    }
  }

  async function connectMeta(id) {
    setBusyId(id);
    setError(null);
    try {
      const { url } = await api.post('/marketing/oauth/meta/start', {});
      window.location.href = url;
    } catch (err) {
      setError(err.message);
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
            {ENV_CONFIGURED_PLATFORMS[i.id] ? (
              <p className="integrations-card-note">
                {i.connected ? 'Configured on the server — live and syncing automatically.' : ENV_CONFIGURED_PLATFORMS[i.id]}
              </p>
            ) : SINGLE_STEP_PLATFORMS[i.id] ? (
              <>
                {i.connected && (
                  <div className="field">
                    <label htmlFor={'int-key-' + i.id}>Status</label>
                    <input id={'int-key-' + i.id} className="input" value={i.apiKey || MASK} disabled />
                  </div>
                )}
                {i.connected ? (
                  <button type="button" className="btn btn-secondary integrations-action" disabled={busyId === i.id} onClick={() => disconnect(i)}>Disconnect</button>
                ) : (
                  <button type="button" className="btn btn-primary integrations-action" disabled={busyId === i.id} onClick={() => connectSingleStep(i.id)}>
                    {busyId === i.id ? 'Redirecting…' : 'Connect with ' + SINGLE_STEP_PLATFORMS[i.id]}
                  </button>
                )}
              </>
            ) : (i.id === 'facebook' || i.id === 'instagram') ? (
              <>
                {i.connected && (
                  <div className="field">
                    <label htmlFor={'int-key-' + i.id}>Status</label>
                    <input id={'int-key-' + i.id} className="input" value={i.apiKey || MASK} disabled />
                  </div>
                )}
                {i.connected ? (
                  <button type="button" className="btn btn-secondary integrations-action" disabled={busyId === i.id} onClick={() => disconnect(i)}>Disconnect</button>
                ) : (
                  <button type="button" className="btn btn-primary integrations-action" disabled={busyId === i.id} onClick={() => connectMeta(i.id)}>
                    {busyId === i.id ? 'Redirecting…' : 'Connect with Facebook'}
                  </button>
                )}
                {i.id === 'instagram' && !i.connected && (
                  <p className="integrations-card-note">Connects via your Facebook Page login — you'll pick the Page, and its linked Instagram account (if any) connects automatically.</p>
                )}
              </>
            ) : (
              <>
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
              </>
            )}
          </div>
        ))}
      </div>
      {!integrations.length && <p className="table-empty">No integrations configured.</p>}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
