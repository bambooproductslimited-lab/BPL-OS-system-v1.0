import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { tr } from '../../lib/i18n.jsx';
import { ago } from './crmHubShared';
import { INTENT } from './chatIntent';
import './ChatReading.css';

// What a customer wants, read from their chats (backend
// crmInterests.service.js): on the lead's window and on the customer's
// profile. The OS reads the chats of those who wrote every hour; "Read the
// chat again" reads them now.

const TOPIC = {
  price: () => tr('Price'), delivery: () => tr('Delivery'), custom: () => tr('Size or design'), availability: () => tr('Availability'),
  payment: () => tr('Paying'), bulk: () => tr('Bulk order'), quality: () => tr('Quality and care'), other: () => tr('Other')
};

export default function ChatReading({ customerId, canManage }) {
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const load = useCallback(() => api.get('/crm/interests/' + customerId).then(setD).catch((e) => setErr(e.message)), [customerId]);
  useEffect(() => { setD(null); setErr(null); if (customerId) load(); }, [customerId, load]);
  async function readAgain() {
    setBusy(true); setErr(null);
    try { const x = await api.post('/crm/interests/' + customerId + '/read', {}); setD((was) => ({ ...(was || {}), ...x, conversations: (was && was.conversations) || 1 })); } catch (e) { setErr(e.message); }
    setBusy(false);
  }
  if (!customerId || !d) return err ? <p className="cr-err" role="alert">{err}</p> : null;
  const r = d.reading;
  if (!r && !d.conversations) return null;
  const hasAny = r && (r.summary || r.interests.length || r.questions.length || r.nextStep);
  const intent = r && INTENT[r.intent];
  return (
    <section className="crm-box cr" aria-labelledby={'cr-' + customerId}>
      <div className="cr-head">
        <h3 className="dk-h3" id={'cr-' + customerId}>💬 {tr('What they want, from their chats')}</h3>
        {intent && r.intent !== 'unclear' && <span className={'cr-intent is-' + intent.tone}>{intent.label()}</span>}
      </div>
      {!r && <p className="dk-muted tl-small">{tr('Their chats have not been read yet. The OS reads them within the hour.')}</p>}
      {r && r.summary && <p className="cr-summary">{r.summary}</p>}
      {r && r.interests.length > 0 && (
        <>
          <h4 className="cr-h4">{tr('Interested in')}</h4>
          <ul className="cr-items">
            {r.interests.map((x, i) => (
              <li key={i} className={x.productId ? 'is-ours' : ''}>
                <b>{x.productName || x.item}</b>
                {x.quantity && <span className="cr-qty">× {x.quantity}</span>}
                {x.productId ? <span className="cr-cat" title={tr('One of our catalogue items')}>{tr('in the catalogue')}</span> : null}
                {(x.details || (x.productName && x.item && x.item.toLowerCase() !== x.productName.toLowerCase())) && (
                  <small>{[x.productName && x.item.toLowerCase() !== x.productName.toLowerCase() ? '“' + x.item + '”' : '', x.details].filter(Boolean).join(' · ')}</small>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {r && r.questions.length > 0 && (
        <>
          <h4 className="cr-h4">{tr('They asked about')}</h4>
          <ul className="cr-qs">
            {r.questions.map((q, i) => <li key={i}><span className="cr-topic">{(TOPIC[q.topic] || TOPIC.other)()}</span><span>{q.text}</span></li>)}
          </ul>
        </>
      )}
      {r && r.nextStep && <p className="cr-next"><b>{tr('Next step')}</b> {r.nextStep}</p>}
      {r && !hasAny && !r.error && <p className="dk-muted tl-small">{tr('Nothing about products or prices in their chats yet.')}</p>}
      {r && r.error && <p className="cr-err" role="alert">{tr('The last reading did not work: {why}', { why: r.error })}</p>}
      {err && <p className="cr-err" role="alert">{err}</p>}
      <div className="cr-foot">
        <span className="dk-muted tl-small">
          {r && r.analysedAt && !r.error ? [
            r.messagesRead === 1 ? tr('Read from 1 message') : tr('Read from {n} messages', { n: r.messagesRead }),
            ago(r.analysedAt),
            r.source === 'ai' ? tr('by AI') : tr('by catalogue words (no AI key on the server)')
          ].join(' · ') : ''}
          {r && r.stale ? <b className="cr-stale"> · {tr('they wrote since')}</b> : null}
        </span>
        {canManage && d.conversations !== 0 && (
          <button type="button" className="btn btn-secondary cr-again" disabled={busy} onClick={readAgain}>{busy ? tr('Reading…') : r ? tr('Read the chat again') : tr('Read the chat now')}</button>
        )}
      </div>
    </section>
  );
}
