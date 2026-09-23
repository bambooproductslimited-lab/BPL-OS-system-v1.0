import { useEffect, useRef, useState } from 'react';
import { tr, msg, activeIntlLocale } from '../lib/i18n.jsx';
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
  { key: 'today', label: msg('Today'), range: function () { var t = new Date(); return { from: toISO(t), to: toISO(t) }; } },
  { key: 'last7', label: msg('Last 7 days'), range: function () { return { from: toISO(daysAgo(6)), to: toISO(new Date()) }; } },
  { key: 'last30', label: msg('Last 30 days'), range: function () { return { from: toISO(daysAgo(29)), to: toISO(new Date()) }; } },
  { key: 'last90', label: msg('Last 90 days'), range: function () { return { from: toISO(daysAgo(89)), to: toISO(new Date()) }; } },
  { key: 'thisMonth', label: msg('This month'), range: function () { var t = new Date(); return { from: toISO(startOfMonth(t)), to: toISO(new Date()) }; } },
  {
    key: 'lastMonth', label: msg('Last month'), range: function () {
      var t = new Date(); var lm = new Date(t.getFullYear(), t.getMonth() - 1, 1);
      return { from: toISO(startOfMonth(lm)), to: toISO(endOfMonth(lm)) };
    }
  },
  { key: 'thisYear', label: msg('This year'), range: function () { var t = new Date(); return { from: toISO(startOfYear(t)), to: toISO(new Date()) }; } }
];

// Matches .drp-panel's width in the stylesheet; used to right-align the panel
// against its trigger without letting it run off the left of the window.
const PANEL_WIDTH = 280;

function fmt(iso) {
  if (!iso) return '';
  return new Date(iso + 'T00:00').toLocaleDateString(activeIntlLocale(), { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function DateRangePicker({ value, onChange, showAllTime }) {
  const [open, setOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState(value.from || '');
  const [customTo, setCustomTo] = useState(value.to || '');
  const wrapRef = useRef(null);
  const [rect, setRect] = useState(null);

  useEffect(() => {
    function onDocClick(e) { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  // Measured against the viewport and positioned fixed, the same way
  // CatalogPicker and CustomerPicker already do it.
  //
  // The panel used to be absolutely positioned with right: 0, so it hung off
  // the left of its trigger. That was fine until .shell-content gained
  // overflow-x: auto to stop wide tables dragging the page sideways — an
  // overflow value makes an element a clipping box, and the panel's left half
  // was cut off inside it: "Today" read "oday". Fixed positioning is not
  // clipped by a scrolling ancestor, so it cannot happen again wherever the
  // control is placed.
  useEffect(() => {
    if (!open) return undefined;
    function measure() { if (wrapRef.current) setRect(wrapRef.current.getBoundingClientRect()); }
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open]);

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
    onChange({ from: null, to: null, presetKey: 'all', label: tr('All time') });
    setOpen(false);
  }

  return (
    <div className="drp-wrap" ref={wrapRef}>
      <button type="button" className="drp-trigger" onClick={() => setOpen((o) => !o)}>
        <span className="drp-trigger-label">{value.label ? tr(value.label) : (fmt(value.from) + ' – ' + fmt(value.to))}</span>
        <span className="drp-trigger-caret">▾</span>
      </button>
      {open && (
        <div
          className="drp-panel"
          style={rect ? {
            top: rect.bottom + 4,
            // Right-aligned to the trigger, as before, but never pushed off
            // the left edge of the window by its own width.
            left: Math.max(8, Math.min(rect.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - 8)),
          } : undefined}
        >
          <div className="drp-presets">
            {showAllTime && (
              <button type="button" className="drp-preset-row" onClick={chooseAllTime}>
                <span className="drp-preset-check">{value.presetKey === 'all' ? '✓' : ''}</span>
                {tr('All time')}
              </button>
            )}
            {PRESETS.map((p) => (
              <button type="button" key={p.key} className="drp-preset-row" onClick={() => choosePreset(p)}>
                <span className="drp-preset-check">{value.presetKey === p.key ? '✓' : ''}</span>
                {tr(p.label)}
              </button>
            ))}
          </div>
          <div className="drp-custom">
            <div className="drp-custom-label">{tr('Custom range')}</div>
            <div className="drp-custom-row">
              <input type="date" className="input" value={customFrom} max={customTo || undefined} onChange={(e) => setCustomFrom(e.target.value)} />
              <span className="drp-custom-sep">–</span>
              <input type="date" className="input" value={customTo} min={customFrom || undefined} onChange={(e) => setCustomTo(e.target.value)} />
              <button type="button" className="btn btn-primary drp-apply-btn" onClick={applyCustom}>{tr('Apply')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
