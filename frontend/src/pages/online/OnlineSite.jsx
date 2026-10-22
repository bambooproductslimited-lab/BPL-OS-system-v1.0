import { useEffect, useState } from 'react';
import OnlineShop from './OnlineShop';
import OnlineTrack from './OnlineTrack';
import TableShop from './TableShop';
import OnlineReceipt from './OnlineReceipt';

// online.starbartema.com: the restaurant's menu to order from, an order
// followed at /t/<its link> (?t= also works, for testing), and a table's
// own menu at /q/<its code> — the QR code on the table (?q=), and a till
// sale's receipt at /receipt/<its link> (?receipt=). Which
// restaurant: ?r=<code> (Bamboo Garden: ?r=BGN), else the one it was built
// for (VITE_ONLINE_COMPANY, tools/build-site.mjs).
const HOME_CODE = import.meta.env.VITE_ONLINE_COMPANY || 'SBR';
function route() {
  const q = new URLSearchParams(window.location.search);
  const m = window.location.pathname.match(/\/t\/([A-Za-z0-9_-]{16,})/);
  const t = window.location.pathname.match(/\/q\/([A-Za-z0-9_-]{8,40})/);
  const rc = window.location.pathname.match(/\/receipt\/([A-Za-z0-9_-]{16,64})/);
  return { track: m ? m[1] : q.get('t'), table: t ? t[1] : q.get('q'), receipt: rc ? rc[1] : q.get('receipt'), code: q.get('r') || HOME_CODE };
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
  if (r.receipt) return <OnlineReceipt token={r.receipt} />;
  if (r.table) return <TableShop code={r.table} />;
  return r.track
    ? <OnlineTrack token={r.track} onMenu={(code) => go(menuOf(code))} />
    : <OnlineShop key={r.code} code={r.code} onTrack={(token) => go(ON_PAGE ? window.location.pathname + '?r=' + r.code + '&t=' + token : '/t/' + token)} />;
}
