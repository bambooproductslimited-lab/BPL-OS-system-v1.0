import { useEffect, useState } from 'react';
import { tr } from '../../lib/i18n.jsx';
import { pushSupported, permissionState, iosNeedsInstall, enablePush, isEnabledHere } from '../../lib/pushNotifications';
import CallIcon from './CallIcon';

// Calls reach a phone or computer with the OS closed only if pop-up alerts
// are on for that device (public/sw.js). This asks, above the chat list,
// until they are — or says what's in the way. Hidden for good once closed.
const HIDE_KEY = 'bamboo-call-alerts-hidden';

export default function CallAlerts() {
  const [state, setState] = useState(null); // off | ios | denied | busy | on
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(HIDE_KEY) === '1'; } catch { return false; } });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let s;
      if (iosNeedsInstall()) s = 'ios';
      else if (!pushSupported()) s = null;
      else if (permissionState() === 'denied') s = 'denied';
      else s = (await isEnabledHere()) ? 'on' : 'off';
      if (!cancelled) setState(s);
    })();
    return () => { cancelled = true; };
  }, []);

  if (hidden || !state || state === 'on') return null;
  function hide() { setHidden(true); try { localStorage.setItem(HIDE_KEY, '1'); } catch { /* private window */ } }
  async function turnOn() {
    setState('busy');
    const r = await enablePush();
    setState(r === 'on' ? 'on' : r === 'denied' ? 'denied' : 'off');
  }

  return (
    <div className="call-alerts" role="note">
      <span className="call-alerts-icon"><CallIcon name="phone" size={16} /></span>
      <div className="call-alerts-text">
        <strong>{tr('Get calls when the OS is closed')}</strong>
        <span>
          {state === 'ios' ? tr('On iPhone or iPad, add Bamboo OS to your Home Screen (Share, then Add to Home Screen), open it from there and turn alerts on.')
            : state === 'denied' ? tr('Alerts are blocked for this site. Allow notifications in the browser\'s site settings, then come back.')
            : tr('Turn on alerts and calls will ring on this device whenever it is online, even with Bamboo OS closed.')}
        </span>
        {(state === 'off' || state === 'busy') && (
          <button type="button" className="btn btn-primary" onClick={turnOn} disabled={state === 'busy'}>{state === 'busy' ? tr('Turning on…') : tr('Turn on alerts')}</button>
        )}
      </div>
      <button type="button" className="call-alerts-close" onClick={hide} aria-label={tr('Close')}><CallIcon name="close" size={15} /></button>
    </div>
  );
}
