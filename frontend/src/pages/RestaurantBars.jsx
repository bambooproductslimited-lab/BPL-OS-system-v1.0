// A column chart for the Restaurants page and its report: one bar per
// period (day, hour, month) with the figures on hover and for screen
// readers. rows: [{ key, value, label, tip, current, weekend }]; avg, when
// given, is drawn as a dashed line with avgLabel at its end. Styles in
// RestaurantsPage.css (rs-bars).
export default function Bars({ rows, format, label, className = '', avg, avgLabel }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className={'rs-bars ' + className} role="img" aria-label={label + ': ' + rows.map((r) => r.tip).join('; ') + (avgLabel ? '; ' + avgLabel : '')}>
      {rows.map((r) => (
        <div key={r.key} className={'rs-bar-col' + (r.current ? ' is-current' : '') + (r.weekend ? ' is-weekend' : '')} tabIndex={0} aria-label={r.tip}>
          <span className="rs-bar-tip" role="tooltip">{r.tip}</span>
          <span className="rs-bar-track"><span className="rs-bar" style={{ height: (r.value ? Math.max(3, Math.round((r.value / max) * 100)) : 0) + '%' }} /></span>
          <span className="rs-bar-label">{r.label}</span>
        </div>
      ))}
      {avg > 0 && <span className="rs-bars-avg" style={{ '--a': Math.min(1, avg / max) }} aria-hidden="true">{avgLabel && <span>{avgLabel}</span>}</span>}
      <span className="rs-bars-max" aria-hidden="true">{format(max)}</span>
    </div>
  );
}
