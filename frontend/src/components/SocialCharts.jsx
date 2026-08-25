import { useMemo, useRef, useState } from 'react';
import './SocialCharts.css';

// Metricool-style graphical metrics for the Social Tracker's Overview tab:
// a multi-line "Community growth" chart across the social platforms that
// share a real "followers" concept, a single-series stat/sparkline for
// Website (deliberately kept off the growth chart's shared axis — active
// users and follower counts are different metrics at different
// magnitudes; mixing them on one linear axis is the classic
// "Users vs Sessions" dual-scale anti-pattern), and a horizontal bar list
// for engagement totals. No charting library — plain inline SVG, following
// this app's existing zero-dependency pattern (jsPDF/html2canvas aside).

// Fixed categorical color per channel — assigned once, never reassigned by
// rank/filter, so a channel keeps its color even if others drop out of a
// given chart for lacking data.
export const CHANNEL_COLORS = {
  facebook: '#2a78d6',
  instagram: '#eb6834',
  tiktok: '#1baf7a',
  youtube: '#eda100',
  twitch: '#e87ba4',
  linkedin: '#008300',
  website: '#4a3aa7'
};
const MUTED_COLOR = '#898781';
export function channelColor(key) { return CHANNEL_COLORS[key] || MUTED_COLOR; }

function niceMax(v) {
  if (v <= 0) return 10;
  var magnitude = Math.pow(10, Math.floor(Math.log10(v)));
  var normalized = v / magnitude;
  var step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}
function niceTicks(max, count) {
  var ticks = [];
  for (var i = 0; i <= count; i++) ticks.push(Math.round((max * i) / count));
  return ticks;
}
function compactNum(n) {
  n = Number(n || 0);
  if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}
// Always includes the year — history can span a year boundary, and
// "26 Jul … 10 Jul" with no year reads as backwards even when the
// underlying dates are correctly sorted (one is just the following year).
function fmtShortDate(t) {
  return new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

var PAD = { left: 44, right: 16, top: 16, bottom: 28 };
var VBW = 800, VBH = 300;

// GrowthChart — series: [{ key, name, color, points: [{ capturedOn, followers }] }]
export function GrowthChart({ series }) {
  const containerRef = useRef(null);
  const [hoverT, setHoverT] = useState(null);
  const [hoverPos, setHoverPos] = useState(null);

  const active = series.filter((s) => s.points && s.points.length > 0);

  const { minT, maxT, maxV, allTimes } = useMemo(() => {
    var times = [];
    var maxVal = 0;
    active.forEach((s) => s.points.forEach((p) => {
      var t = new Date(p.capturedOn.length > 10 ? p.capturedOn : p.capturedOn + 'T00:00').getTime();
      times.push(t);
      if (p.followers > maxVal) maxVal = p.followers;
    }));
    times.sort((a, b) => a - b);
    return {
      minT: times.length ? times[0] : 0,
      maxT: times.length ? times[times.length - 1] : 1,
      maxV: niceMax(maxVal),
      allTimes: Array.from(new Set(times)).sort((a, b) => a - b)
    };
  }, [active]);

  const plotW = VBW - PAD.left - PAD.right;
  const plotH = VBH - PAD.top - PAD.bottom;
  const span = Math.max(1, maxT - minT);
  const xOf = (t) => PAD.left + ((t - minT) / span) * plotW;
  const yOf = (v) => PAD.top + plotH - (maxV ? (v / maxV) * plotH : 0);

  // Step-carry-forward: a follower count holds steady between snapshots,
  // so the tooltip at any hovered date shows each series' most recent
  // known value at-or-before that date, not a misleading interpolation.
  function valueAt(s, t) {
    var pts = s.points;
    var result = null;
    for (var i = 0; i < pts.length; i++) {
      var pt = pts[i];
      var pTime = new Date(pt.capturedOn.length > 10 ? pt.capturedOn : pt.capturedOn + 'T00:00').getTime();
      if (pTime <= t) result = pt.followers; else break;
    }
    return result;
  }

  function handleMove(e) {
    if (!allTimes.length) return;
    var rect = containerRef.current.getBoundingClientRect();
    var xRatio = (e.clientX - rect.left) / rect.width;
    var svgX = xRatio * VBW;
    var t = minT + ((svgX - PAD.left) / plotW) * span;
    var nearest = allTimes.reduce((best, cur) => (Math.abs(cur - t) < Math.abs(best - t) ? cur : best), allTimes[0]);
    setHoverT(nearest);
    setHoverPos({ x: xRatio * rect.width, y: e.clientY - rect.top });
  }
  function handleLeave() { setHoverT(null); setHoverPos(null); }

  const yTicks = niceTicks(maxV, 4);
  const tooltipRows = hoverT !== null
    ? active.map((s) => ({ key: s.key, name: s.name, color: s.color, value: valueAt(s, hoverT) })).filter((r) => r.value !== null)
    : [];

  return (
    <div className="soc-chart-card">
      <div className="soc-chart-title">Community growth</div>
      {!active.length ? (
        <p className="soc-chart-empty">No follower history yet — sync a connected channel, or log a follower count from the Channels tab, to see growth over time.</p>
      ) : (
        <>
          <div className="soc-chart-svg-wrap" ref={containerRef} onPointerMove={handleMove} onPointerLeave={handleLeave}>
            <svg viewBox={'0 0 ' + VBW + ' ' + VBH} className="soc-chart-svg" preserveAspectRatio="none">
              {yTicks.map((tv, i) => (
                <g key={i}>
                  <line x1={PAD.left} x2={VBW - PAD.right} y1={yOf(tv)} y2={yOf(tv)} className="soc-chart-gridline" />
                  <text x={PAD.left - 8} y={yOf(tv)} className="soc-chart-axis-label" textAnchor="end" dominantBaseline="middle">{compactNum(tv)}</text>
                </g>
              ))}
              {hoverT !== null && (
                <line x1={xOf(hoverT)} x2={xOf(hoverT)} y1={PAD.top} y2={VBH - PAD.bottom} className="soc-chart-crosshair" />
              )}
              {active.map((s) => {
                var d = s.points.map((p, i) => {
                  var t = new Date(p.capturedOn.length > 10 ? p.capturedOn : p.capturedOn + 'T00:00').getTime();
                  return (i === 0 ? 'M' : 'L') + xOf(t) + ',' + yOf(p.followers);
                }).join(' ');
                var last = s.points[s.points.length - 1];
                var lastT = new Date(last.capturedOn.length > 10 ? last.capturedOn : last.capturedOn + 'T00:00').getTime();
                return (
                  <g key={s.key}>
                    <path d={d} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                    <circle cx={xOf(lastT)} cy={yOf(last.followers)} r="5" fill={s.color} stroke="var(--soc-chart-surface)" strokeWidth="2" />
                  </g>
                );
              })}
              <text x={PAD.left} y={VBH - 8} className="soc-chart-axis-label">{fmtShortDate(minT)}</text>
              <text x={VBW - PAD.right} y={VBH - 8} className="soc-chart-axis-label" textAnchor="end">{fmtShortDate(maxT)}</text>
            </svg>
            {hoverT !== null && hoverPos && tooltipRows.length > 0 && (
              <div className="soc-chart-tooltip" style={{ left: Math.min(hoverPos.x + 12, (containerRef.current?.clientWidth || 0) - 170) }}>
                <div className="soc-chart-tooltip-date">{fmtShortDate(hoverT)}</div>
                {tooltipRows.map((r) => (
                  <div key={r.key} className="soc-chart-tooltip-row">
                    <span className="soc-chart-tooltip-key" style={{ background: r.color }} />
                    <span className="soc-chart-tooltip-name">{r.name}</span>
                    <span className="soc-chart-tooltip-value">{compactNum(r.value)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="soc-chart-legend">
            {active.map((s) => (
              <div key={s.key} className="soc-chart-legend-item">
                <span className="soc-chart-legend-key" style={{ background: s.color }} />
                {s.name}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// StatSparkline — a stat-tile with an optional trend sparkline once there
// are >= 2 points; a single point (or zero) degrades gracefully to a plain
// hero number, since a one-point "trend" isn't a trend.
export function StatSparkline({ label, points, formatValue }) {
  const has = points && points.length > 0;
  const latest = has ? points[points.length - 1].followers : null;
  const w = 160, h = 40;
  const path = useMemo(() => {
    if (!points || points.length < 2) return null;
    var vals = points.map((p) => p.followers);
    var min = Math.min(...vals), max = Math.max(...vals);
    var range = max - min || 1;
    return points.map((p, i) => {
      var x = (i / (points.length - 1)) * w;
      var y = h - ((p.followers - min) / range) * h;
      return (i === 0 ? 'M' : 'L') + x + ',' + y;
    }).join(' ');
  }, [points]);

  return (
    <div className="soc-stat-tile">
      <div className="soc-stat-label">{label}</div>
      {has ? (
        <>
          <div className="soc-stat-value">{formatValue ? formatValue(latest) : compactNum(latest)}</div>
          {path ? (
            <svg viewBox={'0 0 ' + w + ' ' + h} className="soc-stat-sparkline" preserveAspectRatio="none">
              <path d={path} fill="none" stroke={CHANNEL_COLORS.website} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            </svg>
          ) : (
            <div className="soc-stat-note">Trend appears after the next sync.</div>
          )}
        </>
      ) : (
        <div className="soc-stat-note">No data yet — click Sync now on the Channels tab.</div>
      )}
    </div>
  );
}

// EngagementBars — a horizontal bar list comparing one metric across
// channels. items: [{ key, name, value }]; zero-value channels are
// dropped by the caller before this renders (no signal, no bar).
export function EngagementBars({ items, metricLabel }) {
  const [hoverKey, setHoverKey] = useState(null);
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="soc-chart-card">
      <div className="soc-chart-title">Engagement by channel — {metricLabel}</div>
      {!items.length ? (
        <p className="soc-chart-empty">No published posts with metrics logged yet.</p>
      ) : (
        <div className="soc-bars">
          {items.map((it) => {
            var color = channelColor(it.key);
            var widthPct = (it.value / max) * 100;
            return (
              <div key={it.key} className="soc-bar-row" onPointerEnter={() => setHoverKey(it.key)} onPointerLeave={() => setHoverKey(null)}>
                <div className="soc-bar-label">{it.name}</div>
                <div className="soc-bar-track">
                  <div
                    className="soc-bar-fill"
                    style={{ width: widthPct + '%', background: color, opacity: hoverKey && hoverKey !== it.key ? 0.6 : 1 }}
                  />
                </div>
                <div className="soc-bar-value">{compactNum(it.value)}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
