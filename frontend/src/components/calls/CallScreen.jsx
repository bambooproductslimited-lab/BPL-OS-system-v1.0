import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track, ConnectionState } from 'livekit-client';
import { tr } from '../../lib/i18n.jsx';
import CallIcon from './CallIcon';
import './Calls.css';

// The call itself (calls.service.js hands out the pass): everyone in it as a
// tile — their camera, or their initials with a ring while they speak — and
// the controls along the bottom. Used for staff calls (CallsProvider) and by
// guests on a meeting's link (MeetPage). The sound and pictures go through
// LiveKit; this only connects, shows and cleans up.
//
// session: { url, token, kind, title, subtitle }
// onHeartbeat(): resolves { ended } — every 20 s, so the OS knows we are here
// onLeave(): after hanging up (or the call ending)
// minimized, onMinimize(bool): staff calls can shrink to a small window in a
//   corner so the OS can be used — and shown — during the call. Sharing your
//   screen shrinks it by itself, so the others see your work, not the call.

function initials(name) {
  const parts = String(name || '').replace(/\(guest\)/, '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function clock(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
}

function VideoView({ track, mirror }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !track) return undefined;
    track.attach(el);
    return () => { track.detach(el); };
  }, [track]);
  return <video ref={ref} autoPlay playsInline muted className={'call-video' + (mirror ? ' is-mirror' : '')} />;
}

// Each person keeps one colour for their avatar, from the OS's own palette.
const ACCENTS = ['#2f7d4f', '#1f5a8a', '#7a4fa3', '#b3632f', '#2f8a86', '#a33f5c', '#5f7d2f'];
function accentOf(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return ACCENTS[h % ACCENTS.length];
}

function Tile({ p, local, speaking, screen }) {
  const pub = p.getTrackPublication(screen ? Track.Source.ScreenShare : Track.Source.Camera);
  const video = pub && pub.track && !pub.isMuted ? pub.track : null;
  const micPub = p.getTrackPublication(Track.Source.Microphone);
  const muted = !micPub || micPub.isMuted;
  const name = p.name || p.identity;
  return (
    <div className={'call-tile' + (speaking ? ' is-speaking' : '') + (screen ? ' is-screen' : '') + (video ? ' has-video' : '') + (local && !screen ? ' is-self' : '')}
      style={{ '--tile-accent': accentOf(p.identity) }}>
      {video ? <VideoView track={video} mirror={local && !screen} /> : (
        <div className="call-tile-face"><span className="call-avatar"><span className="call-initials">{initials(name)}</span></span></div>
      )}
      <span className="call-tile-name">
        {screen ? <CallIcon name="screen" size={14} />
          : muted ? <span className="call-tile-muted" title={tr('Muted')}><CallIcon name="micOff" size={13} /></span>
          : speaking ? <span className="call-bars" aria-hidden="true"><i /><i /><i /></span> : null}
        <span className="call-tile-label">{screen ? tr('{name} is sharing their screen', { name }) : local ? tr('You') : name}</span>
      </span>
    </div>
  );
}

// Where the small window sits, moved by dragging it; kept inside the window.
function useDrag() {
  const [pos, setPos] = useState(null); // null: the corner from Calls.css
  const drag = useRef(null);
  function onPointerDown(e) {
    if (e.button !== 0 || e.target.closest('button')) return;
    const box = e.currentTarget.getBoundingClientRect();
    drag.current = { dx: e.clientX - box.left, dy: e.clientY - box.top, w: box.width, h: box.height };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e) {
    const d = drag.current;
    if (!d) return;
    setPos({
      left: Math.min(Math.max(8, e.clientX - d.dx), window.innerWidth - d.w - 8),
      top: Math.min(Math.max(8, e.clientY - d.dy), window.innerHeight - d.h - 8)
    });
  }
  function onPointerUp() { drag.current = null; }
  return { style: pos ? { left: pos.left, top: pos.top, right: 'auto', bottom: 'auto' } : undefined, onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp };
}

export default function CallScreen({ session, onHeartbeat, onLeave, minimized = false, onMinimize }) {
  const roomRef = useRef(null);
  const audioBox = useRef(null);
  const [, setVersion] = useState(0);
  const [state, setState] = useState('connecting'); // connecting | connected | reconnecting | failed
  const [error, setError] = useState(null);
  const [speakers, setSpeakers] = useState([]);
  const [needsTap, setNeedsTap] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const leftRef = useRef(false);
  const connectedRef = useRef(false);
  const bump = () => setVersion((v) => v + 1);

  async function hangUp() {
    if (leftRef.current) return;
    leftRef.current = true;
    try { await roomRef.current?.disconnect(); } catch { /* already gone */ }
    onLeave();
  }

  useEffect(() => {
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;
    let stopped = false;
    const onTrack = (track) => {
      if (track.kind === Track.Kind.Audio && audioBox.current) audioBox.current.appendChild(track.attach());
      bump();
    };
    const offTrack = (track) => { track.detach().forEach((el) => el.remove()); bump(); };
    room
      .on(RoomEvent.TrackSubscribed, onTrack)
      .on(RoomEvent.TrackUnsubscribed, offTrack)
      .on(RoomEvent.ParticipantConnected, bump)
      .on(RoomEvent.ParticipantDisconnected, bump)
      .on(RoomEvent.TrackMuted, bump)
      .on(RoomEvent.TrackUnmuted, bump)
      .on(RoomEvent.LocalTrackPublished, bump)
      .on(RoomEvent.LocalTrackUnpublished, bump)
      .on(RoomEvent.ActiveSpeakersChanged, (list) => setSpeakers(list.map((p) => p.identity)))
      .on(RoomEvent.AudioPlaybackStatusChanged, () => setNeedsTap(!room.canPlaybackAudio))
      .on(RoomEvent.ConnectionStateChanged, (s) => {
        if (s === ConnectionState.Reconnecting) setState('reconnecting');
        if (s === ConnectionState.Connected) setState('connected');
      })
      .on(RoomEvent.Disconnected, () => {
        if (stopped || leftRef.current) return;
        // Never got in: stay on screen and say so (the catch below), rather
        // than closing before anyone can see why.
        if (!connectedRef.current) return;
        leftRef.current = true; onLeave();
      });

    (async () => {
      try {
        await room.connect(session.url, session.token);
        if (stopped) return;
        connectedRef.current = true;
        setState('connected');
        try { await room.localParticipant.setMicrophoneEnabled(true); } catch { setError(tr('Your microphone could not be turned on. Allow it in the browser to be heard.')); }
        if (session.kind === 'video') {
          try { await room.localParticipant.setCameraEnabled(true); } catch { setError(tr('Your camera could not be turned on. Allow it in the browser, or carry on without video.')); }
        }
        setNeedsTap(!room.canPlaybackAudio);
        bump();
      } catch (e) {
        console.error('Call could not connect:', e);
        if (!stopped) { setState('failed'); setError(tr('The call could not connect. Check the internet connection and try again.')); }
      }
    })();
    return () => { stopped = true; room.disconnect(); };
  }, [session.url, session.token]); // eslint-disable-line react-hooks/exhaustive-deps

  // Time in the call, and letting the OS know we are still here.
  useEffect(() => {
    if (state !== 'connected' && state !== 'reconnecting') return undefined;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [state]);
  useEffect(() => {
    const t = setInterval(async () => {
      try { const r = await onHeartbeat(); if (r && r.ended) hangUp(); } catch { /* try again next time */ }
    }, 20000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const room = roomRef.current;
  const local = room ? room.localParticipant : null;
  const remotes = room ? Array.from(room.remoteParticipants.values()) : [];
  const everyone = local ? [local, ...remotes] : [];
  const sharer = everyone.find((p) => { const s = p.getTrackPublication(Track.Source.ScreenShare); return s && s.track; });
  const micOn = local ? local.isMicrophoneEnabled : true;
  const camOn = local ? local.isCameraEnabled : false;
  const sharing = local ? local.isScreenShareEnabled : false;
  const canShare = typeof navigator !== 'undefined' && navigator.mediaDevices && !!navigator.mediaDevices.getDisplayMedia && !/Android|iPhone|iPad/i.test(navigator.userAgent);

  async function toggle(fn) {
    if (!local || busy) return;
    setBusy(true); setError(null);
    try { await fn(); } catch { setError(tr('That didn\'t work. Check that the browser may use your camera and microphone.')); }
    setBusy(false); bump();
  }
  async function flipCamera() {
    const devices = await Room.getLocalDevices('videoinput');
    if (devices.length < 2) return;
    const current = room.getActiveDevice('videoinput');
    const i = devices.findIndex((d) => d.deviceId === current);
    await room.switchActiveDevice('videoinput', devices[(i + 1) % devices.length].deviceId);
  }

  async function toggleShare() {
    if (!local || busy) return;
    const start = !sharing;
    setBusy(true); setError(null);
    try {
      await local.setScreenShareEnabled(start, {
        // Offer this tab (the OS) as well as other tabs, windows and the whole
        // screen, and let the sharer switch what they show mid-share. No tab
        // sound: the call itself plays in this tab and would echo back.
        selfBrowserSurface: 'include', surfaceSwitching: 'include', audio: false
      });
      if (start && onMinimize && local.isScreenShareEnabled) onMinimize(true);
    } catch (e) {
      // Closing the browser's "choose what to share" box is not an error.
      if (!e || e.name !== 'NotAllowedError') setError(tr('Your screen could not be shared. Check that the browser may share your screen.'));
    }
    setBusy(false); bump();
  }

  const drag = useDrag();
  const alone = remotes.length === 0;
  const live = state === 'connected' || state === 'reconnecting';
  const kindText = session.kind === 'video' ? tr('Video call') : tr('Voice call');
  const status = state === 'connecting' ? tr('Connecting…') : state === 'reconnecting' ? tr('Reconnecting…') : state === 'failed' ? tr('Not connected')
    : clock(seconds) + ' · ' + (everyone.length === 1 ? tr('Only you') : tr('{n} in the call', { n: everyone.length }));
  const audio = <div ref={audioBox} hidden />;
  const isPhone = typeof navigator !== 'undefined' && /Android|iPhone|iPad/i.test(navigator.userAgent);

  // One control: a round button, with what it does written under it on the
  // full screen (the small window has room for the icons only).
  const ctl = (small, { icon, label, hint, onClick, tone, pressed }) => (
    <div className={'call-ctl' + (small ? ' is-small' : '')} key={icon + label}>
      <button type="button" className={'call-btn' + (tone ? ' is-' + tone : '')} onClick={onClick} disabled={busy && tone !== 'hangup'}
        aria-pressed={pressed} aria-label={hint || label} title={hint || label}>
        <CallIcon name={icon} size={small ? 18 : 21} />
      </button>
      {!small && <span className="call-ctl-label" aria-hidden="true">{label}</span>}
    </div>
  );
  const controls = (small) => [
    ctl(small, { icon: micOn ? 'mic' : 'micOff', label: micOn ? tr('Mute') : tr('Unmute'), tone: micOn ? '' : 'off', pressed: !micOn,
      onClick: () => toggle(() => local.setMicrophoneEnabled(!micOn)) }),
    !small && ctl(small, { icon: camOn ? 'video' : 'videoOff', label: camOn ? tr('Stop video') : tr('Start video'), hint: camOn ? tr('Turn camera off') : tr('Turn camera on'),
      tone: camOn ? '' : 'off', pressed: camOn, onClick: () => toggle(() => local.setCameraEnabled(!camOn)) }),
    !small && camOn && isPhone && ctl(small, { icon: 'flip', label: tr('Flip'), hint: tr('Switch camera'), onClick: () => toggle(flipCamera) }),
    canShare && ctl(small, { icon: 'screen', label: sharing ? tr('Stop sharing') : tr('Share screen'), hint: sharing ? tr('Stop sharing') : tr('Share your screen'),
      tone: sharing ? 'on' : '', pressed: sharing, onClick: toggleShare }),
    small && ctl(small, { icon: 'grow', label: tr('Back to the full call'), onClick: () => onMinimize(false) }),
    ctl(small, { icon: 'hangup', label: tr('Leave'), hint: tr('Leave the call'), tone: 'hangup', onClick: hangUp })
  ].filter(Boolean);
  const tapToHear = needsTap && <button type="button" className="call-audio-tap" onClick={() => room.startAudio().then(() => setNeedsTap(false))}>{tr('Tap to hear the call')}</button>;

  if (minimized) {
    // Someone else's shared screen first, then whoever is talking, then the
    // first of the others.
    const remoteSharer = sharer && sharer !== local ? sharer : null;
    const focus = remoteSharer || remotes.find((p) => speakers.includes(p.identity)) || remotes[0] || local;
    return (
      <>
        {audio}
        <div className="call-mini" role="dialog" aria-label={session.title} {...drag}>
          <div className="call-mini-view">
            {focus && <Tile p={focus} local={focus === local} screen={!!remoteSharer} speaking={!remoteSharer && speakers.includes(focus.identity)} />}
            {sharing && <span className="call-mini-sharing"><span className="call-rec-dot" aria-hidden="true" />{tr('You are sharing your screen')}</span>}
          </div>
          <div className="call-mini-info">
            <strong>{session.title}</strong>
            <span>{live && <span className="call-live-dot" aria-hidden="true" />}{status}</span>
          </div>
          {error && <div className="call-mini-error" role="alert">{error}</div>}
          {tapToHear}
          <div className="call-mini-controls">{controls(true)}</div>
        </div>
      </>
    );
  }

  const duo = !sharer && everyone.length === 2;
  return (
    <>
    {audio}
    <div className={'call-screen is-' + session.kind} role="dialog" aria-modal="true" aria-label={session.title}>
      <header className="call-head">
        <div className="call-head-main">
          <span className={'call-head-icon is-' + session.kind}><CallIcon name={session.kind === 'video' ? 'video' : 'phone'} size={18} /></span>
          <div className="call-head-text">
            <strong>{session.title}</strong>
            <span>{live && <span className="call-live-dot" aria-hidden="true" />}{kindText} · {status}</span>
          </div>
        </div>
        <div className="call-head-side">
          {sharing && <span className="call-chip is-sharing"><span className="call-rec-dot" aria-hidden="true" />{tr('You are sharing your screen')}</span>}
          {onMinimize && (
            <button type="button" className="call-chip is-button" onClick={() => onMinimize(true)} aria-label={tr('Minimise')} title={tr('Shrink the call to a corner and keep using the OS')}>
              <CallIcon name="shrink" size={15} /> <span className="call-chip-text">{tr('Minimise')}</span>
            </button>
          )}
        </div>
      </header>

      {error && <div className="call-error" role="alert">{error}</div>}
      {tapToHear}

      <div className={'call-stage' + (sharer ? ' has-screen' : '')}>
        {sharer && <div className="call-screen-share"><Tile p={sharer} local={sharer === local} screen /></div>}
        <div className={'call-grid n-' + Math.min(everyone.length, 9) + (duo ? ' is-duo' : '')}>
          {everyone.map((p) => <Tile key={p.identity} p={p} local={p === local} speaking={speakers.includes(p.identity)} />)}
        </div>
        {alone && state === 'connected' && (
          <p className="call-waiting"><span className="call-dots" aria-hidden="true"><i /><i /><i /></span>{session.subtitle || tr('Waiting for others to join…')}</p>
        )}
      </div>

      <footer className="call-dock-wrap">
        <div className="call-dock">{controls(false)}</div>
      </footer>
    </div>
    </>
  );
}
