import { useState } from 'react';
import { tr } from '../lib/i18n.jsx';
import {
  bluetoothSupported, buildTestBytes, kitchenAddressOk, kitchenPrinterFor, passPrntPrinter, requestBluetoothPrinter, requestUsbPrinter, savePassPrnt, saveSystemPrinter, systemPrinter, usbSupported
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
export default function PrinterPanel({ printer, onPrinter, companyName, onClose, kitchen, onKitchen }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const [own, setOwn] = useState(!!(kitchen && kitchen.address));
  const [address, setAddress] = useState(kitchen ? kitchen.address : '');
  const [help, setHelp] = useState(!printer && !(typeof navigator !== 'undefined' && /Android|iPad|iPhone/i.test(navigator.userAgent || '')));
  async function choose(kind, mm) {
    setBusy(kind); setError(null); setDone(null);
    try {
      let next;
      if (kind === 'system') next = systemPrinter(mm);
      else if (kind === 'passprnt') next = passPrntPrinter(mm);
      else next = kind === 'usb' ? await requestUsbPrinter() : await requestBluetoothPrinter();
      saveSystemPrinter(kind === 'system' ? mm : null);
      savePassPrnt(kind === 'passprnt' ? mm : null);
      onPrinter(next);
    } catch (e) {
      if (e && e.name !== 'NotFoundError') setError(e.message);
    } finally { setBusy(null); }
  }
  async function test() {
    setBusy('test'); setError(null); setDone(null);
    try { await printer.write(buildTestBytes(companyName, { lineWidth: printer.lineWidth })); setDone(tr('Test sent to the printer.')); } catch (e) { setError(tr('Could not print: {message}', { message: e.message })); } finally { setBusy(null); }
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
        <small>{tr('For a Star printer on the network (such as a TSP143LAN) or on Bluetooth: Star\'s free PassPRNT app prints each receipt and brings you back to the till. Install it and choose the printer in it first.')}</small>
      </div>
      <div className="prp-way-acts">
        {[80, 58].map((mm) => (
          <button key={mm} type="button" className={'prp-chip' + (printer && printer.kind === 'passprnt' && printer.paper === mm ? ' is-on' : '')} disabled={!!busy} onClick={() => choose('passprnt', mm)}>{tr('{n} mm', { n: mm })}</button>
        ))}
      </div>
    </div>
  );
  const kindText = !printer ? '' : printer.kind === 'system' ? tr('Through this computer · {n} mm paper', { n: printer.paper })
    : printer.kind === 'passprnt' ? tr('Through PassPRNT · {n} mm paper', { n: printer.paper })
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
            <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={forget}>{tr('Disconnect')}</button>
          </div>
        ) : <p className="prp-none">{tr('No printer yet: choose how this device prints.')}</p>}
        {done && <p className="prp-ok" role="status">✅ {done}</p>}
        {error && <div className="error-banner" role="alert">{error}</div>}

        <div className="prp-ways">{android || ios ? [passWay, usbWay, systemWay, btWay] : [systemWay, usbWay, passWay, btWay]}</div>

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
              <li>{tr('Here, choose Star printer, through the PassPRNT app and 80 mm, then Print a test. Each print opens PassPRNT for a moment and comes back to the till.')}</li>
              <li>{tr('On the kitchen screen, new tickets cannot print by themselves this way: tap Print ticket.')}</li>
            </ol>
          </details>
        )}

        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Done')}</button></div>
      </div>
    </div>
  );
}
