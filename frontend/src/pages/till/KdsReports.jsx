import { useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import { buildKitchenReportBytes, systemPrinter } from '../../lib/thermalPrinter';
import TicketTimes from './TicketTimes';
import '../TillSettings.css';
import './fifth.css';
import './kdsReports.css';

// The kitchen screen's reports (KdsPage → Reports; backend
// restaurantTicketTimes kdsReport): for this screen's station, another, or
// the whole kitchen — what is on the screens right now, the ticket times
// (the back office's own charts, till/TicketTimes.jsx), what the kitchen
// made, what was taken off orders after it was sent, and what was taken
// with no internet (made, not timed). Printed on the kitchen's printer as
// a slip, or through the print dialog.

function num(n) { return Number(n).toLocaleString(activeIntlLocale(), { maximumFractionDigits: 2 }); }
function mins(n) { return n == null ? '—' : tr('{n} min', { n: Number(n).toLocaleString(activeIntlLocale(), { maximumFractionDigits: 1 }) }); }

function RightNow({ d }) {
  const t = d.targets, n = d.now;
  const old = n.oldestMinutes;
  const tone = old == null ? '' : old > t.lateAfter ? ' is-late' : old > t.warnAfter ? ' is-slow' : ' is-ok';
  return (
    <div className="kdr-now" aria-label={tr('On the screens now')}>
      <span className="kdr-now-h"><i aria-hidden="true" />{tr('On the screens now')}</span>
      <div className="kdr-now-tile"><b>{n.cooking}</b><small>{tr('Cooking')}</small></div>
      <div className={'kdr-now-tile' + tone}><b>{mins(old)}</b><small>{tr('The oldest has waited')}{tone === ' is-late' ? ' ⏰' : tone === ' is-slow' ? ' ⚠' : ''}</small></div>
      <div className="kdr-now-tile"><b>{n.ready}</b><small>{tr('Ready to serve')}</small></div>
      <div className="kdr-now-tile"><b>{n.held}</b><small>{tr('Coming up')}</small></div>
    </div>
  );
}

function Extras({ d, tipOn }) {
  const top = Math.max(1, ...d.made.map((x) => x.qty));
  return (
    <div className="in-grid kdr-extras">
      <article className="in-card kdr-made">
        <h3>{tr('What the kitchen made')}<small>{tr('{n} dishes, {k} kinds', { n: num(d.madeTotal), k: d.madeKinds })}</small></h3>
        {!d.made.length ? <p className="dk-muted">{tr('Nothing bumped done in these days.')}</p> : (
          <ul className="in-bars is-plain">
            {d.made.map((x) => (
              <li key={x.name + x.category}>
                <span className="in-bar-name">{x.name}{x.category && <small>{x.category}</small>}</span>
                <span className="in-bar-track" {...tipOn(x.name + ' · ' + tr('{n} made', { n: num(x.qty) }) + ' · ' + tr('{n} tickets', { n: x.tickets }))}>
                  <span className="in-bar kdr-bar" style={{ width: Math.max(2, x.qty / top * 100) + '%' }} />
                </span>
                <span className="in-bar-val"><b>{num(x.qty)}</b></span>
              </li>
            ))}
          </ul>
        )}
      </article>
      <article className="in-card kdr-off">
        <h3>{tr('Taken off the orders')}<small>{tr('After they reached the kitchen')}</small></h3>
        {!d.takenOff.length ? <p className="kdr-good">✓ {tr('Nothing was taken off after it reached the kitchen.')}</p> : (
          <>
            <p className="kdr-off-total"><b>{num(d.takenOffTotal)}</b> {tr('dishes taken off')}</p>
            <ol className="tt-list">
              {d.takenOff.map((x) => <li key={x.name}><span className="tt-rank is-ico" aria-hidden="true">✕</span><span className="tt-main"><strong>{x.name}</strong></span><span className="tt-pill">{num(x.qty)}</span></li>)}
            </ol>
          </>
        )}
        {d.offline.tickets > 0 && (
          <p className="kdr-offline">📶 {tr('{n} tickets ({d} dishes) were taken with no internet: made, and counted above, but not timed.', { n: d.offline.tickets, d: num(d.offline.dishes) })}</p>
        )}
      </article>
    </div>
  );
}

export default function KdsReports({ token, companyName, printer, onClose, onSignedOut }) {
  const [station, setStation] = useState('');
  const [data, setData] = useState(null);
  const [said, setSaid] = useState(null);
  const [err, setErr] = useState(null);
  function fail(e) {
    if (e && e.status === 401) { onSignedOut(); return; }
    setErr(e && e.status ? e.message : tr('Cannot reach the server: the reports need the internet.'));
  }
  const stations = data ? data.stations : [];
  const current = data ? data.station : station;
  const stationName = current === 'all' ? tr('All stations') : (stations.find((s) => s.id === current) || {}).name || '';
  const fetcher = (r) => { setErr(null); return posFetch('GET', '/pos/kds/reports?from=' + r.from + '&to=' + r.to + (station ? '&station=' + encodeURIComponent(station) : ''), token); };

  async function print() {
    if (!data) return;
    const p = printer || systemPrinter(80);
    try {
      await p.write(buildKitchenReportBytes(data, companyName, { station: current === 'all' ? 'All stations' : stationName, lineWidth: p.lineWidth }));
      setSaid(tr('Report printed.'));
    } catch (e) { setSaid(tr('Could not print: {message}', { message: e.message })); }
    setTimeout(() => setSaid(null), 3500);
  }

  return (
    <div className="kdr" role="dialog" aria-modal="true" aria-labelledby="kdr-title">
      <header className="kdr-head">
        <span className="kdr-ico" aria-hidden="true">📊</span>
        <span className="kdr-title">
          <strong id="kdr-title">{tr('Kitchen reports')}</strong>
          <small>{stationName}{data ? ' · ' + tr('slow after {warn} min, late after {late} min', { warn: data.targets.warnAfter, late: data.targets.lateAfter }) : ''}</small>
        </span>
        <span className="kdr-actions">
          {said && <span className="kdr-said" role="status">{said}</span>}
          <button type="button" className="kds-tool is-text" disabled={!data} onClick={print}>🖨 {tr('Print')}</button>
          <button type="button" className="kds-tool is-text kdr-close" onClick={onClose}>✕ {tr('Close')}</button>
        </span>
      </header>
      <div className="kdr-body">
        {stations.length > 1 && (
          <div className="ts-chips kdr-stations" role="radiogroup" aria-label={tr('Station')}>
            {[{ id: 'all', name: tr('All stations') }].concat(stations).map((s) => (
              <button key={s.id} type="button" role="radio" aria-checked={current === s.id} className={current === s.id ? 'is-on' : ''} onClick={() => setStation(s.id)}>
                {s.id === 'all' ? '🍽️ ' : ''}{s.name}{data && data.screenStation === s.id && s.id !== 'all' ? ' · ' + tr('this screen') : ''}
              </button>
            ))}
          </div>
        )}
        {err && <p className="kdr-err" role="alert">{err}</p>}
        <TicketTimes token={token} onFail={fail} fetcher={fetcher} reloadKey={station} initialRange="today" onData={setData}
          before={(d) => <RightNow d={d} />} after={(d, tipOn) => <Extras d={d} tipOn={tipOn} />} />
      </div>
    </div>
  );
}
