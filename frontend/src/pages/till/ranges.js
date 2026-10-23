import { createElement, useState } from 'react';
import { msg } from '../../lib/i18n.jsx';

// The days a back-office report looks at (Insights, Tips, Food cost,
// Feedback), and a hover card for a chart's marks.

export function iso(d) { return d.toISOString().slice(0, 10); }
export function addDays(s, n) { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
export const RANGES = [['today', msg('Today')], ['yesterday', msg('Yesterday')], ['7', msg('Last 7 days')], ['30', msg('Last 30 days')], ['month', msg('This month')], ['lastMonth', msg('Last month')]];
export function rangeOf(k) {
  const t = iso(new Date());
  if (k === 'today') return { from: t, to: t };
  if (k === 'yesterday') return { from: addDays(t, -1), to: addDays(t, -1) };
  if (k === '30') return { from: addDays(t, -29), to: t };
  if (k === 'month') return { from: t.slice(0, 8) + '01', to: t };
  if (k === 'lastMonth') { const end = addDays(t.slice(0, 8) + '01', -1); return { from: end.slice(0, 8) + '01', to: end }; }
  return { from: addDays(t, -6), to: t };
}

// A hover card for a mark: what it is, exactly (also on keyboard focus).
export function useTip() {
  const [tip, setTip] = useState(null);
  const on = (text) => ({
    onPointerEnter: (e) => setTip({ text, x: e.clientX, y: e.clientY }),
    onPointerMove: (e) => setTip({ text, x: e.clientX, y: e.clientY }),
    onPointerLeave: () => setTip(null),
    onFocus: (e) => { const r = e.currentTarget.getBoundingClientRect(); setTip({ text, x: r.left + r.width / 2, y: r.top }); },
    onBlur: () => setTip(null),
    tabIndex: 0, 'aria-label': text
  });
  const node = tip ? createElement('div', { className: 'in-tip', role: 'tooltip', style: { left: tip.x, top: tip.y } }, tip.text) : null;
  return [on, node];
}
