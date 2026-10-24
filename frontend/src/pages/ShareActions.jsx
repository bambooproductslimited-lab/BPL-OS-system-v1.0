import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { money } from '../lib/currency';
import { docTr, DOCUMENT_INTL_LOCALE } from '../lib/i18n.jsx';
import SignaturePad, { SignatureView } from '../components/SignaturePad';
import './ShareActions.css';

// What the customer can do on the page behind a share link (SharePage.jsx):
// approve an estimate or a quotation and sign it, decline it, or ask for
// changes (backend documentAnswers.service.js); pay an invoice online by
// card or Mobile Money (invoicePay.service.js). In the document language,
// like the rest of the page.

const DOC_WORD = { quotation: docTr('quotation'), estimate: docTr('estimate'), invoice: docTr('invoice') };

function when(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(DOCUMENT_INTL_LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function AnswerPanel({ doc, token, onAnswered }) {
  const [mode, setMode] = useState(null);
  const [name, setName] = useState(doc.customer?.name || '');
  const [note, setNote] = useState('');
  const [strokes, setStrokes] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const a = doc.answer, st = doc.answerState;
  const word = DOC_WORD[doc.documentType];
  if (!st) return null;

  async function send(action) {
    setBusy(true); setError('');
    try {
      await api.post('/share/' + token + '/answer', { action, name, note, signature: action === 'approved' ? strokes : undefined });
      setMode(null); setNote('');
      onAnswered();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  if (a && a.action === 'approved') {
    // Invoiced at once for its deposit (backend documentAnswers invoiceOnApproval).
    const inv = doc.pay && doc.pay.invoice;
    return (
      <>
        <section className="sa-card sa-done sa-ok no-print">
          <div className="sa-badge" aria-hidden="true">✓</div>
          <div className="sa-body">
            <h2>{docTr('Approved — thank you!')}</h2>
            <p>{docTr('Signed by {name} on {date}. We will be in touch about the next steps.', { name: a.name, date: when(a.at) })}</p>
            <SignatureView strokes={a.signature} className="sa-sig" />
          </div>
        </section>
        {inv && (
          <section className={'sa-card sa-deposit no-print' + (inv.paid || inv.depositPaid ? ' is-paid' : '')}>
            <div className="sa-emoji" aria-hidden="true">{inv.paid || inv.depositPaid ? '🎉' : '💳'}</div>
            <div className="sa-body">
              {inv.paid ? <h2>{docTr('Invoice {no} is paid. Thank you!', { no: inv.invoiceNo })}</h2>
                : inv.depositPaid ? <h2>{docTr('Deposit received. Thank you!')}</h2>
                  : <h2>{inv.deposit ? docTr('Pay the deposit of {amount} now', { amount: money(inv.deposit, doc.currency) }) : docTr('Pay invoice {no} now', { no: inv.invoiceNo })}</h2>}
              <p className="sa-muted">{inv.paid ? docTr('Its receipt is on the invoice.') : inv.depositPaid ? docTr('The rest is on invoice {no}, to pay when it is due.', { no: inv.invoiceNo })
                : docTr('Invoice {no} is ready: pay by card or Mobile Money, and we start right away.', { no: inv.invoiceNo })}</p>
              <a className="sa-btn sa-btn-go" href={'/share/' + inv.token}>{inv.paid || inv.depositPaid ? '🧾 ' + docTr('See the invoice') : '💳 ' + docTr('Pay now')}</a>
            </div>
          </section>
        )}
      </>
    );
  }
  if (a && a.action === 'declined') {
    return (
      <section className="sa-card sa-done sa-no no-print">
        <div className="sa-badge" aria-hidden="true">✕</div>
        <div className="sa-body">
          <h2>{docTr('Declined')}</h2>
          <p>{docTr('You declined this {document} on {date}.', { document: word, date: when(a.at) })}{a.note ? ' “' + a.note + '”' : ''}</p>
          <p className="sa-muted">{docTr('Changed your mind? Ask us for a new copy.')}</p>
        </div>
      </section>
    );
  }
  if (!st.open) {
    return (
      <section className="sa-card sa-done sa-off no-print">
        <div className="sa-badge" aria-hidden="true">⏱</div>
        <div className="sa-body">
          <h2>{st.why === 'expired' ? docTr('This {document} has expired', { document: word }) : docTr('This {document} was withdrawn', { document: word })}</h2>
          <p className="sa-muted">{docTr('Ask us for a new one and we will send it right away.')}</p>
        </div>
      </section>
    );
  }

  const canSign = name.trim().length >= 2 && strokes.length > 0;
  return (
    <section className="sa-card sa-ask no-print">
      {!mode && (
        <>
          <div className="sa-head">
            <div className="sa-emoji" aria-hidden="true">🤝</div>
            <div>
              <h2>{docTr('Happy with this {document}?', { document: word })}</h2>
              <p className="sa-muted">{docTr('Approve it here and sign with your finger or mouse. It takes a few seconds.')}</p>
            </div>
          </div>
          {a && a.action === 'changes' && (
            <div className="sa-changes">
              <strong>{docTr('You asked for changes on {date}:', { date: when(a.at) })}</strong> “{a.note}”
              <div className="sa-muted">{docTr('We will send you a new copy — or approve this one as it is.')}</div>
            </div>
          )}
          <div className="sa-buttons">
            <button type="button" className="sa-btn sa-btn-go" onClick={() => setMode('approve')}>✍️ {docTr('Approve and sign')}</button>
            <button type="button" className="sa-btn sa-btn-soft" onClick={() => setMode('changes')}>✎ {docTr('Ask for changes')}</button>
            <button type="button" className="sa-btn sa-btn-ghost" onClick={() => setMode('decline')}>{docTr('Decline')}</button>
          </div>
        </>
      )}
      {mode === 'approve' && (
        <div className="sa-form">
          <h2>{docTr('Approve and sign')}</h2>
          <label className="sa-label">{docTr('Your full name')}
            <input className="sa-input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </label>
          <div className="sa-label">{docTr('Sign here')}</div>
          <SignaturePad strokes={strokes} onChange={setStrokes} label={docTr('Sign here')} />
          <div className="sa-row">
            <button type="button" className="sa-link" onClick={() => setStrokes([])} disabled={!strokes.length}>{docTr('Clear')}</button>
            <span className="sa-muted">{docTr('By signing you approve this {document} for {total} and its terms.', { document: word, total: money(doc.grandTotal, doc.currency) })}</span>
          </div>
          {error && <div className="sa-error">{error}</div>}
          <div className="sa-buttons">
            <button type="button" className="sa-btn sa-btn-go" disabled={!canSign || busy} onClick={() => send('approved')}>{busy ? docTr('Sending…') : docTr('Approve {document}', { document: word })}</button>
            <button type="button" className="sa-btn sa-btn-ghost" onClick={() => { setMode(null); setError(''); }}>{docTr('Back')}</button>
          </div>
        </div>
      )}
      {(mode === 'changes' || mode === 'decline') && (
        <div className="sa-form">
          <h2>{mode === 'changes' ? docTr('Ask for changes') : docTr('Decline this {document}', { document: word })}</h2>
          <label className="sa-label">{mode === 'changes' ? docTr('What would you like changed?') : docTr('Tell us why (optional)')}
            <textarea className="sa-input sa-text" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          {mode === 'decline' && (
            <label className="sa-label">{docTr('Your name')}
              <input className="sa-input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </label>
          )}
          {error && <div className="sa-error">{error}</div>}
          <div className="sa-buttons">
            {mode === 'changes'
              ? <button type="button" className="sa-btn sa-btn-go" disabled={note.trim().length < 3 || busy} onClick={() => send('changes')}>{busy ? docTr('Sending…') : docTr('Send')}</button>
              : <button type="button" className="sa-btn sa-btn-stop" disabled={busy} onClick={() => send('declined')}>{busy ? docTr('Sending…') : docTr('Decline')}</button>}
            <button type="button" className="sa-btn sa-btn-ghost" onClick={() => { setMode(null); setError(''); }}>{docTr('Back')}</button>
          </div>
        </div>
      )}
    </section>
  );
}

// Paystack sends the customer back to this page with ?reference=…
function returnedReference() {
  const q = new URLSearchParams(window.location.search);
  return q.get('reference') || q.get('trxref') || '';
}

export function PayPanel({ doc, token, onPaid }) {
  const p = doc.pay;
  const [pick, setPick] = useState(p && p.options.length ? p.options[0].kind : 'all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Read once: the address loses it below, and an effect may run twice.
  const [ref] = useState(returnedReference);
  const [check, setCheck] = useState(() => (ref ? { state: 'checking' } : null));
  const tries = useRef(0);

  useEffect(() => {
    if (!ref) return undefined;
    tries.current = 0;
    let stop = false, timer = null;
    async function look() {
      try {
        const r = await api.get('/share/' + token + '/pay/' + encodeURIComponent(ref));
        if (stop) return;
        if (r.status === 'success') { setCheck({ state: 'paid', amount: r.amount, currency: r.currency }); onPaid(); return; }
        if (r.status === 'failed' || r.status === 'abandoned') { setCheck({ state: 'failed' }); return; }
        tries.current += 1;
        if (tries.current >= 8) { setCheck({ state: 'waiting' }); return; }
        timer = setTimeout(look, 3500);
      } catch (e) { if (!stop) setCheck({ state: 'error', message: e.message }); }
    }
    look();
    // The reference stays out of the address once read: a reload, a bookmark
    // or a forward shows the invoice, not an old payment's state.
    window.history.replaceState(null, '', window.location.pathname);
    return () => { stop = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, ref]);

  if (!p) return null;
  const banner = check && (
    <div className={'sa-check sa-check-' + check.state} role="status">
      {check.state === 'checking' && <><span className="sa-spin" aria-hidden="true" /> {docTr('Checking your payment…')}</>}
      {check.state === 'paid' && <>🎉 {docTr('Payment of {amount} received — thank you! Your receipt is on its way.', { amount: money(check.amount, check.currency) })}</>}
      {check.state === 'failed' && <>{docTr('The payment did not go through. Nothing was taken — you can try again.')}</>}
      {check.state === 'waiting' && <>{docTr('Paystack has not confirmed your payment yet. This page will show it once it does — no need to pay again.')}</>}
      {check.state === 'error' && <>{check.message}</>}
    </div>
  );

  if (doc.balanceDue != null && doc.balanceDue <= 0.005 && doc.status !== 'void') {
    return (
      <>
        {banner}
        <section className="sa-card sa-done sa-ok no-print">
          <div className="sa-badge" aria-hidden="true">✓</div>
          <div className="sa-body"><h2>{docTr('Paid in full — thank you!')}</h2></div>
        </section>
      </>
    );
  }
  if (!p.on) return banner || null;

  const chosen = p.options.find((o) => o.kind === pick) || p.options[p.options.length - 1];
  async function pay() {
    setBusy(true); setError('');
    try {
      const r = await api.post('/share/' + token + '/pay', { pay: chosen.kind, back: window.location.origin });
      window.location.assign(r.url);
    } catch (e) { setError(e.message); setBusy(false); }
  }
  return (
    <>
      {banner}
      <section className="sa-card sa-pay no-print">
        <div className="sa-head">
          <div className="sa-emoji" aria-hidden="true">💳</div>
          <div>
            <h2>{docTr('Pay this invoice online')}</h2>
            <p className="sa-muted">{docTr('By card or Mobile Money, securely through Paystack.')}</p>
          </div>
        </div>
        {p.options.length > 1 && (
          <div className="sa-options" role="radiogroup" aria-label={docTr('How much to pay')}>
            {p.options.map((o) => (
              <button type="button" role="radio" aria-checked={pick === o.kind} key={o.kind} className={'sa-option' + (pick === o.kind ? ' on' : '')} onClick={() => setPick(o.kind)}>
                <span className="sa-option-label">{o.kind === 'all' ? docTr('The full balance') : (o.label && o.label !== 'Next payment' ? o.label : docTr('Next payment'))}</span>
                <span className="sa-option-amount">{money(o.amount, doc.currency)}</span>
                {o.dueDate && <span className="sa-muted">{docTr('Due {date}', { date: when(o.dueDate) })}</span>}
              </button>
            ))}
          </div>
        )}
        {error && <div className="sa-error">{error}</div>}
        <div className="sa-buttons">
          <button type="button" className="sa-btn sa-btn-go sa-btn-big" disabled={busy} onClick={pay}>
            {busy ? docTr('Opening Paystack…') : docTr('Pay {amount}', { amount: money(chosen.amount, doc.currency) })}
          </button>
          <span className="sa-methods" aria-hidden="true"><span>VISA</span><span>Mastercard</span><span>MoMo</span></span>
        </div>
        {(p.paidOnline || []).length > 0 && (
          <div className="sa-muted sa-paidlist">
            {p.paidOnline.map((x) => <div key={x.reference}>✓ {docTr('Paid online {amount} on {date}', { amount: money(x.amount, doc.currency), date: when(x.at) })}</div>)}
          </div>
        )}
      </section>
    </>
  );
}
