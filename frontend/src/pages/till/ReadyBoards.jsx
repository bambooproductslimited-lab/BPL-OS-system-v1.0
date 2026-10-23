import { useCallback, useEffect, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { tr } from '../../lib/i18n.jsx';
import { boardUrl } from './customerScreenLink';
import './growth.css';
import './fifth.css';

// The ready-for-pickup board from the till's side (More → Ready board;
// backend restaurantBoard; the board itself is pages/ReadyBoardPage.jsx):
// a TV facing the customers opened at /ready-board shows 6 numbers; typed
// here, it shows this restaurant's counter orders as the kitchen cooks
// them. A small copy of what it shows now.

export default function ReadyBoards({ token, onToast, onClose }) {
  const [data, setData] = useState(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const load = useCallback(() => posFetch('GET', '/pos/boards', token).then(setData).catch((e) => setError(e.message)), [token]);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  async function pair(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      setData(await posFetch('POST', '/pos/boards/pair', token, { code, name: name || tr('Ready board') }));
      setCode(''); setName('');
      onToast(tr('The board now shows this restaurant\'s orders.'));
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function unpair(b) {
    setBusy(true);
    try { setData(await posFetch('POST', '/pos/boards/' + b.id + '/unpair', token)); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <div className="dialog-backdrop" onClick={() => !busy && onClose()}>
      <div className="dialog pos-panel ko rbs" role="dialog" aria-modal="true" aria-labelledby="rbs-title" onClick={(e) => e.stopPropagation()}>
        <header className="bk-head">
          <span className="bk-ico is-board" aria-hidden="true">📺</span>
          <div><h2 id="rbs-title">{tr('Ready for pickup board')}</h2><p className="dk-muted">{tr('A TV for customers: the counter\'s orders, Preparing and Ready, by number and first name. It chimes when one is ready.')}</p></div>
        </header>
        {data && (
          <div className="rbs-mini" aria-label={tr('What the board shows now')}>
            <div><span>👩‍🍳 {tr('Preparing')}</span><ul className="is-plain">{data.preparing.slice(0, 8).map((x) => <li key={x.id}><b>{x.ref}</b>{x.name}</li>)}{!data.preparing.length && <li className="is-none">—</li>}</ul></div>
            <div className="is-ready"><span>🛎️ {tr('Ready')}</span><ul className="is-plain">{data.ready.slice(0, 8).map((x) => <li key={x.id}><b>{x.ref}</b>{x.name}</li>)}{!data.ready.length && <li className="is-none">—</li>}</ul></div>
          </div>
        )}
        <ol className="cs-steps">
          <li><b>1</b><span>{tr('On the TV or tablet, open:')} <code>{boardUrl()}</code></span></li>
          <li><b>2</b><span>{tr('It shows 6 numbers. Type them here:')}</span></li>
        </ol>
        <form className="cs-pair" onSubmit={pair}>
          <input className="input cs-code" inputMode="numeric" autoComplete="off" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" aria-label={tr('The code on the board')} />
          <input className="input" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('Its name, e.g. By the counter')} aria-label={tr('Name')} />
          <button type="submit" className="btn btn-primary" disabled={busy || code.length !== 6}>{tr('Pair the board')}</button>
        </form>
        {error && <div className="error-banner">{error}</div>}
        {data && data.boards.length > 0 && (
          <ul className="cs-list is-plain">
            {data.boards.map((b) => (
              <li key={b.id}><i className={b.online ? 'is-on' : ''} aria-hidden="true" /><span><strong>{b.name}</strong><small>{b.online ? tr('On now') : tr('Not seen for a while: is it on?')}</small></span>
                <button type="button" className="pos-link is-bad" disabled={busy} onClick={() => unpair(b)}>{tr('Take off')}</button></li>
            ))}
          </ul>
        )}
        <div className="dialog-actions"><button type="button" className="btn btn-primary" onClick={onClose}>{tr('Done')}</button></div>
      </div>
    </div>
  );
}
