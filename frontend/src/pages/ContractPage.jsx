import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { API_URL } from '../api/client';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import DeviceLanguage from '../components/DeviceLanguage';
import SignaturePad, { SignatureView } from '../components/SignaturePad';
import ContractText from '../components/ContractText';
import './ShopPage.css';
import './ContractPage.css';

// A contract sent to a customer, at /c/<its link> (backend
// contracts.service.js): public, outside the OS's frame, on Bamboo
// Products' customer website. Its words as a sheet of paper; then signing
// it — the full name, a signature drawn with a finger or the mouse, and a
// box ticked to agree — or declining it with a reason. Signed, it shows
// both names and the signature, ready to print or save as a PDF.

async function call(method, path, body) {
  const r = await fetch(API_URL + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || tr('Something went wrong. Please try again.'));
  return j;
}
function longDate(d) { return new Date(d).toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'long', year: 'numeric' }); }

export default function ContractPage() {
  const { token } = useParams();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [name, setName] = useState('');
  const [strokes, setStrokes] = useState([]);
  const [agree, setAgree] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState(null);
  useEffect(() => { call('GET', '/c/' + encodeURIComponent(token)).then((r) => { setD(r); document.title = r.contractNo + ' · ' + r.title; }).catch((e) => setError(e.message)); }, [token]);

  async function sign(e) {
    e.preventDefault();
    setBusy(true); setSendError(null);
    try { setD(await call('POST', '/c/' + encodeURIComponent(token) + '/sign', { name, signature: strokes, agree })); window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (err) { setSendError(err.message); } finally { setBusy(false); }
  }
  async function decline(e) {
    e.preventDefault();
    setBusy(true); setSendError(null);
    try { setD(await call('POST', '/c/' + encodeURIComponent(token) + '/decline', { note })); } catch (err) { setSendError(err.message); } finally { setBusy(false); }
  }

  if (error) return <div className="shp shp-mid csg"><img src="/logo.png" alt="Bamboo Products Limited" className="shp-logo" /><h1>{tr('We cannot find that contract')}</h1><p>{error}</p></div>;
  if (!d) return <div className="shp shp-mid csg"><span className="shp-spin" aria-hidden="true">📜</span><p>{tr('Loading…')}</p></div>;
  const signed = d.status === 'signed';
  return (
    <div className="shp csg">
      <div className="csg-bar">
        <img src="/logo.png" alt="" className="shp-logo" />
        <span className="csg-bar-t"><strong>{d.contractNo}</strong><small>{d.company}</small></span>
        <DeviceLanguage className="shp-lang csg-lang" />
        <button type="button" className="shp-go is-ghost csg-print" onClick={() => window.print()}>🖨️ {tr('Print')}</button>
      </div>

      {signed && (
        <div className="csg-banner is-signed" role="status">
          <span aria-hidden="true">✅</span>
          <span><strong>{tr('Signed by {name} on {date}', { name: d.signerName, date: longDate(d.signedAt) })}</strong><small>{tr('A copy is kept by Bamboo Products. Print it or save it as a PDF for your records.')}</small></span>
        </div>
      )}
      {d.status === 'declined' && (
        <div className="csg-banner is-declined" role="status"><span aria-hidden="true">✋</span><span><strong>{tr('You declined this contract')}</strong><small>“{d.declineNote}” — {tr('we will be in touch.')}</small></span></div>
      )}
      {d.status === 'void' && (
        <div className="csg-banner is-void" role="status"><span aria-hidden="true">🗂️</span><span><strong>{tr('This contract has been withdrawn')}</strong><small>{tr('Ask us for the current one.')}</small></span></div>
      )}

      <article className="csg-paper">
        <div className="csg-paper-head">
          <span>{d.contractNo}</span>
          {d.quotationNo && <span>{tr('Quotation {no}', { no: d.quotationNo })}</span>}
          <span>{d.customerName}</span>
        </div>
        <ContractText body={d.body} className="csg-text" />
        <div className="csg-sigs">
          <div className="csg-sig">
            <small>{tr('For {company}', { company: d.company })}</small>
            <span className="csg-sig-line is-typed">{d.counterName || '—'}</span>
          </div>
          <div className="csg-sig">
            <small>{tr('For the client')}</small>
            {signed ? <><SignatureView strokes={d.signature} className="csg-sig-draw" /><span className="csg-sig-line">{d.signerName} · {longDate(d.signedAt)}</span></> : <span className="csg-sig-line is-empty">{tr('Not signed yet')}</span>}
          </div>
        </div>
      </article>

      {d.status === 'sent' && !declining && (
        <form className="csg-form" onSubmit={sign}>
          <h2>✍️ {tr('Sign the contract')}</h2>
          <label className="shp-field"><span>{tr('Your full name')}</span><input className="input" required maxLength={120} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <div className="csg-pad-head"><span>{tr('Sign here')}</span><button type="button" className="shp-link" onClick={() => setStrokes([])} disabled={!strokes.length}>{tr('Clear')}</button></div>
          <SignaturePad strokes={strokes} onChange={setStrokes} label={tr('Sign here')} />
          <label className="csg-agree"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>{tr('I have read this contract and agree to it, on behalf of {name}.', { name: d.customerName })}</span></label>
          {sendError && <div className="error-banner" role="alert">{sendError}</div>}
          <button type="submit" className="shp-go is-big" disabled={busy || !agree || !strokes.length || name.trim().length < 2}>{busy ? tr('One moment…') : '✍️ ' + tr('Sign')}</button>
          <button type="button" className="shp-link csg-no" onClick={() => { setDeclining(true); setSendError(null); }}>{tr('I do not agree: decline it')}</button>
        </form>
      )}
      {d.status === 'sent' && declining && (
        <form className="csg-form" onSubmit={decline}>
          <h2>✋ {tr('Decline the contract')}</h2>
          <label className="shp-field"><span>{tr('What would you like changed?')}</span><textarea className="input" rows={3} required maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
          {sendError && <div className="error-banner" role="alert">{sendError}</div>}
          <button type="submit" className="shp-go is-big csg-decline" disabled={busy || note.trim().length < 3}>{busy ? tr('One moment…') : tr('Decline')}</button>
          <button type="button" className="shp-link csg-no" onClick={() => setDeclining(false)}>{tr('Back to signing')}</button>
        </form>
      )}
      <footer className="shp-foot">Bamboo Products Limited · {tr('Made in Ghana from bamboo')} 🎋</footer>
    </div>
  );
}
