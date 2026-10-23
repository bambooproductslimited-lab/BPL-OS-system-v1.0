import { useEffect, useState } from 'react';
import { Icon } from '../../components/DashKit';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { activeIntlLocale, msg, tr } from '../../lib/i18n.jsx';

// A manager's back office, one tap from the till (Back office, in More and
// on the drawer screen): reports, the menu and stock, the setup. Managers
// also take orders and money on the till itself, on their own drawer. Each
// tile opens the till settings at its tab (TillSettings.jsx), with a live
// figure on it: today's sales, who has a drawer, disputes open, what is
// owed, stock running low, kitchen screens online.

const SECTIONS = [
  ['reports', msg('Reports'), msg('What happened on the till, and what is owed.'), [
    ['sales', 'up', msg('Sales')], ['insights', 'pulse', msg('Insights')], ['monthly', 'calendar', msg('Monthly report')], ['drawers', 'drawer', msg('Drawers')], ['disputes', 'warn', msg('Disputes')], ['accounts', 'owed', msg('IOUs and VIP')], ['activity', 'pulse', msg('Activity')]]],
  ['guestsGroup', msg('Guests'), msg('Texts and emails to your guests, loyalty points and gift cards.'), [
    ['campaigns', 'send', msg('Texts and emails')], ['loyalty', 'star', msg('Loyalty')], ['giftcards', 'card', msg('Gift cards')]]],
  ['menu', msg('Menu and stock'), msg('What the till sells, at what price, and what is left.'), [
    ['menu', 'receipt', msg('Menu')], ['stock', 'layers', msg('Stock')]]],
  ['setup', msg('Setup'), msg('Who does what, how customers pay, the bill\'s discounts and taxes, the floor and the kitchen screens.'), [
    ['people', 'people', msg('People')], ['roles', 'key', msg('What each role can do')], ['screens', 'layers', msg('Kitchen screens')], ['payments', 'cash', msg('Payments')],
    ['map', 'map', msg('Floor map')], ['customers', 'owed', msg('Customers')], ['bill', 'percent', msg('Discounts, service and tax')], ['service', 'clock', msg('Courses, menu times and happy hours')], ['apps', 'send', msg('Delivery apps')], ['kiosk', 'receipt', msg('Self-order kiosk')], ['receipts', 'receipt', msg('Receipts')], ['till', 'clock', msg('Till and kitchen')]]]
];

function dayISO(d) { return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }

export default function ManagerHome({ token, companyName, employeeName, logoUrl, tools, onOpen }) {
  const [live, setLive] = useState({});
  useEffect(() => {
    let on = true;
    const today = dayISO(new Date());
    const ask = (path, body, key, pick) => posFetch('POST', path, token, body).then((d) => on && setLive((l) => ({ ...l, [key]: pick(d) }))).catch(() => {});
    ask('/pos/settings/sales', { from: today, to: today, limit: 1 }, 'sales', (d) => d.totals);
    ask('/pos/settings/drawers', {}, 'drawers', (d) => d.drawers.filter((x) => x.session.status === 'open'));
    ask('/pos/settings/disputes', { filter: { status: 'open' } }, 'disputes', (d) => d.totals);
    ask('/pos/settings/accounts', {}, 'accounts', (d) => d.totals);
    ask('/pos/stock', { action: 'list' }, 'stock', (d) => ({ low: d.menu.concat(d.supplies, d.ingredients).filter((i) => i.isLow).length, items: d.menu.length }));
    ask('/pos/settings/screens', { action: 'list' }, 'screens', (d) => ({ set: d.screens.length, online: d.screens.filter((s) => s.online).length, waiting: d.waiting.length }));
    return () => { on = false; };
  }, [token]);

  function figure(k) {
    const s = live.sales, dr = live.drawers, dp = live.disputes, ac = live.accounts, st = live.stock, sc = live.screens;
    if (k === 'sales' && s) return [money(s.net), s.sales === 1 ? tr('1 sale today') : tr('{n} sales today', { n: s.sales })];
    if (k === 'drawers' && dr) {
      if (!dr.length) return [tr('No drawer open'), tr('history of every shift')];
      const duty = dr.find((d) => !d.byManager) || dr[0];
      const since = tr('on duty since {time}', { time: new Date(duty.session.openedAt).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' }) });
      return [duty.cashierName, dr.length > 1 ? since + ' · ' + tr('{n} drawers open', { n: dr.length }) : since];
    }
    if (k === 'disputes' && dp) return dp.open ? [String(dp.open), tr('open · {amount}', { amount: money(dp.openAmount) }), 'warn'] : [tr('None open'), tr('complaints, wrong charges, drawers short')];
    if (k === 'accounts' && ac) return [money(ac.owedNow), tr('owed · {amount} VIP money held', { amount: money(ac.vipHeld) }), ac.owedNow ? 'warn' : null];
    if (k === 'stock' && st) return st.low ? [String(st.low), tr('running low'), 'warn'] : [tr('All fine'), tr('{n} dishes counted', { n: st.items })];
    if (k === 'screens' && sc) return sc.waiting ? [tr('{n} new', { n: sc.waiting }), tr('waiting to be set up'), 'warn'] : [tr('{n} of {m}', { n: sc.online, m: sc.set }), tr('online now')];
    return null;
  }

  return (
    <div className="mh">
      <header className="mh-top">
        <div className="mh-who">
          {logoUrl && <span className="pos-top-logo-wrap"><img className="pos-top-logo" src={logoUrl} alt="" /></span>}
          <div><strong>{companyName}</strong><small>{employeeName} · {tr('Manager')}</small></div>
        </div>
        <div className="mh-tools">{tools}</div>
      </header>
      <section className="mh-hero">
        <span className="mh-hero-ico" aria-hidden="true"><Icon name="key" /></span>
        <div>
          <h1>{tr('Back office')}</h1>
          <p>{tr('Reports, the menu and stock, and the till\'s setup. Orders and money are on the till: open your own drawer there when the cashier on duty is away.')}</p>
        </div>
      </section>
      {SECTIONS.map(([g, title, note, tiles]) => (
        <section key={g} className={'mh-sec is-' + g}>
          <h2>{tr(title)}<small>{tr(note)}</small></h2>
          <div className="mh-tiles">
            {tiles.map(([k, icon, label]) => {
              const f = figure(k);
              return (
                <button key={k} type="button" className={'mh-tile' + (f && f[2] ? ' is-' + f[2] : '')} onClick={() => onOpen(k)}>
                  <span className="mh-tile-ico" aria-hidden="true"><Icon name={icon} /></span>
                  <span className="mh-tile-text"><small>{tr(label)}</small>{f ? <><strong>{f[0]}</strong><span>{f[1]}</span></> : <span className="mh-open">{tr('Open')} →</span>}</span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
