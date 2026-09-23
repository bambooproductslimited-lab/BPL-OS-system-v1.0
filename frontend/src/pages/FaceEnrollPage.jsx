import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import FaceCapture from '../components/FaceCapture';
import { tr } from '../lib/i18n.jsx';
import './FaceEnrollPage.css';

// Public, unauthenticated self-enrollment page — the flip side of HR's
// "Kiosk face match" dialog (EmployeesPage.jsx), which generates the link
// that lands here (see kiosk.service.js's createFaceEnrollLink). Mounted
// outside AppShell/ProtectedRoute in App.jsx, same as SharePage/KioskPage:
// the employee opening this on their own phone has no logged-in session.
// The link is single-use and always expires — see kiosk.service.js's
// module comment on enrollFaceViaLink for why a biometric enrollment link
// needs tighter handling than a read-only document share link.
//
// The link alone only proves possession of a URL, not identity — a
// forwarded/leaked link would otherwise let anyone enroll THEIR face
// against this employee's clock-in record. The PIN step below closes
// that gap: it's the same kiosk PIN only this employee (and HR) know,
// checked server-side before the camera runs and again right before the
// enrollment is actually written (see kiosk.service.js's
// verifyPinAgainstEmployee).

export default function FaceEnrollPage() {
  const { token } = useParams();
  const [status, setStatus] = useState('loading'); // loading | ready | pin | capturing | submitting | success | error
  const [target, setTarget] = useState(null);
  const [error, setError] = useState(null);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState(null);
  const [pinChecking, setPinChecking] = useState(false);

  useEffect(() => {
    api.get('/kiosk/face-enroll/' + token)
      .then((t) => { setTarget(t); setStatus('ready'); })
      .catch((err) => { setError(err.message); setStatus('error'); });
  }, [token]);

  async function verifyPin(e) {
    e.preventDefault();
    setPinError(null);
    setPinChecking(true);
    try {
      await api.post('/kiosk/face-enroll/' + token + '/verify-pin', { pin });
      setStatus('capturing');
    } catch (err) {
      setPinError(err.message);
    } finally {
      setPinChecking(false);
    }
  }

  async function submit(descriptors) {
    setStatus('submitting');
    try {
      await api.post('/kiosk/face-enroll/' + token, { descriptors, pin });
      setStatus('success');
    } catch (err) {
      setPinError(err.message);
      setStatus('pin');
    }
  }

  return (
    <div className="face-enroll-page">
      <div className="face-enroll-card">
        <img src="/logo.png" alt="" className="face-enroll-logo" />
        <h1 className="face-enroll-title">{tr('Face ID setup')}</h1>

        {status === 'loading' && <p className="face-enroll-status">{tr('Loading…')}</p>}

        {status === 'error' && <p className="face-enroll-status face-enroll-error">{error}</p>}

        {status === 'ready' && target && (
          <>
            <p className="face-enroll-body">
              {tr("Hi {firstName}, this sets up face recognition for the clock-in kiosk — once done, you'll need to look at the kiosk's camera (in addition to your PIN) every time you clock in or out.", { firstName: target.firstName })}
            </p>
            <p className="face-enroll-body face-enroll-muted">
              {tr('Nothing is uploaded or stored except the face measurements captured right now — no photo is kept. You\'ll be asked to look at your camera and slowly turn/tilt your head through a few angles, about 10 seconds in total.')}
            </p>
            {target.alreadyEnrolled && (
              <p className="face-enroll-body face-enroll-muted">{tr('You already have a face on file — continuing replaces it.')}</p>
            )}
            <button type="button" className="btn btn-primary face-enroll-start" onClick={() => setStatus('pin')}>
              {tr('Start')}
            </button>
          </>
        )}

        {status === 'pin' && (
          <form onSubmit={verifyPin} className="face-enroll-pin-form">
            <p className="face-enroll-body">{tr('First, confirm it\'s you — enter your kiosk PIN.')}</p>
            {pinError && <div className="face-enroll-error-banner">{pinError}</div>}
            <input
              className="input face-enroll-pin-input" inputMode="numeric" pattern="\d{4}" maxLength={4} autoFocus
              value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
              placeholder="••••"
            />
            <div className="face-enroll-pin-actions">
              <button type="button" className="btn btn-secondary" onClick={() => { setStatus('ready'); setPinError(null); }}>{tr('Back')}</button>
              <button type="submit" className="btn btn-primary" disabled={pin.length !== 4 || pinChecking}>
                {pinChecking ? tr('Checking…') : tr('Continue')}
              </button>
            </div>
          </form>
        )}

        {status === 'capturing' && (
          <FaceCapture
            mode="enroll"
            title={tr('Look at the camera')}
            subtitle={tr('Look straight at the camera, then click Capture — it walks through a few head angles (straight, left, right, up, down).')}
            onCapture={submit}
            onCancel={() => setStatus('ready')}
          />
        )}

        {status === 'submitting' && <p className="face-enroll-status">{tr('Saving…')}</p>}

        {status === 'success' && (
          <p className="face-enroll-status face-enroll-success">
            {tr('You\'re all set! Face recognition is now active for your clock-ins. You can close this page.')}
          </p>
        )}
      </div>
    </div>
  );
}
