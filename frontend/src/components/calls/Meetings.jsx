import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { tr } from '../../lib/i18n.jsx';
import CallIcon from './CallIcon';
import { useCalls } from './CallsContext';
import './Calls.css';

// Meetings booked in a chat (calls.service.js): the booking form, the card
// the booking leaves in the chat, and the list of what's coming up.

const EARLY_MS = 15 * 60000, LATE_MS = 60 * 60000;
const DURATIONS = [15, 30, 45, 60, 90, 120, 180];

function pad(n) { return String(n).padStart(2, '0'); }
function localDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function localTime(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function nextHalfHour() { const d = new Date(Date.now() + 30 * 60000); d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0); return d; }

export function meetingState(m, now = Date.now()) {
  const start = new Date(m.startsAt).getTime(), end = start + m.durationMin * 60000;
  if (m.cancelled) return { key: 'cancelled', open: false };
  if (now > end + LATE_MS) return { key: 'over', open: false };
  if (now >= start && now <= end) return { key: 'live', open: true };
  if (now > end) return { key: 'ended', open: true };
  return { key: 'soon', open: now >= start - EARLY_MS, minutes: Math.round((start - now) / 60000) };
}
export function whenText(m, locale) {
  const d = new Date(m.startsAt);
  const today = new Date(); const tomorrow = new Date(Date.now() + 86400000);
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const day = d.toDateString() === today.toDateString() ? tr('Today') : d.toDateString() === tomorrow.toDateString() ? tr('Tomorrow')
    : d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
  return day + ' · ' + time + ' · ' + tr('{n} min', { n: m.durationMin });
}
function statusText(st) {
  if (st.key === 'cancelled') return tr('Cancelled');
  if (st.key === 'over') return tr('Finished');
  if (st.key === 'live') return tr('On now');
  if (st.key === 'ended') return tr('Running over time');
  if (st.minutes <= 60) return st.minutes <= 1 ? tr('Starts in a minute') : tr('Starts in {n} min', { n: st.minutes });
  return '';
}
function guestUrl(token) { return window.location.origin + '/meet/' + token; }

// Re-render every 30 s so "starts in" and the Join button keep up.
function useTick() {
  const [, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set((n) => n + 1), 30000); return () => clearInterval(t); }, []);
}

export function ScheduleMeetingDialog({ conversationId, existing, onClose, onSaved }) {
  const start = existing ? new Date(existing.startsAt) : nextHalfHour();
  const [form, setForm] = useState({
    title: existing ? existing.title : '', kind: existing ? existing.kind : 'video',
    date: localDate(start), time: localTime(start), durationMin: existing ? existing.durationMin : 30,
    note: existing ? existing.note || '' : '', guests: existing ? !!existing.guestLink : false
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    const startsAt = new Date(form.date + 'T' + form.time);
    if (isNaN(startsAt.getTime())) { setError(tr('Choose a date and time.')); setBusy(false); return; }
    const body = { title: form.title, kind: form.kind, startsAt: startsAt.toISOString(), durationMin: Number(form.durationMin), note: form.note, guests: form.guests };
    try {
      const m = existing ? await api.patch('/messages/meetings/' + existing.id, body) : await api.post('/messages/conversations/' + conversationId + '/meetings', body);
      onSaved(m);
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <form className="dialog meet-form" onClick={(e) => e.stopPropagation()} onSubmit={save} role="dialog" aria-modal="true" aria-labelledby="meet-title">
        <h2 id="meet-title">{existing ? tr('Change the meeting') : tr('Book a meeting')}</h2>
        <p className="dialog-body">{tr('Everyone in this chat is invited. They are reminded 15 minutes before, in the OS and by text, and can join from 15 minutes before it starts.')}</p>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="field"><label htmlFor="meet-name">{tr('What is it about?')}</label>
          <input id="meet-name" className="input" value={form.title} onChange={(e) => set('title', e.target.value)} maxLength={120} required placeholder={tr('e.g. Weekly production review')} />
        </div>
        <div className="field"><span className="field-label">{tr('Call type')}</span>
          <div className="meet-kinds" role="radiogroup" aria-label={tr('Call type')}>
            {[['video', tr('Video call')], ['voice', tr('Voice call')]].map(([k, l]) => (
              <button key={k} type="button" role="radio" aria-checked={form.kind === k} className={'meet-kind' + (form.kind === k ? ' is-on' : '')} onClick={() => set('kind', k)}>
                <CallIcon name={k === 'video' ? 'video' : 'phone'} size={18} /> {l}
              </button>
            ))}
          </div>
        </div>
        <div className="meet-row">
          <div className="field"><label htmlFor="meet-date">{tr('Date')}</label><input id="meet-date" className="input" type="date" value={form.date} onChange={(e) => set('date', e.target.value)} required /></div>
          <div className="field"><label htmlFor="meet-time">{tr('Time')}</label><input id="meet-time" className="input" type="time" value={form.time} onChange={(e) => set('time', e.target.value)} required /></div>
          <div className="field"><label htmlFor="meet-len">{tr('How long')}</label>
            <select id="meet-len" className="input" value={form.durationMin} onChange={(e) => set('durationMin', e.target.value)}>
              {DURATIONS.map((d) => <option key={d} value={d}>{d < 60 ? tr('{n} min', { n: d }) : tr('{n} h', { n: d / 60 })}</option>)}
            </select>
          </div>
        </div>
        <div className="field"><label htmlFor="meet-note">{tr('Agenda or note (optional)')}</label>
          <textarea id="meet-note" className="input" rows={3} value={form.note} onChange={(e) => set('note', e.target.value)} maxLength={1000} />
        </div>
        <label className="meet-guest">
          <input type="checkbox" checked={form.guests} onChange={(e) => set('guests', e.target.checked)} />
          <span>
            <strong>{tr('Guests from outside the company')}</strong>
            <small>{tr('Makes a link you can send to clients or suppliers. They join with their name, no account needed, only while the meeting is open.')}</small>
          </span>
        </label>
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !form.title.trim()}>{busy ? tr('Saving…') : existing ? tr('Save changes') : tr('Book it')}</button>
        </div>
      </form>
    </div>
  );
}

// The card a booking leaves in the chat.
export function MeetingCard({ meetingId, locale }) {
  useTick();
  const calls = useCalls();
  const [m, setM] = useState(null);
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(null);
  const load = () => api.get('/messages/meetings/' + meetingId).then(setM).catch(() => setM(false));
  useEffect(() => { load(); }, [meetingId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (m === false) return null;
  if (!m) return <div className="meet-card"><span className="chat-muted">{tr('Loading…')}</span></div>;
  const st = meetingState(m);
  async function copy() {
    try { await navigator.clipboard.writeText(guestUrl(m.guestToken)); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setError(guestUrl(m.guestToken)); }
  }
  async function cancel() {
    if (!window.confirm(tr('Cancel "{title}"? Everyone in the chat will see it was cancelled.', { title: m.title }))) return;
    try { setM(await api.post('/messages/meetings/' + m.id + '/cancel')); } catch (e) { setError(e.message); }
  }
  return (
    <div className={'meet-card' + (st.key === 'cancelled' ? ' is-cancelled' : '') + (st.open ? ' is-open' : '')}>
      <div className="meet-card-top">
        <span className="meet-card-icon"><CallIcon name={m.kind === 'video' ? 'video' : 'phone'} /></span>
        <div>
          <div className="meet-card-title">{m.title}</div>
          <div className="meet-card-when">{whenText(m, locale)}</div>
          {m.createdByName && <div className="meet-card-when">{tr('Booked by {name}', { name: m.createdByName })}</div>}
        </div>
      </div>
      {m.note && <div className="meet-card-note">{m.note}</div>}
      {statusText(st) && <span className={'meet-card-status' + (st.open ? ' is-open' : '')}>{statusText(st)}</span>}
      {error && <span className="chat-muted" role="alert">{error}</span>}
      <div className="meet-card-actions">
        {st.open && <button type="button" className="btn btn-primary" onClick={() => calls.joinMeeting(m.id, m.title)} disabled={!calls.configured}>{tr('Join')}</button>}
        {!st.open && st.key === 'soon' && <span className="chat-muted">{tr('You can join from 15 minutes before.')}</span>}
        {m.guestToken && (st.key === 'soon' || st.open) && <button type="button" className="btn btn-secondary" onClick={copy}><CallIcon name="link" size={15} /> {copied ? tr('Copied') : tr('Copy guest link')}</button>}
        {m.canManage && st.key === 'soon' && <button type="button" className="btn btn-secondary" onClick={() => setEditing(true)}>{tr('Change')}</button>}
        {m.canManage && (st.key === 'soon' || st.key === 'live') && <button type="button" className="btn btn-secondary" onClick={cancel}>{tr('Cancel meeting')}</button>}
      </div>
      {editing && <ScheduleMeetingDialog existing={m} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} />}
    </div>
  );
}

// What's coming up in all my chats, at the top of the chat list.
export function UpcomingMeetings({ locale, onOpenChat, refreshKey }) {
  useTick();
  const calls = useCalls();
  const [list, setList] = useState([]);
  useEffect(() => { api.get('/messages/meetings/upcoming').then(setList).catch(() => setList([])); }, [refreshKey]);
  const soon = list.filter((m) => new Date(m.startsAt).getTime() - Date.now() < 7 * 86400000).slice(0, 3);
  if (!soon.length) return null;
  return (
    <div className="meet-upcoming" aria-label={tr('Upcoming meetings')}>
      <div className="meet-upcoming-head"><CallIcon name="calendar" size={14} /> {tr('Upcoming meetings')}</div>
      {soon.map((m) => {
        const st = meetingState(m);
        return (
          <button type="button" key={m.id} className="meet-upcoming-row" onClick={() => (st.open && calls.configured ? calls.joinMeeting(m.id, m.title) : onOpenChat(m.conversationId))}>
            <CallIcon name={m.kind === 'video' ? 'video' : 'phone'} size={17} />
            <span className="meet-upcoming-text">
              <strong>{m.title}</strong>
              <span>{whenText(m, locale)}{m.chatName ? ' · ' + m.chatName : ''}</span>
            </span>
            {st.open && <span className="meet-upcoming-join">{tr('Join')}</span>}
          </button>
        );
      })}
    </div>
  );
}
