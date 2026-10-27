import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { api } from '../api/client';
import { activeIntlLocale, msg, tr } from '../lib/i18n.jsx';
import './eighteenth.css';

// A visitor's pass behind its link (/visit/:code; backend visitors.service.js
// pass): who they are coming to see, when, and a code the gate scans or
// reads out. No sign-in; no phone number or email on it.

const PURPOSE = { meeting: msg('Meeting'), delivery: msg('Delivery'), interview: msg('Interview'), contractor: msg('Contractor'), customer: msg('Customer'), official: msg('Official visit'), other: msg('Visit') };
function when(t) { return t ? new Date(t).toLocaleString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : ''; }

export default function VisitPassPage() {
  const { code } = useParams();
  const [p, setP] = useState(null);
  const [qr, setQr] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let live = true;
    api.get('/visit/' + encodeURIComponent(code)).then((x) => {
      if (!live) return;
      setP(x);
      QRCode.toDataURL(x.code, { margin: 1, width: 240, color: { dark: '#14281d', light: '#ffffff' } }).then((u) => { if (live) setQr(u); }).catch(() => {});
    }).catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [code]);
  return (
    <div className="vp">
      <div className="vp-card">
        {error ? <p className="vp-err">{error}</p> : !p ? <p className="vp-wait">{tr('Loading…')}</p> : (
          <>
            <div className="vp-top"><span aria-hidden="true">🎟️</span><div><small>{p.company}</small><h1>{tr('Visitor pass')}</h1></div></div>
            <h2 className="vp-name">{p.name}</h2>
            {p.fromOrg && <p className="vp-from">{p.fromOrg}</p>}
            <dl className="vp-facts">
              <div><dt>{tr('Here to see')}</dt><dd>{p.host || '—'}</dd></div>
              <div><dt>{tr('When')}</dt><dd>{when(p.expectedAt || p.arrivedAt)}</dd></div>
              <div><dt>{tr('For')}</dt><dd>{tr(PURPOSE[p.purpose] || PURPOSE.other)}</dd></div>
            </dl>
            <div className="vp-code">
              {qr && <img src={qr} alt={tr('Pass code {code}', { code: p.code })} />}
              <b>{p.code}</b>
            </div>
            <p className={'vp-state is-' + p.status}>{p.status === 'in' ? '🛎️ ' + tr('Signed in — welcome!') : p.status === 'out' ? '👋 ' + tr('Signed out. Thank you for visiting.') : '📍 ' + tr('Show this at the gate or at reception.')}</p>
          </>
        )}
      </div>
    </div>
  );
}
