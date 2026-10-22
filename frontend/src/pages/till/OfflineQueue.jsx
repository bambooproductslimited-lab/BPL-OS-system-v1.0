import { money } from '../../lib/currency';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import { methodName } from './tillShared';
import { queueRemove, retry } from './tillOffline';

// What this till kept while it could not reach the server (till/tillOffline.js
// queue): each sale and order for the kitchen, oldest first — waiting to be
// sent, or refused by the server with why, to send again (after fixing what
// it says) or to drop.
export default function OfflineQueue({ items, offline, onSend, onClose }) {
  function drop(x) {
    const q = x.kind === 'sale'
      ? tr('Drop this sale? It will not be on the books: the money taken for it has to be sorted out by hand.')
      : tr('Drop this order? The kitchen screen will not get it.');
    if (window.confirm(q)) queueRemove(x.ref);
  }
  const waiting = items.filter((x) => !x.failed);
  const cash = items.filter((x) => x.kind === 'sale').reduce((a, x) => a + x.total, 0);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog tl-dialog tl-queue" role="dialog" aria-modal="true" aria-labelledby="tl-queue-title" onClick={(e) => e.stopPropagation()}>
        <div className="tl-queue-head">
          <span className={'tl-dialog-ico ' + (offline ? 'is-offline' : 'is-send')} aria-hidden="true">{offline ? '📡' : '⤴️'}</span>
          <div><h2 id="tl-queue-title">{tr('Kept on this till')}</h2>
            <p className="dk-muted">{offline ? tr('No internet. These are safe on this till and go to the server, in order, as soon as it answers.') : tr('The internet is back: these are being sent.')}</p></div>
        </div>
        {cash > 0 && <p className="tl-queue-sum">{tr('Sales not on the server yet: {amount}', { amount: money(cash) })}</p>}
        {!items.length ? <p className="dk-muted">{tr('Nothing waiting: everything is on the server.')}</p> : (
          <ul className="tl-queue-list is-plain">
            {items.map((x) => (
              <li key={x.ref} className={x.failed ? 'is-failed' : ''}>
                <span className="tl-queue-ico" aria-hidden="true">{x.kind === 'sale' ? '💵' : '🍳'}</span>
                <span className="tl-queue-text">
                  <strong>{x.kind === 'sale' ? tr('Sale · {name}', { name: x.label }) : tr('To the kitchen · {name}', { name: x.label })}</strong>
                  <small>{new Date(x.at).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' })}{x.method ? ' · ' + (x.method === 'split' ? tr('Split payment') : methodName(x.method)) : ''}</small>
                  {x.failed && <small className="tl-queue-why">⚠️ {x.error}</small>}
                </span>
                <b>{money(x.total)}</b>
                {x.failed && <span className="tl-queue-tools">
                  <button type="button" className="pos-link" onClick={() => { retry(x.ref); onSend(); }}>{tr('Send again')}</button>
                  <button type="button" className="pos-link is-danger" onClick={() => drop(x)}>{tr('Drop')}</button>
                </span>}
              </li>
            ))}
          </ul>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button>
          <button type="button" className="btn btn-primary" disabled={offline || !waiting.length} onClick={onSend}>{tr('Send now')}</button>
        </div>
      </div>
    </div>
  );
}
