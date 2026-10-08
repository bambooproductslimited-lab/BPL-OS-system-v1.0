import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import Photo, { colorFor, forgetBlob, useBlobUrl } from '../components/Photo';
import PhotoDialog from '../components/PhotoDialog';
import {
  ACCEPT_FILES, MAX_FILES, MAX_FILE_BYTES, downloadProtected, fileBadge, fmtSize, kindOf, shrinkPhoto, squarePhoto, uploadWithProgress
} from '../lib/chatMedia';
import { tr, activeIntlLocale } from '../lib/i18n.jsx';
import {
  Burst, ChatGlyph, ForwardDialog, MentionPopup, MessageMenu, ReactionChips, ReactionPicker, RecordCard, RecordPicker,
  ReplyQuote, RichText, SeenDialog, SeenTicks, TypingBubble, recordHref, recordLabel
} from './chat/ChatParts';
import { useCalls } from '../components/calls/CallsContext';
import CallIcon from '../components/calls/CallIcon';
import { MeetingCard, ScheduleMeetingDialog, UpcomingMeetings } from '../components/calls/Meetings';
import CallAlerts from '../components/calls/CallAlerts';
import './MessagesPage.css';

// Chats: one-to-one and group conversations, with photos, videos, voice
// notes and documents, and a photo for every person and group (backed by
// messages.service.js, migration 0080).
//
// Left: every chat, newest first, with its photo, last message and unread
// count, filterable (all / unread / groups). Right: the open chat — bubbles
// grouped by sender, day separators, files shown the way they are (photos
// inline and full-screen, videos and audio playable, documents as cards to
// download), group events as small centred lines. The composer takes text,
// files (button, drag and drop, or paste) and voice notes. The info panel
// shows a contact or a group: its photo, members and admins, and the photos
// and files shared in it. Open chats refresh every few seconds.
//
// Migration 0110 (chat/ChatParts.jsx): reply to, react to, forward, pin,
// edit or delete a message from its actions (hover, or tap it on a phone);
// @mention people in a group; share an OS record as a card; "seen" ticks,
// "typing…" and who is online; search across every chat; everything shared
// in a chat in its info panel. An open chat asks /pulse every 2.5 s and
// reloads only when something changed. New messages, reactions, typing and
// pins animate, unless the reader asked for less motion.

const GROUP_GAP_MS = 5 * 60 * 1000;
const POLL_MS = 6000;
const PULSE_MS = 2500;
const TYPING_EVERY_MS = 3000;

const PATHS = {
  plus: <path d="M12 5v14M5 12h14" />,
  group: <><circle cx="9" cy="8.5" r="3" /><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8M15.5 5.8a3 3 0 0 1 0 5.4M17.5 14.6c1.6.7 2.6 2.2 3 4.4" /></>,
  chat: <path d="M4.5 18.5 5.6 15A7 7 0 1 1 8.9 17.6z" />,
  back: <path d="M15 5l-7 7 7 7" />,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8v.1" /></>,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  clip: <path d="M20 11.5 12 19.5a5 5 0 0 1-7-7l8-8a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3" />,
  image: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="9" cy="10" r="1.8" /><path d="m20.5 16-5-5L6 19.5" /></>,
  mic: <><rect x="9" y="3.5" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3" /></>,
  stop: <rect x="7" y="7" width="10" height="10" rx="1.5" />,
  send: <path d="m4 12 16-7-6 16-2.5-6.5z" />,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 19.5h14" />,
  trash: <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />,
  camera: <><path d="M4 8h3l1.5-2.5h7L17 8h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></>,
  edit: <path d="M5 19h3.5L19 8.5 15.5 5 5 15.5zM13.5 7l3.5 3.5" />,
  userPlus: <><circle cx="9.5" cy="8.5" r="3" /><path d="M4 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8M18.5 8v6M15.5 11h6" /></>,
  leave: <path d="M14 5h4.5v14H14M9.5 16.5 5 12l4.5-4.5M5 12h10" />,
  shield: <path d="M12 3.5 19 6v5.5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z" />,
  left: <path d="M15 5l-7 7 7 7" />,
  right: <path d="M9 5l7 7-7 7" />,
  play: <path d="M8 5.5v13l10.5-6.5z" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />
};
function Icon({ name, size = 18 }) {
  return (
    <svg className="chat-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

function sameDay(a, b) { return a.toDateString() === b.toDateString(); }
function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (sameDay(d, today)) return tr('Today');
  if (sameDay(d, yesterday)) return tr('Yesterday');
  return d.toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined });
}
function hhmm(iso) { return new Date(iso).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' }); }
function listTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (sameDay(d, now)) return hhmm(iso);
  const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days === 1) return tr('Yesterday');
  if (days < 7) return d.toLocaleDateString(activeIntlLocale(), { weekday: 'short' });
  return d.toLocaleDateString(activeIntlLocale(), { day: '2-digit', month: 'short' });
}
function secs(n) { return Math.floor(n / 60) + ':' + String(Math.floor(n % 60)).padStart(2, '0'); }

// A group event, a call or a meeting, in the reader's language. by: who it
// was (for calls and meetings, the sender of the note).
function systemText(meta, by) {
  if (!meta) return '';
  const video = meta.kind === 'video';
  switch (meta.type) {
    case 'call': return video ? tr('{by} started a video call', { by }) : tr('{by} started a voice call', { by });
    case 'callEnded':
      if (meta.missed) return video ? tr('Missed video call') : tr('Missed voice call');
      if (!meta.minutes) return video ? tr('Video call · under a minute') : tr('Voice call · under a minute');
      return video ? tr('Video call · {n} min', { n: meta.minutes }) : tr('Voice call · {n} min', { n: meta.minutes });
    case 'meeting': return tr('{by} booked a meeting', { by });
    case 'meetingCancelled': return tr('{by} cancelled the meeting "{title}"', { by, title: meta.title });
    default: break;
  }
  const names = (meta.names || []).join(', ');
  switch (meta.event) {
    case 'created': return tr('{by} created the group "{name}"', { by: meta.by, name: meta.name });
    case 'added': return tr('{by} added {names}', { by: meta.by, names });
    case 'removed': return tr('{by} removed {names}', { by: meta.by, names });
    case 'left': return tr('{by} left the group', { by: meta.by });
    case 'renamed': return tr('{by} renamed the group to "{name}"', { by: meta.by, name: meta.name });
    case 'photo': return tr('{by} changed the group photo', { by: meta.by });
    case 'photoRemoved': return tr('{by} removed the group photo', { by: meta.by });
    case 'pinned': return tr('{by} pinned a message', { by: meta.by });
    default: return '';
  }
}
function filesLabel(files, fileKind) {
  if (files > 1) return tr('{n} files', { n: files });
  if (fileKind === 'image') return tr('Photo');
  if (fileKind === 'video') return tr('Video');
  if (fileKind === 'audio') return tr('Voice note or audio');
  return tr('Document');
}

// Messages as render items: day separators, and whether each message starts
// or ends a run from the same sender.
function buildItems(messages) {
  const items = [];
  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    const next = messages[i + 1];
    const newDay = !prev || !sameDay(new Date(prev.at), new Date(m.at));
    if (newDay) items.push({ type: 'day', key: 'day-' + m.id, label: dayLabel(m.at) });
    if (m.kind === 'system') { items.push({ type: 'system', key: m.id, message: m }); return; }
    const runBreak = (a, b) => !a || !b || a.kind === 'system' || b.kind === 'system' || a.fromId !== b.fromId || Math.abs(new Date(b.at) - new Date(a.at)) > GROUP_GAP_MS || !sameDay(new Date(a.at), new Date(b.at));
    items.push({ type: 'msg', key: m.id, message: m, isFirst: runBreak(prev, m), isLast: runBreak(m, next) });
  });
  return items;
}

// ── files in a message ─────────────────────────────────────────────────
// Photos and videos get their height only once loaded; the open chat is told
// so it can stay scrolled to the newest message.
const MediaLoaded = createContext(() => {});

function ImageTile({ a, onOpen, count }) {
  const url = useBlobUrl('/messages/files/' + a.id, a.id);
  const onLoad = useContext(MediaLoaded);
  return (
    <button type="button" className={'chat-media-tile' + (count === 1 ? ' is-single' : '')} onClick={onOpen} aria-label={tr('Open photo {name}', { name: a.fileName })}>
      {url ? <img src={url} alt={a.fileName} onLoad={onLoad} /> : <span className="chat-media-loading" />}
    </button>
  );
}
function VideoItem({ a }) {
  const url = useBlobUrl('/messages/files/' + a.id, a.id);
  const onLoad = useContext(MediaLoaded);
  return (
    <div className="chat-video">
      {url ? <video src={url} controls preload="metadata" onLoadedMetadata={onLoad} /> : <span className="chat-media-loading is-video"><Icon name="play" size={28} /></span>}
    </div>
  );
}
function AudioItem({ a }) {
  const url = useBlobUrl('/messages/files/' + a.id, a.id);
  return (
    <div className="chat-audio">
      <span className="chat-audio-icon"><Icon name="mic" /></span>
      {url ? <audio src={url} controls preload="metadata" /> : <span className="chat-muted">{tr('Loading…')}</span>}
    </div>
  );
}
function FileCard({ a }) {
  const badge = fileBadge(a.fileName, a.kind);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await downloadProtected('/messages/files/' + a.id, a.fileName); } catch (e) { window.alert(e.message); } finally { setBusy(false); }
  }
  return (
    <button type="button" className="chat-file" onClick={save} disabled={busy} title={tr('Download {name}', { name: a.fileName })}>
      <span className="chat-file-badge" style={{ background: badge.tone }}>{badge.label}</span>
      <span className="chat-file-text">
        <span className="chat-file-name">{a.fileName}</span>
        <span className="chat-file-size">{busy ? tr('Downloading…') : fmtSize(a.size)}</span>
      </span>
      <span className="chat-file-dl"><Icon name="download" /></span>
    </button>
  );
}
function Attachments({ list, onOpenImage }) {
  const images = list.filter((a) => a.kind === 'image');
  const others = list.filter((a) => a.kind !== 'image');
  return (
    <div className="chat-attachments">
      {images.length > 0 && (
        <div className={'chat-media-grid n' + Math.min(images.length, 4)}>
          {images.slice(0, 4).map((a, i) => (
            <div key={a.id} className="chat-media-cell">
              <ImageTile a={a} count={images.length} onOpen={() => onOpenImage(a.id)} />
              {i === 3 && images.length > 4 && <span className="chat-media-more" onClick={() => onOpenImage(a.id)}>+{images.length - 4}</span>}
            </div>
          ))}
        </div>
      )}
      {others.map((a) => (a.kind === 'video' ? <VideoItem key={a.id} a={a} /> : a.kind === 'audio' ? <AudioItem key={a.id} a={a} /> : <FileCard key={a.id} a={a} />))}
    </div>
  );
}

function Lightbox({ images, index, onIndex, onClose }) {
  const a = images[index];
  const url = useBlobUrl(a ? '/messages/files/' + a.id : null, a && a.id);
  useEffect(() => {
    function key(e) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
      if (e.key === 'ArrowRight' && index < images.length - 1) onIndex(index + 1);
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [index, images.length, onClose, onIndex]);
  if (!a) return null;
  return (
    <div className="chat-lightbox" role="dialog" aria-label={a.fileName} onClick={onClose}>
      <div className="chat-lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="chat-lightbox-name">{a.fileName} · {index + 1}/{images.length}</span>
        <button type="button" className="chat-icon-btn is-light" onClick={() => downloadProtected('/messages/files/' + a.id, a.fileName)} aria-label={tr('Download')}><Icon name="download" /></button>
        <button type="button" className="chat-icon-btn is-light" onClick={onClose} aria-label={tr('Close')}><Icon name="close" /></button>
      </div>
      {index > 0 && <button type="button" className="chat-lightbox-nav is-prev" onClick={(e) => { e.stopPropagation(); onIndex(index - 1); }} aria-label={tr('Previous')}><Icon name="left" size={26} /></button>}
      {url ? <img src={url} alt={a.fileName} onClick={(e) => e.stopPropagation()} /> : <span className="chat-media-loading" />}
      {index < images.length - 1 && <button type="button" className="chat-lightbox-nav is-next" onClick={(e) => { e.stopPropagation(); onIndex(index + 1); }} aria-label={tr('Next')}><Icon name="right" size={26} /></button>}
    </div>
  );
}

// ── picking people ─────────────────────────────────────────────────────
function PeoplePicker({ people, selected, onToggle, exclude }) {
  const [q, setQ] = useState('');
  const list = people.filter((p) => !(exclude || []).includes(p.id)).filter((p) => matchesQuery(q, p.name, p.title, p.department));
  const chosen = people.filter((p) => selected.includes(p.id));
  return (
    <div className="chat-picker">
      {chosen.length > 0 && (
        <div className="chat-picker-chips">
          {chosen.map((p) => (
            <button key={p.id} type="button" className="chat-chip" onClick={() => onToggle(p.id)} aria-label={tr('Remove {name}', { name: p.name })}>
              <Photo id={p.id} name={p.name} photo={p.photo} size={22} /> {p.name.split(' ')[0]} <Icon name="close" size={13} />
            </button>
          ))}
        </div>
      )}
      <SearchInput value={q} onChange={setQ} placeholder={tr('Search people…')} />
      <div className="chat-picker-list" role="listbox" aria-multiselectable="true">
        {list.map((p) => {
          const on = selected.includes(p.id);
          return (
            <button key={p.id} type="button" role="option" aria-selected={on} className={'chat-person' + (on ? ' is-on' : '')} onClick={() => onToggle(p.id)}>
              <Photo id={p.id} name={p.name} photo={p.photo} size={36} />
              <span className="chat-person-text"><span className="chat-person-name">{p.name}</span><span className="chat-muted">{[p.title, p.department].filter(Boolean).join(' · ')}</span></span>
              <span className={'chat-check' + (on ? ' is-on' : '')}>{on && <Icon name="check" size={14} />}</span>
            </button>
          );
        })}
        {!list.length && <p className="chat-muted chat-pad">{tr('No one matches.')}</p>}
      </div>
    </div>
  );
}

export default function MessagesPage() {
  const { session, can } = useAuth();
  const navigate = useNavigate();
  const me = session && session.employee ? session.employee : {};
  const myName = ((me.firstName || '') + ' ' + (me.lastName || '')).trim();
  const [searchParams, setSearchParams] = useSearchParams();

  const [inbox, setInbox] = useState([]);
  const [people, setPeople] = useState([]);
  const [active, setActive] = useState(() => {
    if (searchParams.get('chat')) return { type: 'conv', id: searchParams.get('chat') };
    if (searchParams.get('peer')) return { type: 'peer', id: searchParams.get('peer') };
    return null;
  });
  const [conv, setConv] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState([]); // [{ key, file, kind, url }]
  const [progress, setProgress] = useState(null);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [recording, setRecording] = useState(null); // { started, seconds }
  const recorderRef = useRef(null);

  const [dialog, setDialog] = useState(null); // 'newChat' | 'newGroup' | 'addPeople' | 'myPhoto' | 'groupPhoto' | 'personPhoto'
  const [groupForm, setGroupForm] = useState({ step: 1, members: [], name: '', description: '' });
  const [addSel, setAddSel] = useState([]);
  const [infoOpen, setInfoOpen] = useState(false);
  const [editing, setEditing] = useState(null); // { name, description }
  const [lightbox, setLightbox] = useState(null); // { list, index }
  const [myPhoto, setMyPhoto] = useState('probe');

  // Migration 0110: replying, editing, mentions, a message's actions.
  const [replyTo, setReplyTo] = useState(null);
  const [editingMsg, setEditingMsg] = useState(null);
  const [mentionIds, setMentionIds] = useState([]);
  const [mention, setMention] = useState(null); // { q, start, index }
  const [selectedMsg, setSelectedMsg] = useState(null);
  const [menuFor, setMenuFor] = useState(null);
  const [pickerFor, setPickerFor] = useState(null);
  const [burst, setBurst] = useState(null); // { id, emoji, key }
  const [forwardMsg, setForwardMsg] = useState(null);
  const [deleteMsg, setDeleteMsg] = useState(null);
  const [seenFor, setSeenFor] = useState(null); // a message id
  const calls = useCalls();
  const [booking, setBooking] = useState(false);
  const [meetingsKey, setMeetingsKey] = useState(0);
  const [recordPicker, setRecordPicker] = useState(false);
  const [notice, setNotice] = useState(null);
  const [hits, setHits] = useState([]);
  const [jumpTo, setJumpTo] = useState(null);
  const [flash, setFlash] = useState(null);
  const [pinIndex, setPinIndex] = useState(0);
  const [shared, setShared] = useState(null);
  const [live, setLive] = useState(null); // the last pulse: { convId, typing, reads, online }
  const [freshIds, setFreshIds] = useState(() => new Set());
  const seenRef = useRef({ convId: null, ids: new Set() });
  const typingSentRef = useRef(0);
  const sendingRef = useRef(false);

  const endRef = useRef(null);
  const bodyRef = useRef(null);
  const composerRef = useRef(null);
  const fileInputRef = useRef(null);
  const mediaInputRef = useRef(null);
  const lastCountRef = useRef(0);
  const stickRef = useRef(true); // the reader is at the newest message

  const loadInbox = useCallback(async () => {
    try { setInbox(await api.get('/messages')); } catch (err) { setError(err.message); }
  }, []);
  const loadConv = useCallback(async (a, quiet) => {
    if (!a) { setConv(null); return; }
    try {
      const data = await api.get(a.type === 'conv' ? '/messages/conversations/' + a.id : '/messages/' + a.id);
      // Messages that weren't there last time get the arriving animation.
      const prev = seenRef.current;
      const fresh = prev.convId && prev.convId === data.id ? data.messages.filter((m) => !prev.ids.has(m.id)).map((m) => m.id) : [];
      seenRef.current = { convId: data.id, ids: new Set(data.messages.map((m) => m.id)) };
      setFreshIds(new Set(fresh));
      setLive(null);
      setConv(data);
      if (a.type === 'peer' && data.id) setActive({ type: 'conv', id: data.id });
    } catch (err) {
      if (!quiet) setError(err.message);
      if (err.status === 404) { setActive(null); setConv(null); }
    }
  }, []);

  useEffect(() => {
    (async () => {
      try { setPeople(await api.get('/messages/directory')); } catch { /* the list still works without it */ }
      await loadInbox();
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A link to a chat (a notification, a profile's "Message" button) opens it,
  // also when this page is already showing.
  useEffect(() => {
    const chat = searchParams.get('chat');
    const peer = searchParams.get('peer');
    if (!chat && !peer) return;
    setActive((a) => (chat ? (a && a.type === 'conv' && a.id === chat ? a : { type: 'conv', id: chat }) : (a && a.type === 'peer' && a.id === peer ? a : { type: 'peer', id: peer })));
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);
  useEffect(() => {
    setInfoOpen(false); setEditing(null); setReplyTo(null); setEditingMsg(null); setMention(null); setMentionIds([]);
    setSelectedMsg(null); setMenuFor(null); setPickerFor(null); setPinIndex(0); setShared(null);
    loadConv(active);
  }, [active, loadConv]);

  // Keep the list fresh while the page is visible.
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') loadInbox(); }, POLL_MS);
    return () => clearInterval(t);
  }, [loadInbox]);
  // The open chat asks what changed: it reloads when something did, and
  // otherwise just takes who is typing, how far people have read and who is online.
  const convId = conv && conv.id;
  const convUpdated = conv && conv.updatedAt;
  useEffect(() => {
    if (!convId) return undefined;
    const t = setInterval(async () => {
      if (document.visibilityState !== 'visible' || sendingRef.current) return;
      try {
        const p = await api.get('/messages/conversations/' + convId + '/pulse');
        if (p.updatedAt !== convUpdated) loadConv({ type: 'conv', id: convId }, true);
        else setLive({ convId, ...p });
      } catch { /* the next one will try again */ }
    }, PULSE_MS);
    return () => clearInterval(t);
  }, [convId, convUpdated, loadConv]);
  useEffect(() => { sendingRef.current = sending; }, [sending]);
  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(null), 3200);
    return () => clearTimeout(t);
  }, [notice]);
  // Search inside every chat, as you type in the list's search box.
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) { setHits([]); return undefined; }
    let alive = true;
    const t = setTimeout(() => { api.get('/messages/search?q=' + encodeURIComponent(q)).then((r) => { if (alive) setHits(r); }).catch(() => {}); }, 350);
    return () => { alive = false; clearTimeout(t); };
  }, [search]);
  // Jump to a message (from search, a pin or a reply) once it is on screen.
  useEffect(() => {
    if (!jumpTo || !conv) return;
    const el = document.getElementById('msg-' + jumpTo);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      stickRef.current = false;
      setFlash(jumpTo);
      setTimeout(() => setFlash((f) => (f === jumpTo ? null : f)), 1700);
    } else if (conv.messages.length) {
      setNotice(tr('That message is further back than this chat shows.'));
    }
    setJumpTo(null);
  }, [jumpTo, conv]);
  // What was shared, for the info panel.
  useEffect(() => {
    if (!infoOpen || !convId) return;
    api.get('/messages/conversations/' + convId + '/shared').then(setShared).catch(() => setShared(null));
  }, [infoOpen, convId, convUpdated]);

  // Scroll to the newest message when the chat opens or something new arrives
  // (unless the reader has scrolled up to read older ones).
  useEffect(() => {
    if (!conv) return;
    const n = conv.messages.length;
    const el = bodyRef.current;
    const nearBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (n !== lastCountRef.current && (nearBottom || lastCountRef.current === 0)) {
      if (endRef.current) endRef.current.scrollIntoView({ block: 'end' });
      stickRef.current = true;
    }
    lastCountRef.current = n;
  }, [conv]);
  const onMediaLoaded = useCallback(() => {
    const el = bodyRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, []);
  function onBodyScroll() {
    const el = bodyRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
  }
  useEffect(() => { lastCountRef.current = 0; }, [active && active.id]);

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }, [draft]);

  // Free the local previews of files that were not sent.
  useEffect(() => () => pending.forEach((p) => p.url && URL.revokeObjectURL(p.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo(() => (conv ? buildItems(conv.messages) : []), [conv]);
  // Live state: from the last pulse when there is one, else from the chat itself.
  const liveNow = live && conv && live.convId === conv.id ? live : null;
  const others = conv ? conv.members.filter((mb) => !mb.me) : [];
  const readAt = useMemo(() => {
    const m = {};
    (liveNow ? liveNow.reads : (conv ? conv.members.map((mb) => ({ id: mb.id, lastReadAt: mb.lastReadAt })) : [])).forEach((r) => { m[r.id] = r.lastReadAt; });
    return m;
  }, [liveNow, conv]);
  const onlineIds = useMemo(() => new Set(liveNow ? liveNow.online : (conv ? conv.members.filter((mb) => !mb.me && mb.online).map((mb) => mb.id) : [])), [liveNow, conv]);
  const typingNames = liveNow ? liveNow.typing.map((t) => t.name) : (conv ? conv.members.filter((mb) => mb.typing).map((mb) => mb.name.split(' ')[0]) : []);
  const memberNames = useMemo(() => (conv ? conv.members.map((mb) => mb.name) : []), [conv]);
  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [typingNames.length]);
  const images = useMemo(() => (conv ? conv.messages.flatMap((m) => m.attachments.filter((a) => a.kind === 'image')) : []), [conv]);
  const sharedFiles = useMemo(() => (conv ? conv.messages.flatMap((m) => m.attachments.filter((a) => a.kind !== 'image')).reverse() : []), [conv]);
  const peopleById = useMemo(() => Object.fromEntries(people.map((p) => [p.id, p])), [people]);

  function open(a) {
    setDraft('');
    clearPending();
    setActive(a);
  }

  // ── a message's actions ─────────────────────────────────────────────
  async function msgAction(fn, after) {
    setError(null);
    try { const r = await fn(); if (after) after(r); await loadConv({ type: 'conv', id: conv.id }, true); loadInbox(); } catch (err) { setError(err.message); }
  }
  function react(m, emoji) {
    const had = (m.reactions || []).some((r) => r.mine && r.emoji === emoji);
    setPickerFor(null); setSelectedMsg(null);
    if (!had) setBurst({ id: m.id, emoji, key: Date.now() });
    msgAction(() => api.post('/messages/m/' + m.id + '/react', { emoji }));
  }
  function startReply(m) {
    setEditingMsg(null); setReplyTo(m); setSelectedMsg(null);
    if (composerRef.current) composerRef.current.focus();
  }
  function startEdit(m) {
    setReplyTo(null); setEditingMsg(m); setDraft(m.body); setSelectedMsg(null); clearPending();
    setTimeout(() => { if (composerRef.current) { composerRef.current.focus(); composerRef.current.setSelectionRange(m.body.length, m.body.length); } }, 0);
  }
  function cancelContext() { if (editingMsg) setDraft(''); setEditingMsg(null); setReplyTo(null); }
  function menuItems(m) {
    const own = m.fromMe;
    return [
      { icon: 'reply', label: tr('Reply'), run: () => startReply(m) },
      m.body && { icon: 'copy', label: tr('Copy text'), run: () => { navigator.clipboard.writeText(m.body).then(() => setNotice(tr('Copied.'))).catch(() => {}); } },
      { icon: 'forward', label: tr('Forward'), run: () => setForwardMsg(m) },
      isGroup && (own || conv.myRole === 'admin') && { icon: 'eye', label: tr('Seen by…'), run: () => setSeenFor(m.id) },
      conv.canPin && { icon: 'pin', label: m.pinned ? tr('Unpin') : tr('Pin'), run: () => msgAction(() => api.post('/messages/m/' + m.id + '/pin', { pinned: !m.pinned }), () => setNotice(m.pinned ? tr('Unpinned.') : tr('Pinned to the top of the chat.'))) },
      own && { icon: 'edit', label: tr('Edit'), run: () => startEdit(m) },
      own && { icon: 'trash', label: tr('Delete'), danger: true, run: () => setDeleteMsg(m) }
    ].filter(Boolean);
  }
  // Where a menu or picker fits: up near the bottom of the chat, down near the top.
  function placeFor(e) {
    const rowEl = e.currentTarget.closest('.chat-row');
    const body = bodyRef.current;
    if (!rowEl || !body) return { up: false, down: false };
    const r = rowEl.getBoundingClientRect(), b = body.getBoundingClientRect();
    return { up: b.bottom - r.bottom < 250, down: r.top - b.top < 70 };
  }
  function seenState(m) {
    if (!others.length) return null;
    const readers = others.filter((o) => readAt[o.id] && new Date(readAt[o.id]) >= new Date(m.at));
    if (!readers.length) return { state: 'sent', title: tr('Sent') };
    if (!isGroup) return { state: 'seen', title: tr('Seen') };
    return { state: readers.length === others.length ? 'seen' : 'some', count: readers.length, all: readers.length === others.length, title: tr('Seen by {names}', { names: readers.map((r) => r.name.split(' ')[0]).join(', ') }) };
  }
  function openRecord(r) { const href = recordHref(r); if (href) navigate(href); }

  // ── typing and @mentions ──────────────────────────────────────────
  function onDraftChange(e) {
    const value = e.target.value;
    setDraft(value);
    if (conv && conv.id && value.trim() && !editingMsg && Date.now() - typingSentRef.current > TYPING_EVERY_MS) {
      typingSentRef.current = Date.now();
      api.post('/messages/conversations/' + conv.id + '/typing').catch(() => {});
    }
    const caret = e.target.selectionStart || value.length;
    const m = /(^|\s)@([^\s@]{0,30})$/.exec(value.slice(0, caret));
    if (m && conv && conv.kind === 'group') setMention({ q: m[2], start: caret - m[2].length - 1, index: 0 });
    else setMention(null);
  }
  const mentionPeople = mention && conv ? others.filter((o) => matchesQuery(mention.q, o.name, o.title)).slice(0, 6) : [];
  function pickMention(pp) {
    const el = composerRef.current;
    const caret = el ? el.selectionStart : draft.length;
    const before = draft.slice(0, mention.start) + '@' + pp.name + ' ';
    setDraft(before + draft.slice(caret));
    setMentionIds((ids) => (ids.includes(pp.id) ? ids : [...ids, pp.id]));
    setMention(null);
    setTimeout(() => { if (el) { el.focus(); el.setSelectionRange(before.length, before.length); } }, 0);
  }
  function mentionsIn(body) { return mentionIds.filter((id) => { const pp = others.find((o) => o.id === id); return pp && body.includes('@' + pp.name); }); }

  // ── attachments ──────────────────────────────────────────────────────
  async function addFiles(fileList) {
    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;
    setError(null);
    const room = MAX_FILES - pending.length;
    if (incoming.length > room) setError(tr('You can send up to {n} files at a time.', { n: MAX_FILES }));
    const next = [];
    for (const f0 of incoming.slice(0, Math.max(0, room))) {
      const f = await shrinkPhoto(f0);
      if (f.size > MAX_FILE_BYTES) { setError(tr('"{name}" is too big. Files can be up to 25 MB.', { name: f.name })); continue; }
      const kind = kindOf(f);
      next.push({ key: Math.random().toString(36).slice(2), file: f, kind, url: kind === 'image' || kind === 'video' ? URL.createObjectURL(f) : null });
    }
    setPending((p) => [...p, ...next]);
    if (composerRef.current) composerRef.current.focus();
  }
  function removePending(key) {
    setPending((p) => {
      const it = p.find((x) => x.key === key);
      if (it && it.url) URL.revokeObjectURL(it.url);
      return p.filter((x) => x.key !== key);
    });
  }
  function clearPending() {
    setPending((p) => { p.forEach((x) => x.url && URL.revokeObjectURL(x.url)); return []; });
  }

  async function send(e, extraFiles, record) {
    if (e) e.preventDefault();
    const body = draft.trim();
    if (editingMsg) {
      if (!body && !editingMsg.attachments.length && !editingMsg.record) return;
      setSending(true); setError(null);
      try {
        await api.patch('/messages/m/' + editingMsg.id, { body });
        setEditingMsg(null); setDraft('');
        await loadConv({ type: 'conv', id: conv.id }, true);
        loadInbox();
      } catch (err) { setError(err.message); } finally { setSending(false); }
      return;
    }
    const files = extraFiles || pending.map((p) => p.file);
    if (!body && !files.length && !record) return;
    if (!active) return;
    setSending(true); setError(null); setProgress(files.length ? 0 : null); setMention(null);
    const mentions = mentionsIn(body);
    try {
      const path = active.type === 'conv' ? '/messages/conversations/' + active.id : '/messages/' + active.id;
      let r;
      if (files.length) {
        const fd = new FormData();
        if (body) fd.append('body', body);
        if (replyTo) fd.append('replyTo', replyTo.id);
        if (mentions.length) fd.append('mentions', JSON.stringify(mentions));
        files.forEach((f) => fd.append('files', f, f.name));
        r = await uploadWithProgress(path, fd, setProgress);
      } else {
        r = await api.post(path, { body, replyTo: replyTo ? replyTo.id : null, mentions, record: record ? { type: record.type, id: record.id } : null });
      }
      setDraft(''); setReplyTo(null); setMentionIds([]); stickRef.current = true;
      if (!extraFiles) clearPending();
      if (active.type === 'peer' && r && r.conversationId) setActive({ type: 'conv', id: r.conversationId });
      else await loadConv(active, true);
      loadInbox();
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false); setProgress(null);
    }
  }
  function onComposerKey(e) {
    if (mention && mentionPeople.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMention({ ...mention, index: (mention.index + 1) % mentionPeople.length }); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMention({ ...mention, index: (mention.index - 1 + mentionPeople.length) % mentionPeople.length }); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionPeople[mention.index]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMention(null); return; }
    }
    if (e.key === 'Escape' && (replyTo || editingMsg)) { e.preventDefault(); cancelContext(); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e); }
  }
  function onPaste(e) {
    const files = Array.from(e.clipboardData ? e.clipboardData.files : []);
    if (files.length) { e.preventDefault(); addFiles(files); }
  }

  // ── voice notes ─────────────────────────────────────────────────────
  async function startRecording() {
    setError(null);
    if (!navigator.mediaDevices || !window.MediaRecorder) { setError(tr('Voice notes are not supported in this browser.')); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ['audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
      const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const chunks = [];
      rec.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const mime = rec.mimeType || type || 'audio/webm';
        const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
        if (rec.cancelled || !chunks.length) return;
        const file = new File(chunks, 'voice-note-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.' + ext, { type: mime.split(';')[0] });
        send(null, [file]);
      };
      rec.start();
      recorderRef.current = rec;
      const started = Date.now();
      setRecording({ started, seconds: 0 });
      rec.timer = setInterval(() => setRecording({ started, seconds: (Date.now() - started) / 1000 }), 250);
    } catch {
      setError(tr('The microphone could not be used. Allow it in the browser and try again.'));
    }
  }
  function stopRecording(cancel) {
    const rec = recorderRef.current;
    if (!rec) return;
    clearInterval(rec.timer);
    rec.cancelled = !!cancel;
    rec.stop();
    recorderRef.current = null;
    setRecording(null);
  }

  // ── groups ──────────────────────────────────────────────────────────
  async function createGroup() {
    setError(null);
    try {
      const r = await api.post('/messages/groups', { name: groupForm.name, description: groupForm.description, memberIds: groupForm.members });
      if (groupForm.photoFile) {
        const fd = new FormData(); fd.append('photo', groupForm.photoFile);
        await uploadWithProgress('/messages/conversations/' + r.id + '/photo', fd).catch(() => {});
      }
      setDialog(null);
      setGroupForm({ step: 1, members: [], name: '', description: '' });
      await loadInbox();
      open({ type: 'conv', id: r.id });
    } catch (err) { setError(err.message); }
  }
  async function groupAction(fn) {
    setError(null);
    try { await fn(); await loadConv(active, true); await loadInbox(); } catch (err) { setError(err.message); }
  }
  async function leaveGroup() {
    if (!window.confirm(tr('Leave "{name}"? You will stop getting its messages.', { name: conv.name }))) return;
    try { await api.post('/messages/conversations/' + conv.id + '/leave'); setActive(null); setConv(null); await loadInbox(); } catch (err) { setError(err.message); }
  }

  if (loading) return <div className="eyebrow">{tr('Loading…')}</div>;

  const unreadTotal = inbox.reduce((n, c) => n + (c.unread || 0), 0);
  const visibleInbox = inbox
    .filter((c) => filter === 'all' || (filter === 'unread' ? c.unread > 0 : c.kind === 'group'))
    .filter((c) => matchesQuery(search, c.name, c.title, c.last && c.last.body));
  // People you have not chatted with yet also show up when searching.
  const chattedWith = new Set(inbox.filter((c) => c.kind === 'direct').map((c) => c.peerId));
  const newPeople = search ? people.filter((p) => !chattedWith.has(p.id) && matchesQuery(search, p.name, p.title, p.department)).slice(0, 8) : [];

  function preview(c) {
    const l = c.last;
    if (!l) return c.kind === 'group' ? tr('{n} members', { n: c.memberCount }) : '';
    if (l.kind === 'system') return systemText(l.meta, l.fromMe ? tr('You') : l.fromName);
    if (l.deleted) return tr('This message was deleted');
    const who = l.fromMe ? tr('You') + ': ' : c.kind === 'group' ? l.fromName + ': ' : '';
    return who + (l.body || (l.record ? recordLabel(l.record.type) + ': ' + l.record.title : filesLabel(l.files, l.fileKind)));
  }

  const isGroup = conv && conv.kind === 'group';
  const liveHere = conv ? calls.live.find((c) => c.conversationId === conv.id) : null;
  const amAdmin = isGroup && conv.myRole === 'admin';
  const peerOnline = conv && !isGroup && onlineIds.has(conv.peerId);
  const subtitle = conv ? (typingNames.length
    ? (isGroup ? (typingNames.length === 1 ? tr('{name} is typing…', { name: typingNames[0] }) : tr('{n} people are typing…', { n: typingNames.length })) : tr('typing…'))
    : isGroup
      ? conv.members.map((m) => (m.me ? tr('You') : m.name.split(' ')[0])).join(', ')
      : peerOnline ? tr('online')
        : conv.peer && conv.peer.lastSeenAt ? tr('last seen {when}', { when: listTime(conv.peer.lastSeenAt) === hhmm(conv.peer.lastSeenAt) ? tr('today at {time}', { time: hhmm(conv.peer.lastSeenAt) }) : listTime(conv.peer.lastSeenAt) })
          : [conv.title, conv.department].filter(Boolean).join(' · ')) : '';
  const subtitleClass = typingNames.length ? ' chat-typing-sub' : peerOnline ? ' chat-online-sub' : '';
  const pins = conv ? conv.pinned || [] : [];
  const pin = pins.length ? pins[Math.min(pinIndex, pins.length - 1)] : null;
  function highlight(text) {
    const q = search.trim();
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (!q || i < 0) return text;
    return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
  }

  return (
    <div className="chat">
      {error && <div className="error-banner chat-error" role="alert">{error}<button type="button" className="chat-icon-btn" onClick={() => setError(null)} aria-label={tr('Close')}><Icon name="close" size={16} /></button></div>}

      <div className="chat-panes" data-open={!!active} data-info={infoOpen && !!conv}>
        {/* ── chat list ── */}
        <aside className="chat-list">
          <div className="chat-list-head">
            <button type="button" className="chat-me" onClick={() => setDialog('myPhoto')} title={tr('Your photo')}>
              <Photo id={me.id} name={myName} photo={myPhoto} size={40} />
            </button>
            <div className="chat-list-title">
              <h2>{tr('Chats')}</h2>
              <span className="chat-muted">{unreadTotal ? tr('{n} unread', { n: unreadTotal }) : tr('All caught up')}</span>
            </div>
            <button type="button" className="chat-icon-btn" onClick={() => { setGroupForm({ step: 1, members: [], name: '', description: '' }); setDialog('newGroup'); }} title={tr('New group')} aria-label={tr('New group')}><Icon name="group" /></button>
            <button type="button" className="chat-icon-btn is-primary" onClick={() => setDialog('newChat')} title={tr('New chat')} aria-label={tr('New chat')}><Icon name="plus" /></button>
          </div>
          <div className="chat-list-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search chats and people…')} /></div>
          <div className="chat-tabs" role="tablist" aria-label={tr('Show')}>
            {[['all', tr('All')], ['unread', tr('Unread')], ['groups', tr('Groups')]].map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={filter === k} className={filter === k ? 'is-on' : ''} onClick={() => setFilter(k)}>{label}</button>
            ))}
          </div>
          <CallAlerts />
          <UpcomingMeetings locale={activeIntlLocale()} onOpenChat={(id) => open({ type: 'conv', id })} refreshKey={meetingsKey} />
          <div className="chat-list-items">
            {visibleInbox.map((c, n) => {
              const on = active && ((active.type === 'conv' && active.id === c.id) || (active.type === 'peer' && active.id === c.peerId));
              return (
                <button key={c.id} type="button" style={{ '--n': Math.min(n, 12) }} className={'chat-item' + (on ? ' is-active' : '') + (c.unread ? ' is-unread' : '')} onClick={() => open({ type: 'conv', id: c.id })}>
                  <span className={'chat-av' + (c.kind === 'direct' && c.online ? ' is-online' : '')}><Photo kind={c.kind === 'group' ? 'group' : 'person'} id={c.kind === 'group' ? c.id : c.peerId} name={c.name} photo={c.photo} size={48} /></span>
                  <span className="chat-item-main">
                    <span className="chat-item-row">
                      <span className="chat-item-name">{c.name}</span>
                      <span className="chat-item-at">{listTime(c.lastAt)}</span>
                    </span>
                    <span className="chat-item-row">
                      <span className="chat-item-preview">
                        {c.last && c.last.files > 0 && !c.last.body && <Icon name={c.last.fileKind === 'image' ? 'image' : c.last.fileKind === 'audio' ? 'mic' : 'clip'} size={14} />}
                        {preview(c)}
                      </span>
                      {c.unread > 0 && <span className="chat-badge">{c.unread}</span>}
                    </span>
                  </span>
                </button>
              );
            })}
            {hits.length > 0 && (
              <>
                <p className="chat-list-label">{tr('Messages')}</p>
                {hits.map((h) => (
                  <button key={h.id} type="button" className="chat-item" onClick={() => { setJumpTo(h.id); open({ type: 'conv', id: h.conversationId }); }}>
                    <Photo kind={h.kind === 'group' ? 'group' : 'person'} id={h.kind === 'group' ? h.conversationId : h.peerId} name={h.name} photo={h.photo} size={48} />
                    <span className="chat-item-main">
                      <span className="chat-item-row"><span className="chat-item-name">{h.name}</span><span className="chat-item-at">{listTime(h.at)}</span></span>
                      <span className="chat-item-preview chat-hit-body">{(h.fromMe ? tr('You') : h.fromName.split(' ')[0]) + ': '}{highlight(h.body)}</span>
                    </span>
                  </button>
                ))}
              </>
            )}
            {newPeople.length > 0 && (
              <>
                <p className="chat-list-label">{tr('Start a new chat')}</p>
                {newPeople.map((p) => (
                  <button key={p.id} type="button" className="chat-item" onClick={() => { setSearch(''); open({ type: 'peer', id: p.id }); }}>
                    <Photo id={p.id} name={p.name} photo={p.photo} size={48} />
                    <span className="chat-item-main">
                      <span className="chat-item-name">{p.name}</span>
                      <span className="chat-item-preview">{[p.title, p.department].filter(Boolean).join(' · ')}</span>
                    </span>
                  </button>
                ))}
              </>
            )}
            {!inbox.length && !search && (
              <div className="chat-empty">
                <span className="chat-empty-icon"><Icon name="chat" size={28} /></span>
                <p className="chat-empty-title">{tr('No chats yet')}</p>
                <p className="chat-muted">{tr('Message a colleague, or start a group for your team.')}</p>
                <div className="chat-empty-actions">
                  <button type="button" className="btn btn-primary" onClick={() => setDialog('newChat')}>{tr('New chat')}</button>
                  <button type="button" className="btn btn-secondary" onClick={() => setDialog('newGroup')}>{tr('New group')}</button>
                </div>
              </div>
            )}
            {!!inbox.length && !visibleInbox.length && !newPeople.length && !hits.length && <p className="chat-muted chat-pad">{tr('No chats match.')}</p>}
          </div>
        </aside>

        {/* ── the open chat ── */}
        <section className="chat-thread"
          onDragOver={(e) => { if (conv && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
          onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
          onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}>
          {conv ? (
            <>
              <header className="chat-thread-head">
                <button type="button" className="chat-icon-btn chat-back" onClick={() => setActive(null)} aria-label={tr('Back to chats')}><Icon name="back" /></button>
                <button type="button" className="chat-thread-id" onClick={() => setInfoOpen(true)}>
                  <span className={'chat-av' + (peerOnline ? ' is-online' : '')}><Photo kind={isGroup ? 'group' : 'person'} id={isGroup ? conv.id : conv.peerId} name={conv.name} photo={conv.photo} size={42} /></span>
                  <span className="chat-thread-text">
                    <span className="chat-thread-name">{conv.name}</span>
                    <span className={'chat-muted chat-thread-sub' + subtitleClass}>{subtitle}</span>
                  </span>
                </button>
                <button type="button" className="chat-icon-btn" disabled={!calls.configured} onClick={() => calls.startCall(conv.id, 'voice', conv.name)}
                  aria-label={tr('Voice call')} title={calls.configured ? tr('Voice call') : tr('Calls aren\'t set up yet')}><CallIcon name="phone" /></button>
                <button type="button" className="chat-icon-btn" disabled={!calls.configured} onClick={() => calls.startCall(conv.id, 'video', conv.name)}
                  aria-label={tr('Video call')} title={calls.configured ? tr('Video call') : tr('Calls aren\'t set up yet')}><CallIcon name="video" /></button>
                <button type="button" className="chat-icon-btn" onClick={() => setBooking(true)} aria-label={tr('Book a meeting')} title={tr('Book a meeting')}><CallIcon name="calendar" /></button>
                <button type="button" className="chat-icon-btn" onClick={() => setInfoOpen((v) => !v)} aria-label={isGroup ? tr('Group info') : tr('Contact info')} title={isGroup ? tr('Group info') : tr('Contact info')}><Icon name="info" /></button>
              </header>
              {liveHere && !liveHere.inCall && (
                <div className="chat-call-bar" role="status">
                  <span className="chat-call-bar-icon"><CallIcon name={liveHere.kind === 'video' ? 'video' : 'phone'} size={16} /></span>
                  <span className="chat-call-bar-text">
                    <strong>{liveHere.meetingTitle || (liveHere.kind === 'video' ? tr('Video call in progress') : tr('Voice call in progress'))}</strong>
                    <span className="chat-muted">{liveHere.people === 1 ? tr('1 person in the call') : tr('{n} people in the call', { n: liveHere.people })}</span>
                  </span>
                  <button type="button" className="btn btn-primary" onClick={() => (liveHere.meetingId ? calls.joinMeeting(liveHere.meetingId, liveHere.meetingTitle || conv.name) : calls.joinCall(liveHere.id, conv.name))}>{tr('Join')}</button>
                </div>
              )}

              {pin && (
                <div className="chat-pinned" key={pin.id}>
                  <ChatGlyph name="pin" size={16} />
                  <button type="button" className="chat-pinned-open" onClick={() => { setJumpTo(pin.id); setPinIndex((i) => (i + 1) % pins.length); }}
                    title={pins.length > 1 ? tr('Show the next pinned message') : tr('Go to the pinned message')}>
                    <span className="chat-pinned-label">{pins.length > 1 ? tr('Pinned message {n} of {total}', { n: Math.min(pinIndex, pins.length - 1) + 1, total: pins.length }) : tr('Pinned message')}</span>
                    <span className="chat-pinned-text">{pin.fromName.split(' ')[0]}: {pin.body || (pin.record ? recordLabel(pin.record.type) + ': ' + pin.record.title : filesLabel(pin.files, pin.fileKind))}</span>
                  </button>
                  {pins.length > 1 && <span className="chat-pinned-bars" aria-hidden="true">{pins.map((pp, i) => <i key={pp.id} className={i === Math.min(pinIndex, pins.length - 1) ? 'is-on' : ''} />)}</span>}
                  {conv.canPin && <button type="button" className="chat-icon-btn is-small" onClick={() => msgAction(() => api.post('/messages/m/' + pin.id + '/pin', { pinned: false }))} aria-label={tr('Unpin')} title={tr('Unpin')}><ChatGlyph name="close" size={15} /></button>}
                </div>
              )}

              <MediaLoaded.Provider value={onMediaLoaded}>
              <div className="chat-thread-body" ref={bodyRef} onScroll={onBodyScroll}>
                {!conv.messages.length && (
                  <div className="chat-thread-start">
                    <Photo kind={isGroup ? 'group' : 'person'} id={isGroup ? conv.id : conv.peerId} name={conv.name} photo={conv.photo} size={72} />
                    <p className="chat-empty-title">{isGroup ? conv.name : tr('Say hello to {name}', { name: conv.name.split(' ')[0] })}</p>
                    <p className="chat-muted">{tr('Messages, photos and files you send here are only seen by the people in this chat.')}</p>
                  </div>
                )}
                {items.map((it) => {
                  if (it.type === 'day') return <div className="chat-day" key={it.key}><span>{it.label}</span></div>;
                  if (it.type === 'system') {
                    const sm = it.message, meta = sm.meta || {};
                    if (meta.type === 'meeting') return <div className="chat-meeting" key={it.key}><MeetingCard meetingId={meta.meetingId} locale={activeIntlLocale()} /></div>;
                    const running = meta.type === 'call' ? calls.live.find((c) => c.id === meta.callId && !c.inCall) : null;
                    return (
                      <div className="chat-system" key={it.key}>
                        <span>
                          {(meta.type === 'call' || meta.type === 'callEnded') && <CallIcon name={meta.kind === 'video' ? 'video' : 'phone'} size={14} />}
                          {systemText(meta, sm.fromMe ? tr('You') : sm.fromName)}
                          {running && <button type="button" className="chat-system-join" onClick={() => calls.joinCall(running.id, conv.name)}>{tr('Join')}</button>}
                        </span>
                      </div>
                    );
                  }
                  const m = it.message;
                  const sender = peopleById[m.fromId];
                  const hasFiles = m.attachments.length > 0;
                  const onlyMedia = !m.body && hasFiles && !m.replyTo && !m.forwarded && m.attachments.every((a) => a.kind === 'image');
                  const seen = m.fromMe && !m.deleted ? seenState(m) : null;
                  const mine = (m.reactions || []).find((r) => r.mine);
                  const align = m.fromMe ? 'right' : 'left';
                  return (
                    <div key={it.key} id={'msg-' + m.id}
                      className={'chat-row' + (m.fromMe ? ' is-mine' : '') + (it.isFirst ? ' is-first' : '') + (freshIds.has(m.id) ? ' is-new' : '') + (flash === m.id ? ' is-flash' : '') + (selectedMsg === m.id ? ' is-selected' : '')}>
                      {!m.fromMe && isGroup && (
                        <span className="chat-row-avatar">{it.isLast && <Photo id={m.fromId} name={m.fromName} photo={sender ? sender.photo : null} size={30} />}</span>
                      )}
                      <div className="chat-bubble-wrap">
                        <div className={'chat-bubble' + (m.fromMe ? ' is-mine' : '') + (!it.isFirst ? ' is-cont-top' : '') + (!it.isLast ? ' is-cont-bottom' : '') + (onlyMedia && !m.deleted ? ' is-media' : '')}
                          onClick={(e) => { if (!m.deleted && !e.target.closest('button, a, audio, video, input')) setSelectedMsg((x) => (x === m.id ? null : m.id)); }}
                          onDoubleClick={(e) => { if (!m.deleted && !e.target.closest('button, a, audio, video')) react(m, '❤️'); }}>
                          {!m.fromMe && isGroup && it.isFirst && <span className="chat-sender" style={{ color: colorFor(m.fromName) }}>{m.fromName}</span>}
                          {m.forwarded && !m.deleted && <span className="chat-fwd"><ChatGlyph name="forward" size={13} /> {tr('Forwarded')}</span>}
                          {m.replyTo && !m.deleted && <ReplyQuote reply={m.replyTo} onJump={m.replyTo.deleted ? null : () => setJumpTo(m.replyTo.id)} />}
                          {m.deleted ? (
                            <span className="chat-deleted"><ChatGlyph name="ban" size={15} /> {m.fromMe ? tr('You deleted this message') : tr('This message was deleted')}</span>
                          ) : (
                            <>
                              {hasFiles && <Attachments list={m.attachments} onOpenImage={(id) => setLightbox({ list: images, index: images.findIndex((x) => x.id === id) })} />}
                              {m.record && <RecordCard record={m.record} onOpen={() => openRecord(m.record)} />}
                              {m.body && <RichText text={m.body} names={isGroup ? memberNames : []} />}
                            </>
                          )}
                          <span className="chat-meta">
                            {m.pinned && <span className="chat-pin-mark" title={tr('Pinned')}><ChatGlyph name="pin" size={11} /></span>}
                            {m.editedAt && !m.deleted && <span className="chat-edited">{tr('edited')}</span>}
                            <span className="chat-time">{hhmm(m.at)}</span>
                            {seen && isGroup && seen.count > 0 && (
                              <button type="button" className={'chat-seen-count' + (seen.all ? ' is-all' : '')} onClick={() => setSeenFor(m.id)} title={tr('See who has seen it')} aria-label={tr('Seen by {n}. See who.', { n: seen.count })}>
                                <ChatGlyph name="eye" size={12} />{seen.count}
                              </button>
                            )}
                            {seen && <SeenTicks state={seen.state} title={seen.title} onClick={isGroup ? () => setSeenFor(m.id) : undefined} />}
                          </span>
                        </div>
                        {!m.deleted && <ReactionChips reactions={m.reactions} onToggle={(emoji) => react(m, emoji)} />}
                        {!m.deleted && (
                          <div className="chat-actions">
                            <button type="button" onClick={(e) => { const pl = placeFor(e); setMenuFor(null); setPickerFor(pickerFor && pickerFor.id === m.id ? null : { id: m.id, down: pl.down }); }} aria-label={tr('React')} title={tr('React')}><ChatGlyph name="smile" /></button>
                            <button type="button" onClick={() => startReply(m)} aria-label={tr('Reply')} title={tr('Reply')}><ChatGlyph name="reply" /></button>
                            <button type="button" onClick={(e) => { const pl = placeFor(e); setPickerFor(null); setMenuFor(menuFor && menuFor.id === m.id ? null : { id: m.id, up: pl.up }); }} aria-label={tr('More')} title={tr('More')}><ChatGlyph name="more" /></button>
                          </div>
                        )}
                        {pickerFor && pickerFor.id === m.id && <ReactionPicker choices={conv.reactionChoices || []} mine={mine && mine.emoji} align={align} down={pickerFor.down} onPick={(emoji) => react(m, emoji)} onClose={() => setPickerFor(null)} />}
                        {menuFor && menuFor.id === m.id && <MessageMenu items={menuItems(m)} align={align} up={menuFor.up} onClose={() => setMenuFor(null)} />}
                        {burst && burst.id === m.id && <Burst key={burst.key} emoji={burst.emoji} />}
                      </div>
                    </div>
                  );
                })}
                <TypingBubble names={typingNames} isGroup={isGroup} />
                <div ref={endRef} />
              </div>
              </MediaLoaded.Provider>

              {dragging && <div className="chat-drop"><Icon name="clip" size={30} /><span>{tr('Drop files to send them')}</span></div>}

              {pending.length > 0 && (
                <div className="chat-pending">
                  {pending.map((p) => (
                    <div key={p.key} className="chat-pending-item">
                      {p.kind === 'image' ? <img src={p.url} alt="" /> : p.kind === 'video' ? <video src={p.url} muted /> : (
                        <span className="chat-pending-file" style={{ background: fileBadge(p.file.name, p.kind).tone }}>{fileBadge(p.file.name, p.kind).label}</span>
                      )}
                      <span className="chat-pending-name">{p.file.name}<br /><span className="chat-muted">{fmtSize(p.file.size)}</span></span>
                      <button type="button" className="chat-pending-x" onClick={() => removePending(p.key)} aria-label={tr('Remove {name}', { name: p.file.name })}><Icon name="close" size={14} /></button>
                    </div>
                  ))}
                </div>
              )}
              {progress !== null && <div className="chat-progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: Math.round(progress * 100) + '%' }} /></div>}

              {(replyTo || editingMsg) && (
                <div className="chat-context" key={(replyTo || editingMsg).id}>
                  <ChatGlyph name={editingMsg ? 'edit' : 'reply'} size={18} />
                  <ReplyQuote inComposer reply={editingMsg ? { fromName: tr('Editing your message'), body: editingMsg.body } : { fromName: tr('Replying to {name}', { name: replyTo.fromMe ? tr('yourself') : replyTo.fromName }), body: replyTo.body, files: replyTo.attachments.length, fileKind: replyTo.attachments[0] && replyTo.attachments[0].kind, record: replyTo.record }} />
                  <button type="button" className="chat-icon-btn is-small" onClick={cancelContext} aria-label={tr('Cancel')} title={tr('Cancel')}><ChatGlyph name="close" size={15} /></button>
                </div>
              )}
              <form className="chat-compose" onSubmit={send} style={{ position: 'relative' }}>
                {mention && <MentionPopup people={mentionPeople} index={mention.index} onPick={pickMention} />}
                <input ref={fileInputRef} type="file" multiple accept={ACCEPT_FILES} hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
                <input ref={mediaInputRef} type="file" multiple accept="image/*,video/*" hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
                {recording ? (
                  <div className="chat-recording">
                    <span className="chat-rec-dot" aria-hidden="true" />
                    <span>{tr('Recording')} {secs(recording.seconds)}</span>
                    <button type="button" className="btn btn-secondary chat-rec-cancel" onClick={() => stopRecording(true)}>{tr('Cancel')}</button>
                    <button type="button" className="chat-send" onClick={() => stopRecording(false)} aria-label={tr('Stop and send')} title={tr('Stop and send')}><Icon name="send" /></button>
                  </div>
                ) : (
                  <>
                    {!editingMsg && (
                      <>
                        <button type="button" className="chat-icon-btn" onClick={() => fileInputRef.current.click()} aria-label={tr('Attach files')} title={tr('Attach documents, photos or audio')} disabled={sending}><Icon name="clip" /></button>
                        <button type="button" className="chat-icon-btn chat-media-btn" onClick={() => mediaInputRef.current.click()} aria-label={tr('Photos and videos')} title={tr('Photos and videos')} disabled={sending}><Icon name="image" /></button>
                        <button type="button" className="chat-icon-btn" onClick={() => setRecordPicker(true)} aria-label={tr('Share from the OS')} title={tr('Share a work order, invoice, quotation, client, lead or leave request')} disabled={sending}><ChatGlyph name="grid" size={18} /></button>
                      </>
                    )}
                    <textarea ref={composerRef} className="chat-input" rows={1} value={draft}
                      onChange={onDraftChange} onKeyDown={onComposerKey} onPaste={onPaste} onBlur={() => setTimeout(() => setMention(null), 150)}
                      placeholder={editingMsg ? tr('Edit your message…') : pending.length ? tr('Add a caption…') : isGroup ? tr('Message… (@ to mention)') : tr('Write a message…')} aria-label={tr('Message')} disabled={sending} />
                    {editingMsg ? (
                      <button type="submit" key="save" className="chat-send" disabled={sending} aria-label={tr('Save')} title={tr('Save')}><ChatGlyph name="check" size={18} /></button>
                    ) : draft.trim() || pending.length ? (
                      <button type="submit" key="send" className="chat-send" disabled={sending} aria-label={tr('Send')} title={tr('Send')}><Icon name="send" /></button>
                    ) : (
                      <button type="button" key="mic" className="chat-send is-mic" onClick={startRecording} disabled={sending} aria-label={tr('Record a voice note')} title={tr('Record a voice note')}><Icon name="mic" /></button>
                    )}
                  </>
                )}
              </form>
            </>
          ) : (
            <div className="chat-placeholder">
              <span className="chat-empty-icon is-big"><Icon name="chat" size={40} /></span>
              <p className="chat-empty-title">{tr('Pick a chat, or start one')}</p>
              <p className="chat-muted">{tr('Send messages, photos, videos, voice notes and documents to a colleague or a whole team.')}</p>
              <div className="chat-empty-actions">
                <button type="button" className="btn btn-primary" onClick={() => setDialog('newChat')}>{tr('New chat')}</button>
                <button type="button" className="btn btn-secondary" onClick={() => setDialog('newGroup')}>{tr('New group')}</button>
              </div>
            </div>
          )}
        </section>

        {/* ── contact / group info ── */}
        {conv && infoOpen && (
          <aside className="chat-info" aria-label={isGroup ? tr('Group info') : tr('Contact info')}>
            <header className="chat-info-head">
              <button type="button" className="chat-icon-btn" onClick={() => setInfoOpen(false)} aria-label={tr('Close')}><Icon name="close" /></button>
              <strong>{isGroup ? tr('Group info') : tr('Contact info')}</strong>
            </header>
            <div className="chat-info-body">
              <div className="chat-info-hero">
                <div className="chat-info-photo">
                  <Photo kind={isGroup ? 'group' : 'person'} id={isGroup ? conv.id : conv.peerId} name={conv.name} photo={conv.photo} size={120} />
                  {(isGroup ? amAdmin : can('employee.write')) && (
                    <button type="button" className="chat-info-photo-btn" onClick={() => setDialog(isGroup ? 'groupPhoto' : 'personPhoto')} aria-label={tr('Change photo')} title={tr('Change photo')}><Icon name="camera" /></button>
                  )}
                </div>
                {editing ? (
                  <div className="chat-info-edit">
                    <input className="input" value={editing.name} maxLength={80} onChange={(e) => setEditing({ ...editing, name: e.target.value })} aria-label={tr('Group name')} />
                    <textarea className="input" value={editing.description} maxLength={300} rows={3} placeholder={tr('What is this group for? (optional)')} onChange={(e) => setEditing({ ...editing, description: e.target.value })} aria-label={tr('Description')} />
                    <div className="chat-info-edit-actions">
                      <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>{tr('Cancel')}</button>
                      <button type="button" className="btn btn-primary" disabled={!editing.name.trim()} onClick={() => groupAction(async () => { await api.patch('/messages/conversations/' + conv.id, editing); setEditing(null); })}>{tr('Save')}</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <h3 className="chat-info-name">{conv.name}{amAdmin && <button type="button" className="chat-icon-btn is-small" onClick={() => setEditing({ name: conv.name, description: conv.description || '' })} aria-label={tr('Edit group name and description')}><Icon name="edit" size={15} /></button>}</h3>
                    <p className="chat-muted">{isGroup ? tr('Group · {n} members', { n: conv.members.length }) : [conv.title, conv.department].filter(Boolean).join(' · ')}</p>
                    {isGroup && conv.description && <p className="chat-info-desc">{conv.description}</p>}
                  </>
                )}
              </div>

              {isGroup && (
                <section className="chat-info-section">
                  <div className="chat-info-section-head">
                    <strong>{tr('{n} members', { n: conv.members.length })}</strong>
                    {amAdmin && <button type="button" className="btn btn-secondary chat-small-btn" onClick={() => { setAddSel([]); setDialog('addPeople'); }}><Icon name="userPlus" size={15} /> {tr('Add people')}</button>}
                  </div>
                  <ul className="chat-members">
                    {conv.members.map((mb) => (
                      <li key={mb.id}>
                        <span className={'chat-av' + (!mb.me && onlineIds.has(mb.id) ? ' is-online' : '')}><Photo id={mb.id} name={mb.name} photo={mb.photo} size={38} /></span>
                        <span className="chat-person-text">
                          <span className="chat-person-name">{mb.me ? tr('You') : mb.name}</span>
                          <span className="chat-muted">{mb.title}</span>
                        </span>
                        {mb.role === 'admin' && <span className="chat-admin-tag"><Icon name="shield" size={12} /> {tr('Admin')}</span>}
                        {amAdmin && !mb.me && (
                          <span className="chat-member-actions">
                            <button type="button" className="chat-link" onClick={() => groupAction(() => api.post('/messages/conversations/' + conv.id + '/admins/' + mb.id, { admin: mb.role !== 'admin' }))}>{mb.role === 'admin' ? tr('Remove admin') : tr('Make admin')}</button>
                            <button type="button" className="chat-link is-danger" onClick={() => { if (window.confirm(tr('Remove {name} from the group?', { name: mb.name }))) groupAction(() => api.del('/messages/conversations/' + conv.id + '/members/' + mb.id)); }}>{tr('Remove')}</button>
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {(() => {
                const pics = shared ? shared.images : images.slice().reverse();
                const docs = shared ? shared.files : sharedFiles;
                const recs = shared ? shared.records : [];
                return (
                  <>
                    <section className="chat-info-section">
                      <div className="chat-info-section-head"><strong>{tr('Photos')}</strong><span className="chat-muted">{pics.length}</span></div>
                      {pics.length ? (
                        <div className="chat-info-media">
                          {pics.slice(0, 24).map((a, i) => <ImageTile key={a.id} a={a} count={2} onOpen={() => setLightbox({ list: pics, index: i })} />)}
                        </div>
                      ) : <p className="chat-muted">{tr('No photos shared yet.')}</p>}
                    </section>
                    <section className="chat-info-section">
                      <div className="chat-info-section-head"><strong>{tr('Files, audio and videos')}</strong><span className="chat-muted">{docs.length}</span></div>
                      {docs.length ? <div className="chat-info-files">{docs.slice(0, 20).map((a) => (a.kind === 'video' ? <VideoItem key={a.id} a={a} /> : a.kind === 'audio' ? <AudioItem key={a.id} a={a} /> : <FileCard key={a.id} a={a} />))}</div>
                        : <p className="chat-muted">{tr('No files shared yet.')}</p>}
                    </section>
                    <section className="chat-info-section">
                      <div className="chat-info-section-head"><strong>{tr('Shared from the OS')}</strong><span className="chat-muted">{recs.length}</span></div>
                      {recs.length ? <div className="chat-info-records">{recs.slice(0, 20).map((r) => <RecordCard key={r.messageId} record={r.record} onOpen={() => openRecord(r.record)} />)}</div>
                        : <p className="chat-muted">{tr('No work orders, invoices or other records shared yet.')}</p>}
                    </section>
                  </>
                );
              })()}

              {isGroup && (
                <button type="button" className="btn btn-secondary chat-leave" onClick={leaveGroup}><Icon name="leave" size={16} /> {tr('Leave group')}</button>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* ── dialogs ── */}
      {dialog === 'newChat' && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <div className="dialog chat-dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('New chat')}</h2>
            <button type="button" className="chat-person chat-new-group-row" onClick={() => { setGroupForm({ step: 1, members: [], name: '', description: '' }); setDialog('newGroup'); }}>
              <span className="photo photo-group chat-new-group-icon"><Icon name="group" size={20} /></span>
              <span className="chat-person-text"><span className="chat-person-name">{tr('New group')}</span><span className="chat-muted">{tr('Chat with several people at once')}</span></span>
            </button>
            <PeoplePicker people={people} selected={[]} onToggle={(id) => { setDialog(null); open({ type: 'peer', id }); }} />
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>{tr('Cancel')}</button></div>
          </div>
        </div>
      )}

      {dialog === 'newGroup' && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <div className="dialog chat-dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{groupForm.step === 1 ? tr('New group: who is in it?') : tr('New group: name and photo')}</h2>
            {groupForm.step === 1 ? (
              <>
                <p className="chat-muted">{tr('Pick the people to add. You can add more later.')}</p>
                <PeoplePicker people={people} selected={groupForm.members}
                  onToggle={(id) => setGroupForm((g) => ({ ...g, members: g.members.includes(id) ? g.members.filter((x) => x !== id) : [...g.members, id] }))} />
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>{tr('Cancel')}</button>
                  <button type="button" className="btn btn-primary" disabled={!groupForm.members.length} onClick={() => setGroupForm((g) => ({ ...g, step: 2 }))}>
                    {tr('Next ({n} picked)', { n: groupForm.members.length })}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="chat-group-setup">
                  <label className="chat-group-photo" title={tr('Group photo')}>
                    {groupForm.photoUrl ? <img src={groupForm.photoUrl} alt="" /> : <span><Icon name="camera" size={26} /><small>{tr('Add photo')}</small></span>}
                    <input type="file" accept="image/*" hidden onChange={async (e) => {
                      const f = e.target.files && e.target.files[0];
                      e.target.value = '';
                      if (!f) return;
                      try { const sq = await squarePhoto(f); setGroupForm((g) => ({ ...g, photoFile: sq, photoUrl: URL.createObjectURL(sq) })); } catch (err) { setError(err.message); }
                    }} />
                  </label>
                  <div className="chat-group-fields">
                    <div className="field"><label htmlFor="grp-name">{tr('Group name')}</label>
                      <input id="grp-name" className="input" maxLength={80} value={groupForm.name} autoFocus onChange={(e) => setGroupForm((g) => ({ ...g, name: e.target.value }))} placeholder={tr('e.g. Factory supervisors')} /></div>
                    <div className="field"><label htmlFor="grp-desc">{tr('Description (optional)')}</label>
                      <textarea id="grp-desc" className="input" rows={2} maxLength={300} value={groupForm.description} onChange={(e) => setGroupForm((g) => ({ ...g, description: e.target.value }))} /></div>
                  </div>
                </div>
                <p className="chat-muted">{tr('{n} people plus you. You will be the group admin: you can rename it, change its photo and add or remove people.', { n: groupForm.members.length })}</p>
                <div className="dialog-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setGroupForm((g) => ({ ...g, step: 1 }))}>{tr('Back')}</button>
                  <button type="button" className="btn btn-primary" disabled={!groupForm.name.trim()} onClick={createGroup}>{tr('Create group')}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {dialog === 'addPeople' && conv && (
        <div className="dialog-backdrop" onClick={() => setDialog(null)}>
          <div className="dialog chat-dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Add people to "{name}"', { name: conv.name })}</h2>
            <PeoplePicker people={people} selected={addSel} exclude={conv.members.map((m) => m.id)}
              onToggle={(id) => setAddSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))} />
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={!addSel.length} onClick={() => groupAction(async () => { await api.post('/messages/conversations/' + conv.id + '/members', { employeeIds: addSel }); setDialog(null); })}>
                {tr('Add {n}', { n: addSel.length })}
              </button>
            </div>
          </div>
        </div>
      )}

      {dialog === 'myPhoto' && (
        <PhotoDialog title={tr('Your photo')} kind="person" id={me.id} name={myName} photo={myPhoto === 'probe' ? 'probe' : myPhoto}
          uploadPath="/messages/people/me/photo"
          onDone={(v) => { forgetBlob('/messages/people/' + me.id + '/photo'); setMyPhoto(v); setDialog(null); api.get('/messages/directory').then(setPeople).catch(() => {}); }}
          onClose={() => setDialog(null)} />
      )}
      {dialog === 'personPhoto' && conv && !isGroup && (
        <PhotoDialog title={tr('Photo of {name}', { name: conv.name })} kind="person" id={conv.peerId} name={conv.name} photo={conv.photo}
          uploadPath={'/messages/people/' + conv.peerId + '/photo'}
          onDone={() => { forgetBlob('/messages/people/' + conv.peerId + '/photo'); setDialog(null); loadConv(active, true); loadInbox(); api.get('/messages/directory').then(setPeople).catch(() => {}); }}
          onClose={() => setDialog(null)} />
      )}
      {dialog === 'groupPhoto' && conv && isGroup && (
        <PhotoDialog title={tr('Group photo')} kind="group" id={conv.id} name={conv.name} photo={conv.photo}
          uploadPath={'/messages/conversations/' + conv.id + '/photo'}
          onDone={() => { forgetBlob('/messages/conversations/' + conv.id + '/photo'); setDialog(null); loadConv(active, true); loadInbox(); }}
          onClose={() => setDialog(null)} />
      )}

      {lightbox && lightbox.index >= 0 && (
        <Lightbox images={lightbox.list} index={lightbox.index} onIndex={(i) => setLightbox((l) => ({ ...l, index: i }))} onClose={() => setLightbox(null)} />
      )}

      {forwardMsg && (
        <ForwardDialog inbox={inbox} people={people} onClose={() => setForwardMsg(null)}
          onSend={async (sel) => {
            const r = await api.post('/messages/m/' + forwardMsg.id + '/forward', {
              conversationIds: sel.filter((x) => x.kind === 'conv').map((x) => x.id), peerIds: sel.filter((x) => x.kind === 'peer').map((x) => x.id)
            });
            setForwardMsg(null);
            setNotice(r.sent === 1 ? tr('Forwarded to 1 chat.') : tr('Forwarded to {n} chats.', { n: r.sent }));
            loadInbox();
          }} />
      )}
      {recordPicker && (
        <RecordPicker onClose={() => setRecordPicker(false)} onPick={(r) => { setRecordPicker(false); send(null, null, r); }} />
      )}
      {deleteMsg && (
        <div className="dialog-backdrop" onClick={() => setDeleteMsg(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Delete this message?')}</h2>
            <p className="dialog-body">{tr('It is removed for everyone in the chat, with its files. A note that it was deleted stays in its place.')}</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeleteMsg(null)}>{tr('Cancel')}</button>
              <button type="button" className="btn btn-primary" onClick={() => { const m = deleteMsg; setDeleteMsg(null); msgAction(() => api.del('/messages/m/' + m.id), () => setNotice(tr('Message deleted.'))); }}>{tr('Delete')}</button>
            </div>
          </div>
        </div>
      )}
      {seenFor && <SeenDialog messageId={seenFor} locale={activeIntlLocale()} onClose={() => setSeenFor(null)} />}
      {booking && conv && (
        <ScheduleMeetingDialog conversationId={conv.id} onClose={() => setBooking(false)}
          onSaved={() => { setBooking(false); setMeetingsKey((k) => k + 1); loadConv({ type: 'conv', id: conv.id }, true); loadInbox(); }} />
      )}
      {notice && <div className="chat-notice" role="status" key={notice}>{notice}</div>}
    </div>
  );
}
