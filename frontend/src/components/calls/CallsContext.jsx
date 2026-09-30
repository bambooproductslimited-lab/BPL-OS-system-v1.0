import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { tr } from '../../lib/i18n.jsx';
// The calling library is large: loaded when a call starts, not with the OS.
const CallScreen = lazy(() => import('./CallScreen'));
import CallIcon from './CallIcon';
import './Calls.css';

// Calls across the whole OS (calls.service.js): which calls are running in
// my chats, the ringing card when someone calls me wherever I am in the OS,
// and the call screen once I'm in one. Chats start and join calls through
// useCalls().

const CallsCtx = createContext({ live: [], configured: false, active: null, startCall() {}, joinCall() {}, joinMeeting() {}, error: null, clearError() {} });
export function useCalls() { return useContext(CallsCtx); }

const POLL_MS = 4000;

// A soft two-note ring, made in the browser (no sound file to load), and a
// buzz on phones that can.
function useRingtone(on) {
  useEffect(() => {
    if (!on) return undefined;
    let ctx = null, stopped = false;
    const ring = () => {
      if (stopped) return;
      try {
        ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
        [[660, 0], [880, 0.22], [660, 0.9], [880, 1.12]].forEach(([f, at]) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.frequency.value = f; o.type = 'sine';
          g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
          g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + at + 0.03);
          g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.2);
          o.connect(g).connect(ctx.destination);
          o.start(ctx.currentTime + at); o.stop(ctx.currentTime + at + 0.22);
        });
      } catch { /* no sound allowed yet — the card still shows */ }
      try { if (navigator.vibrate) navigator.vibrate([300, 150, 300]); } catch { /* not a phone */ }
    };
    ring();
    const t = setInterval(ring, 2600);
    return () => { stopped = true; clearInterval(t); try { if (ctx) ctx.close(); } catch { /* closed */ } };
  }, [on]);
}

function IncomingCall({ call, onAccept, onDecline }) {
  useRingtone(true);
  const who = call.startedBy ? call.startedBy.name : tr('Someone');
  return (
    <div className="call-incoming" role="alertdialog" aria-live="assertive" aria-label={tr('Incoming call')}>
      <span className={'call-incoming-icon is-' + call.kind}><CallIcon name={call.kind === 'video' ? 'video' : 'phone'} size={22} /></span>
      <div className="call-incoming-text">
        <strong>{who}</strong>
        <span>{call.kind === 'video' ? tr('Video call') : tr('Voice call')}{call.group && call.chatName ? ' · ' + call.chatName : ''}</span>
      </div>
      <button type="button" className="call-round is-decline" onClick={onDecline} aria-label={tr('Decline')} title={tr('Decline')}><CallIcon name="hangup" /></button>
      <button type="button" className="call-round is-accept" onClick={onAccept} aria-label={tr('Answer')} title={tr('Answer')}><CallIcon name={call.kind === 'video' ? 'video' : 'phone'} /></button>
    </div>
  );
}

export function CallsProvider({ children }) {
  const [live, setLive] = useState([]);
  const [configured, setConfigured] = useState(false);
  const [active, setActive] = useState(null); // { callId, session }
  const [dismissed, setDismissed] = useState({});
  const [error, setError] = useState(null);
  const activeRef = useRef(null);
  activeRef.current = active;

  const refresh = useCallback(async () => {
    try {
      const r = await api.get('/messages/calls/live');
      setLive(r.calls || []);
      setConfigured(!!r.configured);
    } catch { /* offline for a moment: keep what we had */ }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Leaving the page mid-call still hangs up for the others.
  useEffect(() => {
    const bye = () => {
      const a = activeRef.current;
      if (!a) return;
      try {
        fetch(api.url('/messages/calls/' + a.callId + '/leave'), { method: 'POST', keepalive: true, headers: api.authHeaders() });
      } catch { /* the server ends it once we stop checking in */ }
    };
    window.addEventListener('pagehide', bye);
    return () => window.removeEventListener('pagehide', bye);
  }, []);

  function open(r, title, subtitle) {
    setError(null);
    setDismissed((d) => ({ ...d, [r.id]: true }));
    setActive({ callId: r.id, conversationId: r.conversationId, session: { url: r.url, token: r.token, kind: r.kind, title: title || tr('Call'), subtitle } });
  }
  async function run(fn, title, subtitle) {
    if (activeRef.current) { setError(tr('You are already in a call. Leave it first.')); return; }
    try { open(await fn(), title, subtitle); } catch (e) { setError(e.message); }
  }
  const value = {
    live, configured, active, error, clearError: () => setError(null),
    startCall: (conversationId, kind, title) => run(() => api.post('/messages/conversations/' + conversationId + '/calls', { kind }), title),
    joinCall: (callId, title) => run(() => api.post('/messages/calls/' + callId + '/join'), title),
    joinMeeting: (meetingId, title) => run(() => api.post('/messages/meetings/' + meetingId + '/join'), title, tr('The meeting has started. Others will appear here as they join.')),
    refresh
  };

  const ringing = !active && live.find((c) => c.ringing && !dismissed[c.id]);
  async function decline(c) {
    setDismissed((d) => ({ ...d, [c.id]: true }));
    try { await api.post('/messages/calls/' + c.id + '/decline'); } catch { /* it stops ringing anyway */ }
    refresh();
  }

  return (
    <CallsCtx.Provider value={value}>
      {children}
      {ringing && (
        <IncomingCall call={ringing}
          onAccept={() => value.joinCall(ringing.id, ringing.group && ringing.chatName ? ringing.chatName : ringing.startedBy ? ringing.startedBy.name : tr('Call'))}
          onDecline={() => decline(ringing)} />
      )}
      {error && !active && (
        <div className="call-toast" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label={tr('Close')}><CallIcon name="close" size={16} /></button></div>
      )}
      {active && (
        <Suspense fallback={<div className="call-screen call-loading">{tr('Connecting…')}</div>}>
        <CallScreen session={active.session}
          onHeartbeat={() => api.post('/messages/calls/' + active.callId + '/heartbeat')}
          onLeave={async () => {
            const id = active.callId;
            setActive(null);
            try { await api.post('/messages/calls/' + id + '/leave'); } catch { /* ended already */ }
            refresh();
          }} />
        </Suspense>
      )}
    </CallsCtx.Provider>
  );
}
