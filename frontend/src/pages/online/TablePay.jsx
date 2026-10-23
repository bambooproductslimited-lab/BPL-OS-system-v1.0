import { useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { tr } from '../../lib/i18n.jsx';

// Paying at the table (the table's QR code, or the QR code on the printed
// bill; backend restaurantTablePay): all that is left, a share of the bill
// split between the table, or an amount; a tip; by card or Mobile Money on
// Paystack's page, then back to the table's page, which says it is paid.

function round2(n) { return Math.round(Number(n) * 100) / 100; }
const MAX_PEOPLE = 12;

export function TablePaySheet({ code, info, onClose }) {
  const [mode, setMode] = useState('all');
  const [people, setPeople] = useState(2);
  const [custom, setCustom] = useState('');
  const [tipPick, setTipPick] = useState(null); // null: none, a %, or 'own'
  const [ownTip, setOwnTip] = useState('');
  const [name, setName] = useState(() => { try { return localStorage.getItem('bamboo.table.name') || ''; } catch { return ''; } });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const left = info.left;
  const share = mode === 'all' ? left : mode === 'split' ? Math.min(left, round2(info.total / people)) : Math.min(left, round2(custom || 0));
  const tip = tipPick === 'own' ? Math.max(0, round2(ownTip || 0)) : tipPick ? round2(share * tipPick / 100) : 0;
  const total = round2(share + tip);
  const done = info.total > 0 ? Math.min(1, info.paid / info.total) : 0;

  async function pay(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      try { localStorage.setItem('bamboo.table.name', name.trim()); } catch { /* not kept */ }
      const r = await posFetch('POST', '/pos/table/' + encodeURIComponent(code) + '/pay', null, { amount: share, tip, name: name.trim(), back: window.location.origin + window.location.pathname });
      window.location.assign(r.url);
    } catch (err) { setError(err.message); setBusy(false); }
  }

  return (
    <div className="on-sheet-back is-checkout" onClick={() => !busy && onClose()}>
      <form className="on-sheet on-checkout tp-sheet" role="dialog" aria-modal="true" aria-labelledby="tp-title" onClick={(e) => e.stopPropagation()} onSubmit={pay}>
        <div className="on-co-head">
          <button type="button" className="on-x is-plain" onClick={onClose} aria-label={tr('Back')}>←</button>
          <h2 id="tp-title">{tr('Pay the bill')}</h2>
          <span className="tp-table">🪑 {info.table.name}</span>
        </div>

        <div className="tp-hero" style={{ '--done': done }}>
          <span className="tp-ring" aria-hidden="true"><i /><b>{Math.round(done * 100)}%</b></span>
          <div>
            <small>{info.paid > 0 ? tr('Left to pay') : tr('The bill')}</small>
            <strong>{money(left)}</strong>
            {info.paid > 0 && <small>{tr('{paid} of {total} paid already', { paid: money(info.paid), total: money(info.total) })}</small>}
          </div>
        </div>
        {info.payments.length > 0 && (
          <ul className="tp-paid">
            {info.payments.map((p, i) => <li key={i}><span aria-hidden="true">✓</span>{p.payer ? tr('{name} paid {amount}', { name: p.payer, amount: money(p.amount) }) : tr('Someone paid {amount}', { amount: money(p.amount) })}</li>)}
          </ul>
        )}

        <fieldset className="on-fs">
          <legend>{tr('How much are you paying?')}</legend>
          <div className="tp-modes" role="radiogroup" aria-label={tr('How much are you paying?')}>
            {[['all', '🧾', tr('All of it'), money(left)], ['split', '👥', tr('Split it'), tr('equal shares')], ['amount', '✏️', tr('An amount'), tr('you choose')]].map(([k, art, label, sub]) => (
              <button key={k} type="button" role="radio" aria-checked={mode === k} className={mode === k ? 'is-on' : ''} onClick={() => setMode(k)}>
                <span aria-hidden="true">{art}</span><strong>{label}</strong><small>{sub}</small>
              </button>
            ))}
          </div>
          {mode === 'split' && (
            <div className="tp-split">
              <div className="tp-people" aria-hidden="true">{Array.from({ length: people }, (_, i) => <i key={i} className={i === 0 ? 'is-me' : ''}>{i === 0 ? '🙂' : ''}</i>)}</div>
              <div className="tp-stepper">
                <button type="button" onClick={() => setPeople((n) => Math.max(2, n - 1))} aria-label={tr('One person fewer')}>−</button>
                <span><b>{people}</b> {tr('people')}</span>
                <button type="button" onClick={() => setPeople((n) => Math.min(MAX_PEOPLE, n + 1))} aria-label={tr('One person more')}>+</button>
              </div>
              <p>{tr('Each pays {amount}', { amount: money(round2(info.total / people)) })}{share < round2(info.total / people) ? ' · ' + tr('you pay what is left') : ''}</p>
            </div>
          )}
          {mode === 'amount' && (
            <label className="on-field"><span>{tr('Amount (GHS)')}</span>
              <input className="input tp-amount" inputMode="decimal" value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^\d.]/g, ''))} placeholder={money(left)} autoFocus />
            </label>
          )}
        </fieldset>

        {info.tips.length > 0 && (
          <fieldset className="on-fs">
            <legend>{tr('Add a tip for the team?')}</legend>
            <div className="tp-tips">
              <button type="button" className={tipPick === null ? 'is-on' : ''} onClick={() => setTipPick(null)}><strong>{tr('No tip')}</strong></button>
              {info.tips.map((p) => (
                <button key={p} type="button" className={tipPick === p ? 'is-on' : ''} onClick={() => setTipPick(p)}><strong>{p}%</strong><small>{money(round2(share * p / 100))}</small></button>
              ))}
              <button type="button" className={tipPick === 'own' ? 'is-on' : ''} onClick={() => setTipPick('own')}><strong>{tr('Other')}</strong></button>
            </div>
            {tipPick === 'own' && <label className="on-field"><span>{tr('Tip (GHS)')}</span><input className="input" inputMode="decimal" value={ownTip} onChange={(e) => setOwnTip(e.target.value.replace(/[^\d.]/g, ''))} autoFocus /></label>}
          </fieldset>
        )}

        <label className="on-field"><span>{tr('Your name (optional), so the waiter knows who paid')}</span>
          <input className="input" value={name} maxLength={60} autoComplete="given-name" onChange={(e) => setName(e.target.value)} />
        </label>

        <div className="on-total">
          <div><span>{tr('Your part of the bill')}</span><b>{money(share)}</b></div>
          {tip > 0 && <div><span>💛 {tr('Tip')}</span><b>{money(tip)}</b></div>}
          <div className="is-total"><span>{tr('You pay')}</span><strong>{money(total)}</strong></div>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <button type="submit" className="on-go is-big tp-go" disabled={busy || !(share >= Math.min(1, left))}>{busy ? tr('Opening Paystack…') : '💳 ' + tr('Pay {amount}', { amount: money(total) })}</button>
        <p className="on-hint is-center tp-safe"><span aria-hidden="true">🔒</span>{tr('Card or Mobile Money, on Paystack\'s secure page. The waiter sees it is paid.')}</p>
      </form>
    </div>
  );
}

// Back from Paystack: checking, paid (and what is left), or not paid.
export function TablePaidBanner({ state, left, onAgain, onClose }) {
  if (!state) return null;
  const ok = state.status === 'success';
  const wait = state.status === 'checking' || state.status === 'pending';
  return (
    <div className={'tp-done is-' + (ok ? 'ok' : wait ? 'wait' : 'bad')} role="status">
      {ok && <span className="tp-confetti" aria-hidden="true">{Array.from({ length: 14 }, (_, i) => <i key={i} style={{ '--i': i }} />)}</span>}
      <span className="tp-done-art" aria-hidden="true">{ok ? '🎉' : wait ? '⏳' : '😕'}</span>
      <div>
        <strong>{ok ? tr('Paid, thank you!') : wait ? (state.status === 'checking' ? tr('Checking your payment…') : tr('Still waiting for Paystack')) : tr('The payment did not go through')}</strong>
        <small>
          {ok ? [money(state.amount) + (state.tip > 0 ? ' + ' + tr('a tip of {amount}', { amount: money(state.tip) }) : ''), left > 0 ? tr('{amount} left on the table', { amount: money(left) }) : tr('The bill is settled')].join(' · ')
            : wait ? tr('It shows on the bill as soon as Paystack confirms it.') : tr('Nothing was taken. You can try again, or pay the waiter.')}
        </small>
      </div>
      {!ok && !wait && <button type="button" className="tp-again" onClick={onAgain}>{tr('Try again')}</button>}
      {!wait && <button type="button" className="tp-close" onClick={onClose} aria-label={tr('Close')}>✕</button>}
    </div>
  );
}
