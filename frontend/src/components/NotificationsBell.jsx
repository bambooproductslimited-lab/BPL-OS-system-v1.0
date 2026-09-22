import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import Icon from '../layout/navIcons';
import { playNotification, isMuted, setMuted } from '../lib/notificationSound';
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
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  var hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  var days = Math.floor(hours / 24);
  if (days < 7) return days + 'd ago';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

export default function NotificationsBell() {
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [muted, setMutedState] = useState(isMuted);
  const newestSeenRef = useRef(0);
  const primedRef = useRef(false);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    let next;
    try { next = await api.get('/notifications'); } catch { return; } // silent — a failed poll shouldn't surface an error banner
    setItems(next);

    const newestUnread = next.reduce(
      (max, n) => (!n.read ? Math.max(max, new Date(n.at).getTime()) : max), 0
    );
    if (primedRef.current && newestUnread > newestSeenRef.current) playNotification();
    primedRef.current = true;
    if (newestUnread > newestSeenRef.current) newestSeenRef.current = newestUnread;
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const unreadCount = items.filter((n) => !n.read).length;

  function handleOpen() {
    setOpen(true);
    load(); // refresh right as the panel opens, not just on the timer
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
    else navigate('/' + kind);
  }

  return (
    <div className="notif-bell">
      <button type="button" className="btn btn-secondary notif-bell-btn" onClick={handleOpen} aria-label="Notifications">
        <span className="notif-bell-icon"><Icon name="bell" /></span>
        {unreadCount > 0 && <span className="notif-bell-badge">{unreadCount > 99 ? '99+' : unreadCount}</span>}
      </button>

      {open && (
        <>
          <div className="notif-backdrop" onClick={() => setOpen(false)} />
          <div className="notif-panel">
            <div className="notif-panel-head">
              <span className="notif-panel-title">Notifications</span>
              <span className="notif-panel-tools">
                <button
                  type="button"
                  className={'notif-mute' + (muted ? ' notif-mute-off' : '')}
                  onClick={toggleMuted}
                  aria-pressed={!muted}
                  title={muted ? 'Notification sound is off — turn it on' : 'Notification sound is on — turn it off'}
                >
                  {muted ? 'Sound off' : 'Sound on'}
                </button>
                {unreadCount > 0 && (
                  <button type="button" className="notif-markall" onClick={markAllRead}>Mark all read</button>
                )}
              </span>
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
              {!items.length && <div className="notif-empty">Nothing yet.</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
