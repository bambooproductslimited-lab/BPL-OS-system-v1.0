import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_ORIGIN } from '../api/client';
import { posFetch } from '../lib/posApi';
import { DELIVERY_URL, KDS_URL, SITE } from '../lib/site';
import { money } from '../lib/currency';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { restaurantLogoUrl } from '../lib/restaurantLogos';
import {
  buildReceiptBytes, buildDrawerReportBytes, buildKitchenChitBytes, reconnectUsbPrinter, reconnectBluetoothPrinter, reconnectSystemPrinter,
  reconnectPassPrnt, readPassPrntReply, kitchenSetup, saveKitchenSetup, kitchenPrinterFor
} from '../lib/thermalPrinter';
import PrinterPanel from '../components/PrinterPanel';
import { activeIntlLocale, activeLocale, tr } from '../lib/i18n.jsx';
import { Icon, Status } from '../components/DashKit';
import DeviceLanguage from '../components/DeviceLanguage';
import { IouDialog, RefundDialog, VipDialog } from './TillMoney';
import TillSettings from './TillSettings';
import PayDialog from './till/PayDialog';
import HandInDialog from './till/HandInDialog';
import MoreMenu from './till/MoreMenu';
import { OnToday, MyShifts } from './till/Rota';
import TimeClock from './till/TimeClock';
import { WasteDialog } from './till/Waste';
import { BrokenDialog } from './till/Fifteenth';
import TeamNotes from './till/TeamNotes';
import PrepDialog from './till/Prep';
import { ChecklistsDialog } from './till/Checklists';
import { IncomingDialog } from './till/Transfers';
import { PettyCashDialog, SafeDropDialog } from './till/CashOffice';
import { EventsDialog } from './till/Events';
import { pettyOf } from './till/cashShared';
import { TableMapPicker } from './till/TableMap';
import ManagerHome from './till/ManagerHome';
import AzRail, { azGroups, sectionId } from './till/AzRail';
import { CustomItemDialog, DeliveryDialog, DisputeDialog, NoteDialog, SendConfirmDialog } from './till/OrderDialogs';
import { AddOnsDialog, DiscountDialog } from './till/BillDialogs';
import PromoCodeDialog from './till/PromoCode';
import { CameraScan, LinkBarcode } from './till/Barcode';
import { dishByCode, useBarcodeWedge } from './till/barcodeScan';
import { billOf, contactOf, serviceWords, modsPrice, modsWords, paidAheadOf, paidAheadWords, withMarkup } from './till/tillBill';
import { ReceiptLines, ReceiptQr, SendReceipt } from './till/ReceiptParts';
import MoveBill from './till/MoveBill';
import { AllergyDialog, AllergyStrip, KitchenChits } from './till/ServiceParts';
import { allergenWords, categoryOpen, clashes, courseName, courseOf, happyFor, hoursOf } from './till/tillService';
import { StockTab } from './till/MenuStock';
import PayInOutDialog from './till/PayInOutDialog';
import TableInbox from './till/TableInbox';
import TableBill from './till/TableBill';
import OfflineQueue from './till/OfflineQueue';
import Bookings from './till/Bookings';
import BusyMode, { BusyPill } from './till/BusyMode';
import Curbside, { CurbsidePill } from './till/Curbside';
import GiftCards from './till/GiftCards';
import CustomerScreen from './till/CustomerScreen';
import Rewards from './till/Rewards';
import Downloads from './till/Downloads';
import Kiosks from './till/Kiosks';
import ReadyBoards from './till/ReadyBoards';
import { AppBanner, AppPicker } from './till/AppOrder';
import GuestContactDialog, { ContactFields } from './till/GuestContact';
import { useCustomerDisplay } from './till/customerScreenLink';
import {
  OFFLINE_METHODS, cacheLoad, cacheSave, draftClear, draftLoad, draftSave, enqueue, fetchOrGiveUp, flush, isLocal, isNetworkError, newRef, onQueue, queueList,
  resolveIds, serverAnswers
} from './till/tillOffline';
import { playNewTicket } from '../kiosk/kioskSounds';
import {
  FULFILLMENT, FulfillmentIcon, KitchenTag, fmt, fulfillmentName, lineBody, lineFromTab, lineKey, methodName, moveLabel, round2
} from './till/tillShared';
import { statusName } from './delivery/dlShared';
import './till/till.css';
import { applyTheme, clearTheme, getInitialTheme, saveTheme } from '../lib/theme';
import ThemeSwitch, { ThemeChoice } from '../components/ThemeSwitch';
import '../components/DashKit.css';
import './ToolRoomPage.css';
import './RestaurantPosPage.css';
import './till/calm.css';

// The send dialog brings the map with it: loaded when it is first opened.
const SendDialog = lazy(() => import('./delivery/DlDialogs').then((m) => ({ default: m.SendDialog })));

// Same "animate a live-data-driven number, not a CSS keyframe" hook as
// RestaurantsPage.jsx's — small enough, and specific enough to each page's
// own values, that a shared component isn't worth it yet.
function useCountUp(target, durationMs) {
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  const rafRef = useRef(null);
  useEffect(() => {
    const from = fromRef.current;
    const to = Number(target) || 0;
    if (from === to) return undefined;
    const start = performance.now();
    const duration = durationMs || 400;
    function tick(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (to - from) * eased);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = to;
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  return display;
}

// The restaurant POS's own till page — a full-screen, standalone page
// meant to be opened on a shared counter device (tablet/PC) at Star Bar
// Restaurant or Bamboo Garden, outside ProtectedRoute/AppShell in App.jsx
// just like /kiosk, since the till itself never logs into the main app as
// anyone. Whoever is working the counter enters their 4-digit kiosk PIN
// (the exact same one used to clock in/out — see restaurantPos.service.js)
// once per shift rather than per sale; the pin pad here reuses KioskPage's
// own CSS classes verbatim so the two "unattended device" experiences look
// like one consistent product, while the menu/cart/checkout below is its
// own layout.
//
// Session persistence: the till-session token restaurantPos.service.js
// issues is good for 12 hours, stored in localStorage so a page reload
// (or the tablet waking from sleep) doesn't force a re-login mid-shift —
// re-validated against /pos/menu on mount, and cleared if that comes back
// 401 (expired or the server restarted, which drops nothing server-side
// since the token is self-contained, but is still worth handling).
var SESSION_KEY = 'bamboo.pos.session';
// Kitchen tickets just handed to PassPRNT, to print again if they could not
// (on the device: PassPRNT may bring the till back in a new tab).
var KITCHEN_SENT_KEY = 'bamboo.kitchen.sent';
var PIN_LENGTH = 4;

// The real Square-imported menus (1,600+ items each) have no photos yet —
// uploading one is a per-item, opt-in action from the management page
// (RestaurantsPage.jsx), so most tiles fall back to a flat colour + initial
// rather than a generic placeholder icon; a small fixed palette keeps the
// grid visually varied without pulling in an image for every item.
var TILE_PALETTE = ['#2dd4bf', '#f59e0b', '#f472b6', '#818cf8', '#fb7185', '#34d399', '#60a5fa', '#facc15'];
function tileColor(seed) {
  var s = String(seed || '');
  var hash = 0;
  for (var i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return TILE_PALETTE[hash % TILE_PALETTE.length];
}
function tileInitial(name) {
  var trimmed = String(name || '').trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
}

// Small line drawings for the order's table / waiter / guest chips (DashKit
// has none for a table or a tray).
var WHO_GLYPH = {
  table: <><path d="M3 9h18M6 9v10M18 9v10M4.5 9 7 5h10l2.5 4" /></>,
  waiter: <><circle cx="12" cy="7" r="3" /><path d="M5 20c.6-3.6 3.2-6 7-6s6.4 2.4 7 6" /><path d="M15.5 14.5h5" /></>,
  guest: <><circle cx="12" cy="8" r="3.5" /><path d="M4.5 20c.8-4 3.8-6.5 7.5-6.5s6.7 2.5 7.5 6.5" /></>
};
function WhoGlyph({ name }) {
  return <svg className="pos-who-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{WHO_GLYPH[name]}</svg>;
}

const ROLE_NAME = { manager: () => tr('Manager'), cashier: () => tr('Cashier'), waiter: () => tr('Waiter'), kitchen: () => tr('Kitchen'), none: () => tr('No access') };

// What the till lets the person signed in do, until the server says
// (GET /pos/access); also what it falls back to if that cannot be asked.
const FALLBACK_ACCESS = {
  role: 'cashier',
  can: { till: true, charge: true, keepOpen: true, customItem: true, removeTable: true, refund: true, approveRefunds: false, vipTopUp: true, iou: true, iouPaid: true, favorites: true, kds: true },
  settings: {
    paymentMethods: ['cash', 'mobile_money', 'alipay', 'wechat', 'vip', 'iou'], currencies: { USD: { on: false, rate: 0 }, CNY: { on: false, rate: 0 } },
    receipt: { footer: 'Thank you!', extra: '', showLogo: true }, idleMinutes: 0, requireWaiter: false, defaultFulfillment: 'dine_in', kitchen: { warnAfter: 10, lateAfter: 20, printReady: false },
    discounts: [], serviceCharge: { on: false, rate: 0, types: {} }, tax: { included: true, list: [] },
    courses: { on: false, names: [], categories: {} }, hours: { categories: {} }, happyHours: []
  }
};
// promoCode: a deal's code given; promo, channel: the deal an open order kept, and where it came from (a website or kiosk order).
const NO_ADJUST = { discount: null, serviceOff: null, promoCode: null, promo: null, channel: null };

// One dish on the menu grid. A menu can run past a thousand dishes, so a
// tile only draws again when its own dish, count or tap changes, not every
// time anything on the order does; the photo is the server's small square
// (menu-photos ?size=thumb), decoded off the main thread.
// happy: the happy hour's percentage on it now; closedFrom: served only
// from then (its menu's hours); clash: it has what the order's allergy
// alert names.
const MenuTile = memo(function MenuTile({ m, qty, tapped, plusN, canFavorite, onTap, onFavorite, happy, closedFrom, clash }) {
  return (
    <button
      type="button"
      className={'pos-tile' + (qty ? ' is-picked' : '') + (tapped ? ' is-tapped' : '') + (m.stock && m.stock.soldOut ? ' is-out' : '') + (closedFrom ? ' is-closed' : '') + (clash ? ' is-clash' : '')}
      style={{ '--c': tileColor(m.name) }}
      onClick={() => onTap(m)}
    >
      <span className="pos-tile-pic" style={m.photoUrl ? undefined : { '--c': tileColor(m.name) }}>
        {m.photoUrl ? <img src={API_ORIGIN + m.photoUrl} alt="" width="52" height="52" loading="lazy" decoding="async" /> : <span>{tileInitial(m.name.replace(/^zq\s+/i, ''))}</span>}
      </span>
      <span className="pos-tile-text">
        <span className="pos-tile-name">{m.name}</span>
        <span className="pos-tile-price">{m.variations && m.variations.length ? tr('{n} prices', { n: m.variations.length }) : money(m.price)}</span>
      </span>
      {happy > 0 && !closedFrom && <span className="pos-tile-happy">🍹 −{happy}%</span>}
      {m.combo && !(happy > 0) && !closedFrom && <span className="pos-tile-combo">🍱 {tr('Combo')}</span>}
      {closedFrom && <span className="pos-tile-hours" title={tr('from {time}', { time: closedFrom })}>🕘 {closedFrom}</span>}
      {clash && <span className="pos-tile-clash" title={tr('Has what the guest is allergic to')}>⚠</span>}
      {canFavorite ? (
        <span
          role="button" tabIndex={0}
          className={'pos-tile-star' + (m.favorite ? ' is-on' : '')}
          onClick={(e) => onFavorite(e, m)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onFavorite(e, m); } }}
          aria-label={m.favorite ? tr('Remove from favorites') : tr('Add to favorites')}
          aria-pressed={m.favorite}
        >★</span>
      ) : m.favorite && <span className="pos-tile-star is-on is-fixed" aria-label={tr('Favourite')}>★</span>}
      {m.stock && (m.stock.low || m.stock.soldOut) && <span className={'pos-tile-stock' + (m.stock.soldOut ? ' is-out' : '')}>{m.stock.soldOut ? tr('Sold out') : tr('{n} left', { n: m.stock.left })}</span>}
      {!!qty && <span key={'q' + qty} className="pos-tile-qty">{qty}</span>}
      {plusN != null && <span key={'p' + plusN} className="pos-tile-plus" aria-hidden="true">+1</span>}
    </button>
  );
});

export default function RestaurantPosPage() {
  const [session, setSession] = useState(null); // { token, employeeName, companyId, companyName }
  const [sessionChecked, setSessionChecked] = useState(false);
  const [pin, setPin] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState(null);
  // The PIN screen as the time clock: clock in, a break, clock out (till/TimeClock).
  const [clockMode, setClockMode] = useState(false);

  const [menu, setMenu] = useState([]);
  const [menuLoading, setMenuLoading] = useState(false);
  const [menuError, setMenuError] = useState(null);
  const [search, setSearch] = useState('');

  // Quick-access tabs above the menu grid: the till always opens on what
  // sells most ("Mostly bought"), with every dish ("All items") last — or
  // on every dish while a new till has no sales to rank yet.
  const [viewTab, setViewTab] = useState('mostly'); // 'mostly' | 'favorites' | 'recent' | 'all'
  // Items tapped into the cart this shift, most-recent-first and deduped —
  // deliberately session-only (not persisted), unlike favorites: it's a
  // "what was I just doing" shortcut, not a lasting curation, so it
  // resets on logout along with the cart.
  const [recentIds, setRecentIds] = useState([]);
  const [mostlyBought, setMostlyBought] = useState([]);
  const [mostlyBoughtLoading, setMostlyBoughtLoading] = useState(false);

  const [cart, setCart] = useState([]); // [{ menuItemId, variationId, name, price, qty, note, custom }]
  // Dine in (at a table), pickup (at the counter) or delivery (who, a
  // phone and where), and the dialogs around an order (till/OrderDialogs.jsx).
  const [fulfillment, setFulfillment] = useState('dine_in');
  const [delivery, setDelivery] = useState({ name: '', phone: '', address: '' });
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [noteFor, setNoteFor] = useState(null); // the cart line whose note is being written
  const [customOpen, setCustomOpen] = useState(false);
  const [sendConfirm, setSendConfirm] = useState(false);
  const [sentLines, setSentLines] = useState([]); // an open order's lines as they went to the kitchen
  const [tappedId, setTappedId] = useState(null); // brief tap-feedback flash on the tile just added
  const [plus, setPlus] = useState(null); // { id, n } — the "+1" that floats off the tile just tapped

  // Variation picker — mirrors the real Square POS's own item-detail modal:
  // tapping an item that has named price variations (e.g. "M" ₵98 vs
  // "Jellyfish" ₵238) opens this instead of adding straight to the cart.
  const [variantPickerItem, setVariantPickerItem] = useState(null); // the menu tile being picked for, or null
  const [promoOpen, setPromoOpen] = useState(false); // typing a deal's promo code (till/PromoCode.jsx)
  const [scanOpen, setScanOpen] = useState(false); // the camera reading a barcode (till/Barcode.jsx)
  const [newCode, setNewCode] = useState(null); // a barcode no dish has yet, to give to one
  const [addOnsFor, setAddOnsFor] = useState(null); // { item, variation, line? }: a dish's add-ons being picked (till/BillDialogs.jsx)
  const [offFor, setOffFor] = useState(null); // 'bill' or a cart line: its discount being given
  const [moveFor, setMoveFor] = useState(null); // an open order being moved (till/MoveBill.jsx)
  const [billAdjust, setBillAdjust] = useState(NO_ADJUST); // the whole bill's discount, and the service charge taken off
  // The table's service (till/tillService.js): how many sat down, the seat
  // the next dishes are for, the order's allergy alert, and the kitchen's
  // tickets to print for stations without a screen.
  const [guests, setGuests] = useState(null);
  const [seat, setSeat] = useState(null);
  const [allergy, setAllergy] = useState(null);
  const [allergyOpen, setAllergyOpen] = useState(false);
  const [chits, setChits] = useState(null);

  // Table/waiter/guest — all optional, attached to the CURRENT in-progress
  // order only (like the cart itself: reset after each sale, never
  // persisted mid-shift). Cashier ≠ waiter: whoever's logged into the till
  // rings up the payment, but the person actually serving the table is
  // recorded separately (restaurantPos.service.js's createOrder), same
  // split Square's own POS makes.
  const [tables, setTables] = useState([]);
  const [waiters, setWaiters] = useState([]);
  const [selectedTable, setSelectedTable] = useState(null); // { id, name } | null
  const [selectedWaiter, setSelectedWaiter] = useState(null); // { id, name } | null
  const [selectedGuest, setSelectedGuest] = useState(null); // { id, name, phone } | null

  const [tablePickerOpen, setTablePickerOpen] = useState(false);
  const [waiterPickerOpen, setWaiterPickerOpen] = useState(false);
  const [guestPickerOpen, setGuestPickerOpen] = useState(false);
  const [guestSearch, setGuestSearch] = useState('');
  const [guestResults, setGuestResults] = useState([]);
  const [guestSearching, setGuestSearching] = useState(false);
  const [newGuestName, setNewGuestName] = useState('');
  const [newGuestPhone, setNewGuestPhone] = useState('');
  const [newGuestMore, setNewGuestMore] = useState(null); // email, birthday, yes or no to messages (till/GuestContact.jsx)
  const [contactFor, setContactFor] = useState(null); // the customer whose email and birthday are being kept
  const [addingGuest, setAddingGuest] = useState(false);
  const [guestError, setGuestError] = useState(null);

  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const [checkoutError, setCheckoutError] = useState(null);

  const [receipt, setReceipt] = useState(null);

  // Cash drawer session (per cashier — see restaurantPos.service.js's
  // buildReport). drawer is the current open session's live report (or
  // null); drawerChecked gates the till behind an "open your drawer"
  // prompt until we know one way or the other, same pattern as
  // sessionChecked above so there's no flash of the wrong screen.
  const [drawer, setDrawer] = useState(null);
  const [drawerChecked, setDrawerChecked] = useState(false);
  const [openingCash, setOpeningCash] = useState('');
  const [openingDrawer, setOpeningDrawer] = useState(false);
  const [openDrawerError, setOpenDrawerError] = useState(null);

  const [drawerPanelOpen, setDrawerPanelOpen] = useState(false);
  const [movementDirection, setMovementDirection] = useState(null); // Pay in / Pay out: 'in' | 'out' | null

  const [closeDrawerOpen, setCloseDrawerOpen] = useState(false);
  const [closeActualCash, setCloseActualCash] = useState('');
  const [closeNote, setCloseNote] = useState('');
  const [closingDrawer, setClosingDrawer] = useState(false);
  const [closeDrawerError, setCloseDrawerError] = useState(null);
  const [closedReport, setClosedReport] = useState(null); // set once closed — shows the printable report screen
  const [ordersOnly, setOrdersOnly] = useState(false); // taking orders with no drawer: another cashier is on duty, or a manager chose not now
  const [officeOpen, setOfficeOpen] = useState(false); // a manager's back office (till/ManagerHome.jsx)
  const [dutyNotice, setDutyNotice] = useState(true); // the "another cashier is on duty" popup, once per sign-in

  // Direct thermal-printer output (Phase 3) — set once per till device,
  // then reused for every sale's receipt for the rest of the shift (and
  // silently reconnected on reload, same as the till session itself).
  // Only ever a same-device convenience on top of the always-available
  // "Print receipt" browser-print button below — see thermalPrinter.js's
  // module comment for why WebUSB/WebBluetooth simply don't exist on an
  // iPad in any browser, so this stays optional rather than replacing it.
  const [printer, setPrinter] = useState(null); // { kind, name, write }
  const [printerError, setPrinterError] = useState(null);
  const [printerOpen, setPrinterOpen] = useState(false); // how this till prints (components/PrinterPanel.jsx)
  // Where kitchen tickets print (the till's printer or the kitchen's own),
  // the ones waiting to print that reached the kitchen without this till,
  // and the ones PassPRNT could not print, to print again.
  const [kitchenSet, setKitchenSet] = useState(() => kitchenSetup());
  const kitchenPrinter = useMemo(() => kitchenPrinterFor(printer, kitchenSet), [printer, kitchenSet]);
  const [toPrint, setToPrint] = useState([]);
  const [kitchenRetry, setKitchenRetry] = useState(null);
  const takingRef = useRef(false);
  const [printing, setPrinting] = useState(false);

  // The till follows the OS's light/dark choice on this device, with its
  // own switch in the top bar.
  const [theme, setTheme] = useState(getInitialTheme);
  const [now, setNow] = useState(() => new Date());
  // This cashier's shift so far and the open tables (orders kept to pay
  // later) — restaurantPos.service.js's shiftSummary / listTabs.
  const [shift, setShift] = useState(null);
  const [tabs, setTabs] = useState([]);
  const [tabsOpen, setTabsOpen] = useState(false);
  const [currentTab, setCurrentTab] = useState(null); // the open table being added to, or null
  const [keepDialog, setKeepDialog] = useState(null); // { label } while naming an order to keep open
  const [savingTab, setSavingTab] = useState(false);
  const [tabError, setTabError] = useState(null);
  const [category, setCategory] = useState(''); // '' = every category
  const [cartOpen, setCartOpen] = useState(false); // the order as a full-screen sheet on a phone
  const menuScrollRef = useRef(null); // the menu's scrolling list, for the A–Z bar
  const [toast, setToast] = useState(null);
  // The kitchen display (pages/KdsPage.jsx): what is ready to take out,
  // and a note sent with the order (restaurantKitchen.service.js).
  const [kitchen, setKitchen] = useState(null); // { inUse, cooking, ready: [...] }
  const [kitchenOpen, setKitchenOpen] = useState(false);
  // Bookings and the waitlist (what is booked soon, for the top bar and the
  // floor map), gift cards, the customer's screen, a customer's rewards.
  const [soon, setSoon] = useState(null);
  const [bookingsOpen, setBookingsOpen] = useState(false);
  const [giftOpen, setGiftOpen] = useState(false);
  const [screenOpen, setScreenOpen] = useState(false);
  const [rewardsOpen, setRewardsOpen] = useState(false);
  const [downloadsOpen, setDownloadsOpen] = useState(false); // till/Downloads.jsx: Square-format files
  const [kiosksOpen, setKiosksOpen] = useState(false); // till/Kiosks.jsx: pairing the self-order kiosk
  const [boardsOpen, setBoardsOpen] = useState(false); // till/ReadyBoards.jsx: pairing the ready-for-pickup board
  const [appOrder, setAppOrder] = useState(null); // a delivery app's order being rung up (till/AppOrder.jsx)
  const [appPickOpen, setAppPickOpen] = useState(false);
  const [payInfo, setPayInfo] = useState(null); // the bill being paid and its tip, for the customer's screen
  const [deliveryPrompt, setDeliveryPrompt] = useState(null); // a delivery's food ready to go out
  const [tableBox, setTableBox] = useState(null); // what the tables ask for from their QR codes
  const [tableBoxOpen, setTableBoxOpen] = useState(false);
  const [billOpen, setBillOpen] = useState(false); // a table's bill, with its QR code to pay from a phone
  const tableSeen = useRef(null);
  // Without the internet (till/tillOffline.js): the till keeps selling;
  // what it makes waits on this device (queued) until the server answers.
  const [offline, setOffline] = useState(false);
  const offlineRef = useRef(false);
  const [queued, setQueued] = useState(queueList);
  const [queueOpen, setQueueOpen] = useState(false);
  const coRef = useRef(null); // the restaurant signed in to, for what is kept on this device
  const [sendFor, setSendFor] = useState(null); // { target, riders, settings }: sending one out with a rider
  const prompted = useRef(new Set()); // tickets asked about already
  const [handIn, setHandIn] = useState(null); // an open delivery order: the money its rider brought back
  const askedMoney = useRef(new Set()); // deliveries whose money was asked about already
  const [kitchenNote, setKitchenNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [taxesOpen, setTaxesOpen] = useState(false); // the taxes in the prices, one line or each
  const [rotaToday, setRotaToday] = useState(null); // who works today (till/Rota.jsx)
  const [rotaOpen, setRotaOpen] = useState(false);
  // Busy mode for the website (till/BusyMode.jsx): on, its pill at the top.
  const [busyMode, setBusyMode] = useState(null);
  const [busyOpen, setBusyOpen] = useState(false);
  // Website customers outside for their pickup (till/Curbside.jsx).
  const [outside, setOutside] = useState([]);
  const [curbOpen, setCurbOpen] = useState(false);
  // Refunds, VIP money and IOUs (TillMoney.jsx)
  const [refundFor, setRefundFor] = useState(null); // 'find' | an order id | null
  const [vipOpen, setVipOpen] = useState(null); // { startGuest } | null
  const [iouOpen, setIouOpen] = useState(false);
  const [vipKey, setVipKey] = useState(0);
  // The person's role on the till and the till's settings (TillSettings.jsx)
  const [tillAccess, setTillAccess] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false); // true, or the tab to open at
  const [disputeFor, setDisputeFor] = useState(null); // a problem reported: { orderId?, tabId?, label, customerName }
  const [stockOpen, setStockOpen] = useState(false);
  const [wasteOpen, setWasteOpen] = useState(false);
  const [brokenOpen, setBrokenOpen] = useState(false);
  const [notes, setNotes] = useState(null); // notes for the team: { notes, unread, canWrite }
  const [notesOpen, setNotesOpen] = useState(false);
  // The kitchen's prep list, today's checklists, stock on its way here (migration 0194).
  const [prepOpen, setPrepOpen] = useState(false);
  const [checks, setChecks] = useState(null); // { lists, open }
  const [checksOpen, setChecksOpen] = useState(false);
  const [incoming, setIncoming] = useState(null); // { waiting, can }
  const [incomingOpen, setIncomingOpen] = useState(false);
  // The cash office and the week's events (migration 0195).
  const [cashOpen, setCashOpen] = useState(null); // 'drop' | 'petty' | null
  const [events, setEvents] = useState(null); // { events, today }
  const [eventsOpen, setEventsOpen] = useState(false);
  const [idleNote, setIdleNote] = useState(null); // minutes, after signing out for being unused
  const [drawerLeftOpen, setDrawerLeftOpen] = useState(false); // signed out with a drawer open: it stays open
  const can = (k) => !!(tillAccess && tillAccess.can[k]);
  // Busy mode's pill: whether the website is busy or paused, every half minute.
  const canDelivery = can('delivery');
  const sessionToken = session && session.token;
  useEffect(() => {
    if (!sessionToken || !canDelivery) { setBusyMode(null); return undefined; }
    const load = () => posFetch('GET', '/pos/busy', sessionToken).then((b) => setBusyMode(b.takesOnline ? b.busy : null)).catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [sessionToken, canDelivery]);
  // Curbside: who is outside, every 20 seconds, for whoever takes money or runs deliveries.
  const canCurb = can('charge') || canDelivery;
  useEffect(() => {
    if (!sessionToken || !canCurb) { setOutside([]); return undefined; }
    const load = () => posFetch('GET', '/pos/curbside', sessionToken).then((r) => setOutside(r.outside)).catch(() => {});
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [sessionToken, canCurb]);
  // Money is taken, given back and receipts printed only on one's own open
  // drawer: the cashier on duty's (one cashier at a time), or a manager's.
  const onDuty = (k) => can(k) && !!drawer;
  const isManager = !!(tillAccess && tillAccess.role === 'manager');
  const tillSettings = (tillAccess && tillAccess.settings) || FALLBACK_ACCESS.settings;
  // Steady handlers for the memoized menu tiles (MenuTile), always calling
  // this render's tapItem and toggleFavorite.
  const tileHandlers = useRef({});
  // A barcode scanner types the code and Enter wherever the cashier is (till/Barcode.jsx).
  useBarcodeWedge(scanCode, !!session && !newCode && !scanOpen);
  // A code scanned into the search box rings up its dish too.
  useEffect(() => {
    const c = search.trim();
    if (c.length >= 4 && dishByCode(menu, c)) { setSearch(''); scanCode(c); }
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps
  tileHandlers.current = { tap: tapItem, favorite: toggleFavorite };
  const onTileTap = useCallback((m) => tileHandlers.current.tap(m), []);
  const onTileFavorite = useCallback((e, m) => tileHandlers.current.favorite(e, m), []);

  useEffect(() => {
    applyTheme(theme);
    saveTheme(theme);
  }, [theme]);
  useEffect(() => () => clearTheme(), []);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 20000);
    return () => clearInterval(t);
  }, []);
  // Notes for the team: whoever signs in sees the new ones first.
  useEffect(() => {
    setNotes(null); setNotesOpen(false);
    if (!sessionToken) return;
    posFetch('GET', '/pos/team-notes', sessionToken).then((r) => { setNotes(r); if (r.unread > 0) setNotesOpen(true); }).catch(() => {});
  }, [sessionToken]);
  // Today's checklists and stock coming in, now and every two minutes.
  useEffect(() => {
    setChecks(null); setIncoming(null); setEvents(null);
    if (!sessionToken) return undefined;
    const load = () => {
      posFetch('GET', '/pos/checklists', sessionToken).then(setChecks).catch(() => {});
      posFetch('GET', '/pos/transfers/waiting', sessionToken).then(setIncoming).catch(() => {});
      posFetch('GET', '/pos/events', sessionToken).then(setEvents).catch(() => {});
    };
    load();
    const t = setInterval(load, 120000);
    return () => clearInterval(t);
  }, [sessionToken]);
  useEffect(() => {
    if (!session || !session.token) return undefined;
    loadSoon(session.token);
    const t = setInterval(() => { loadKitchen(session.token); loadTabs(session.token); loadSoon(session.token); }, 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);
  // ── without the internet ──
  useEffect(() => onQueue(setQueued), []);
  useEffect(() => { offlineRef.current = offline; }, [offline]);
  useEffect(() => {
    const down = () => setOffline(true);
    const up = () => { serverAnswers().then((ok) => { if (ok) backOnline(); }); };
    window.addEventListener('offline', down);
    window.addEventListener('online', up);
    return () => { window.removeEventListener('offline', down); window.removeEventListener('online', up); };
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps
  // Offline: is the server back? Every few seconds. Online: what waits is sent.
  useEffect(() => {
    if (!session) return undefined;
    const t = setInterval(() => {
      if (offlineRef.current) serverAnswers().then((ok) => { if (ok) backOnline(); });
      else if (queueList().some((x) => !x.failed)) sendKept();
    }, offline ? 8000 : 30000);
    if (!offline && queueList().some((x) => !x.failed)) sendKept();
    return () => clearInterval(t);
  }, [session, offline]); // eslint-disable-line react-hooks/exhaustive-deps
  // The order being taken, kept on this device as it changes.
  useEffect(() => {
    if (!session || !coRef.current) return;
    if (!cart.length && !currentTab) { draftClear(coRef.current); return; }
    draftSave(coRef.current, { cart, fulfillment, selectedTable, selectedWaiter, selectedGuest, delivery, kitchenNote, currentTab, sentLines, at: Date.now() });
  }, [session, cart, fulfillment, selectedTable, selectedWaiter, selectedGuest, delivery, kitchenNote, currentTab, sentLines]);

  // The tables' QR orders and calls, asked for every few seconds; something
  // new rings and says so.
  useEffect(() => {
    if (!session || !session.token) return undefined;
    tableSeen.current = null;
    loadTableBox(session.token);
    loadRota(session.token);
    const t = setInterval(() => loadTableBox(session.token), 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);
  // Kitchen tickets that reached the kitchen without this till, for its
  // kitchen printer (lib/thermalPrinter.js kitchenSetup others), every few
  // seconds: a printer the page reaches prints them at once; through
  // PassPRNT, Android opens the app only from a tap, so the till asks.
  useEffect(() => {
    if (!session || !session.token || !kitchenPrinter || !kitchenSet.others || offline) return undefined;
    let gone = false;
    const look = async () => {
      if (takingRef.current) return;
      try {
        const r = await posFetch('GET', '/pos/kitchen/to-print', session.token);
        if (gone) return;
        if (kitchenPrinter.kind !== 'passprnt' && r.chits.length) takeAndPrint(r.chits);
        else setToPrint(r.chits);
      } catch { /* asked again in a moment */ }
    };
    look();
    const t = setInterval(look, 8000);
    return () => { gone = true; clearInterval(t); };
  }, [session, kitchenPrinter, kitchenSet.others, offline]); // eslint-disable-line react-hooks/exhaustive-deps
  const printWaiting = kitchenPrinter && kitchenSet.others && !offline ? toPrint : [];
  // A delivery's food is ready: ask once to send it out with a rider (not
  // over a payment being taken; the next look asks then).
  useEffect(() => {
    if (!kitchen || !tillAccess || !tillAccess.can.delivery || deliveryPrompt || sendFor || checkoutOpen) return;
    const t = kitchen.ready.find((x) => x.fulfillment === 'delivery' && !x.deliveryId && !prompted.current.has(x.id));
    if (!t) return;
    prompted.current.add(t.id);
    setDeliveryPrompt(t);
  }, [kitchen]); // eslint-disable-line react-hooks/exhaustive-deps
  // A rider says they collected the money: ask the cashier on duty, once,
  // to count it in (not over a payment being taken).
  useEffect(() => {
    if (!tabs || !onDuty('charge') || handIn || deliveryPrompt || sendFor || checkoutOpen) return;
    const t = tabs.find((x) => x.delivery && x.delivery.collected && !askedMoney.current.has(x.delivery.id));
    if (!t) return;
    askedMoney.current.add(t.delivery.id);
    setHandIn(t);
  }, [tabs, deliveryPrompt, sendFor, checkoutOpen, handIn]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    (async () => {
      // The computer's own printer when chosen on this device, else the
      // USB or Bluetooth printer paired before.
      const sys = reconnectSystemPrinter() || reconnectPassPrnt();
      if (sys) { setPrinter(sys); return; }
      const usb = await reconnectUsbPrinter();
      if (usb) { setPrinter(usb); return; }
      const bt = await reconnectBluetoothPrinter();
      if (bt) setPrinter(bt);
    })();
  }, []);
  // Back from Star's PassPRNT app (lib/thermalPrinter.js): printed, or why not.
  useEffect(() => {
    const said = () => {
      const r = readPassPrntReply();
      if (!r) return;
      setToast(r.ok ? '🖨️ ' + tr('Printed on the Star printer.') : tr('The Star printer did not print: {message}', { message: r.message || tr('no answer from PassPRNT') }));
      // Kitchen tickets just handed to PassPRNT: printed, or offered again.
      let sent = null;
      try { sent = JSON.parse(localStorage.getItem(KITCHEN_SENT_KEY) || 'null'); localStorage.removeItem(KITCHEN_SENT_KEY); } catch { sent = null; }
      if (!r.ok && sent && Date.now() - sent.at < 120000) setKitchenRetry(sent.list);
      if (r.ok) setKitchenRetry(null);
    };
    said();
    window.addEventListener('hashchange', said);
    return () => window.removeEventListener('hashchange', said);
  }, []);

  // Own service worker, scoped to /pos only (same pattern as KioskPage.jsx's
  // /kiosk one) — makes a till device's "Add to Home Screen" install open
  // straight into the POS with its own icon/name (pos-manifest.webmanifest,
  // pos.html) instead of landing on the main app's dashboard, and caches
  // the app shell so a till that loses wifi mid-shift still loads. On the
  // till's own website (lib/site.js) the whole site is the till.
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/pos-sw.js', { scope: SITE === 'pos' ? '/' : '/pos' }).catch(() => {});
    }
  }, []);

  async function printToThermalPrinter(order) {
    setPrinting(true);
    setPrinterError(null);
    try {
      const bytes = buildReceiptBytes(order, session.companyName, order.cashierName || session.employeeName, {
        kickDrawer: order.paymentMethod === 'cash' || (order.payments || []).some((p) => p.method === 'cash'), footer: tillSettings.receipt.footer, extra: tillSettings.receipt.extra, lineWidth: printer.lineWidth
      });
      await printer.write(bytes);
    } catch (err) {
      setPrinterError(tr('Could not print: {message}', { message: err.message }));
    } finally {
      setPrinting(false);
    }
  }

  async function loadMenu(token) {
    setMenuLoading(true);
    setMenuError(null);
    try {
      const items = await fetchOrGiveUp('GET', '/pos/menu', token);
      setMenu(items);
      cacheSave(coRef.current, 'menu', items);
      return true;
    } catch (err) {
      if (err.status === 401) { localStorage.removeItem(SESSION_KEY); setSession(null); return false; }
      // No internet: the menu this till last loaded.
      const kept = isNetworkError(err) ? cacheLoad(coRef.current, 'menu') : null;
      if (kept) { setMenu(kept); goneOffline(); return true; }
      setMenuError(err.message);
      return false;
    } finally {
      setMenuLoading(false);
    }
  }

  // Loaded alongside the menu rather than lazily on first tab switch —
  // it's one cheap, already-windowed aggregate query (see
  // restaurantPos.service.js's mostlyBought), and fetching it upfront
  // avoids a loading flicker the first time someone taps the tab.
  async function loadMostlyBought(token) {
    setMostlyBoughtLoading(true);
    try {
      let list;
      try { list = await posFetch('GET', '/pos/menu/mostly-bought', token); cacheSave(coRef.current, 'mostly', list); }
      catch (e) { list = (isNetworkError(e) && cacheLoad(coRef.current, 'mostly')) || []; }
      setMostlyBought(list);
      // Nothing sold yet to rank: every dish instead.
      if (!list.length) setViewTab((v) => (v === 'mostly' ? 'all' : v));
    } catch {
      // Non-critical — the tab just shows its empty state if this fails.
    } finally {
      setMostlyBoughtLoading(false);
    }
  }

  // Tables/waiters are per-company catalogues (management-set for tables,
  // any active employee for waiters) — cheap, loaded alongside the menu
  // same as mostlyBought above rather than lazily when a picker opens.
  async function loadTablesAndWaiters(token) {
    try {
      const [t, w] = await Promise.all([
        posFetch('GET', '/pos/tables', token),
        posFetch('GET', '/pos/waiters', token)
      ]);
      setTables(t);
      setWaiters(w);
      cacheSave(coRef.current, 'tables', t);
      cacheSave(coRef.current, 'waiters', w);
    } catch {
      // Non-critical — the pickers show what this till last loaded, or nothing.
      setTables(cacheLoad(coRef.current, 'tables') || []);
      setWaiters(cacheLoad(coRef.current, 'waiters') || []);
    }
  }

  async function toggleFavorite(e, item) {
    e.stopPropagation();
    try {
      const res = await posFetch('POST', '/pos/menu-items/' + item.id + '/favorite', session.token);
      setMenu((prev) => prev.map((m) => (m.id === item.id ? { ...m, favorite: res.favorite } : m)));
      setMostlyBought((prev) => prev.map((m) => (m.id === item.id ? { ...m, favorite: res.favorite } : m)));
    } catch (err) {
      if (err.status === 401) { localStorage.removeItem(SESSION_KEY); setSession(null); }
    }
  }

  async function loadShift(token) {
    try { setShift(await posFetch('GET', '/pos/shift', token || session.token)); } catch { /* the shift figures just don't show */ }
  }
  // After a refund, a VIP top-up or an IOU paid: the shift, the drawer and
  // a VIP balance on the payment screen are fresh again.
  function moneyChanged() { loadShift(); refreshDrawer(); setVipKey((k) => k + 1); }
  function sessionEnded() { localStorage.removeItem(SESSION_KEY); setSession(null); setRefundFor(null); setVipOpen(null); setIouOpen(false); }
  async function loadSoon(token) {
    try { setSoon(await posFetch('GET', '/pos/bookings/soon', token || session.token)); } catch { /* no bookings shown then */ }
  }
  // A booking or a guest from the waitlist seated: their order starts at their table.
  function seatBooking(b) {
    setBookingsOpen(false);
    loadSoon();
    const t = tables.find((x) => x.id === b.tableId);
    if (cart.length) { setToast(tr('{name} is seated at {table}.', { name: b.name, table: t ? t.name : '' })); return; }
    setFulfillment('dine_in');
    if (t) setSelectedTable(t);
    setGuests(b.party);
    setToast(tr('{name} is seated at {table}: their order starts here.', { name: b.name, table: t ? t.name : '' }));
  }
  async function loadKitchen(token) {
    try { setKitchen(await posFetch('GET', '/pos/kitchen', token || session.token)); } catch { /* the kitchen figures just don't show */ }
  }
  // Sending a delivery out with a rider (delivery/DlDialogs SendDialog), with
  // what the delivery screen knows of it: the customer's pin, what to collect.
  async function sendOut(ref) {
    setDeliveryPrompt(null);
    try {
      const b = await posFetch('GET', '/pos/delivery/board', session.token);
      const w = b.ready.concat(b.cooking).find((x) => (ref.tabId && x.tabId === ref.tabId) || (ref.orderId && x.orderId === ref.orderId));
      if (!w) { setToast(tr('That order has gone out already.')); loadKitchen(); loadTabs(); return; }
      setSendFor({ target: w, riders: b.riders, settings: b.settings });
    } catch (err) {
      if (err.status === 401) { localStorage.removeItem(SESSION_KEY); setSession(null); } else setToast(err.message);
    }
  }
  async function serveTicket(t) {
    try {
      await posFetch('POST', '/pos/kds/tickets/' + t.id + '/served', session.token, { from: 'till' });
      setToast(tr('#{n} served.', { n: t.number }));
      loadKitchen();
    } catch (err) { setToast(err.message); }
  }
  function goneOffline() { if (!offlineRef.current) { offlineRef.current = true; setOffline(true); } }
  function backOnline() {
    offlineRef.current = false;
    setOffline(false);
    if (session) { loadMenu(session.token); loadTabs(); loadKitchen(); refreshDrawer(); loadShift(); }
  }
  // What this till kept while offline, sent now.
  async function sendKept() {
    if (!session) return;
    const r = await flush(session.token);
    if (r.offline) goneOffline();
    if (r.signIn) setToast(tr('Sign in again to send what this till kept.'));
    if (r.sent) {
      setToast(r.sent === 1 ? tr('1 order kept on this till is now on the server.') : tr('{n} orders kept on this till are now on the server.', { n: r.sent }));
      loadTabs(); loadKitchen(); refreshDrawer(); loadShift();
    }
  }
  // The order that was being taken when the till stopped (the power, a reload), back.
  function restoreDraft() {
    const d = draftLoad(coRef.current);
    if (!d || !d.cart || !d.cart.length || Date.now() - d.at > 12 * 3600000) return;
    setCart(d.cart); setFulfillment(d.fulfillment || 'dine_in'); setSelectedTable(d.selectedTable || null); setSelectedWaiter(d.selectedWaiter || null);
    setSelectedGuest(d.selectedGuest || null); setDelivery(d.delivery || { name: '', phone: '', address: '' }); setKitchenNote(d.kitchenNote || '');
    setCurrentTab(d.currentTab || null); setSentLines(d.sentLines || []);
    setToast(tr('The order you were taking is back on the till.'));
  }
  // Who works today, from the rota (backend restaurantRota.service.js).
  async function loadRota(token) {
    try { setRotaToday((await posFetch('GET', '/pos/rota/today', token || session.token)).shifts); } catch { /* the rota is a nicety */ }
  }
  async function loadTableBox(token) {
    let b;
    try { b = await posFetch('GET', '/pos/table-orders', token || session.token); } catch { return; }
    const paidKey = (x) => 'paid:' + x.tabId + ':' + x.payments;
    const paidList = b.paidAtTable || [];
    const ids = b.orders.map((o) => o.id).concat(b.calls.map((c) => c.id), paidList.map(paidKey));
    if (tableSeen.current) {
      const fresh = b.orders.filter((o) => !tableSeen.current.has(o.id));
      const calls = b.calls.filter((c) => !tableSeen.current.has(c.id));
      const paidNow = paidList.filter((x) => !tableSeen.current.has(paidKey(x)));
      if (fresh.length || calls.length || paidNow.length) {
        playNewTicket();
        setToast(fresh.length ? tr('{table} ordered from the table.', { table: fresh[0].tableName })
          : calls.length ? (calls[0].kind === 'bill' ? tr('{table} asks for the bill.', { table: calls[0].tableName }) : tr('{table} calls the waiter.', { table: calls[0].tableName }))
            : tr('{table} paid {amount} from the table.', { table: paidNow[0].tableName, amount: money(paidNow[0].amount) }));
        if (paidNow.length) loadTabs();
      }
    }
    tableSeen.current = new Set(ids);
    setTableBox(b);
  }
  // A table asked for its bill: its open order, on the till to charge.
  async function openBill(c) {
    setTableBoxOpen(false);
    let list = tabs;
    try { list = await posFetch('GET', '/pos/tabs', session.token); setTabs(list); } catch { /* the list as it was */ }
    const t = list.find((x) => (c.tabId ? x.id === c.tabId : x.tableId === c.tableId));
    if (t) openTab(t, true); else setToast(tr('{table} has no open order on the till.', { table: c.tableName }));
  }
  async function loadTabs(token) {
    try {
      const list = await posFetch('GET', '/pos/tabs', token || session.token);
      cacheSave(coRef.current, 'tabs', list);
      setTabs(withKept(list));
    } catch { setTabs((t) => (t.length ? withKept(t) : withKept(cacheLoad(coRef.current, 'tabs') || []))); }
  }
  // The open orders with what this till keeps to send: an order made or
  // changed offline as it is now here, and one paid offline gone.
  function withKept(list) {
    const kept = queueList();
    const paid = new Set(kept.filter((x) => x.kind === 'sale' && x.body.tabId).map((x) => x.body.tabId));
    let out = list.filter((t) => !paid.has(t.id) && !(t.offline && !kept.some((x) => x.localId === t.id)));
    kept.filter((x) => x.kind === 'tab' && x.snapshot).forEach((x) => {
      const id = x.localId || x.body.id;
      if (paid.has(id)) return;
      out = out.some((t) => t.id === id) ? out.map((t) => (t.id === id ? { ...x.snapshot, id } : t)) : out.concat([{ ...x.snapshot, id }]);
    });
    return out;
  }

  // The drawer's running figures (cash sales so far), after each sale.
  async function refreshDrawer() {
    try { const d = await posFetch('GET', '/pos/drawer', session.token); if (d) { setDrawer(d); cacheSave(coRef.current, 'drawer', d); } } catch { /* keeps the last figures */ }
  }

  async function loadAccess(token) {
    try {
      const a = await posFetch('GET', '/pos/access', token || session.token);
      cacheSave(coRef.current, 'access', a);
      // Their role was changed to one that does not use the till.
      if (!a.can.till) { localStorage.removeItem(SESSION_KEY); setSession(null); setTillAccess(null); setLoginError(tr('Your role does not use the till. Ask a manager.')); return; }
      setTillAccess((prev) => {
        // A new sign-in starts orders the way the settings say.
        if (!prev) setFulfillment(a.settings.defaultFulfillment || 'dine_in');
        return a;
      });
    }
    catch (err) {
      if (err.status === 401 || err.status === 403) { localStorage.removeItem(SESSION_KEY); setSession(null); setLoginError(err.status === 403 ? err.message : null); }
      else setTillAccess((a) => a || cacheLoad(coRef.current, 'access') || FALLBACK_ACCESS);
    }
  }

  async function loadDrawer(token) {
    await loadAccess(token);
    loadShift(token);
    loadTabs(token);
    loadKitchen(token);
    try {
      const d = await posFetch('GET', '/pos/drawer', token);
      setDrawer(d);
      cacheSave(coRef.current, 'drawer', d);
    } catch (err) {
      // No internet: the drawer as this till last saw it. Otherwise the
      // open-drawer prompt below shows and the cashier can retry with it.
      if (isNetworkError(err)) setDrawer(cacheLoad(coRef.current, 'drawer') || null);
    } finally {
      setDrawerChecked(true);
    }
  }

  // A role changed in the settings reaches a till already signed in.
  useEffect(() => {
    if (!session) return undefined;
    const t = setInterval(() => loadAccess(session.token), 60000);
    return () => clearInterval(t);
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  // Signing out a till left unused, when the settings ask for it.
  const idleMinutes = tillSettings.idleMinutes;
  useEffect(() => {
    if (!session || !idleMinutes) return undefined;
    let last = Date.now();
    const bump = () => { last = Date.now(); };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    // Not while offline: nobody could sign in again until the internet is back.
    const t = setInterval(() => { if (!offlineRef.current && Date.now() - last > idleMinutes * 60000) { logout('idle'); setIdleNote(idleMinutes); } }, 15000);
    return () => { events.forEach((e) => window.removeEventListener(e, bump)); clearInterval(t); };
  }, [session, idleMinutes]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const saved = localStorage.getItem(SESSION_KEY);
    if (!saved) { setSessionChecked(true); return; }
    let parsed;
    try { parsed = JSON.parse(saved); } catch { localStorage.removeItem(SESSION_KEY); setSessionChecked(true); return; }
    coRef.current = parsed.companyId || null;
    loadMenu(parsed.token).then((ok) => {
      if (ok) { setSession(parsed); loadMostlyBought(parsed.token); loadDrawer(parsed.token); loadTablesAndWaiters(parsed.token); restoreDraft(); }
      setSessionChecked(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function tapDigit(d) {
    if (loggingIn) return;
    const next = (pin + d).slice(0, PIN_LENGTH);
    setPin(next);
    if (next.length === PIN_LENGTH) handlePinComplete(next);
  }
  function tapClear() { if (!loggingIn) setPin(''); }
  // A till with a keyboard can type the PIN as well as tap it.
  useEffect(() => {
    if (session || !sessionChecked || clockMode) return undefined;
    function onKey(e) {
      if (/^[0-9]$/.test(e.key)) tapDigit(e.key);
      else if (e.key === 'Backspace') tapBackspace();
      else if (e.key === 'Escape') tapClear();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  function tapBackspace() { if (!loggingIn) setPin(pin.slice(0, -1)); }

  async function handlePinComplete(fullPin) {
    setLoggingIn(true);
    setLoginError(null);
    try {
      const s = await posFetch('POST', '/pos/login', null, { pin: fullPin, app: 'till' });
      coRef.current = s.companyId || null;
      setIdleNote(null);
      setDrawerLeftOpen(false);
      localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      setSession(s);
      setPin('');
      await loadMenu(s.token);
      loadMostlyBought(s.token);
      loadDrawer(s.token);
      loadTablesAndWaiters(s.token);
      restoreDraft();
    } catch (err) {
      setLoginError(isNetworkError(err) ? tr('No internet: the till cannot check a PIN now. Whoever was signed in stays signed in; sign in again when the internet is back.') : err.message);
      setPin('');
    } finally {
      setLoggingIn(false);
    }
  }

  // Signing out — to step away, or after the till went unused — leaves a
  // cash drawer open: signing in again carries on with it, and only
  // counting and closing it ends it. The activity log notes the sign-out.
  function logout(reason) {
    if (offlineRef.current && reason !== 'idle' && !window.confirm(tr('No internet: nobody can sign in to this till until it is back. Sign out anyway?'))) return;
    if (session) posFetch('POST', '/pos/logout', session.token, { reason: reason === 'idle' ? 'idle' : 'manual' }).catch(() => {});
    setDrawerLeftOpen(!!drawer);
    setOrdersOnly(false);
    setDutyNotice(true);
    setOfficeOpen(false);
    localStorage.removeItem(SESSION_KEY);
    setSession(null);
    setTillAccess(null);
    setSettingsOpen(false);
    setCart([]);
    setMenu([]);
    setReceipt(null);
    setRecentIds([]);
    setMostlyBought([]);
    setViewTab('mostly');
    setFulfillment('dine_in');
    setDelivery({ name: '', phone: '', address: '' });
    setSentLines([]);
    setDrawer(null);
    setDrawerChecked(false);
    setClosedReport(null);
    setTables([]);
    setWaiters([]);
    setSelectedTable(null);
    setSelectedWaiter(null);
    setSelectedGuest(null);
    setShift(null);
    setTabs([]);
    setCurrentTab(null);
    setCategory('');
    setCartOpen(false);
    setKitchen(null);
    setKitchenNote('');
    setNoteOpen(false);
  }

  async function searchGuests(q) {
    setGuestSearching(true);
    try {
      setGuestResults(await posFetch('GET', '/pos/guests' + (q ? '?q=' + encodeURIComponent(q) : ''), session.token));
    } catch {
      // Non-critical — the picker just shows no results if this fails.
    } finally {
      setGuestSearching(false);
    }
  }

  function openGuestPicker() {
    setGuestError(null);
    setGuestSearch('');
    setNewGuestName('');
    setNewGuestPhone('');
    setNewGuestMore(null);
    setGuestPickerOpen(true);
    searchGuests('');
  }

  async function submitNewGuest(e) {
    e.preventDefault();
    setAddingGuest(true);
    setGuestError(null);
    try {
      const more = newGuestMore ? { email: newGuestMore.email.trim() || undefined, birthday: newGuestMore.birthday || undefined, marketing: newGuestMore.marketing } : {};
      const g = await posFetch('POST', '/pos/guests', session.token, { name: newGuestName, phone: newGuestPhone, ...more });
      setSelectedGuest(g);
      setGuestPickerOpen(false);
    } catch (err) {
      if (err.status === 401) { localStorage.removeItem(SESSION_KEY); setSession(null); }
      else setGuestError(err.message);
    } finally {
      setAddingGuest(false);
    }
  }

  // Whether the till is free for this cashier: asked again when they tap
  // "Cashier on duty" (the other cashier may have closed their drawer).
  async function checkDuty() {
    // A manager opens their own drawer beside the cashier on duty's.
    if (isManager) { setOrdersOnly(false); return; }
    const a = await posFetch('GET', '/pos/access', session.token).catch(() => null);
    if (!a) return;
    setTillAccess(a);
    if (a.cashierOnDuty && !a.cashierOnDuty.me) setDutyNotice(true);
    else setOrdersOnly(false);
  }

  async function submitOpenDrawer(e) {
    e.preventDefault();
    setOpeningDrawer(true);
    setOpenDrawerError(null);
    try {
      setDrawer(await posFetch('POST', '/pos/drawer/open', session.token, { startingCash: openingCash === '' ? 0 : openingCash }));
      setOpeningCash('');
      loadShift();
    } catch (err) {
      if (err.status === 401) { localStorage.removeItem(SESSION_KEY); setSession(null); }
      else setOpenDrawerError(err.message);
    } finally {
      setOpeningDrawer(false);
    }
  }

  function openMovement(direction) { setMovementDirection(direction); }

  function openCloseDrawer() {
    if (queued.length) {
      setToast(tr('First send what this till kept while offline ({n}): the drawer counts it.', { n: queued.length }));
      setQueueOpen(true);
      return;
    }
    setCloseDrawerError(null);
    setCloseActualCash('');
    setCloseNote('');
    setCloseDrawerOpen(true);
  }

  async function submitCloseDrawer(e) {
    e.preventDefault();
    setClosingDrawer(true);
    setCloseDrawerError(null);
    try {
      const report = await posFetch('POST', '/pos/drawer/close', session.token, {
        actualCash: closeActualCash === '' ? 0 : closeActualCash, note: closeNote
      });
      setClosedReport(report);
      setDrawer(null);
      setCloseDrawerOpen(false);
      setDrawerPanelOpen(false);
    } catch (err) {
      if (err.status === 401) { localStorage.removeItem(SESSION_KEY); setSession(null); }
      else setCloseDrawerError(err.message);
    } finally {
      setClosingDrawer(false);
    }
  }

  async function printDrawerReportThermal(report) {
    setPrinting(true);
    setPrinterError(null);
    try {
      const bytes = buildDrawerReportBytes(report, session.companyName, session.employeeName, { lineWidth: printer.lineWidth });
      await printer.write(bytes);
    } catch (err) {
      setPrinterError(tr('Could not print: {message}', { message: err.message }));
    } finally {
      setPrinting(false);
    }
  }

  var RECENT_LIMIT = 30;
  // A cart line is its dish and variation ("M" and "Jellyfish" ring up
  // apart) and its note: the same dish with a note for the kitchen is
  // another line (tillShared.lineKey). A tap on a tile adds to the line
  // with no note.
  // A dish with sizes asks which; one with add-ons (till/BillDialogs.jsx) asks for them.
  function tapItem(tapped) {
    // A tile from "mostly bought" (/pos/menu/mostly-bought) is the menu's
    // dish with its sizes and add-ons.
    const item = menuById.get(tapped.id) || tapped;
    // Not served now: its menu's hours (breakfast in the morning).
    if (!categoryOpen(tillSettings, item.category)) {
      const h = hoursOf(tillSettings, item.category);
      setToast(tr('{name} is served from {from} to {to}.', { name: item.name, from: h.from, to: h.to }));
      return;
    }
    if (item.variations && item.variations.length) { setVariantPickerItem(item); return; }
    if (item.addOns && item.addOns.length) { setAddOnsFor({ item, variation: null }); return; }
    addToCart(item, null);
  }
  function pickVariation(item, v) {
    if (item.addOns && item.addOns.length) { setVariantPickerItem(null); setAddOnsFor({ item, variation: v }); return; }
    addToCart(item, v);
  }
  // A barcode scanned or read by the camera (till/Barcode.jsx): its dish, or
  // its size, as if tapped; a code no dish has asks which dish it is.
  function scanCode(code) {
    setScanOpen(false);
    const found = dishByCode(menu, code);
    if (!found) { setNewCode(code); return; }
    const item = menuById.get(found.item.id) || found.item;
    if (!found.variation) { tapItem(item); return; }
    if (!categoryOpen(tillSettings, item.category)) { tapItem(item); return; }
    pickVariation(item, found.variation);
  }
  function addToCart(item, variation, mods, n) {
    const qty = n || 1;
    // A dish that counts its stock: no more than is left (what this open
    // order already sent is its own).
    if (item.stock) {
      const mine = sentLines.filter((l) => l.menuItemId === item.id).reduce((a, l) => a + l.qty, 0);
      const can2 = item.stock.left + mine;
      if ((cartQtyById.get(item.id) || 0) + qty > can2) {
        setToast(can2 <= 0 ? tr('{name} is sold out.', { name: item.name }) : tr('Only {n} × {name} left.', { n: can2, name: item.name }));
        setVariantPickerItem(null);
        setAddOnsFor(null);
        return;
      }
    }
    // The guest is allergic to something it has: asked first.
    const bad = clashes(item.allergens, allergy);
    if (bad.length && !window.confirm(tr('{name} has {allergens}, and this order has an allergy alert. Add it anyway?', { name: item.name, allergens: bad.map((k) => allergenWords(k, tr)).join(', ') }))) {
      setVariantPickerItem(null); setAddOnsFor(null); return;
    }
    // A happy hour on it now goes on by itself (the cashier can take it off).
    const hh = happyFor(tillSettings, item.category);
    const line = {
      menuItemId: item.id, variationId: variation ? variation.id : null,
      name: variation ? item.name + ' — ' + variation.name : item.name,
      price: round2((variation ? variation.price : item.price) + modsPrice(mods)), qty, note: '', modifiers: mods || [],
      discountSpec: hh ? { presetId: hh.id, kind: 'percent', value: hh.percent, name: hh.name } : null, comp: null,
      seat: seat || null, course: null, category: item.category || '', allergens: item.allergens || []
    };
    const key = lineKey(line);
    setCart((prev) => {
      const idx = prev.findIndex((l) => lineKey(l) === key);
      if (idx >= 0) return prev.map((l, i) => (i === idx ? { ...l, qty: l.qty + qty } : l));
      return prev.concat([line]);
    });
    setAddOnsFor(null);
    setRecentIds((prev) => [item.id].concat(prev.filter((id) => id !== item.id)).slice(0, RECENT_LIMIT));
    setTappedId(item.id);
    setTimeout(() => setTappedId((cur) => (cur === item.id ? null : cur)), 260);
    setPlus((p) => ({ id: item.id, n: p ? p.n + 1 : 1 }));
    setVariantPickerItem(null);
  }
  // A dish not on the menu (till/OrderDialogs.jsx CustomItemDialog).
  function addCustom(c) {
    const line = { menuItemId: null, variationId: null, name: c.name, price: c.price, qty: c.qty, note: c.note || '', custom: { name: c.name, price: c.price, category: c.category || '' } };
    setCart((prev) => {
      const idx = prev.findIndex((l) => lineKey(l) === lineKey(line));
      if (idx >= 0) return prev.map((l, i) => (i === idx ? { ...l, qty: l.qty + c.qty } : l));
      return prev.concat([line]);
    });
    setCustomOpen(false);
    setToast(tr('{name} added.', { name: c.name }));
  }
  function changeQty(key, delta) {
    setCart((prev) => prev.map((l) => (lineKey(l) === key ? { ...l, qty: Math.max(0, l.qty + delta) } : l)).filter((l) => l.qty > 0));
  }
  function removeLine(key) {
    setCart((prev) => prev.filter((l) => lineKey(l) !== key));
  }
  // A line changed (its note, add-ons or discount); a line that ends up
  // like another joins it.
  function changeLine(key, patch) {
    setCart((prev) => {
      const idx = prev.findIndex((l) => lineKey(l) === key);
      if (idx < 0) return prev;
      const next = { ...prev[idx], ...patch };
      const rest = prev.filter((_, i) => i !== idx);
      const same = rest.findIndex((l) => lineKey(l) === lineKey(next));
      if (same >= 0) return rest.map((l, i) => (i === same ? { ...l, qty: l.qty + next.qty } : l));
      return prev.map((l, i) => (i === idx ? next : l));
    });
  }
  function setLineNote(key, note) { changeLine(key, { note }); setNoteFor(null); }
  // A line's add-ons changed: its price follows.
  function editAddOns(l) {
    const item = menu.find((m) => m.id === l.menuItemId);
    if (!item) return;
    setAddOnsFor({ item, variation: l.variationId ? (item.variations || []).find((v) => v.id === l.variationId) || null : null, line: l });
  }
  function saveAddOns(mods, qty) {
    const f = addOnsFor;
    if (f.line) {
      const base = f.variation ? f.variation.price : f.item.price;
      changeLine(lineKey(f.line), { modifiers: mods, price: round2(base + modsPrice(mods)) });
      setAddOnsFor(null);
    } else addToCart(f.item, f.variation, mods, qty);
  }
  // The whole bill's discount and service charge as the server wants them.
  function adjustBody() {
    return { discount: billAdjust.discount || undefined, serviceOff: billAdjust.serviceOff || undefined, promoCode: billAdjust.promoCode || undefined };
  }

  // The bill as the server will make it (till/tillBill.js): add-ons,
  // discounts, the service charge, the taxes.
  // A delivery app's order is at the app's prices, and picked up by its rider.
  // Deals (till/promos.js) look at each dish's category; a large party's service charge at how many sat down.
  const bill = useMemo(() => {
    const cats = new Map(menu.map((m) => [m.id, m.category]));
    const lines = cart.map((l) => (l.category !== undefined || !l.menuItemId ? l : { ...l, category: cats.get(l.menuItemId) || '' }));
    return appOrder ? billOf(withMarkup(lines, appOrder.markup), billAdjust, tillSettings, 'pickup', { channel: 'app' }) : billOf(lines, billAdjust, tillSettings, fulfillment, { guests });
  }, [cart, billAdjust, tillSettings, fulfillment, appOrder, menu, guests]);
  const cartTotal = bill.total;
  const animatedCartTotal = useCountUp(cartTotal);
  // The customer's screen (till/customerScreenLink.js): the order as it
  // stands, the bill and a tip to tap while paying, a thank-you once paid.
  const screenRef = (currentTab ? currentTab.id : 'sale') + '-' + Math.round(((checkoutOpen && payInfo ? payInfo.bill : cartTotal) || 0) * 100);
  const screenState = useMemo(() => {
    if (!session) return { phase: 'idle' };
    if (receipt && !receipt.reprint) {
      return { phase: 'paid', ref: String(receipt.id), lang: activeLocale(), customer: receipt.guestName || '',
        paid: { total: receipt.total, tip: receipt.tip || 0, change: receipt.change || 0, method: receipt.paymentMethod, orderNo: receipt.orderNo || '', receiptUrl: receipt.offline ? '' : receipt.receiptUrl || '',
          points: receipt.points ? { earned: receipt.points.earned, balance: receipt.points.balance } : null } };
    }
    if (!cart.length) return { phase: 'idle', lang: activeLocale() };
    const tips = tillSettings.tips && tillSettings.tips.on ? tillSettings.tips : null;
    return {
      phase: checkoutOpen ? 'pay' : 'order', ref: screenRef, lang: activeLocale(),
      lines: bill.lines.map((l) => ({ name: l.name, qty: l.qty, amount: l.net, gross: l.gross, mods: modsWords(l.modifiers, tr), seat: l.seat || null, comp: !!l.comp,
        off: l.comp ? tr('On the house') : l.discount > 0 && l.discountSpec && l.discountSpec.name ? l.discountSpec.name : '' })),
      totals: { items: bill.itemsGross, discount: bill.discountTotal, service: bill.serviceCharge, serviceName: serviceWords(bill.serviceName, tr), total: bill.total, taxes: bill.taxes },
      tip: checkoutOpen && tips ? { ask: true, base: payInfo ? payInfo.bill : bill.total, percents: tips.percents, amount: payInfo ? payInfo.tip : 0 } : undefined,
      customer: selectedGuest ? selectedGuest.name : '', cashier: session.employeeName ? String(session.employeeName).split(' ')[0] : ''
    };
  }, [session, receipt, cart.length, bill, checkoutOpen, payInfo, selectedGuest, tillSettings, screenRef]);
  const screen = useCustomerDisplay({ token: session && session.token, state: screenState });
  const animatedShiftSales = useCountUp(shift ? shift.sales : 0, 700);
  const menuById = useMemo(() => new Map(menu.map((m) => [m.id, m])), [menu]);
  const cartQtyById = useMemo(() => {
    const map = new Map();
    cart.forEach((l) => { if (l.menuItemId) map.set(l.menuItemId, (map.get(l.menuItemId) || 0) + l.qty); });
    return map;
  }, [cart]);

  // What an order needs before it goes anywhere: dine in, its table (when
  // the restaurant has tables) and, if the settings ask, the waiter; a
  // delivery, who, a phone and where.
  function orderReady() {
    // Ordered on the self-order kiosk: called by its number, no table or phone needed.
    const kioskTab = currentTab && tabs.some((t) => t.id === currentTab.id && t.fromKiosk);
    if (kioskTab) return true;
    if (fulfillment === 'dine_in' && tables.length && !selectedTable) {
      setToast(tr('Pick the table for this dine-in order.'));
      setTablePickerOpen(true);
      return false;
    }
    if (fulfillment === 'dine_in' && tillSettings.requireWaiter && selectedTable && !selectedWaiter) {
      setToast(tr('Pick the waiter for this table.'));
      setWaiterPickerOpen(true);
      return false;
    }
    if (fulfillment === 'delivery' && !(delivery.name && delivery.phone && delivery.address)) {
      setToast(tr('A delivery needs the customer\'s name, a phone and the location.'));
      setDeliveryOpen(true);
      return false;
    }
    if (fulfillment === 'pickup' && !(pickupWho().name && pickupWho().phone)) {
      setToast(tr('A pickup needs the customer\'s name and a phone, to call them when it is ready.'));
      setDeliveryOpen(true);
      return false;
    }
    return true;
  }
  // Who and where, as the server wants them with an order.
  function orderWho() {
    const body = {
      fulfillment: fulfillment,
      tableId: fulfillment === 'dine_in' && selectedTable ? selectedTable.id : undefined,
      waiterId: fulfillment === 'dine_in' && selectedWaiter ? selectedWaiter.id : undefined,
      guestId: selectedGuest ? selectedGuest.id : undefined
    };
    if (fulfillment === 'delivery') Object.assign(body, { customerName: delivery.name, customerPhone: delivery.phone, deliveryAddress: delivery.address });
    else if (fulfillment === 'pickup') Object.assign(body, { customerName: pickupWho().name, customerPhone: pickupWho().phone });
    else if (selectedGuest) Object.assign(body, { customerName: selectedGuest.name, customerPhone: selectedGuest.phone || '' });
    // How many sat down (eaten in), and any allergy alert for the kitchen.
    if (fulfillment === 'dine_in' && guests) body.guests = guests;
    body.allergy = allergy || null;
    return body;
  }
  // Who a pickup is for: as typed (Pickup details), else the customer picked.
  function pickupWho() {
    return { name: delivery.name || (selectedGuest ? selectedGuest.name : ''), phone: delivery.phone || (selectedGuest ? selectedGuest.phone || '' : '') };
  }
  function whereText() {
    if (fulfillment === 'dine_in') return selectedTable ? selectedTable.name : currentTab ? currentTab.name : tr('No table');
    if (fulfillment === 'togo') return tr('To go');
    if (fulfillment === 'pickup') return tr('Counter');
    return delivery.address || tr('Delivery');
  }
  function payMethods() { return tillSettings.paymentMethods.filter((k) => k !== 'iou' || can('iou')); }
  function openCheckout() {
    if (!orderReady()) return;
    setCheckoutError(null);
    setCartOpen(false);
    setCheckoutOpen(true);
  }

  // By dish (PayDialog): only the dishes picked, the rest of the open order stays open.
  function pickedLines(dishPick) {
    return dishPick.map((p) => { const l = cart.find((x) => lineKey(x) === p.key); return l ? { ...l, qty: p.qty } : null; }).filter(Boolean);
  }
  async function submitCheckout(payments, dishPick, tip) {
    setCheckingOut(true);
    setCheckoutError(null);
    const byDish = !!(dishPick && dishPick.length && currentTab);
    // Its own reference: sent again (a slow answer, the internet back), it is still one sale.
    const body = Object.assign({
      items: (byDish ? pickedLines(dishPick) : cart).map(lineBody),
      keepRest: byDish || undefined,
      payments: payments,
      tabId: currentTab ? currentTab.id : undefined,
      kitchenNote: kitchenNote.trim() || undefined,
      adjust: adjustBody(),
      tip: tip > 0 ? tip : undefined,
      clientRef: newRef()
    }, orderWho());
    if (byDish && (offline || isLocal(body.tabId))) { setCheckoutError(tr('No internet: pay by dish needs the server. Take the whole bill, or wait for the internet.')); setCheckingOut(false); return; }
    if (offline || (body.tabId && isLocal(body.tabId))) { keepSale(body, payments); setCheckingOut(false); return; }
    try {
      const order = await fetchOrGiveUp('POST', '/pos/orders', session.token, resolveIds(body));
      // The order response only carries ids (see restaurantPos.service.js's
      // rowToOrder) — names come from what's already selected here, so the
      // receipt can show them without a second round trip.
      setReceipt({
        ...order, tableName: fulfillment === 'dine_in' && selectedTable ? selectedTable.name : null,
        waiterName: fulfillment === 'dine_in' && selectedWaiter ? selectedWaiter.name : null, guestName: selectedGuest ? selectedGuest.name : (order.customerName || null),
        guestPhone: selectedGuest ? selectedGuest.phone || '' : '', restName: order.restOpen && currentTab ? currentTab.name : null
      });
      printChits(order.chits);
      clearOrder();
      setCheckoutOpen(false);
      loadShift();
      loadTabs();
      loadKitchen();
      refreshDrawer();
    } catch (err) {
      if (err.status === 401) { localStorage.removeItem(SESSION_KEY); setSession(null); setCheckoutOpen(false); }
      else if (isNetworkError(err) && !byDish) { goneOffline(); keepSale(body, payments); }
      else setCheckoutError(err.message);
    } finally {
      setCheckingOut(false);
    }
  }
  // A delivery app's order: paid on the app, so it is rung up at once.
  async function submitApp() {
    if (!cart.length || !appOrder) return;
    if (offline) { setToast(tr('No internet: a delivery app\'s order waits for the internet.')); return; }
    setCheckingOut(true);
    try {
      const order = await posFetch('POST', '/pos/orders', session.token, {
        items: cart.map(lineBody), payments: [{ method: 'app' }], app: { key: appOrder.key, ref: appOrder.ref, customer: appOrder.customer || undefined },
        kitchenNote: kitchenNote.trim() || undefined, adjust: adjustBody(), allergy: allergy || null, clientRef: newRef()
      });
      setReceipt({ ...order, tableName: null, waiterName: null, guestName: order.customerName || null, guestPhone: '' });
      printChits(order.chits);
      clearOrder();
      loadShift(); loadKitchen();
    } catch (err) {
      if (err.status === 401) { localStorage.removeItem(SESSION_KEY); setSession(null); }
      else setToast(err.message);
    } finally { setCheckingOut(false); }
  }
  // A sale with no server to take it: kept on this till with when it was
  // taken, a receipt now, and sent when the internet is back. VIP and IOU
  // need the customer's account on the server.
  function keepSale(body, payments) {
    if (payments.some((pm) => !OFFLINE_METHODS.includes(pm.method))) {
      setCheckoutError(tr('No internet: VIP, IOU and gift cards need the server. Take cash, Mobile Money, Alipay or WeChat Pay, or wait for the internet.'));
      return;
    }
    const total = bill.total;
    const label = currentTab ? currentTab.name : pickupLabel() || whereText();
    enqueue({ kind: 'sale', ref: body.clientRef, body: { ...body, takenAt: new Date().toISOString() }, label, total, method: payments.length > 1 ? 'split' : payments[0].method });
    const one = payments.length === 1 ? payments[0] : null;
    const change = one && one.method === 'cash' && one.currency === 'GHS' && one.tendered != null ? round2(one.tendered - total) : null;
    setReceipt({
      id: body.clientRef, offline: true, orderNo: tr('Offline') + ' ' + body.clientRef.slice(-6).toUpperCase(), createdAt: new Date().toISOString(),
      items: bill.lines.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.price, gross: l.gross, discount: l.discount, discountName: l.discountSpec ? l.discountSpec.name : null, compReason: l.comp ? l.comp.reason : null, lineTotal: l.net, note: l.note || '', modifiers: l.modifiers || [] })),
      itemsGross: bill.itemsGross, discountTotal: bill.discountTotal, billDiscount: bill.billDiscount ? { name: bill.billDiscountName, amount: bill.billDiscount } : null,
      serviceCharge: bill.serviceCharge, serviceName: bill.serviceName, serviceRate: bill.serviceRate, taxes: bill.taxes, taxTotal: bill.taxTotal, taxIncluded: bill.taxIncluded,
      subtotal: bill.subtotal, total, paymentMethod: payments.length > 1 ? 'split' : payments[0].method,
      payments: payments.map((pm) => ({ method: pm.method, currency: pm.currency || 'GHS', amount: pm.amount != null ? Number(pm.amount) : total, tendered: pm.tendered })),
      cashTendered: one && one.method === 'cash' && one.tendered != null ? one.tendered : null, change: change != null && change > 0 ? change : null,
      fulfillment, customerName: body.customerName || '', customerPhone: body.customerPhone || '', deliveryAddress: body.deliveryAddress || '',
      tableName: fulfillment === 'dine_in' && selectedTable ? selectedTable.name : null, waiterName: fulfillment === 'dine_in' && selectedWaiter ? selectedWaiter.name : null,
      guestName: selectedGuest ? selectedGuest.name : (body.customerName || null)
    });
    if (currentTab) setTabs((list) => list.filter((t) => t.id !== currentTab.id));
    clearOrder();
    setCheckoutOpen(false);
  }

  // ── open orders ──
  function clearOrder() {
    setCart([]);
    setAppOrder(null);
    setKitchenNote(''); setNoteOpen(false);
    setSelectedTable(null);
    setSelectedWaiter(null);
    setSelectedGuest(null);
    setCurrentTab(null);
    setSentLines([]);
    setBillAdjust(NO_ADJUST);
    setGuests(null); setSeat(null); setAllergy(null);
    setDelivery({ name: '', phone: '', address: '' });
    setFulfillment(tillSettings.defaultFulfillment || 'dine_in');
  }
  // "Send to kitchen": checked, then confirmed on the cashier's screen
  // (till/OrderDialogs.jsx SendConfirmDialog), then saved as an open order
  // and sent. An order with no table, customer or delivery is named first.
  function sendToKitchen() {
    if (!orderReady()) return;
    setTabError(null);
    if (fulfillment === 'dine_in' && !selectedTable && !selectedGuest && !currentTab) { setKeepDialog({ label: '' }); return; }
    setSendConfirm(true);
  }
  function pickupLabel() {
    if (currentTab && currentTab.label) return currentTab.label;
    if (fulfillment === 'delivery') return delivery.name;
    if (fulfillment === 'togo') return (selectedGuest && selectedGuest.name) || tr('To go') + ' ' + now.toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' });
    if (fulfillment === 'pickup') return pickupWho().name || tr('Counter') + ' ' + now.toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' });
    return '';
  }
  async function saveTab(label, table) {
    const tbl = table || selectedTable;
    setSavingTab(true);
    setTabError(null);
    try {
      const who = orderWho();
      if (table) who.tableId = table.id;
      const body = Object.assign({
        id: currentTab ? currentTab.id : undefined, label: label || pickupLabel() || '',
        items: cart.map(lineBody),
        kitchenNote: kitchenNote.trim() || undefined,
        adjust: adjustBody(),
        clientRef: currentTab ? undefined : newRef()
      }, who, { tableId: fulfillment === 'dine_in' && tbl ? tbl.id : undefined });
      if (offline || (body.id && isLocal(body.id))) { keepTab(body, tbl); return; }
      let saved;
      try { saved = await fetchOrGiveUp('POST', '/pos/tabs', session.token, resolveIds(body)); }
      catch (e) { if (isNetworkError(e)) { goneOffline(); keepTab(body, tbl); return; } throw e; }
      setToast(saved.kitchenTicket
        ? ((saved.kitchenTicket.held || []).length
          ? tr('{name} sent to the kitchen as #{n}; {course} waits until you call it.', { name: tabName(saved), n: saved.kitchenTicket.number, course: saved.kitchenTicket.held.map((c) => courseName(tillSettings, c, tr)).join(', ') })
          : tr('{name} sent to the kitchen as #{n}.', { name: tabName(saved), n: saved.kitchenTicket.number }))
        : tr('{name} kept open. Pay it from Open orders.', { name: tabName(saved) }));
      printChits(saved.chits);
      loadKitchen();
      setKeepDialog(null);
      setSendConfirm(false);
      setCartOpen(false);
      clearOrder();
      loadTabs();
      loadShift();
    } catch (err) {
      if (err.status === 401) { localStorage.removeItem(SESSION_KEY); setSession(null); }
      else if (keepDialog || sendConfirm) setTabError(err.message);
      else setToast(err.message);
    } finally {
      setSavingTab(false);
    }
  }
  // An order for the kitchen with no server to take it: kept on this till,
  // in Open orders as it is now, and sent when the internet is back — the
  // kitchen is told by word of mouth meanwhile.
  function keepTab(body, tbl) {
    const ref = body.clientRef || newRef();
    const id = body.id || 'local:' + ref;
    const lines = bill.lines.map((l) => ({ ...l, unitPrice: l.price, gross: l.gross, lineTotal: l.net, category: l.custom ? l.custom.category : undefined, fee: l.custom ? l.custom.fee : undefined }));
    const total = bill.total;
    const snapshot = {
      id, offline: true, label: body.label || '', tableId: body.tableId || null, tableName: tbl ? tbl.name : null, waiterId: body.waiterId || null, waiterName: selectedWaiter ? selectedWaiter.name : null,
      guestId: body.guestId || null, guestName: selectedGuest ? selectedGuest.name : null, guestPhone: selectedGuest ? selectedGuest.phone || '' : null,
      fulfillment: body.fulfillment || fulfillment, customerName: body.customerName || '', customerPhone: body.customerPhone || '', deliveryAddress: body.deliveryAddress || '',
      createdAt: currentTab && currentTab.createdAt ? currentTab.createdAt : new Date().toISOString(), lines, total, adjust: { ...billAdjust }, unavailable: 0, kitchen: null
    };
    enqueue({ kind: 'tab', ref, body: { ...body, clientRef: body.id ? undefined : ref }, localId: body.id ? null : id, label: tabName(snapshot), total, snapshot });
    setTabs((list) => (list.some((t) => t.id === id) ? list.map((t) => (t.id === id ? snapshot : t)) : list.concat([snapshot])));
    setToast(tr('No internet: {name} is kept on this till. Tell the kitchen now; it reaches the kitchen screen when the internet is back.', { name: tabName(snapshot) }));
    setKeepDialog(null);
    setSendConfirm(false);
    setCartOpen(false);
    clearOrder();
    setSavingTab(false);
  }
  // The tickets of stations without a screen: printed by themselves on the
  // kitchen's printer (or the till's own) as the order is sent, else shown
  // to print (till/ServiceParts.jsx).
  async function printChits(list) {
    if (!list || !list.length) return;
    const kp = kitchenPrinter;
    if (kp) {
      try {
        // Printed in English, as the printer has no other letters (lib/thermalPrinter.js).
        const english = (x, v) => (v ? x.replace('{n}', v.n) : x);
        // Through PassPRNT: kept for a moment, to print again if it could not.
        if (kp.kind === 'passprnt') { try { localStorage.setItem(KITCHEN_SENT_KEY, JSON.stringify({ at: Date.now(), list })); } catch { /* not offered again */ } }
        // All of them in one go, each cut off: one print on the computer's printer.
        await kp.write([].concat(...list.map((c) => buildKitchenChitBytes(c, session.companyName, { courseName: c.course ? courseName(tillSettings, c.course, english) : '', lineWidth: kp.lineWidth }))));
        setKitchenRetry(null);
        setToast(list.length === 1 ? tr('{station}\'s ticket printed.', { station: list[0].station }) : tr('{n} kitchen tickets printed.', { n: list.length }));
        return;
      } catch { /* shown to print instead */ }
    }
    setChits(list);
  }
  // Tickets that reached the kitchen without this till (website, kiosk,
  // table QR), waiting for a kitchen printer: taken off the queue by this
  // till (never two printing one) and printed.
  async function takeAndPrint(list) {
    if (takingRef.current || !list.length) return;
    takingRef.current = true;
    try {
      const r = await posFetch('POST', '/pos/kitchen/to-print', session.token, { ids: [...new Set(list.map((c) => c.ticketId))] });
      setToPrint([]);
      await printChits(r.chits);
    } catch (err) {
      if (err.status === 401) { localStorage.removeItem(SESSION_KEY); setSession(null); } else setToast(err.message);
    } finally { takingRef.current = false; }
  }
  // Each dish's course as the send confirmation shows it: the first course
  // (or as far as the order has been called) goes now, the later ones wait.
  function sendCourseFor() {
    if (!(tillSettings.courses && tillSettings.courses.on) || fulfillment !== 'dine_in') return null;
    const c = (l) => courseOf(tillSettings, { course: l.course, category: l.category || ((menuById.get(l.menuItemId) || {}).category) });
    const first = cart.map(c).filter((n) => n > 0).sort((a, b) => a - b)[0] || 0;
    const fired = (liveTab && liveTab.firedCourse) || first;
    return (l) => { const n = c(l); return l.custom ? null : { name: courseName(tillSettings, n, tr), waits: n > 0 && n > fired }; };
  }
  // The next course called (backend restaurantPos fireCourse).
  async function callCourse(t) {
    try {
      const r = await posFetch('POST', '/pos/tabs/' + t.id + '/fire', session.token, {});
      setToast(tr('{course} called for {name}: the kitchen starts on it now.', { course: r.called.join(', '), name: tabName(t) }));
      printChits(r.chits);
      loadTabs();
      loadKitchen();
    } catch (err) { setToast(err.message); }
  }
  function tabName(t) {
    if (t.fulfillment === 'togo' || t.fulfillment === 'pickup' || t.fulfillment === 'delivery') return t.label || t.customerName || t.guestName || fulfillmentName(t.fulfillment);
    return t.tableName || t.label || t.guestName || tr('Order');
  }
  function openTab(t, pay) {
    if (cart.length && !(currentTab && currentTab.id === t.id) && !window.confirm(tr('Put the order on the till aside and open {name}?', { name: tabName(t) }))) return;
    const lines = t.lines.map(lineFromTab);
    setCart(lines);
    setSentLines(lines);
    setFulfillment(t.fulfillment || 'dine_in');
    setDelivery({ name: t.customerName || '', phone: t.customerPhone || '', address: t.deliveryAddress || '' });
    setSelectedTable(t.tableId ? tables.find((x) => x.id === t.tableId) || { id: t.tableId, name: t.tableName } : null);
    setSelectedWaiter(t.waiterId ? { id: t.waiterId, name: t.waiterName } : null);
    setSelectedGuest(t.guestId ? { id: t.guestId, name: t.guestName, phone: t.guestPhone || '' } : null);
    setCurrentTab({ id: t.id, label: t.label, name: tabName(t), createdAt: t.createdAt, kitchen: t.kitchen });
    const a = t.adjust || {};
    setBillAdjust({ discount: a.discount || null, serviceOff: a.serviceOff || null, promoCode: a.promoCode || null, promo: a.promo || null, channel: a.channel || null });
    setGuests(t.guests || null); setSeat(null); setAllergy(t.allergy || null);
    setTabsOpen(false);
    // The customer's accounts (VIP, IOU) for the payment screen.
    if (t.guestId) refreshGuest(t.guestId, t.guestName);
    if (pay) { setCheckoutError(null); setCheckoutOpen(true); }
  }
  async function refreshGuest(id, name) {
    try {
      const list = await posFetch('GET', '/pos/guests?q=' + encodeURIComponent(name || ''), session.token);
      const g = list.find((x) => x.id === id);
      if (g) setSelectedGuest(g);
    } catch { /* the payment screen asks again */ }
  }
  async function dropTab(t) {
    if (!window.confirm(tr('Remove the open order for {name}? Nothing has been paid for it.', { name: tabName(t) }))) return;
    try {
      await posFetch('DELETE', '/pos/tabs/' + t.id, session.token);
      if (currentTab && currentTab.id === t.id) clearOrder();
      setToast(tr('Open order removed.'));
      loadTabs();
      loadShift();
    } catch (err) { setToast(err.message); }
  }
  async function reprint(orderId) {
    try {
      const r = await posFetch('GET', '/pos/orders/' + orderId + '/receipt', session.token);
      setDrawerPanelOpen(false);
      setReceipt({ ...r, reprint: true });
    } catch (err) { setToast(err.message); }
  }

  // Star Bar's real Square-imported menu runs into the thousands of items —
  // a touch grid that size is unusable without a way to jump straight to
  // an item, so filtering here isn't cosmetic.
  const searchedMenu = useMemo(() => menu.filter((m) => matchesQuery(search, m.name, m.category)), [menu, search]);
  const grouped = useMemo(() => {
    const map = new Map();
    searchedMenu.forEach((m) => {
      if (!map.has(m.category)) map.set(m.category, []);
      map.get(m.category).push(m);
    });
    return Array.from(map.entries());
  }, [searchedMenu]);

  const favoriteItems = useMemo(() => searchedMenu.filter((m) => m.favorite), [searchedMenu]);
  const recentItems = useMemo(() => {
    const byId = new Map(searchedMenu.map((m) => [m.id, m]));
    return recentIds.map((id) => byId.get(id)).filter(Boolean);
  }, [recentIds, searchedMenu]);
  const mostlyBoughtItems = useMemo(() => mostlyBought.filter((m) => matchesQuery(search, m.name, m.category)), [mostlyBought, search]);

  // What sells most first, every dish last.
  const VIEW_TABS = [
    { key: 'mostly', label: tr('Mostly bought'), icon: 'up' },
    { key: 'favorites', label: tr('Favorites'), count: favoriteItems.length, star: true },
    { key: 'recent', label: tr('Recent'), count: recentItems.length, icon: 'clock' },
    { key: 'all', label: tr('All items'), icon: 'layers' }
  ];
  const menuCategories = useMemo(() => Array.from(new Set(menu.map((m) => m.category).filter(Boolean))).sort(), [menu]);
  const liveTab = currentTab ? tabs.find((t) => t.id === currentTab.id) || null : null;

  function renderTile(m) {
    const hh = happyFor(tillSettings, m.category, now);
    const shut = categoryOpen(tillSettings, m.category, now) ? null : hoursOf(tillSettings, m.category).from;
    return <MenuTile key={m.id} m={m} qty={cartQtyById.get(m.id) || 0} tapped={tappedId === m.id} plusN={plus && plus.id === m.id ? plus.n : null} canFavorite={can('favorites')} onTap={onTileTap} onFavorite={onTileFavorite}
      happy={hh ? hh.percent : 0} closedFrom={shut} clash={clashes(m.allergens, allergy).length > 0} />;
  }
  const themeButton = <ThemeSwitch theme={theme} onChange={setTheme} className="pos-icon-btn" />;
  const firstName = session ? String(session.employeeName || '').split(' ').slice(0, -1).join(' ') || session.employeeName : '';
  const hour = now.getHours();
  const greeting = hour < 12 ? tr('Good morning, {name}', { name: firstName }) : hour < 17 ? tr('Good afternoon, {name}', { name: firstName }) : tr('Good evening, {name}', { name: firstName });
  const clock = now.toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' });
  const today = now.toLocaleDateString(activeIntlLocale(), { weekday: 'long', day: 'numeric', month: 'long' });
  const timeOf = (iso) => new Date(iso).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' });

  if (!sessionChecked) return null;

  if (!session) {
    return (
      <div className="dk pos-shell pos-gate">
        <span className="pos-orb is-a" aria-hidden="true" /><span className="pos-orb is-b" aria-hidden="true" />
        <div className="pos-gate-top"><DeviceLanguage className="pos-lang" />{themeButton}</div>
        <div className="pos-gate-card">
          <div className="pos-gate-side">
            <p className="dk-eyebrow">{today}</p>
            <div className="pos-clock">{clock}</div>
            <h1 className="pos-gate-title">{tr('Restaurant till')}</h1>
            <p className="dk-muted">{tr('Enter your 4-digit PIN, the same one you clock in with. The till then stays open for your shift on this device.')}</p>
            <div className="pos-gate-logos" aria-hidden="true">
              {['SBR', 'BGN'].map((c) => restaurantLogoUrl(c) && <img key={c} src={restaurantLogoUrl(c)} alt="" />)}
            </div>
          </div>
          <div className="pos-gate-pad">
            <div className="tc-mode" role="tablist" aria-label={tr('What for')}>
              <button type="button" role="tab" aria-selected={!clockMode} className={!clockMode ? 'is-on' : ''} onClick={() => setClockMode(false)}>🔓 {tr('Sign in')}</button>
              <button type="button" role="tab" aria-selected={clockMode} className={clockMode ? 'is-on' : ''} onClick={() => { setPin(''); setLoginError(null); setClockMode(true); }}>⏱ {tr('Time clock')}</button>
            </div>
            {clockMode ? <TimeClock onClose={() => setClockMode(false)} /> : <>
              <div className={'pos-pin' + (loginError ? ' is-bad' : '')} aria-label={tr('PIN')}>
                {Array.from({ length: PIN_LENGTH }).map((_, i) => <span key={i} className={i < pin.length ? 'is-on' : ''} />)}
              </div>
              <p className={'pos-pin-note' + (loginError ? ' is-bad' : '')} role="status">
                {loggingIn ? tr('Checking…') : loginError || (idleNote && drawerLeftOpen ? tr('Signed out after {n} minutes without use. The cash drawer stays open: tap your PIN to carry on.', { n: idleNote })
                  : idleNote ? tr('Signed out after {n} minutes without use. Tap your PIN to carry on.', { n: idleNote })
                    : drawerLeftOpen ? tr('Signed out. The cash drawer stays open until it is counted and closed: tap your PIN to carry on.') : tr('Tap your PIN or type it.'))}
              </p>
              <div className="pos-keypad">
                {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                  <button key={d} type="button" disabled={loggingIn} onClick={() => tapDigit(d)}>{d}</button>
                ))}
                <button type="button" className="is-muted" disabled={loggingIn} onClick={tapClear}>{tr('Clear')}</button>
                <button type="button" disabled={loggingIn} onClick={() => tapDigit('0')}>0</button>
                <button type="button" className="is-muted" disabled={loggingIn} onClick={tapBackspace} aria-label={tr('Backspace')}>⌫</button>
              </div>
            </>}
          </div>
        </div>
      </div>
    );
  }

  if (!drawerChecked || !tillAccess) return null;

  // A cashier can't ring anything up until their own drawer is open — same
  // "count starting cash before you sell" step a real POS shift begins
  // with, and what makes the report at close-out complete (see
  // restaurantPos.service.js's buildReport: Cash Sales is summed from
  // this session's own opened_at onward).
  // Someone who does not take payments (a waiter) has no drawer to open.
  // Another cashier has the drawer: this one takes orders until they close
  // it. A manager is not held back: they open their own beside it, or not
  // now and only take orders.
  const otherOnDuty = tillAccess.cashierOnDuty && !tillAccess.cashierOnDuty.me ? tillAccess.cashierOnDuty : null;
  const dutyBlocks = !!otherOnDuty && !isManager;

  // A manager's back office: reports, the menu and stock, the setup — one
  // tap from the till, and back.
  if (isManager && officeOpen) {
    return (
      <div className="dk pos-shell pos-till" data-brand={session.companyCode}>
        <ManagerHome token={session.token} companyName={session.companyName} employeeName={session.employeeName} logoUrl={restaurantLogoUrl(session.companyCode)}
          tools={<>
            <button type="button" className="btn btn-primary tl-btn mh-back" onClick={() => setOfficeOpen(false)}><Icon name="cash" />{drawer ? tr('Back to the till') : tr('To the till')}</button>
            <DeviceLanguage className="pos-lang" />{themeButton}<button type="button" className="btn btn-secondary tl-btn" onClick={logout}>{tr('Log out')}</button>
          </>}
          onOpen={(t) => setSettingsOpen(t)} />
        {settingsOpen && (
          <TillSettings token={session.token} companyName={session.companyName} logoUrl={restaurantLogoUrl(session.companyCode)} initialTab={typeof settingsOpen === 'string' ? settingsOpen : undefined}
            onClose={() => setSettingsOpen(false)} onSaved={() => loadAccess()} onAuth={sessionEnded} />
        )}
      </div>
    );
  }

  if (!drawer && !closedReport && can('charge') && !ordersOnly && !dutyBlocks) {
    const last = shift && shift.lastClosed;
    const quick = [0, 100, 200, 500, 1000];
    return (
      <div className="dk pos-shell pos-gate" data-brand={session.companyCode}>
        <span className="pos-orb is-a" aria-hidden="true" /><span className="pos-orb is-b" aria-hidden="true" />
        <div className="pos-gate-top">
          {isManager && <button type="button" className="btn btn-secondary tl-btn" onClick={() => setOfficeOpen(true)}><Icon name="key" />{tr('Back office')}</button>}
          <DeviceLanguage className="pos-lang" />
          {themeButton}
          <button type="button" className="btn btn-secondary tl-btn" onClick={logout}>{tr('Log out')}</button>
        </div>
        <div className="pos-gate-card">
          <div className="pos-gate-side">
            {restaurantLogoUrl(session.companyCode) && <img className="pos-gate-logo" src={restaurantLogoUrl(session.companyCode)} alt="" />}
            <p className="dk-eyebrow">{session.companyName} · {today}</p>
            <h1 className="pos-gate-title">{greeting}</h1>
            <p className="dk-muted">{tr('Count the cash in the drawer before your first sale. At the end of your shift you count it again, and the till shows whether it adds up.')}</p>
            {isManager && otherOnDuty && (
              <div className="pos-note is-duty">
                <Icon name="drawer" />
                <span>{tr('{name} is the cashier on duty, drawer open since {time}. As a manager you open your own beside it: what you charge goes in yours, not theirs.', { name: otherOnDuty.name, time: timeOf(otherOnDuty.since) })}</span>
              </div>
            )}
            {last && (
              <div className="pos-note">
                <Icon name="info" />
                <span>{tr('The last drawer was closed by {name} on {date} with {amount} counted.', { name: last.cashierName, date: new Date(last.closedAt).toLocaleString(activeIntlLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }), amount: money(last.counted) })}</span>
              </div>
            )}
            {shift && shift.openTabs > 0 && (
              <div className="pos-note is-warn">
                <Icon name="clock" />
                <span>{shift.openTabs === 1 ? tr('1 table is still open from before. You can pay it once your drawer is open.') : tr('{n} tables are still open from before. You can pay them once your drawer is open.', { n: shift.openTabs })}</span>
              </div>
            )}
          </div>
          <form className="pos-gate-pad pos-open-form" onSubmit={submitOpenDrawer}>
            <label htmlFor="opening-cash" className="pos-big-label">{tr('Starting cash in the drawer')}</label>
            <input
              id="opening-cash" className="input pos-big-input" type="number" min="0" step="0.01" inputMode="decimal" autoFocus
              value={openingCash} onChange={(e) => setOpeningCash(e.target.value)} placeholder="0.00"
            />
            <div className="pos-quick">
              {quick.map((q) => <button key={q} type="button" className={Number(openingCash) === q && openingCash !== '' ? 'is-on' : ''} onClick={() => setOpeningCash(String(q))}>{money(q)}</button>)}
              {last && last.counted > 0 && !quick.includes(last.counted) && <button type="button" onClick={() => setOpeningCash(String(last.counted))}>{tr('Last count {amount}', { amount: money(last.counted) })}</button>}
            </div>
            {openDrawerError && <div className="error-banner">{openDrawerError}</div>}
            <button type="submit" className="btn btn-primary pos-big-btn" disabled={openingDrawer}>
              {openingDrawer ? tr('Opening…') : tr('Open drawer and start selling')}
            </button>
            {isManager && <button type="button" className="pos-link pos-skip" onClick={() => setOrdersOnly(true)}>{tr('Not now: take orders without a drawer')}</button>}
          </form>
        </div>
      </div>
    );
  }

  if (closedReport) {
    const r = closedReport;
    const diffTone = r.difference === null ? '' : Math.abs(r.difference) < 0.01 ? 'good' : r.difference < 0 ? 'bad' : 'warn';
    return (
      <div className="dk pos-shell pos-done" data-brand={session.companyCode}>
        <div className="pos-receipt-print" id="pos-receipt">
          {restaurantLogoUrl(session.companyCode) && (
            <img className="pos-receipt-logo" src={restaurantLogoUrl(session.companyCode)} alt="" />
          )}
          <div className="pos-receipt-header">{tr('Drawer Report:')} {session.employeeName}</div>
          <div className="pos-receipt-meta">
            {new Date(r.session.openedAt).toLocaleString(activeIntlLocale())} –<br />
            {new Date(r.session.closedAt).toLocaleString(activeIntlLocale())}<br />
            {session.companyName}
          </div>
          <div className="pos-receipt-rule" />
          <div className="pos-receipt-lines">
            <div className="pos-receipt-line"><span>{tr('Starting Cash')}</span><span>{money(r.startingCash)}</span></div>
            <div className="pos-receipt-line"><span>{tr('Cash Sales')}</span><span>{money(r.cashSales)}</span></div>
            {r.iouPaidCash > 0 && <div className="pos-receipt-line"><span>{tr('IOUs paid in cash')}</span><span>{money(r.iouPaidCash)}</span></div>}
            {r.vipTopUpsCash > 0 && <div className="pos-receipt-line"><span>{tr('VIP money in cash')}</span><span>{money(r.vipTopUpsCash)}</span></div>}
            <div className="pos-receipt-line"><span>{tr('Cash Refunds')}</span><span>{money(r.cashRefunds)}</span></div>
            {r.vipCashOutsCash > 0 && <div className="pos-receipt-line"><span>{tr('VIP money given back')}</span><span>-{money(r.vipCashOutsCash)}</span></div>}
            {r.iouLentCash > 0 && <div className="pos-receipt-line"><span>{tr('Cash lent on IOU accounts')}</span><span>-{money(r.iouLentCash)}</span></div>}
            <div className="pos-receipt-line"><span>{tr('Paid In/Out')}</span><span>{r.netPaidInOut < 0 ? '-' : ''}{money(Math.abs(r.netPaidInOut))}</span></div>
            {r.safeDrops > 0 && <div className="pos-receipt-line"><span>{tr('Into the safe')}</span><span>-{money(r.safeDrops)}</span></div>}
            {r.pettyCash > 0 && <div className="pos-receipt-line"><span>{tr('Petty cash')}</span><span>-{money(r.pettyCash)}</span></div>}
            <div className="pos-receipt-line"><span>{tr('Expected in Drawer')}</span><span>{money(r.expected)}</span></div>
            <div className="pos-receipt-line"><span>{tr('Actual in Drawer')}</span><span>{money(r.actual)}</span></div>
          </div>
          <div className="pos-receipt-rule" />
          <div className="pos-receipt-total">
            <span>{tr('Difference')}</span><span>{r.difference < 0 ? '-' : ''}{money(Math.abs(r.difference))}</span>
          </div>
          {!!r.movements.length && (
            <>
              <div className="pos-receipt-rule" />
              <div className="pos-receipt-footer" style={{ fontWeight: 700, marginBottom: 6 }}>{tr('PAID IN/OUT')}</div>
              <div className="pos-receipt-lines">
                {r.movements.map((m) => (
                  <div key={(m.account || '') + m.id} className="pos-receipt-line">
                    <span>{m.account ? moveLabel(m) + ' · ' + timeOf(m.createdAt)
                      : m.kind === 'drop' ? tr('Into the safe at {time}', { time: timeOf(m.createdAt) })
                        : m.kind === 'petty' ? tr('Petty cash at {time}', { time: timeOf(m.createdAt) }) + (m.paidTo ? ' · ' + m.paidTo : '')
                          : m.kind === 'event' ? tr('Event deposit at {time}', { time: timeOf(m.createdAt) })
                            : m.direction === 'in' ? tr('Paid in at {time}', { time: timeOf(m.createdAt) }) : tr('Paid out at {time}', { time: timeOf(m.createdAt) })}{m.note && !(m.kind === 'drop' && m.note === 'Into the safe') ? ' — ' + m.note : ''}</span>
                    <span>{m.direction === 'out' ? '-' : ''}{money(m.amount)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="pos-done-side">
          <span className={'pos-done-mark is-' + (diffTone || 'good')}><Icon name={diffTone === 'bad' || diffTone === 'warn' ? 'warn' : 'check'} /></span>
          <h1 className="pos-gate-title">{tr('Drawer closed')}</h1>
          <p className="pos-done-big">
            {diffTone === 'good' ? tr('The count matches exactly.') : r.difference < 0 ? tr('{amount} short', { amount: money(-r.difference) }) : tr('{amount} over', { amount: money(r.difference) })}
          </p>
          <p className="dk-muted">{tr('Expected {expected}, counted {actual}. Managers see this report under Restaurants → Cash drawers.', { expected: money(r.expected), actual: money(r.actual) })}</p>
          {printerError && <div className="error-banner pos-printer-error">{printerError}</div>}
          <div className="pos-done-actions">
            <button type="button" className="btn btn-secondary" onClick={() => window.print()}>{tr('Print report')}</button>
            {printer && (
              <button type="button" className="btn btn-secondary" disabled={printing} onClick={() => printDrawerReportThermal(closedReport)}>
                {printing ? tr('Printing…') : tr('Print via {name}', { name: printer.name })}
              </button>
            )}
            <button type="button" className="btn btn-primary" onClick={logout}>{tr('Done, log out')}</button>
          </div>
        </div>
      </div>
    );
  }

  if (receipt) {
    // Served by the waiter who looked after the table; the cashier who took
    // the money is named under it. Without a waiter, the cashier served.
    const cashier = receipt.cashierName || session.employeeName;
    const server = receipt.waiterName || cashier;
    return (
      <div className="dk pos-shell pos-done" data-brand={session.companyCode}>
        {!receipt.reprint && <span className="pos-confetti" aria-hidden="true">{Array.from({ length: 44 }, (_, i) => <i key={i} style={{ '--i': i, '--x': (i * 53) % 97, '--r': ((i * 37) % 17) / 17 }} />)}</span>}
        <div className="pos-receipt-print" id="pos-receipt">
          {tillSettings.receipt.showLogo && restaurantLogoUrl(session.companyCode) && (
            <img className="pos-receipt-logo" src={restaurantLogoUrl(session.companyCode)} alt="" />
          )}
          <div className="pos-receipt-header">{session.companyName}</div>
          {tillSettings.receipt.extra && <div className="pos-receipt-extra">{tillSettings.receipt.extra}</div>}
          <div className="pos-receipt-meta">
            {tr('Order {orderNo}', { orderNo: receipt.orderNo })}{receipt.fulfillment ? ' · ' + fulfillmentName(receipt.fulfillment) : ''}<br />
            {new Date(receipt.createdAt).toLocaleString(activeIntlLocale())}<br />
            {receipt.tableName
              ? tr('Served by {name} at {table}', { name: server, table: receipt.tableName })
              : tr('Served by {name}', { name: server })}
            {receipt.waiterName && <><br />{tr('Cashier: {name}', { name: cashier })}</>}
            {(receipt.guestName || receipt.customerName) && <><br />{tr('Customer:')} {receipt.guestName || receipt.customerName}</>}
            {receipt.fulfillment === 'delivery' && <><br />{tr('Deliver to:')} {receipt.deliveryAddress}{receipt.customerPhone ? ' · ' + receipt.customerPhone : ''}</>}
          </div>
          <div className="pos-receipt-rule" />
          <ReceiptLines receipt={receipt} />
          {receipt.payments && (receipt.payments.length > 1 || (receipt.payments[0] && (receipt.payments[0].currency !== 'GHS' || receipt.payments[0].tendered != null))) ? (
            <div className="pos-receipt-lines pos-receipt-cash">
              {receipt.payments.map((p, i) => (
                <div key={i} className="pos-receipt-line">
                  <span>{methodName(p.method)}{p.giftCard ? ' •••• ' + p.giftCard : ''}{p.currency !== 'GHS' ? ' · ' + fmt(p.foreignAmount, p.currency) + ' @ ' + p.rate : ''}{p.tendered != null ? ' · ' + tr('received {amount}', { amount: fmt(p.tendered, p.currency) }) : ''}</span>
                  <span>{money(p.amount)}</span>
                </div>
              ))}
              {receipt.change > 0 && <div className="pos-receipt-line"><span>{tr('Change due')}</span><span>{money(receipt.change)}</span></div>}
            </div>
          ) : receipt.cashTendered != null && (
            <div className="pos-receipt-lines pos-receipt-cash">
              <div className="pos-receipt-line"><span>{tr('Cash')}</span><span>{money(receipt.cashTendered)}</span></div>
              <div className="pos-receipt-line"><span>{tr('Change due')}</span><span>{money(receipt.change)}</span></div>
            </div>
          )}
          {receipt.refunds && receipt.refunds.length > 0 && (
            <div className="pos-receipt-lines pos-receipt-refunds">
              {receipt.refunds.map((x) => (
                <div key={x.id} className="pos-receipt-line"><span>{tr('Refunded {date}', { date: new Date(x.createdAt).toLocaleDateString(activeIntlLocale()) })} ({x.items.map((i) => i.qty + '× ' + i.name).join(', ')})</span><span>−{money(x.amount)}</span></div>
              ))}
              <div className="pos-receipt-line is-net"><span>{tr('After refunds')}</span><span>{money(receipt.total - receipt.refunded)}</span></div>
            </div>
          )}
          <div className="pos-receipt-footer">
            {receipt.paymentMethod === 'vip' ? tr('Paid from {name}\'s VIP account', { name: receipt.guestName || tr('the customer') })
              : receipt.paymentMethod === 'iou' ? (receipt.iouPaidAt ? tr('IOU, paid {date}', { date: new Date(receipt.iouPaidAt).toLocaleDateString(activeIntlLocale()) }) : tr('IOU: owed by {name}', { name: receipt.guestName || tr('the customer') }))
                : receipt.paymentMethod === 'split' ? tr('Split payment')
                  : <>{tr('Paid by')} {methodName(receipt.paymentMethod)}</>}
            {receipt.vipBalance != null && <><br />{tr('VIP balance left: {amount}', { amount: money(receipt.vipBalance) })}</>}
            {tillSettings.receipt.footer && <><br /><b className="pos-receipt-thanks">{tillSettings.receipt.footer}</b></>}
          </div>
          {receipt.receiptUrl && !receipt.offline && (
            <div className="pos-receipt-qr">
              <ReceiptQr url={receipt.receiptUrl} />
              <small>{tr('Scan for this receipt on your phone')}</small>
            </div>
          )}
        </div>
        <div className="pos-done-side">
          <span className="pos-done-mark is-good is-burst"><Icon name="check" /></span>
          <h1 className="pos-gate-title">{receipt.reprint ? tr('Receipt for {no}', { no: receipt.orderNo }) : tr('Sale complete')}</h1>
          {!receipt.reprint && receipt.change != null && receipt.change > 0 && (
            <p className="pos-done-big">{tr('Give {amount} change', { amount: money(receipt.change) })}</p>
          )}
          {!receipt.reprint && (receipt.change == null || receipt.change === 0) && (
            <p className="pos-done-big">
              {receipt.paymentMethod === 'iou' ? tr('{amount} owed by {name}', { amount: money(receipt.total), name: receipt.guestName || tr('the customer') })
                : receipt.paymentMethod === 'vip' ? tr('{amount} from {name}\'s VIP account', { amount: money(receipt.total), name: receipt.guestName || tr('the customer') })
                  : receipt.paymentMethod === 'split' ? tr('{amount} paid {n} ways', { amount: money(receipt.total), n: (receipt.payments || []).length })
                    : tr('{amount} paid by {method}', { amount: money(receipt.total), method: methodName(receipt.paymentMethod) })}
            </p>
          )}
          {!receipt.reprint && receipt.vipBalance != null && <p className="dk-muted">{tr('VIP balance left: {amount}', { amount: money(receipt.vipBalance) })}</p>}
          {!receipt.reprint && (receipt.giftCards || []).map((g) => <p key={g.card} className="dk-muted">🎁 {tr('Gift card •••• {card}: {amount} left', { card: g.card, amount: money(g.left) })}</p>)}
          {!receipt.reprint && receipt.tip > 0 && <p className="pos-done-tip">💛 {tr('Tip {amount}, thank you!', { amount: money(receipt.tip) })}</p>}
          {!receipt.reprint && receipt.points && (receipt.points.earned > 0 || receipt.points.used > 0) && (
            <p className="pos-done-points">⭐ {tr('{name}: {earned} points earned, {balance} now', { name: receipt.points.name || receipt.guestName || tr('the customer'), earned: receipt.points.earned, balance: receipt.points.balance })}</p>
          )}
          {!receipt.reprint && receipt.kitchenTicket && <p className="pos-sent"><Icon name="send" />{tr('Sent to the kitchen as #{n}.', { n: receipt.kitchenTicket.number })}</p>}
          {receipt.offline && <p className="pos-offline-note">📡 {tr('Taken without the internet: kept on this till and sent to the server when it is back. Its number comes then.')}</p>}
          {receipt.restOpen && (
            <p className="pos-sent"><Icon name="clock" />{tr('The rest of {name} stays open.', { name: receipt.restName || tr('the order') })}
              <button type="button" className="pos-link" onClick={() => { const t = tabs.find((x) => x.id === receipt.restOpen); setReceipt(null); if (t) openTab(t, true); }}>{tr('Pay the rest')}</button></p>
          )}
          <SendReceipt token={session.token} receipt={receipt} companyName={session.companyName} onToast={setToast} />
          <p className="dk-muted">{receipt.reprint ? tr('A copy of an order from this shift.') : tr('Print the receipt if the guest wants one, then start the next sale.')}</p>
          {printerError && <div className="error-banner pos-printer-error">{printerError}</div>}
          <div className="pos-done-actions">
            <button type="button" className="btn btn-secondary" onClick={() => window.print()}>{tr('Print receipt')}</button>
            {printer && (
              <button type="button" className="btn btn-secondary" disabled={printing} onClick={() => printToThermalPrinter(receipt)}>
                {printing ? tr('Printing…') : tr('Print via {name}', { name: printer.name })}
              </button>
            )}
            {receipt.reprint && onDuty('refund') && receipt.status !== 'voided' && receipt.refunded < receipt.total && (
              <button type="button" className="btn btn-secondary" onClick={() => { const id = receipt.id; setReceipt(null); setRefundFor(id); }}>{tr('Refund…')}</button>
            )}
            <button type="button" className="btn btn-primary" onClick={() => setReceipt(null)} autoFocus>{receipt.reprint ? tr('Back to the till') : tr('New sale')}</button>
          </div>
        </div>
      </div>
    );
  }

  const cartCount = cart.reduce((n, l) => n + l.qty, 0);
  const categories = grouped.map(([c, items]) => [c, items.length]);
  const shownGroups = category ? grouped.filter(([c]) => c === category) : grouped;
  // All items, A to Z (till/AzRail.jsx), within the category picked if any.
  const azShown = viewTab === 'all' ? azGroups(shownGroups.reduce((a, g) => a.concat(g[1]), [])) : [];
  const avgOrder = shift && shift.orders ? shift.sales / shift.orders : 0;

  const orderPanel = (
    <section className={'pos-order' + (cartOpen ? ' is-open' : '')} aria-label={tr('Current order')}>
      <div className="pos-order-head">
        <span className="pos-order-ico" aria-hidden="true"><Icon name="receipt" />{cartCount > 0 && <b key={cartCount}>{cartCount}</b>}</span>
        <div className="pos-order-titles">
          <h2 className="pos-order-title">{currentTab ? currentTab.name : tr('New order')}</h2>
          <p className="dk-muted">
            {currentTab ? tr('Open since {time}. Add to it, send the new round, or charge it.', { time: timeOf(currentTab.createdAt) }) : cartCount ? (cartCount === 1 ? tr('1 item') : tr('{n} items', { n: cartCount })) : tr('Tap a dish to start.')}
          </p>
          {liveTab && liveTab.kitchen && <KitchenTag kitchen={liveTab.kitchen} />}
          {liveTab && (liveTab.paidAtTable || []).length > 0 && (
            <span className="tbill-chip">💳 {paidAheadWords(liveTab.paidAtTable, money(liveTab.paidAtTable.reduce((a, p) => a + p.amount - (p.tip || 0), 0)), tr)}</span>
          )}
        </div>
        <div className="pos-order-head-tools">
          {liveTab && liveTab.tableId && <button type="button" className="pos-link tbill-open" onClick={() => setBillOpen(true)}>🧾 {tr('Bill')}</button>}
          {(cart.length > 0 || currentTab) && <button type="button" className="pos-link" onClick={clearOrder}>{currentTab ? tr('Put aside') : tr('Clear')}</button>}
          <button type="button" className="pos-icon-btn pos-sheet-close" onClick={() => setCartOpen(false)} aria-label={tr('Close')}>×</button>
        </div>
      </div>
      {appOrder && <AppBanner app={appOrder} total={cartTotal} onChange={() => setAppPickOpen(true)} onCancel={() => setAppOrder(null)} />}
      {!appOrder && (<>
      <div className="tl-ful-switch" role="radiogroup" aria-label={tr('Dine in, to go, pickup or delivery')}>
        {FULFILLMENT.map((f) => (
          <button key={f.key} type="button" role="radio" aria-checked={fulfillment === f.key} className={'is-' + f.key + (fulfillment === f.key ? ' is-on' : '')}
            onClick={() => {
              setFulfillment(f.key);
              if (f.key === 'delivery' && !(delivery.name && delivery.phone && delivery.address)) setDeliveryOpen(true);
              if (f.key === 'pickup' && !(delivery.name || (selectedGuest && selectedGuest.name)) ) setDeliveryOpen(true);
            }}>
            <FulfillmentIcon kind={f.key} /><span>{tr(f.label)}</span>
          </button>
        ))}
      </div>
      <div className={'pos-order-who is-' + fulfillment}>
        {fulfillment === 'dine_in' && (<>
          <button type="button" className={selectedTable ? 'is-set' : tables.length ? 'is-needed' : ''} onClick={() => setTablePickerOpen(true)}>
            <WhoGlyph name="table" /><small>{tr('Table')}</small><span>{selectedTable ? selectedTable.name : tables.length ? tr('Pick one') : tr('None')}</span>
          </button>
          <button type="button" className={selectedWaiter ? 'is-set' : ''} onClick={() => setWaiterPickerOpen(true)}>
            <WhoGlyph name="waiter" /><small>{tr('Waiter')}</small><span>{selectedWaiter ? selectedWaiter.name : tr('None')}</span>
          </button>
        </>)}
        {fulfillment === 'togo' && (
          <span className="pos-who-fixed is-togo"><FulfillmentIcon kind="togo" /><small>{tr('To go')}</small><span>{tr('Packed to take away')}</span></span>
        )}
        {fulfillment === 'pickup' && (
          <button type="button" className={'pos-who-wide' + (pickupWho().name && pickupWho().phone ? ' is-set' : ' is-needed')} onClick={() => setDeliveryOpen(true)}>
            <Icon name="bag" /><small>{tr('Pickup for')}</small><span>{pickupWho().name ? pickupWho().name + (pickupWho().phone ? ' · ' + pickupWho().phone : '') : tr('Name and phone')}</span>
          </button>
        )}
        {fulfillment === 'delivery' && (
          <button type="button" className={'pos-who-wide' + (delivery.address ? ' is-set' : ' is-needed')} onClick={() => setDeliveryOpen(true)}>
            <Icon name="send" /><small>{tr('Deliver to')}</small><span>{delivery.address || tr('Location, name and phone')}</span>
          </button>
        )}
        <button type="button" className={selectedGuest ? 'is-set' : ''} onClick={openGuestPicker}>
          <WhoGlyph name="guest" /><small>{tr('Customer')}</small>
          <span>{selectedGuest ? selectedGuest.name : fulfillment === 'delivery' && delivery.name ? delivery.name : tr('None')}</span>
          {selectedGuest && (selectedGuest.vip || selectedGuest.iouAllowed || selectedGuest.points > 0) && (
            <em className="pos-who-accts">{selectedGuest.vip && <b className="is-vip">{tr('VIP')}</b>}{selectedGuest.iouAllowed && <b className="is-iou">{tr('IOU')}</b>}{selectedGuest.points > 0 && <b className="is-pts">⭐ {selectedGuest.points}</b>}</em>
          )}
        </button>
      </div>
      </>)}
      {fulfillment === 'dine_in' && !appOrder && (
        <div className="pos-service">
          <div className="pos-guests" role="group" aria-label={tr('Guests')}>
            <span aria-hidden="true">👥</span>
            <button type="button" onClick={() => setGuests(guests > 1 ? guests - 1 : null)} disabled={!guests} aria-label={tr('One guest less')}>−</button>
            <b>{guests || '–'}</b>
            <button type="button" onClick={() => setGuests(Math.min(200, (guests || 0) + 1))} aria-label={tr('One guest more')}>+</button>
            <small>{guests === 1 ? tr('guest') : tr('guests')}</small>
          </div>
          {guests > 1 && (
            <div className="pos-seats" role="radiogroup" aria-label={tr('New dishes for')}>
              <button type="button" role="radio" aria-checked={!seat} className={!seat ? 'is-on' : ''} onClick={() => setSeat(null)}>{tr('Table')}</button>
              {Array.from({ length: Math.min(guests, 12) }, (_, i) => i + 1).map((n) => (
                <button key={n} type="button" role="radio" aria-checked={seat === n} className={seat === n ? 'is-on' : ''} onClick={() => setSeat(n)} title={tr('Seat {n}', { n })}>{n}</button>
              ))}
            </div>
          )}
          <span className="pos-service-end">
            {kitchen && kitchen.inUse && !noteOpen && !kitchenNote && <button type="button" className="pos-chip-add" onClick={() => setNoteOpen(true)} title={tr('Add a note for the whole order')}>✎ {tr('Note')}</button>}
            {!allergy && <button type="button" className="pos-allergy-add" onClick={() => setAllergyOpen(true)}>⚠ {tr('Allergy')}</button>}
          </span>
        </div>
      )}
      {fulfillment !== 'dine_in' && !appOrder && ((kitchen && kitchen.inUse && !noteOpen && !kitchenNote) || !allergy) && (
        <div className="pos-service is-chips">
          <span className="pos-service-end">
            {kitchen && kitchen.inUse && !noteOpen && !kitchenNote && <button type="button" className="pos-chip-add" onClick={() => setNoteOpen(true)} title={tr('Add a note for the whole order')}>✎ {tr('Note')}</button>}
            {!allergy && <button type="button" className="pos-allergy-add" onClick={() => setAllergyOpen(true)}>⚠ {tr('Allergy alert')}</button>}
          </span>
        </div>
      )}
      <AllergyStrip allergy={allergy} onClick={() => setAllergyOpen(true)} />
      {kitchen && kitchen.inUse && (noteOpen || kitchenNote) && (
        <div className="pos-knote">
          <input className="input" value={kitchenNote} maxLength={300} autoFocus={noteOpen && !kitchenNote} onChange={(e) => setKitchenNote(e.target.value)}
            placeholder={tr('Note for the whole order, e.g. bring the drinks first')} aria-label={tr('Note for the kitchen')} />
          <button type="button" className="pos-link" onClick={() => { setKitchenNote(''); setNoteOpen(false); }}>{tr('Remove')}</button>
        </div>
      )}
      <div className="pos-lines">
        {!cart.length && (
          <div className="pos-lines-empty">
            <span className="pos-empty-art" aria-hidden="true"><Icon name="bag" /><i /><i /><i /></span>
            <strong>{tr('Ready for the next order')}</strong>
            <p>{tr('Nothing on this order yet. Tap dishes on the left; tap again to add another.')}</p>
            <ol className="pos-steps">
              <li><b>1</b>{tr('Dine in, to go, pickup or delivery')}</li>
              <li><b>2</b>{tr('Tap the dishes; ✎ adds a note to one')}</li>
              <li><b>3</b>{tr('Send it to the kitchen, or charge it')}</li>
            </ol>
          </div>
        )}
        {cart.map((l, i) => {
          const k = lineKey(l);
          const b = bill.lines[i] || { gross: l.price * l.qty, net: l.price * l.qty, discount: 0 };
          const item = l.menuItemId ? menuById.get(l.menuItemId) : null;
          const hasAddOns = !!(item && item.addOns && item.addOns.length);
          const off = l.comp ? tr('On the house') : l.discountSpec ? (l.discountSpec.kind === 'percent' ? '−' + l.discountSpec.value + '%' : '−' + money(l.discountSpec.value)) : null;
          const bad = clashes(l.allergens || (item && item.allergens), allergy);
          const coursesOn = tillSettings.courses && tillSettings.courses.on && fulfillment === 'dine_in' && !l.custom;
          const course = coursesOn ? courseOf(tillSettings, { course: l.course, category: l.category || (item && item.category) }) : 0;
          return (
            <div key={k} className={'pos-line' + (l.custom ? ' is-custom' : '') + (l.comp ? ' is-comp' : '') + ((l.modifiers || []).length ? ' has-mods' : '') + (bad.length ? ' is-clash' : '')}>
              <span className="pos-line-dot" style={{ '--c': tileColor(l.name) }} aria-hidden="true">{l.custom ? '✦' : tileInitial(l.name.replace(/^zq\s+/i, ''))}</span>
              <div className="pos-line-main">
                <span className="pos-line-name">{l.name}</span>
                {(l.modifiers || []).length > 0 && (
                  hasAddOns
                    ? <button type="button" className="pos-line-mods" onClick={() => editAddOns(l)} title={tr('Change the add-ons')}>✚ {modsWords(l.modifiers, tr)}</button>
                    : <span className="pos-line-mods">✚ {modsWords(l.modifiers, tr)}</span>
                )}
                <span className="dk-muted">{money(appOrder && appOrder.markup ? round2(l.price * (1 + appOrder.markup / 100)) : l.price)}{l.qty > 1 ? ' × ' + l.qty : ''}</span>
                <span className="pos-line-extra">
                  {bad.length > 0 && <em className="pos-line-clash">⚠ {bad.map((x) => allergenWords(x, tr)).join(', ')}</em>}
                  {guests > 1 && (
                    <button type="button" className={'pos-line-seat' + (l.seat ? ' is-set' : '')} title={tr('Which seat')}
                      onClick={() => changeLine(k, { seat: l.seat && l.seat < Math.min(guests, 12) ? l.seat + 1 : l.seat ? null : 1 })}>
                      {l.seat ? tr('Seat {n}', { n: l.seat }) : tr('Table')}
                    </button>
                  )}
                  {coursesOn && (
                    <button type="button" className={'pos-line-course is-c' + course} title={tr('Its course: tap to change')}
                      onClick={() => changeLine(k, { course: course < (tillSettings.courses.names || []).length ? course + 1 : 0 })}>
                      {course ? course + ' · ' + courseName(tillSettings, course, tr) : '⚡ ' + courseName(tillSettings, 0, tr)}
                    </button>
                  )}
                  {l.custom && <em className="tl-badge">{tr('not on the menu')}</em>}
                  {hasAddOns && !(l.modifiers || []).length && <button type="button" className="pos-line-note" onClick={() => editAddOns(l)}>✚ {tr('Add-ons')}</button>}
                  {/* Unused, a note and a discount are small icons; set, they say what they are. */}
                  <button type="button" className={'pos-line-note' + (l.note ? ' is-set' : ' is-icon')} onClick={() => setNoteFor(l)} title={tr('Add a note')} aria-label={l.note ? undefined : tr('Add a note')}>
                    ✎{l.note ? ' ' + l.note : ''}
                  </button>
                  {!l.fee && !(l.custom && l.custom.fee) && (
                    <button type="button" className={'pos-line-off' + (off ? ' is-set' : ' is-icon')} onClick={() => setOffFor(l)} title={l.comp ? l.comp.reason : l.discountSpec ? l.discountSpec.name : tr('A discount, or on the house')} aria-label={off ? undefined : tr('Discount')}>
                      %{off ? ' ' + off : ''}
                    </button>
                  )}
                </span>
              </div>
              <div className="pos-stepper">
                <button type="button" onClick={() => changeQty(k, -1)} aria-label={tr('Decrease')}>−</button>
                <span>{l.qty}</span>
                <button type="button" onClick={() => changeQty(k, 1)} aria-label={tr('Increase')}>+</button>
              </div>
              <span key={l.qty + ':' + b.net} className="pos-line-total">
                {b.dealName && <em className="pos-line-deal" title={b.dealName}>🎟️</em>}
                {b.discount > 0 && <s>{money(b.gross)}</s>}
                {money(b.net)}
              </span>
              <button type="button" className="pos-line-x" onClick={() => removeLine(k)} aria-label={tr('Remove')}>×</button>
            </div>
          );
        })}
      </div>
      <div className="pos-order-foot">
        <span className="pos-ticket-edge" aria-hidden="true" />
        {cart.length > 0 && (bill.discountTotal > 0 || bill.serviceOn || bill.taxes.length > 0) && (
          <div className="pos-bill">
            <div><span>{tr('Dishes')}</span><b>{money(bill.itemsGross)}</b></div>
            {/* The deal on its own line (till/promos.js), the other discounts beside it. */}
            {bill.deal && <div className="is-deal"><span>🎟️ {bill.deal.name}{bill.deal.code && <small>{bill.deal.code}</small>}</span><b>−{money(bill.deal.amount)}</b></div>}
            {bill.discountTotal - (bill.deal ? bill.deal.amount : 0) > 0.004 && <div className="is-off"><span>{tr('Discounts')}{bill.billDiscountName ? ' · ' + bill.billDiscountName : ''}</span><b>−{money(bill.discountTotal - (bill.deal ? bill.deal.amount : 0))}</b></div>}
            {bill.serviceOn && (
              <div className={bill.serviceOff ? 'is-struck' : ''}>
                <span>{bill.partyService ? '👨‍👩‍👧‍👦 ' : ''}{serviceWords(bill.serviceName, tr)} {bill.serviceOff ? '· ' + tr('taken off') : (bill.serviceRate || (bill.partyService ? tillSettings.partyService.rate : tillSettings.serviceCharge.rate)) + '%'}</span>
                <b>{money(bill.serviceCharge)}</b>
              </div>
            )}
            {bill.taxes.filter((t) => !t.included).map((t) => <div key={t.name}><span>{t.name} {t.rate}%</span><b>{money(t.amount)}</b></div>)}
            {/* Taxes already in the prices: one line, opened to see each. */}
            {bill.taxes.some((t) => t.included) && (
              <button type="button" className="is-incl pos-incl-toggle" aria-expanded={taxesOpen} onClick={() => setTaxesOpen(!taxesOpen)}>
                <span>{taxesOpen ? '▾' : '▸'} {tr('incl. taxes')} <small>{bill.taxes.filter((t) => t.included).map((t) => t.name).join(', ')}</small></span>
                <b>{money(bill.taxes.filter((t) => t.included).reduce((a, t) => a + t.amount, 0))}</b>
              </button>
            )}
            {taxesOpen && bill.taxes.filter((t) => t.included).map((t) => <div key={t.name} className="is-incl is-sub"><span>{tr('incl. {tax} {rate}%', { tax: t.name, rate: t.rate })}</span><b>{money(t.amount)}</b></div>)}
          </div>
        )}
        <div className="pos-total">
          <span>{tr('Total')}{cartCount > 0 && <small>{cartCount === 1 ? tr('1 item') : tr('{n} items', { n: cartCount })}</small>}</span>
          <strong className={cart.length ? 'is-live' : ''}>{money(animatedCartTotal)}</strong>
        </div>
        {cart.length > 0 && (
          <div className="pos-bill-tools">
            <button type="button" className={'pos-link' + (billAdjust.discount ? ' is-set' : '')} onClick={() => setOffFor('bill')}>
              % {billAdjust.discount ? billAdjust.discount.name || bill.billDiscountName || tr('Discount') : bill.serviceOn ? tr('Discount or service charge') : tr('Discount the bill')}
            </button>
            {!appOrder && (tillSettings.promotions || []).some((p) => p.code && p.on) && (
              <button type="button" className={'pos-link is-promo' + (billAdjust.promoCode ? ' is-set' : '')} onClick={() => setPromoOpen(true)}>
                🎟️ {billAdjust.promoCode || tr('Promo code')}
              </button>
            )}
            {tillSettings.loyalty && tillSettings.loyalty.on && selectedGuest && (
              <button type="button" className={'pos-link is-reward' + (billAdjust.discount && String(billAdjust.discount.presetId || '').indexOf('loyalty:') === 0 ? ' is-set' : '')} onClick={() => setRewardsOpen(true)}>
                ⭐ {tr('Rewards')} · {tr('{n} points', { n: selectedGuest.points || 0 })}
              </button>
            )}
          </div>
        )}
        <div className="pos-order-actions">
          {can('keepOpen') && !appOrder && <button type="button" className="btn btn-secondary pos-send" disabled={!cart.length || savingTab} onClick={sendToKitchen} title={tr('Send to the kitchen and keep the order open to pay later')}>
            <Icon name="send" /><span>{savingTab ? tr('Sending…') : tr('Send to kitchen')}</span>
          </button>}
          {can('charge') && (appOrder
            ? <button type="button" className="btn btn-primary pos-charge is-app" disabled={!cart.length || checkingOut} onClick={submitApp}><span>{checkingOut ? tr('Processing…') : tr('Ring up the {app} order · {amount}', { app: appOrder.name, amount: money(cartTotal) })}</span></button>
            : drawer
            ? <button type="button" className="btn btn-primary pos-charge" disabled={!cart.length} onClick={openCheckout}><span>{tr('Charge {amount}', { amount: money(cartTotal) })}</span></button>
            : isManager
              ? <button type="button" className="btn btn-primary pos-charge" onClick={() => setOrdersOnly(false)}><span>{tr('Open your drawer to charge')}</span></button>
              : <button type="button" className="btn btn-primary pos-charge" disabled title={tr('Only the cashier on duty, with their drawer open, charges.')}><span>{tr('The cashier on duty charges')}</span></button>)}
        </div>
      </div>
    </section>
  );

  return (
    <div className="dk pos-shell pos-till" data-brand={session.companyCode}>
      <header className="pos-top">
        <div className="pos-top-who">
          {restaurantLogoUrl(session.companyCode) && <span className="pos-top-logo-wrap"><img className="pos-top-logo" src={restaurantLogoUrl(session.companyCode)} alt="" /></span>}
          <div className="pos-top-names">
            <div className="pos-top-company">{session.companyName}</div>
            <div className="dk-muted" title={session.employeeName}><span className="pos-top-hello">{greeting} · </span><b className="pos-top-clock">{clock}</b></div>
          </div>
        </div>
        {/* Only what is used all the time, and what is asking: the shift
            (its drawer behind it), the kitchen, orders from the tables and
            bookings while someone waits for an answer, the open orders. The
            rest is under More, in groups. */}
        <div className="pos-top-stats">
          {can('charge') && drawer && (
            <button type="button" className="pos-stat is-sales" onClick={() => { loadShift(); refreshDrawer(); setDrawerPanelOpen(true); }}
              title={tr('{n} orders', { n: shift ? shift.orders : 0 }) + ' · ' + tr('In the drawer') + ' ' + money(drawer.expected)}>
              <span className="pos-stat-ico" aria-hidden="true"><Icon name="up" /></span>
              <span className="pos-stat-text">
                <small>{tr('Your shift')}</small>
                <strong>{money(animatedShiftSales)}</strong>
              </span>
            </button>
          )}
          {can('charge') && !drawer && (
            <button type="button" className="pos-stat is-duty" onClick={checkDuty}
              title={isManager ? tr('open your own drawer') : otherOnDuty ? tr('you take orders') : tr('open your drawer')}>
              <span className="pos-stat-ico" aria-hidden="true"><Icon name="drawer" /></span>
              <span className="pos-stat-text">
                <small>{tr('Cashier on duty')}</small>
                <strong>{otherOnDuty ? otherOnDuty.name : tr('Nobody')}</strong>
              </span>
            </button>
          )}
          {!can('charge') && (
            <span className={'pos-stat is-role is-' + tillAccess.role} title={tr('takes orders')}>
              <span className="pos-stat-ico" aria-hidden="true"><Icon name="people" /></span>
              <span className="pos-stat-text">
                <small>{tr('Signed in as')}</small>
                <strong>{ROLE_NAME[tillAccess.role] ? ROLE_NAME[tillAccess.role]() : tillAccess.role}</strong>
              </span>
            </span>
          )}
          {kitchen && kitchen.inUse && (
            <button type="button" className={'pos-stat is-kitchen' + (kitchen.ready.length ? ' is-ready' : '')} onClick={() => { loadKitchen(); setKitchenOpen(true); }}>
              <span className="pos-stat-ico" aria-hidden="true"><Icon name="bag" /></span>
              <span className="pos-stat-text">
                <small>{tr('Kitchen')}</small>
                <strong>{kitchen.ready.length ? tr('{n} ready', { n: kitchen.ready.length }) : kitchen.cooking === 1 ? tr('1 cooking') : tr('{n} cooking', { n: kitchen.cooking })}</strong>
              </span>
            </button>
          )}
          {tableBox && (tableBox.orders.length > 0 || tableBox.calls.length > 0 || (tableBox.paidAtTable || []).length > 0) && (
            <button type="button" className="pos-stat is-qr is-asking" onClick={() => { loadTableBox(); setTableBoxOpen(true); }}>
              <span className="pos-stat-ico" aria-hidden="true">📱</span>
              <span className="pos-stat-text">
                <small>{tr('From the tables')}</small>
                <strong>{tableBox.orders.length ? tr('{n} to accept', { n: tableBox.orders.length })
                  : tableBox.calls.length ? (tableBox.calls.length === 1 ? tr('1 call') : tr('{n} calls', { n: tableBox.calls.length }))
                    : tr('Paid at the table')}</strong>
              </span>
            </button>
          )}
          {(kitchenRetry || printWaiting.length > 0) && (
            <button type="button" className={'pos-stat is-print is-asking' + (kitchenRetry ? ' is-bad' : '')} onClick={() => (kitchenRetry ? printChits(kitchenRetry) : takeAndPrint(printWaiting))}>
              <span className="pos-stat-ico" aria-hidden="true">🖨️</span>
              <span className="pos-stat-text">
                <small>{tr('Kitchen printer')}</small>
                <strong>{kitchenRetry ? tr('Print again') : printWaiting.length === 1 ? tr('1 ticket to print') : tr('{n} tickets to print', { n: printWaiting.length })}</strong>
              </span>
            </button>
          )}
          <CurbsidePill outside={outside} onClick={() => setCurbOpen(true)} />
          <BusyPill busy={busyMode} onClick={() => setBusyOpen(true)} />
          {notes && notes.unread > 0 && !notesOpen && (
            <button type="button" className="crew-pill" onClick={() => setNotesOpen(true)}>📣 {notes.unread === 1 ? tr('1 new note') : tr('{n} new notes', { n: notes.unread })}</button>
          )}
          {soon && soon.can && (soon.requested > 0 || soon.waiting > 0) && (
            <button type="button" className="pos-stat is-bookings is-asking" onClick={() => setBookingsOpen(true)}>
              <span className="pos-stat-ico" aria-hidden="true">📅</span>
              <span className="pos-stat-text">
                <small>{tr('Bookings')}</small>
                <strong>{soon.requested ? tr('{n} to answer', { n: soon.requested }) : soon.waiting === 1 ? tr('1 waiting') : tr('{n} waiting', { n: soon.waiting })}</strong>
              </span>
            </button>
          )}
          <button type="button" className={'pos-stat is-tables' + (tabs.length ? ' is-warn' : '')} onClick={() => { loadTabs(); setTabsOpen(true); }}
            title={tabs.length ? money(tabs.reduce((s2, t) => s2 + t.total, 0)) : tr('none waiting')}>
            <span className="pos-stat-ico" aria-hidden="true"><Icon name="clock" /></span>
            <span className="pos-stat-text">
              <small>{tr('Open orders')}</small>
              <strong>{tabs.length}</strong>
            </span>
          </button>
        </div>
        <div className="pos-top-tools">
          {/* What is used now and then waits behind More (till/MoreMenu.jsx). */}
          <MoreMenu
            groups={[
              { key: 'money', emoji: '💰', label: tr('Money and accounts') },
              { key: 'orders', emoji: '🧾', label: tr('Orders and guests') },
              { key: 'screens', emoji: '🖥️', label: tr('Screens and devices') },
              { key: 'manage', emoji: '🗂️', label: tr('Manage') },
            ]}
            items={[
              onDuty('vipTopUp') && { key: 'vip', group: 'money', icon: 'spark', tone: 'vip', label: tr('VIP customers'), note: tr('Money put down, balances'), onClick: () => setVipOpen({}) },
              onDuty('iouPaid') && { key: 'iou', group: 'money', icon: 'owed', tone: 'iou', label: tr('IOUs'), note: shift && shift.iousOpen ? tr('{n} owed · {amount}', { n: shift.iousOpen, amount: money(shift.iousOwed) }) : tr('Nothing owed'), badge: shift && shift.iousOpen ? shift.iousOpen : 0, onClick: () => setIouOpen(true) },
              onDuty('refund') && { key: 'refund', group: 'money', icon: 'void', tone: 'refund', label: tr('Refund a sale'), note: tr('A manager approves it'), onClick: () => setRefundFor('find') },
              tillSettings.giftCards && tillSettings.giftCards.on && { key: 'gift', group: 'money', icon: <span className="tl-more-emo">🎁</span>, tone: 'gift', label: tr('Gift cards'), note: tr('Sell one, or look one up'), onClick: () => setGiftOpen(true) },
              can('charge') && drawer && { key: 'drawer', group: 'money', icon: 'drawer', tone: 'drawer', label: tr('Your drawer'), note: tr('{amount} expected', { amount: money(drawer.expected) }), onClick: () => { loadShift(); refreshDrawer(); setDrawerPanelOpen(true); } },
              can('bookings') && { key: 'bookings', group: 'orders', icon: <span className="tl-more-emo">📅</span>, tone: 'book', label: tr('Bookings and waitlist'), note: soon && soon.waiting ? tr('{n} waiting', { n: soon.waiting }) : tr('Tables booked, walk-ins waiting'), badge: soon && soon.requested ? soon.requested : null, onClick: () => setBookingsOpen(true) },
              tableBox && (tableBox.settings.on || tableBox.orders.length > 0) && { key: 'qr', group: 'orders', icon: <span className="tl-more-emo">📱</span>, tone: 'qr', label: tr('Orders from the tables'), note: tr('QR orders, calls, paid at the table'), badge: tableBox.orders.length + tableBox.calls.length || null, onClick: () => { loadTableBox(); setTableBoxOpen(true); } },
              can('charge') && (tillSettings.apps && tillSettings.apps.list || []).some((a) => a.on) && { key: 'app', group: 'orders', icon: <span className="tl-more-emo">🛵</span>, tone: 'app', label: tr('Delivery-app order'),
                note: (tillSettings.apps.list || []).filter((a) => a.on).map((a) => a.name).join(', '), onClick: () => (currentTab ? setToast(tr('Put the open order aside first: an app\'s order is rung up on its own.')) : setAppPickOpen(true)) },
              can('delivery') && { key: 'busy', group: 'orders', icon: <span className="tl-more-emo">{busyMode && busyMode.mode === 'paused' ? '⏸️' : '🔥'}</span>, tone: 'busy', label: tr('Busy mode'),
                note: busyMode ? (busyMode.mode === 'paused' ? tr('Website orders paused') : tr('Website orders +{n} min', { n: busyMode.extraMinutes })) : tr('Website orders take longer, or pause'), badge: busyMode ? '!' : null, onClick: () => setBusyOpen(true) },
              can('delivery') && { key: 'delivery', group: 'orders', icon: 'send', tone: 'delivery', label: tr('Deliveries'), note: tr('Website orders, riders, the map'), href: DELIVERY_URL },
              { key: 'dispute', group: 'orders', icon: 'warn', tone: 'dispute', label: tr('Report a problem'), note: tr('A complaint or a wrong charge'), onClick: () => setDisputeFor({}) },
              { key: 'screen', group: 'screens', icon: <span className="tl-more-emo">🖥️</span>, tone: 'screen', label: tr('Customer screen'), note: screen.displays.length ? tr('{n} showing this till', { n: screen.displays.length }) : tr('Pair a screen facing the customer'), onClick: () => setScreenOpen(true) },
              { key: 'kiosk', group: 'screens', icon: <span className="tl-more-emo">🧾</span>, tone: 'kiosk', label: tr('Self-order kiosk'), note: tillSettings.kiosk && tillSettings.kiosk.on ? tr('Taking orders') : tr('Pair a tablet for customers to order'), onClick: () => setKiosksOpen(true) },
              { key: 'board', group: 'screens', icon: <span className="tl-more-emo">📺</span>, tone: 'kiosk', label: tr('Ready board'), note: tr('A TV for customers: preparing and ready orders'), onClick: () => setBoardsOpen(true) },
              kitchen && kitchen.inUse && { key: 'kds', group: 'screens', icon: 'bag', tone: 'kitchen', label: tr('Open the kitchen screen'), note: tr('In a new tab'), href: KDS_URL },
              { key: 'printer', group: 'screens', icon: 'receipt', tone: 'printer', label: tr('Printer'), note: printer ? printer.name : tr('Not set up: choose one'), onClick: () => setPrinterOpen(true) },
              { key: 'rota', group: 'manage', icon: <span className="tl-more-emo">🗓️</span>, tone: 'rota', label: tr('Who is on today'),
                note: rotaToday ? (rotaToday.length ? rotaToday.map((x) => x.name.split(' ')[0]).slice(0, 4).join(', ') + (rotaToday.length > 4 ? ' +' + (rotaToday.length - 4) : '') : tr('Nobody on the rota')) : tr('The rota'),
                onClick: () => { loadRota(); setRotaOpen(true); } },
              isManager ? { key: 'office', group: 'manage', icon: 'key', tone: 'settings', label: tr('Back office'), note: tr('Reports, menu and stock, setup'), onClick: () => setOfficeOpen(true) }
                : { key: 'settings', group: 'manage', icon: 'key', tone: 'settings', label: tr('Till settings'), note: tr('Sales, activity, roles, payments'), onClick: () => setSettingsOpen(true) },
              can('stock') && { key: 'stock', group: 'manage', icon: 'layers', tone: 'stock', label: tr('Stock'), note: tr('Count it, enter what came in'), onClick: () => setStockOpen(true) },
              (can('till') || can('stock') || can('kds')) && { key: 'prep', group: 'manage', icon: <span className="tl-more-emo">🔪</span>, tone: 'prep', label: tr('Prep list'), note: tr('What to have ready today'), onClick: () => setPrepOpen(true) },
              checks && checks.lists.length > 0 && { key: 'checklists', group: 'manage', icon: <span className="tl-more-emo">✅</span>, tone: 'checklists', label: tr('Checklists'),
                note: checks.open ? (checks.open === 1 ? tr('1 to finish today') : tr('{n} to finish today', { n: checks.open })) : tr('All done today'), badge: checks.open || null, onClick: () => setChecksOpen(true) },
              incoming && incoming.can && incoming.waiting > 0 && { key: 'incoming', group: 'manage', icon: <span className="tl-more-emo">🚚</span>, tone: 'incoming', label: tr('Stock coming in'),
                note: incoming.waiting === 1 ? tr('1 transfer to count in') : tr('{n} transfers to count in', { n: incoming.waiting }), badge: incoming.waiting, onClick: () => setIncomingOpen(true) },
              can('charge') && drawer && drawer.session && drawer.session.status === 'open' && { key: 'safe', group: 'manage', icon: <span className="tl-more-emo">🔐</span>, tone: 'safe', label: tr('Cash into the safe'), note: tr('From your drawer, a manager watching'), onClick: () => setCashOpen('drop') },
              can('charge') && drawer && drawer.session && drawer.session.status === 'open' && { key: 'petty', group: 'manage', icon: <span className="tl-more-emo">🧾</span>, tone: 'petty', label: tr('Petty cash'), note: tr('Spent from your drawer, with the receipt'), onClick: () => setCashOpen('petty') },
              events && events.events.length > 0 && { key: 'events', group: 'manage', icon: <span className="tl-more-emo">🥂</span>, tone: 'events', label: tr('Events'),
                note: events.today ? (events.today === 1 ? tr('1 event today') : tr('{n} events today', { n: events.today })) : tr('{n} this week', { n: events.events.length }), badge: events.today || null, onClick: () => setEventsOpen(true) },
              { key: 'broken', group: 'manage', icon: <span className="tl-more-emo">🛠️</span>, tone: 'broken', label: tr('Something broken?'), note: tr('A fridge, the cooker, the generator…'), onClick: () => setBrokenOpen(true) },
              (can('till') || can('stock') || can('kds')) && { key: 'waste', group: 'manage', icon: <span className="tl-more-emo">🗑️</span>, tone: 'waste', label: tr('Throw something away'), note: tr('Waste: what, how many, why'), onClick: () => setWasteOpen(true) },
              notes && (notes.notes.length > 0 || notes.canWrite) && { key: 'notes', group: 'manage', icon: <span className="tl-more-emo">📌</span>, tone: 'notes', label: tr('Notes for the team'),
                note: notes.unread ? (notes.unread === 1 ? tr('1 new note') : tr('{n} new notes', { n: notes.unread })) : notes.notes.length ? tr('{n} up now', { n: notes.notes.length }) : tr('Write one for everyone'), badge: notes.unread || null, onClick: () => setNotesOpen(true) },
              { key: 'downloads', group: 'manage', icon: <span className="tl-more-emo">⬇️</span>, tone: 'downloads', label: tr('Downloads (Square format)'), note: tr('Item library and item sales'), onClick: () => setDownloadsOpen(true) },
            ]}
            extra={<div className="tl-more-look"><ThemeChoice theme={theme} onChange={setTheme} compact /><DeviceLanguage className="pos-lang tl-more-lang" /></div>}
          />
          <button type="button" className="btn btn-secondary tl-btn" onClick={logout}>{tr('Log out')}</button>
        </div>
      </header>
      {(offline || queued.length > 0) && (
        <button type="button" className={'pos-offline' + (offline ? ' is-off' : '') + (queued.some((x) => x.failed) ? ' is-stuck' : '')} onClick={() => setQueueOpen(true)}>
          <span className="pos-offline-dot" aria-hidden="true" />
          <span className="pos-offline-text">
            <strong>{offline ? tr('No internet: the till keeps working') : queued.some((x) => x.failed) ? tr('Some orders kept on this till need a look') : tr('Back online: sending what was kept')}</strong>
            <small>{offline ? tr('Sales and orders for the kitchen are kept on this till and sent when it is back. Tell the kitchen what you send meanwhile. VIP and IOU wait for the internet.') : tr('Tap to see them.')}</small>
          </span>
          {queued.length > 0 && <b className="pos-offline-n">{queued.length}</b>}
        </button>
      )}
      {printerError && <div className="error-banner pos-printer-error">{printerError}</div>}

      <div className="pos-body">
        <section className="pos-menu" aria-label={tr('Menu')}>
          <div className="pos-menu-tools">
            <div className="pos-search"><SearchInput value={search} onChange={setSearch} placeholder={tr('Search the menu…')} /></div>
            <button type="button" className="pos-icon-btn pos-scan-btn" onClick={() => setScanOpen(true)} title={tr('Scan a barcode: with the camera, or point a scanner at it any time')} aria-label={tr('Scan a barcode')}>
              <span className="pos-scan-ico" aria-hidden="true" />
            </button>
            {can('customItem') && (
              <button type="button" className="btn btn-secondary tl-btn tl-custom-btn" onClick={() => setCustomOpen(true)} title={tr('A dish that is not on the menu')}>
                <span aria-hidden="true">✦</span>{tr('Not on the menu')}
              </button>
            )}
            <div className="dk-segment pos-seg" role="radiogroup" aria-label={tr('Show')}>
              {VIEW_TABS.map((t) => (
                <button key={t.key} type="button" role="radio" aria-checked={viewTab === t.key} className={viewTab === t.key ? 'is-on' : ''} onClick={() => setViewTab(t.key)}>
                  {t.star ? <span className="pos-seg-star" aria-hidden="true">★</span> : <Icon name={t.icon} />}
                  {t.label}{typeof t.count === 'number' && t.count > 0 ? <span className="pos-seg-n">{t.count}</span> : null}
                </button>
              ))}
            </div>
          </div>
          {viewTab === 'all' && categories.length > 1 && (
            <div className="pos-cats" role="radiogroup" aria-label={tr('Category')}>
              <button type="button" role="radio" aria-checked={!category} className={!category ? 'is-on' : ''} onClick={() => setCategory('')}><i className="pos-cat-dot is-all" />{tr('Everything')} <span>{searchedMenu.length}</span></button>
              {categories.map(([c, n]) => (
                <button key={c} type="button" role="radio" aria-checked={category === c} className={category === c ? 'is-on' : ''} style={{ '--c': tileColor(c) }} onClick={() => setCategory(category === c ? '' : c)}><i className="pos-cat-dot" />{c} <span>{n}</span></button>
              ))}
            </div>
          )}
          <div className="pos-menu-body">
            <div className={'pos-menu-scroll' + (viewTab === 'all' && azShown.length ? ' has-az' : '')} ref={menuScrollRef}>
              {menuError && <div className="error-banner">{menuError}</div>}
              {menuLoading ? (
                <p className="dk-muted">{tr('Loading menu…')}</p>
              ) : viewTab === 'all' ? (
                !azShown.length ? (
                  <div className="dk-empty"><Icon name="info" /><p>{search ? tr('No items match "{search}"', { search }) : tr('No menu items yet — add some from Restaurants → Menu in the main app.')}</p></div>
                ) : (
                  azShown.map(([letter, items]) => (
                    <div key={letter} id={sectionId(letter)} className="pos-group az-group">
                      <h3 className="pos-group-title az-title"><b>{letter}</b><span>{items.length}</span></h3>
                      <div className="pos-grid">{items.map(renderTile)}</div>
                    </div>
                  ))
                )
              ) : viewTab === 'favorites' ? (
                !favoriteItems.length ? (
                  <div className="dk-empty"><Icon name="info" /><p>{search ? tr('No favorites match "{search}"', { search }) : tr('No favorites yet — tap the ★ on any item to pin it here.')}</p></div>
                ) : <div className="pos-grid">{favoriteItems.map(renderTile)}</div>
              ) : viewTab === 'recent' ? (
                !recentItems.length ? (
                  <div className="dk-empty"><Icon name="info" /><p>{search ? tr('No recent items match "{search}"', { search }) : tr('Nothing added to an order yet this shift.')}</p></div>
                ) : <div className="pos-grid">{recentItems.map(renderTile)}</div>
              ) : mostlyBoughtLoading && !mostlyBoughtItems.length ? (
                <p className="dk-muted">{tr('Loading…')}</p>
              ) : !mostlyBoughtItems.length ? (
                <div className="dk-empty"><Icon name="info" /><p>{search ? tr('No results match "{search}"', { search }) : tr('Not enough sales yet to rank — check back once a few orders have gone through.')}</p></div>
              ) : <div className="pos-grid">{mostlyBoughtItems.map(renderTile)}</div>}
            </div>
            {viewTab === 'all' && azShown.length > 1 && <AzRail letters={azShown.map((g) => g[0])} scrollRef={menuScrollRef} />}
          </div>
        </section>
        {orderPanel}
      </div>

      {!cartOpen && !(refundFor || vipOpen || iouOpen || tabsOpen || kitchenOpen || drawerPanelOpen || checkoutOpen || settingsOpen) && (
        <button type="button" className="pos-phone-bar" onClick={() => setCartOpen(true)}>
          <span className="pos-phone-bar-n" key={cartCount}>{cartCount}</span>
          <span>{currentTab ? currentTab.name : tr('Order')} · {cartCount === 1 ? tr('1 item') : tr('{n} items', { n: cartCount })}</span>
          <strong>{money(cartTotal)}</strong>
        </button>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}

      {curbOpen && <Curbside token={session.token} outside={outside} onClose={() => setCurbOpen(false)} onChanged={setOutside} onToast={setToast} />}
      {busyOpen && <BusyMode token={session.token} onClose={() => setBusyOpen(false)} onChanged={setBusyMode} onToast={setToast} />}
      {bookingsOpen && <Bookings token={session.token} tables={tables} onSeat={seatBooking} onToast={setToast} onClose={() => { setBookingsOpen(false); loadSoon(); }} />}
      {contactFor && <GuestContactDialog token={session.token} guest={contactFor} onClose={() => setContactFor(null)}
        onSaved={(g) => { setContactFor(null); if (selectedGuest && selectedGuest.id === g.id) setSelectedGuest(g); setToast(tr('Saved for {name}.', { name: g.name })); }} />}
      {downloadsOpen && <Downloads token={session.token} isManager={isManager} companyName={session.companyName} onToast={setToast} onClose={() => setDownloadsOpen(false)} />}
      {kiosksOpen && <Kiosks token={session.token} onToast={setToast} onClose={() => setKiosksOpen(false)} />}
      {rotaOpen && (
        <div className="dialog-backdrop" onClick={() => setRotaOpen(false)}>
          <div className="dialog ro-dlg is-today" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="ro-today-title">
            <h3 id="ro-today-title">🗓️ {tr('Who is on today')}</h3>
            {rotaToday ? <OnToday shifts={rotaToday} /> : <p className="dk-muted">{tr('Loading…')}</p>}
            <MyShifts token={session.token} onToast={setToast} />
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setRotaOpen(false)}>{tr('Close')}</button></div>
          </div>
        </div>
      )}
      {boardsOpen && <ReadyBoards token={session.token} onToast={setToast} onClose={() => setBoardsOpen(false)} />}
      {appPickOpen && <AppPicker apps={(tillSettings.apps && tillSettings.apps.list) || []} current={appOrder} onClose={() => setAppPickOpen(false)}
        onPick={(a) => { setAppOrder(a); setAppPickOpen(false); setCurrentTab(null); }} />}
      {giftOpen && <GiftCards token={session.token} settings={tillSettings} companyName={session.companyName} can={can} onToast={setToast} onClose={() => { setGiftOpen(false); refreshDrawer(); loadShift(); }} />}
      {printerOpen && (
        <PrinterPanel printer={printer} onPrinter={(p) => { setPrinter(p); setPrinterError(null); }} companyName={session.companyName} onClose={() => setPrinterOpen(false)}
          kitchen={kitchenSet} onKitchen={(k) => { saveKitchenSetup(k); setKitchenSet(k); }} />
      )}
      {screenOpen && <CustomerScreen token={session.token} device={screen.device} displays={screen.displays} onChanged={screen.reload} onToast={setToast} onClose={() => setScreenOpen(false)} />}
      {rewardsOpen && selectedGuest && (
        <Rewards token={session.token} guest={selectedGuest} applied={billAdjust.discount ? billAdjust.discount.presetId : null}
          onApply={(presetId, name) => { setBillAdjust((a) => ({ ...a, discount: presetId ? { presetId, name } : null })); setRewardsOpen(false); }} onClose={() => setRewardsOpen(false)} />
      )}
      {checkoutOpen && (
        <PayDialog token={session.token} title={currentTab ? currentTab.name : tr('To pay')} total={Math.round(cartTotal * 100) / 100} methods={payMethods()}
          settings={tillSettings} customer={selectedGuest} refreshKey={vipKey} busy={checkingOut} error={checkoutError}
          onPickCustomer={openGuestPicker} onTopUp={() => setVipOpen({ startGuest: selectedGuest })}
          dishes={currentTab && !isLocal(currentTab.id) ? {
            lines: cart.map((l) => ({ key: lineKey(l), name: l.name, qty: l.qty, seat: l.seat || null, words: [modsWords(l.modifiers, tr), l.note].filter(Boolean).join(' · ') })),
            billFor: (pick) => billOf(cart.filter((l) => pick[lineKey(l)] > 0).map((l) => ({ ...l, qty: pick[lineKey(l)] })), billAdjust, tillSettings, fulfillment),
            why: liveTab && (liveTab.delivery || liveTab.onlineRef) ? tr('A delivery or a website order is paid in one go.')
              : cart.length !== sentLines.length || cart.some((l) => { const s0 = sentLines.find((x) => lineKey(x) === lineKey(l)); return !s0 || s0.qty !== l.qty; })
                ? tr('Send the new dishes to the kitchen first, then pay by dish.') : null
          } : null}
          screenTip={screen.tip} onTip={setPayInfo} paidAhead={paidAheadOf(liveTab)}
          onCancel={() => { setCheckoutOpen(false); setPayInfo(null); }} onComplete={submitCheckout} />
      )}

      {keepDialog && !sendConfirm && (
        <div className="dialog-backdrop" onClick={() => !savingTab && setKeepDialog(null)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (keepDialog.label.trim()) setSendConfirm(true); }}>
            <h2>{tr('Which order is this?')}</h2>
            <p className="dk-muted">{tr('Give it a table or a name, so anyone on the till can find it again and pay it later. Then it goes to the kitchen.')}</p>
            {tables.length > 0 && (
              <div className="pos-picker-grid">
                {tables.filter((t) => !tabs.some((x) => x.tableId === t.id)).map((t) => (
                  <button key={t.id} type="button" className="pos-picker-tile" onClick={() => { setSelectedTable(t); setKeepDialog(null); setSendConfirm(true); }}>{t.name}</button>
                ))}
              </div>
            )}
            <div className="field">
              <label htmlFor="pos-keep-name">{tables.length ? tr('Or a name') : tr('Name')}</label>
              <input id="pos-keep-name" className="input" maxLength={60} value={keepDialog.label} onChange={(e) => setKeepDialog({ label: e.target.value })} placeholder={tr('e.g. Bar – Kofi, Takeaway 2')} autoFocus />
            </div>
            {tabError && <div className="error-banner">{tabError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setKeepDialog(null)} disabled={savingTab}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={savingTab || !keepDialog.label.trim()}>{tr('Next')}</button>
            </div>
          </form>
        </div>
      )}

      {tabsOpen && (
        <div className="dialog-backdrop" onClick={() => setTabsOpen(false)}>
          <div className="dialog pos-panel" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Open orders')}</h2>
            <p className="dk-muted">{tr('Orders sent to the kitchen and kept open to add to and pay later. They are not sales until they are paid. The tag says where the food is.')}</p>
            {!tabs.length ? (
              <div className="dk-empty"><Icon name="check" /><p>{tr('No open orders. Send an order to the kitchen to hold it here.')}</p></div>
            ) : (
              <ul className="dk-rows pos-tabs">
                {tabs.map((t) => (
                  <li key={t.id} className={'dk-row tl-tab is-' + (t.fulfillment || 'dine_in')}>
                    <span className={'dk-lead-icon tl-ful-ico is-' + (t.fulfillment || 'dine_in')} title={fulfillmentName(t.fulfillment || 'dine_in')}><FulfillmentIcon kind={t.fulfillment || 'dine_in'} /></span>
                    <div className="dk-row-main">
                      <div className="dk-row-title">{tabName(t)} <KitchenTag kitchen={t.kitchen} compact />{t.onlineRef && <span className="tl-web">{t.onlineRef}</span>}
                        {t.delivery && <span className={'tl-out is-' + t.delivery.status}>🛵 {t.delivery.ref} · {statusName(t.delivery.status)} · {t.delivery.riderName}</span>}
                        {t.delivery && t.delivery.collected && <span className="tl-cash">💵 {tr('{amount} with {name}', { amount: money(t.delivery.collected.amount), name: t.delivery.riderName })}</span>}</div>
                      <div className="dk-muted dk-row-meta">
                        {[fulfillmentName(t.fulfillment || 'dine_in'), t.lines.reduce((n, l) => n + l.qty, 0) === 1 ? tr('1 item') : tr('{n} items', { n: t.lines.reduce((n, l) => n + l.qty, 0) }), t.waiterName, tr('open since {time}', { time: timeOf(t.createdAt) }), t.openedBy ? tr('by {name}', { name: t.openedBy }) : null].filter(Boolean).join(' · ')}
                      </div>
                      {t.fulfillment === 'delivery' && <div className="dk-muted dk-row-meta tl-tab-deliver"><Icon name="send" /> {t.deliveryAddress} · {t.customerPhone}</div>}
                      {t.unavailable > 0 && <Status tone="warn">{t.unavailable === 1 ? tr('1 item is off the menu now') : tr('{n} items are off the menu now', { n: t.unavailable })}</Status>}
                    </div>
                    <div className="dk-row-side">
                      <div className="dk-row-amount">{money(t.total)}</div>
                      <div className="pos-tab-actions">
                        {can('removeTable') && <button type="button" className="pos-link is-bad" onClick={() => dropTab(t)}>{tr('Remove')}</button>}
                        <button type="button" className="pos-link" onClick={() => setDisputeFor({ tabId: t.id, label: t.name, customerName: t.guestName || t.customerName || '' })}>{tr('Problem?')}</button>
                        {can('keepOpen') && !t.offline && !t.delivery && !t.onlineRef && !String(t.id).startsWith('local:') && <button type="button" className="pos-link" onClick={() => setMoveFor(t)}>⇄ {tr('Move')}</button>}
                        {t.fulfillment === 'delivery' && !t.delivery && can('delivery') && <button type="button" className="btn btn-secondary tl-btn" onClick={() => { setTabsOpen(false); sendOut({ tabId: t.id }); }}>🛵 {tr('Send')}</button>}
                        {t.kitchen && (t.kitchen.held || []).length > 0 && can('keepOpen') && (
                          <button type="button" className="btn tl-btn tl-call" onClick={() => callCourse(t)}>🔔 {tr('Call {course}', { course: courseName(tillSettings, t.kitchen.held[0], tr) })}</button>
                        )}
                        <button type="button" className="btn btn-secondary tl-btn" onClick={() => openTab(t, false)}>{tr('Open')}</button>
                        {onDuty('charge') && (t.delivery && t.delivery.toCollect > 0 && t.delivery.status !== 'failed'
                          ? <button type="button" className="btn btn-primary tl-btn" onClick={() => { setTabsOpen(false); setHandIn(t); }}>💵 {tr('Money in')}</button>
                          : <button type="button" className="btn btn-primary tl-btn" onClick={() => openTab(t, true)}>{tr('Pay')}</button>)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setTabsOpen(false)}>{tr('Close')}</button>
            </div>
          </div>
        </div>
      )}

      {allergyOpen && <AllergyDialog value={allergy} onClose={() => setAllergyOpen(false)} onSave={(v) => { setAllergy(v); setAllergyOpen(false); }} />}
      {chits && <KitchenChits chits={chits} settings={tillSettings} onClose={() => setChits(null)} />}

      {moveFor && (
        <MoveBill token={session.token} tab={moveFor} tabs={tabs} tables={tables} waiters={waiters} name={tabName}
          onClose={() => setMoveFor(null)}
          onDone={(text) => {
            if (currentTab && tabs.some((t) => t.id === currentTab.id)) clearOrder();
            setMoveFor(null); setToast(text); loadTabs(); loadKitchen();
          }} />
      )}

      {kitchenOpen && kitchen && (
        <div className="dialog-backdrop" onClick={() => setKitchenOpen(false)}>
          <div className="dialog pos-panel" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Ready to serve')}</h2>
            <p className="dk-muted">{kitchen.cooking === 1 ? tr('From the kitchen screen. 1 more ticket is cooking.') : tr('From the kitchen screen. {n} more tickets are cooking.', { n: kitchen.cooking })}</p>
            {!kitchen.ready.length ? (
              <div className="dk-empty"><Icon name="check" /><p>{tr('Nothing waiting. Dishes show here once the kitchen marks them done.')}</p></div>
            ) : (
              <ul className="dk-rows pos-tabs">
                {kitchen.ready.map((t) => (
                  <li key={t.id} className="dk-row">
                    <span className="pos-ready-no">#{t.number}</span>
                    <div className="dk-row-main">
                      <div className="dk-row-title">{t.fulfillment === 'togo' ? (t.label || t.guestName || tr('To go')) : t.fulfillment === 'pickup' ? (t.label || t.guestName || tr('Counter')) : t.fulfillment === 'delivery' ? (t.guestName || t.label) : (t.tableName || t.label || t.guestName || tr('Counter'))}
                        {t.fulfillment && <span className={'tl-ful is-' + t.fulfillment}><FulfillmentIcon kind={t.fulfillment} />{fulfillmentName(t.fulfillment)}</span>}
                        {t.onlineRef && <span className="tl-web">{t.onlineRef}</span>}</div>
                      <div className="dk-muted dk-row-meta">{[t.dishes === 1 ? tr('1 dish') : tr('{n} dishes', { n: t.dishes }), t.waiterName, t.waitingMinutes ? tr('ready {n} min ago', { n: t.waitingMinutes }) : tr('just ready')].filter(Boolean).join(' · ')}</div>
                      {t.fulfillment === 'delivery' && <div className="dk-muted dk-row-meta">{t.deliveryAddress} · {t.customerPhone}</div>}
                      {t.readyText && (t.readyText.channel === 'sms' ? <span className="tl-texted">📱 {tr('Texted: food ready')}</span>
                        : t.readyText.url ? <a className="tl-texted is-wa" href={t.readyText.url} target="_blank" rel="noreferrer">💬 {tr('Tell them on WhatsApp')}</a> : null)}
                    </div>
                    <div className="dk-row-side">
                      {t.fulfillment === 'delivery' && !t.deliveryId && can('delivery') && (
                        <button type="button" className="btn btn-primary tl-btn" onClick={() => { setKitchenOpen(false); sendOut({ tabId: t.tabId, orderId: t.orderId }); }}>🛵 {tr('Send with a rider')}</button>
                      )}
                      {t.fulfillment === 'delivery' && t.deliveryId ? <span className="tl-out">🛵 {tr('Out with a rider')}</span>
                        : <button type="button" className={'btn tl-btn ' + (t.fulfillment === 'delivery' && can('delivery') ? 'btn-secondary' : 'btn-primary')} onClick={() => serveTicket(t)}>{tr('Mark served')}</button>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="dialog-actions">
              <a className="btn btn-secondary" href={KDS_URL} target="_blank" rel="noreferrer">{tr('Open the kitchen screen ↗')}</a>
              <button type="button" className="btn btn-primary" onClick={() => setKitchenOpen(false)}>{tr('Close')}</button>
            </div>
          </div>
        </div>
      )}

      {drawerPanelOpen && (
        <div className="dialog-backdrop" onClick={() => setDrawerPanelOpen(false)}>
          <div className="dialog pos-panel" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Your shift')}</h2>
            <p className="dk-muted">{tr('{name} · drawer opened {date}', { name: session.employeeName, date: new Date(drawer.session.openedAt).toLocaleString(activeIntlLocale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' }) })}</p>
            <dl className="dk-sum pos-sum">
              <div><dt>{tr('Sales')}</dt><dd>{money(shift ? shift.sales : 0)}</dd></div>
              <div><dt>{tr('Orders')}</dt><dd>{shift ? shift.orders : 0}</dd></div>
              <div><dt>{tr('Average order')}</dt><dd>{avgOrder ? money(avgOrder) : '—'}</dd></div>
            </dl>
            {shift && shift.byMethod.length > 0 && (
              <div className="pos-methods-sum">
                {shift.byMethod.map((m) => (
                  <div key={m.method}><span>{methodName(m.method)}</span><span className="dk-muted">{m.orders === 1 ? tr('1 order') : tr('{n} orders', { n: m.orders })}</span><strong>{money(m.total)}</strong></div>
                ))}
              </div>
            )}
            {shift && ((shift.refunds && shift.refunds.count) || (shift.iouPaid && shift.iouPaid.count) || (shift.vipTopUps && shift.vipTopUps.count)) ? (
              <div className="pos-methods-sum pos-money-sum">
                {shift.refunds.count > 0 && <div><span>{tr('Refunds')}</span><span className="dk-muted">{shift.refunds.count === 1 ? tr('1 refund') : tr('{n} refunds', { n: shift.refunds.count })}</span><strong>−{money(shift.refunds.total)}</strong></div>}
                {shift.iouPaid.count > 0 && <div><span>{tr('IOUs paid')}</span><span className="dk-muted">{shift.iouPaid.byMethod.map((m) => methodName(m.method) + ' ' + money(m.total)).join(' · ')}</span><strong>{money(shift.iouPaid.total)}</strong></div>}
                {shift.vipTopUps.count > 0 && <div><span>{tr('VIP money put down')}</span><span className="dk-muted">{shift.vipTopUps.byMethod.map((m) => methodName(m.method) + ' ' + money(m.total)).join(' · ')}</span><strong>{money(shift.vipTopUps.total)}</strong></div>}
              </div>
            ) : null}
            <h3 className="pos-panel-h">{tr('Cash drawer')}</h3>
            <div className="pos-drawer-lines">
              <div className="pos-drawer-line"><span>{tr('Starting Cash')}</span><span>{money(drawer.startingCash)}</span></div>
              <div className="pos-drawer-line"><span>{tr('Cash Sales')}</span><span>{money(drawer.cashSales)}</span></div>
              {drawer.iouPaidCash > 0 && <div className="pos-drawer-line"><span>{tr('IOUs paid in cash')}</span><span>{money(drawer.iouPaidCash)}</span></div>}
              {drawer.vipTopUpsCash > 0 && <div className="pos-drawer-line"><span>{tr('VIP money in cash')}</span><span>{money(drawer.vipTopUpsCash)}</span></div>}
              {drawer.cashRefunds > 0 && <div className="pos-drawer-line"><span>{tr('Cash Refunds')}</span><span>−{money(drawer.cashRefunds)}</span></div>}
              {drawer.vipCashOutsCash > 0 && <div className="pos-drawer-line"><span>{tr('VIP money given back')}</span><span>−{money(drawer.vipCashOutsCash)}</span></div>}
              {drawer.iouLentCash > 0 && <div className="pos-drawer-line"><span>{tr('Cash lent on IOU accounts')}</span><span>−{money(drawer.iouLentCash)}</span></div>}
              {drawer.giftSoldCash > 0 && <div className="pos-drawer-line"><span>{tr('Gift cards sold in cash')}</span><span>{money(drawer.giftSoldCash)}</span></div>}
              {drawer.giftVoidedCash > 0 && <div className="pos-drawer-line"><span>{tr('Gift cards cancelled, cash given back')}</span><span>−{money(drawer.giftVoidedCash)}</span></div>}
              <div className="pos-drawer-line"><span>{tr('Paid In/Out')}</span><span>{drawer.netPaidInOut < 0 ? '-' : ''}{money(Math.abs(drawer.netPaidInOut))}</span></div>
              {drawer.safeDrops > 0 && <div className="pos-drawer-line"><span>🔐 {tr('Into the safe')}</span><span>−{money(drawer.safeDrops)}</span></div>}
              {drawer.pettyCash > 0 && <div className="pos-drawer-line"><span>🧾 {tr('Petty cash')}</span><span>−{money(drawer.pettyCash)}</span></div>}
              <div className="pos-drawer-line is-total"><span>{tr('Expected in Drawer')}</span><span>{money(drawer.expected)}</span></div>
            </div>
            {!!drawer.movements.length && (
              <div className="pos-drawer-moves">
                {drawer.movements.slice().reverse().map((m) => (
                  <div key={(m.account || '') + m.id} className={'pos-drawer-line' + (m.account ? ' is-acct is-' + m.account : '')}>
                    <span>{m.account ? <><em className={'pos-acct-tag is-' + m.account}>{m.account === 'vip' ? tr('VIP') : tr('IOU')}</em>{moveLabel(m)} · {timeOf(m.createdAt)}</>
                      : m.kind === 'drop' ? '🔐 ' + tr('Into the safe at {time}', { time: timeOf(m.createdAt) })
                        : m.kind === 'petty' ? pettyOf(m.category).icon + ' ' + tr('Petty cash at {time}', { time: timeOf(m.createdAt) }) + (m.paidTo ? ' · ' + m.paidTo : '')
                          : m.kind === 'event' ? '🥂 ' + tr('Event deposit at {time}', { time: timeOf(m.createdAt) })
                            : m.direction === 'in' ? tr('Paid in at {time}', { time: timeOf(m.createdAt) }) : tr('Paid out at {time}', { time: timeOf(m.createdAt) })}{m.note && !(m.kind === 'drop' && m.note === 'Into the safe') ? ' — ' + m.note : ''}</span>
                    <span>{m.direction === 'out' ? '-' : ''}{money(m.amount)}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="pos-panel-actions">
              <button type="button" className="btn btn-secondary tl-btn" onClick={() => openMovement('in')}>{tr('Paid in…')}</button>
              <button type="button" className="btn btn-secondary tl-btn" onClick={() => openMovement('out')}>{tr('Paid out…')}</button>
            </div>
            {shift && shift.recent.length > 0 && (
              <>
                <h3 className="pos-panel-h">{tr('Latest orders')}</h3>
                <ul className="dk-rows">
                  {shift.recent.map((o) => (
                    <li key={o.id} className="dk-row">
                      <div className="dk-row-main">
                        <div className="dk-row-title">{o.orderNo} <KitchenTag kitchen={o.kitchen} compact /></div>
                        <div className="dk-muted dk-row-meta">{[timeOf(o.createdAt), o.fulfillment ? fulfillmentName(o.fulfillment) : null, o.tableName || o.customerName, o.items === 1 ? tr('1 item') : tr('{n} items', { n: o.items }), methodName(o.paymentMethod)].filter(Boolean).join(' · ')}</div>
                      </div>
                      <div className="dk-row-side">
                        <div className="dk-row-amount">{money(o.total)}</div>
                        {o.refunded > 0 && <small className="pos-money-tag is-refund">{tr('{amount} refunded', { amount: money(o.refunded) })}</small>}
                        <span className="pos-row-links">
                          <button type="button" className="pos-link" onClick={() => reprint(o.id)}>{tr('Receipt')}</button>
                          <button type="button" className="pos-link" onClick={() => setDisputeFor({ orderId: o.id, label: o.orderNo, customerName: o.customerName || '' })}>{tr('Problem?')}</button>
                          {onDuty('refund') && <button type="button" className="pos-link" onClick={() => { setDrawerPanelOpen(false); setRefundFor(o.id); }}>{tr('Refund')}</button>}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDrawerPanelOpen(false)}>{tr('Close')}</button>
              <button type="button" className="btn btn-primary" onClick={openCloseDrawer}>{tr('End shift: count the drawer…')}</button>
            </div>
          </div>
        </div>
      )}

      {queueOpen && <OfflineQueue items={queued} offline={offline} onSend={sendKept} onClose={() => setQueueOpen(false)} />}
      {billOpen && liveTab && (
        <TableBill token={session.token} tab={liveTab} companyName={session.companyName} printer={printer} onClose={() => setBillOpen(false)}
          onFail={(e) => { if (e.status === 401) { localStorage.removeItem(SESSION_KEY); setSession(null); } else setToast(e.message); }} />
      )}
      {tableBoxOpen && tableBox && (
        <TableInbox token={session.token} box={tableBox} waiters={waiters} canSend={can('keepOpen')} onClose={() => setTableBoxOpen(false)}
          onChanged={() => { loadTableBox(); loadTabs(); loadKitchen(); }} onToast={setToast} onOpenBill={openBill} onChits={printChits}
          onUnauthorized={() => { localStorage.removeItem(SESSION_KEY); setSession(null); }} />
      )}
      {movementDirection && (
        <PayInOutDialog token={session.token} direction={movementDirection} can={{ vip: onDuty('vipTopUp'), iouIn: onDuty('iouPaid'), iouOut: onDuty('iou') }}
          onClose={() => setMovementDirection(null)} onUnauthorized={() => { localStorage.removeItem(SESSION_KEY); setSession(null); }}
          onDone={(d, text) => { setDrawer(d); setMovementDirection(null); setToast(text); }} />
      )}

      {closeDrawerOpen && (
        <div className="dialog-backdrop" onClick={() => !closingDrawer && setCloseDrawerOpen(false)}>
          <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitCloseDrawer}>
            <h2>{tr('Close drawer')}</h2>
            {closeDrawerError && <div className="error-banner">{closeDrawerError}</div>}
            <p className="pos-checkout-total">{tr('Expected in drawer:')} <strong>{money(drawer.expected)}</strong></p>
            <div className="field">
              <label htmlFor="close-actual">{tr('Actual cash counted')}</label>
              <input
                id="close-actual" className="input" type="number" min="0" step="0.01" autoFocus required
                value={closeActualCash} onChange={(e) => setCloseActualCash(e.target.value)} placeholder="0.00"
              />
            </div>
            <div className="field">
              <label htmlFor="close-note">{tr('Note (optional)')}</label>
              <input id="close-note" className="input" value={closeNote} onChange={(e) => setCloseNote(e.target.value)} />
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setCloseDrawerOpen(false)} disabled={closingDrawer}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={closingDrawer}>{closingDrawer ? tr('Closing…') : tr('Close drawer')}</button>
            </div>
          </form>
        </div>
      )}

      {scanOpen && <CameraScan onCode={scanCode} onClose={() => setScanOpen(false)} />}
      {newCode && (
        <LinkBarcode code={newCode} menu={menu} token={session.token} canStock={can('stock')} onClose={() => setNewCode(null)}
          onLinked={(pick) => {
            setNewCode(null); setToast(tr('{name} has its barcode now.', { name: pick.item.name }));
            if (pick.variation) pickVariation(pick.item, pick.variation); else tapItem(pick.item);
            loadMenu(session.token);
          }} />
      )}
      {promoOpen && (
        <PromoCodeDialog promotions={tillSettings.promotions} channel="till" current={billAdjust.promoCode}
          onApply={(code) => { setBillAdjust((a) => ({ ...a, promoCode: code })); setPromoOpen(false); }} onClose={() => setPromoOpen(false)} />
      )}
      {addOnsFor && (
        <AddOnsDialog item={addOnsFor.item} variation={addOnsFor.variation} editing={!!addOnsFor.line}
          base={addOnsFor.variation ? addOnsFor.variation.price : addOnsFor.item.price} picked={addOnsFor.line ? addOnsFor.line.modifiers : []}
          onSave={saveAddOns} onClose={() => setAddOnsFor(null)} />
      )}
      {offFor && (
        <DiscountDialog token={session.token} line={offFor === 'bill' ? null : offFor} settings={tillSettings} can={{ discount: can('discount'), comp: can('comp') }}
          current={offFor === 'bill' ? billAdjust : offFor} serviceOn={bill.serviceOn}
          onApply={(patch) => {
            if (offFor === 'bill') setBillAdjust((a) => ({ ...a, ...patch }));
            else changeLine(lineKey(offFor), patch);
            setOffFor(null);
          }}
          onClose={() => setOffFor(null)} />
      )}
      {variantPickerItem && (
        <div className="dialog-backdrop" onClick={() => setVariantPickerItem(null)}>
          <div className="dialog pos-picker-dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{variantPickerItem.name}</h2>
            <div className="pos-picker-list">
              {variantPickerItem.variations.map((v) => (
                <button
                  key={v.id} type="button" className="pos-picker-row"
                  onClick={() => pickVariation(variantPickerItem, v)}
                >
                  <span>{v.name}</span>
                  <span>{money(v.price)}</span>
                </button>
              ))}
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setVariantPickerItem(null)}>{tr('Cancel')}</button>
            </div>
          </div>
        </div>
      )}

      {tablePickerOpen && (
        <div className="dialog-backdrop" onClick={() => setTablePickerOpen(false)}>
          <div className="dialog pos-picker-dialog tl-map-dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Pick the table')}</h2>
            <p className="dk-muted">{tr('Where they sit. A table with an open order shows its total and where its food is; tap it to open that order.')}</p>
            <TableMapPicker tables={tables} tabs={tabs} booked={soon ? soon.tables : null} selectedId={selectedTable ? selectedTable.id : null}
              onPick={(t, tab) => {
                if (tab && !(currentTab && currentTab.id === tab.id)) { setTablePickerOpen(false); openTab(tab, false); return; }
                setSelectedTable(t); setFulfillment('dine_in'); setTablePickerOpen(false);
              }} />
            <div className="dialog-actions">
              {selectedTable && <button type="button" className="btn btn-secondary" onClick={() => { setSelectedTable(null); setTablePickerOpen(false); }}>{tr('Clear')}</button>}
              <button type="button" className="btn btn-primary" onClick={() => setTablePickerOpen(false)}>{tr('Done')}</button>
            </div>
          </div>
        </div>
      )}

      {waiterPickerOpen && (
        <div className="dialog-backdrop" onClick={() => setWaiterPickerOpen(false)}>
          <div className="dialog pos-picker-dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Waiter')}</h2>
            <div className="pos-picker-list">
              {waiters.map((w) => (
                <button
                  key={w.id} type="button"
                  className={'pos-picker-row' + (selectedWaiter && selectedWaiter.id === w.id ? ' pos-picker-row-selected' : '')}
                  onClick={() => { setSelectedWaiter(w); setWaiterPickerOpen(false); }}
                >
                  {w.name}
                </button>
              ))}
              {!waiters.length && <div className="pos-empty">{tr('No staff found for this company.')}</div>}
            </div>
            <div className="dialog-actions">
              {selectedWaiter && <button type="button" className="btn btn-secondary" onClick={() => { setSelectedWaiter(null); setWaiterPickerOpen(false); }}>{tr('Clear')}</button>}
              <button type="button" className="btn btn-primary" onClick={() => setWaiterPickerOpen(false)}>{tr('Done')}</button>
            </div>
          </div>
        </div>
      )}

      {guestPickerOpen && (
        <div className="dialog-backdrop" onClick={() => setGuestPickerOpen(false)}>
          <div className="dialog pos-picker-dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Customer')}</h2>
            <p className="dk-muted tl-small">{tr('VIP: has money put down. IOU: a manager lets them owe.')}</p>
            <div className="field">
              <input
                className="input" value={guestSearch} placeholder={tr('Search name or phone…')} autoFocus
                onChange={(e) => { setGuestSearch(e.target.value); searchGuests(e.target.value); }}
              />
            </div>
            <div className="pos-picker-list">
              {guestSearching && <div className="eyebrow">{tr('Searching…')}</div>}
              {!guestSearching && guestResults.map((g) => (
                <button
                  key={g.id} type="button"
                  className={'pos-picker-row' + (selectedGuest && selectedGuest.id === g.id ? ' pos-picker-row-selected' : '')}
                  onClick={() => {
                    setSelectedGuest(g); setGuestPickerOpen(false);
                    if (fulfillment === 'delivery' || fulfillment === 'pickup') setDelivery((d) => ({ ...d, name: d.name || g.name, phone: d.phone || g.phone || '' }));
                  }}
                >
                  <span>{g.name}{g.phone ? ' · ' + g.phone : ''}</span>
                  {(g.vip || g.iouAllowed || g.points > 0) && (
                    <em className="pos-who-accts">
                      {g.points > 0 && <b className="is-pts" title={tr('Loyalty points')}>⭐ {g.points}</b>}
                      {g.vip && <b className="is-vip" title={tr('VIP account: {amount}', { amount: money(g.vipBalance) })}>{tr('VIP')} {money(g.vipBalance)}</b>}
                      {g.iouAllowed && <b className="is-iou" title={tr('IOU account')}>{tr('IOU')}{g.iouOwed > 0 ? ' · ' + money(g.iouOwed) : ''}</b>}
                    </em>
                  )}
                </button>
              ))}
              {!guestSearching && !guestResults.length && <div className="pos-empty">{tr('No matching customers.')}</div>}
            </div>
            <div className="pos-picker-divider">{tr('Or add a new customer')}</div>
            {guestError && <div className="error-banner">{guestError}</div>}
            <form onSubmit={submitNewGuest} className="pos-new-guest-form">
              <input className="input" value={newGuestName} onChange={(e) => setNewGuestName(e.target.value)} placeholder={tr('Name')} required />
              <input className="input" value={newGuestPhone} onChange={(e) => setNewGuestPhone(e.target.value)} placeholder={tr('Phone (optional)')} />
              <button type="submit" className="btn btn-primary" disabled={addingGuest}>{addingGuest ? tr('Adding…') : tr('Add & select')}</button>
              {newGuestMore ? <ContactFields value={newGuestMore} onChange={setNewGuestMore} />
                : <button type="button" className="pos-link gx-more" onClick={() => setNewGuestMore(contactOf(null))}>✉️ {tr('+ Email, birthday, messages')}</button>}
            </form>
            <div className="dialog-actions">
              {selectedGuest && <button type="button" className="btn btn-secondary" onClick={() => { setContactFor(selectedGuest); setGuestPickerOpen(false); }}>✉️ {tr('Email and birthday')}</button>}
              {selectedGuest && <button type="button" className="btn btn-secondary" onClick={() => { setSelectedGuest(null); setGuestPickerOpen(false); }}>{tr('Clear')}</button>}
              <button type="button" className="btn btn-secondary" onClick={() => setGuestPickerOpen(false)}>{tr('Close')}</button>
            </div>
          </div>
        </div>
      )}

      {noteFor && <NoteDialog line={noteFor} onClose={() => setNoteFor(null)} onSave={(n) => setLineNote(lineKey(noteFor), n)} />}
      {customOpen && <CustomItemDialog categories={menuCategories} onClose={() => setCustomOpen(false)} onAdd={addCustom} />}
      {deliveryOpen && (
        <DeliveryDialog value={delivery} customer={selectedGuest} pickup={fulfillment === 'pickup'} onClose={() => setDeliveryOpen(false)}
          onPickCustomer={() => { setDeliveryOpen(false); openGuestPicker(); }}
          onSave={(d) => { setDelivery(d); if (fulfillment !== 'pickup') setFulfillment('delivery'); setDeliveryOpen(false); }} />
      )}
      {sendConfirm && (
        <SendConfirmDialog cart={cart} sent={sentLines} total={bill.total} fulfillment={fulfillment} allergy={allergy} courseFor={sendCourseFor()}
          where={fulfillment === 'dine_in' ? (selectedTable ? selectedTable.name : (keepDialog && keepDialog.label) || (currentTab && currentTab.name) || (selectedGuest && selectedGuest.name) || '') : whereText()}
          customer={fulfillment === 'pickup' ? [pickupWho().name, pickupWho().phone].filter(Boolean).join(' · ') : selectedGuest ? selectedGuest.name : fulfillment === 'delivery' ? delivery.name : null}
          waiter={fulfillment === 'dine_in' && selectedWaiter ? selectedWaiter.name : null} delivery={delivery} kitchenNote={kitchenNote.trim()}
          busy={savingTab} error={tabError}
          onClose={() => { setSendConfirm(false); setTabError(null); }}
          onConfirm={() => saveTab(keepDialog && keepDialog.label ? keepDialog.label : (currentTab ? currentTab.label : ''))} />
      )}
      {refundFor && (
        <RefundDialog token={session.token} startWith={refundFor === 'find' ? null : refundFor} onClose={() => setRefundFor(null)}
          onShowReceipt={(id) => { setRefundFor(null); reprint(id); }} onChanged={moneyChanged} onAuth={sessionEnded} />
      )}
      {vipOpen && (
        <VipDialog token={session.token} startGuest={vipOpen.startGuest || null} onClose={() => setVipOpen(null)} onChanged={moneyChanged} onAuth={sessionEnded} />
      )}
      {iouOpen && <IouDialog token={session.token} onClose={() => setIouOpen(false)} onChanged={moneyChanged} onAuth={sessionEnded} />}
      {disputeFor && <DisputeDialog token={session.token} target={disputeFor} onClose={() => setDisputeFor(null)} onSaved={() => { setDisputeFor(null); setToast(tr('Sent to the manager.')); }} />}
      {stockOpen && (
        <div className="dialog-backdrop" onClick={() => setStockOpen(false)}>
          <div className="dialog pos-panel ts tl-stock" onClick={(e) => e.stopPropagation()}>
            <h2>{tr('Stock')}</h2>
            <StockTab token={session.token} pin={null} onFail={(err) => { if (err.status === 401) sessionEnded(); else setToast(err.message); }} />
            <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setStockOpen(false)}>{tr('Close')}</button></div>
          </div>
        </div>
      )}
      {prepOpen && <PrepDialog token={session.token} onClose={() => setPrepOpen(false)} />}
      {checksOpen && <ChecklistsDialog token={session.token} onClose={(d) => { if (d) setChecks(d); setChecksOpen(false); }} />}
      {cashOpen === 'drop' && drawer && <SafeDropDialog token={session.token} drawer={drawer} isManager={isManager} onClose={() => setCashOpen(null)} onDone={(d, text) => { setDrawer(d); setCashOpen(null); setToast(text); }} />}
      {cashOpen === 'petty' && drawer && <PettyCashDialog token={session.token} drawer={drawer} isManager={isManager} onClose={() => setCashOpen(null)} onDone={(d, text) => { setDrawer(d); setCashOpen(null); setToast(text); }} />}
      {eventsOpen && <EventsDialog token={session.token} onClose={() => setEventsOpen(false)} />}
      {incomingOpen && <IncomingDialog token={session.token} onClose={(d) => { if (d) setIncoming({ waiting: d.waiting, can: true }); setIncomingOpen(false); }} />}
      {wasteOpen && <WasteDialog token={session.token} onClose={() => setWasteOpen(false)} onToast={setToast} />}
      {brokenOpen && <BrokenDialog token={session.token} onClose={() => setBrokenOpen(false)} onDone={(text) => { setBrokenOpen(false); setToast(text); }} />}
      {notesOpen && <TeamNotes token={session.token} isManager={!!(notes && notes.canWrite)} initial={notes} onClose={(r) => { if (r) setNotes(r); setNotesOpen(false); }} />}
      {dutyBlocks && can('charge') && !drawer && dutyNotice && (
        <div className="dialog-backdrop">
          <div className="dialog tl-dialog tl-duty" role="alertdialog" aria-modal="true" aria-labelledby="tl-duty-title">
            <span className="tl-dialog-ico is-duty" aria-hidden="true"><Icon name="drawer" /></span>
            <h2 id="tl-duty-title">{tr('{name} is the cashier on duty', { name: otherOnDuty.name })}</h2>
            <p className="dk-muted">{tr('Only one cashier uses the drawer at a time. Their drawer has been open since {time}.', { time: timeOf(otherOnDuty.since) })}</p>
            <ul className="tl-duty-list">
              <li><Icon name="check" />{tr('You can take orders and send them to the kitchen.')}</li>
              <li><Icon name="void" />{tr('Charging, money and receipts wait until they close their drawer and you open yours.')}</li>
            </ul>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={logout}>{tr('Log out')}</button>
              <button type="button" className="btn btn-primary" autoFocus onClick={() => { setDutyNotice(false); setOrdersOnly(true); }}>{tr('Take orders')}</button>
            </div>
          </div>
        </div>
      )}
      {deliveryPrompt && !checkoutOpen && (
        <div className="dialog-backdrop" onClick={() => setDeliveryPrompt(null)}>
          <div className="dialog tl-dialog tl-deliver" role="alertdialog" aria-modal="true" aria-labelledby="tl-deliver-title" onClick={(e) => e.stopPropagation()}>
            <span className="tl-dialog-ico is-delivery" aria-hidden="true">🛵</span>
            <h2 id="tl-deliver-title">{tr('{name}\'s delivery is ready', { name: deliveryPrompt.guestName || deliveryPrompt.label })}</h2>
            <p className="dk-muted">{[deliveryPrompt.onlineRef, '#' + deliveryPrompt.number, deliveryPrompt.dishes === 1 ? tr('1 dish') : tr('{n} dishes', { n: deliveryPrompt.dishes })].filter(Boolean).join(' · ')}</p>
            <ul className="tl-duty-list tl-deliver-list">
              {deliveryPrompt.deliveryAddress && <li><Icon name="map" />{deliveryPrompt.deliveryAddress}</li>}
              {deliveryPrompt.customerPhone && <li><Icon name="phone" />{deliveryPrompt.customerPhone}</li>}
            </ul>
            <p className="dk-muted">{tr('Send it out now: pick one of your riders or type someone\'s name and phone, then send them their link.')}</p>
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDeliveryPrompt(null)}>{tr('Later')}</button>
              <button type="button" className="btn btn-primary" autoFocus onClick={() => sendOut({ tabId: deliveryPrompt.tabId, orderId: deliveryPrompt.orderId })}>🛵 {tr('Send with a rider')}</button>
            </div>
          </div>
        </div>
      )}
      {handIn && !checkoutOpen && (
        <HandInDialog token={session.token} tab={handIn} onClose={() => setHandIn(null)}
          onDone={(r) => { setHandIn(null); loadTabs(); loadShift(); refreshDrawer(); setToast(tr('{ref}: {amount} in the drawer.', { ref: r.delivery.ref, amount: money(r.delivery.money.handed.amount) }) + (r.delivery.money.short > 0 ? ' ' + tr('Short by {amount}: a manager will see it.', { amount: money(r.delivery.money.short) }) : '')); }} />
      )}
      {sendFor && (
        <Suspense fallback={null}>
          <SendDialog token={session.token} target={sendFor.target} riders={sendFor.riders} settings={sendFor.settings}
            onClose={() => setSendFor(null)} onDone={(d) => { setSendFor(null); loadKitchen(); loadTabs(); setToast(tr('{ref} is out with {rider}.', { ref: d.ref, rider: d.rider.name })); }} />
        </Suspense>
      )}
      {settingsOpen && (
        <TillSettings token={session.token} companyName={session.companyName} logoUrl={restaurantLogoUrl(session.companyCode)}
          onClose={() => setSettingsOpen(false)} onSaved={() => loadAccess()} onAuth={sessionEnded} />
      )}
    </div>
  );
}
