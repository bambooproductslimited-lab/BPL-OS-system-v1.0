import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import './SocialTrackerPage.css';

// Metricool-style social & campaign tracker: channels (Facebook, Instagram,
// TikTok, WhatsApp Business, Website, ThomasNet), campaigns, a content
// calendar of posts with their engagement numbers, and follower/traffic
// snapshots per channel for a growth trend. Everything is manually logged —
// a channel's "Connected" badge only means an API key is stored on the
// Integrations screen (settings.manage), same as this app's other
// integrations (Square, Slack, QuickBooks); pulling live numbers from each
// platform's API is a separate backend build per platform once real
// developer app approval exists for it.

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'calendar', label: 'Content calendar' },
  { key: 'campaigns', label: 'Campaigns' },
  { key: 'channels', label: 'Channels' }
];

const POST_STATUSES = [
  { value: 'planned', label: 'Planned' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'published', label: 'Published' },
  { value: 'failed', label: 'Failed' }
];
const CAMPAIGN_STATUSES = [
  { value: 'planned', label: 'Planned' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' }
];

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso.length > 10 ? iso : iso + 'T00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function num(n) { return Number(n || 0).toLocaleString(); }

function statusTagClass(status) {
  if (status === 'published' || status === 'active' || status === 'completed') return 'tag-neutral';
  if (status === 'failed') return 'tag-accent';
  return 'tag-outline';
}

function blankPostForm() {
  return {
    channelId: '', campaignId: '', title: '', caption: '', mediaUrl: '', status: 'planned',
    scheduledAt: '', publishedAt: '', likes: 0, comments: 0, shares: 0, reach: 0, impressions: 0, clicks: 0, leads: 0
  };
}
function blankCampaignForm() {
  return { name: '', description: '', startDate: '', endDate: '', status: 'planned' };
}

export default function SocialTrackerPage() {
  const { can } = useAuth();
  const canManage = can('marketing.manage');

  const [tab, setTab] = useState('overview');
  const [dash, setDash] = useState(null);
  const [posts, setPosts] = useState([]);
  const [channels, setChannels] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [calendarFilter, setCalendarFilter] = useState({ channelId: '', campaignId: '', status: '' });

  const [postDialogOpen, setPostDialogOpen] = useState(false);
  const [postForm, setPostForm] = useState(blankPostForm());
  const [editingPostId, setEditingPostId] = useState(null);
  const [postError, setPostError] = useState(null);
  const [savingPost, setSavingPost] = useState(false);

  const [campaignDialogOpen, setCampaignDialogOpen] = useState(false);
  const [campaignForm, setCampaignForm] = useState(blankCampaignForm());
  const [editingCampaignId, setEditingCampaignId] = useState(null);
  const [campaignError, setCampaignError] = useState(null);
  const [savingCampaign, setSavingCampaign] = useState(false);

  const [channelDrafts, setChannelDrafts] = useState({});
  const [statDrafts, setStatDrafts] = useState({});
  const [statHistory, setStatHistory] = useState({});
  const [busyChannelId, setBusyChannelId] = useState(null);

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const query = new URLSearchParams();
      if (calendarFilter.channelId) query.set('channelId', calendarFilter.channelId);
      if (calendarFilter.campaignId) query.set('campaignId', calendarFilter.campaignId);
      if (calendarFilter.status) query.set('status', calendarFilter.status);
      const qs = query.toString();
      const [d, p, c, camp] = await Promise.all([
        api.get('/marketing/dashboard'),
        api.get('/marketing/posts' + (qs ? '?' + qs : '')),
        api.get('/marketing/channels'),
        api.get('/marketing/campaigns')
      ]);
      setDash(d);
      setPosts(p);
      setChannels(c);
      setCampaigns(camp);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [calendarFilter.channelId, calendarFilter.campaignId, calendarFilter.status]);

  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // ── Content calendar ──────────────────────────────────────────────
  function openNewPost() {
    setPostError(null);
    setEditingPostId(null);
    setPostForm({ ...blankPostForm(), channelId: (channels[0] && channels[0].id) || '' });
    setPostDialogOpen(true);
  }
  function openEditPost(post) {
    setPostError(null);
    setEditingPostId(post.id);
    setPostForm({
      channelId: post.channelId, campaignId: post.campaignId || '', title: post.title, caption: post.caption,
      mediaUrl: post.mediaUrl, status: post.status,
      scheduledAt: post.scheduledAt ? post.scheduledAt.slice(0, 16) : '',
      publishedAt: post.publishedAt ? post.publishedAt.slice(0, 16) : '',
      likes: post.likes, comments: post.comments, shares: post.shares, reach: post.reach,
      impressions: post.impressions, clicks: post.clicks, leads: post.leads
    });
    setPostDialogOpen(true);
  }
  async function submitPost(e) {
    e.preventDefault();
    setSavingPost(true);
    setPostError(null);
    try {
      const body = { ...postForm, campaignId: postForm.campaignId || null, scheduledAt: postForm.scheduledAt || null, publishedAt: postForm.publishedAt || null };
      if (editingPostId) {
        await api.patch('/marketing/posts/' + editingPostId, body);
        setToast('Post updated.');
      } else {
        await api.post('/marketing/posts', body);
        setToast('Post added.');
      }
      setPostDialogOpen(false);
      await loadAll();
    } catch (err) {
      setPostError(err.message);
    } finally {
      setSavingPost(false);
    }
  }
  async function removePost(post) {
    if (!window.confirm('Delete "' + post.title + '"?')) return;
    try {
      await api.del('/marketing/posts/' + post.id);
      setToast('Post deleted.');
      await loadAll();
    } catch (err) {
      setError(err.message);
    }
  }

  // ── Campaigns ──────────────────────────────────────────────────────
  function openNewCampaign() {
    setCampaignError(null);
    setEditingCampaignId(null);
    setCampaignForm(blankCampaignForm());
    setCampaignDialogOpen(true);
  }
  function openEditCampaign(c) {
    setCampaignError(null);
    setEditingCampaignId(c.id);
    setCampaignForm({ name: c.name, description: c.description, startDate: c.startDate || '', endDate: c.endDate || '', status: c.status });
    setCampaignDialogOpen(true);
  }
  async function submitCampaign(e) {
    e.preventDefault();
    setSavingCampaign(true);
    setCampaignError(null);
    try {
      const body = { ...campaignForm, startDate: campaignForm.startDate || null, endDate: campaignForm.endDate || null };
      if (editingCampaignId) {
        await api.patch('/marketing/campaigns/' + editingCampaignId, body);
        setToast('Campaign updated.');
      } else {
        await api.post('/marketing/campaigns', body);
        setToast('Campaign added.');
      }
      setCampaignDialogOpen(false);
      await loadAll();
    } catch (err) {
      setCampaignError(err.message);
    } finally {
      setSavingCampaign(false);
    }
  }

  // ── Channels ───────────────────────────────────────────────────────
  function channelDraft(c) {
    return channelDrafts[c.id] || { handle: c.handle, notes: c.notes };
  }
  async function saveChannel(c) {
    const draft = channelDraft(c);
    setBusyChannelId(c.id);
    try {
      await api.patch('/marketing/channels/' + c.id, draft);
      setToast(c.name + ' updated.');
      await loadAll();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyChannelId(null);
    }
  }
  async function loadStatHistory(c) {
    try {
      setStatHistory({ ...statHistory, [c.id]: await api.get('/marketing/channels/' + c.id + '/stats') });
    } catch (err) {
      setError(err.message);
    }
  }
  async function logStat(c) {
    const draft = statDrafts[c.id] || {};
    if (!draft.capturedOn || draft.followers === undefined || draft.followers === '') {
      setToast('Enter a date and follower count first.');
      return;
    }
    setBusyChannelId(c.id);
    try {
      await api.post('/marketing/channels/' + c.id + '/stats', draft);
      setToast('Logged ' + draft.followers + ' followers for ' + c.name + '.');
      setStatDrafts({ ...statDrafts, [c.id]: { capturedOn: '', followers: '' } });
      await loadStatHistory(c);
      await loadAll();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyChannelId(null);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  return (
    <div className="soctrack">
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <p className="soctrack-intro">
        A Metricool-style tracker for social &amp; marketing performance. Post metrics, follower counts and
        campaign figures are logged here manually — a channel shows "Connected" once an API key for it is stored
        on the Integrations screen, but pulling live numbers from each platform is a separate build per platform
        once you have real developer app access there.
      </p>

      <div className="soctrack-tabs">
        {TABS.map((t) => (
          <button key={t.key} type="button" className={'soctrack-tab' + (tab === t.key ? ' soctrack-tab-active' : '')} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && dash && (
        <div className="soctrack-overview">
          <div className="soctrack-channel-grid">
            {dash.channels.map((c) => (
              <div key={c.id} className="soctrack-channel-card">
                <div className="soctrack-channel-card-top">
                  <div>
                    <div className="soctrack-channel-name">{c.name}</div>
                    <div className="soctrack-channel-handle">{c.handle || '—'}</div>
                  </div>
                  <span className={'tag ' + (c.connected ? 'tag-neutral' : 'tag-outline')}>{c.connected ? 'Connected' : 'Not connected'}</span>
                </div>
                {c.followers !== null && (
                  <div className="soctrack-followers">
                    {num(c.followers)} followers
                    {c.followerChange !== null && (
                      <span className={c.followerChange >= 0 ? 'soctrack-delta-up' : 'soctrack-delta-down'}>
                        {' '}{c.followerChange >= 0 ? '+' : ''}{num(c.followerChange)}
                      </span>
                    )}
                  </div>
                )}
                <div className="soctrack-metric-row">
                  <div><div className="soctrack-metric-value">{c.totals.posts}</div><div className="soctrack-metric-label">Posts</div></div>
                  <div><div className="soctrack-metric-value">{num(c.totals.likes)}</div><div className="soctrack-metric-label">Likes</div></div>
                  <div><div className="soctrack-metric-value">{num(c.totals.reach)}</div><div className="soctrack-metric-label">Reach</div></div>
                  <div><div className="soctrack-metric-value">{num(c.totals.clicks)}</div><div className="soctrack-metric-label">Clicks</div></div>
                  {c.totals.leads > 0 && <div><div className="soctrack-metric-value">{num(c.totals.leads)}</div><div className="soctrack-metric-label">Leads</div></div>}
                </div>
              </div>
            ))}
          </div>

          <h2 className="soctrack-section-title">Campaigns</h2>
          <table className="table">
            <thead><tr><th>Campaign</th><th>Status</th><th>Dates</th><th>Posts</th><th>Likes</th><th>Reach</th><th>Clicks</th><th>Leads</th></tr></thead>
            <tbody>
              {dash.campaigns.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 600 }}>{c.name}</td>
                  <td><span className={'tag ' + statusTagClass(c.status)}>{c.status}</span></td>
                  <td>{fmtDate(c.startDate)} – {fmtDate(c.endDate)}</td>
                  <td>{c.totals.posts}</td><td>{num(c.totals.likes)}</td><td>{num(c.totals.reach)}</td><td>{num(c.totals.clicks)}</td><td>{num(c.totals.leads)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!dash.campaigns.length && <p className="table-empty">No campaigns yet.</p>}
        </div>
      )}

      {tab === 'calendar' && (
        <div>
          <div className="soctrack-filters">
            <select className="input" value={calendarFilter.channelId} onChange={(e) => setCalendarFilter({ ...calendarFilter, channelId: e.target.value })}>
              <option value="">All channels</option>
              {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select className="input" value={calendarFilter.campaignId} onChange={(e) => setCalendarFilter({ ...calendarFilter, campaignId: e.target.value })}>
              <option value="">All campaigns</option>
              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select className="input" value={calendarFilter.status} onChange={(e) => setCalendarFilter({ ...calendarFilter, status: e.target.value })}>
              <option value="">All statuses</option>
              {POST_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            {canManage && <button type="button" className="btn btn-primary soctrack-new-btn" onClick={openNewPost}>New post</button>}
          </div>

          <table className="table">
            <thead><tr><th>Date</th><th>Channel</th><th>Campaign</th><th>Title</th><th>Status</th><th>Likes</th><th>Comments</th><th>Shares</th><th>Reach</th><th>Clicks</th><th>Leads</th><th /></tr></thead>
            <tbody>
              {posts.map((p) => (
                <tr key={p.id}>
                  <td>{fmtDate(p.publishedAt || p.scheduledAt)}</td>
                  <td>{p.channelName}</td>
                  <td>{p.campaignName || '—'}</td>
                  <td style={{ fontWeight: 600 }}>{p.title}</td>
                  <td><span className={'tag ' + statusTagClass(p.status)}>{p.status}</span></td>
                  <td>{num(p.likes)}</td><td>{num(p.comments)}</td><td>{num(p.shares)}</td><td>{num(p.reach)}</td><td>{num(p.clicks)}</td><td>{num(p.leads)}</td>
                  <td className="table-actions">
                    {canManage && (
                      <>
                        <button type="button" className="btn btn-secondary soctrack-row-btn" onClick={() => openEditPost(p)}>Edit</button>
                        <button type="button" className="btn btn-secondary soctrack-row-btn" onClick={() => removePost(p)}>Delete</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!posts.length && <p className="table-empty">No posts logged yet.</p>}
        </div>
      )}

      {tab === 'campaigns' && (
        <div>
          {canManage && (
            <div className="soctrack-toolbar">
              <button type="button" className="btn btn-primary" onClick={openNewCampaign}>New campaign</button>
            </div>
          )}
          <table className="table">
            <thead><tr><th>Campaign</th><th>Description</th><th>Dates</th><th>Status</th><th /></tr></thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 600 }}>{c.name}</td>
                  <td className="soctrack-desc-cell">{c.description || '—'}</td>
                  <td>{fmtDate(c.startDate)} – {fmtDate(c.endDate)}</td>
                  <td><span className={'tag ' + statusTagClass(c.status)}>{c.status}</span></td>
                  <td className="table-actions">
                    {canManage && <button type="button" className="btn btn-secondary soctrack-row-btn" onClick={() => openEditCampaign(c)}>Edit</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!campaigns.length && <p className="table-empty">No campaigns yet.</p>}
        </div>
      )}

      {tab === 'channels' && (
        <div className="soctrack-channels-list">
          {channels.map((c) => {
            const draft = channelDraft(c);
            const statDraft = statDrafts[c.id] || { capturedOn: '', followers: '' };
            const history = statHistory[c.id];
            return (
              <div key={c.id} className="soctrack-channel-row">
                <div className="soctrack-channel-row-top">
                  <div>
                    <div className="soctrack-channel-name">{c.name}</div>
                    <div className="soctrack-channel-handle">{c.kind}</div>
                  </div>
                  <span className={'tag ' + (c.connected ? 'tag-neutral' : 'tag-outline')}>{c.connected ? 'Connected' : 'Not connected'}</span>
                </div>

                {canManage ? (
                  <div className="soctrack-channel-fields">
                    <div className="field">
                      <label>Handle / URL</label>
                      <input className="input" value={draft.handle} onChange={(e) => setChannelDrafts({ ...channelDrafts, [c.id]: { ...draft, handle: e.target.value } })} />
                    </div>
                    <div className="field">
                      <label>Notes</label>
                      <input className="input" value={draft.notes} onChange={(e) => setChannelDrafts({ ...channelDrafts, [c.id]: { ...draft, notes: e.target.value } })} />
                    </div>
                    <button type="button" className="btn btn-secondary" disabled={busyChannelId === c.id} onClick={() => saveChannel(c)}>Save</button>
                  </div>
                ) : (
                  <div className="soctrack-channel-fields">
                    <div>{c.handle || '—'}</div>
                    {c.notes && <div className="soctrack-channel-handle">{c.notes}</div>}
                  </div>
                )}

                <div className="soctrack-stat-log">
                  <div className="soctrack-stat-log-title">Follower / traffic log</div>
                  {canManage && (
                    <div className="soctrack-stat-log-form">
                      <input className="input" type="date" value={statDraft.capturedOn} onChange={(e) => setStatDrafts({ ...statDrafts, [c.id]: { ...statDraft, capturedOn: e.target.value } })} />
                      <input className="input" type="number" min="0" placeholder="Follower count" value={statDraft.followers} onChange={(e) => setStatDrafts({ ...statDrafts, [c.id]: { ...statDraft, followers: e.target.value } })} />
                      <button type="button" className="btn btn-secondary" disabled={busyChannelId === c.id} onClick={() => logStat(c)}>Log</button>
                    </div>
                  )}
                  {!history && <button type="button" className="btn btn-secondary soctrack-row-btn" onClick={() => loadStatHistory(c)}>Show history</button>}
                  {history && (
                    history.length ? (
                      <table className="table soctrack-stat-table">
                        <thead><tr><th>Date</th><th>Followers</th></tr></thead>
                        <tbody>
                          {history.slice().reverse().map((h) => <tr key={h.id}><td>{fmtDate(h.capturedOn)}</td><td>{num(h.followers)}</td></tr>)}
                        </tbody>
                      </table>
                    ) : <p className="table-empty">No entries logged yet.</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {postDialogOpen && (
        <div className="dialog-backdrop" onClick={() => setPostDialogOpen(false)}>
          <form className="dialog soctrack-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitPost}>
            <h2 className="soctrack-dialog-title">{editingPostId ? 'Edit post' : 'New post'}</h2>
            {postError && <div className="error-banner soctrack-dialog-span">{postError}</div>}

            <div className="field">
              <label htmlFor="post-channel">Channel</label>
              <select id="post-channel" className="input" value={postForm.channelId} onChange={(e) => setPostForm({ ...postForm, channelId: e.target.value })} required>
                {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="post-campaign">Campaign (optional)</label>
              <select id="post-campaign" className="input" value={postForm.campaignId} onChange={(e) => setPostForm({ ...postForm, campaignId: e.target.value })}>
                <option value="">None</option>
                {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="field soctrack-dialog-span">
              <label htmlFor="post-title">Title</label>
              <input id="post-title" className="input" value={postForm.title} onChange={(e) => setPostForm({ ...postForm, title: e.target.value })} required />
            </div>
            <div className="field soctrack-dialog-span">
              <label htmlFor="post-caption">Caption / notes</label>
              <textarea id="post-caption" className="input" value={postForm.caption} onChange={(e) => setPostForm({ ...postForm, caption: e.target.value })} />
            </div>
            <div className="field soctrack-dialog-span">
              <label htmlFor="post-media">Media URL (optional)</label>
              <input id="post-media" className="input" value={postForm.mediaUrl} onChange={(e) => setPostForm({ ...postForm, mediaUrl: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="post-status">Status</label>
              <select id="post-status" className="input" value={postForm.status} onChange={(e) => setPostForm({ ...postForm, status: e.target.value })}>
                {POST_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="post-scheduled">Scheduled for</label>
              <input id="post-scheduled" className="input" type="datetime-local" value={postForm.scheduledAt} onChange={(e) => setPostForm({ ...postForm, scheduledAt: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="post-published">Published at</label>
              <input id="post-published" className="input" type="datetime-local" value={postForm.publishedAt} onChange={(e) => setPostForm({ ...postForm, publishedAt: e.target.value })} />
            </div>

            <div className="soctrack-dialog-span soctrack-section-title-inline">Engagement</div>
            <div className="field"><label>Likes</label><input className="input" type="number" min="0" value={postForm.likes} onChange={(e) => setPostForm({ ...postForm, likes: e.target.value })} /></div>
            <div className="field"><label>Comments</label><input className="input" type="number" min="0" value={postForm.comments} onChange={(e) => setPostForm({ ...postForm, comments: e.target.value })} /></div>
            <div className="field"><label>Shares</label><input className="input" type="number" min="0" value={postForm.shares} onChange={(e) => setPostForm({ ...postForm, shares: e.target.value })} /></div>
            <div className="field"><label>Reach</label><input className="input" type="number" min="0" value={postForm.reach} onChange={(e) => setPostForm({ ...postForm, reach: e.target.value })} /></div>
            <div className="field"><label>Impressions</label><input className="input" type="number" min="0" value={postForm.impressions} onChange={(e) => setPostForm({ ...postForm, impressions: e.target.value })} /></div>
            <div className="field"><label>Clicks</label><input className="input" type="number" min="0" value={postForm.clicks} onChange={(e) => setPostForm({ ...postForm, clicks: e.target.value })} /></div>
            <div className="field"><label>Leads</label><input className="input" type="number" min="0" value={postForm.leads} onChange={(e) => setPostForm({ ...postForm, leads: e.target.value })} /></div>

            <div className="dialog-actions soctrack-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setPostDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={savingPost}>{savingPost ? 'Saving…' : 'Save post'}</button>
            </div>
          </form>
        </div>
      )}

      {campaignDialogOpen && (
        <div className="dialog-backdrop" onClick={() => setCampaignDialogOpen(false)}>
          <form className="dialog soctrack-campaign-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitCampaign}>
            <h2 className="soctrack-dialog-title">{editingCampaignId ? 'Edit campaign' : 'New campaign'}</h2>
            {campaignError && <div className="error-banner soctrack-dialog-span">{campaignError}</div>}

            <div className="field soctrack-dialog-span">
              <label htmlFor="camp-name">Name</label>
              <input id="camp-name" className="input" value={campaignForm.name} onChange={(e) => setCampaignForm({ ...campaignForm, name: e.target.value })} required />
            </div>
            <div className="field soctrack-dialog-span">
              <label htmlFor="camp-desc">Description</label>
              <textarea id="camp-desc" className="input" value={campaignForm.description} onChange={(e) => setCampaignForm({ ...campaignForm, description: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="camp-start">Start date</label>
              <input id="camp-start" className="input" type="date" value={campaignForm.startDate} onChange={(e) => setCampaignForm({ ...campaignForm, startDate: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="camp-end">End date</label>
              <input id="camp-end" className="input" type="date" value={campaignForm.endDate} onChange={(e) => setCampaignForm({ ...campaignForm, endDate: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="camp-status">Status</label>
              <select id="camp-status" className="input" value={campaignForm.status} onChange={(e) => setCampaignForm({ ...campaignForm, status: e.target.value })}>
                {CAMPAIGN_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>

            <div className="dialog-actions soctrack-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setCampaignDialogOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={savingCampaign}>{savingCampaign ? 'Saving…' : 'Save campaign'}</button>
            </div>
          </form>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
