import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Icon, Status, fmtDate } from '../../components/DashKit';
import { money } from '../../lib/currency';
import { msg, tr } from '../../lib/i18n.jsx';

// What the CRM's customer pages share (crmcustomers, crminbox,
// crmfollowups, crmhealth, crmmarketing): the channels a customer writes
// on, how long ago something was, the customer kinds, the reasons someone
// needs a follow-up — all worded here, in the reader's language, from the
// numbers the backend sends (backend/src/services/crm*.service.js).

export const CHANNELS = [
  { key: 'whatsapp', label: msg('WhatsApp') },
  { key: 'email', label: msg('Email') },
  { key: 'instagram', label: msg('Instagram') },
  { key: 'facebook', label: msg('Facebook') },
  { key: 'sms', label: msg('SMS') },
  { key: 'call', label: msg('Call') },
  { key: 'visit', label: msg('Visit') },
  { key: 'other', label: msg('Other') }
];
export function channelLabel(key) { const c = CHANNELS.find((x) => x.key === key); return c ? tr(c.label) : key || '—'; }

const GLYPHS = {
  whatsapp: <><path d="M4 20l1.2-4.1A8 8 0 1 1 8.3 19z" /><path d="M9 8.6c0 3.3 3 6.4 6.4 6.4l1-1.6-2-1-1 .9a4.4 4.4 0 0 1-2.7-2.7l.9-1-1-2z" /></>,
  email: <><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="m4 7 8 6 8-6" /></>,
  instagram: <><rect x="4" y="4" width="16" height="16" rx="4.5" /><circle cx="12" cy="12" r="3.6" /><circle cx="16.8" cy="7.2" r=".6" fill="currentColor" /></>,
  facebook: <path d="M14 8.5h2.2V5.2H14c-2.2 0-3.6 1.5-3.6 3.7v1.9H8.3v3.2h2.1V20h3.3v-6h2.3l.4-3.2h-2.7V9.3c0-.5.3-.8.8-.8z" />,
  sms: <><path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V16.5H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5z" /><path d="M8 11h.01M12 11h.01M16 11h.01" /></>,
  call: <path d="M6.5 4h3l1.5 4-2 1.2a10 10 0 0 0 5.8 5.8L16 13l4 1.5v3a2 2 0 0 1-2.2 2A15.5 15.5 0 0 1 4.5 6.2 2 2 0 0 1 6.5 4z" />,
  visit: <><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.4" /></>,
  other: <><circle cx="12" cy="12" r="8" /><path d="M8.5 12h.01M12 12h.01M15.5 12h.01" /></>
};
export function ChannelGlyph({ channel }) {
  return <svg className="dk-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{GLYPHS[channel] || GLYPHS.other}</svg>;
}
// A small round mark in the channel's colour, with its name for screen readers.
export function ChannelDot({ channel, withLabel }) {
  return (
    <span className={'hub-ch is-' + (channel || 'other')} title={channelLabel(channel)}>
      <span className="hub-ch-dot"><ChannelGlyph channel={channel} /></span>
      {withLabel ? <span className="hub-ch-name">{channelLabel(channel)}</span> : <span className="sr-only">{channelLabel(channel)}</span>}
    </span>
  );
}

// "just now", "5 min ago", "3 h ago", "2 days ago", or the date.
export function ago(iso) {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return tr('just now');
  if (s < 3600) return tr('{n} min ago', { n: Math.floor(s / 60) });
  if (s < 86400) return tr('{n} h ago', { n: Math.floor(s / 3600) });
  const d = Math.floor(s / 86400);
  if (d === 1) return tr('yesterday');
  if (d < 30) return tr('{n} days ago', { n: d });
  return fmtDate(iso);
}
export function timeOf(iso) {
  return iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
}

export const CATEGORIES = [
  { key: 'lead', label: msg('Lead'), tone: 'info', help: msg('Has asked about something, hasn\'t bought yet.') },
  { key: 'prospect', label: msg('Prospect'), tone: 'warn', help: msg('A real chance: talking prices, quoted or close to ordering.') },
  { key: 'active', label: msg('Customer'), tone: 'good', help: msg('Has paid us. The first payment on a sale makes them a customer by itself.') },
  { key: 'vip', label: msg('VIP'), tone: 'good', help: msg('Buys often or buys big. Looked after first.') }
];
export function CategoryTag({ value }) {
  const c = CATEGORIES.find((x) => x.key === value) || CATEGORIES[0];
  return <Status tone={c.tone}>{tr(c.label)}</Status>;
}

export const ghsOr = (n, cur) => money(n || 0, cur || 'GHS');

// ── why someone needs a follow-up ────────────────────────────────────
export const REASONS = {
  waiting: { label: msg('Waiting for a reply'), icon: 'send', tone: 'bad' },
  planned: { label: msg('Follow-up planned'), icon: 'calendar', tone: 'warn' },
  overdue: { label: msg('Payment overdue'), icon: 'owed', tone: 'bad' },
  quote: { label: msg('Quotation not answered'), icon: 'doc', tone: 'warn' },
  lead: { label: msg('Lead follow-up due'), icon: 'people', tone: 'info' },
  quiet: { label: msg('Gone quiet'), icon: 'clock', tone: 'info' }
};
export const REASON_ORDER = ['waiting', 'planned', 'overdue', 'quote', 'lead', 'quiet'];

function hoursText(h) { return h < 48 ? tr('{n} h', { n: h }) : tr('{n} days', { n: Math.floor(h / 24) }); }
export function reasonText(r) {
  switch (r.type) {
    case 'waiting': return tr('Wrote on {channel} {time} ago and is waiting for a reply: “{text}”', { channel: channelLabel(r.channel), time: hoursText(r.hours || 0), text: r.preview || '' });
    case 'planned': {
      const base = r.late ? tr('Follow-up was planned for {date} ({n} days ago)', { date: fmtDate(r.on), n: r.late }) : tr('Follow-up planned for today');
      return r.note ? base + ': ' + r.note : base;
    }
    case 'overdue': return tr('Invoice {ref}: {amount} overdue by {n} days', { ref: r.ref, amount: ghsOr(r.amount, r.currency), n: r.days });
    case 'quote': {
      const base = r.sentDays != null ? tr('Quotation {ref} ({amount}) sent {n} days ago, no answer yet', { ref: r.ref, amount: ghsOr(r.amount, r.currency), n: r.sentDays }) : tr('Quotation {ref} ({amount}), no answer yet', { ref: r.ref, amount: ghsOr(r.amount, r.currency) });
      return r.expires ? base + ' · ' + tr('it expires on {date}', { date: fmtDate(r.expires) }) : base;
    }
    case 'lead': return r.item ? tr('Lead {ref} ({item}): follow-up due {date}', { ref: r.ref, item: r.item, date: fmtDate(r.due) }) : tr('Lead {ref}: follow-up due {date}', { ref: r.ref, date: fmtDate(r.due) });
    case 'quiet': return r.lastBought ? tr('No contact for {n} days — last bought on {date}', { n: r.days, date: fmtDate(r.lastBought) }) : tr('No contact for {n} days', { n: r.days });
    default: return r.text || '';
  }
}
export function nextStepText(item) {
  const r = item.reasons[0];
  if (!r) return '';
  switch (r.type) {
    case 'waiting': return tr('Reply on {channel} — they are waiting.', { channel: channelLabel(r.channel) });
    case 'planned': return r.note || tr('Get in touch as planned, then set the next date or mark it done.');
    case 'overdue': return tr('Remind them about the payment and agree a date.');
    case 'quote': return tr('Ask if the quotation works for them and answer any questions.');
    case 'lead': return tr('Move the lead on: call, then update its stage.');
    default: return tr('Check in: ask how the last order is doing and share what is new.');
  }
}
export function ReasonTag({ type }) {
  const r = REASONS[type] || REASONS.quiet;
  return <span className={'hub-reason is-' + r.tone}><Icon name={r.icon} /> {tr(r.label)}</span>;
}

// ── duplicates: why two profiles look like one customer ──────────────
export function dupReasonText(s) {
  let m;
  if ((m = /^same phone (.+)$/.exec(s))) return tr('Same phone number ({value})', { value: phonePretty(m[1]) });
  if ((m = /^same email (.+)$/.exec(s))) return tr('Same email address ({value})', { value: m[1] });
  if (s === 'same name') return tr('Same name');
  if ((m = /^similar names \((.+?)\)(?:, (.+))?$/.exec(s))) {
    const extra = (m[2] || '').split(', ').filter(Boolean).map((x) => {
      if (x === 'same location') return tr('same location');
      if (x === 'same contact person') return tr('same contact person');
      const d = /^same email domain (.+)$/.exec(x);
      return d ? tr('same email domain {domain}', { domain: d[1] }) : x;
    });
    return tr('Nearly the same name ({names})', { names: m[1] }) + (extra.length ? ' · ' + extra.join(' · ') : '');
  }
  return s;
}
export function phonePretty(digits) {
  const d = String(digits || '');
  return /^233\d{9}$/.test(d) ? '+233 ' + d.slice(3, 5) + ' ' + d.slice(5, 8) + ' ' + d.slice(8) : (/^\d{8,}$/.test(d) ? '+' + d : d);
}

// ── the reps ─────────────────────────────────────────────────────────
export function useReps(enabled = true) {
  const [reps, setReps] = useState([]);
  const load = useCallback(async () => { try { setReps(await api.get('/crm/reps')); } catch { setReps([]); } }, []);
  useEffect(() => { if (enabled) load(); }, [enabled, load]);
  return { reps, reload: load };
}
export function RepSelect({ reps, value, onChange, id, emptyLabel, disabled }) {
  return (
    <select id={id} className="input" value={value || ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-label={tr('Sales rep')}>
      <option value="">{emptyLabel || tr('Nobody yet')}</option>
      {reps.map((r) => <option key={r.id} value={r.id}>{r.name}{r.isRep ? '' : ' · ' + tr('(not a sales rep)')}</option>)}
    </select>
  );
}

// A round initial for a customer.
export function CustMark({ name, size = 38 }) {
  const n = String(name || '?').trim();
  const parts = n.split(/\s+/).filter(Boolean);
  const ini = ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  let h = 0; for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  return <span className="hub-mark" style={{ width: size, height: size, fontSize: Math.round(size * 0.36), '--h': h % 360 }} aria-hidden="true">{ini}</span>;
}

// Download rows as a spreadsheet (CSV).
export function downloadCsv(fileName, rows) {
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const blob = new Blob(['﻿' + rows.map((r) => r.map(esc).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = fileName; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

// Who sent one of our messages: the person in the OS, or the WhatsApp
// Business app on the company phone (coexistence), stored as PHONE_AUTHOR
// in backend/src/services/whatsapp.service.js.
export function ourAuthor(sentByName, author) {
  if (sentByName) return sentByName;
  if (author === 'Bamboo Products (phone)') return tr('Sent from the company phone');
  return author || tr('Us');
}
