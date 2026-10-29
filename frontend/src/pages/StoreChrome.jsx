import DeviceLanguage from '../components/DeviceLanguage';
import { tr } from '../lib/i18n.jsx';
import './StoreChrome.css';

// The frame of Bamboo Products' customer website (online.bplghana.com,
// sites/bpl.jsx): a glassy bar along the top — the brand, the shop,
// booking a visit, My account, the language and the basket — and a footer
// with the shop's categories, where to find the showroom and how to pay.
// The same pages are on the OS at /shop, /book and /account, so the shop's
// own address is worked out from where we are.
function shopHome() {
  return typeof window !== 'undefined' && window.location.pathname.startsWith('/shop') ? '/shop' : '/';
}

export function StoreTop({ active, me, count, bump, onBasket }) {
  const home = shopHome();
  const first = me && me.name ? me.name.split(' ')[0] : null;
  return (
    <nav className="stc-top" aria-label={tr('Bamboo Products')}>
      <a className="stc-brand" href={home}>
        <img src="/logo.png" alt="" />
        <span><b>Bamboo Products</b><small>{tr('Made in Ghana from bamboo')}</small></span>
      </a>
      <div className="stc-links">
        <a href={home} className={active === 'shop' ? 'is-on' : ''} aria-current={active === 'shop' ? 'page' : undefined}><span aria-hidden="true">🛍️</span><em>{tr('Shop')}</em></a>
        <a href="/book" className={active === 'book' ? 'is-on' : ''} aria-current={active === 'book' ? 'page' : undefined}><span aria-hidden="true">📅</span><em>{tr('Book a visit')}</em></a>
        <a href="/account" className={active === 'account' ? 'is-on' : ''} aria-current={active === 'account' ? 'page' : undefined}><span aria-hidden="true">👤</span><em>{first || tr('My account')}</em></a>
      </div>
      <DeviceLanguage className="stc-lang" />
      {onBasket && (
        <button type="button" className={'stc-cart' + (count ? ' has-items' : '')} key={bump} onClick={onBasket} aria-label={tr('Your basket') + (count ? ' (' + count + ')' : '')}>
          <span aria-hidden="true">🧺</span>{count > 0 && <b>{count}</b>}
        </button>
      )}
    </nav>
  );
}

export function StoreFoot({ shop, categories, onCategory }) {
  const home = shopHome();
  const year = new Date().getFullYear();
  return (
    <footer className="stc-foot">
      <div className={'stc-foot-in' + (categories && categories.length ? '' : ' is-short')}>
        <div className="stc-foot-brand">
          <img src="/logo.png" alt="" />
          <strong>Bamboo Products Limited</strong>
          <p>{tr('Furniture, blinds, garden pieces and lighting, made by hand in Accra from Ghanaian bamboo.')}</p>
          <span className="stc-pay">
            <i>📱 {tr('Mobile Money')}</i><i>💳 {tr('Card')}</i>{shop && shop.delivery && <i>🚚 {tr('Delivery')}</i>}
          </span>
        </div>
        {categories && categories.length > 0 && (
          <div className="stc-foot-col">
            <h4>{tr('Shop')}</h4>
            {categories.map((c) => (onCategory
              ? <button key={c} type="button" onClick={() => onCategory(c)}>{c}</button>
              : <a key={c} href={home}>{c}</a>))}
          </div>
        )}
        <div className="stc-foot-col">
          <h4>{tr('Visit us')}</h4>
          {shop && shop.pickupAddress && <span>🏬 {shop.pickupAddress}</span>}
          <a href="/book">📅 {tr('Book a consultation or a site measurement')}</a>
          {shop && shop.deliveryNote && <span>🚚 {shop.deliveryNote}</span>}
        </div>
        <div className="stc-foot-col">
          <h4>{tr('Help')}</h4>
          <a href="/account">👤 {tr('My account: orders and invoices')}</a>
          <a href="/jobs">🧑‍🔧 {tr('Work with us')}</a>
        </div>
      </div>
      <p className="stc-foot-line">© {year} Bamboo Products Limited · {tr('Made in Ghana from bamboo')} 🎋</p>
    </footer>
  );
}
