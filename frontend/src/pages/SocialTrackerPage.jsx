import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { MetricSection } from '../components/SocialCharts';
import DateRangePicker, { PRESETS } from '../components/DateRangePicker';
import MarketingRecommendations from '../components/MarketingRecommendations';
import { rowsToCsv, downloadCsv } from '../lib/csvExport';
import { shareOrDownloadPdf } from '../lib/documentShare';
import './SocialTrackerPage.css';
import RowMenu from '../components/RowMenu';
import PlatformIcon from '../components/PlatformIcon';
import { restaurantLogoUrl } from '../lib/restaurantLogos';

import { activeIntlLocale, msg, tr, trNodes } from '../lib/i18n.jsx';
import { codeLabel } from '../lib/codeLabels.js';
// Metricool-style social & campaign tracker: channels (Facebook, Instagram,
// TikTok, WhatsApp Business, Website, ThomasNet), campaigns, a content
// calendar of posts with their engagement numbers, and follower/traffic
// snapshots per channel for a growth trend. Everything is manually logged —
// a channel's "Connected" badge only means an API key is stored on the
// Integrations screen (settings.manage), same as this app's other
// integrations (Square, Slack, QuickBooks); pulling live numbers from each
// platform's API is a separate backend build per platform once real
// developer app approval exists for it.
//
// One tracker per company (backend marketingChannels.js): Bamboo Products,
// Star Bar Restaurant and Bamboo Garden each have their own channels,
// campaigns, posts, follower history and inbox. The switcher at the top
// picks the company (?company=SB, remembered on this device); every list
// and total below is that company's. A channel that can be connected to an
// account (Facebook, Instagram, TikTok, YouTube) connects from its row on
// the Channels tab, to that company's own account.
//
// Laid out to explain itself: a company header with where things stand,
// tabs with counts, and an Overview that leads with plain totals, a short
// "what stands out" list written from the numbers, and what each number
// means. Channels, posts and campaigns are cards with each platform's icon;
// every dialog, sync and connect flow and the Facebook Page picker work as
// before.

const AVATAR_COLORS = ['#3f7d3b', '#2f5f2c', '#7d5c3f', '#3f5a7d', '#7d3f5c', '#5c3f7d', '#7d6b3f', '#3f7d6b'];
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return ((parts[0] ? parts[0][0] : '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function avatarColor(name) { return AVATAR_COLORS[hashStr(name || '') % AVATAR_COLORS.length]; }

function Icon({ name }) {
  const paths = {
    overview: <path d="M4 19V5M4 19h16M8 15l3.5-4 3 2.5L19 8" />,
    calendar: <><rect x="4" y="5.5" width="16" height="14.5" rx="2" /><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" /></>,
    campaigns: <path d="M5 21V4.5M5 5h11.5l-2 3.5 2 3.5H5" />,
    inbox: <><path d="M3.5 12.5V6.5A1.5 1.5 0 0 1 5 5h14a1.5 1.5 0 0 1 1.5 1.5v6" /><path d="M3.5 12.5h5l1.3 2.5h4.4l1.3-2.5h5V18a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18z" /></>,
    channels: <path d="M9 7.5 6.5 10a3.5 3.5 0 0 0 5 5L14 12.5M15 16.5l2.5-2.5a3.5 3.5 0 0 0-5-5L10 11.5M9.5 14.5l5-5" />,
    people: <><circle cx="9" cy="8.5" r="3" /><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8M15.5 5.8a3 3 0 0 1 0 5.4M17.5 14.6c1.6.7 2.6 2.2 3 4.4" /></>,
    eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></>,
    heart: <path d="M12 19.5s-7.5-4.4-7.5-9.7A4.2 4.2 0 0 1 12 7.3a4.2 4.2 0 0 1 7.5 2.5c0 5.3-7.5 9.7-7.5 9.7z" />,
    post: <><rect x="4.5" y="4" width="15" height="16" rx="2" /><path d="M8 9h8M8 12.5h8M8 16h5" /></>,
    chat: <path d="M4.5 18.5 5.6 15A7 7 0 1 1 8.9 17.6z" />,
    info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8v.1" /></>,
    spark: <path d="M12 3.5 13.8 9l5.7 1.5-5.7 1.6L12 17.5l-1.8-5.4-5.7-1.6L10.2 9zM18.5 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />,
    check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
    arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
    up: <path d="M12 19V5M6 11l6-6 6 6" />,
    down: <path d="M12 5v14M6 13l6 6 6-6" />,
    warn: <><path d="M12 4 21 19.5H3z" /><path d="M12 10v4.5M12 17v.1" /></>,
    sync: <path d="M19.5 12a7.5 7.5 0 0 1-13 5.1M4.5 12a7.5 7.5 0 0 1 13-5.1M17.5 3.5v3.4h-3.4M6.5 20.5v-3.4h3.4" />
  };
  return (
    <svg className="st-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

// A metric row's totals across channels: { value, delta, pct } (delta and
// pct null when there is nothing to compare with).
function sumMetric(metric) {
  const rows = (metric && metric.byChannel) || [];
  const value = rows.reduce((n, r) => n + Number(r.value || 0), 0);
  const withDelta = rows.filter((r) => r.delta !== null && r.delta !== undefined);
  const delta = withDelta.length ? withDelta.reduce((n, r) => n + Number(r.delta), 0) : null;
  const prev = delta === null ? null : value - delta;
  const pct = prev ? Math.round((delta / prev) * 100) : null;
  return { value, delta, pct, channels: rows.length };
}

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00').getTime() - new Date(a + 'T00:00').getTime()) / 86400000);
}
function todayIso() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Where a campaign is in its dates: { pct, label } or null without dates.
function campaignTimeline(c) {
  if (!c.startDate || !c.endDate) return null;
  const today = todayIso();
  const total = Math.max(1, daysBetween(c.startDate, c.endDate) + 1);
  if (today < c.startDate) {
    const n = daysBetween(today, c.startDate);
    return { pct: 0, label: n === 1 ? tr('Starts tomorrow') : tr('Starts in {n} days', { n }) };
  }
  if (today > c.endDate) return { pct: 100, label: tr('Ended {date}', { date: fmtDate(c.endDate) }) };
  const day = daysBetween(c.startDate, today) + 1;
  return { pct: Math.round((day / total) * 100), label: tr('Day {day} of {total}', { day, total }) };
}

function monthKey(iso) { return iso ? iso.slice(0, 7) : ''; }
function monthLabel(key) {
  if (!key) return tr('No date yet');
  return new Date(key + '-01T00:00').toLocaleDateString(activeIntlLocale(), { month: 'long', year: 'numeric' });
}


// A total's change against the same number of days just before.
function Delta({ value, pct, days }) {
  if (value === null || value === undefined) return <span className="st-delta is-flat">{tr('Nothing to compare yet')}</span>;
  if (value === 0) return <span className="st-delta is-flat">{tr('Same as the {n} days before', { n: days })}</span>;
  const up = value > 0;
  return (
    <span className={'st-delta ' + (up ? 'is-up' : 'is-down')}>
      <Icon name={up ? 'up' : 'down'} />
      <span>{(up ? '+' : '−') + num(Math.abs(value))}{pct !== null && pct !== undefined ? ' (' + (up ? '+' : '−') + Math.abs(pct) + '%)' : ''}</span>
      <span className="st-delta-vs">{tr('vs the {n} days before', { n: days })}</span>
    </span>
  );
}

function EmptyState({ icon, title, body, action }) {
  return (
    <div className="st-empty">
      <span className="st-empty-icon"><Icon name={icon} /></span>
      <p className="st-empty-title">{title}</p>
      {body && <p className="st-empty-body">{body}</p>}
      {action && <button type="button" className="btn btn-primary" onClick={action.run}>{action.label}</button>}
    </div>
  );
}

// A campaign with where it is in its dates and, when known, its results.
function CampaignCard({ c, totals, onEdit }) {
  const tl = campaignTimeline(c);
  return (
    <article className="st-card st-campaign">
      <div className="st-campaign-top">
        <span className={'st-campaign-flag is-' + c.status}><Icon name="campaigns" /></span>
        <div className="st-card-id">
          <div className="st-card-name">{c.name}</div>
          <div className="st-card-sub">{c.startDate || c.endDate ? fmtDate(c.startDate) + ' – ' + fmtDate(c.endDate) : tr('No dates set')}</div>
        </div>
        <span className={'st-status is-' + c.status}>{codeLabel(c.status)}</span>
      </div>
      {c.description && <p className="st-campaign-desc">{c.description}</p>}
      {tl && (
        <div className="st-timeline">
          <div className="st-timeline-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={tl.pct} aria-label={tl.label}>
            <span style={{ width: tl.pct + '%' }} />
          </div>
          <span className="st-timeline-label">{tl.label}</span>
        </div>
      )}
      {totals && (
        <dl className="st-mini-stats">
          <div><dt>{tr('Posts')}</dt><dd>{num(totals.posts)}</dd></div>
          <div><dt>{tr('Reach')}</dt><dd>{num(totals.reach)}</dd></div>
          <div><dt>{tr('Likes')}</dt><dd>{num(totals.likes)}</dd></div>
          <div><dt>{tr('Clicks')}</dt><dd>{num(totals.clicks)}</dd></div>
          <div><dt>{tr('Leads')}</dt><dd>{num(totals.leads)}</dd></div>
        </dl>
      )}
      {onEdit && <div className="st-card-foot"><button type="button" className="st-link" onClick={onEdit}>{tr('Edit')} <Icon name="arrow" /></button></div>}
    </article>
  );
}

const TABS = [
  { key: 'overview', label: msg('Overview') },
  { key: 'calendar', label: msg('Content calendar') },
  { key: 'campaigns', label: msg('Campaigns') },
  { key: 'inbox', label: msg('Inbox') },
  { key: 'channels', label: msg('Channels') }
];

const POST_STATUSES = [
  { value: 'planned', label: msg('Planned') },
  { value: 'scheduled', label: msg('Scheduled') },
  { value: 'published', label: msg('Published') },
  { value: 'failed', label: msg('Failed') }
];
const CAMPAIGN_STATUSES = [
  { value: 'planned', label: msg('Planned') },
  { value: 'active', label: msg('Active') },
  { value: 'completed', label: msg('Completed') }
];
const INBOX_KINDS = [
  { value: 'comment', label: msg('Comment') },
  { value: 'message', label: msg('Message / DM') }
];

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso.length > 10 ? iso : iso + 'T00:00').toLocaleDateString(activeIntlLocale(), { day: '2-digit', month: 'short', year: 'numeric' });
}
function num(n) { return Number(n || 0).toLocaleString(); }


// The endpoint each connected platform syncs through (with the channel's
// key, so each company's own account is read).
const SYNC_PATH = { tiktok: 'tiktok', facebook: 'facebook', instagram: 'instagram', youtube: 'youtube', twitch: 'twitch', website: 'website' };
// Platforms that connect by signing in to the platform.
const OAUTH_PLATFORMS = ['facebook', 'instagram', 'tiktok', 'youtube', 'twitch'];
const COMPANY_KEY = 'bos.socialCompany';

function initialCompany() {
  const q = new URLSearchParams(window.location.search).get('company');
  if (q) return q.toUpperCase();
  try { return localStorage.getItem(COMPANY_KEY) || 'BPL'; } catch { return 'BPL'; }
}

// The address bar after handling a platform's redirect: the flags it sent
// back are dropped, the company stays.
function cleanUrl(company) {
  window.history.replaceState({}, '', window.location.pathname + (company && company !== 'BPL' ? '?company=' + company : ''));
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
function blankInboxForm() {
  return { channelId: '', postId: '', kind: 'comment', authorName: '', authorHandle: '', body: '' };
}

export default function SocialTrackerPage() {
  const { can } = useAuth();
  const canManage = can('marketing.manage');

  const [tab, setTab] = useState('overview');
  const [company, setCompany] = useState(initialCompany);
  const [companies, setCompanies] = useState([]);
  const companyName = (companies.find((c) => c.code === company) || {}).name || '';
  const cq = 'company=' + encodeURIComponent(company);
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

  const [inboxItems, setInboxItems] = useState([]);
  const [inboxFilter, setInboxFilter] = useState({ channelId: '', status: '', kind: '' });
  const [inboxDialogOpen, setInboxDialogOpen] = useState(false);
  const [inboxForm, setInboxForm] = useState(blankInboxForm());
  const [inboxError, setInboxError] = useState(null);
  const [savingInbox, setSavingInbox] = useState(false);
  const [replyDrafts, setReplyDrafts] = useState({});
  const [busyInboxId, setBusyInboxId] = useState(null);
  const [allPosts, setAllPosts] = useState([]);
  const [syncingKey, setSyncingKey] = useState(null); // channel key being synced, connected or disconnected

  const [pagePickerOpen, setPagePickerOpen] = useState(false);
  const [pagePickerPending, setPagePickerPending] = useState(null);
  const [pagePickerPages, setPagePickerPages] = useState([]);
  const [pagePickerLoading, setPagePickerLoading] = useState(false);
  const [pagePickerError, setPagePickerError] = useState(null);
  const [connectingPageId, setConnectingPageId] = useState(null);

  const defaultRange = (() => { var r = PRESETS[2].range(); return { ...r, presetKey: 'last30', label: PRESETS[2].label }; })(); // Last 30 days
  const [dateRange, setDateRange] = useState(defaultRange);
  const [metrics, setMetrics] = useState(null);
  const [metricsError, setMetricsError] = useState(null);

  const [exporting, setExporting] = useState(false);
  const [recommendation, setRecommendation] = useState(null);
  const overviewRef = useRef(null);

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const query = new URLSearchParams({ company });
      if (calendarFilter.channelId) query.set('channelId', calendarFilter.channelId);
      if (calendarFilter.campaignId) query.set('campaignId', calendarFilter.campaignId);
      if (calendarFilter.status) query.set('status', calendarFilter.status);
      const qs = query.toString();
      const inboxQuery = new URLSearchParams({ company });
      if (inboxFilter.channelId) inboxQuery.set('channelId', inboxFilter.channelId);
      if (inboxFilter.status) inboxQuery.set('status', inboxFilter.status);
      if (inboxFilter.kind) inboxQuery.set('kind', inboxFilter.kind);
      const inboxQs = inboxQuery.toString();
      const [d, p, c, camp, inbox] = await Promise.all([
        api.get('/marketing/dashboard?' + cq),
        api.get('/marketing/posts?' + qs),
        api.get('/marketing/channels?' + cq),
        api.get('/marketing/campaigns?' + cq),
        api.get('/marketing/inbox?' + inboxQs)
      ]);
      setDash(d);
      setPosts(p);
      setChannels(c);
      setCampaigns(camp);
      setInboxItems(inbox);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [company, cq, calendarFilter.channelId, calendarFilter.campaignId, calendarFilter.status, inboxFilter.channelId, inboxFilter.status, inboxFilter.kind]);

  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => {
    api.get('/marketing/companies').then(setCompanies).catch(() => setCompanies([]));
  }, []);
  // A remembered company that no longer has a tracker falls back to Bamboo Products.
  useEffect(() => {
    if (companies.length && !companies.some((c) => c.code === company)) setCompany('BPL');
  }, [companies, company]);

  function switchCompany(code) {
    if (code === company) return;
    setCompany(code);
    try { localStorage.setItem(COMPANY_KEY, code); } catch { /* remembered for this visit only */ }
    setCalendarFilter({ channelId: '', campaignId: '', status: '' });
    setInboxFilter({ channelId: '', status: '', kind: '' });
    setChannelDrafts({});
    setStatDrafts({});
    setStatHistory({});
    setRecommendation(null);
    cleanUrl(code);
  }

  // Overview tab's Metricool-style metric sections — re-fetched whenever
  // the date range changes, scoped to that range on the backend.
  useEffect(() => {
    setMetricsError(null);
    api.get('/marketing/dashboard/metrics?from=' + dateRange.from + '&to=' + dateRange.to + '&' + cq)
      .then(setMetrics)
      .catch((err) => setMetricsError(err.message));
    // dash: fetched again whenever the tracker's data is (a post or a
    // follower count just logged shows in the charts straight away).
  }, [dateRange.from, dateRange.to, cq, dash]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // Landing back here after the TikTok OAuth redirect (oauth.routes.js's
  // callback sends the browser to /socialtracker?tiktok=connected|error).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tiktok = params.get('tiktok');
    if (!tiktok) return;
    if (tiktok === 'connected') {
      setToast(tr('TikTok connected.'));
      setTab('channels');
    } else if (tiktok === 'error') {
      setError(params.get('message') || tr('TikTok connection failed.'));
    }
    cleanUrl(company);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Landing back here after the Meta OAuth redirect. A connected Page (not
  // necessarily with Instagram linked) needs picking before the connection
  // is real — oauth.routes.js's callback sends the browser here with a
  // pending token rather than connecting outright, since the logged-in
  // account may admin more than one Facebook Page.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const meta = params.get('meta');
    if (!meta) return;
    if (meta === 'choose-page') {
      openPagePicker(params.get('pending'));
    } else if (meta === 'error') {
      setError(params.get('message') || tr('Facebook/Instagram connection failed.'));
    }
    cleanUrl(company);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Landing back here after the YouTube or Twitch OAuth redirect — same
  // single-step connected|error shape as TikTok's, for both platforms.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    let changed = false;
    [['youtube', 'YouTube'], ['twitch', 'Twitch']].forEach(([key, label]) => {
      const value = params.get(key);
      if (!value) return;
      changed = true;
      if (value === 'connected') {
        setToast(tr('{label} connected.', { label }));
        setTab('channels');
      } else if (value === 'error') {
        setError(params.get('message') || (tr('{label} connection failed.', { label })));
      }
    });
    if (changed) cleanUrl(company);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What a finished sync says, per platform.
  function syncMessage(c, r) {
    switch (c.platform) {
      case 'tiktok':
        if (r.videoError) return tr('Synced followers ({n}), but video sync failed: {videoError}', { n: num(r.followers), videoError: r.videoError });
        return r.followers !== null && r.followers !== undefined
          ? tr('Synced {n} TikTok video(s), {followers} followers.', { n: r.synced, followers: num(r.followers) })
          : tr('Synced {n} TikTok video(s).', { n: r.synced });
      case 'facebook':
        if (r.syncError) return tr('Facebook: partially synced ({synced} post(s)) — {syncError}', { synced: r.synced, syncError: r.syncError });
        return r.followers !== null && r.followers !== undefined
          ? tr('Synced {n} Facebook post(s), {followers} followers.', { n: r.synced, followers: num(r.followers) })
          : tr('Synced {n} Facebook post(s).', { n: r.synced });
      case 'instagram':
        if (r.syncError) return tr('Instagram: partially synced ({synced} post(s)) — {syncError}', { synced: r.synced, syncError: r.syncError });
        return r.followers !== null && r.followers !== undefined
          ? tr('Synced {n} Instagram post(s), {followers} followers.', { n: r.synced, followers: num(r.followers) })
          : tr('Synced {n} Instagram post(s).', { n: r.synced });
      case 'youtube':
        return r.followers !== null && r.followers !== undefined
          ? tr('Synced {n} YouTube video(s), {followers} subscribers.', { n: r.synced, followers: num(r.followers) })
          : tr('Synced {n} YouTube video(s).', { n: r.synced });
      case 'twitch':
        return r.followers !== null && r.followers !== undefined
          ? tr('Synced {n} Twitch video(s), {followers} followers.', { n: r.synced, followers: num(r.followers) })
          : tr('Synced {n} Twitch video(s).', { n: r.synced });
      default:
        return r.followers !== null && r.followers !== undefined
          ? tr('Synced {n} website page(s), {followers} active users (30d).', { n: r.synced, followers: num(r.followers) })
          : tr('Synced {n} website page(s).', { n: r.synced });
    }
  }

  async function syncChannel(c) {
    setSyncingKey(c.key);
    setError(null);
    try {
      const r = await api.post('/marketing/' + SYNC_PATH[c.platform] + '/sync', { channel: c.key });
      setToast(syncMessage(c, r));
      await loadAll();
    } catch (err) {
      setError(err.message);
    } finally {
      setSyncingKey(null);
    }
  }

  // Sends the browser to the platform to sign in with this company's
  // account; it comes back to this page (oauth.routes.js).
  async function connectChannel(c) {
    setSyncingKey(c.key);
    setError(null);
    try {
      const { url } = c.platform === 'facebook' || c.platform === 'instagram'
        ? await api.post('/marketing/oauth/meta/start', { company })
        : await api.post('/marketing/oauth/' + c.platform + '/start', { channel: c.key });
      window.location.href = url;
    } catch (err) {
      setError(err.message);
      setSyncingKey(null);
    }
  }

  async function disconnectChannel(c) {
    if (!window.confirm(tr('Disconnect {name}? Its numbers stop syncing; what is already here stays.', { name: c.name }))) return;
    setSyncingKey(c.key);
    setError(null);
    try {
      await api.post('/marketing/channels/' + c.id + '/disconnect', {});
      setToast(tr('{name} disconnected.', { name: c.name }));
      await loadAll();
    } catch (err) {
      setError(err.message);
    } finally {
      setSyncingKey(null);
    }
  }

  async function openPagePicker(pending) {
    setPagePickerPending(pending);
    setPagePickerOpen(true);
    setPagePickerLoading(true);
    setPagePickerError(null);
    try {
      setPagePickerPages(await api.get('/marketing/meta/pages?pending=' + encodeURIComponent(pending)));
    } catch (err) {
      setPagePickerError(err.message);
    } finally {
      setPagePickerLoading(false);
    }
  }

  async function connectPage(page) {
    setConnectingPageId(page.id);
    setPagePickerError(null);
    try {
      const r = await api.post('/marketing/meta/pages/' + page.id + '/connect', { pending: pagePickerPending });
      setPagePickerOpen(false);
      setToast(r.instagramConnected
        ? tr('Connected "{name}" and its linked Instagram account.', { name: r.pageName })
        : tr('Connected "{name}" (no Instagram account linked).', { name: r.pageName }));
      setTab('channels');
      await loadAll();
    } catch (err) {
      setPagePickerError(err.message);
    } finally {
      setConnectingPageId(null);
    }
  }

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
        setToast(tr('Post updated.'));
      } else {
        await api.post('/marketing/posts', body);
        setToast(tr('Post added.'));
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
    if (!window.confirm(tr('Delete "{title}"?', { title: post.title }))) return;
    try {
      await api.del('/marketing/posts/' + post.id);
      setToast(tr('Post deleted.'));
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
      const body = { ...campaignForm, company, startDate: campaignForm.startDate || null, endDate: campaignForm.endDate || null };
      if (editingCampaignId) {
        await api.patch('/marketing/campaigns/' + editingCampaignId, body);
        setToast(tr('Campaign updated.'));
      } else {
        await api.post('/marketing/campaigns', body);
        setToast(tr('Campaign added.'));
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
      setToast(tr('{name} updated.', { name: c.name }));
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
      setToast(tr('Enter a date and follower count first.'));
      return;
    }
    setBusyChannelId(c.id);
    try {
      await api.post('/marketing/channels/' + c.id + '/stats', draft);
      setToast(tr('Logged {followers} followers for {name}.', { followers: draft.followers, name: c.name }));
      setStatDrafts({ ...statDrafts, [c.id]: { capturedOn: '', followers: '' } });
      await loadStatHistory(c);
      await loadAll();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyChannelId(null);
    }
  }

  // ── Inbox ──────────────────────────────────────────────────────────
  async function openNewInboxItem() {
    setInboxError(null);
    setInboxForm({ ...blankInboxForm(), channelId: (channels[0] && channels[0].id) || '' });
    setInboxDialogOpen(true);
    try {
      setAllPosts(await api.get('/marketing/posts?' + cq));
    } catch (err) {
      setInboxError(err.message);
    }
  }
  async function submitInboxItem(e) {
    e.preventDefault();
    setSavingInbox(true);
    setInboxError(null);
    try {
      await api.post('/marketing/inbox', { ...inboxForm, postId: inboxForm.postId || null });
      setToast(tr('Logged.'));
      setInboxDialogOpen(false);
      await loadAll();
    } catch (err) {
      setInboxError(err.message);
    } finally {
      setSavingInbox(false);
    }
  }
  async function sendReply(item) {
    const replyBody = (replyDrafts[item.id] || '').trim();
    if (!replyBody) {
      setToast(tr('Write a reply first.'));
      return;
    }
    setBusyInboxId(item.id);
    try {
      await api.post('/marketing/inbox/' + item.id + '/reply', { replyBody });
      setToast(tr('Reply recorded.'));
      setReplyDrafts({ ...replyDrafts, [item.id]: '' });
      await loadAll();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyInboxId(null);
    }
  }
  async function archiveInboxItem(item) {
    setBusyInboxId(item.id);
    try {
      await api.post('/marketing/inbox/' + item.id + '/status', { status: 'archived' });
      setToast(tr('Archived.'));
      await loadAll();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyInboxId(null);
    }
  }
  async function reopenInboxItem(item) {
    setBusyInboxId(item.id);
    try {
      await api.post('/marketing/inbox/' + item.id + '/status', { status: 'open' });
      setToast(tr('Reopened.'));
      await loadAll();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyInboxId(null);
    }
  }

  async function downloadOverviewPdf() {
    setExporting(true);
    try {
      await shareOrDownloadPdf(overviewRef.current, 'social-tracker-' + company.toLowerCase() + '-' + new Date().toISOString().slice(0, 10) + '.pdf', tr('Social & campaign tracker') + (companyName ? ' — ' + companyName : ''), tr('Social & campaign tracker'));
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  }

  function downloadOverviewCsv() {
    if (!dash) return;
    const rows = [
      [tr('Social & Campaign Tracker — Overview'), companyName, new Date().toISOString().slice(0, 10)],
      [],
      [tr('Channels')],
      [tr('Channel'), tr('Handle'), tr('Connected'), tr('Followers'), tr('Follower change'), tr('Posts'), tr('Likes'), tr('Reach'), tr('Clicks'), tr('Leads')],
      ...dash.channels.map((c) => [c.name, c.handle || '', c.connected ? 'yes' : 'no', c.followers, c.followerChange, c.totals.posts, c.totals.likes, c.totals.reach, c.totals.clicks, c.totals.leads]),
      [],
      [tr('Campaigns')],
      [tr('Campaign'), tr('Status'), tr('Start'), tr('End'), tr('Posts'), tr('Likes'), tr('Reach'), tr('Clicks'), tr('Leads')],
      ...dash.campaigns.map((c) => [c.name, c.status, c.startDate || '', c.endDate || '', c.totals.posts, c.totals.likes, c.totals.reach, c.totals.clicks, c.totals.leads])
    ];
    if (recommendation) rows.push([], [tr('Content recommendations')], [recommendation.recommendation]);
    downloadCsv('social-tracker-' + company.toLowerCase() + '-' + new Date().toISOString().slice(0, 10) + '.csv', rowsToCsv(rows));
  }

  // ── what the page says about itself ────────────────────────────────
  const connectedCount = channels.filter((c) => c.connected).length;
  const openInbox = dash ? dash.channels.reduce((n, c) => n + (c.openInboxCount || 0), 0) : 0;
  const activeCampaigns = campaigns.filter((c) => c.status === 'active').length;
  const rangeDays = daysBetween(dateRange.from, dateRange.to) + 1;
  const kpi = metrics ? {
    followers: sumMetric(metrics.metrics.followers),
    reach: sumMetric(metrics.metrics.reach),
    interactions: sumMetric(metrics.metrics.interactions),
    posts: sumMetric(metrics.metrics.posts)
  } : null;
  const hasPosts = dash ? dash.channels.some((c) => c.totals.posts > 0) || posts.length > 0 : false;
  const hasFollowers = dash ? dash.channels.some((c) => c.followers !== null) : false;
  const setupSteps = [
    { done: connectedCount > 0, title: tr('Connect a channel'), body: tr('Sign in to Facebook, Instagram, TikTok or YouTube once, and their numbers come in by themselves.'), action: () => setTab('channels'), actionLabel: tr('Go to Channels') },
    { done: hasPosts, title: tr('Log or sync your posts'), body: tr('Every post with its likes, comments, reach and clicks — planned ones too, so the calendar shows what is coming.'), action: () => setTab('calendar'), actionLabel: tr('Open the calendar') },
    { done: hasFollowers, title: tr('Record follower counts'), body: tr('A count now and then (or a daily sync) draws the growth line for each channel.'), action: () => setTab('channels'), actionLabel: tr('Log followers') }
  ];
  const setupLeft = setupSteps.filter((st) => !st.done).length;

  // A few plain sentences about the chosen period, written from the numbers.
  const insights = [];
  if (dash && metrics) {
    const reachRows = (metrics.metrics.reach.byChannel || []).slice().sort((a, b) => b.value - a.value);
    if (reachRows[0] && reachRows[0].value > 0) {
      insights.push({ tone: 'good', icon: 'eye', text: tr('{channel} reached the most people: {n} in this period.', { channel: reachRows[0].name, n: num(reachRows[0].value) }) });
    }
    const growth = (metrics.metrics.followers.byChannel || []).filter((r) => r.delta !== null && r.delta !== 0).sort((a, b) => b.delta - a.delta);
    if (growth[0] && growth[0].delta > 0) {
      insights.push({ tone: 'good', icon: 'up', text: tr('{channel} gained {n} followers — the fastest growth.', { channel: growth[0].name, n: num(growth[0].delta) }) });
    }
    const lost = growth.filter((r) => r.delta < 0);
    if (lost.length) {
      const worst = lost[lost.length - 1];
      insights.push({ tone: 'warn', icon: 'down', text: tr('{channel} lost {n} followers. Worth a look at what was posted.', { channel: worst.name, n: num(-worst.delta) }) });
    }
    if (kpi && kpi.posts.value === 0) {
      insights.push({ tone: 'warn', icon: 'post', text: tr('Nothing was published in this period.'), action: canManage ? { label: tr('Plan a post'), run: () => { setTab('calendar'); openNewPost(); } } : null });
    } else if (kpi && kpi.interactions.value > 0 && kpi.posts.value > 0) {
      insights.push({ tone: 'info', icon: 'heart', text: tr('Each post drew {n} likes, comments and shares on average.', { n: num(Math.round(kpi.interactions.value / kpi.posts.value)) }) });
    }
    if (openInbox > 0) {
      insights.push({ tone: 'warn', icon: 'chat', text: openInbox === 1 ? tr('1 comment or message is waiting for a reply.') : tr('{n} comments and messages are waiting for a reply.', { n: openInbox }), action: { label: tr('Open the inbox'), run: () => { setInboxFilter({ channelId: '', status: 'open', kind: '' }); setTab('inbox'); } } });
    }
    if (connectedCount === 0 && channels.some((c) => c.connectable)) {
      insights.push({ tone: 'info', icon: 'channels', text: tr('No channel is connected yet, so every number here was logged by hand.'), action: canManage ? { label: tr('Connect one'), run: () => setTab('channels') } : null });
    }
    const ending = dash.campaigns.filter((c) => c.status === 'active' && c.endDate && c.endDate >= todayIso() && daysBetween(todayIso(), c.endDate) <= 7);
    if (ending[0]) {
      insights.push({ tone: 'info', icon: 'campaigns', text: tr('Campaign "{name}" ends {date}.', { name: ending[0].name, date: fmtDate(ending[0].endDate) }) });
    }
  }

  function selectTab(key) { setTab(key); }
  function onTabKey(e) {
    const i = TABS.findIndex((t) => t.key === tab);
    let next = null;
    if (e.key === 'ArrowRight') next = TABS[(i + 1) % TABS.length];
    if (e.key === 'ArrowLeft') next = TABS[(i - 1 + TABS.length) % TABS.length];
    if (e.key === 'Home') next = TABS[0];
    if (e.key === 'End') next = TABS[TABS.length - 1];
    if (!next) return;
    e.preventDefault();
    setTab(next.key);
    const el = document.getElementById('st-tab-' + next.key);
    if (el) el.focus();
  }
  function showChannel(c) {
    setTab('channels');
    setTimeout(() => {
      const el = document.getElementById('st-ch-' + c.id);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); el.focus({ preventScroll: true }); }
    }, 60);
  }
  const tabCount = {
    calendar: posts.length || null,
    campaigns: campaigns.length || null,
    inbox: openInbox || null,
    channels: channels.length ? connectedCount + '/' + channels.length : null
  };

  function channelStatus(c) {
    if (c.connected) return { cls: 'is-live', label: tr('Syncs automatically') };
    if (c.connectable || OAUTH_PLATFORMS.includes(c.platform)) return { cls: 'is-ready', label: tr('Ready to connect') };
    return { cls: 'is-manual', label: tr('Logged by hand') };
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  const current = companies.find((c) => c.code === company);
  const logo = restaurantLogoUrl(company);

  return (
    <div className="soctrack">
      {error && <div className="error-banner" role="alert">{error}</div>}

      {companies.length > 1 && (
        <div className="st-companies" role="radiogroup" aria-label={tr('Company')}>
          {companies.map((co) => {
            const coLogo = restaurantLogoUrl(co.code);
            return (
              <button key={co.code} type="button" role="radio" aria-checked={co.code === company}
                className={'st-company' + (co.code === company ? ' is-current' : '')} onClick={() => switchCompany(co.code)}>
                {coLogo
                  ? <img className="st-company-logo" src={coLogo} alt="" />
                  : <span className="st-company-mark" style={{ background: avatarColor(co.name) }} aria-hidden="true">{initials(co.name)}</span>}
                <span className="st-company-text">
                  <span className="st-company-name">{co.name}</span>
                  <span className="st-company-sub">{tr('{n} channels', { n: co.channels })}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      <header className="st-hero">
        <div className="st-hero-id">
          {logo
            ? <img className="st-hero-logo" src={logo} alt="" />
            : <span className="st-hero-mark" style={{ background: avatarColor(companyName || company) }} aria-hidden="true">{initials(companyName || company)}</span>}
          <div>
            <p className="st-eyebrow">{tr('Social & campaign tracker')}</p>
            <h2 className="st-hero-title">{companyName || (current && current.name) || company}</h2>
            <p className="st-hero-sub">{tr('How this company is doing on social media and its website: who follows it, who sees its posts, and who is waiting for an answer.')}</p>
          </div>
        </div>
        <div className="st-hero-stats">
          <button type="button" className="st-hero-stat" onClick={() => setTab('channels')}>
            <strong>{connectedCount}<span>/{channels.length}</span></strong>
            <span>{tr('channels syncing automatically')}</span>
          </button>
          <button type="button" className={'st-hero-stat' + (openInbox ? ' is-alert' : '')} onClick={() => { setInboxFilter({ channelId: '', status: 'open', kind: '' }); setTab('inbox'); }}>
            <strong>{openInbox}</strong>
            <span>{openInbox === 1 ? tr('message waiting for a reply') : tr('messages waiting for a reply')}</span>
          </button>
          <button type="button" className="st-hero-stat" onClick={() => setTab('campaigns')}>
            <strong>{activeCampaigns}</strong>
            <span>{activeCampaigns === 1 ? tr('campaign running') : tr('campaigns running')}</span>
          </button>
        </div>
      </header>

      <div className="st-tabs" role="tablist" aria-label={tr('Social & campaign tracker')} onKeyDown={onTabKey}>
        {TABS.map((t) => (
          <button key={t.key} id={'st-tab-' + t.key} type="button" role="tab" aria-selected={tab === t.key} aria-controls="st-panel"
            tabIndex={tab === t.key ? 0 : -1} className={'st-tab' + (tab === t.key ? ' is-active' : '')} onClick={() => selectTab(t.key)}>
            <Icon name={t.key} />
            <span>{tr(t.label)}</span>
            {tabCount[t.key] !== null && tabCount[t.key] !== undefined && (
              <span className={'st-tab-count' + (t.key === 'inbox' ? ' is-alert' : '')}>{tabCount[t.key]}</span>
            )}
          </button>
        ))}
      </div>

      <div id="st-panel" role="tabpanel" aria-labelledby={'st-tab-' + tab} className="st-panel">

      {tab === 'overview' && dash && (
        <div className="st-overview">
          <div className="st-toolbar">
            <div>
              <h3 className="st-h3">{tr('Performance')}</h3>
              <p className="st-muted">{tr('Totals for the dates you pick, compared with the same number of days just before.')}</p>
            </div>
            <div className="st-toolbar-actions">
              <DateRangePicker value={dateRange} onChange={setDateRange} />
              <button type="button" className="btn btn-secondary" onClick={downloadOverviewCsv}>{tr('Download CSV')}</button>
              <button type="button" className="btn btn-secondary" disabled={exporting} onClick={downloadOverviewPdf}>
                {exporting ? tr('Preparing…') : tr('Download PDF')}
              </button>
            </div>
          </div>

          {setupLeft > 0 && (
            <section className="st-setup" aria-label={tr('Getting started')}>
              <div className="st-setup-head">
                <Icon name="spark" />
                <div>
                  <strong>{tr('Getting started')}</strong>
                  <span className="st-muted"> · {tr('{done} of {total} done', { done: setupSteps.length - setupLeft, total: setupSteps.length })}</span>
                </div>
              </div>
              <ol className="st-setup-steps">
                {setupSteps.map((st, i) => (
                  <li key={i} className={st.done ? 'is-done' : ''}>
                    <span className="st-setup-n" aria-hidden="true">{st.done ? <Icon name="check" /> : i + 1}</span>
                    <div>
                      <strong>{st.title}</strong>{st.done && <span className="st-sr"> — {tr('done')}</span>}
                      <p>{st.body}</p>
                      {!st.done && canManage && <button type="button" className="st-link" onClick={st.action}>{st.actionLabel} <Icon name="arrow" /></button>}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <div ref={overviewRef} className="st-overview-body">
            {metricsError && <div className="error-banner">{metricsError}</div>}
            {kpi && (
              <div className="st-kpis">
                {[
                  { key: 'followers', icon: 'people', label: tr('Followers'), help: tr('People following these channels, from the latest count.'), m: kpi.followers },
                  { key: 'reach', icon: 'eye', label: tr('Reach'), help: tr('How many times posts published in this period were seen.'), m: kpi.reach },
                  { key: 'interactions', icon: 'heart', label: tr('Interactions'), help: tr('Likes, comments and shares on those posts.'), m: kpi.interactions },
                  { key: 'posts', icon: 'post', label: tr('Posts published'), help: tr('Posts that went out in this period.'), m: kpi.posts }
                ].map((k) => (
                  <div key={k.key} className={'st-kpi st-kpi-' + k.key}>
                    <div className="st-kpi-top">
                      <span className="st-kpi-icon"><Icon name={k.icon} /></span>
                      <span className="st-kpi-label">{k.label}</span>
                    </div>
                    <div className="st-kpi-value">{num(k.m.value)}</div>
                    <Delta value={k.m.delta} pct={k.m.pct} days={rangeDays} />
                    <p className="st-kpi-help">{k.help}</p>
                  </div>
                ))}
              </div>
            )}

            {insights.length > 0 && (
              <section className="st-insights" aria-label={tr('What stands out')}>
                <h3 className="st-h3"><Icon name="spark" /> {tr('What stands out')}</h3>
                <ul>
                  {insights.slice(0, 6).map((it, i) => (
                    <li key={i} className={'st-insight is-' + it.tone}>
                      <span className="st-insight-icon"><Icon name={it.icon} /></span>
                      <span className="st-insight-text">{it.text}</span>
                      {it.action && <button type="button" className="st-link" onClick={it.action.run}>{it.action.label} <Icon name="arrow" /></button>}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {metrics && (
              <div className="soc-metrics-stack">
                <MetricSection title={tr('Followers')} hint={tr('The follower count of each channel over time. A line going up means the audience is growing.')} metric={metrics.metrics.followers} />
                <MetricSection title={tr('Reach')} hint={tr('How often posts were seen, by the day they were published: views on TikTok and YouTube, page views on the website.')} metric={metrics.metrics.reach} />
                <MetricSection title={tr('Interactions')} hint={tr('Likes, comments and shares together, by the day the post was published. This shows what people actually responded to.')} metric={metrics.metrics.interactions} />
                <MetricSection title={tr('Posts published')} hint={tr('How many posts went out each day. Steady posting usually brings steady growth.')} metric={metrics.metrics.posts} />
              </div>
            )}

            <div className="st-section-head">
              <h3 className="st-h3">{tr('Channels')}</h3>
              <p className="st-muted">{tr('All-time totals of published posts on each channel.')}</p>
            </div>
            <div className="st-channel-grid">
              {dash.channels.map((c) => {
                const status = channelStatus(c);
                return (
                  <article key={c.id} className="st-card st-channel-card">
                    <div className="st-card-top">
                      <PlatformIcon platform={c.platform} size={40} />
                      <div className="st-card-id">
                        <div className="st-card-name">{c.name}</div>
                        <div className="st-card-sub">{c.handle || tr('No handle added')}</div>
                      </div>
                      <span className={'st-status ' + status.cls}>{status.label}</span>
                    </div>
                    <div className="st-followers">
                      {c.followers !== null ? (
                        <>
                          <span className="st-followers-n">{num(c.followers)}</span>
                          <span className="st-followers-label">{c.platform === 'website' ? tr('active users') : tr('followers')}</span>
                          {c.followerChange !== null && c.followerChange !== 0 && (
                            <span className={'st-chip ' + (c.followerChange > 0 ? 'is-up' : 'is-down')}>{(c.followerChange > 0 ? '+' : '−') + num(Math.abs(c.followerChange))}</span>
                          )}
                          {c.followersAsOf && <span className="st-followers-asof">{tr('as of {date}', { date: fmtDate(c.followersAsOf) })}</span>}
                        </>
                      ) : <span className="st-muted">{tr('No follower count yet')}</span>}
                    </div>
                    <dl className="st-mini-stats">
                      <div><dt>{tr('Posts')}</dt><dd>{num(c.totals.posts)}</dd></div>
                      <div><dt>{tr('Likes')}</dt><dd>{num(c.totals.likes)}</dd></div>
                      <div><dt>{tr('Reach')}</dt><dd>{num(c.totals.reach)}</dd></div>
                      <div><dt>{tr('Clicks')}</dt><dd>{num(c.totals.clicks)}</dd></div>
                      {c.totals.leads > 0 && <div><dt>{tr('Leads')}</dt><dd>{num(c.totals.leads)}</dd></div>}
                    </dl>
                    <div className="st-card-foot">
                      {c.openInboxCount > 0 && (
                        <button type="button" className="st-pill-alert" onClick={() => { setInboxFilter({ channelId: c.id, status: 'open', kind: '' }); setTab('inbox'); }}>
                          <Icon name="chat" /> {tr('{openInboxCount} awaiting reply', { openInboxCount: c.openInboxCount })}
                        </button>
                      )}
                      <button type="button" className="st-link" onClick={() => showChannel(c)}>{tr('Manage')} <Icon name="arrow" /></button>
                    </div>
                  </article>
                );
              })}
            </div>

            <div className="st-section-head">
              <h3 className="st-h3">{tr('Campaigns')}</h3>
              <p className="st-muted">{tr('Results of the published posts tagged with each campaign.')}</p>
            </div>
            {dash.campaigns.length ? (
              <div className="st-campaign-grid">
                {dash.campaigns.map((c) => <CampaignCard key={c.id} c={c} totals={c.totals} />)}
              </div>
            ) : (
              <EmptyState icon="campaigns" title={tr('No campaigns yet')} body={tr('A campaign groups posts with one goal, like a new menu or a promotion, so you can see how it did as a whole.')} />
            )}

            <MarketingRecommendations key={company} company={company} onGenerated={setRecommendation} />
          </div>

          <details className="st-glossary">
            <summary><Icon name="info" /> {tr('What do these numbers mean?')}</summary>
            <dl>
              <div><dt>{tr('Followers')}</dt><dd>{tr('People who follow the channel. It comes from the latest count, synced or logged by hand; on the website it is the active users of the last 30 days.')}</dd></div>
              <div><dt>{tr('Reach')}</dt><dd>{tr('How many times posts were seen: views on TikTok and YouTube, page views on the website, reach on Facebook and Instagram.')}</dd></div>
              <div><dt>{tr('Interactions')}</dt><dd>{tr('Likes, comments and shares added together: how much people engaged, not just scrolled past.')}</dd></div>
              <div><dt>{tr('Clicks')}</dt><dd>{tr('Taps on a link in a post, for example to the website, menu or booking page.')}</dd></div>
              <div><dt>{tr('Leads')}</dt><dd>{tr('Enquiries, orders or bookings that came from a post, logged on the post.')}</dd></div>
              <div><dt>{tr('Syncs automatically')}</dt><dd>{tr('The channel is signed in to the company\'s own account; Sync now fetches the latest posts and follower count.')}</dd></div>
              <div><dt>{tr('Logged by hand')}</dt><dd>{tr('No automatic connection: posts and follower counts are typed in on the Content calendar and Channels tabs.')}</dd></div>
              <div><dt>{tr('The arrows')}</dt><dd>{tr('Each total is compared with the same number of days just before the dates you picked.')}</dd></div>
            </dl>
          </details>
        </div>
      )}

      {tab === 'calendar' && (
        <div className="st-stack">
          <div className="st-toolbar">
            <div>
              <h3 className="st-h3">{tr('Content calendar')}</h3>
              <p className="st-muted">{tr('Every post: planned, scheduled and published, newest first, with how each one did.')}</p>
            </div>
            {canManage && <button type="button" className="btn btn-primary" onClick={openNewPost}>{tr('New post')}</button>}
          </div>
          <div className="st-filters">
            <label className="st-filter">
              <span>{tr('Channel')}</span>
              <select className="input" value={calendarFilter.channelId} onChange={(e) => setCalendarFilter({ ...calendarFilter, channelId: e.target.value })}>
                <option value="">{tr('All channels')}</option>
                {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="st-filter">
              <span>{tr('Campaign')}</span>
              <select className="input" value={calendarFilter.campaignId} onChange={(e) => setCalendarFilter({ ...calendarFilter, campaignId: e.target.value })}>
                <option value="">{tr('All campaigns')}</option>
                {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <div className="st-segment" role="group" aria-label={tr('Status')}>
              {[{ value: '', label: msg('All') }, ...POST_STATUSES].map((st) => (
                <button key={st.value || 'all'} type="button" aria-pressed={calendarFilter.status === st.value}
                  className={calendarFilter.status === st.value ? 'is-on' : ''} onClick={() => setCalendarFilter({ ...calendarFilter, status: st.value })}>
                  {tr(st.label)}
                </button>
              ))}
            </div>
          </div>

          {posts.length ? (
            (() => {
              const groups = [];
              posts.forEach((p) => {
                const k = monthKey(p.publishedAt || p.scheduledAt);
                let g = groups.find((x) => x.key === k);
                if (!g) { g = { key: k, items: [] }; groups.push(g); }
                g.items.push(p);
              });
              return groups.map((g) => (
                <section key={g.key || 'none'} className="st-month">
                  <h4 className="st-month-title">{monthLabel(g.key)} <span className="st-muted">· {g.items.length === 1 ? tr('1 post') : tr('{n} posts', { n: g.items.length })}</span></h4>
                  <ul className="st-post-list">
                    {g.items.map((p) => {
                      const when = p.publishedAt || p.scheduledAt;
                      const ch = channels.find((c) => c.id === p.channelId);
                      return (
                        <li key={p.id} className="st-post">
                          <div className="st-post-date" aria-hidden="true">
                            {when ? (
                              <>
                                <span className="st-post-day">{new Date(when.length > 10 ? when : when + 'T00:00').getDate()}</span>
                                <span className="st-post-mon">{new Date(when.length > 10 ? when : when + 'T00:00').toLocaleDateString(activeIntlLocale(), { month: 'short' })}</span>
                              </>
                            ) : <span className="st-post-mon">—</span>}
                          </div>
                          <PlatformIcon platform={ch ? ch.platform : 'website'} size={34} />
                          <div className="st-post-main">
                            <div className="st-post-title">{p.title}</div>
                            <div className="st-post-meta">
                              {p.channelName}{p.campaignName ? ' · ' + p.campaignName : ''}{when ? ' · ' + fmtDate(when) : ''}
                            </div>
                            {p.status === 'published' ? (
                              <dl className="st-post-stats">
                                <div><dt>{tr('Likes')}</dt><dd>{num(p.likes)}</dd></div>
                                <div><dt>{tr('Comments')}</dt><dd>{num(p.comments)}</dd></div>
                                <div><dt>{tr('Shares')}</dt><dd>{num(p.shares)}</dd></div>
                                <div><dt>{tr('Reach')}</dt><dd>{num(p.reach)}</dd></div>
                                <div><dt>{tr('Clicks')}</dt><dd>{num(p.clicks)}</dd></div>
                                {p.leads > 0 && <div><dt>{tr('Leads')}</dt><dd>{num(p.leads)}</dd></div>}
                              </dl>
                            ) : (
                              <p className="st-post-note">{p.status === 'failed' ? tr('Did not go out. Edit it to try again or mark it published.') : tr('Not published yet: numbers appear once it is.')}</p>
                            )}
                          </div>
                          <span className={'st-status is-' + p.status}>{codeLabel(p.status)}</span>
                          <div className="st-post-menu" onClick={(e) => e.stopPropagation()}>
                            <RowMenu actions={[
                              { label: tr('Edit'), onClick: () => openEditPost(p), hidden: !(canManage) },
                              { label: tr('Delete'), onClick: () => removePost(p), danger: true, hidden: !(canManage) },
                            ]} />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ));
            })()
          ) : (
            <EmptyState icon="calendar" title={tr('No posts logged yet')}
              body={calendarFilter.channelId || calendarFilter.campaignId || calendarFilter.status ? tr('Nothing matches these filters.') : tr('Add the posts you plan and publish, or connect a channel on the Channels tab to bring them in.')}
              action={canManage ? { label: tr('New post'), run: openNewPost } : null} />
          )}
        </div>
      )}

      {tab === 'campaigns' && (
        <div className="st-stack">
          <div className="st-toolbar">
            <div>
              <h3 className="st-h3">{tr('Campaigns')}</h3>
              <p className="st-muted">{tr('Group posts under one goal and dates. Tag a post with its campaign when you log it.')}</p>
            </div>
            {canManage && <button type="button" className="btn btn-primary" onClick={openNewCampaign}>{tr('New campaign')}</button>}
          </div>
          {campaigns.length ? (
            <div className="st-campaign-grid">
              {campaigns.map((c) => {
                const withTotals = dash && dash.campaigns.find((x) => x.id === c.id);
                return <CampaignCard key={c.id} c={c} totals={withTotals ? withTotals.totals : null} onEdit={canManage ? () => openEditCampaign(c) : null} />;
              })}
            </div>
          ) : (
            <EmptyState icon="campaigns" title={tr('No campaigns yet')} body={tr('A campaign groups posts with one goal, like a new menu or a promotion, so you can see how it did as a whole.')}
              action={canManage ? { label: tr('New campaign'), run: openNewCampaign } : null} />
          )}
        </div>
      )}

      {tab === 'inbox' && (
        <div className="st-stack">
          <div className="st-toolbar">
            <div>
              <h3 className="st-h3">{tr('Inbox')}</h3>
              <p className="st-muted">{tr('Comments and messages people sent, so nobody is left without an answer.')}</p>
            </div>
            {canManage && <button type="button" className="btn btn-primary" onClick={openNewInboxItem}>{tr('Log incoming')}</button>}
          </div>
          <div className="st-callout">
            <Icon name="info" />
            <p>{tr('Comments and messages logged here are tracked in Bamboo OS — a reply you send below is recorded as the reply, but doesn\'t post back to Facebook/Instagram/TikTok/WhatsApp itself yet (that needs the channel\'s live API connected first). Until then, send your reply on the actual platform and record it here.')}</p>
          </div>
          <div className="st-filters">
            <div className="st-segment" role="group" aria-label={tr('Status')}>
              {[{ value: 'open', label: msg('Waiting') }, { value: 'replied', label: msg('Replied') }, { value: 'archived', label: msg('Archived') }, { value: '', label: msg('All') }].map((st) => (
                <button key={st.value || 'all'} type="button" aria-pressed={inboxFilter.status === st.value}
                  className={inboxFilter.status === st.value ? 'is-on' : ''} onClick={() => setInboxFilter({ ...inboxFilter, status: st.value })}>
                  {tr(st.label)}{st.value === 'open' && openInbox > 0 ? ' (' + openInbox + ')' : ''}
                </button>
              ))}
            </div>
            <label className="st-filter">
              <span>{tr('Channel')}</span>
              <select className="input" value={inboxFilter.channelId} onChange={(e) => setInboxFilter({ ...inboxFilter, channelId: e.target.value })}>
                <option value="">{tr('All channels')}</option>
                {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label className="st-filter">
              <span>{tr('Type')}</span>
              <select className="input" value={inboxFilter.kind} onChange={(e) => setInboxFilter({ ...inboxFilter, kind: e.target.value })}>
                <option value="">{tr('Comments & messages')}</option>
                {INBOX_KINDS.map((k) => <option key={k.value} value={k.value}>{tr(k.label)}</option>)}
              </select>
            </label>
          </div>

          {inboxItems.length ? (
            <ul className="st-inbox-list">
              {inboxItems.map((item) => {
                const ch = channels.find((c) => c.id === item.channelId);
                return (
                  <li key={item.id} className={'st-card st-inbox-item is-' + item.status}>
                    <div className="st-inbox-top">
                      <span className="st-avatar" style={{ background: avatarColor(item.authorName || 'Unknown') }} aria-hidden="true">{initials(item.authorName || tr('Unknown'))}</span>
                      <div className="st-inbox-who">
                        <div className="st-inbox-name">
                          {item.authorName || tr('Unknown')} {item.authorHandle && <span className="st-muted">{item.authorHandle}</span>}
                        </div>
                        <div className="st-inbox-meta">
                          {ch && <PlatformIcon platform={ch.platform} size={18} className="is-inline" />}
                          {trNodes('{kind} on {channel}', {
                            kind: <span>{item.kind === 'comment' ? tr('Comment') : tr('Message')}</span>,
                            channel: <strong>{item.channelName}</strong>
                          })}
                          {item.postTitle && <span> · {item.postTitle}</span>}
                          <span> · {fmtDate(item.receivedAt)}</span>
                        </div>
                      </div>
                      <span className={'st-status is-' + item.status}>{item.status === 'open' ? tr('Waiting') : codeLabel(item.status)}</span>
                    </div>
                    <p className="st-inbox-body">{item.body}</p>

                    {item.status === 'replied' ? (
                      <div className="st-inbox-reply">
                        <div className="st-inbox-reply-label">{tr('Reply ·')} {item.repliedByName} · {fmtDate(item.repliedAt)}</div>
                        <p>{item.replyBody}</p>
                        {canManage && <button type="button" className="btn btn-secondary st-btn-sm" disabled={busyInboxId === item.id} onClick={() => reopenInboxItem(item)}>{tr('Reopen')}</button>}
                      </div>
                    ) : item.status === 'open' && canManage ? (
                      <div className="st-inbox-form">
                        <label className="st-sr" htmlFor={'reply-' + item.id}>{tr('Write a reply…')}</label>
                        <textarea id={'reply-' + item.id} className="input" placeholder={tr('Write a reply…')} value={replyDrafts[item.id] || ''} onChange={(e) => setReplyDrafts({ ...replyDrafts, [item.id]: e.target.value })} />
                        <div className="st-inbox-actions">
                          <button type="button" className="btn btn-primary st-btn-sm" disabled={busyInboxId === item.id} onClick={() => sendReply(item)}>{tr('Reply')}</button>
                          <button type="button" className="btn btn-secondary st-btn-sm" disabled={busyInboxId === item.id} onClick={() => archiveInboxItem(item)}>{tr('Archive')}</button>
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState icon="inbox" title={inboxFilter.status === 'open' ? tr('All caught up') : tr('Nothing logged yet')}
              body={inboxFilter.status === 'open' ? tr('No comment or message is waiting for a reply.') : tr('Log a comment or message here when one comes in, then record your reply.')} />
          )}
        </div>
      )}

      {tab === 'channels' && (
        <div className="st-stack">
          <div className="st-toolbar">
            <div>
              <h3 className="st-h3">{tr('Channels')}</h3>
              <p className="st-muted">{tr('Where {company} is online. Connect a channel to sync its numbers, or log them by hand.', { company: companyName || company })}</p>
            </div>
          </div>
          <div className="st-legend" aria-label={tr('What the labels mean')}>
            <span><span className="st-status is-live">{tr('Syncs automatically')}</span> {tr('numbers come in from the platform')}</span>
            <span><span className="st-status is-ready">{tr('Ready to connect')}</span> {tr('can sync once someone signs in')}</span>
            <span><span className="st-status is-manual">{tr('Logged by hand')}</span> {tr('no automatic connection')}</span>
          </div>
          <div className="st-channel-list">
            {channels.map((c) => {
              const draft = channelDraft(c);
              const statDraft = statDrafts[c.id] || { capturedOn: '', followers: '' };
              const history = statHistory[c.id];
              const status = channelStatus(c);
              const summary = dash && dash.channels.find((x) => x.id === c.id);
              return (
                <article key={c.id} id={'st-ch-' + c.id} tabIndex={-1} className="st-card st-channel-row">
                  <div className="st-card-top">
                    <PlatformIcon platform={c.platform} size={44} />
                    <div className="st-card-id">
                      <div className="st-card-name">{c.name}</div>
                      <div className="st-card-sub">{c.handle || codeLabel(c.kind)}</div>
                    </div>
                    <span className={'st-status ' + status.cls}>{status.label}</span>
                  </div>

                  <p className="st-channel-explain">
                    {c.connected
                      ? tr('Numbers come from {name} itself. Press Sync now any time for the latest posts and follower count.', { name: c.name })
                      : c.connectable
                        ? (c.platform === 'website'
                          ? tr('Connects to Google Analytics when {setting} is set on the server.', { setting: company === 'BPL' ? 'GA4_PROPERTY_ID' : 'GA4_PROPERTY_ID_' + company })
                          : (c.platform === 'facebook' || c.platform === 'instagram')
                            ? tr('Facebook and Instagram connect together: sign in, then pick this company\'s Page.')
                            : tr('Sign in to {name} once and its numbers sync automatically. Until then, log them by hand below.', { name: c.name }))
                        : tr('{name} has no automatic connection. Log its posts on the Content calendar and its follower count below.', { name: c.name })}
                  </p>

                  {summary && (
                    <dl className="st-mini-stats">
                      <div><dt>{c.platform === 'website' ? tr('Active users') : tr('Followers')}</dt><dd>{summary.followers !== null ? num(summary.followers) : '—'}</dd></div>
                      <div><dt>{tr('Posts')}</dt><dd>{num(summary.totals.posts)}</dd></div>
                      <div><dt>{tr('Reach')}</dt><dd>{num(summary.totals.reach)}</dd></div>
                      <div><dt>{tr('Waiting')}</dt><dd>{num(summary.openInboxCount)}</dd></div>
                    </dl>
                  )}

                  {canManage && (SYNC_PATH[c.platform] || OAUTH_PLATFORMS.includes(c.platform)) && (c.connected || OAUTH_PLATFORMS.includes(c.platform)) && (
                    <div className="st-channel-actions">
                      {c.connected && SYNC_PATH[c.platform] && (
                        <button type="button" className="btn btn-primary st-btn-sm" disabled={!!syncingKey} onClick={() => syncChannel(c)}>
                          <Icon name="sync" /> {syncingKey === c.key ? tr('Syncing…') : tr('Sync now')}
                        </button>
                      )}
                      {!c.connected && OAUTH_PLATFORMS.includes(c.platform) && (
                        <button type="button" className="btn btn-primary st-btn-sm" disabled={!!syncingKey} onClick={() => connectChannel(c)}>
                          {syncingKey === c.key ? tr('Opening…') : tr('Connect {name}', { name: c.name })}
                        </button>
                      )}
                      {c.connected && OAUTH_PLATFORMS.includes(c.platform) && (
                        <button type="button" className="btn btn-secondary st-btn-sm" disabled={!!syncingKey} onClick={() => disconnectChannel(c)}>{tr('Disconnect')}</button>
                      )}
                    </div>
                  )}

                  <details className="st-disclosure">
                    <summary>{tr('Handle and notes')}</summary>
                    {canManage ? (
                      <div className="st-channel-fields">
                        <div className="field">
                          <label htmlFor={'ch-handle-' + c.id}>{tr('Handle / URL')}</label>
                          <input id={'ch-handle-' + c.id} className="input" value={draft.handle} onChange={(e) => setChannelDrafts({ ...channelDrafts, [c.id]: { ...draft, handle: e.target.value } })} />
                        </div>
                        <div className="field">
                          <label htmlFor={'ch-notes-' + c.id}>{tr('Notes')}</label>
                          <input id={'ch-notes-' + c.id} className="input" value={draft.notes} onChange={(e) => setChannelDrafts({ ...channelDrafts, [c.id]: { ...draft, notes: e.target.value } })} />
                        </div>
                        <button type="button" className="btn btn-secondary" disabled={busyChannelId === c.id} onClick={() => saveChannel(c)}>{tr('Save')}</button>
                      </div>
                    ) : (
                      <div className="st-channel-readonly">
                        <div>{c.handle || '—'}</div>
                        {c.notes && <div className="st-muted">{c.notes}</div>}
                      </div>
                    )}
                  </details>

                  <details className="st-disclosure" onToggle={(e) => { if (e.currentTarget.open && !history) loadStatHistory(c); }}>
                    <summary>{c.platform === 'website' ? tr('Visitor log') : tr('Follower log')}</summary>
                    {canManage && (
                      <div className="st-stat-form">
                        <label className="st-filter">
                          <span>{tr('Date')}</span>
                          <input className="input" type="date" value={statDraft.capturedOn} onChange={(e) => setStatDrafts({ ...statDrafts, [c.id]: { ...statDraft, capturedOn: e.target.value } })} />
                        </label>
                        <label className="st-filter">
                          <span>{tr('Follower count')}</span>
                          <input className="input" type="number" min="0" value={statDraft.followers} onChange={(e) => setStatDrafts({ ...statDrafts, [c.id]: { ...statDraft, followers: e.target.value } })} />
                        </label>
                        <button type="button" className="btn btn-secondary" disabled={busyChannelId === c.id} onClick={() => logStat(c)}>{tr('Log')}</button>
                      </div>
                    )}
                    {!history ? <p className="st-muted">{tr('Loading…')}</p> : history.length ? (
                      <table className="table st-stat-table">
                        <thead><tr><th>{tr('Date')}</th><th>{tr('Followers')}</th></tr></thead>
                        <tbody>
                          {history.slice().reverse().map((h) => <tr key={h.id}><td>{fmtDate(h.capturedOn)}</td><td>{num(h.followers)}</td></tr>)}
                        </tbody>
                      </table>
                    ) : <p className="st-muted">{tr('No entries logged yet.')}</p>}
                  </details>
                </article>
              );
            })}
          </div>
        </div>
      )}
      </div>

      {postDialogOpen && (
        <div className="dialog-backdrop" onClick={() => setPostDialogOpen(false)}>
          <form className="dialog soctrack-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitPost}>
            <h2 className="soctrack-dialog-title">{editingPostId ? tr('Edit post') : tr('New post')}</h2>
            {postError && <div className="error-banner soctrack-dialog-span">{postError}</div>}

            <div className="field">
              <label htmlFor="post-channel">{tr('Channel')}</label>
              <select id="post-channel" className="input" value={postForm.channelId} onChange={(e) => setPostForm({ ...postForm, channelId: e.target.value })} required>
                {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="post-campaign">{tr('Campaign (optional)')}</label>
              <select id="post-campaign" className="input" value={postForm.campaignId} onChange={(e) => setPostForm({ ...postForm, campaignId: e.target.value })}>
                <option value="">{tr('None')}</option>
                {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="field soctrack-dialog-span">
              <label htmlFor="post-title">{tr('Title')}</label>
              <input id="post-title" className="input" value={postForm.title} onChange={(e) => setPostForm({ ...postForm, title: e.target.value })} required />
            </div>
            <div className="field soctrack-dialog-span">
              <label htmlFor="post-caption">{tr('Caption / notes')}</label>
              <textarea id="post-caption" className="input" value={postForm.caption} onChange={(e) => setPostForm({ ...postForm, caption: e.target.value })} />
            </div>
            <div className="field soctrack-dialog-span">
              <label htmlFor="post-media">{tr('Media URL (optional)')}</label>
              <input id="post-media" className="input" value={postForm.mediaUrl} onChange={(e) => setPostForm({ ...postForm, mediaUrl: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="post-status">{tr('Status')}</label>
              <select id="post-status" className="input" value={postForm.status} onChange={(e) => setPostForm({ ...postForm, status: e.target.value })}>
                {POST_STATUSES.map((s) => <option key={s.value} value={s.value}>{tr(s.label)}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="post-scheduled">{tr('Scheduled for')}</label>
              <input id="post-scheduled" className="input" type="datetime-local" value={postForm.scheduledAt} onChange={(e) => setPostForm({ ...postForm, scheduledAt: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="post-published">{tr('Published at')}</label>
              <input id="post-published" className="input" type="datetime-local" value={postForm.publishedAt} onChange={(e) => setPostForm({ ...postForm, publishedAt: e.target.value })} />
            </div>

            <div className="soctrack-dialog-span soctrack-section-title-inline">{tr('Engagement')}</div>
            <div className="field"><label>{tr('Likes')}</label><input className="input" type="number" min="0" value={postForm.likes} onChange={(e) => setPostForm({ ...postForm, likes: e.target.value })} /></div>
            <div className="field"><label>{tr('Comments')}</label><input className="input" type="number" min="0" value={postForm.comments} onChange={(e) => setPostForm({ ...postForm, comments: e.target.value })} /></div>
            <div className="field"><label>{tr('Shares')}</label><input className="input" type="number" min="0" value={postForm.shares} onChange={(e) => setPostForm({ ...postForm, shares: e.target.value })} /></div>
            <div className="field"><label>{tr('Reach')}</label><input className="input" type="number" min="0" value={postForm.reach} onChange={(e) => setPostForm({ ...postForm, reach: e.target.value })} /></div>
            <div className="field"><label>{tr('Impressions')}</label><input className="input" type="number" min="0" value={postForm.impressions} onChange={(e) => setPostForm({ ...postForm, impressions: e.target.value })} /></div>
            <div className="field"><label>{tr('Clicks')}</label><input className="input" type="number" min="0" value={postForm.clicks} onChange={(e) => setPostForm({ ...postForm, clicks: e.target.value })} /></div>
            <div className="field"><label>{tr('Leads')}</label><input className="input" type="number" min="0" value={postForm.leads} onChange={(e) => setPostForm({ ...postForm, leads: e.target.value })} /></div>

            <div className="dialog-actions soctrack-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setPostDialogOpen(false)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={savingPost}>{savingPost ? tr('Saving…') : tr('Save post')}</button>
            </div>
          </form>
        </div>
      )}

      {campaignDialogOpen && (
        <div className="dialog-backdrop" onClick={() => setCampaignDialogOpen(false)}>
          <form className="dialog soctrack-campaign-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitCampaign}>
            <h2 className="soctrack-dialog-title">{editingCampaignId ? tr('Edit campaign') : tr('New campaign')}</h2>
            {campaignError && <div className="error-banner soctrack-dialog-span">{campaignError}</div>}

            <div className="field soctrack-dialog-span">
              <label htmlFor="camp-name">{tr('Name')}</label>
              <input id="camp-name" className="input" value={campaignForm.name} onChange={(e) => setCampaignForm({ ...campaignForm, name: e.target.value })} required />
            </div>
            <div className="field soctrack-dialog-span">
              <label htmlFor="camp-desc">{tr('Description')}</label>
              <textarea id="camp-desc" className="input" value={campaignForm.description} onChange={(e) => setCampaignForm({ ...campaignForm, description: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="camp-start">{tr('Start date')}</label>
              <input id="camp-start" className="input" type="date" value={campaignForm.startDate} onChange={(e) => setCampaignForm({ ...campaignForm, startDate: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="camp-end">{tr('End date')}</label>
              <input id="camp-end" className="input" type="date" value={campaignForm.endDate} onChange={(e) => setCampaignForm({ ...campaignForm, endDate: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="camp-status">{tr('Status')}</label>
              <select id="camp-status" className="input" value={campaignForm.status} onChange={(e) => setCampaignForm({ ...campaignForm, status: e.target.value })}>
                {CAMPAIGN_STATUSES.map((s) => <option key={s.value} value={s.value}>{tr(s.label)}</option>)}
              </select>
            </div>

            <div className="dialog-actions soctrack-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setCampaignDialogOpen(false)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={savingCampaign}>{savingCampaign ? tr('Saving…') : tr('Save campaign')}</button>
            </div>
          </form>
        </div>
      )}

      {inboxDialogOpen && (
        <div className="dialog-backdrop" onClick={() => setInboxDialogOpen(false)}>
          <form className="dialog soctrack-campaign-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitInboxItem}>
            <h2 className="soctrack-dialog-title">{tr('Log an incoming comment or message')}</h2>
            {inboxError && <div className="error-banner soctrack-dialog-span">{inboxError}</div>}

            <div className="field">
              <label htmlFor="ib-channel">{tr('Channel')}</label>
              <select id="ib-channel" className="input" value={inboxForm.channelId} onChange={(e) => setInboxForm({ ...inboxForm, channelId: e.target.value, postId: '' })} required>
                {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="ib-kind">{tr('Type')}</label>
              <select id="ib-kind" className="input" value={inboxForm.kind} onChange={(e) => setInboxForm({ ...inboxForm, kind: e.target.value, postId: e.target.value === 'message' ? '' : inboxForm.postId })}>
                {INBOX_KINDS.map((k) => <option key={k.value} value={k.value}>{tr(k.label)}</option>)}
              </select>
            </div>
            {inboxForm.kind === 'comment' && (
              <div className="field soctrack-dialog-span">
                <label htmlFor="ib-post">{tr('On which post (optional)')}</label>
                <select id="ib-post" className="input" value={inboxForm.postId} onChange={(e) => setInboxForm({ ...inboxForm, postId: e.target.value })}>
                  <option value="">{tr('Not tied to a specific post')}</option>
                  {allPosts.filter((p) => p.channelId === inboxForm.channelId).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                </select>
              </div>
            )}
            <div className="field">
              <label htmlFor="ib-author-name">{tr('From (name)')}</label>
              <input id="ib-author-name" className="input" value={inboxForm.authorName} onChange={(e) => setInboxForm({ ...inboxForm, authorName: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="ib-author-handle">{tr('Handle / phone')}</label>
              <input id="ib-author-handle" className="input" value={inboxForm.authorHandle} onChange={(e) => setInboxForm({ ...inboxForm, authorHandle: e.target.value })} />
            </div>
            <div className="field soctrack-dialog-span">
              <label htmlFor="ib-body">{tr('What they wrote')}</label>
              <textarea id="ib-body" className="input" value={inboxForm.body} onChange={(e) => setInboxForm({ ...inboxForm, body: e.target.value })} required />
            </div>

            <div className="dialog-actions soctrack-dialog-span">
              <button type="button" className="btn btn-secondary" onClick={() => setInboxDialogOpen(false)}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={savingInbox}>{savingInbox ? tr('Saving…') : tr('Log it')}</button>
            </div>
          </form>
        </div>
      )}

      {pagePickerOpen && (
        <div className="dialog-backdrop" onClick={() => setPagePickerOpen(false)}>
          <div className="dialog soctrack-page-dialog" onClick={(e) => e.stopPropagation()}>
            <h2 className="soctrack-dialog-title">{tr('Choose a Facebook Page to connect')}</h2>
            <p className="soctrack-dialog-note">
              {tr('Pick the Page for {company}. Its linked Instagram account (if any) connects automatically at the same time.', { company: companyName || 'Bamboo Products Limited' })}
            </p>
            {pagePickerError && <div className="error-banner">{pagePickerError}</div>}
            {pagePickerLoading ? (
              <div className="eyebrow">{tr('Loading pages…')}</div>
            ) : (
              <div className="soctrack-page-list">
                {pagePickerPages.map((p) => (
                  <div key={p.id} className="soctrack-page-row">
                    <div>
                      <div className="soctrack-channel-name">{p.name}</div>
                      <div className="soctrack-channel-handle">{p.hasInstagram ? tr('Instagram linked: @{instagramUsername}', { instagramUsername: p.instagramUsername }) : tr('No Instagram account linked')}</div>
                    </div>
                    <button type="button" className="btn btn-primary soctrack-row-btn" disabled={!!connectingPageId} onClick={() => connectPage(p)}>
                      {connectingPageId === p.id ? tr('Connecting…') : tr('Connect')}
                    </button>
                  </div>
                ))}
                {!pagePickerPages.length && <p className="table-empty">{tr('No Facebook Pages found for this account.')}</p>}
              </div>
            )}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setPagePickerOpen(false)}>{tr('Cancel')}</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
