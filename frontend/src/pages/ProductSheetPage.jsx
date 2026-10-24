import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { API_URL } from '../api/client';
import { docTr, DOCUMENT_INTL_LOCALE } from '../lib/i18n.jsx';
import './ProductSheetPage.css';

// The page behind the link a rep sends a customer on WhatsApp (backend
// crmProductSheets.service.js; the rep's side is crm/SendProducts.jsx):
// public, no sign-in, outside the OS's frame. The products with their
// photos, what each is and the price, the rep's note, and a button to
// reply to the rep on WhatsApp. Like the shared documents (SharePage.jsx),
// it is in the company's document language: the customer never chose one.
// ?preview=1, from the rep's own screen, is not counted as the customer
// opening it.

function cedis(n, cur) {
  return (cur || 'GHS') + ' ' + Number(n || 0).toLocaleString(DOCUMENT_INTL_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function WaGlyph() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20l1.2-4.1A8 8 0 1 1 8.3 19z" /><path d="M9 8.6c0 3.3 3 6.4 6.4 6.4l1-1.6-2-1-1 .9a4.4 4.4 0 0 1-2.7-2.7l.9-1-1-2z" /></svg>;
}

export default function ProductSheetPage() {
  const { token } = useParams();
  const [sheet, setSheet] = useState(null);
  const [error, setError] = useState(null);
  const [big, setBig] = useState(null);

  useEffect(() => {
    const preview = new URLSearchParams(window.location.search).get('preview') === '1';
    fetch(API_URL + '/public/products/' + encodeURIComponent(token) + (preview ? '?preview=1' : ''))
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((j.error && j.error.message) || docTr('This link could not be opened.'));
        return j;
      })
      .then(setSheet)
      .catch((e) => setError(e.message));
  }, [token]);
  useEffect(() => { document.title = docTr('Products from Bamboo Products Limited'); }, []);

  if (error) {
    return (
      <div className="ps ps-mid">
        <img src="/logo.png" alt="Bamboo Products Limited" className="ps-logo" />
        <h1>{docTr('This link has expired')}</h1>
        <p>{error}</p>
      </div>
    );
  }
  if (!sheet) return <div className="ps ps-mid"><span className="ps-spin" aria-hidden="true">🎋</span><p>{docTr('Loading…')}</p></div>;

  const reply = sheet.rep.whatsapp ? 'https://wa.me/' + sheet.rep.whatsapp + '?text=' + encodeURIComponent(docTr('Hello {name}, about the products you sent:', { name: sheet.rep.name.split(' ')[0] }) + ' ') : null;
  const sentOn = new Date(sheet.sentAt).toLocaleDateString(DOCUMENT_INTL_LOCALE, { day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <div className="ps">
      <header className="ps-top">
        <img src="/logo.png" alt="" className="ps-logo" />
        <div>
          <b>Bamboo Products Limited</b>
          <small>{docTr('Handmade bamboo furniture and building, Ghana')}</small>
        </div>
      </header>

      <section className="ps-hello">
        <span className="ps-wave" aria-hidden="true">👋</span>
        <h1>{sheet.to ? docTr('Hello {name}!', { name: sheet.to }) : docTr('Hello!')}</h1>
        <p>{sheet.items.length === 1 ? docTr('Here is the product {rep} picked for you.', { rep: sheet.rep.name || docTr('our team') }) : docTr('Here are the {n} products {rep} picked for you.', { n: sheet.items.length, rep: sheet.rep.name || docTr('our team') })}</p>
        {sheet.note && <blockquote className="ps-note">{sheet.note}</blockquote>}
      </section>

      <main className="ps-list">
        {sheet.items.map((it, i) => (
          <article key={i} className="ps-card" style={{ '--i': i }}>
            <button type="button" className="ps-photo" onClick={() => it.photo && setBig(it)} disabled={!it.photo} aria-label={it.photo ? docTr('See the photo bigger') : undefined}>
              {it.photo ? <img src={API_URL + it.photo} alt={it.name} loading="lazy" /> : <span aria-hidden="true">🎋</span>}
            </button>
            <div className="ps-info">
              <h2>{it.name}</h2>
              {it.description && <p>{it.description}</p>}
              <div className="ps-price">
                <b>{cedis(it.price, sheet.currency)}</b>
                {it.unit && it.unit !== 'each' && <small> / {it.unit}</small>}
                {it.qty > 1 && <span className="ps-qty">× {it.qty} = {cedis(it.price * it.qty, sheet.currency)}</span>}
              </div>
            </div>
          </article>
        ))}
      </main>

      {sheet.items.length > 1 && (
        <div className="ps-total"><span>{docTr('Total')}</span><b>{cedis(sheet.total, sheet.currency)}</b></div>
      )}

      <footer className="ps-foot">
        {reply && <a className="ps-reply" href={reply} target="_blank" rel="noopener noreferrer"><WaGlyph /> {docTr('Reply to {name} on WhatsApp', { name: sheet.rep.name.split(' ')[0] })}</a>}
        <p>{docTr('Sent on {date}. Prices are in Ghana cedis and may change; ask us for a quotation.', { date: sentOn })}</p>
      </footer>

      {big && (
        <div className="ps-big" role="dialog" aria-modal="true" aria-label={big.name} onClick={() => setBig(null)}>
          <img src={API_URL + big.photo} alt={big.name} />
          <span>{big.name} · {cedis(big.price, sheet.currency)}</span>
        </div>
      )}
    </div>
  );
}
