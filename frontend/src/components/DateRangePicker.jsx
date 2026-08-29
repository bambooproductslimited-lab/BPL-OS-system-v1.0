import { useEffect, useRef, useState } from 'react';
import './DateRangePicker.css';

// A Metricool-style date-range control: preset rows (nobody fights a
// calendar grid for "last 30 days"), a bold check marking the selection,
// and a custom range tucked behind a hairline in the footer — per the
// dataviz skill's interaction spec for filter controls.

function toISO(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { var d = new Date(); d.setDate(d.getDate() - n); return d; }
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
function startOfYear(d) { return new Date(d.getFullYear(), 0, 1); }

export const PRESETS = [
  { key: 'today', label: 'Today', range: function () { var t = new Date(); return { from: toISO(t), to: toISO(t) }; } },
  { key: 'last7', label: 'Last 7 days', range: function () { return { from: toISO(daysAgo(6)), to: toISO(new Date()) }; } },
  { key: 'last30', label: 'Last 30 days', range: function () { return { from: toISO(daysAgo(29)), to: toISO(new Date()) }; } },
  { key: 'last90', label: 'Last 90 days', range: function () { return { from: toISO(daysAgo(89)), to: toISO(new Date()) }; } },
  { key: 'thisMonth', label: 'This month', range: function () { var t = new Date(); return { from: toISO(startOfMonth(t)), to: toISO(new Date()) }; } },
  {
    key: 'lastMonth', label: 'Last month', range: function () {
      var t = new Date(); var lm = new Date(t.getFullYear(), t.getMonth() - 1, 1);
      return { from: toISO(startOfMonth(lm)), to: toISO(endOfMonth(lm)) };
    }
  },
  { key: 'thisYear', label: 'This year', range: function () { var t = new Date(); return { from: toISO(startOfYear(t)), to: toISO(new Date()) }; } }
];

function fmt(iso) {
  if (!iso) return '';
  return new Date(iso + 'T00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function DateRangePicker({ value, onChange, showAllTime }) {
  const [open, setOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState(value.from || '');
  const [customTo, setCustomTo] = useState(value.to || '');
  const wrapRef = useRef(null);

  useEffect(() => {
    function onDocClick(e) { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  useEffect(() => { setCustomFrom(value.from || ''); setCustomTo(value.to || ''); }, [value.from, value.to]);

  function choosePreset(preset) {
    var range = preset.range();
    onChange({ ...range, presetKey: preset.key, label: preset.label });
    setOpen(false);
  }
  function applyCustom() {
    if (!customFrom || !customTo || customTo < customFrom) return;
    onChange({ from: customFrom, to: customTo, presetKey: 'custom', label: fmt(customFrom) + ' – ' + fmt(customTo) });
    setOpen(false);
  }
  function chooseAllTime() {
    onChange({ from: null, to: null, presetKey: 'all', label: 'All time' });
    setOpen(false);
  }

  return (
    <div className="drp-wrap" ref={wrapRef}>
      <button type="button" className="drp-trigger" onClick={() => setOpen((o) => !o)}>
        <span className="drp-trigger-label">{value.label || (fmt(value.from) + ' – ' + fmt(value.to))}</span>
        <span className="drp-trigger-caret">▾</span>
      </button>
      {open && (
        <div className="drp-panel">
          <div className="drp-presets">
            {showAllTime && (
              <button type="button" className="drp-preset-row" onClick={chooseAllTime}>
                <span className="drp-preset-check">{value.presetKey === 'all' ? '✓' : ''}</span>
                All time
              </button>
            )}
            {PRESETS.map((p) => (
              <button type="button" key={p.key} className="drp-preset-row" onClick={() => choosePreset(p)}>
                <span className="drp-preset-check">{value.presetKey === p.key ? '✓' : ''}</span>
                {p.label}
              </button>
            ))}
          </div>
          <div className="drp-custom">
            <div className="drp-custom-label">Custom range</div>
            <div className="drp-custom-row">
              <input type="date" className="input" value={customFrom} max={customTo || undefined} onChange={(e) => setCustomFrom(e.target.value)} />
              <span className="drp-custom-sep">–</span>
              <input type="date" className="input" value={customTo} min={customFrom || undefined} onChange={(e) => setCustomTo(e.target.value)} />
              <button type="button" className="btn btn-primary drp-apply-btn" onClick={applyCustom}>Apply</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
