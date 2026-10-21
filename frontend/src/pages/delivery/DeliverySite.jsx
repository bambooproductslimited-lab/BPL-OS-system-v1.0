import DeliveryApp from './DeliveryApp';
import RiderPage from './RiderPage';

// delivery.starbartema.com: the delivery screen (a staff PIN), and a
// rider's page at /r/<their link> (?r= also works, for testing).
function riderToken() {
  const m = window.location.pathname.match(/\/r\/([A-Za-z0-9_-]{16,})/);
  return m ? m[1] : new URLSearchParams(window.location.search).get('r');
}
export default function DeliverySite() {
  const t = riderToken();
  return t ? <RiderPage token={t} /> : <DeliveryApp />;
}
