import { lazy, Suspense, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import { tr, activeIntlLocale } from '../lib/i18n.jsx';
const CallScreen = lazy(() => import('../components/calls/CallScreen'));
import CallIcon from '../components/calls/CallIcon';
import { whenText } from '../components/calls/Meetings';
import '../components/calls/Calls.css';

// A meeting's guest link (calls.service.js): clients and suppliers join a
// booked meeting by name, with no account. Public — mounted outside the app
// shell in App.jsx. The link only lets them in while the meeting is open.
export default function MeetPage() {
  const { token } = useParams();
  const [m, setM] = useState(null);
  const [error, setError] = useState(null);
  const [name, setName] = useState(() => { try { return localStorage.getItem('bamboo-guest-name') || ''; } catch { return ''; } });
  const [joining, setJoining] = useState(false);
  const [inCall, setInCall] = useState(null); // { guestId, session }
  const [left, setLeft] = useState(false);

  function load() { api.get('/meet/' + token).then(setM).catch((e) => setError(e.message)); }
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  async function join(e) {
    e.preventDefault();
    setJoining(true); setError(null);
    try {
      try { localStorage.setItem('bamboo-guest-name', name.trim()); } catch { /* private window */ }
      const r = await api.post('/meet/' + token + '/join', { name: name.trim() });
      setLeft(false);
      setInCall({ guestId: r.guestId, session: { url: r.url, token: r.token, kind: r.kind, title: r.meeting.title, subtitle: tr('Waiting for the others to join…') } });
    } catch (err) { setError(err.message); }
    setJoining(false);
  }

  if (inCall) {
    return (
      <Suspense fallback={<div className="call-screen call-loading">{tr('Connecting…')}</div>}>
      <CallScreen session={inCall.session}
        onHeartbeat={() => api.post('/meet/' + token + '/heartbeat', { guestId: inCall.guestId })}
        onLeave={async () => {
          const id = inCall.guestId;
          setInCall(null); setLeft(true);
          try { await api.post('/meet/' + token + '/leave', { guestId: id }); } catch { /* ended already */ }
          load();
        }} />
      </Suspense>
    );
  }

  const locale = activeIntlLocale();
  return (
    <div className="meet-page">
      <div className="meet-page-card">
        <img src="/logo.png" alt="" className="meet-page-logo" />
        {!m && !error && <p className="meet-page-muted">{tr('Loading…')}</p>}
        {!m && error && <><h1>{tr('This link doesn\'t work')}</h1><p className="meet-page-muted">{error}</p></>}
        {m && (
          <>
            <span className="meet-page-kicker">{m.company || ''}</span>
            <h1>{m.title}</h1>
            <p className="meet-page-when"><CallIcon name={m.kind === 'video' ? 'video' : 'phone'} size={17} /> {m.kind === 'video' ? tr('Video meeting') : tr('Voice meeting')} · {whenText(m, locale)}</p>
            {m.host && <p className="meet-page-muted">{tr('Hosted by {name}', { name: m.host })}</p>}
            {m.note && <p className="meet-page-note">{m.note}</p>}
            {left && <p className="meet-page-left">{tr('You left the meeting.')}</p>}
            {m.cancelled ? <p className="meet-page-state">{tr('This meeting was cancelled.')}</p>
              : m.over ? <p className="meet-page-state">{tr('This meeting is over.')}</p>
              : !m.configured ? <p className="meet-page-state">{tr('Calls aren\'t available right now. Please contact the host.')}</p>
              : !m.open ? <p className="meet-page-state">{tr('You can join from 15 minutes before it starts. This page will let you in then.')}</p>
              : (
                <form className="meet-page-form" onSubmit={join}>
                  {error && <div className="error-banner" role="alert">{error}</div>}
                  <div className="field"><label htmlFor="meet-guest-name">{tr('Your name')}</label>
                    <input id="meet-guest-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required autoComplete="name" placeholder={tr('So the others know who you are')} />
                  </div>
                  <button type="submit" className="btn btn-primary" disabled={joining || !name.trim()}>{joining ? tr('Joining…') : left ? tr('Join again') : tr('Join the meeting')}</button>
                  <p className="meet-page-muted">{m.kind === 'video' ? tr('Your browser will ask to use your camera and microphone.') : tr('Your browser will ask to use your microphone.')}</p>
                </form>
              )}
          </>
        )}
      </div>
    </div>
  );
}
