import { useCallback, useEffect, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { tr } from '../../lib/i18n.jsx';
import { hubPing } from './outage';

// Till settings → Printers → Outage mode: when the internet is down (a
// power cut can keep it down for days), the tills still send the kitchen's
// tickets through the print hub on the restaurant's own network — printed
// in each kitchen, shown on its screens (till/outage.js, tools/print-hub).
// Each till and kitchen screen trusts the hub once, on the hub's own setup
// page; this says whether the device in hand reaches it.
export default function OutageBox({ token }) {
  const [o, setO] = useState(null);
  const [check, setCheck] = useState(null); // null | 'checking' | { ok, version?, error? }

  const test = useCallback(async (hub) => { setCheck('checking'); setCheck(await hubPing(hub)); }, []);
  useEffect(() => {
    let live = true;
    posFetch('GET', '/pos/kitchen/outage', token).then((r) => { if (!live) return; setO(r); if (r && r.hub) test(r.hub); }).catch(() => {});
    return () => { live = false; };
  }, [token, test]);
  if (!o) return null;
  const hub = o.hub;
  const printers = o.printers || [];
  const kitchens = o.stations || [];
  const ok = check && check !== 'checking' && check.ok;

  return (
    <section className={'tpr-outage' + (ok ? ' is-on' : '')} aria-labelledby="tpr-outage-title">
      <div className="tpr-hubbox-head">
        <span className="tpr-outage-ico" aria-hidden="true">🔌</span>
        <span>
          <strong id="tpr-outage-title">{tr('Outage mode: when the internet is down')}</strong>
          <small>{tr('The tills keep selling with no internet. Through the print hub on the restaurant\'s network, their orders still print in each kitchen and show on the kitchen screens. Each till and kitchen screen is set up for it once.')}</small>
        </span>
      </div>

      {!hub ? (
        <p className="tpr-outage-row is-off">
          <span className="tpr-outage-dot" aria-hidden="true" />
          <span><strong>{tr('Not ready yet')}</strong><small>{tr('The print hub has not said where it answers on the network. It needs version 1.1 or newer (download it above) running on a computer at the restaurant.')}</small></span>
        </p>
      ) : (
        <>
          <p className={'tpr-outage-row' + (check === 'checking' ? '' : ok ? ' is-on' : ' is-off')}>
            <span className="tpr-outage-dot" aria-hidden="true" />
            <span>
              <strong>{check === 'checking' ? tr('Checking this device…') : ok ? tr('This device is ready') : tr('This device is not set up yet')}</strong>
              <small>{check === 'checking' ? (hub.urls || [])[0] : ok
                ? tr('It reaches {hub} on the restaurant\'s network: with no internet, its orders still reach the kitchen.', { hub: hub.name })
                : tr('It cannot reach {hub} on the restaurant\'s network yet. Set it up once, on the restaurant\'s Wi-Fi.', { hub: hub.name })}</small>
            </span>
            <button type="button" className="btn btn-secondary" disabled={check === 'checking'} onClick={() => test(hub)}>{tr('Check again')}</button>
          </p>
          {!ok && check !== 'checking' && (
            <ol className="tpr-outage-steps">
              <li>{tr('On this till or kitchen screen, connected to the restaurant\'s Wi-Fi, open the hub\'s setup page.')}</li>
              <li>{tr('Download the hub\'s certificate and trust it: the page shows how on an iPad or iPhone, Android, Windows and Mac.')}</li>
              <li>{tr('Come back here and press Check again. Do the same on every till and kitchen screen.')}</li>
            </ol>
          )}
          <div className="tpr-dl">
            {hub.setupUrl && <a className="btn btn-primary" href={hub.setupUrl} target="_blank" rel="noreferrer">🛠 {tr('Set up this device')}</a>}
            <span className="tpr-pill">{tr('{n} kitchens', { n: kitchens.length })} · {tr('{n} kitchen printers', { n: printers.length })}</span>
          </div>
        </>
      )}
      <p className="tpr-hint">{tr('Keep the router and the hub\'s computer on the generator or a UPS: with no internet, the tills and kitchen screens talk through them. What was taken reaches Bamboo OS by itself when the internet is back, without printing again.')}</p>
    </section>
  );
}
