import { money } from '../../lib/currency';
import { activeIntlLocale, tr } from '../../lib/i18n.jsx';
import './fifth.css';

// The guests' side of the till in the settings (TillSettings.jsx, "Bookings,
// tips and rewards"; backend restaurantTillFront clean): bookings and the
// website's booking page, tips on the pay screen and the customer's screen,
// the "your food is ready" text, loyalty points and their rewards, gift
// cards, guests' feedback from their receipt. Each starts off (but the
// feedback). Tips are shared out as the till says (tips.pool: to whoever
// served, by sale, or by hours; backend restaurantTips).

function newId() { return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'r-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
const DAYS = [0, 1, 2, 3, 4, 5, 6];
function dayName(d) { return new Date(Date.UTC(2024, 0, 7 + d)).toLocaleDateString(activeIntlLocale(), { weekday: 'short', timeZone: 'UTC' }); }

function Toggle({ on, title, note, onChange }) {
  return (
    <button type="button" role="switch" aria-checked={!!on} className="ts-toggle-row" onClick={() => onChange(!on)}>
      <span><strong>{title}</strong>{note && <small>{note}</small>}</span>
      <span className={'ts-switch' + (on ? ' is-on' : '')} aria-hidden="true"><i /></span>
    </button>
  );
}

const POOL = [['direct', '🙋', () => tr('To whoever served'), () => tr('The table\'s waiter, else the cashier, keeps the tip.')],
  ['sale', '🧾', () => tr('By sale'), () => tr('Each tip shared equally by the team clocked in when it was paid.')],
  ['hours', '⏱️', () => tr('By hours'), () => tr('Each day\'s tips shared by the hours each person worked that day.')]];
const POOL_ROLES = [['waiter', () => tr('Waiters')], ['cashier', () => tr('Cashiers')], ['kitchen', () => tr('Kitchen')], ['manager', () => tr('Managers')]];

export default function GuestSettings({ draft, set, companyName, paystackReady }) {
  const b = draft.bookings;
  const tips = draft.tips;
  const rt = draft.readyText;
  const lo = draft.loyalty;
  const gc = draft.giftCards;
  const fb = draft.feedback;
  const setB = (patch) => set(['bookings'], { ...b, ...patch });
  const setLo = (patch) => set(['loyalty'], { ...lo, ...patch });
  function setReward(i, patch) { setLo({ rewards: lo.rewards.map((r, j) => (j === i ? { ...r, ...patch } : r)) }); }
  const sample = (rt.message || '').replace(/\{name\}/g, 'Esi').replace(/\{number\}/g, 'A-042').replace(/\{restaurant\}/g, companyName || tr('the restaurant'));
  const spend = Number(lo.spend) || 10;

  return (
    <section className="ts-sec ts-bill ts-guests">
      <div className="ts-bill-block">
        <h3><span aria-hidden="true">📅</span>{tr('Bookings and the waitlist')}</h3>
        <p className="dk-muted">{tr('The till always takes bookings and walk-ins waiting for a table (Bookings and waitlist in the More menu). The website can take them too.')}</p>
        <Toggle on={b.online} title={tr('Book a table on the website')} note={tr('Customers pick a day, a time and how many; a table is not given until the till does.')} onChange={(v) => setB({ online: v })} />
        <Toggle on={b.autoConfirm} title={tr('Confirm website bookings at once')} note={b.autoConfirm ? tr('They are booked as soon as asked, while there is room.') : tr('Each one waits for someone at the till to confirm or decline it.')} onChange={(v) => setB({ autoConfirm: v })} />
        <div className="ts-guests-grid">
          <div className="field"><label htmlFor="gs-from">{tr('First booking')}</label><input id="gs-from" className="input" type="time" value={b.from} onChange={(e) => setB({ from: e.target.value })} /></div>
          <div className="field"><label htmlFor="gs-to">{tr('Last booking')}</label><input id="gs-to" className="input" type="time" value={b.to} onChange={(e) => setB({ to: e.target.value })} /></div>
          <div className="field"><label>{tr('Every')}</label>
            <div className="dk-segment" role="radiogroup" aria-label={tr('Every')}>
              {[15, 30, 60].map((m) => <button key={m} type="button" role="radio" aria-checked={b.step === m} className={b.step === m ? 'is-on' : ''} onClick={() => setB({ step: m })}>{tr('{n} min', { n: m })}</button>)}
            </div>
          </div>
          <div className="field"><label htmlFor="gs-per">{tr('Bookings a time')}</label><input id="gs-per" className="input ts-bill-num" type="number" min="1" max="50" value={b.perSlot} onChange={(e) => setB({ perSlot: e.target.value })} /></div>
          <div className="field"><label htmlFor="gs-party">{tr('Biggest party online')}</label><input id="gs-party" className="input ts-bill-num" type="number" min="1" max="100" value={b.maxParty} onChange={(e) => setB({ maxParty: e.target.value })} /></div>
          <div className="field"><label htmlFor="gs-ahead">{tr('Days ahead')}</label><input id="gs-ahead" className="input ts-bill-num" type="number" min="1" max="180" value={b.daysAhead} onChange={(e) => setB({ daysAhead: e.target.value })} /></div>
          <div className="field"><label htmlFor="gs-min">{tr('Table kept (minutes)')}</label><input id="gs-min" className="input ts-bill-num" type="number" min="15" max="600" step="15" value={b.minutes} onChange={(e) => setB({ minutes: e.target.value })} /></div>
        </div>
        <div className="field"><label>{tr('Days open for bookings')}</label>
          <div className="ts-chips">
            {DAYS.map((d) => {
              const on = !b.days.length || b.days.includes(d);
              return (
                <button key={d} type="button" className={'ts-chip' + (on ? ' is-on' : '')} aria-pressed={on}
                  onClick={() => { const cur = b.days.length ? b.days : DAYS; const next = on ? cur.filter((x) => x !== d) : cur.concat([d]).sort(); setB({ days: next.length === 7 ? [] : next }); }}>
                  {dayName(d)}
                </button>
              );
            })}
          </div>
          <small className="dk-muted">{!b.days.length ? tr('Every day.') : tr('Only on the days lit up.')}</small>
        </div>
      </div>

      <div className="ts-bill-block">
        <h3><span aria-hidden="true">💛</span>{tr('Tips')}</h3>
        <Toggle on={tips.on} title={tr('Ask for a tip when paying')} note={tr('On the pay screen and the customer\'s screen. Tips are paid on top of the bill, are not sales, and are shown in the sales report.')}
          onChange={(v) => set(['tips'], { ...tips, on: v })} />
        {tips.on && (
          <div className="ts-guests-row">
            {[0, 1, 2, 3].map((i) => (
              <label key={i} className="ts-guests-pct">
                <input className="input ts-bill-num" type="number" min="0" max="50" step="0.5" value={tips.percents[i] != null ? tips.percents[i] : ''} placeholder="—"
                  onChange={(e) => { const next = [0, 1, 2, 3].map((j) => (j === i ? e.target.value : tips.percents[j])).filter((x) => x !== '' && x != null && !Number.isNaN(Number(x))).map(Number); set(['tips', 'percents'], next); }}
                  aria-label={tr('Tip {n}', { n: i + 1 })} />
                <span>%</span>
              </label>
            ))}
            <small className="dk-muted">{tr('On a bill of {amount}: {list}', { amount: money(100), list: tips.percents.map((p) => money(p)).join(' · ') })}</small>
          </div>
        )}
        {tips.on && (
          <div className="ts-pool">
            <span className="ts-label">{tr('Shared how?')}</span>
            <div className="ts-pool-ways" role="radiogroup" aria-label={tr('Shared how?')}>
              {POOL.map(([k, art, label, note]) => (
                <button key={k} type="button" role="radio" aria-checked={tips.pool.method === k} className={tips.pool.method === k ? 'is-on' : ''}
                  onClick={() => set(['tips', 'pool'], { ...tips.pool, method: k, roles: tips.pool.roles.length ? tips.pool.roles : ['waiter', 'cashier'] })}>
                  <span aria-hidden="true">{art}</span><strong>{label()}</strong><small>{note()}</small>
                </button>
              ))}
            </div>
            {tips.pool.method !== 'direct' && (
              <div className="field"><label>{tr('Who shares them')}</label>
                <div className="ts-chips">
                  {POOL_ROLES.map(([r, label]) => {
                    const on = tips.pool.roles.includes(r);
                    return <button key={r} type="button" className={'ts-chip' + (on ? ' is-on' : '')} aria-pressed={on}
                      onClick={() => set(['tips', 'pool', 'roles'], on ? tips.pool.roles.filter((x) => x !== r) : tips.pool.roles.concat([r]))}>{label()}</button>;
                  })}
                </div>
                <small className="dk-muted">{tr('By their role on the till; their hours come from clocking in. Nobody clocked in: the tip goes to whoever served.')}</small>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="ts-bill-block">
        <h3><span aria-hidden="true">😊</span>{tr('Guests\' feedback')}</h3>
        <Toggle on={fb.on} title={tr('Ask how it was, on the receipt')} note={tr('The receipt link (WhatsApp, text or the QR code on the printed receipt) asks for a face from 1 to 5, what was good, and a comment. Unhappy ones wait for a manager to follow up.')}
          onChange={(v) => set(['feedback'], { ...fb, on: v })} />
        {fb.on && (
          <div className="field"><label htmlFor="gs-review">{tr('Your review page (optional)')}</label>
            <input id="gs-review" className="input" type="url" inputMode="url" maxLength={300} value={fb.reviewUrl} onChange={(e) => set(['feedback', 'reviewUrl'], e.target.value.trim())} placeholder="https://g.page/r/…" />
            <small className="dk-muted">{tr('Happy guests (4 or 5) are asked to leave a review there, on Google for example.')}</small>
          </div>
        )}
      </div>

      <div className="ts-bill-block">
        <h3><span aria-hidden="true">📱</span>{tr('Text when the food is ready')}</h3>
        <Toggle on={rt.on} title={tr('Text pickup customers when their order is ready')} note={tr('Sent once, when the kitchen has every dish of a pickup order ready. Without a text service, the till shows a WhatsApp button instead.')}
          onChange={(v) => set(['readyText'], { ...rt, on: v })} />
        {rt.on && (
          <div className="ts-guests-text">
            <textarea className="input" rows={3} maxLength={300} value={rt.message} onChange={(e) => set(['readyText', 'message'], e.target.value)} aria-label={tr('The text')} />
            <small className="dk-muted">{tr('{name} is the customer\'s first name, {number} the order\'s number, {restaurant} the restaurant.')}</small>
            <div className="ts-guests-bubble" aria-label={tr('What they get')}><span>💬</span><p>{sample}</p></div>
          </div>
        )}
      </div>

      <div className="ts-bill-block">
        <h3><span aria-hidden="true">⭐</span>{tr('Loyalty points')}</h3>
        <Toggle on={lo.on} title={tr('Customers earn points')} note={tr('A customer picked on the till (or matched by their phone) earns points on what they pay, and spends them on the rewards below. A refund takes them back.')}
          onChange={(v) => setLo({ on: v })} />
        {lo.on && (
          <>
            <div className="ts-guests-grid">
              <div className="field"><label htmlFor="gs-spend">{tr('One point for every (GHS)')}</label>
                <input id="gs-spend" className="input ts-bill-num" type="number" min="0.5" step="0.5" value={lo.spend} onChange={(e) => setLo({ spend: e.target.value })} /></div>
              <p className="ts-guests-eg">{tr('A bill of {amount} earns {n} points.', { amount: money(200), n: Math.floor(200 / spend) })}</p>
            </div>
            <ul className="ts-bill-rows is-plain">
              {lo.rewards.map((r, i) => (
                <li key={r.id || i}>
                  <input className="input" maxLength={40} value={r.name} onChange={(e) => setReward(i, { name: e.target.value })} placeholder={tr('e.g. GHS 20 off')} aria-label={tr('Name')} />
                  <label className="ts-guests-pts"><input className="input ts-bill-num" type="number" min="1" value={r.points} onChange={(e) => setReward(i, { points: e.target.value })} aria-label={tr('Points it takes')} /><span>⭐</span></label>
                  <div className="dk-segment" role="radiogroup" aria-label={tr('Kind of discount')}>
                    <button type="button" role="radio" aria-checked={r.kind === 'percent'} className={r.kind === 'percent' ? 'is-on' : ''} onClick={() => setReward(i, { kind: 'percent' })}>%</button>
                    <button type="button" role="radio" aria-checked={r.kind === 'amount'} className={r.kind === 'amount' ? 'is-on' : ''} onClick={() => setReward(i, { kind: 'amount' })}>GHS</button>
                  </div>
                  <input className="input ts-bill-num" type="number" min="0" step="0.01" value={r.value} onChange={(e) => setReward(i, { value: e.target.value })} aria-label={tr('How much off')} />
                  <button type="button" className="pos-line-x" onClick={() => setLo({ rewards: lo.rewards.filter((_, j) => j !== i) })} aria-label={tr('Remove')}>×</button>
                </li>
              ))}
            </ul>
            <button type="button" className="btn btn-secondary tl-btn" disabled={lo.rewards.length >= 12} onClick={() => setLo({ rewards: lo.rewards.concat([{ id: newId(), name: '', points: 100, kind: 'amount', value: 20 }]) })}>+ {tr('A reward')}</button>
          </>
        )}
      </div>

      <div className="ts-bill-block">
        <h3><span aria-hidden="true">🎁</span>{tr('Gift cards')}</h3>
        <Toggle on={gc.on} title={tr('Sell gift cards and take them as payment')} note={tr('Sold for cash or Mobile Money into the drawer (not a sale: the sale is when the card is spent). Each has a 16-digit number and a page of its own to send.')}
          onChange={(v) => set(['giftCards'], { ...gc, on: v })} />
        {gc.on && (
          <div className="ts-guests-row">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <input key={i} className="input ts-bill-num" type="number" min="1" step="1" value={gc.amounts[i] != null ? gc.amounts[i] : ''} placeholder="—" aria-label={tr('Amount {n}', { n: i + 1 })}
                onChange={(e) => { const next = [0, 1, 2, 3, 4, 5].map((j) => (j === i ? e.target.value : gc.amounts[j])).filter((x) => x !== '' && x != null && !Number.isNaN(Number(x))).map(Number); set(['giftCards', 'amounts'], next); }} />
            ))}
            <small className="dk-muted">{tr('The amounts the till offers first (any other amount can be typed).')}</small>
          </div>
        )}
        {gc.on && (
          <Toggle on={!!gc.online && !!paystackReady} disabled={!paystackReady} title={'🌐 ' + tr('Sell gift cards on the website')}
            note={paystackReady ? tr('Guests buy one on the restaurant\'s website, paid by card or Mobile Money through Paystack; the card is made when it is paid and sent to whoever it is for by text or email.') : tr('Needs Paystack set up on the server (PAYSTACK_SECRET_KEY).')}
            onChange={(v) => set(['giftCards'], { ...gc, online: v })} />
        )}
      </div>
    </section>
  );
}
