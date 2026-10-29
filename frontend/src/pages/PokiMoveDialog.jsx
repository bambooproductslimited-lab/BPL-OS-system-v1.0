import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { fmtDate } from '../components/DashKit';
import { money } from '../lib/currency';
import { tr } from '../lib/i18n.jsx';
import './PokiMove.css';

// Moving a tenant to another unit before their booking runs out
// (POST /api/poki/bookings/:id/move, poki.service.js moveBooking). Pick the
// unit, the moving day and the rent there; what it does to the money comes
// from the server (…/move/quote) before anyone presses Move: the time left,
// priced in the old unit and the new, the difference to charge or give
// back, the deposit that goes with them and anything else that moves.

const METHODS = [['mobile_money', 'Mobile money'], ['cash', 'Cash'], ['bank_transfer', 'Bank transfer'], ['card', 'Card'], ['cheque', 'Cheque']];
// "8 months and 22 days", in the reader's language.
function timeLeft(l) {
  const mo = l.months ? (l.months === 1 ? tr('1 month') : tr('{n} months', { n: l.months })) : '';
  const da = l.days ? (l.days === 1 ? tr('1 day') : tr('{n} days', { n: l.days })) : '';
  return mo && da ? tr('{months} and {days}', { months: mo, days: da }) : mo || da;
}
function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

export default function PokiMoveDialog({ booking, units, onClose, onMoved }) {
  const b = booking;
  const isDraft = b.status === 'draft';
  const start = String(b.startDate).slice(0, 10), end = String(b.endDate).slice(0, 10);
  const today = iso(new Date());
  const [unitId, setUnitId] = useState('');
  const [moveDate, setMoveDate] = useState(isDraft ? start : today < start ? start : today > end ? end : today);
  const [rate, setRate] = useState('unit');
  const [custom, setCustom] = useState('');
  const [deposit, setDeposit] = useState(String(b.depositAmount || 0));
  const [settle, setSettle] = useState('');
  const [refund, setRefund] = useState({ method: 'mobile_money', reference: '' });
  const [reason, setReason] = useState('');
  const [find, setFind] = useState('');
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const choices = useMemo(() => units
    .filter((u) => u.active !== false && u.id !== b.unitId)
    .sort((x, y) => (x.status === 'vacant' ? 0 : 1) - (y.status === 'vacant' ? 0 : 1) || String(x.propertyName).localeCompare(String(y.propertyName)) || String(x.code).localeCompare(String(y.code))), [units, b.unitId]);
  const shown = choices.filter((u) => matchesQuery(find, u.code, u.name, u.propertyName, u.tenantName));
  const picked = choices.find((u) => u.id === unitId);
  const sign = quote ? (quote.difference > 0.005 ? 'up' : quote.difference < -0.005 ? 'down' : 'same') : null;
  const settleNow = settle || (sign === 'up' ? 'charge' : sign === 'down' ? 'keep' : undefined);

  function body() {
    return {
      unitId, moveDate, keepRate: rate === 'keep',
      monthlyRate: rate === 'other' && custom !== '' ? custom : undefined,
      depositAmount: deposit === '' ? undefined : deposit
    };
  }
  // The figures come from the server, so the screen and the invoice agree.
  useEffect(() => {
    if (!unitId || !moveDate || (rate === 'other' && custom === '')) { setQuote(null); setQuoteError(null); return undefined; }
    let gone = false;
    const t = setTimeout(() => {
      api.post('/poki/bookings/' + b.id + '/move/quote', body())
        .then((q) => { if (!gone) { setQuote(q); setQuoteError(null); } })
        .catch((err) => { if (!gone) { setQuote(null); setQuoteError(err.message); } });
    }, 250);
    return () => { gone = true; clearTimeout(t); };
  }, [unitId, moveDate, rate, custom, deposit]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setSettle(''); }, [sign]);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const out = await api.post('/poki/bookings/' + b.id + '/move', { ...body(), difference: settleNow, refund: settleNow === 'return' ? refund : undefined, reason });
      onMoved(out);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  const m = (n) => money(n, b.currency);
  const canMove = quote && quote.available && !saving && !(settleNow === 'return' && quote.giveBack && quote.giveBack.refund > 0 && !refund.method);

  return (
    <div className="dialog-backdrop" onClick={() => !saving && onClose()}>
      <form className="dialog tl-dialog pmv" onClick={(e) => e.stopPropagation()} onSubmit={submit} aria-labelledby="pmv-title">
        <header className="pmv-head">
          <span className="pmv-badge" aria-hidden="true">🏠</span>
          <div>
            <p className="eyebrow">{b.bookingNo} · {b.propertyName}</p>
            <h2 id="pmv-title">{tr('Move {tenant} to another unit', { tenant: b.tenantName })}</h2>
            <p className="dk-muted tl-small">{isDraft
              ? tr('They haven\'t moved in yet, so the whole booking moves: {from} – {to}.', { from: fmtDate(start), to: fmtDate(end) })
              : tr('The booking on {unit} ends on the moving day; a new one carries on in the new unit until {date}. Their rent stays on their booking\'s invoice, so only the difference is settled.', { unit: b.unitCode, date: fmtDate(end) })}</p>
          </div>
          <button type="button" className="tl-close" onClick={onClose} aria-label={tr('Close')}>×</button>
        </header>

        <section className="pmv-step">
          <h3 className="pmv-step-title"><span>1</span>{tr('Which unit?')}</h3>
          {choices.length > 6 && <SearchInput value={find} onChange={setFind} placeholder={tr('Search units…')} />}
          <div className="pmv-units" role="radiogroup" aria-label={tr('Which unit?')}>
            {shown.map((u) => (
              <button key={u.id} type="button" role="radio" aria-checked={unitId === u.id} className={'pmv-unit' + (unitId === u.id ? ' is-on' : '') + (u.status === 'vacant' ? ' is-free' : ' is-let')} onClick={() => setUnitId(u.id)}>
                <span className="pmv-unit-code">{u.code}</span>
                <span className="pmv-unit-main">
                  <strong>{u.name || u.code}</strong>
                  <small>{u.propertyName}</small>
                  <small className="pmv-unit-rent">{tr('{amount} a month', { amount: money(u.baseRent, u.currency) })}</small>
                </span>
                <span className="pmv-unit-state">{u.status === 'vacant' ? tr('Free now') : u.bookingEnd ? tr('Let until {date}', { date: fmtDate(u.bookingEnd) }) : tr('Let')}</span>
              </button>
            ))}
            {!shown.length && <p className="dk-muted tl-small">{choices.length ? tr('No unit matches.') : tr('There is no other unit to move to. Add one on Properties & units.')}</p>}
          </div>
        </section>

        <section className="pmv-step pmv-grid">
          <h3 className="pmv-step-title"><span>2</span>{tr('When, and for what rent?')}</h3>
          <div className="field">
            <label htmlFor="pmv-day">{tr('Moving day')}</label>
            <input id="pmv-day" className="input" type="date" value={moveDate} min={start} max={end} disabled={isDraft} onChange={(e) => setMoveDate(e.target.value)} required />
            <span className="dk-muted tl-small">{tr('Their first day in the new unit.')}</span>
          </div>
          <div className="field">
            <span className="tl-label">{tr('Rent in the new unit')}</span>
            <div className="tl-seg" role="radiogroup" aria-label={tr('Rent in the new unit')}>
              {[['unit', picked ? tr('{unit}\'s rent', { unit: picked.code }) : tr('The unit\'s rent')], ['keep', tr('Keep their rent')], ['other', tr('Another amount')]].map(([k, label]) => (
                <button key={k} type="button" role="radio" aria-checked={rate === k} className={'tl-seg-btn' + (rate === k ? ' is-on' : '')} onClick={() => setRate(k)}>{label}</button>
              ))}
            </div>
            {rate === 'other' && <input className="input" type="number" min="0" step="0.01" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder={tr('Rent per month ({currency})', { currency: b.currency })} aria-label={tr('Rent per month')} />}
            {rate === 'keep' && <span className="dk-muted tl-small">{tr('{amount} a month, as now.', { amount: m(b.monthlyRate) })}</span>}
          </div>
          <div className="field">
            <label htmlFor="pmv-dep">{tr('Deposit for the new unit')}</label>
            <input id="pmv-dep" className="input" type="number" min="0" step="0.01" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
            <span className="dk-muted tl-small">{tr('What they hold goes with them; only a rise is charged.')}</span>
          </div>
        </section>

        {quoteError && <div className="error-banner" role="alert">{quoteError}</div>}
        {quote && (
          <section className="pmv-step pmv-money" aria-live="polite">
            <h3 className="pmv-step-title"><span>3</span>{tr('What it does to the money')}</h3>
            {!quote.available && quote.clashesWith && (
              <div className="pmv-warn is-bad">⛔ {tr('{unit} is booked {from} – {to} under {bookingNo}, so they can\'t move in on {date}. Choose another unit or day.', { unit: quote.to.unitCode, from: fmtDate(quote.clashesWith.startDate), to: fmtDate(quote.clashesWith.endDate), bookingNo: quote.clashesWith.bookingNo, date: fmtDate(quote.moveDate) })}</div>
            )}
            <div className="pmv-compare">
              <div className="pmv-side">
                <span className="pmv-side-code">{quote.from.unitCode}</span>
                <span className="dk-muted tl-small">{tr('{left} left at {rate} a month', { left: timeLeft(quote.left), rate: m(quote.from.monthlyRate) })}</span>
                <strong>{m(quote.from.forTheRest)}</strong>
                <small className="dk-muted">{tr('already charged')}</small>
              </div>
              <span className="pmv-arrow" aria-hidden="true">→</span>
              <div className="pmv-side is-to">
                <span className="pmv-side-code">{quote.to.unitCode}</span>
                <span className="dk-muted tl-small">{tr('{left} at {rate} a month', { left: timeLeft(quote.left), rate: m(quote.to.monthlyRate) })}</span>
                <strong>{m(quote.to.forTheRest)}</strong>
                <small className="dk-muted">{tr('from {date} to {end}', { date: fmtDate(quote.moveDate), end: fmtDate(quote.endDate) })}</small>
              </div>
              <div className={'pmv-diff is-' + sign}>
                <span>{sign === 'up' ? tr('The new unit costs more') : sign === 'down' ? tr('The new unit costs less') : tr('Same rent')}</span>
                <strong>{sign === 'same' ? '=' : (sign === 'up' ? '+ ' : '− ') + m(Math.abs(quote.difference))}</strong>
              </div>
            </div>

            {sign === 'up' && (
              <div className="tl-seg pmv-settle" role="radiogroup" aria-label={tr('The difference')}>
                {[['charge', tr('Charge it: an invoice for {amount}', { amount: m(quote.difference) })], ['waive', tr('Let it go')]].map(([k, label]) => (
                  <button key={k} type="button" role="radio" aria-checked={settleNow === k} className={'tl-seg-btn' + (settleNow === k ? ' is-on' : '')} onClick={() => setSettle(k)}>{label}</button>
                ))}
              </div>
            )}
            {sign === 'down' && (
              <>
                <div className="tl-seg pmv-settle" role="radiogroup" aria-label={tr('The difference')}>
                  {[['keep', tr('Keep it')], ['return', tr('Give it back')]].map(([k, label]) => (
                    <button key={k} type="button" role="radio" aria-checked={settleNow === k} className={'tl-seg-btn' + (settleNow === k ? ' is-on' : '')} onClick={() => setSettle(k)}>{label}</button>
                  ))}
                </div>
                {settleNow === 'return' && quote.giveBack && (
                  <div className="poki-term-refund">
                    <p className="poki-refund-why">{quote.giveBack.refund > 0
                      ? tr('A credit note of {credit} on {invoiceNo}; they have paid, so {refund} is paid back to them.', { credit: m(quote.giveBack.credit), invoiceNo: quote.giveBack.invoiceNo, refund: m(quote.giveBack.refund) })
                      : tr('A credit note of {credit} on {invoiceNo}: they owe that much less.', { credit: m(quote.giveBack.credit), invoiceNo: quote.giveBack.invoiceNo || '—' })}</p>
                    {quote.giveBack.refund > 0 && (
                      <div className="poki-refund-fields">
                        <label className="field">
                          <span>{tr('Paid back by')}</span>
                          <select className="input" value={refund.method} onChange={(e) => setRefund({ ...refund, method: e.target.value })}>
                            {METHODS.map(([k, l]) => <option key={k} value={k}>{tr(l)}</option>)}
                          </select>
                        </label>
                        <label className="field">
                          <span>{tr('Reference (optional)')}</span>
                          <input className="input" value={refund.reference} onChange={(e) => setRefund({ ...refund, reference: e.target.value })} placeholder={tr('e.g. the MoMo transaction ID')} />
                        </label>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            <ul className="pmv-notes">
              <li><span aria-hidden="true">🔐</span>{quote.deposit.held > 0
                ? (quote.deposit.owing > 0
                  ? tr('The {held} deposit they hold goes with them; {owing} more is charged for the new unit.', { held: m(quote.deposit.held), owing: m(quote.deposit.owing) })
                  : tr('The {held} deposit they hold goes with them.', { held: m(quote.deposit.held) }))
                : quote.deposit.owing > 0 ? tr('A deposit of {owing} is charged for the new unit.', { owing: m(quote.deposit.owing) }) : tr('No deposit is held on this booking.')}</li>
              {quote.charges > 0 && <li><span aria-hidden="true">🔁</span>{quote.charges === 1 ? tr('1 running charge (CAM or another) moves to the new booking.') : tr('{n} running charges (CAM and others) move to the new booking.', { n: quote.charges })}</li>}
              {quote.unbilledReadings > 0 && <li className="is-warn"><span aria-hidden="true">💧</span>{quote.unbilledReadings === 1
                ? tr('1 meter reading on {unit} is not billed yet: bill it before the move, while {unit} is still theirs.', { unit: quote.from.unitCode })
                : tr('{n} meter readings on {unit} are not billed yet: bill them before the move, while {unit} is still theirs.', { n: quote.unbilledReadings, unit: quote.from.unitCode })}</li>}
              <li><span aria-hidden="true">📝</span>{tr('Draw up a new tenancy agreement for {unit} after the move.', { unit: quote.to.unitCode })}</li>
            </ul>
          </section>
        )}

        <div className="field">
          <label htmlFor="pmv-why">{tr('Why they are moving (optional)')}</label>
          <input id="pmv-why" className="input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder={tr('e.g. wanted a bigger room, a leak in the old one')} />
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" disabled={saving} onClick={onClose}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={!canMove}>{saving ? tr('Moving…') : picked ? tr('Move to {unit}', { unit: picked.code }) : tr('Move')}</button>
        </div>
      </form>
    </div>
  );
}
