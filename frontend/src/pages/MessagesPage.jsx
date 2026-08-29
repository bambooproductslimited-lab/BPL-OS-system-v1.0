import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import './MessagesPage.css';

// Ported from Bamboo OS.dc.html's messages screen (screens.messages block
// + the msgInbox/msgDirectoryOptions/activeThread computed values, and the
// "New message" dialog around its render()), then redesigned to read as an
// actual chat app: initials avatars, grouped/rounded bubbles, day
// separators and an auto-growing composer. Rounded corners are a deliberate,
// contained exception to the app's flat/zero-radius design system — scoped
// to this page's own CSS, since that's the visual grammar that reads as
// "chat" (bubbles, avatars). Everything else (colors, fonts, dialog/table
// chrome) still comes from the shared tokens in styles/theme.css.

const GROUP_GAP_MS = 5 * 60 * 1000; // consecutive same-sender messages within 5min collapse into one visual group
const AVATAR_COLORS = ['#3f7d3b', '#2f5f2c', '#7d5c3f', '#3f5a7d', '#7d3f5c', '#5c3f7d', '#7d6b3f', '#3f7d6b'];

function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  const first = parts[0] ? parts[0][0] : '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function avatarColor(name) {
  return AVATAR_COLORS[hashStr(name || '') % AVATAR_COLORS.length];
}

function Avatar({ name, size }) {
  return (
    <div className={'msg-avatar' + (size ? ' msg-avatar-' + size : '')} style={{ background: avatarColor(name) }}>
      {initials(name)}
    </div>
  );
}

function sameCalendarDay(a, b) { return a.toDateString() === b.toDateString(); }

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (sameCalendarDay(d, today)) return 'Today';
  if (sameCalendarDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined });
}

function fmtBubbleTime(iso) { return new Date(iso).toTimeString().slice(0, 5); }

function fmtInboxAt(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (sameCalendarDay(d, now)) return d.toTimeString().slice(0, 5);
  const diffDays = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString('en-GB', { weekday: 'short' });
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

// Flattens a thread's messages into render items: day separators, plus each
// message tagged with whether it starts/ends a consecutive same-sender run
// (so bubbles can round like a real chat app instead of floating separately).
function buildThreadItems(messages) {
  const items = [];
  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    const next = messages[i + 1];
    const newDay = !prev || !sameCalendarDay(new Date(prev.at), new Date(m.at));
    if (newDay) items.push({ type: 'day', key: 'day-' + m.id, label: dayLabel(m.at) });

    const gapBefore = prev ? new Date(m.at) - new Date(prev.at) : Infinity;
    const gapAfter = next ? new Date(next.at) - new Date(m.at) : Infinity;
    const isFirst = newDay || !prev || prev.fromMe !== m.fromMe || gapBefore > GROUP_GAP_MS;
    const nextNewDay = next && !sameCalendarDay(new Date(m.at), new Date(next.at));
    const isLast = !next || nextNewDay || next.fromMe !== m.fromMe || gapAfter > GROUP_GAP_MS;

    items.push({ type: 'msg', key: m.id, message: m, isFirst: isFirst, isLast: isLast });
  });
  return items;
}

export default function MessagesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [inbox, setInbox] = useState([]);
  const [directory, setDirectory] = useState([]);
  // Deep-linked from a "New message from X" notification (NotificationsBell
  // navigates to /messages?peer=<id>) — consumed once, then stripped from
  // the URL so a later back/refresh doesn't keep pinning this conversation.
  const [activePeerId, setActivePeerId] = useState(() => searchParams.get('peer') || null);
  const [thread, setThread] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [inboxSearch, setInboxSearch] = useState('');
  const [directorySearch, setDirectorySearch] = useState('');

  const threadEndRef = useRef(null);
  const composerRef = useRef(null);

  const load = useCallback(async (peerId) => {
    setError(null);
    try {
      const requests = [api.get('/messages'), api.get('/messages/directory')];
      if (peerId) requests.push(api.get('/messages/' + peerId));
      const [inboxRows, dirRows, threadData] = await Promise.all(requests);
      setInbox(inboxRows);
      setDirectory(dirRows);
      if (peerId) setThread(threadData);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(activePeerId); }, [load, activePeerId]);

  useEffect(() => {
    if (searchParams.get('peer')) setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (threadEndRef.current) threadEndRef.current.scrollIntoView({ block: 'end' });
  }, [thread]);

  // Auto-grow the composer up to ~5 lines, matching the familiar chat-app feel.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, [draft]);

  const threadItems = useMemo(() => (thread ? buildThreadItems(thread.messages) : []), [thread]);

  function openThread(peerId) {
    setDraft('');
    setActivePeerId(peerId);
  }

  function startConversationWith(peerId) {
    setDialogOpen(false);
    setDraft('');
    setActivePeerId(peerId);
  }

  async function handleSend(e) {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    setError(null);
    try {
      await api.post('/messages/' + activePeerId, { body: body });
      setDraft('');
      await load(activePeerId);
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  function handleComposerKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(e);
    }
  }

  if (loading) return <div className="eyebrow">Loading…</div>;

  const visibleInbox = inbox.filter((c) => matchesQuery(inboxSearch, c.peerName, c.lastBody));
  const visibleDirectory = directory.filter((p) => matchesQuery(directorySearch, p.name, p.title));

  return (
    <div>
      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="messages-panes" data-thread-open={!!activePeerId}>
        <div className="messages-inbox">
          <div className="messages-inbox-header">
            <div>
              <div className="eyebrow">Messages</div>
              <h2 className="messages-inbox-title">Chats</h2>
            </div>
            <button type="button" className="messages-new-btn" aria-label="New message" title="New message" onClick={() => setDialogOpen(true)}>
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M10 4.5V15.5M4.5 10H15.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="messages-inbox-search">
            <SearchInput value={inboxSearch} onChange={setInboxSearch} placeholder="Search conversations…" />
          </div>
          <div className="messages-inbox-list">
            {visibleInbox.map((c) => (
              <div
                key={c.peerId}
                className={'messages-inbox-item' + (c.peerId === activePeerId ? ' messages-inbox-item-active' : '') + (c.unread > 0 ? ' messages-inbox-item-unread' : '')}
                onClick={() => openThread(c.peerId)}
              >
                <Avatar name={c.peerName} size="md" />
                <div className="messages-inbox-main">
                  <div className="messages-inbox-row">
                    <div className="messages-inbox-name">{c.peerName}</div>
                    <div className="messages-inbox-at">{fmtInboxAt(c.lastAt)}</div>
                  </div>
                  <div className="messages-inbox-row">
                    <div className="messages-inbox-preview">{c.lastFromMe ? 'You: ' : ''}{c.lastBody}</div>
                    {c.unread > 0 && <span className="messages-unread-dot">{c.unread}</span>}
                  </div>
                </div>
              </div>
            ))}
            {!inbox.length && (
              <div className="messages-empty-state">
                <svg viewBox="0 0 48 48" fill="none" aria-hidden="true" className="messages-empty-icon">
                  <path d="M8 12a4 4 0 0 1 4-4h24a4 4 0 0 1 4 4v16a4 4 0 0 1-4 4H20l-8 8v-8h-4a4 4 0 0 1-4-4V12Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                </svg>
                <p className="messages-empty-title">No conversations yet</p>
                <p className="messages-empty-sub">Start a chat with a colleague.</p>
                <button type="button" className="btn btn-primary" onClick={() => setDialogOpen(true)}>New message</button>
              </div>
            )}
            {!!inbox.length && !visibleInbox.length && <p className="messages-empty">No matches.</p>}
          </div>
        </div>

        <div className="messages-thread-pane">
          {thread && activePeerId ? (
            <>
              <div className="messages-thread-header">
                <button type="button" className="messages-back-btn" aria-label="Back to conversations" onClick={() => setActivePeerId(null)}>
                  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M12.5 4.5 6 10l6.5 5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <Avatar name={thread.peerName} size="md" />
                <div>
                  <div className="messages-thread-peer-name">{thread.peerName}</div>
                  <div className="messages-thread-peer-title">{thread.peerTitle}</div>
                </div>
              </div>
              <div className="messages-thread-body">
                {threadItems.map((item) => item.type === 'day' ? (
                  <div className="messages-day-sep" key={item.key}><span>{item.label}</span></div>
                ) : (
                  <div
                    key={item.key}
                    className={'messages-row' + (item.message.fromMe ? ' messages-row-mine' : ' messages-row-theirs') + (item.isFirst ? ' messages-row-first' : '')}
                  >
                    {!item.message.fromMe && (
                      <div className="messages-row-avatar-slot">
                        {item.isLast && <Avatar name={thread.peerName} size="sm" />}
                      </div>
                    )}
                    <div
                      className={
                        'messages-bubble' +
                        (item.message.fromMe ? ' messages-bubble-mine' : ' messages-bubble-theirs') +
                        (!item.isFirst ? ' messages-bubble-grouped-top' : '') +
                        (!item.isLast ? ' messages-bubble-grouped-bottom' : '')
                      }
                    >
                      <div className="messages-bubble-text">{item.message.body}</div>
                      {item.isLast && <div className="messages-bubble-at">{fmtBubbleTime(item.message.at)}</div>}
                    </div>
                  </div>
                ))}
                <div ref={threadEndRef} />
              </div>
              <form className="messages-compose" onSubmit={handleSend}>
                <textarea
                  ref={composerRef}
                  className="messages-compose-input"
                  rows={1}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  placeholder="Write a message…"
                  disabled={sending}
                />
                <button className="messages-send-btn" type="submit" disabled={sending || !draft.trim()} aria-label="Send">
                  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                    <path d="M3 10 17 3l-5 14-3-6-6-1Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="currentColor" fillOpacity="0.08" />
                  </svg>
                </button>
              </form>
            </>
          ) : (
            <div className="messages-thread-placeholder">
              <svg viewBox="0 0 48 48" fill="none" aria-hidden="true" className="messages-empty-icon">
                <rect x="6" y="9" width="36" height="26" rx="3" stroke="currentColor" strokeWidth="2" />
                <path d="M12 17h24M12 24h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <p className="messages-empty-title">Select a conversation</p>
              <p className="messages-empty-sub">Or start a new one.</p>
              <button type="button" className="btn btn-secondary" onClick={() => setDialogOpen(true)}>New message</button>
            </div>
          )}
        </div>
      </div>

      {dialogOpen && (
        <div className="dialog-backdrop" onClick={() => setDialogOpen(false)}>
          <div className="dialog messages-new-dialog" onClick={(e) => e.stopPropagation()}>
            <h2>New message</h2>
            <SearchInput value={directorySearch} onChange={setDirectorySearch} placeholder="Search people…" />
            <div className="messages-directory">
              {visibleDirectory.map((p) => (
                <button type="button" key={p.id} className="messages-directory-item" onClick={() => startConversationWith(p.id)}>
                  <Avatar name={p.name} size="sm" />
                  <span className="messages-directory-item-text">
                    <span className="messages-directory-item-name">{p.name}</span>
                    {p.title && <span className="messages-directory-item-title">{p.title}</span>}
                  </span>
                </button>
              ))}
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialogOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
