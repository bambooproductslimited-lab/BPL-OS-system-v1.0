import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/DashKit';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { activeIntlLocale, msg, tr } from '../../lib/i18n.jsx';
import { methodName } from './tillShared';

// The till settings' back-office tabs (TillSettings.jsx): the kitchen
// screens a manager sets up, the drawers of every shift (and one left open
// closed for its cashier), disputes, and what customers owe and put down.
// Backend: restaurantKdsScreens, restaurantPos.drawerHistory,
// restaurantDisputes, restaurantTillAccounts (all through
// restaurantTillAccess.service.js, a manager's PIN in the body).

function dayISO(d) { return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
function when(iso) { return new Date(iso).toLocaleString(activeIntlLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
function ago(iso) {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? tr('just now') : m < 60 ? tr('{n} min ago', { n: m }) : m < 1440 ? tr('{n} h ago', { n: Math.floor(m / 60) }) : tr('{n} days ago', { n: Math.floor(m / 1440) });
}
const RANGES = [['7', msg('Last 7 days')], ['30', msg('Last 30 days')], ['month', msg('This month')]];
function rangeDates(r) {
  const today = dayISO(new Date());
  if (r === 'month') return { from: today.slice(0, 8) + '01', to: today };
  return { from: dayISO(new Date(Date.now() - (Number(r) - 1) * 86400000)), to: today };
}
function RangeChips({ value, onChange }) {
  return (
    <div className="ts-chips" role="radiogroup" aria-label={tr('When')}>
      {RANGES.map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={value === k} className={value === k ? 'is-on' : ''} onClick={() => onChange(k)}>{tr(label)}</button>)}
    </div>
  );
}

// ── kitchen screens ──
export function KitchenScreensTab({ token, pin, onFail }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [names, setNames] = useState({}); // waiting code or screen id -> name typed
  const [stations, setStations] = useState({}); // waiting code or screen id -> station picked
  const [code, setCode] = useState('');
  const call = useCallback(async (body) => posFetch('POST', '/pos/settings/screens', token, { managerPin: pin || undefined, ...body }), [token, pin]);
  const load = useCallback(async () => { try { setData(await call({ action: 'list' })); } catch (err) { onFail(err); } }, [call, onFail]);
  useEffect(() => { load(); const t = setInterval(load, 6000); return () => clearInterval(t); }, [load]);
  async function act(body) {
    setBusy(true);
    try { setData(await call(body)); setNames({}); setStations({}); setCode(''); } catch (err) { onFail(err); } finally { setBusy(false); }
  }
  if (!data) return <section className="ts-sec"><p className="dk-muted">{tr('Loading…')}</p></section>;
  const nextName = tr('Kitchen screen {n}', { n: data.screens.length + 1 });
  function stationPick(key, value) {
    return (
      <select className="input" value={value} onChange={(e) => setStations({ ...stations, [key]: e.target.value })} aria-label={tr('Station')}>
        <option value="all">{tr('All stations')}</option>
        {data.stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    );
  }
  return (
    <section className="ts-sec ts-scr">
      <p className="dk-muted">{tr('Each screen in a kitchen or bar is set up here once: its name and the station whose dishes it shows. Cooks then sign in on it with their own PIN, so the activity report says who cooked what.')}</p>
      {!data.stations.length && <p className="ts-note"><Icon name="info" />{tr('No stations yet: every screen shows every dish. Stations are set up in the app under Restaurants → Kitchen.')}</p>}

      <div className="ts-scr-new">
        <h4><span className="ts-scr-pulse" aria-hidden="true" />{tr('New screens on this network')}</h4>
        {!data.waiting.length ? (
          <p className="dk-muted tl-hint-row">{tr('None waiting. Open the kitchen screen link on the tablet: it shows a code and appears here within a few seconds.')}</p>
        ) : (
          <ul className="ts-scr-wait">
            {data.waiting.map((w) => {
              const name = names[w.code] !== undefined ? names[w.code] : nextName;
              return (
                <li key={w.code}>
                  <span className="ts-scr-code">{w.code.slice(0, 3)} {w.code.slice(3)}</span>
                  <span className="ts-scr-dev"><strong>{w.device}</strong><small>{tr('opened {when}', { when: ago(w.createdAt) })}</small></span>
                  <input className="input" value={name} maxLength={40} onChange={(e) => setNames({ ...names, [w.code]: e.target.value })} aria-label={tr('Name')} />
                  {stationPick(w.code, stations[w.code] || 'all')}
                  <button type="button" className="btn btn-primary tl-btn" disabled={busy} onClick={() => act({ action: 'claim', code: w.code, name, stationId: stations[w.code] || 'all' })}>{tr('Set up')}</button>
                </li>
              );
            })}
          </ul>
        )}
        <form className="ts-scr-code-form" onSubmit={(e) => { e.preventDefault(); act({ action: 'claim', code, name: names.code || nextName, stationId: stations.code || 'all' }); }}>
          <span>{tr('Not listed? Type the code shown on the screen:')}</span>
          <input className="input ts-scr-code-in" value={code} maxLength={7} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="······" aria-label={tr('Code')} />
          <input className="input" value={names.code !== undefined ? names.code : nextName} maxLength={40} onChange={(e) => setNames({ ...names, code: e.target.value })} aria-label={tr('Name')} />
          {stationPick('code', stations.code || 'all')}
          <button type="submit" className="btn btn-secondary tl-btn" disabled={busy || code.replace(/\s/g, '').length !== 6}>{tr('Set up')}</button>
        </form>
      </div>

      <h4 className="ts-scr-h">{tr('Set-up screens')} <small>{data.screens.length}</small></h4>
      {!data.screens.length ? <div className="dk-empty"><Icon name="info" /><p>{tr('No screen set up yet.')}</p></div> : (
        <ul className="ts-scr-list">
          {data.screens.map((sc) => {
            const name = names[sc.id] !== undefined ? names[sc.id] : sc.name;
            const st = stations[sc.id] || sc.stationId || 'all';
            const changed = name !== sc.name || st !== (sc.stationId || 'all');
            return (
              <li key={sc.id} className={sc.online ? 'is-online' : ''}>
                <span className="ts-scr-ico" aria-hidden="true"><Icon name="layers" /><i /></span>
                <span className="ts-scr-main">
                  <input className="input" value={name} maxLength={40} onChange={(e) => setNames({ ...names, [sc.id]: e.target.value })} aria-label={tr('Name')} />
                  <small>{[sc.online ? tr('Online') : tr('Last seen {when}', { when: ago(sc.lastSeenAt) }), sc.device, sc.signedIn ? tr('{name} signed in {when}', { name: sc.signedIn, when: ago(sc.signedInAt) }) : tr('Nobody signed in yet')].join(' · ')}</small>
                </span>
                {stationPick(sc.id, st)}
                {changed && <button type="button" className="btn btn-primary tl-btn" disabled={busy} onClick={() => act({ action: 'update', id: sc.id, name, stationId: st })}>{tr('Save')}</button>}
                <button type="button" className="pos-link is-bad" disabled={busy} onClick={() => { if (window.confirm(tr('Take {name} off? It goes back to showing a code until it is set up again.', { name: sc.name }))) act({ action: 'remove', id: sc.id }); }}>{tr('Take off')}</button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ── drawers ──
// onActivity(drawer) opens the activity report on everything done on one drawer.
export function DrawersTab({ token, pin, onFail, onActivity }) {
  const [range, setRange] = useState('7');
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [count, setCount] = useState('');
  const [note, setNote] = useState('');
  const [closing, setClosing] = useState(null); // the drawer a manager is closing for its cashier
  const [busy, setBusy] = useState(false);
  const dates = useMemo(() => rangeDates(range), [range]);
  const load = useCallback(async (extra) => {
    try { setData(await posFetch('POST', '/pos/settings/drawers', token, { managerPin: pin || undefined, ...dates, ...extra })); } catch (err) { onFail(err); }
  }, [token, pin, dates, onFail]);
  useEffect(() => { load(); }, [load]);
  async function closeFor(d) {
    setBusy(true);
    try { await load({ action: 'close', id: d.session.id, actualCash: count, note }); setCount(''); setNote(''); setOpen(null); setClosing(null); } finally { setBusy(false); }
  }
  const t = data && data.totals;
  return (
    <section className="ts-sec ts-dr">
      <RangeChips value={range} onChange={setRange} />
      {t && (
        <div className="ts-act-sum">
          <span><b>{t.drawers}</b>{t.drawers === 1 ? tr('drawer') : tr('drawers')}</span>
          <span className="is-sales"><b>{money(t.cashSales)}</b>{tr('cash sales')}</span>
          <span className={t.short < 0 ? 'is-refunds' : ''}><b>{money(t.short)}</b>{tr('short')}</span>
          <span><b>{money(t.over)}</b>{tr('over')}</span>
        </div>
      )}
      {!data ? <p className="dk-muted">{tr('Loading…')}</p> : !data.drawers.length ? <div className="dk-empty"><Icon name="drawer" /><p>{tr('No drawers on these days.')}</p></div> : (
        <ul className="ts-dr-list">
          {data.drawers.map((d) => {
            const isOpen = d.session.status === 'open';
            const diff = d.difference;
            return (
              <li key={d.session.id} className={isOpen ? 'is-open' : diff < 0 ? 'is-short' : diff > 0 ? 'is-over' : ''}>
                <button type="button" className="ts-dr-row" aria-expanded={open === d.session.id} onClick={() => setOpen(open === d.session.id ? null : d.session.id)}>
                  <span className="ts-dr-who"><strong>{d.cashierName}{d.byManager && <em className="ts-dr-mgr">{tr('Manager')}</em>}</strong><small>{when(d.session.openedAt)}{d.session.closedAt ? ' → ' + new Date(d.session.closedAt).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' }) : ''}</small></span>
                  <span className="ts-dr-fig"><small>{tr('Expected')}</small><b>{money(d.expected)}</b></span>
                  <span className="ts-dr-fig"><small>{tr('Counted')}</small><b>{d.actual == null ? '—' : money(d.actual)}</b></span>
                  <span className={'ts-dr-diff' + (isOpen ? ' is-open' : diff < 0 ? ' is-short' : diff > 0 ? ' is-over' : ' is-ok')}>
                    {isOpen ? tr('Open now') : diff === 0 ? tr('Adds up') : (diff > 0 ? '+' : '−') + money(Math.abs(diff))}
                  </span>
                </button>
                {open === d.session.id && (
                  <div className="ts-dr-detail">
                    <dl>
                      <div><dt>{tr('Starting Cash')}</dt><dd>{money(d.startingCash)}</dd></div>
                      <div><dt>{tr('Cash Sales')}</dt><dd>{money(d.cashSales)}</dd></div>
                      {d.iouPaidCash > 0 && <div><dt>{tr('IOUs paid in cash')}</dt><dd>{money(d.iouPaidCash)}</dd></div>}
                      {d.vipTopUpsCash > 0 && <div><dt>{tr('VIP money in cash')}</dt><dd>{money(d.vipTopUpsCash)}</dd></div>}
                      {d.cashRefunds > 0 && <div><dt>{tr('Cash Refunds')}</dt><dd>−{money(d.cashRefunds)}</dd></div>}
                      <div><dt>{tr('Paid In/Out')}</dt><dd>{money(d.netPaidInOut)}</dd></div>
                    </dl>
                    {d.movements.length > 0 && <ul className="ts-dr-moves">{d.movements.map((m) => <li key={m.id}>{m.direction === 'in' ? '+' : '−'}{money(m.amount)} · {m.note || '—'} · {new Date(m.createdAt).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' })}</li>)}</ul>}
                    {d.session.closingNote && <p className="ts-hint">✎ {d.session.closingNote}</p>}
                    {d.dispute && <p className="ts-hint">{d.dispute.status === 'open' ? tr('A dispute is open for this shortage (Disputes).') : tr('Its dispute is resolved.')}</p>}
                    {onActivity && (
                      <button type="button" className="btn btn-secondary tl-btn ts-dr-log" onClick={() => onActivity({ id: d.session.id, label: d.cashierName + ' · ' + when(d.session.openedAt) + ' → ' + (d.session.closedAt ? new Date(d.session.closedAt).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' }) : tr('open now')) })}>
                        <Icon name="pulse" />{tr('Everything done on this drawer')}
                      </button>
                    )}
                    {/* Signing out leaves a drawer open: its cashier counts and closes it.
                        A manager does so for them only when they cannot. */}
                    {isOpen && closing !== d.session.id && (
                      <button type="button" className="pos-link ts-dr-for" onClick={() => setClosing(d.session.id)}>{tr('{name} cannot close it themselves? Close it for them…', { name: d.cashierName })}</button>
                    )}
                    {isOpen && closing === d.session.id && (
                      <form className="ts-dr-close" onSubmit={(e) => { e.preventDefault(); closeFor(d); }}>
                        <p>{tr('Only when {name} cannot count it themselves (gone home, off sick): count the cash in it and close it for them, so the next cashier can open theirs.', { name: d.cashierName })}</p>
                        <label><span>{tr('Counted')}</span><input className="input" type="number" min="0" step="0.01" inputMode="decimal" value={count} onChange={(e) => setCount(e.target.value)} required /></label>
                        <input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder={tr('Note (optional)')} aria-label={tr('Note')} />
                        <button type="submit" className="btn btn-primary tl-btn" disabled={busy || count === ''}>{tr('Close the drawer')}</button>
                      </form>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ── disputes ──
const KIND_LABEL = { complaint: msg('Complaint'), wrong_charge: msg('Wrong charge'), drawer_short: msg('Drawer short'), rider_short: msg('Rider short'), other: msg('Other problem') };
const RESOLUTION_LABEL = { refunded: msg('Refunded'), remade: msg('Made again'), discounted: msg('Discounted'), written_off: msg('Written off'), no_action: msg('Nothing to do'), other: msg('Other') };
export function kindLabel(k) { return KIND_LABEL[k] ? tr(KIND_LABEL[k]) : k; }

export function DisputesTab({ token, pin, onFail }) {
  const [status, setStatus] = useState('open');
  const [kind, setKind] = useState('');
  const [data, setData] = useState(null);
  const [resolving, setResolving] = useState(null);
  const [resolution, setResolution] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const call = useCallback(async (extra) => posFetch('POST', '/pos/settings/disputes', token, { managerPin: pin || undefined, filter: { status, kind: kind || undefined }, ...extra }), [token, pin, status, kind]);
  useEffect(() => { let live = true; call({}).then((d) => live && setData(d)).catch((err) => live && onFail(err)); return () => { live = false; }; }, [call, onFail]);
  async function act(extra) {
    setBusy(true);
    try { setData(await call(extra)); setResolving(null); setResolution(''); setNote(''); } catch (err) { onFail(err); } finally { setBusy(false); }
  }
  const t = data && data.totals;
  return (
    <section className="ts-sec ts-dp">
      <p className="dk-muted">{tr('Complaints and wrong charges raised on the till, and drawers counted short (these open by themselves). Resolve each, saying how.')}</p>
      <div className="ts-dp-filters">
        <div className="ts-chips" role="radiogroup" aria-label={tr('Status')}>
          {[['open', tr('Open')], ['resolved', tr('Resolved')], ['all', tr('All')]].map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={status === k} className={status === k ? 'is-on' : ''} onClick={() => setStatus(k)}>{label}</button>)}
        </div>
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)} aria-label={tr('Kind')}>
          <option value="">{tr('Every kind')}</option>
          {Object.keys(KIND_LABEL).map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
        </select>
      </div>
      {t && (
        <div className="ts-act-sum">
          <span className={t.open ? 'is-refunds' : ''}><b>{t.open}</b>{tr('open')}</span>
          <span><b>{money(t.openAmount)}</b>{tr('at stake')}</span>
          <span className="is-sales"><b>{t.resolved30}</b>{tr('resolved in 30 days')}</span>
          <span><b>{money(t.short30)}</b>{tr('drawers short in 30 days')}</span>
        </div>
      )}
      {!data ? <p className="dk-muted">{tr('Loading…')}</p> : !data.rows.length ? <div className="dk-empty"><Icon name="check" /><p>{status === 'open' ? tr('No open disputes. Nice.') : tr('No disputes for these filters.')}</p></div> : (
        <ul className="ts-dp-list">
          {data.rows.map((d) => (
            <li key={d.id} className={'is-' + d.kind + ' is-' + d.status}>
              <div className="ts-dp-top">
                <span className={'ts-dp-kind is-' + d.kind}>{kindLabel(d.kind)}</span>
                {d.amount != null && <b className="ts-dp-amt">{money(d.amount)}</b>}
                <span className={'ts-dp-status is-' + d.status}>{d.status === 'open' ? tr('Open') : tr('Resolved')}</span>
              </div>
              <p className="ts-dp-desc">{d.description}</p>
              <small className="ts-dp-meta">{[d.orderNo ? tr('Sale {order}', { order: d.orderNo }) : d.tabLabel ? tr('Open order {name}', { name: d.tabLabel }) : null, d.customerName, d.openedBy ? tr('raised by {name}', { name: d.openedBy }) : tr('opened by itself'), when(d.createdAt)].filter(Boolean).join(' · ')}</small>
              {d.status === 'resolved' ? (
                <div className="ts-dp-res">
                  <Icon name="check" /><span><b>{RESOLUTION_LABEL[d.resolution] ? tr(RESOLUTION_LABEL[d.resolution]) : d.resolution}</b>{d.resolutionNote ? ' — ' + d.resolutionNote : ''}<small>{tr('{name}, {when}', { name: d.resolvedBy || '—', when: when(d.resolvedAt) })}</small></span>
                  <button type="button" className="pos-link" disabled={busy} onClick={() => act({ action: 'reopen', id: d.id })}>{tr('Open again')}</button>
                </div>
              ) : resolving === d.id ? (
                <form className="ts-dp-form" onSubmit={(e) => { e.preventDefault(); act({ action: 'resolve', id: d.id, resolution, note }); }}>
                  <div className="ts-chips" role="radiogroup" aria-label={tr('How it was resolved')}>
                    {Object.keys(RESOLUTION_LABEL).map((k) => <button key={k} type="button" role="radio" aria-checked={resolution === k} className={resolution === k ? 'is-on' : ''} onClick={() => setResolution(k)}>{tr(RESOLUTION_LABEL[k])}</button>)}
                  </div>
                  <input className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder={tr('What was done (optional)')} aria-label={tr('Note')} />
                  <div className="ts-dp-form-act">
                    <button type="button" className="btn btn-secondary tl-btn" onClick={() => setResolving(null)}>{tr('Cancel')}</button>
                    <button type="submit" className="btn btn-primary tl-btn" disabled={busy || !resolution}>{tr('Resolve')}</button>
                  </div>
                </form>
              ) : <button type="button" className="btn btn-secondary tl-btn ts-dp-go" onClick={() => { setResolving(d.id); setResolution(''); setNote(''); }}>{tr('Resolve…')}</button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── IOUs and VIP money ──
const VIP_KIND = { topup: msg('Put down'), sale: msg('Spent'), refund: msg('Given back') };
export function AccountsTab({ token, pin, onFail }) {
  const [range, setRange] = useState('30');
  const [view, setView] = useState('iou');
  const [data, setData] = useState(null);
  const dates = useMemo(() => rangeDates(range), [range]);
  useEffect(() => {
    let live = true;
    posFetch('POST', '/pos/settings/accounts', token, { managerPin: pin || undefined, ...dates }).then((d) => live && setData(d)).catch((err) => live && onFail(err));
    return () => { live = false; };
  }, [token, pin, dates, onFail]);
  const t = data && data.totals;
  return (
    <section className="ts-sec ts-ac">
      <div className="ts-ac-top">
        <div className="dk-segment pos-seg" role="radiogroup" aria-label={tr('Show')}>
          <button type="button" role="radio" aria-checked={view === 'iou'} className={view === 'iou' ? 'is-on' : ''} onClick={() => setView('iou')}>{tr('IOUs')}</button>
          <button type="button" role="radio" aria-checked={view === 'vip'} className={view === 'vip' ? 'is-on' : ''} onClick={() => setView('vip')}>{tr('VIP money')}</button>
        </div>
        <RangeChips value={range} onChange={setRange} />
      </div>
      {t && view === 'iou' && (
        <div className="ts-act-sum">
          <span className={t.owedNow ? 'is-refunds' : ''}><b>{money(t.owedNow)}</b>{tr('owed now by {n} customers', { n: t.owingCustomers })}</span>
          <span className="is-sales"><b>{money(t.iouPaid)}</b>{tr('paid back on these days')}</span>
          <span><b>{money(t.iouSold)}</b>{tr('sold on IOU ({n})', { n: t.iouSoldCount })}</span>
        </div>
      )}
      {t && view === 'vip' && (
        <div className="ts-act-sum">
          <span className="is-sales"><b>{money(t.vipToppedUp)}</b>{tr('put down')}</span>
          <span><b>{money(t.vipSpent)}</b>{tr('spent')}</span>
          {t.vipBack > 0 && <span><b>{money(t.vipBack)}</b>{tr('given back')}</span>}
          <span className="is-kitchen"><b>{money(t.vipHeld)}</b>{tr('held now for {n} customers', { n: t.vipCustomers })}</span>
        </div>
      )}
      {!data ? <p className="dk-muted">{tr('Loading…')}</p> : view === 'iou' ? (
        !data.ious.length ? <div className="dk-empty"><Icon name="owed" /><p>{tr('Nobody owes anything, and no IOU was paid on these days.')}</p></div> : (
          <ul className="ts-ac-list">
            {data.ious.map((i) => (
              <li key={i.id} className={i.paid ? 'is-paid' : i.days >= 7 ? 'is-late' : 'is-owed'}>
                <span className="ts-ac-main"><strong>{i.customer || '—'}</strong><small>{[i.orderNo, when(i.at), i.phone, i.cashier].filter(Boolean).join(' · ')}</small></span>
                <span className={'ts-ac-tag' + (i.paid ? ' is-paid' : i.days >= 7 ? ' is-late' : '')}>
                  {i.paid ? tr('Paid {when} · {method}', { when: when(i.paidAt), method: methodName(i.paidMethod) }) : i.days === 0 ? tr('Owed since today') : tr('Owed {n} days', { n: i.days })}
                </span>
                <b className="ts-ac-amt">{money(i.paid ? i.paidAmount : i.owed)}</b>
              </li>
            ))}
          </ul>
        )
      ) : (
        !data.vip.length ? <div className="dk-empty"><Icon name="spark" /><p>{tr('No VIP money put down or spent on these days.')}</p></div> : (
          <ul className="ts-ac-list">
            {data.vip.map((v) => (
              <li key={v.id} className={'is-vip-' + v.kind}>
                <span className="ts-ac-main"><strong>{v.customer}</strong><small>{[when(v.at), v.orderNo, v.method ? methodName(v.method) : null, v.cashier, v.note].filter(Boolean).join(' · ')}</small></span>
                <span className={'ts-ac-tag is-' + v.kind}>{VIP_KIND[v.kind] ? tr(VIP_KIND[v.kind]) : v.kind}</span>
                <b className="ts-ac-amt">{v.amount > 0 ? '+' : '−'}{money(Math.abs(v.amount))}</b>
              </li>
            ))}
          </ul>
        )
      )}
    </section>
  );
}
