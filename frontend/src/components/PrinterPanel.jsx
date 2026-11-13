import { useEffect, useState } from 'react';
import { tr } from '../lib/i18n.jsx';
import {
  bluetoothSupported, buildTestBytes, deviceModel, iminTill, kitchenAddressOk, kitchenPrinterFor, passPrntComesBack, passPrntDrawer, passPrntPrinter, rawBtPrinter, requestBluetoothPrinter, requestUsbPrinter,
  saveNetworkPrinter, savePassPrnt, saveRawBt, saveSystemPrinter, setPassPrntComesBack, setPassPrntDrawer, systemPrinter, usbSupported
} from '../lib/thermalPrinter';
import './PrinterPanel.css';

// How this device prints (the till, on a computer or an Android till such
// as an iMin; the kitchen screen): the printer set up on the computer itself
// (a Star TSP100 on Bluetooth, USB or the network, through its driver and
// the browser's print box), a USB printer straight from Chrome (Star
// printers as a picture, others as ESC/POS text), or a Bluetooth Low Energy
// printer; on Android, USB first, with the iMin's set-up steps. A test
// print, and letting go of the printer. lib/thermalPrinter.js does the
// printing; the choice is kept on the device. On the till (kitchen, onKitchen:
// lib/thermalPrinter.js kitchenSetup), where kitchen tickets print: the same
// printer, or the kitchen's own Star printer on the network by its address.
// network: the restaurant's printers on its network that print receipts
// (Till settings → Printers), first when there are any; onNetwork(p) makes
// one this till's printer. networkKitchen: the kitchens have network
// printers of their own, printing their tickets by themselves.
export default function PrinterPanel({ printer, onPrinter, companyName, onClose, kitchen, onKitchen, network, onNetwork, networkKitchen }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const [own, setOwn] = useState(!!(kitchen && kitchen.address));
  const [address, setAddress] = useState(kitchen ? kitchen.address : '');
  const [help, setHelp] = useState(!printer && !(typeof navigator !== 'undefined' && /Android|iPad|iPhone/i.test(navigator.userAgent || '')));
  // Whether PassPRNT comes back by itself after printing: not in a Home
  // Screen app on an iPhone or iPad, where its way back opens Safari
  // (lib/thermalPrinter.js passPrntComesBack); kept on this device.
  const [comesBack, setComesBack] = useState(passPrntComesBack);
  // A cash drawer plugged into the Star printer, opened through PassPRNT for
  // cash sales: off until said (lib/thermalPrinter.js passPrntDrawer).
  const [drawerOn, setDrawerOn] = useState(passPrntDrawer);
  // An iMin till with its own printer (the Swan 2), found by its model.
  const [till, setTill] = useState(null);
  useEffect(() => { let live = true; deviceModel().then((m) => { if (live) setTill(iminTill(m)); }); return () => { live = false; }; }, []);
  // arg: the paper (58/80) for this computer's printer and PassPRNT, the
  // printer itself for one on the network.
  async function choose(kind, arg) {
    setBusy(kind); setError(null); setDone(null);
    try {
      let next;
      if (kind === 'network') next = onNetwork(arg);
      else if (kind === 'system') next = systemPrinter(arg);
      else if (kind === 'passprnt') next = passPrntPrinter(arg);
      else if (kind === 'rawbt') next = rawBtPrinter(arg);
      else next = kind === 'usb' ? await requestUsbPrinter() : await requestBluetoothPrinter();
      saveSystemPrinter(kind === 'system' ? arg : null);
      savePassPrnt(kind === 'passprnt' ? arg : null);
      saveRawBt(kind === 'rawbt' ? arg : null);
      saveNetworkPrinter(kind === 'network' ? arg : null);
      onPrinter(next);
    } catch (e) {
      if (e && e.name !== 'NotFoundError') setError(e.message);
    } finally { setBusy(null); }
  }
  async function test() {
    setBusy('test'); setError(null); setDone(null);
    try { await printer.write(buildTestBytes(companyName, { lineWidth: printer.lineWidth }), { kind: 'test', title: tr('Test print') }); setDone(tr('Test sent to the printer.')); } catch (e) { setError(tr('Could not print: {message}', { message: e.message })); } finally { setBusy(null); }
  }
  // The kitchen's printer: kept as soon as its address is whole.
  function kitchenTo(next) { onKitchen(Object.assign({}, kitchen, next)); }
  function pickOwn(on) {
    setOwn(on); setError(null); setDone(null);
    kitchenTo({ address: on && kitchenAddressOk(address) ? address.trim() : '' });
  }
  function typeAddress(v) {
    const a = v.replace(/[^0-9.]/g, '').slice(0, 15);
    setAddress(a);
    kitchenTo({ address: kitchenAddressOk(a) ? a : '' });
  }
  async function kitchenTest() {
    const kp = kitchenPrinterFor(printer, kitchen);
    if (!kp) return;
    setBusy('ktest'); setError(null); setDone(null);
    try { await kp.write(buildTestBytes(companyName, { lineWidth: kp.lineWidth })); setDone(tr('Test sent to the kitchen printer.')); } catch (e) { setError(tr('Could not print: {message}', { message: e.message })); } finally { setBusy(null); }
  }
  async function forget() {
    if (printer.forget) await printer.forget();
    saveSystemPrinter(null);
    savePassPrnt(null);
    saveRawBt(null);
    saveNetworkPrinter(null);
    onPrinter(null);
  }
  // An Android till (an iMin, a tablet): a USB printer straight from Chrome
  // is the way there (no Star driver for Android's printing); a computer's
  // own printer first elsewhere.
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  const android = /Android/i.test(ua);
  const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
  const systemWay = (
    <div key="system" className={'prp-way' + (printer && printer.kind === 'system' ? ' is-on' : '')}>
      <span className="prp-way-ico" aria-hidden="true">🖥️</span>
      <div className="prp-way-txt">
        <strong>{tr('This computer\'s printer')}</strong>
        <small>{tr('A printer set up on this computer with its own driver, such as a Star TSP100 on Bluetooth, USB or the network on a Mac. Receipts are laid out for the paper.')}</small>
      </div>
      <div className="prp-way-acts">
        {[80, 58].map((mm) => (
          <button key={mm} type="button" className={'prp-chip' + (printer && printer.kind === 'system' && printer.paper === mm ? ' is-on' : '')} disabled={!!busy} onClick={() => choose('system', mm)}>{tr('{n} mm', { n: mm })}</button>
        ))}
      </div>
    </div>
  );
  const usbWay = (
    <div key="usb" className={'prp-way' + (printer && printer.kind === 'usb' ? ' is-on' : '') + (usbSupported() ? '' : ' is-off')}>
      <span className="prp-way-ico" aria-hidden="true">🔌</span>
      <div className="prp-way-txt">
        <strong>{tr('USB printer, straight from Chrome')}</strong>
        <small>{usbSupported() ? tr('No driver needed. Star printers print the receipt as a picture; other receipt printers as text.') : tr('This browser cannot reach USB printers: use Chrome or Edge.')}</small>
      </div>
      <div className="prp-way-acts"><button type="button" className="prp-chip" disabled={!!busy || !usbSupported()} onClick={() => choose('usb')}>{busy === 'usb' ? tr('Connecting…') : tr('Connect')}</button></div>
    </div>
  );
  const btWay = (
    <div key="bt" className={'prp-way' + (printer && printer.kind === 'bluetooth' ? ' is-on' : '') + (bluetoothSupported() ? '' : ' is-off')}>
      <span className="prp-way-ico" aria-hidden="true">📶</span>
      <div className="prp-way-txt">
        <strong>{tr('Bluetooth LE printer')}</strong>
        <small>{tr('Small receipt printers on Bluetooth Low Energy. Star\'s Bluetooth printers use classic Bluetooth: choose Star printer, through the PassPRNT app.')}</small>
      </div>
      <div className="prp-way-acts"><button type="button" className="prp-chip" disabled={!!busy || !bluetoothSupported()} onClick={() => choose('bluetooth')}>{busy === 'bluetooth' ? tr('Connecting…') : tr('Connect')}</button></div>
    </div>
  );
  // A Star printer on the network (a TSP143LAN) or on Bluetooth: through
  // Star's PassPRNT app.
  const passWay = (
    <div key="pass" className={'prp-way' + (printer && printer.kind === 'passprnt' ? ' is-on' : '')}>
      <span className="prp-way-ico" aria-hidden="true">📲</span>
      <div className="prp-way-txt">
        <strong>{tr('Star printer, through the PassPRNT app')}{(android || ios) && <em className="prp-best is-bt">{tr('Network or Bluetooth')}</em>}</strong>
        <small>{ios && !comesBack
          ? tr('For a Star printer on the network (such as a TSP143LAN) or on Bluetooth: Star\'s free PassPRNT app prints each receipt, then tap ◀ at the top-left corner to come back to the till. Install it and choose the printer in it first.')
          : tr('For a Star printer on the network (such as a TSP143LAN) or on Bluetooth: Star\'s free PassPRNT app prints each receipt and brings you back to the till. Install it and choose the printer in it first.')}</small>
      </div>
      <div className="prp-way-acts">
        {[80, 58].map((mm) => (
          <button key={mm} type="button" className={'prp-chip' + (printer && printer.kind === 'passprnt' && printer.paper === mm ? ' is-on' : '')} disabled={!!busy} onClick={() => choose('passprnt', mm)}>{tr('{n} mm', { n: mm })}</button>
        ))}
      </div>
    </div>
  );
  // Any ESC/POS printer on an Android till — Bluetooth, USB, or one built
  // in — through the RawBT app.
  const rawPaper = (
    <div className="prp-way-acts">
      {[80, 58].map((mm) => (
        <button key={mm} type="button" className={'prp-chip' + (printer && printer.kind === 'rawbt' && printer.paper === mm ? ' is-on' : '')} disabled={!!busy} onClick={() => choose('rawbt', mm)}>{tr('{n} mm', { n: mm })}</button>
      ))}
    </div>
  );
  const rawWay = (
    <div key="raw" className={'prp-way' + (printer && printer.kind === 'rawbt' ? ' is-on' : '')}>
      <span className="prp-way-ico" aria-hidden="true">🤖</span>
      <div className="prp-way-txt">
        <strong>{tr('Any receipt printer, through the RawBT app')}</strong>
        <small>{tr('Epson and other receipt printers on Bluetooth or USB, and a printer built into the till: the free RawBT app prints each receipt and comes back. Install it and choose the printer in it first.')}</small>
      </div>
      {rawPaper}
    </div>
  );
  // This till's own printer (an iMin Swan 2): straight from Chrome over its
  // inside USB link, or through RawBT as the Bluetooth printer
  // "BluetoothPrinter" the till offers.
  const swan = till && android && (
    <section className="prp-swan" aria-labelledby="prp-swan-title">
      <div className="prp-swan-head">
        <span className="prp-swan-ico" aria-hidden="true">🧾</span>
        <div>
          <h3 id="prp-swan-title">{tr('This till\'s own printer')}</h3>
          <p>{tr('{name} ({model}): the receipt printer built into this till.', { name: till.name, model: till.model })}</p>
        </div>
      </div>
      <div className={'prp-way is-main' + (printer && printer.kind === 'usb' ? ' is-on' : '')}>
        <span className="prp-way-ico" aria-hidden="true">⚡</span>
        <div className="prp-way-txt">
          <strong>{tr('Straight from the till')}<em className="prp-best">{tr('Try first')}</em></strong>
          <small>{tr('No app: press Connect and pick the printer in the list (it may be called USB Printer). Allow Chrome to use it when Android asks.')}</small>
        </div>
        <div className="prp-way-acts"><button type="button" className="prp-chip" disabled={!!busy || !usbSupported()} onClick={() => choose('usb')}>{busy === 'usb' ? tr('Connecting…') : tr('Connect')}</button></div>
      </div>
      <div className={'prp-way' + (printer && printer.kind === 'rawbt' ? ' is-on' : '')}>
        <span className="prp-way-ico" aria-hidden="true">🤖</span>
        <div className="prp-way-txt">
          <strong>{tr('Through the RawBT app')}</strong>
          <small>{tr('Not in the list? Install RawBT from Google Play. In RawBT, choose Bluetooth and the printer called BluetoothPrinter (the built-in one), then pick the paper here.')}</small>
        </div>
        {rawPaper}
      </div>
    </section>
  );
  const nets = network || [];
  const netWays = nets.length > 0 && (
    <div key="net" className="prp-net">
      <h3>🖧 {tr('Printers on the restaurant\'s network')}</h3>
      {nets.map((p) => {
        const on = printer && printer.kind === 'network' && printer.id === p.id;
        return (
          <div key={p.id} className={'prp-way' + (on ? ' is-on' : '')}>
            <span className="prp-way-ico" aria-hidden="true">🖨️<i className={'prp-net-dot' + (p.online ? '' : ' is-off') + (p.problem && p.problem !== 'offline' && p.problem !== 'low' ? ' is-bad' : '')} /></span>
            <div className="prp-way-txt">
              <strong>{p.name}</strong>
              <small>{p.online ? (p.problem && p.problem !== 'low' ? tr('Online, but not printing: {why}', { why: p.statusText || p.problem }) : tr('Online · {n} mm · receipts, bills and reports print here from any till', { n: p.paper })) : tr('Offline: switched off or not on the network')}</small>
            </div>
            <div className="prp-way-acts"><button type="button" className={'prp-chip' + (on ? ' is-on' : '')} disabled={!!busy} onClick={() => choose('network', p)}>{on ? '✓ ' + tr('In use') : tr('Use')}</button></div>
          </div>
        );
      })}
    </div>
  );
  const kindText = !printer ? '' : printer.auto ? tr('Set for every till in Till settings → Printers · {n} mm paper', { n: printer.paper }) : printer.kind === 'network' ? tr('On the restaurant\'s network · {n} mm paper', { n: printer.paper }) : printer.kind === 'system' ? tr('Through this computer · {n} mm paper', { n: printer.paper })
    : printer.kind === 'passprnt' ? tr('Through PassPRNT · {n} mm paper', { n: printer.paper })
    : printer.kind === 'rawbt' ? tr('Through RawBT · {n} mm paper', { n: printer.paper })
    : printer.kind === 'usb' ? (printer.star ? tr('USB · Star, printed as a picture') : tr('USB')) : tr('Bluetooth');
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog prp" role="dialog" aria-modal="true" aria-labelledby="prp-title" onClick={(e) => e.stopPropagation()}>
        <div className="prp-head">
          <span className="prp-ico" aria-hidden="true">🖨️</span>
          <div><h2 id="prp-title">{tr('Printer')}</h2><p>{tr('Receipts, bills and kitchen tickets from this device.')}</p></div>
          <button type="button" className="prp-x" onClick={onClose} aria-label={tr('Close')}>✕</button>
        </div>

        {printer ? (
          <div className="prp-now">
            <span className="prp-dot" aria-hidden="true" />
            <div><strong>{printer.name}</strong><small>{kindText}</small></div>
            <button type="button" className="btn btn-primary" disabled={!!busy} onClick={test}>{busy === 'test' ? tr('Printing…') : tr('Print a test')}</button>
            {!printer.auto && <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={forget}>{tr('Disconnect')}</button>}
          </div>
        ) : <p className="prp-none">{tr('No printer yet: choose how this device prints.')}</p>}
        {printer && printer.auto && <p className="prp-auto">{tr('Chosen by the restaurant: every till with no printer of its own prints its receipts and bills here, with nothing to set up on the device. To print somewhere else from this till, choose another printer below.')}</p>}
        {printer && printer.kind === 'passprnt' && ios && (
          <button type="button" role="switch" aria-checked={comesBack} className="prp-kit-switch prp-back"
            onClick={() => { setPassPrntComesBack(!comesBack); setComesBack(!comesBack); }}>
            <span><strong>{tr('Come back to the till by itself after printing')}</strong>
              <small>{comesBack
                ? tr('PassPRNT then opens the till\'s web address, which an iPad or iPhone opens in Safari, not in the till on the Home Screen. Keep this on only when the till is used in Safari.')
                : tr('Off: best for the till on the Home Screen. Once PassPRNT has printed, tap ◀ at the top-left corner (or swipe right along the bottom edge) to come back to the till just as you left it.')}</small></span>
            <span className={'prp-switch' + (comesBack ? ' is-on' : '')} aria-hidden="true"><i /></span>
          </button>
        )}
        {printer && printer.kind === 'passprnt' && (
          <button type="button" role="switch" aria-checked={drawerOn} className="prp-kit-switch prp-drawer"
            onClick={() => { setPassPrntDrawer(!drawerOn); setDrawerOn(!drawerOn); }}>
            <span><strong>{tr('A cash drawer is plugged into this printer')}</strong>
              <small>{drawerOn
                ? tr('PassPRNT opens it once the receipt of a cash sale has printed. If cash receipts stop printing, turn this off.')
                : tr('Off: receipts print without asking for a drawer. Turn it on only if a cash drawer is plugged into the printer, to open it for cash sales.')}</small></span>
            <span className={'prp-switch' + (drawerOn ? ' is-on' : '')} aria-hidden="true"><i /></span>
          </button>
        )}
        {done && <p className="prp-ok" role="status">✅ {done}</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}

        {swan}
        {netWays}
        <div className="prp-ways">{android ? [passWay, rawWay, usbWay, systemWay, btWay] : ios ? [passWay, usbWay, systemWay, btWay] : [systemWay, usbWay, passWay, btWay]}</div>

        {!ios && (
          <details className="prp-help" open={help} onToggle={(e) => setHelp(e.currentTarget.open)}>
            {android ? (
              <>
                <summary>⭐ {tr('A Star printer on a USB cable (this Android till)')}</summary>
                <ol>
                  <li>{tr('Plug the printer\'s USB cable into one of the till\'s USB ports, and switch the printer on.')}</li>
                  <li>{tr('Open the till in Chrome, or in the till installed from Chrome on the home screen. Other apps cannot reach USB printers.')}</li>
                  <li>{tr('Here, choose USB printer, straight from Chrome, press Connect and pick the Star (TSP100 or TSP143) in the list.')}</li>
                  <li>{tr('When Android asks, allow Chrome to use the printer. If it asks which app should open the printer, choose Chrome.')}</li>
                  <li>{tr('Print a test: the receipt prints as a picture and is cut. A cash drawer plugged into the printer opens for cash sales.')}</li>
                </ol>
              </>
            ) : (
              <>
                <summary>⭐ {tr('Setting up a Star TSP100 on a Mac')}</summary>
                <ol>
                  <li>{tr('Install Star\'s printer driver for macOS (from starmicronics.com, Support → Drivers, for the TSP100).')}</li>
                  <li>{tr('Connect the printer: pair it in System Settings → Bluetooth, or plug in its USB cable.')}</li>
                  <li>{tr('Add it in System Settings → Printers & Scanners, and make it the default printer. Paper: 72mm × Receipt (80mm roll).')}</li>
                  <li>{tr('Here, choose This computer\'s printer and 80 mm, then Print a test.')}</li>
                  <li>{tr('To print without the print box each time, open Chrome with kiosk printing: in Terminal, type open -a "Google Chrome" --args --kiosk-printing (Chrome closed first). Receipts then go straight to the default printer.')}</li>
                  <li>{tr('In the same Options: cut at the end of each page, and paper reduction on, so no blank paper comes out after a receipt.')}</li>
                  <li>{tr('The cash drawer: in the printer\'s driver settings (Printers & Scanners → Options), set the cash drawer to open with each receipt.')}</li>
                </ol>
                <p>{tr('With a USB cable, choosing USB printer, straight from Chrome works too, without a driver: the till sends the receipt to the Star as a picture.')}</p>
              </>
            )}
          </details>
        )}

        {kitchen && (
          <section className="prp-kit" aria-labelledby="prp-kit-title">
            <div className="prp-kit-head">
              <span className="prp-kit-ico" aria-hidden="true">🍳</span>
              <div>
                <h3 id="prp-kit-title">{tr('Kitchen tickets')}</h3>
                <p>{tr('Each order sent to the kitchen prints there by itself, as it is sent.')}</p>
              </div>
            </div>
            {networkKitchen && <p className="prp-kit-net">✅ {tr('The kitchens have their own printers on the network: their tickets print there by themselves (Till settings → Printers). This is only for stations without one.')}</p>}
            <div className="prp-seg" role="radiogroup" aria-label={tr('Kitchen tickets print on')}>
              <button type="button" role="radio" aria-checked={!own} className={!own ? 'is-on' : ''} onClick={() => pickOwn(false)}>
                <span aria-hidden="true">🧾</span><span><strong>{tr('This printer')}</strong><small>{tr('With the receipts')}</small></span>
              </button>
              <button type="button" role="radio" aria-checked={own} className={own ? 'is-on' : ''} disabled={!(android || ios)} onClick={() => pickOwn(true)}>
                <span aria-hidden="true">📡</span><span><strong>{tr('The kitchen\'s own printer')}</strong><small>{android || ios ? tr('A Star on the network, such as a TSP143LAN') : tr('On an Android till or iPad, with PassPRNT')}</small></span>
              </button>
            </div>
            {own && (android || ios) && (
              <div className="prp-kit-own">
                <label className="prp-kit-addr">
                  <span>{tr('The kitchen printer\'s address')}</span>
                  <input className="input" inputMode="decimal" autoComplete="off" spellCheck={false} placeholder="192.168.1.50" value={address} onChange={(e) => typeAddress(e.target.value)}
                    aria-invalid={!!address && !kitchenAddressOk(address)} />
                </label>
                <div className="prp-way-acts">
                  {[80, 58].map((mm) => (
                    <button key={mm} type="button" className={'prp-chip' + (kitchen.paper === mm ? ' is-on' : '')} onClick={() => kitchenTo({ paper: mm })}>{tr('{n} mm', { n: mm })}</button>
                  ))}
                </div>
                <button type="button" className="btn btn-primary prp-kit-test" disabled={!!busy || !kitchenAddressOk(address)} onClick={kitchenTest}>{busy === 'ktest' ? tr('Printing…') : '🍳 ' + tr('Test the kitchen printer')}</button>
                <small className="prp-kit-hint">{address && !kitchenAddressOk(address) ? tr('Four numbers with dots, such as 192.168.1.50.')
                  : tr('Hold the printer\'s FEED button while switching it on: the page it prints shows its IP address. The printer and this till must be on the same network, with PassPRNT installed here.')}</small>
              </div>
            )}
            <button type="button" role="switch" aria-checked={kitchen.others} className="prp-kit-switch" onClick={() => kitchenTo({ others: !kitchen.others })}>
              <span><strong>{tr('Also orders from the website, kiosk and tables')}</strong>
                <small>{tr('Orders that reach the kitchen without this till print here too. With PassPRNT, tap Print on the till when they come: Android lets an app open only from a tap.')}</small></span>
              <span className={'prp-switch' + (kitchen.others ? ' is-on' : '')} aria-hidden="true"><i /></span>
            </button>
            <p className="prp-kit-note">{tr('Which stations print: Till settings → Kitchen screens → No screen: print its tickets.')}</p>
          </section>
        )}

        {(android || ios) && (
          <details className="prp-help is-bt" open={!printer || printer.kind === 'passprnt'}>
            <summary>📲 {tr('A Star printer on the network or Bluetooth (PassPRNT)')}</summary>
            <ol>
              <li>{tr('Find the model on the label under the printer. LAN (such as TSP143LAN): plug its network cable into the router the till\'s Wi-Fi comes from, and switch it on. BI (such as TSP143IIIBI): pair it in the till\'s Settings → Bluetooth (code 1234 if asked).')}</li>
              <li>{ios ? tr('Install Star PassPRNT (free) from the App Store.') : tr('Install Star PassPRNT (free) from Google Play.')}</li>
              <li>{tr('Open PassPRNT, tap Printer and pick the Star in the list (one on the network shows its address, TCP:192.168…), set the paper to 3 inch (80mm), then Check communication.')}</li>
              <li>{tr('Not in the list? Hold the printer\'s FEED button while switching it on: it prints its settings, with its IP address. The till and the printer must be on the same network.')}</li>
              <li>{ios && !comesBack
                ? tr('Here, choose Star printer, through the PassPRNT app and 80 mm, then Print a test. Each print opens PassPRNT: once it has printed, tap ◀ at the top-left corner (or swipe right along the bottom edge) to come back to the till.')
                : tr('Here, choose Star printer, through the PassPRNT app and 80 mm, then Print a test. Each print opens PassPRNT for a moment and comes back to the till.')}</li>
              {ios && <li>{tr('On an iPad or iPhone, open the till from its icon on the Home Screen, not in Safari: Safari is a till of its own, with its own sign-in and printer.')}</li>}
              <li>{tr('On the kitchen screen, new tickets cannot print by themselves this way: tap Print ticket.')}</li>
            </ol>
          </details>
        )}

        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Done')}</button></div>
      </div>
    </div>
  );
}
