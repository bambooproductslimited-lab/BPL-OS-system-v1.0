import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import Photo, { colorFor, forgetBlob, useBlobUrl } from '../components/Photo';
import {
  ACCEPT_FILES, MAX_FILES, MAX_FILE_BYTES, downloadProtected, fileBadge, fmtSize, kindOf, shrinkPhoto, squarePhoto, uploadWithProgress
} from '../lib/chatMedia';
import { tr, activeIntlLocale } from '../lib/i18n.jsx';
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

const GROUP_GAP_MS = 5 * 60 * 1000;
const POLL_MS = 6000;

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

// A group event, in the reader's language.
function systemText(meta) {
  if (!meta) return '';
  const names = (meta.names || []).join(', ');
  switch (meta.event) {
    case 'created': return tr('{by} created the group "{name}"', { by: meta.by, name: meta.name });
    case 'added': return tr('{by} added {names}', { by: meta.by, names });
    case 'removed': return tr('{by} removed {names}', { by: meta.by, names });
    case 'left': return tr('{by} left the group', { by: meta.by });
    case 'renamed': return tr('{by} renamed the group to "{name}"', { by: meta.by, name: meta.name });
    case 'photo': return tr('{by} changed the group photo', { by: meta.by });
    case 'photoRemoved': return tr('{by} removed the group photo', { by: meta.by });
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

// Choose / remove a square photo for a person or a group.
function PhotoDialog({ title, kind, id, name, photo, uploadPath, onDone, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  async function choose(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const sq = await squarePhoto(file);
      const fd = new FormData(); fd.append('photo', sq);
      const r = await uploadWithProgress(uploadPath, fd);
      forgetBlob(uploadPath);
      onDone(r.photo);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true); setError(null);
    try { await api.del(uploadPath); forgetBlob(uploadPath); onDone(null); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog chat-photo-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <div className="chat-photo-preview"><Photo kind={kind} id={id} name={name} photo={photo} size={140} /></div>
        {error && <div className="error-banner">{error}</div>}
        <p className="chat-muted">{tr('The photo is cropped to a square. Everyone in the OS can see profile photos; a group photo is seen by its members.')}</p>
        <input ref={inputRef} type="file" accept="image/*" hidden onChange={choose} />
        <div className="dialog-actions">
          {photo && <button type="button" className="btn btn-secondary" disabled={busy} onClick={remove}>{tr('Remove photo')}</button>}
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => inputRef.current.click()}>{busy ? tr('Saving…') : photo ? tr('Choose a new photo') : tr('Choose a photo')}</button>
        </div>
      </div>
    </div>
  );
}

export default function MessagesPage() {
  const { session, can } = useAuth();
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
  const [lightbox, setLightbox] = useState(null); // index into images
  const [myPhoto, setMyPhoto] = useState('probe');

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
  useEffect(() => { setInfoOpen(false); setEditing(null); loadConv(active); }, [active, loadConv]);

  // Keep the list and the open chat fresh while the page is visible.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      loadInbox();
      if (active && active.type === 'conv' && !sending) loadConv(active, true);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [active, sending, loadInbox, loadConv]);

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
  const images = useMemo(() => (conv ? conv.messages.flatMap((m) => m.attachments.filter((a) => a.kind === 'image')) : []), [conv]);
  const sharedFiles = useMemo(() => (conv ? conv.messages.flatMap((m) => m.attachments.filter((a) => a.kind !== 'image')).reverse() : []), [conv]);
  const peopleById = useMemo(() => Object.fromEntries(people.map((p) => [p.id, p])), [people]);

  function open(a) {
    setDraft('');
    clearPending();
    setActive(a);
  }

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

  async function send(e, extraFiles) {
    if (e) e.preventDefault();
    const body = draft.trim();
    const files = extraFiles || pending.map((p) => p.file);
    if (!body && !files.length) return;
    if (!active) return;
    setSending(true); setError(null); setProgress(files.length ? 0 : null);
    try {
      const path = active.type === 'conv' ? '/messages/conversations/' + active.id : '/messages/' + active.id;
      let r;
      if (files.length) {
        const fd = new FormData();
        if (body) fd.append('body', body);
        files.forEach((f) => fd.append('files', f, f.name));
        r = await uploadWithProgress(path, fd, setProgress);
      } else {
        r = await api.post(path, { body });
      }
      setDraft('');
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
    if (l.kind === 'system') return systemText(l.meta);
    const who = l.fromMe ? tr('You') + ': ' : c.kind === 'group' ? l.fromName + ': ' : '';
    return who + (l.body || filesLabel(l.files, l.fileKind));
  }

  const isGroup = conv && conv.kind === 'group';
  const amAdmin = isGroup && conv.myRole === 'admin';
  const subtitle = conv ? (isGroup
    ? conv.members.map((m) => (m.me ? tr('You') : m.name.split(' ')[0])).join(', ')
    : [conv.title, conv.department].filter(Boolean).join(' · ')) : '';

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
          <div className="chat-list-items">
            {visibleInbox.map((c) => {
              const on = active && ((active.type === 'conv' && active.id === c.id) || (active.type === 'peer' && active.id === c.peerId));
              return (
                <button key={c.id} type="button" className={'chat-item' + (on ? ' is-active' : '') + (c.unread ? ' is-unread' : '')} onClick={() => open({ type: 'conv', id: c.id })}>
                  <Photo kind={c.kind === 'group' ? 'group' : 'person'} id={c.kind === 'group' ? c.id : c.peerId} name={c.name} photo={c.photo} size={48} />
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
            {!!inbox.length && !visibleInbox.length && !newPeople.length && <p className="chat-muted chat-pad">{tr('No chats match.')}</p>}
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
                  <Photo kind={isGroup ? 'group' : 'person'} id={isGroup ? conv.id : conv.peerId} name={conv.name} photo={conv.photo} size={42} />
                  <span className="chat-thread-text">
                    <span className="chat-thread-name">{conv.name}</span>
                    <span className="chat-muted chat-thread-sub">{subtitle}</span>
                  </span>
                </button>
                <button type="button" className="chat-icon-btn" onClick={() => setInfoOpen((v) => !v)} aria-label={isGroup ? tr('Group info') : tr('Contact info')} title={isGroup ? tr('Group info') : tr('Contact info')}><Icon name="info" /></button>
              </header>

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
                  if (it.type === 'system') return <div className="chat-system" key={it.key}><span>{systemText(it.message.meta)}</span></div>;
                  const m = it.message;
                  const sender = peopleById[m.fromId];
                  const hasFiles = m.attachments.length > 0;
                  const onlyMedia = !m.body && hasFiles && m.attachments.every((a) => a.kind === 'image');
                  return (
                    <div key={it.key} className={'chat-row' + (m.fromMe ? ' is-mine' : '') + (it.isFirst ? ' is-first' : '')}>
                      {!m.fromMe && isGroup && (
                        <span className="chat-row-avatar">{it.isLast && <Photo id={m.fromId} name={m.fromName} photo={sender ? sender.photo : null} size={30} />}</span>
                      )}
                      <div className={'chat-bubble' + (m.fromMe ? ' is-mine' : '') + (!it.isFirst ? ' is-cont-top' : '') + (!it.isLast ? ' is-cont-bottom' : '') + (onlyMedia ? ' is-media' : '')}>
                        {!m.fromMe && isGroup && it.isFirst && <span className="chat-sender" style={{ color: colorFor(m.fromName) }}>{m.fromName}</span>}
                        {hasFiles && <Attachments list={m.attachments} onOpenImage={(id) => setLightbox(images.findIndex((x) => x.id === id))} />}
                        {m.body && <span className="chat-text">{m.body}</span>}
                        <span className="chat-time">{hhmm(m.at)}</span>
                      </div>
                    </div>
                  );
                })}
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

              <form className="chat-compose" onSubmit={send}>
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
                    <button type="button" className="chat-icon-btn" onClick={() => fileInputRef.current.click()} aria-label={tr('Attach files')} title={tr('Attach documents, photos or audio')} disabled={sending}><Icon name="clip" /></button>
                    <button type="button" className="chat-icon-btn chat-media-btn" onClick={() => mediaInputRef.current.click()} aria-label={tr('Photos and videos')} title={tr('Photos and videos')} disabled={sending}><Icon name="image" /></button>
                    <textarea ref={composerRef} className="chat-input" rows={1} value={draft}
                      onChange={(e) => setDraft(e.target.value)} onKeyDown={onComposerKey} onPaste={onPaste}
                      placeholder={pending.length ? tr('Add a caption…') : tr('Write a message…')} aria-label={tr('Message')} disabled={sending} />
                    {draft.trim() || pending.length ? (
                      <button type="submit" className="chat-send" disabled={sending} aria-label={tr('Send')} title={tr('Send')}><Icon name="send" /></button>
                    ) : (
                      <button type="button" className="chat-send is-mic" onClick={startRecording} disabled={sending} aria-label={tr('Record a voice note')} title={tr('Record a voice note')}><Icon name="mic" /></button>
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
                        <Photo id={mb.id} name={mb.name} photo={mb.photo} size={38} />
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

              <section className="chat-info-section">
                <div className="chat-info-section-head"><strong>{tr('Photos')}</strong><span className="chat-muted">{images.length}</span></div>
                {images.length ? (
                  <div className="chat-info-media">
                    {images.slice(-12).reverse().map((a) => <ImageTile key={a.id} a={a} count={2} onOpen={() => setLightbox(images.findIndex((x) => x.id === a.id))} />)}
                  </div>
                ) : <p className="chat-muted">{tr('No photos shared yet.')}</p>}
              </section>
              <section className="chat-info-section">
                <div className="chat-info-section-head"><strong>{tr('Files, audio and videos')}</strong><span className="chat-muted">{sharedFiles.length}</span></div>
                {sharedFiles.length ? <div className="chat-info-files">{sharedFiles.slice(0, 12).map((a) => (a.kind === 'video' ? <VideoItem key={a.id} a={a} /> : a.kind === 'audio' ? <AudioItem key={a.id} a={a} /> : <FileCard key={a.id} a={a} />))}</div>
                  : <p className="chat-muted">{tr('No files shared yet.')}</p>}
              </section>

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

      {lightbox !== null && lightbox >= 0 && (
        <Lightbox images={images} index={lightbox} onIndex={setLightbox} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}
