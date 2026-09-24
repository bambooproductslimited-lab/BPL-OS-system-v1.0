import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import Icon from '../layout/navIcons';
import { playNotification, isMuted, setMuted } from '../lib/notificationSound';
import { pushSupported, permissionState, iosNeedsInstall, enablePush, disablePush, isEnabledHere, sendTestPush } from '../lib/pushNotifications';
import { tr, activeIntlLocale } from '../lib/i18n.jsx';
import './NotificationsBell.css';

// The header bell + dropdown from the design prototype (Bamboo OS.dc.html's
// toggleNotif/closeNotif/markAllRead/openNotification handlers) — the real
// backend side of this (GET/POST /api/notifications, and every service that
// calls utils/notify.js's notify()) already existed; this was the missing
// piece; there was never a frontend for it.
//
// No websocket/push in this app, so freshness is a plain poll — 45s is
// often enough to feel live without hammering the API.
const POLL_MS = 45000;

// Newest notification timestamp this session has already accounted for.
// The chime fires when an UNREAD notification arrives that is newer than
// this — tracked by time rather than by counting unread items, because the
// count also moves when things are marked read, and by timestamp rather
// than by remembering ids, because /api/notifications returns every
// notification an employee has ever had and that set only grows.
//
// It is seeded on the very first poll without playing anything: opening the
// OS to a backlog of yesterday's notifications should not set off a chime,
// only something actually arriving while you are sitting there.

function timeAgo(iso) {
  var diffMs = Date.now() - new Date(iso).getTime();
  var mins = Math.floor(diffMs / 60000);
  if (mins < 1) return tr('just now');
  if (mins < 60) return tr('{mins}m ago', { mins });
  var hours = Math.floor(mins / 60);
  if (hours < 24) return tr('{hours}h ago', { hours });
  var days = Math.floor(hours / 24);
  if (days < 7) return tr('{days}d ago', { days });
  return new Date(iso).toLocaleDateString(activeIntlLocale(), { day: '2-digit', month: 'short' });
}

export default function NotificationsBell() {
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [muted, setMutedState] = useState(isMuted);
  // Pop-up (Web Push) state for THIS device: 'off' | 'on' | 'denied' |
  // 'unsupported' | 'ios-install' | 'busy'.
  const [popups, setPopups] = useState('off');
  const [testSent, setTestSent] = useState('');
  const newestSeenRef = useRef(0);
  // Read by the poll, which is a stable callback and so cannot see the
  // popups state directly.
  const popupsOnRef = useRef(false);
  const primedRef = useRef(false);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    let next;
    try { next = await api.get('/notifications'); } catch { return; } // silent — a failed poll shouldn't surface an error banner
    setItems(next);

    const newestUnread = next.reduce(
      (max, n) => (!n.read ? Math.max(max, new Date(n.at).getTime()) : max), 0
    );
    // Exactly one alert per notification. Where this device has pop-up
    // alerts on, the operating system has already made its own sound for
    // this one and the in-app chime would just double it up.
    if (primedRef.current && newestUnread > newestSeenRef.current && !popupsOnRef.current) playNotification();
    primedRef.current = true;
    if (newestUnread > newestSeenRef.current) newestSeenRef.current = newestUnread;
  }, []);

  useEffect(() => { load(); }, [load]);

  // What this device's pop-up situation actually is. Permission alone does
  // not settle it: site data can be cleared without the permission being
  // revoked, leaving permission granted and no subscription.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (iosNeedsInstall()) { if (!cancelled) setPopups('ios-install'); return; }
      if (!pushSupported()) { if (!cancelled) setPopups('unsupported'); return; }
      if (permissionState() === 'denied') { if (!cancelled) setPopups('denied'); return; }
      const here = await isEnabledHere();
      if (!cancelled) setPopups(here ? 'on' : 'off');
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { popupsOnRef.current = popups === 'on'; }, [popups]);

  // Tapping a pop-up asks the service worker to open the right screen; it
  // messages whichever window it found rather than reloading it, so the
  // session and scroll position survive. See public/sw.js.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    function onMessage(event) {
      const data = event.data;
      if (data && data.type === 'bamboo-open' && typeof data.path === 'string') navigate(data.path);
    }
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate]);

  useEffect(() => {
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const unreadCount = items.filter((n) => !n.read).length;

  function handleOpen() {
    setOpen(true);
    load(); // refresh right as the panel opens, not just on the timer
  }

  // Pop-up alerts on this device. Both directions have to happen from the
  // click itself — no browser will prompt for notification permission from
  // anywhere but a real user gesture.
  async function togglePopups() {
    setTestSent('');
    if (popups === 'on') {
      setPopups('busy');
      await disablePush();
      setPopups('off');
      return;
    }
    setPopups('busy');
    const result = await enablePush();
    setPopups(result === 'on' ? 'on' : result === 'denied' ? 'denied' : 'off');
  }

  async function testPopup() {
    setTestSent(tr('Sending…'));
    try {
      await sendTestPush();
      setTestSent(tr('Sent — it should appear shortly.'));
    } catch {
      setTestSent(tr('Could not send a test to this device.'));
    }
  }

  // Flipping the sound back on plays the chime once, so whoever just
  // turned it on hears what they have signed up for (and finds out
  // immediately if the device's volume is down).
  function toggleMuted() {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
    if (!next) playNotification();
  }

  async function markAllRead() {
    await api.post('/notifications/read', {});
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
  }

  async function openNotification(n) {
    if (!n.read) {
      api.post('/notifications/read', { id: n.id }).catch(() => {});
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
    }
    setOpen(false);
    if (!n.link) return;
    const [kind, id] = n.link.split(':');
    if (kind === 'message') navigate('/messages?peer=' + id);
    else if (kind === 'chat') navigate('/messages?chat=' + id);
    else navigate('/' + kind);
  }

  return (
    <div className="notif-bell">
      <button type="button" className="btn btn-secondary notif-bell-btn" onClick={handleOpen} aria-label={tr('Notifications')}>
        <span className="notif-bell-icon"><Icon name="bell" /></span>
        {unreadCount > 0 && <span className="notif-bell-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>}
      </button>

      {open && (
        <>
          <div className="notif-backdrop" onClick={() => setOpen(false)} />
          <div className="notif-panel">
            <div className="notif-panel-head">
              <span className="notif-panel-title">{tr('Notifications')}</span>
              <span className="notif-panel-tools">
                <button
                  type="button"
                  className={'notif-mute' + (muted ? ' notif-mute-off' : '')}
                  onClick={toggleMuted}
                  aria-pressed={!muted}
                  title={muted ? tr('Notification sound is off — turn it on') : tr('Notification sound is on — turn it off')}
                >
                  {muted ? tr('Sound off') : tr('Sound on')}
                </button>
                {unreadCount > 0 && (
                  <button type="button" className="notif-markall" onClick={markAllRead}>{tr('Mark all read')}</button>
                )}
              </span>
            </div>
            <div className="notif-popups">
              {popups === 'ios-install' ? (
                <p className="notif-popups-note">
                  {tr('To get pop-up alerts on an iPhone or iPad, add Bamboo OS to your Home Screen first: tap Share, then Add to Home Screen, and open it from there. Apple only allows them for an installed app.')}
                </p>
              ) : popups === 'unsupported' ? (
                <p className="notif-popups-note">{tr("This browser can't show pop-up alerts.")}</p>
              ) : popups === 'denied' ? (
                <p className="notif-popups-note">
                  {tr('Pop-up alerts are blocked for this site. Allow notifications for Bamboo OS in your browser settings, then come back here.')}
                </p>
              ) : (
                <>
                  <button
                    type="button"
                    className={'notif-popups-toggle' + (popups === 'on' ? ' notif-popups-on' : '')}
                    onClick={togglePopups}
                    disabled={popups === 'busy'}
                    aria-pressed={popups === 'on'}
                  >
                    {popups === 'busy' ? tr('Working…')
                      : popups === 'on' ? tr('Pop-up alerts are on for this device')
                      : tr('Turn on pop-up alerts for this device')}
                  </button>
                  {popups === 'on' && (
                    <button type="button" className="notif-popups-test" onClick={testPopup}>{tr('Send a test')}</button>
                  )}
                </>
              )}
              {testSent && <span className="notif-popups-sent">{testSent}</span>}
            </div>
            <div className="notif-list">
              {items.slice(0, 8).map((n) => (
                <button
                  type="button"
                  key={n.id}
                  className={'notif-item' + (n.link ? '' : ' notif-item-static') + (n.read ? '' : ' notif-item-unread')}
                  onClick={() => openNotification(n)}
                  disabled={!n.link}
                >
                  <div className="notif-item-title">{n.title}</div>
                  {n.body && <div className="notif-item-body">{n.body}</div>}
                  <div className="notif-item-when">{timeAgo(n.at)}</div>
                </button>
              ))}
              {!items.length && <div className="notif-empty">{tr('Nothing yet.')}</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
