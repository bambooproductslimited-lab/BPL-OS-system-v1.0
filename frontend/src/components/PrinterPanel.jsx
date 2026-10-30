import { useState } from 'react';
import { tr } from '../lib/i18n.jsx';
import {
  bluetoothSupported, buildTestBytes, requestBluetoothPrinter, requestUsbPrinter, saveSystemPrinter, systemPrinter, usbSupported
} from '../lib/thermalPrinter';
import './PrinterPanel.css';

// How this device prints (the till, on a computer or an Android till such
// as an iMin; the kitchen screen): the printer set up on the computer itself
// (a Star TSP100 on Bluetooth, USB or the network, through its driver and
// the browser's print box), a USB printer straight from Chrome (Star
// printers as a picture, others as ESC/POS text), or a Bluetooth Low Energy
// printer; on Android, USB first, with the iMin's set-up steps. A test
// print, and letting go of the printer. lib/thermalPrinter.js does the
// printing; the choice is kept on the device.
export default function PrinterPanel({ printer, onPrinter, companyName, onClose }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const [help, setHelp] = useState(!printer);
  async function choose(kind, mm) {
    setBusy(kind); setError(null); setDone(null);
    try {
      let next;
      if (kind === 'system') { next = systemPrinter(mm); saveSystemPrinter(mm); }
      else next = kind === 'usb' ? await requestUsbPrinter() : await requestBluetoothPrinter();
      if (kind !== 'system') saveSystemPrinter(null);
      onPrinter(next);
    } catch (e) {
      if (e && e.name !== 'NotFoundError') setError(e.message);
    } finally { setBusy(null); }
  }
  async function test() {
    setBusy('test'); setError(null); setDone(null);
    try { await printer.write(buildTestBytes(companyName, { lineWidth: printer.lineWidth })); setDone(tr('Test sent to the printer.')); } catch (e) { setError(tr('Could not print: {message}', { message: e.message })); } finally { setBusy(null); }
  }
  async function forget() {
    if (printer.forget) await printer.forget();
    saveSystemPrinter(null);
    onPrinter(null);
  }
  // An Android till (an iMin, a tablet): a USB printer straight from Chrome
  // is the way there (no Star driver for Android's printing); a computer's
  // own printer first elsewhere.
  const android = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');
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
        <strong>{tr('USB printer, straight from Chrome')}{android && usbSupported() && <em className="prp-best">{tr('Best for this till')}</em>}</strong>
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
        <small>{tr('Small receipt printers on Bluetooth Low Energy. Star\'s Bluetooth printers use classic Bluetooth, which web pages cannot reach: set them up on the computer and choose This computer\'s printer.')}</small>
      </div>
      <div className="prp-way-acts"><button type="button" className="prp-chip" disabled={!!busy || !bluetoothSupported()} onClick={() => choose('bluetooth')}>{busy === 'bluetooth' ? tr('Connecting…') : tr('Connect')}</button></div>
    </div>
  );
  const kindText = !printer ? '' : printer.kind === 'system' ? tr('Through this computer · {n} mm paper', { n: printer.paper })
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

        <div className="prp-ways">{(android ? [usbWay, systemWay, btWay] : [systemWay, usbWay, btWay])}</div>

        <details className="prp-help" open={help} onToggle={(e) => setHelp(e.currentTarget.open)}>
          {android ? (
            <>
              <summary>⭐ {tr('Setting up a Star TSP100 on this Android till (iMin)')}</summary>
              <ol>
                <li>{tr('Plug the printer\'s USB cable into one of the till\'s USB ports, and switch the printer on.')}</li>
                <li>{tr('Open the till in Chrome, or in the till installed from Chrome on the home screen. Other apps cannot reach USB printers.')}</li>
                <li>{tr('Here, choose USB printer, straight from Chrome, press Connect and pick the Star (TSP100 or TSP143) in the list.')}</li>
                <li>{tr('When Android asks, allow Chrome to use the printer. If it asks which app should open the printer, choose Chrome.')}</li>
                <li>{tr('Print a test: the receipt prints as a picture and is cut. A cash drawer plugged into the printer opens for cash sales.')}</li>
              </ol>
              <p>{tr('Star\'s Bluetooth printers cannot be reached from a web page on Android: use the printer\'s USB cable.')}</p>
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

        <div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Done')}</button></div>
      </div>
    </div>
  );
}
