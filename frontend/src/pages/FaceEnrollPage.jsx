import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import FaceCapture from '../components/FaceCapture';
import './FaceEnrollPage.css';

// Public, unauthenticated self-enrollment page — the flip side of HR's
// "Kiosk face match" dialog (EmployeesPage.jsx), which generates the link
// that lands here (see kiosk.service.js's createFaceEnrollLink). Mounted
// outside AppShell/ProtectedRoute in App.jsx, same as SharePage/KioskPage:
// the employee opening this on their own phone has no logged-in session.
// The link is single-use and always expires — see kiosk.service.js's
// module comment on enrollFaceViaLink for why a biometric enrollment link
// needs tighter handling than a read-only document share link.

export default function FaceEnrollPage() {
  const { token } = useParams();
  const [status, setStatus] = useState('loading'); // loading | ready | capturing | submitting | success | error
  const [target, setTarget] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/kiosk/face-enroll/' + token)
      .then((t) => { setTarget(t); setStatus('ready'); })
      .catch((err) => { setError(err.message); setStatus('error'); });
  }, [token]);

  async function submit(descriptors) {
    setStatus('submitting');
    try {
      await api.post('/kiosk/face-enroll/' + token, { descriptors });
      setStatus('success');
    } catch (err) {
      setError(err.message);
      setStatus('ready');
    }
  }

  return (
    <div className="face-enroll-page">
      <div className="face-enroll-card">
        <img src="/logo.png" alt="" className="face-enroll-logo" />
        <h1 className="face-enroll-title">Face ID setup</h1>

        {status === 'loading' && <p className="face-enroll-status">Loading…</p>}

        {status === 'error' && <p className="face-enroll-status face-enroll-error">{error}</p>}

        {status === 'ready' && target && (
          <>
            {error && <div className="face-enroll-error-banner">{error}</div>}
            <p className="face-enroll-body">
              Hi {target.firstName}, this sets up face recognition for the clock-in kiosk — once done, you'll
              need to look at the kiosk's camera (in addition to your PIN) every time you clock in or out.
            </p>
            <p className="face-enroll-body face-enroll-muted">
              Nothing is uploaded or stored except the face measurements captured right now — no photo is kept.
              You'll be asked to look at your camera and slowly turn/tilt your head through a few angles, about
              10 seconds in total.
            </p>
            {target.alreadyEnrolled && (
              <p className="face-enroll-body face-enroll-muted">You already have a face on file — continuing replaces it.</p>
            )}
            <button type="button" className="btn btn-primary face-enroll-start" onClick={() => setStatus('capturing')}>
              Start
            </button>
          </>
        )}

        {status === 'capturing' && (
          <FaceCapture
            mode="enroll"
            title="Look at the camera"
            subtitle="Look straight at the camera, then click Capture — it walks through a few head angles (straight, left, right, up, down)."
            onCapture={submit}
            onCancel={() => setStatus('ready')}
          />
        )}

        {status === 'submitting' && <p className="face-enroll-status">Saving…</p>}

        {status === 'success' && (
          <p className="face-enroll-status face-enroll-success">
            You're all set! Face recognition is now active for your clock-ins. You can close this page.
          </p>
        )}
      </div>
    </div>
  );
}
