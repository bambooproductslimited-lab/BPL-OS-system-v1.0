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

function Tile({ p, local, speaking, screen }) {
  const pub = p.getTrackPublication(screen ? Track.Source.ScreenShare : Track.Source.Camera);
  const video = pub && pub.track && !pub.isMuted ? pub.track : null;
  const micPub = p.getTrackPublication(Track.Source.Microphone);
  const muted = !micPub || micPub.isMuted;
  const name = p.name || p.identity;
  return (
    <div className={'call-tile' + (speaking ? ' is-speaking' : '') + (screen ? ' is-screen' : '') + (video ? ' has-video' : '')}>
      {video ? <VideoView track={video} mirror={local && !screen} /> : (
        <div className="call-tile-face"><span className="call-initials">{initials(name)}</span></div>
      )}
      <span className="call-tile-name">
        {!screen && muted && <CallIcon name="micOff" size={14} />}
        {screen ? tr('{name} is sharing their screen', { name }) : local ? tr('You') : name}
      </span>
    </div>
  );
}

export default function CallScreen({ session, onHeartbeat, onLeave }) {
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

  const alone = remotes.length === 0;
  return (
    <div className="call-screen" role="dialog" aria-modal="true" aria-label={session.title}>
      <header className="call-head">
        <div className="call-head-text">
          <strong>{session.title}</strong>
          <span>
            {state === 'connecting' ? tr('Connecting…') : state === 'reconnecting' ? tr('Reconnecting…') : state === 'failed' ? tr('Not connected')
              : clock(seconds) + ' · ' + (everyone.length === 1 ? tr('Only you') : tr('{n} in the call', { n: everyone.length }))}
          </span>
        </div>
        <span className={'call-kind is-' + session.kind}><CallIcon name={session.kind === 'video' ? 'video' : 'phone'} size={15} /> {session.kind === 'video' ? tr('Video call') : tr('Voice call')}</span>
      </header>

      {error && <div className="call-error" role="alert">{error}</div>}
      {needsTap && <button type="button" className="call-audio-tap" onClick={() => room.startAudio().then(() => setNeedsTap(false))}>{tr('Tap to hear the call')}</button>}

      <div className={'call-stage' + (sharer ? ' has-screen' : '')}>
        {sharer && <div className="call-screen-share"><Tile p={sharer} local={sharer === local} screen /></div>}
        <div className={'call-grid n-' + Math.min(everyone.length, 9)}>
          {everyone.map((p) => <Tile key={p.identity} p={p} local={p === local} speaking={speakers.includes(p.identity)} />)}
        </div>
        {alone && state === 'connected' && <p className="call-waiting">{session.subtitle || tr('Waiting for others to join…')}</p>}
      </div>

      <footer className="call-controls">
        <button type="button" className={'call-btn' + (micOn ? '' : ' is-off')} onClick={() => toggle(() => local.setMicrophoneEnabled(!micOn))}
          aria-pressed={!micOn} aria-label={micOn ? tr('Mute') : tr('Unmute')} title={micOn ? tr('Mute') : tr('Unmute')}>
          <CallIcon name={micOn ? 'mic' : 'micOff'} />
        </button>
        <button type="button" className={'call-btn' + (camOn ? '' : ' is-off')} onClick={() => toggle(() => local.setCameraEnabled(!camOn))}
          aria-pressed={camOn} aria-label={camOn ? tr('Turn camera off') : tr('Turn camera on')} title={camOn ? tr('Turn camera off') : tr('Turn camera on')}>
          <CallIcon name={camOn ? 'video' : 'videoOff'} />
        </button>
        {camOn && /Android|iPhone|iPad/i.test(navigator.userAgent) && (
          <button type="button" className="call-btn" onClick={() => toggle(flipCamera)} aria-label={tr('Switch camera')} title={tr('Switch camera')}><CallIcon name="flip" /></button>
        )}
        {canShare && (
          <button type="button" className={'call-btn' + (sharing ? ' is-on' : '')} onClick={() => toggle(() => local.setScreenShareEnabled(!sharing))}
            aria-pressed={sharing} aria-label={sharing ? tr('Stop sharing') : tr('Share your screen')} title={sharing ? tr('Stop sharing') : tr('Share your screen')}>
            <CallIcon name="screen" />
          </button>
        )}
        <button type="button" className="call-btn is-hangup" onClick={hangUp} aria-label={tr('Leave the call')} title={tr('Leave the call')}><CallIcon name="hangup" /></button>
      </footer>
      <div ref={audioBox} hidden />
    </div>
  );
}
