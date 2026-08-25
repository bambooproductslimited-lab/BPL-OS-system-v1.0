import { useMemo, useRef, useState } from 'react';
import './SocialCharts.css';

// Metricool-style graphical metrics for the Social Tracker's Overview tab:
// per-metric sections (Followers / Impressions / Interactions / Posts),
// each a row of solid-colored per-channel stat cards (current value +
// trend arrow vs the prior equal-length period) with a multi-line trend
// chart underneath. No charting library — plain inline SVG, following
// this app's existing zero-dependency pattern (jsPDF/html2canvas aside).

// Fixed categorical color per channel — assigned once, never reassigned by
// rank/filter, so a channel keeps its color whether it's a chart line, a
// legend swatch, or a stat card background.
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

// Relative luminance -> pick white or ink text so a value stays legible
// set inside a solid-colored card, per the dataviz skill's one exception
// to "text never wears the data color."
function textColorFor(hex) {
  var r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  var lin = [r, g, b].map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  var L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return L > 0.5 ? '#0b0b0b' : '#ffffff';
}

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
export function compactNum(n) {
  n = Number(n || 0);
  var sign = n < 0 ? '-' : '';
  n = Math.abs(n);
  if (n >= 1000000) return sign + (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return sign + (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return sign + String(n);
}
// Always includes the year — history can span a year boundary, and
// "26 Jul … 10 Jul" with no year reads as backwards even when the
// underlying dates are correctly sorted (one is just the following year).
function fmtShortDate(t) {
  return new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

var PAD = { left: 44, right: 16, top: 16, bottom: 28 };
var VBW = 800, VBH = 260;

// LineChart — series: [{ key, name, color, points: [{ capturedOn, value }] }]
function LineChart({ series }) {
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
      if (p.value > maxVal) maxVal = p.value;
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

  // Step-carry-forward for cumulative metrics (followers) — a count holds
  // steady between snapshots. Post-based metrics (impressions/interactions/
  // posts) are daily totals, not cumulative, so an exact-day match is used
  // instead (no carry-forward — there's nothing to carry).
  function valueAt(s, t) {
    var exact = s.points.find((p) => new Date(p.capturedOn.length > 10 ? p.capturedOn : p.capturedOn + 'T00:00').getTime() === t);
    return exact ? exact.value : null;
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

  if (!active.length) {
    return <p className="soc-chart-empty">No data for this period yet.</p>;
  }

  return (
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
            var sorted = [...s.points].sort((a, b) => a.capturedOn.localeCompare(b.capturedOn));
            var d = sorted.map((p, i) => {
              var t = new Date(p.capturedOn.length > 10 ? p.capturedOn : p.capturedOn + 'T00:00').getTime();
              return (i === 0 ? 'M' : 'L') + xOf(t) + ',' + yOf(p.value);
            }).join(' ');
            var last = sorted[sorted.length - 1];
            var lastT = new Date(last.capturedOn.length > 10 ? last.capturedOn : last.capturedOn + 'T00:00').getTime();
            return (
              <g key={s.key}>
                <path d={d} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                {sorted.length === 1 && <circle cx={xOf(lastT)} cy={yOf(last.value)} r="4" fill={s.color} />}
                <circle cx={xOf(lastT)} cy={yOf(last.value)} r="5" fill={s.color} stroke="var(--soc-chart-surface)" strokeWidth="2" />
              </g>
            );
          })}
          {minT === maxT ? (
            <text x={(PAD.left + VBW - PAD.right) / 2} y={VBH - 8} className="soc-chart-axis-label" textAnchor="middle">{fmtShortDate(minT)}</text>
          ) : (
            <>
              <text x={PAD.left} y={VBH - 8} className="soc-chart-axis-label">{fmtShortDate(minT)}</text>
              <text x={VBW - PAD.right} y={VBH - 8} className="soc-chart-axis-label" textAnchor="end">{fmtShortDate(maxT)}</text>
            </>
          )}
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
  );
}

// MetricSection — one Metricool-style block: a row of solid per-channel
// stat cards (value + trend arrow) and a trend chart underneath.
// metric: { byChannel: [{channelKey,name,value,delta}], series: [{channelKey,name,points}] }
export function MetricSection({ title, metric }) {
  var byChannel = metric.byChannel || [];
  var series = (metric.series || []).map((s) => ({ key: s.channelKey, name: s.name, color: channelColor(s.channelKey), points: s.points }));

  return (
    <div className="soc-chart-card">
      <div className="soc-chart-title">{title}</div>
      {!byChannel.length ? (
        <p className="soc-chart-empty">No data for this period yet.</p>
      ) : (
        <>
          <div className="soc-stat-row">
            {byChannel.map((c) => {
              var bg = channelColor(c.channelKey);
              var ink = textColorFor(bg);
              var arrow = c.delta === null ? '' : c.delta > 0 ? ' ↑' : c.delta < 0 ? ' ↓' : '';
              return (
                <div key={c.channelKey} className="soc-stat-card" style={{ background: bg, color: ink }}>
                  <div className="soc-stat-card-value">{compactNum(c.value)}{arrow}</div>
                  <div className="soc-stat-card-name">{c.name}</div>
                </div>
              );
            })}
          </div>
          <LineChart series={series} />
        </>
      )}
    </div>
  );
}
