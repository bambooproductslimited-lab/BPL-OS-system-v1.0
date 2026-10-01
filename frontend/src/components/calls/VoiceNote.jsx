import { useEffect, useRef, useState } from 'react';
import { tr } from '../../lib/i18n.jsx';
import { uploadWithProgress } from '../../lib/chatMedia';
import CallIcon from './CallIcon';

// A call nobody picked up: leave them a voice note instead, like voicemail.
// Offered when the call stops ringing unanswered, or straight away when the
// caller presses "Leave a voice note instead" while it rings. The note goes
// into the chat the call was made from, as any voice note does (the same
// recording format as MessagesPage.jsx), so they hear it when they look.

const MAX_SECONDS = 120;

function clock(s) { const n = Math.floor(s); return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0'); }

export default function VoiceNote({ conversationId, name, missed, startNow, onClose }) {
  const [state, setState] = useState('idle'); // idle | recording | sending | sent
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState(null);
  const recRef = useRef(null);

  async function start() {
    setError(null);
    if (!navigator.mediaDevices || !window.MediaRecorder) { setError(tr('Voice notes are not supported in this browser.')); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ['audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
      const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const chunks = [];
      rec.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        clearInterval(rec.timer);
        if (rec.cancelled || !chunks.length) { setState('idle'); setSeconds(0); return; }
        const mime = rec.mimeType || type || 'audio/webm';
        const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
        const file = new File(chunks, 'voice-note-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.' + ext, { type: mime.split(';')[0] });
        setState('sending');
        try {
          const fd = new FormData();
          fd.append('files', file, file.name);
          await uploadWithProgress('/messages/conversations/' + conversationId, fd);
          setState('sent');
          setTimeout(onClose, 2200);
        } catch (err) { setError(err.message || tr('The voice note could not be sent. Try again.')); setState('idle'); }
      };
      rec.start();
      recRef.current = rec;
      const started = Date.now();
      setSeconds(0);
      setState('recording');
      rec.timer = setInterval(() => {
        const s = (Date.now() - started) / 1000;
        setSeconds(s);
        if (s >= MAX_SECONDS) stop(false);
      }, 250);
    } catch {
      setError(tr('The microphone could not be used. Allow it in the browser and try again.'));
      setState('idle');
    }
  }
  function stop(cancel) {
    const rec = recRef.current;
    if (!rec) return;
    recRef.current = null;
    rec.cancelled = !!cancel;
    try { rec.stop(); } catch { /* stopped */ }
  }

  useEffect(() => {
    if (startNow) start();
    return () => stop(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="call-voicenote" role="dialog" aria-live="polite" aria-label={tr('Leave a voice note')}>
      <span className={'call-voicenote-icon' + (state === 'recording' ? ' is-rec' : '')}><CallIcon name="mic" size={22} /></span>
      <div className="call-voicenote-text">
        <strong>{state === 'sent' ? tr('Voice note sent to {name}', { name })
          : missed ? tr('{name} didn\'t answer', { name }) : tr('Voice note for {name}', { name })}</strong>
        <span>{state === 'recording' ? <><span className="call-rec-dot" aria-hidden="true" /> {tr('Recording {time} — press Send when you are done', { time: clock(seconds) })}</>
          : state === 'sending' ? tr('Sending…')
          : state === 'sent' ? tr('They will find it in your chat.')
          : tr('Leave a voice note: it goes into your chat with them.')}</span>
        {error && <span className="call-voicenote-error" role="alert">{error}</span>}
      </div>
      <div className="call-voicenote-acts">
        {state === 'idle' && <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Not now')}</button>
          <button type="button" className="btn btn-primary" onClick={start}>{tr('Record voice note')}</button>
        </>}
        {state === 'recording' && <>
          <button type="button" className="btn btn-secondary" onClick={() => { stop(true); onClose(); }}>{tr('Cancel')}</button>
          <button type="button" className="btn btn-primary" onClick={() => stop(false)}>{tr('Send')}</button>
        </>}
      </div>
    </div>
  );
}
