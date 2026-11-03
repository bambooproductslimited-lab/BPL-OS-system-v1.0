import { useCallback, useEffect, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import { printerState } from './printerState';
import './printers.css';

// The restaurant's network printers from the till, as on Square: which are
// printing, which are off or out of paper, and the last tickets each was
// given — one that did not print is printed again (or let go) from here.
// Opened from the printer pill on the till's top bar (RestaurantPosPage).
const KIND = { kitchen: () => tr('Kitchen ticket'), stub: () => tr('Order summary'), void: () => tr('Void ticket'), receipt: () => tr('Receipt'), bill: () => tr('Bill'), report: () => tr('Report'), test: () => tr('Test print') };
const STATUS = { queued: () => tr('Waiting'), printing: () => tr('Printing'), printed: () => tr('Printed'), failed: () => tr('Not printed'), cancelled: () => tr('Let go') };

export default function PrinterStatus({ token, onClose, onFail, onSettings }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(null);
  const load = useCallback(async () => { try { setData(await posFetch('GET', '/pos/printers', token)); } catch (e) { onFail(e); } }, [token, onFail]);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  async function act(job, what) {
    setBusy(job.id);
    try { await posFetch('POST', '/pos/print-jobs/' + job.id + '/' + what, token, {}); await load(); } catch (e) { onFail(e); } finally { setBusy(null); }
  }
  const time = (iso) => new Date(iso).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog tl-dialog tpr-sheet" role="dialog" aria-modal="true" aria-labelledby="tpr-sheet-title" onClick={(e) => e.stopPropagation()}>
        <span className="tl-dialog-ico" aria-hidden="true">🖨️</span>
        <h2 id="tpr-sheet-title">{tr('Printers')}</h2>
        {!data ? <p className="dk-muted">{tr('Loading…')}</p> : (
          <>
            {data.printers.map((p) => {
              const st = printerState(p);
              return (
                <div key={p.id} className={'tpr-card is-' + st.tone}>
                  <div className="tpr-head">
                    <span className="tpr-ico" aria-hidden="true">🖨️<i className={'tpr-dot is-' + st.tone} /></span>
                    <span className="tpr-main">
                      <strong>{p.name}</strong>
                      <small><b className={'tpr-state is-' + st.tone}>{st.text}</b>{p.waiting ? ' · ' + tr('{n} waiting to print', { n: p.waiting }) : ''}</small>
                    </span>
                  </div>
                  {st.tone !== 'ok' && st.tone !== 'warn' && (
                    <p className="tpr-hint">{p.problem === 'offline' ? tr('Check it is switched on and its network cable is in. Its tickets wait and print as soon as it is back.')
                      : p.problem === 'paper' ? tr('Put in a new roll: what is waiting prints by itself.') : p.problem === 'cover' ? tr('Close the printer\'s cover: what is waiting prints by itself.') : tr('Switch it off and on again. What is waiting prints when it is back.')}</p>
                  )}
                </div>
              );
            })}
            <h4 className="ts-scr-h">{tr('Last tickets')}</h4>
            {!data.jobs.length ? <p className="dk-muted">{tr('Nothing printed in the last 12 hours.')}</p> : (
              <ul className="tpr-jobs">
                {data.jobs.map((j) => (
                  <li key={j.id}>
                    <span><strong>{j.title}</strong><small>{KIND[j.kind] ? KIND[j.kind]() : j.kind} · {j.printerName} · {time(j.at)}{j.error ? ' · ' + j.error : ''}</small></span>
                    <b className={'tpr-job-st is-' + j.status}>{STATUS[j.status] ? STATUS[j.status]() : j.status}</b>
                    {j.status !== 'cancelled' && <button type="button" className="btn btn-secondary tl-btn" disabled={busy === j.id} onClick={() => act(j, 'again')}>{tr('Print again')}</button>}
                    {(j.status === 'failed' || j.status === 'queued') && <button type="button" className="pos-link" disabled={busy === j.id} onClick={() => act(j, 'cancel')}>{tr('Let go')}</button>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <div className="dialog-actions">
          {onSettings && <button type="button" className="btn btn-secondary" onClick={onSettings}>{tr('Set up printers')}</button>}
          <button type="button" className="btn btn-primary" onClick={onClose}>{tr('Done')}</button>
        </div>
      </div>
    </div>
  );
}
