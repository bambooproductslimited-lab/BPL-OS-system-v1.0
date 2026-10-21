import { useEffect, useState } from 'react';
import OnlineShop from './OnlineShop';
import OnlineTrack from './OnlineTrack';

// online.starbartema.com: the restaurant's menu to order from, and an
// order followed at /t/<its link> (?t= also works, for testing). Which
// restaurant: VITE_ONLINE_COMPANY when built (tools/build-site.mjs), or
// ?r=<code>.
function route() {
  const m = window.location.pathname.match(/\/t\/([A-Za-z0-9_-]{16,})/);
  return { track: m ? m[1] : new URLSearchParams(window.location.search).get('t') };
}
const CODE = new URLSearchParams(window.location.search).get('r') || import.meta.env.VITE_ONLINE_COMPANY || 'SBR';
// On the site's own address the paths are / and /t/<link>; opened as a
// page of the development server, the same by query.
const ON_PAGE = window.location.pathname.endsWith('-site.html');

export default function OnlineSite() {
  const [r, setR] = useState(route);
  useEffect(() => { const on = () => setR(route()); window.addEventListener('popstate', on); return () => window.removeEventListener('popstate', on); }, []);
  function go(path) { window.history.pushState({}, '', path); setR(route()); window.scrollTo(0, 0); }
  const menuPath = ON_PAGE ? window.location.pathname + '?r=' + CODE : '/';
  return r.track
    ? <OnlineTrack token={r.track} code={CODE} onMenu={() => go(menuPath)} />
    : <OnlineShop code={CODE} onTrack={(token) => go(ON_PAGE ? window.location.pathname + '?r=' + CODE + '&t=' + token : '/t/' + token)} />;
}
