import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { tr } from '../lib/i18n.jsx';
import { Status, fmtDate } from './DashKit';
import { SignatureView } from './SignaturePad';
import './ClientAnswers.css';

// What the customer said on an estimate's or a quotation's link (backend
// documentAnswers.service.js), for the Quotations and Estimates windows:
// approved with their signature, declined, changes asked for, newest first.

// The tag beside a document's state: the customer's latest answer, and
// whether they opened the link.
export function AnswerTag({ doc }) {
  if (doc.clientAnswer === 'approved') return <Status tone="good">✍️ {tr('Signed online')}</Status>;
  if (doc.clientAnswer === 'declined') return <Status tone="bad">{tr('Declined online')}</Status>;
  if (doc.clientAnswer === 'changes') return <Status tone="warn">✎ {tr('Changes asked')}</Status>;
  if (doc.viewedAt) return <Status tone="info">👀 {tr('Opened')}</Status>;
  return null;
}

const SAID = { approved: 'Approved and signed', declined: 'Declined', changes: 'Asked for changes' };

export default function ClientAnswers({ type, id, refreshKey }) {
  const [list, setList] = useState(null);
  useEffect(() => {
    let live = true;
    api.get('/document-answers/' + type + '/' + id).then((r) => { if (live) setList(r); }).catch(() => { if (live) setList([]); });
    return () => { live = false; };
  }, [type, id, refreshKey]);
  if (!list || !list.length) return null;
  return (
    <>
      <h3 className="tl-h3">{tr('What the customer said')}</h3>
      <ol className="ca-list">
        {list.map((a, i) => (
          <li key={i} className={'ca-item is-' + a.action}>
            <span className="ca-dot" aria-hidden="true">{a.action === 'approved' ? '✓' : a.action === 'declined' ? '✕' : '✎'}</span>
            <div className="ca-body">
              <div className="ca-head"><strong>{tr(SAID[a.action])}</strong><span className="dk-muted tl-small">{a.name ? a.name + ' · ' : ''}{fmtDate(a.at)} {new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
              {a.note && <p className="ca-note">“{a.note}”</p>}
              {a.signature && <SignatureView strokes={a.signature} className="ca-sig" />}
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}
