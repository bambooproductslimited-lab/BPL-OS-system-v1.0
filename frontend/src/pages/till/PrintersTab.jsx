import { useCallback, useEffect, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import { printerState } from './printerState';
import './printers.css';

// Till settings → Printers, as on Square: the restaurant's printers on its
// network (backend restaurantPrinters.service.js). Each Star printer is
// plugged into the router and given the restaurant's printer link (its
// CloudPRNT server URL); it then shows up here by itself, to be named and
// given its profile — the stations whose kitchen tickets it prints, the
// order summary for the cashier, receipts and bills from the tills, void
// tickets, its paper and copies. A test print; taking one off. Looked at
// again every few seconds, so a printer just set up appears.
//
// Printers are found by themselves by the Bamboo print hub (tools/print-hub,
// backend restaurantPrintHub.service.js): a small program on a computer that
// stays on at the restaurant finds every Epson, Star and other receipt
// printer on the network — nothing set on the printers — and its tickets go
// through it. Star printers can instead ask by themselves (CloudPRNT), with
// the link put in each printer's settings.

const NAMES = () => [tr('Kitchen'), tr('Grill'), tr('Bar'), tr('Counter')];
// The print hub, from the till's own website (put there with the till's files).
const DOWNLOADS = { windows: '/downloads/bamboo-print-hub-windows.zip', others: '/downloads/bamboo-print-hub.zip' };
const MAKE = { epson: () => 'Epson', star: () => 'Star Micronics', escpos: () => tr('Receipt printer') };
function whatItIs(p) { return [MAKE[p.make] ? MAKE[p.make]() : '', p.model].filter(Boolean).join(' '); }

function Editor({ p, stations, busy, onSave, onCancel }) {
  const [f, setF] = useState({ name: p.name || '', paper: p.paper || 80, stationIds: p.stationIds || [], stubs: !!p.stubs, receipts: !!p.receipts, voids: p.voids !== false, copies: p.copies || 1, commandSet: p.commandSet || '' });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const toggleStation = (id) => set('stationIds', f.stationIds.includes(id) ? f.stationIds.filter((x) => x !== id) : f.stationIds.concat([id]));
  const row = (k, title, note) => (
    <button type="button" role="switch" aria-checked={!!f[k]} className="ts-toggle-row" onClick={() => set(k, !f[k])}>
      <span><strong>{title}</strong><small>{note}</small></span>
      <span className={'ts-switch' + (f[k] ? ' is-on' : '')} aria-hidden="true"><i /></span>
    </button>
  );
  return (
    <div className="tpr-edit">
      <label className="tpr-field">
        <span>{tr('Name')}</span>
        <input className="input" value={f.name} maxLength={40} placeholder={tr('Such as Kitchen, Grill, Bar or Counter')} onChange={(e) => set('name', e.target.value)} />
      </label>
      <div className="tpr-quick">{NAMES().map((n) => <button key={n} type="button" className={'tpr-chip' + (f.name === n ? ' is-on' : '')} onClick={() => set('name', n)}>{n}</button>)}</div>

      <div className="tpr-block">
        <h5>🍳 {tr('Kitchen tickets for')}</h5>
        <p>{tr('Each order prints here with only these stations\' dishes, as soon as it is sent to the kitchen.')}</p>
        {stations.length ? (
          <div className="tpr-quick">
            {stations.map((s) => <button key={s.id} type="button" role="checkbox" aria-checked={f.stationIds.includes(s.id)} className={'tpr-chip is-station' + (f.stationIds.includes(s.id) ? ' is-on' : '')} onClick={() => toggleStation(s.id)}>{f.stationIds.includes(s.id) ? '✓ ' : ''}{s.name}</button>)}
          </div>
        ) : <p className="ts-note">{tr('No stations yet: they are set up in the app under Restaurants → Kitchen.')}</p>}
      </div>
      {row('stubs', '🧾 ' + tr('Order summary for the cashier'), tr('Every order sent to the kitchen prints here too: all its dishes, which kitchen each went to and who sent it.'))}
      {row('receipts', '💵 ' + tr('Receipts and bills'), tr('Tills can print their receipts, bills and drawer reports here, and open the cash drawer plugged into it.'))}
      {row('voids', '🚫 ' + tr('Void tickets'), tr('A dish taken off after it was sent prints VOID at its kitchen, so it is not made.'))}
      <div className="tpr-two">
        <div className="tpr-block">
          <h5>{tr('Paper')}</h5>
          <div className="tpr-quick">{[80, 58].map((mm) => <button key={mm} type="button" className={'tpr-chip' + (f.paper === mm ? ' is-on' : '')} onClick={() => set('paper', mm)}>{tr('{n} mm', { n: mm })}</button>)}</div>
        </div>
        <div className="tpr-block">
          <h5>{tr('Copies of each kitchen ticket')}</h5>
          <div className="tpr-quick">{[1, 2, 3].map((n) => <button key={n} type="button" className={'tpr-chip' + (f.copies === n ? ' is-on' : '')} onClick={() => set('copies', n)}>{n}</button>)}</div>
        </div>
      </div>
      {p.via === 'hub' && (
        <div className="tpr-block">
          <h5>{tr('Printer language')}</h5>
          <p>{tr('Automatic suits nearly every printer. If the test print comes out as odd characters or blank paper, choose the other one.')}</p>
          <div className="tpr-quick">
            {[['', tr('Automatic')], ['escpos', tr('ESC/POS (Epson and most others)')], ['star', 'Star Micronics']].map(([k, label]) => (
              <button key={k || 'auto'} type="button" className={'tpr-chip' + (f.commandSet === k ? ' is-on' : '')} onClick={() => set('commandSet', k)}>{label}</button>
            ))}
          </div>
        </div>
      )}
      <div className="tpr-acts">
        <button type="button" className="btn btn-primary" disabled={busy || !f.name.trim()} onClick={() => onSave(f)}>{busy ? tr('Saving…') : tr('Save printer')}</button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={onCancel}>{tr('Cancel')}</button>
      </div>
    </div>
  );
}

export default function PrintersTab({ token, pin, onFail }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);
  const [copied, setCopied] = useState(false);
  const [done, setDone] = useState(null);
  const call = useCallback(async (body) => posFetch('POST', '/pos/settings/printers', token, { managerPin: pin || undefined, ...body }), [token, pin]);
  const load = useCallback(async () => { try { setData(await call({ action: 'list' })); } catch (err) { onFail(err); } }, [call, onFail]);
  useEffect(() => { load(); const t = setInterval(load, 6000); return () => clearInterval(t); }, [load]);
  async function act(body, text) {
    setBusy(true); setDone(null);
    try { setData(await call(body)); setEditing(null); if (text) setDone(text); } catch (err) { onFail(err); } finally { setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(data.link); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { /* the link stays on screen to copy by hand */ }
  }
  if (!data) return <section className="ts-sec"><p className="dk-muted">{tr('Loading…')}</p></section>;
  const fresh = data.printers.filter((p) => p.isNew);
  const named = data.printers.filter((p) => !p.isNew);
  const stationName = (id) => (data.stations.find((s) => s.id === id) || {}).name;
  const hubs = data.hubs || [];
  const time = (iso) => new Date(iso).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' });
  const where = (p) => [p.via === 'hub' ? tr('through the print hub') : 'CloudPRNT', p.ip].filter(Boolean).join(' · ');

  return (
    <section className="ts-sec tpr">
      <p className="dk-muted">{tr('Printers in the kitchens, at the bar and at the counter, on the restaurant\'s network. When an order is sent to the kitchen, each kitchen prints its own dishes at once and the cashier\'s printer prints the order summary, from a till, a waiter\'s phone, the website, the kiosk or a table\'s QR code.')}</p>

      <section className={'tpr-hubbox' + (hubs.some((h) => h.online) ? ' is-on' : '')} aria-labelledby="tpr-hub-title">
        <div className="tpr-hubbox-head">
          <span className="tpr-hub-ico" aria-hidden="true">🛰️</span>
          <span>
            <strong id="tpr-hub-title">{tr('Printers found by themselves')}</strong>
            <small>{tr('The Bamboo print hub, on a computer that stays on at the restaurant, finds every Epson, Star and other receipt printer on the network with a cable. Nothing to set on the printers.')}</small>
          </span>
        </div>
        {hubs.map((h) => (
          <div key={h.id} className={'tpr-hub' + (h.online ? ' is-on' : ' is-off')}>
            <span className="tpr-hub-pulse" aria-hidden="true" />
            <span className="tpr-main">
              <strong>🖥️ {h.name}</strong>
              <small>{h.online ? tr('Watching {networks} · {n} printer(s) found', { networks: h.networks || tr('the network'), n: h.found }) : tr('Not heard from since {time}: is that computer on, with the hub open?', { time: time(h.lastSeenAt) })}</small>
            </span>
            {h.outdated && <span className="tpr-pill is-warn">{tr('A newer hub is available')}</span>}
          </div>
        ))}
        {!hubs.length && (
          <ol>
            <li>{tr('On a computer at the restaurant that stays on (the office computer, a laptop or a Raspberry Pi), on the same network as the printers, download the print hub:')}</li>
            <li>{tr('Unzip it and open Bamboo print hub. When it asks, paste this restaurant\'s printer link (Copy link below). On Windows, say yes when it offers to start with the computer.')}</li>
            <li>{tr('Within a minute every receipt printer on the network shows up below with its make and model, to be named. A printer plugged in later appears on its own.')}</li>
          </ol>
        )}
        <div className="tpr-dl">
          <a className="btn btn-primary" href={DOWNLOADS.windows} download>⬇ {tr('Print hub for Windows')}</a>
          <a className="btn btn-secondary" href={DOWNLOADS.others} download>⬇ {tr('Mac, Linux, Raspberry Pi')}</a>
        </div>
        <div className="tpr-link">
          <code>{data.link}</code>
          <button type="button" className="btn btn-primary" onClick={copy}>{copied ? '✓ ' + tr('Copied') : tr('Copy link')}</button>
        </div>
        <p className="tpr-hint">{tr('Keep this link to yourselves: any printer or hub given it prints this restaurant\'s tickets. Ask the router to keep each printer\'s address the same (a reserved address), so it is always found.')}</p>
      </section>

      <details className="tpr-connect">
        <summary><span className="tpr-connect-ico" aria-hidden="true">🔌</span><span><strong>{tr('Or: a Star printer that asks by itself (CloudPRNT)')}</strong><small>{tr('Without a computer: Star printers with CloudPRNT, on an Ethernet cable: mC-Print3, TSP100IV, TSP143IIILAN…')}</small></span></summary>
        <ol>
          <li>{tr('Plug the printer\'s network cable into the router (or a switch) and switch it on.')}</li>
          <li>{tr('Find its IP address: switch it off, hold FEED and switch it on. The second slip shows it under Current IP Parameters Status.')}</li>
          <li>{tr('On a phone or computer on the same Wi-Fi, open http:// and that address. Sign in as root: the password is public, or the one on the label under the printer. Open CloudPRNT, turn it on and paste this link as the Server URL. Polling: 5 seconds. Save, then restart the printer.')}</li>
          <li>{tr('Within a few seconds it appears below: give it a name and choose what it prints.')}</li>
        </ol>
      </details>

      {fresh.length > 0 && (
        <div className="ts-scr-new">
          <h4><span className="ts-scr-pulse" aria-hidden="true" />{tr('New printers on the network')}</h4>
          {fresh.map((p) => (
            <div key={p.id} className="tpr-card is-new">
              <div className="tpr-head">
                <span className="tpr-ico" aria-hidden="true">🖨️</span>
                <span className="tpr-main"><strong>{whatItIs(p) || tr('New printer')}</strong><small>{where(p)} · {printerState(p).text}</small></span>
                {editing !== p.id && <button type="button" className="btn btn-primary" onClick={() => setEditing(p.id)}>{tr('Set up this printer')}</button>}
              </div>
              {editing === p.id && <Editor p={p} stations={data.stations} busy={busy} onCancel={() => setEditing(null)} onSave={(f) => act({ action: 'save', id: p.id, ...f }, tr('{name} is ready.', { name: f.name }))} />}
              {editing !== p.id && p.via === 'hub' && <button type="button" className="pos-link tpr-remove" disabled={busy} onClick={() => act({ action: 'remove', id: p.id }, tr('Taken off: it is not offered again.'))}>{tr('Not a printer for tickets: take it off')}</button>}
            </div>
          ))}
        </div>
      )}

      {done && <p className="tpr-done" role="status">✅ {done}</p>}

      {named.length > 0 && <h4 className="ts-scr-h">{tr('Printers')} <small>{named.length}</small></h4>}
      {named.map((p) => {
        const st = printerState(p);
        const does = [p.stationIds.length ? '🍳 ' + p.stationIds.map(stationName).filter(Boolean).join(', ') : '', p.stubs ? '🧾 ' + tr('Order summary') : '', p.receipts ? '💵 ' + tr('Receipts and bills') : '', p.voids && p.stationIds.length ? '🚫 ' + tr('Voids') : ''].filter(Boolean);
        return (
          <div key={p.id} className={'tpr-card is-' + st.tone}>
            <div className="tpr-head">
              <span className="tpr-ico" aria-hidden="true">🖨️<i className={'tpr-dot is-' + st.tone} /></span>
              <span className="tpr-main">
                <strong>{p.name}</strong>
                <small><b className={'tpr-state is-' + st.tone}>{st.text}</b> · {tr('{n} mm', { n: p.paper })}{p.copies > 1 ? ' · ' + tr('{n} copies', { n: p.copies }) : ''}{p.waiting ? ' · ' + tr('{n} waiting', { n: p.waiting }) : ''}</small>
              </span>
              {editing !== p.id && (
                <span className="tpr-btns">
                  <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => act({ action: 'test', id: p.id }, tr('A test is on its way to {name}.', { name: p.name }))}>{tr('Print a test')}</button>
                  <button type="button" className="btn btn-secondary" onClick={() => setEditing(p.id)}>{tr('Edit')}</button>
                </span>
              )}
            </div>
            {editing !== p.id && (
              <div className="tpr-does">
                {does.length ? does.map((d) => <span key={d} className="tpr-pill">{d}</span>) : <span className="tpr-pill is-none">{tr('Prints nothing yet: edit it to choose')}</span>}
                <span className="tpr-mac">{[whatItIs(p), where(p)].filter(Boolean).join(' · ')}</span>
              </div>
            )}
            {editing === p.id && (
              <>
                <Editor p={p} stations={data.stations} busy={busy} onCancel={() => setEditing(null)} onSave={(f) => act({ action: 'save', id: p.id, ...f }, tr('{name} saved.', { name: f.name }))} />
                <button type="button" className="pos-link is-bad tpr-remove" disabled={busy} onClick={() => { if (window.confirm(p.via === 'hub' ? tr('Take {name} off? Its tickets stop printing there, and the print hub stops offering it.', { name: p.name }) : tr('Take {name} off? Its tickets stop printing there until it is set up again.', { name: p.name }))) act({ action: 'remove', id: p.id }, tr('{name} taken off.', { name: p.name })); }}>{tr('Take this printer off')}</button>
              </>
            )}
          </div>
        );
      })}

      {data.hidden > 0 && (
        <p className="ts-note">{tr('{n} found on the network but taken off (an office printer, say).', { n: data.hidden })} <button type="button" className="pos-link" disabled={busy} onClick={() => act({ action: 'unhide' }, tr('Shown again: they are back under New printers.'))}>{tr('Show them again')}</button></p>
      )}
      <p className="ts-note">{tr('A till\'s own printer — on USB, Bluetooth, or built in like the iMin Swan 2\'s — is set up on that till: More → Printer.')}</p>
    </section>
  );
}
