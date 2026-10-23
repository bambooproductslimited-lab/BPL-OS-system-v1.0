import { useEffect, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { restaurantLogoUrl } from '../../lib/restaurantLogos';
import { tr } from '../../lib/i18n.jsx';
import { applyTheme, getInitialTheme } from '../../lib/theme';
import DeviceLanguage from '../../components/DeviceLanguage';

// Two small pages of the website (OnlineSite.jsx):
// - /u/<link>: the link at the end of every text or email from the
//   restaurant (backend restaurantCampaigns unsubscribe): one tap, and no
//   more messages; nothing else about the guest is shown;
// - /paid: where Paystack sends a customer back after paying the till's QR
//   code on their phone (backend restaurantPaystack): a thank-you, the till
//   moves on by itself.

function Shell({ restaurant, children }) {
  const logo = restaurant ? restaurantLogoUrl(restaurant.code) : null;
  return (
    <div className="on-shell on-track on-small-page">
      <header className="on-track-top">
        {logo ? <img src={logo} alt="" /> : <span aria-hidden="true">🍽️</span>}
        <div><strong>{restaurant ? restaurant.name : ''}</strong></div>
        <DeviceLanguage className="on-lang" />
      </header>
      <div className="on-small-card">{children}</div>
    </div>
  );
}

export function UnsubscribePage({ token }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { applyTheme(getInitialTheme()); }, []);
  useEffect(() => { posFetch('GET', '/pos/online/unsubscribe/' + encodeURIComponent(token)).then(setD).catch((e) => setError(e.message)); }, [token]);
  async function stop() {
    setBusy(true);
    try { setD(await posFetch('POST', '/pos/online/unsubscribe/' + encodeURIComponent(token))); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  if (!d) return <div className="on-shell is-empty"><div className="on-empty"><span className="on-spin" aria-hidden="true">✉️</span><strong>{error ? tr('This link does not work') : tr('One moment…')}</strong>{error && <p>{error}</p>}</div></div>;
  return (
    <Shell restaurant={d.restaurant}>
      {d.stopped ? (
        <>
          <span className="on-small-ico" aria-hidden="true">✅</span>
          <h1>{tr('Done: no more messages')}</h1>
          <p>{tr('{restaurant} will not send you texts or emails any more. Changed your mind? Tell us at the till next time.', { restaurant: d.restaurant.name })}</p>
        </>
      ) : (
        <>
          <span className="on-small-ico" aria-hidden="true">✉️</span>
          <h1>{d.name ? tr('Hi {name}', { name: d.name }) : tr('Hello')}</h1>
          <p>{tr('Stop the texts and emails from {restaurant}? Receipts and "your food is ready" texts still come when you ask for them.', { restaurant: d.restaurant.name })}</p>
          <button type="button" className="on-go is-big" disabled={busy} onClick={stop}>{busy ? tr('One moment…') : tr('Stop the messages')}</button>
        </>
      )}
      {error && <p className="on-err">{error}</p>}
    </Shell>
  );
}

export function PaidPage() {
  useEffect(() => { applyTheme(getInitialTheme()); }, []);
  return (
    <Shell restaurant={null}>
      <span className="on-small-ico" aria-hidden="true">🎉</span>
      <h1>{tr('Thank you!')}</h1>
      <p>{tr('Your payment is on its way to the till. You can close this page.')}</p>
    </Shell>
  );
}
