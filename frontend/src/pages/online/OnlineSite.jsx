import { useEffect, useState } from 'react';
import OnlineShop from './OnlineShop';
import OnlineTrack from './OnlineTrack';
import TableShop from './TableShop';
import OnlineReceipt from './OnlineReceipt';
import { BookingPage } from './BookSheet';
import GiftPage from './GiftPage';
import { PaidPage, UnsubscribePage } from './GuestPages';
import { loadAccount } from './onlineShared';

// online.starbartema.com: the restaurant's menu to order from, an order
// followed at /t/<its link> (?t= also works, for testing), and a table's
// own menu at /q/<its code> — the QR code on the table (?q=), and a till
// sale's receipt at /receipt/<its link> (?receipt=), a booking at
// /b/<its link> (?b=), a gift card at /g/<its link> (?g=), the stop link of
// a text or email at /u/<its link> (?u=) and the page after paying the
// till's QR code at /paid. Which
// restaurant: ?r=<code> (Bamboo Garden: ?r=BGN), else the one it was built
// for (VITE_ONLINE_COMPANY, tools/build-site.mjs).
const HOME_CODE = import.meta.env.VITE_ONLINE_COMPANY || 'SBR';
function route() {
  const q = new URLSearchParams(window.location.search);
  const m = window.location.pathname.match(/\/t\/([A-Za-z0-9_-]{16,})/);
  const t = window.location.pathname.match(/\/q\/([A-Za-z0-9_-]{8,40})/);
  const rc = window.location.pathname.match(/\/receipt\/([A-Za-z0-9_-]{16,64})/);
  const bk = window.location.pathname.match(/\/b\/([A-Za-z0-9_-]{16,64})/);
  const g = window.location.pathname.match(/\/g\/([A-Za-z0-9_-]{16,64})/);
  const u = window.location.pathname.match(/\/u\/([A-Za-z0-9_-]{8,40})/);
  return { unsubscribe: u ? u[1] : q.get('u'), paid: /\/paid\/?$/.test(window.location.pathname) || q.has('paid'), track: m ? m[1] : q.get('t'), table: t ? t[1] : q.get('q'), receipt: rc ? rc[1] : q.get('receipt'), booking: bk ? bk[1] : q.get('b'), gift: g ? g[1] : q.get('g'),
    mine: q.get('mine'), code: q.get('r') || HOME_CODE };
}
// On the site's own address the paths are / and /t/<link>; opened as a
// page of the development server, the same by query.
const ON_PAGE = window.location.pathname.endsWith('-site.html');

export default function OnlineSite() {
  const [r, setR] = useState(route);
  useEffect(() => { const on = () => setR(route()); window.addEventListener('popstate', on); return () => window.removeEventListener('popstate', on); }, []);
  function go(path) { window.history.pushState({}, '', path); setR(route()); window.scrollTo(0, 0); }
  // Back to the menu of the restaurant the order was from.
  const menuOf = (code) => {
    const c = code || r.code;
    return ON_PAGE ? window.location.pathname + '?r=' + c : c === HOME_CODE ? '/' : '/?r=' + encodeURIComponent(c);
  };
  if (r.unsubscribe) return <UnsubscribePage token={r.unsubscribe} />;
  if (r.paid) return <PaidPage />;
  if (r.receipt) return <OnlineReceipt token={r.receipt} />;
  if (r.gift) return <GiftPage token={r.gift} />;
  if (r.booking) return <BookingPage token={r.booking} onMenu={(code) => go(menuOf(code))} />;
  if (r.table) return <TableShop code={r.table} />;
  // An order of the signed-in customer's own (their account, on any phone).
  const acct = loadAccount();
  if (r.mine && acct) return <OnlineTrack mineId={r.mine} auth={acct.token} onMenu={(code) => go(menuOf(code))} />;
  return r.track
    ? <OnlineTrack token={r.track} onMenu={(code) => go(menuOf(code))} />
    : <OnlineShop key={r.code} code={r.code} onTrack={(token) => go(ON_PAGE ? window.location.pathname + '?r=' + r.code + '&t=' + token : '/t/' + token)}
      onBooking={(token) => go(ON_PAGE ? window.location.pathname + '?r=' + r.code + '&b=' + token : '/b/' + token)}
      onTrackMine={(o) => go((ON_PAGE ? window.location.pathname : '/') + '?r=' + o.restaurant.code + '&mine=' + o.id)} />;
}
