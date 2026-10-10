import { useEffect, useState } from 'react';
import './crmFun.css';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';

// The lively bits the Inbox and the follow-ups share (CrmInboxPage.jsx,
// CrmFollowUpsPage.jsx): how long someone has waited, said and coloured by
// how urgent it is; a progress ring; and confetti for a cleared inbox or a
// finished round. Styles in crmFun.css (.fun-*).

export function minutesSince(iso) { return iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000)) : 0; }

// "12 min", "3 h 5 min", "2 d 4 h".
export function spanText(mins) {
  if (mins === null || mins === undefined) return '—';
  const m = Math.round(mins);
  if (m < 1) return tr('under a minute');
  if (m < 60) return tr('{n} min', { n: m });
  if (m < 1440) { const h = Math.floor(m / 60), r = m % 60; return r ? tr('{h} h {m} min', { h, m: r }) : tr('{n} h', { n: h }); }
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return h ? tr('{d} d {h} h', { d, h }) : tr('{n} d', { n: d });
}

// Under an hour is fresh, under four is getting warm, more is hot.
export function waitTone(mins) { return mins < 60 ? 'fresh' : mins < 240 ? 'warm' : 'hot'; }
const TONE_WORD = { fresh: () => tr('under an hour'), warm: () => tr('over an hour'), hot: () => tr('over 4 hours') };

export function WaitPill({ since, label }) {
  const mins = minutesSince(since);
  const tone = waitTone(mins);
  return (
    <span className={'fun-wait is-' + tone} title={tr('Waiting {time} ({how})', { time: spanText(mins), how: TONE_WORD[tone]() })}>
      <span className="fun-wait-dot" aria-hidden="true" />
      {label ? label + ' ' : ''}{spanText(mins)}
    </span>
  );
}

// A ring filled to value / max, with whatever goes in its middle.
export function Ring({ value, max, size = 120, stroke = 12, tone = '', children }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const part = max ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <span className={'fun-ring' + (tone ? ' is-' + tone : '')} style={{ width: size, height: size }}>
      <svg viewBox={'0 0 ' + size + ' ' + size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} className="fun-ring-track" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} className="fun-ring-fill" strokeWidth={stroke} strokeDasharray={(c * part) + ' ' + c} transform={'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')'} />
      </svg>
      <span className="fun-ring-in">{children}</span>
    </span>
  );
}

// Paper pieces falling — none when the device asks for less motion.
export function Confetti({ burst }) {
  const [pieces, setPieces] = useState([]);
  useEffect(() => {
    if (!burst) return undefined;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const colors = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'];
    setPieces(Array.from({ length: 90 }, (_, i) => ({
      id: burst + '-' + i, left: Math.random() * 100, delay: Math.random() * 0.35, dur: 1.8 + Math.random() * 1.4,
      color: colors[i % colors.length], rot: Math.round(Math.random() * 720 - 360), drift: Math.round((Math.random() - 0.5) * 220), w: 6 + Math.random() * 7
    })));
    const t = setTimeout(() => setPieces([]), 3600);
    return () => clearTimeout(t);
  }, [burst]);
  if (!pieces.length) return null;
  return (
    <div className="fun-confetti" aria-hidden="true">
      {pieces.map((p) => <i key={p.id} style={{ left: p.left + '%', background: p.color, width: p.w, height: p.w * 0.45, animationDelay: p.delay + 's', animationDuration: p.dur + 's', '--rot': p.rot + 'deg', '--drift': p.drift + 'px' }} />)}
    </div>
  );
}

export function greeting(name) {
  const h = new Date().getHours();
  if (!name) return h < 12 ? tr('Good morning') : h < 17 ? tr('Good afternoon') : tr('Good evening');
  return h < 12 ? tr('Good morning, {name}', { name }) : h < 17 ? tr('Good afternoon, {name}', { name }) : tr('Good evening, {name}', { name });
}

// Monday first, in the reader's language ("Mon", "lun.", "周一").
export function weekdayShort(i) {
  return new Date(Date.UTC(2024, 0, 1 + i)).toLocaleDateString(activeIntlLocale(), { weekday: 'short', timeZone: 'UTC' });
}
