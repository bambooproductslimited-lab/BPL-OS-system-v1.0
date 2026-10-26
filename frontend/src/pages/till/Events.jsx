import { useCallback, useEffect, useMemo, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { activeIntlLocale, msg, tr } from '../../lib/i18n.jsx';
import './fourteenth.css';

// Private events and room hire (backend restaurantEvents, migration 0195).
// On the till (More → Events): this week's booked events, today's with its
// plan hour by hour — what is now — and its menu in portions. In the back
// office: the guests' requests, the events coming up (planned, sent, booked)
// and an event written out: who, when, where, the menu a head, extras, the
// deposit and the plan; sent to the guest, the deposit taken; the website's
// "Hire our space" settings.

const STATUS = { enquiry: ['📨', msg('Asked for')], quoted: ['📤', msg('Sent to the guest')], confirmed: ['✅', msg('Booked')], done: ['🎉', msg('Done')], cancelled: ['✕', msg('Cancelled')] };
const WHO = { all: ['👥', msg('Everyone')], kitchen: ['🍳', msg('Kitchen')], floor: ['🍽️', msg('Floor')], bar: ['🍹', msg('Bar')] };
const DEPOSIT = { none: msg('No deposit'), due: msg('Deposit due'), paid: msg('Deposit paid'), refunded: msg('Deposit given back') };
function dayText(iso) { return new Date(iso).toLocaleDateString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); }
function weekday(iso) { return new Date(iso).toLocaleDateString(activeIntlLocale(), { weekday: 'short', timeZone: 'UTC' }); }
function hhmm(iso) { return new Date(iso).toISOString().slice(11, 16); }
function round2(n) { return Math.round(Number(n) * 100) / 100; }
function portions(per, guests) { return Math.ceil(Number(per) * guests - 1e-9); }

// The plan of the day, what is now marked.
function Plan({ plan, today }) {
  const now = new Date().toISOString().slice(11, 16);
  const at = today ? plan.reduce((a, p, i) => (p.time <= now ? i : a), -1) : -1;
  return (
    <ol className="evt-plan">
      {plan.map((p, i) => (
        <li key={i} className={(i === at ? 'is-now' : i < at ? 'is-past' : '') + ' is-' + p.who}>
          <b>{p.time}</b><span aria-hidden="true">{WHO[p.who][0]}</span><span>{p.text}<small>{tr(WHO[p.who][1])}</small></span>
        </li>
      ))}
    </ol>
  );
}

// More → Events.
export function EventsDialog({ token, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  useEffect(() => { posFetch('GET', '/pos/events', token).then((d) => { setData(d); const t = d.events.find((e) => e.today) || d.events[0]; if (t) setOpen(t.id); }).catch((e) => setError(e.message)); }, [token]);
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog evt-dlg" role="dialog" aria-modal="true" aria-labelledby="evt-title" onClick={(e) => e.stopPropagation()}>
        <div className="cof-head">
          <span className="cof-head-art is-event" aria-hidden="true">🥂</span>
          <div><h2 id="evt-title">{tr('Events')}</h2><p>{!data ? tr('Loading…') : data.today ? (data.today === 1 ? tr('1 event today') : tr('{n} events today', { n: data.today })) : data.events.length ? tr('Booked this week') : tr('No events booked this week.')}</p></div>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {data && data.events.map((e, i) => {
          const isOpen = open === e.id;
          return (
            <section key={e.id} className={'evt-card' + (e.today ? ' is-today' : '')} style={{ '--i': i }}>
              <button type="button" className="evt-card-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : e.id)}>
                <span className="evt-date"><b>{new Date(e.startsAt).getUTCDate()}</b><small>{weekday(e.startsAt)}</small></span>
                <span className="evt-card-main">
                  <strong>{e.occasion || tr('Event')} · {e.name}</strong>
                  <small>🕒 {hhmm(e.startsAt)}–{hhmm(e.endsAt)} · 👥 {tr('{n} guests', { n: e.guests })}{e.space ? ' · 📍 ' + e.space : ''}</small>
                </span>
                {e.today && <em className="evt-today">{tr('Today')}</em>}
              </button>
              {isOpen && (
                <div className="evt-card-body">
                  {e.plan.length > 0 && <Plan plan={e.plan} today={e.today} />}
                  {e.menu.length > 0 && (
                    <ul className="evt-menu">{e.menu.map((m) => <li key={m.menuItemId}><b>{portions(m.perGuest, e.guests)}×</b> {m.name}<small>{tr('{n} a guest', { n: m.perGuest })}</small></li>)}</ul>
                  )}
                  {(e.note || e.staffNote) && <p className="evt-notes">{e.note ? '💬 ' + e.note : ''}{e.note && e.staffNote ? ' · ' : ''}{e.staffNote ? '📝 ' + e.staffNote : ''}</p>}
                  <p className="evt-dep">{STATUS[e.status][0]} {tr(STATUS[e.status][1])} · {tr(DEPOSIT[e.deposit.status])}{e.deposit.amount > 0 ? ' ' + money(e.deposit.amount) : ''}</p>
                </div>
              )}
            </section>
          );
        })}
        <div className="dialog-actions"><button type="button" className="btn btn-primary" onClick={onClose}>{tr('Close')}</button></div>
      </div>
    </div>
  );
}

function blankEvent() {
  const d = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  return { name: '', phone: '', email: '', occasion: '', space: '', day: d, from: '18:00', to: '22:00', guests: 30, menu: [], perHead: '', extras: [], deposit: '', plan: [], note: '', staffNote: '' };
}
function draftOf(e) {
  return { id: e.id, name: e.name, phone: e.phone, email: e.email, occasion: e.occasion, space: e.space, day: e.startsAt.slice(0, 10), from: hhmm(e.startsAt), to: hhmm(e.endsAt), guests: e.guests,
    menu: e.menu.map((m) => ({ menuItemId: m.menuItemId, perGuest: m.perGuest })), perHead: e.perHead || '', extras: e.extras.map((x) => ({ ...x })), deposit: e.deposit.amount || '', depositLocked: e.deposit.status === 'paid',
    plan: e.plan.map((p) => ({ ...p })), note: e.note, staffNote: e.staffNote };
}

function Editor({ draft, setDraft, menu, settings, busy, onSave, onClose }) {
  const set = (patch) => setDraft({ ...draft, ...patch });
  const guests = Math.max(0, Math.round(Number(draft.guests) || 0));
  const extras = draft.extras.reduce((a, x) => a + (Number(x.amount) || 0), 0);
  const total = round2((Number(draft.perHead) || 0) * guests + extras);
  const byId = useMemo(() => new Map(menu.map((m) => [m.id, m])), [menu]);
  const cats = useMemo(() => Array.from(new Set(menu.map((m) => m.category))), [menu]);
  const food = draft.menu.reduce((a, l) => a + (byId.get(l.menuItemId) ? byId.get(l.menuItemId).price * portions(l.perGuest, guests) : 0), 0);
  return (
    <form className="ts-sec evt-edit" onSubmit={(e) => { e.preventDefault(); onSave(); }}>
      <div className="evt-edit-head"><h3>{draft.id ? tr('The event') : tr('New event')}</h3><button type="button" className="pos-link" onClick={onClose}>{tr('Back to the events')}</button></div>
      <fieldset className="evt-fs"><legend>👤 {tr('Who')}</legend>
        <div className="evt-grid">
          <label><span>{tr('Name')}</span><input className="input" required maxLength={80} value={draft.name} onChange={(e) => set({ name: e.target.value })} /></label>
          <label><span>{tr('Phone')}</span><input className="input" type="tel" maxLength={30} value={draft.phone} onChange={(e) => set({ phone: e.target.value })} /></label>
          <label><span>{tr('Email')}</span><input className="input" type="email" maxLength={120} value={draft.email} onChange={(e) => set({ email: e.target.value })} /></label>
        </div>
      </fieldset>
      <fieldset className="evt-fs"><legend>🗓️ {tr('When and where')}</legend>
        <div className="evt-grid">
          <label><span>{tr('Occasion')}</span><input className="input" maxLength={60} value={draft.occasion} onChange={(e) => set({ occasion: e.target.value })} placeholder={tr('e.g. Wedding reception')} /></label>
          <label><span>{tr('Space')}</span><select className="input" value={draft.space} onChange={(e) => set({ space: e.target.value })}><option value="">—</option>{settings.spaces.map((s) => <option key={s.name} value={s.name}>{s.name}{s.seats ? ' (' + s.seats + ')' : ''}</option>)}</select></label>
          <label><span>{tr('Guests')}</span><input className="input" type="number" min="1" max="2000" value={draft.guests} onChange={(e) => set({ guests: e.target.value })} /></label>
          <label><span>{tr('Day')}</span><input className="input" type="date" required value={draft.day} onChange={(e) => set({ day: e.target.value })} /></label>
          <label><span>{tr('From')}</span><input className="input" type="time" required value={draft.from} onChange={(e) => set({ from: e.target.value })} /></label>
          <label><span>{tr('To')}</span><input className="input" type="time" required value={draft.to} onChange={(e) => set({ to: e.target.value })} /></label>
        </div>
      </fieldset>
      <fieldset className="evt-fs"><legend>🍽️ {tr('The menu')}</legend>
        <ul className="evt-menu-edit">
          {draft.menu.map((l, i) => { const m = byId.get(l.menuItemId); return (
            <li key={l.menuItemId}>
              <span><strong>{m ? m.name : '?'}</strong><small>{m ? m.category + ' · ' + money(m.price) : ''}</small></span>
              <label><input className="input" type="number" min="0.1" max="10" step="0.1" value={l.perGuest} onChange={(e) => set({ menu: draft.menu.map((x, k) => (k === i ? { ...x, perGuest: e.target.value } : x)) })} aria-label={tr('Portions a guest')} /><small>{tr('a guest')}</small></label>
              <b>{portions(l.perGuest || 0, guests)}×</b>
              <button type="button" className="pos-link is-bad" onClick={() => set({ menu: draft.menu.filter((x, k) => k !== i) })} aria-label={tr('Take it off')}>✕</button>
            </li>
          ); })}
        </ul>
        <select className="input" value="" onChange={(e) => { if (e.target.value) set({ menu: draft.menu.concat([{ menuItemId: e.target.value, perGuest: 1 }]) }); }}>
          <option value="">＋ {tr('Add a dish')}</option>
          {cats.map((c) => <optgroup key={c} label={c || tr('Other')}>{menu.filter((m) => m.category === c && !draft.menu.some((l) => l.menuItemId === m.id)).map((m) => <option key={m.id} value={m.id}>{m.name} · {money(m.price)}</option>)}</optgroup>)}
        </select>
        {draft.menu.length > 0 && <p className="dk-muted">{tr('At menu prices, the food comes to {amount} ({each} a guest).', { amount: money(food), each: money(guests ? food / guests : 0) })}</p>}
      </fieldset>
      <fieldset className="evt-fs"><legend>💰 {tr('The price')}</legend>
        <div className="evt-grid">
          <label><span>{tr('A head')}</span><input className="input" type="number" min="0" step="any" value={draft.perHead} onChange={(e) => set({ perHead: e.target.value })} /></label>
          <label><span>{tr('Deposit')}</span><input className="input" type="number" min="0" step="any" value={draft.deposit} disabled={draft.depositLocked} onChange={(e) => set({ deposit: e.target.value })} /></label>
          {!draft.depositLocked && settings.depositPercent > 0 && total > 0 && <button type="button" className="pos-link evt-pct" onClick={() => set({ deposit: String(Math.round(total * settings.depositPercent / 100)) })}>{tr('{n}% of it', { n: settings.depositPercent })}</button>}
        </div>
        {draft.extras.map((x, i) => (
          <div key={i} className="evt-extra">
            <input className="input" maxLength={80} value={x.text} onChange={(e) => set({ extras: draft.extras.map((y, k) => (k === i ? { ...y, text: e.target.value } : y)) })} placeholder={tr('e.g. Garden hire, decorations')} aria-label={tr('Extra')} />
            <input className="input" type="number" min="0" step="any" value={x.amount} onChange={(e) => set({ extras: draft.extras.map((y, k) => (k === i ? { ...y, amount: e.target.value } : y)) })} aria-label={tr('Amount')} />
            <button type="button" className="pos-link is-bad" onClick={() => set({ extras: draft.extras.filter((y, k) => k !== i) })} aria-label={tr('Take it off')}>✕</button>
          </div>
        ))}
        <button type="button" className="pos-link" onClick={() => set({ extras: draft.extras.concat([{ text: '', amount: '' }]) })}>＋ {tr('An extra')}</button>
        <div className="evt-total"><span>{money(Number(draft.perHead) || 0)} × {guests}{extras ? ' + ' + money(extras) : ''}</span><b>{money(total)}</b></div>
      </fieldset>
      <fieldset className="evt-fs"><legend>⏱️ {tr('The plan of the day')}</legend>
        {draft.plan.map((p, i) => (
          <div key={i} className="evt-plan-row">
            <input className="input" type="time" value={p.time} onChange={(e) => set({ plan: draft.plan.map((y, k) => (k === i ? { ...y, time: e.target.value } : y)) })} aria-label={tr('Time')} />
            <input className="input" maxLength={140} value={p.text} onChange={(e) => set({ plan: draft.plan.map((y, k) => (k === i ? { ...y, text: e.target.value } : y)) })} placeholder={tr('e.g. Starters out, the cake, speeches')} aria-label={tr('What')} />
            <select className="input" value={p.who} onChange={(e) => set({ plan: draft.plan.map((y, k) => (k === i ? { ...y, who: e.target.value } : y)) })} aria-label={tr('Who')}>
              {Object.keys(WHO).map((w) => <option key={w} value={w}>{WHO[w][0]} {tr(WHO[w][1])}</option>)}
            </select>
            <button type="button" className="pos-link is-bad" onClick={() => set({ plan: draft.plan.filter((y, k) => k !== i) })} aria-label={tr('Take it off')}>✕</button>
          </div>
        ))}
        <button type="button" className="pos-link" onClick={() => set({ plan: draft.plan.concat([{ time: draft.plan.length ? draft.plan[draft.plan.length - 1].time : draft.from, text: '', who: 'all' }]) })}>＋ {tr('A line')}</button>
      </fieldset>
      <div className="evt-grid">
        <label><span>{tr('The guest\'s note')}</span><textarea className="input" rows={2} maxLength={500} value={draft.note} onChange={(e) => set({ note: e.target.value })} /></label>
        <label><span>{tr('For the team only')}</span><textarea className="input" rows={2} maxLength={500} value={draft.staffNote} onChange={(e) => set({ staffNote: e.target.value })} /></label>
      </div>
      <div className="dialog-actions"><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save the event')}</button></div>
    </form>
  );
}

// The back office's Events.
export function EventsTab({ token, pin, onFail }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState(null);
  const [flash, setFlash] = useState(null);
  const call = useCallback((body) => posFetch('POST', '/pos/settings/events', token, { managerPin: pin || undefined, ...body }), [token, pin]);
  useEffect(() => { call({ action: 'list' }).then((d) => { setData(d); setSettings(d.settings); }).catch(onFail); }, [call, onFail]);
  async function run(body, done) {
    setBusy(true); setFlash(null);
    try { const d = await call(body); setData(d); if (done) done(d); return d; } catch (e) { onFail(e); return null; } finally { setBusy(false); }
  }
  if (!data) return <section className="ts-sec"><p className="dk-muted">{tr('Loading…')}</p></section>;
  if (draft) {
    return <Editor draft={draft} setDraft={setDraft} menu={data.menu} settings={data.settings} busy={busy} onClose={() => setDraft(null)}
      onSave={() => run({ action: 'save', event: { ...draft, guests: Number(draft.guests), perHead: Number(draft.perHead) || 0, deposit: Number(draft.deposit) || 0,
        menu: draft.menu.map((l) => ({ menuItemId: l.menuItemId, perGuest: Number(l.perGuest) })), extras: draft.extras.map((x) => ({ text: x.text, amount: Number(x.amount) || 0 })) } }, () => { setDraft(null); setFlash(tr('Saved.')); })} />;
  }
  const asks = data.events.filter((e) => e.status === 'enquiry');
  const coming = data.events.filter((e) => e.status === 'quoted' || e.status === 'confirmed');
  const past = data.events.filter((e) => e.status === 'done' || e.status === 'cancelled');
  function told(d) {
    if (!d || !d.told) return;
    if (d.told.sent) setFlash('📱 ' + tr('Texted to the guest.'));
    else if (d.told.whatsapp) { setFlash(<>{tr('Texts are not set up: send it on WhatsApp.')} <a href={d.told.whatsapp} target="_blank" rel="noreferrer">💬 {tr('Open WhatsApp')}</a></>); }
  }
  const card = (e, i) => (
    <article key={e.id} className={'evt-row is-' + e.status} style={{ '--i': Math.min(i, 12) }}>
      <span className="evt-date"><b>{new Date(e.startsAt).getUTCDate()}</b><small>{weekday(e.startsAt)}</small></span>
      <div className="evt-row-main">
        <strong>{e.occasion || tr('Event')} · {e.name} <span className="evt-ref">{e.ref}</span></strong>
        <small>🗓️ {dayText(e.startsAt)}, {hhmm(e.startsAt)}–{hhmm(e.endsAt)} · 👥 {tr('{n} guests', { n: e.guests })}{e.space ? ' · 📍 ' + e.space : ''}{e.source === 'website' ? ' · 🌐 ' + tr('From the website') : ''}</small>
        <small className="evt-money">{e.total > 0 ? money(e.total) + ' · ' : ''}<span className={'evt-dep-tag is-' + e.deposit.status}>{tr(DEPOSIT[e.deposit.status])}{e.deposit.amount > 0 ? ' ' + money(e.deposit.amount) : ''}</span></small>
        {e.note && <small className="evt-guest-note">💬 {e.note}</small>}
      </div>
      <div className="evt-row-end">
        <span className={'evt-status is-' + e.status}>{STATUS[e.status][0]} {tr(STATUS[e.status][1])}</span>
        <div className="evt-acts">
          {(e.status === 'enquiry' || e.status === 'quoted' || e.status === 'confirmed') && <button type="button" className="pos-link" onClick={() => setDraft(draftOf(e))}>{tr('Edit')}</button>}
          {(e.status === 'enquiry' || e.status === 'quoted') && e.total > 0 && <button type="button" className="pos-link" disabled={busy} onClick={() => run({ action: 'status', id: e.id, status: 'quoted' }, told)}>📤 {e.status === 'quoted' ? tr('Send again') : tr('Send to the guest')}</button>}
          {e.deposit.status === 'due' && e.status !== 'cancelled' && (
            <select className="input evt-dep-sel" value="" disabled={busy} onChange={(ev) => { if (ev.target.value) run({ action: 'deposit', id: e.id, method: ev.target.value }, () => setFlash(tr('Deposit taken: booked.'))); }} aria-label={tr('Deposit taken')}>
              <option value="">💵 {tr('Deposit taken…')}</option><option value="cash">{tr('In cash, into my drawer')}</option><option value="mobile_money">{tr('By Mobile Money')}</option><option value="bank">{tr('By bank transfer')}</option>
            </select>
          )}
          {(e.status === 'enquiry' || e.status === 'quoted') && e.deposit.status !== 'due' && <button type="button" className="pos-link" disabled={busy} onClick={() => run({ action: 'status', id: e.id, status: 'confirmed' }, told)}>✅ {tr('Booked')}</button>}
          {e.status === 'confirmed' && new Date(e.startsAt) < new Date() && <button type="button" className="pos-link" disabled={busy} onClick={() => run({ action: 'status', id: e.id, status: 'done' })}>🎉 {tr('Done')}</button>}
          {e.link && <button type="button" className="pos-link" onClick={() => { if (navigator.clipboard) navigator.clipboard.writeText(e.link); setFlash(tr('The guest\'s link is copied.')); }}>🔗 {tr('Copy the guest\'s link')}</button>}
          {(e.status === 'enquiry' || e.status === 'quoted' || e.status === 'confirmed') && <button type="button" className="pos-link is-bad" disabled={busy} onClick={() => { if (window.confirm(tr('Cancel {ref}? The guest is told; a deposit paid online is given back.', { ref: e.ref }))) run({ action: 'status', id: e.id, status: 'cancelled' }, told); }}>{tr('Cancel')}</button>}
        </div>
      </div>
    </article>
  );
  return (
    <section className="ts-sec evt-tab">
      {flash && <div className="ts-flash" role="status">{flash}</div>}
      <div className="evt-top">
        <p className="dk-muted">{tr('Private parties and the space hired: the menu a head, a deposit, and the plan of the day for the team.')}</p>
        <button type="button" className="btn btn-primary" onClick={() => setDraft(blankEvent())}>＋ {tr('New event')}</button>
        <button type="button" className="btn btn-secondary" onClick={() => setSettingsOpen(!settingsOpen)}>🌐 {data.settings.on ? tr('Asked for on the website') : tr('Not on the website')}</button>
      </div>
      {settingsOpen && settings && (
        <form className="cof-form evt-settings" onSubmit={(e) => { e.preventDefault(); run({ action: 'settings', settings }, () => { setSettingsOpen(false); setFlash(tr('Saved.')); }); }}>
          <button type="button" role="switch" aria-checked={settings.on} className="ts-toggle-row" onClick={() => setSettings({ ...settings, on: !settings.on })}>
            <span><strong>{tr('Hire our space, on the website')}</strong><small>{tr('Guests ask for a party: the day, the hours, how many and where. You plan it here and send it.')}</small></span>
            <span className={'ts-switch' + (settings.on ? ' is-on' : '')} aria-hidden="true"><i /></span>
          </button>
          <div className="evt-grid">
            <label><span>{tr('Guests, at least')}</span><input className="input" type="number" min="1" value={settings.minGuests} onChange={(e) => setSettings({ ...settings, minGuests: e.target.value })} /></label>
            <label><span>{tr('At least, days ahead')}</span><input className="input" type="number" min="0" max="60" value={settings.leadDays} onChange={(e) => setSettings({ ...settings, leadDays: e.target.value })} /></label>
            <label><span>{tr('Deposit, % of the price')}</span><input className="input" type="number" min="0" max="100" value={settings.depositPercent} onChange={(e) => setSettings({ ...settings, depositPercent: e.target.value })} /></label>
          </div>
          <h4>{tr('The spaces')}</h4>
          {settings.spaces.map((s, i) => (
            <div key={i} className="evt-extra">
              <input className="input" maxLength={40} value={s.name} onChange={(e) => setSettings({ ...settings, spaces: settings.spaces.map((y, k) => (k === i ? { ...y, name: e.target.value } : y)) })} placeholder={tr('e.g. Garden terrace')} aria-label={tr('Space')} />
              <input className="input" type="number" min="0" value={s.seats} onChange={(e) => setSettings({ ...settings, spaces: settings.spaces.map((y, k) => (k === i ? { ...y, seats: e.target.value } : y)) })} aria-label={tr('Seats')} />
              <button type="button" className="pos-link is-bad" onClick={() => setSettings({ ...settings, spaces: settings.spaces.filter((y, k) => k !== i) })} aria-label={tr('Take it off')}>✕</button>
            </div>
          ))}
          <button type="button" className="pos-link" onClick={() => setSettings({ ...settings, spaces: settings.spaces.concat([{ name: '', seats: 20 }]) })}>＋ {tr('A space')}</button>
          <label><span>{tr('A line for the guests (optional)')}</span><input className="input" maxLength={300} value={settings.note} onChange={(e) => setSettings({ ...settings, note: e.target.value })} placeholder={tr('e.g. Decorations welcome; music until midnight.')} /></label>
          <button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save')}</button>
        </form>
      )}
      {asks.length > 0 && <><h3 className="cof-h">📨 {tr('Asked for: plan them')} <span className="evt-count">{asks.length}</span></h3><div className="evt-list">{asks.map(card)}</div></>}
      <h3 className="cof-h">🗓️ {tr('Coming up')}</h3>
      {coming.length ? <div className="evt-list">{coming.map(card)}</div> : <p className="dk-muted">{tr('Nothing booked yet.')}</p>}
      {past.length > 0 && <><h3 className="cof-h">{tr('The last 30 days')}</h3><div className="evt-list is-past">{past.map(card)}</div></>}
    </section>
  );
}
