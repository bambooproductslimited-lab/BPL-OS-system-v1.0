import { useCallback, useEffect, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import { saveAccount } from './onlineShared';

// A customer's own account on the ordering website (backend
// restaurantCustomerAccounts): made with a name, a phone number and a
// password, signed in to on any phone. Signed in, the checkout fills in
// their details and their orders are listed here — to follow, and to order
// again. Ordering without an account still works.

const STATUS = { pending: ['⏳', () => tr('Waiting for the restaurant')], accepted: ['👩‍🍳', () => tr('Accepted')], done: ['🎉', () => tr('Done')], rejected: ['😔', () => tr('Not taken')], cancelled: ['✕', () => tr('Cancelled')] };

export default function AccountSheet({ account, onAccount, onClose, onFollow, onReorder }) {
  const [mode, setMode] = useState(account ? 'me' : 'signin');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [mine, setMine] = useState(null);

  const loadMine = useCallback(async () => {
    if (!account) return;
    try { const d = await posFetch('GET', '/pos/online/account', account.token); setMine(d); onAccount({ token: account.token, account: d.account }); }
    catch (e) { if (e.status === 401) { saveAccount(null); onAccount(null); setMode('signin'); } else setError(e.message); }
  }, [account, onAccount]);
  useEffect(() => { if (mode === 'me') loadMine(); }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = mode === 'signup'
        ? await posFetch('POST', '/pos/online/account/signup', null, { name, phone, password })
        : await posFetch('POST', '/pos/online/account/login', null, { phone, password });
      saveAccount(r);
      onAccount(r);
      setPassword('');
      setMode('me');
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  function signOut() { saveAccount(null); onAccount(null); setMine(null); setMode('signin'); }

  const me = account && account.account;
  return (
    <div className="on-sheet-back" onClick={onClose}>
      <div className="on-sheet on-acct" role="dialog" aria-modal="true" aria-labelledby="on-acct-title" onClick={(e) => e.stopPropagation()}>
        <div className="on-co-head">
          <button type="button" className="on-x is-plain" onClick={onClose} aria-label={tr('Close')}>←</button>
          <h2 id="on-acct-title">{mode === 'me' ? tr('Your account') : mode === 'signup' ? tr('Create your account') : tr('Sign in')}</h2>
        </div>
        {mode !== 'me' ? (
          <form className="on-acct-form" onSubmit={submit}>
            <div className="on-acct-hero" aria-hidden="true"><span>👋</span></div>
            <p className="on-hint">{mode === 'signup' ? tr('Order faster next time: your details fill in by themselves, and your orders are all here, on any phone.') : tr('Welcome back. Sign in with your phone number and password.')}</p>
            <div className="on-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={mode === 'signin'} className={mode === 'signin' ? 'is-on' : ''} onClick={() => { setMode('signin'); setError(null); }}>{tr('Sign in')}</button>
              <button type="button" role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'is-on' : ''} onClick={() => { setMode('signup'); setError(null); }}>{tr('Create an account')}</button>
            </div>
            {mode === 'signup' && <label className="on-field"><span>{tr('Your name')}</span><input className="input" required maxLength={80} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></label>}
            <label className="on-field"><span>{tr('Phone number')}</span><input className="input" type="tel" inputMode="tel" required autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="024 000 0000" /></label>
            <label className="on-field"><span>{tr('Password')}</span>
              <span className="on-pw">
                <input className="input" type={show ? 'text' : 'password'} required minLength={mode === 'signup' ? 8 : 1} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} />
                <button type="button" onClick={() => setShow(!show)} aria-label={show ? tr('Hide the password') : tr('Show the password')}>{show ? '🙈' : '👁'}</button>
              </span>
              {mode === 'signup' && <small className="on-hint">{tr('At least 8 letters or numbers.')}</small>}
            </label>
            {error && <div className="error-banner" role="alert">{error}</div>}
            <button type="submit" className="on-go is-big" disabled={busy}>{busy ? tr('One moment…') : mode === 'signup' ? tr('Create my account') : tr('Sign in')}</button>
            <p className="on-hint is-center">{tr('You can always order without an account.')}</p>
          </form>
        ) : (
          <div className="on-acct-me">
            <div className="on-acct-card">
              <span className="on-acct-avatar" aria-hidden="true">{(me && me.name ? me.name.replace(/^zq\s+/i, '') : '?').charAt(0).toUpperCase()}</span>
              <div><strong>{me ? me.name : ''}</strong><small>{me ? '+' + me.phone : ''}</small>{me && me.address && <small>📍 {me.address}</small>}</div>
              <button type="button" className="on-link" onClick={signOut}>{tr('Sign out')}</button>
            </div>
            {mine && (mine.points || []).map((p) => {
              const next = p.next.find((r) => r.points > p.points);
              const ready = p.next.filter((r) => r.points <= p.points);
              return (
                <div key={p.restaurant.code} className="on-points">
                  <span className="on-points-star" aria-hidden="true">⭐</span>
                  <div className="on-points-main">
                    <small>{tr('Your points at {name}', { name: p.restaurant.name })}</small>
                    <strong>{p.points.toLocaleString(activeIntlLocale())}</strong>
                    {next && <span className="on-points-bar" aria-hidden="true"><i style={{ width: Math.min(100, (p.points / next.points) * 100) + '%' }} /></span>}
                    <p>{ready.length ? tr('Ready to use at the till: {list}', { list: ready.map((r) => r.name).join(', ') })
                      : next ? tr('{n} more points for {reward}', { n: next.points - p.points, reward: next.name }) : ''}</p>
                    <em>{tr('1 point for every {amount} you pay. Give your phone number at the till.', { amount: money(p.spend) })}</em>
                  </div>
                </div>
              );
            })}
            <h3>{tr('Your orders')}</h3>
            {!mine ? <p className="on-hint">{tr('Loading…')}</p> : !mine.orders.length ? (
              <div className="on-basket-empty"><span aria-hidden="true">🧺</span><strong>{tr('No orders yet')}</strong><p>{tr('Orders you place while signed in show here.')}</p></div>
            ) : (
              <ul className="on-acct-orders is-plain">
                {mine.orders.map((o) => {
                  const st = STATUS[o.status] || STATUS.pending;
                  const live = o.status === 'pending' || o.status === 'accepted';
                  return (
                    <li key={o.id} className={live ? 'is-live' : ''}>
                      <div className="on-acct-o-top">
                        <span className="on-acct-o-ico" aria-hidden="true">{st[0]}</span>
                        <span><strong>{o.ref} · {o.restaurant.name}</strong><small>{new Date(o.placedAt).toLocaleString(activeIntlLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · {st[1]()}</small></span>
                        <b>{money(o.total)}</b>
                      </div>
                      <p className="on-acct-o-items">{o.items.map((l) => l.qty + '× ' + l.name).join(', ')}</p>
                      <div className="on-acct-o-acts">
                        {live && <button type="button" className="on-go is-small" onClick={() => onFollow(o)}>📍 {tr('Follow it')}</button>}
                        <button type="button" className="on-go is-ghost is-small" onClick={() => onReorder(o)}>🔁 {tr('Order again')}</button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {error && <div className="error-banner" role="alert">{error}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
