import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import RowMenu from '../components/RowMenu';
import SearchInput, { matchesQuery } from '../components/SearchInput';
import { Section } from '../components/DashKit';
import { activeIntlLocale, tr } from '../lib/i18n.jsx';
import './RestaurantKitchen.css';

// Restaurants → Kitchen: the kitchen display (KDS) for one restaurant
// (backend restaurantKitchen.service.js; the screen itself is
// pages/KdsPage.jsx at /kds). Off until a station is set up: then each
// round the till sends — an open table kept open, a sale charged — shows
// on the kitchen screen as a ticket, each dish at the station that cooks
// its menu category. Here: how the kitchen is doing today (tickets, time
// from sent to ready, how many took too long), the stations and the
// categories each cooks, where every category of the menu goes (or that it
// is not sent at all), and today's tickets with their times.

function timeOf(ts) { return new Date(ts).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' }); }
function minText(m) { return m == null ? '—' : m < 1 ? tr('under a minute') : tr('{n} min', { n: Math.round(m) }); }
const STATUS = { cooking: () => tr('Cooking'), ready: () => tr('Ready'), served: () => tr('Served to the guest'), cancelled: () => tr('Cancelled') };

export default function RestaurantKitchen({ companyId, companyName, canManage, onToast }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [dialog, setDialog] = useState(null); // { id?, name, categories: [], everythingElse }
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [catSearch, setCatSearch] = useState('');

  const load = useCallback(async () => {
    if (!companyId) return;
    try { setData(await api.get('/restaurant/kitchen?companyId=' + companyId)); setError(null); } catch (e) { setError(e.message); }
  }, [companyId]);
  useEffect(() => { setData(null); load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  async function run(fn, done) {
    try { await fn(); await load(); if (done) onToast(done); } catch (e) { onToast(e.message); }
  }
  async function saveStation(e) {
    e.preventDefault();
    setSaving(true); setFormError(null);
    try {
      const body = { name: dialog.name, categories: dialog.categories, everythingElse: dialog.everythingElse, printTickets: !!dialog.printTickets };
      if (dialog.id) await api.put('/restaurant/kitchen/stations/' + dialog.id, body);
      else await api.post('/restaurant/kitchen/stations', { ...body, companyId });
      setDialog(null);
      await load();
      onToast(dialog.id ? tr('Station saved.') : tr('Station added. The till now sends its dishes to the kitchen screen.'));
    } catch (err) { setFormError(err.message); } finally { setSaving(false); }
  }
  function oneKitchen() {
    run(() => api.post('/restaurant/kitchen/stations', { companyId, name: tr('Kitchen'), categories: [], everythingElse: true }), tr('The kitchen screen is on: every dish goes to one kitchen.'));
  }

  // Which station already cooks each category (a category goes to one).
  const takenBy = useMemo(() => {
    const m = new Map();
    (data ? data.stations : []).forEach((s) => { if (s.active) s.categories.forEach((c) => m.set(c.trim().toLowerCase(), s)); });
    return m;
  }, [data]);

  if (error && !data) return <div className="error-banner">{error}</div>;
  if (!data) return <p className="dk-muted">{tr('Loading…')}</p>;
  const t = data.today, timing = data.timing;
  const tone = (m) => (m == null ? '' : m >= timing.lateAfter ? 'is-late' : m >= timing.warnAfter ? 'is-warn' : 'is-ok');
  const maxStation = Math.max(1, ...t.byStation.map((s) => s.averageMinutes || 0));
  const notSent = data.categories.filter((c) => !c.stationId);

  return (
    <div className="rk">
      <Section id="rs-kitchen" title={tr('Kitchen screen')} card
        sub={tr('What the till sends to the kitchen shows on a screen there: open the kitchen screen on a tablet or TV in the kitchen and sign in with a staff PIN.')}
        action={<a className="btn btn-primary tl-btn" href="/kds" target="_blank" rel="noreferrer">{tr('Open the kitchen screen ↗')}</a>}>
        {!data.inUse ? (
          <div className="rk-start">
            <span className="rk-start-art" aria-hidden="true">👩‍🍳</span>
            <div className="rk-start-text">
              <strong>{tr('The kitchen screen is off for {name}', { name: companyName })}</strong>
              <p>{tr('Set up where dishes are cooked. Then, when a waiter keeps a table open or the till charges a sale, the dishes go to the kitchen screen as a ticket, each to the station that cooks it, and the till sees when they are ready.')}</p>
              {canManage ? (
                <div className="rk-start-acts">
                  <button type="button" className="btn btn-primary" onClick={oneKitchen}>{tr('One kitchen for everything')}</button>
                  <button type="button" className="btn btn-secondary" onClick={() => { setFormError(null); setCatSearch(''); setDialog({ name: '', categories: [], everythingElse: false }); }}>{tr('Set up stations…')}</button>
                </div>
              ) : <p className="dk-muted">{tr('A manager of the restaurant can turn it on here.')}</p>}
            </div>
          </div>
        ) : (
          <div className="rk-tiles">
            <div className="rk-tile"><b>{t.tickets}</b><span>{t.tickets === 1 ? tr('ticket today') : tr('tickets today')}</span></div>
            <div className="rk-tile is-cooking"><b>{t.cooking}</b><span>{tr('cooking now')}</span></div>
            <div className="rk-tile is-ready"><b>{t.ready}</b><span>{tr('ready to serve')}</span></div>
            <div className={'rk-tile ' + tone(t.averageMinutes)}><b>{minText(t.averageMinutes)}</b><span>{tr('on average, sent to ready')}</span></div>
            <div className={'rk-tile ' + tone(t.longestMinutes)}><b>{minText(t.longestMinutes)}</b><span>{tr('the longest today')}</span></div>
            <div className={'rk-tile' + (t.late ? ' is-late' : '')}><b>{t.late}</b><span>{tr('took over {n} min', { n: timing.lateAfter })}</span></div>
          </div>
        )}
      </Section>

      <div className="dk-two rk-two">
        <Section id="rs-stations" title={tr('Stations')} card
          sub={tr('Each part of the kitchen with its own screen, and the menu categories it cooks. One station can also take everything else.')}
          action={canManage && <button type="button" className="btn btn-secondary tl-btn" onClick={() => { setFormError(null); setCatSearch(''); setDialog({ name: '', categories: [], everythingElse: !data.stations.some((s) => s.everythingElse) }); }}>{tr('Add station')}</button>}>
          {!data.stations.length ? <p className="dk-muted tl-small">{tr('No stations yet.')}</p> : (
            <ul className="rk-stations">
              {data.stations.map((s) => {
                const today = t.byStation.find((x) => x.id === s.id);
                return (
                  <li key={s.id} className={'rk-station' + (s.active ? '' : ' is-off')}>
                    <div className="rk-station-head">
                      <span className="rk-station-ico" aria-hidden="true">🍳</span>
                      <strong>{s.name}</strong>
                      {!s.active && <span className="rk-pill">{tr('Turned off')}</span>}
                      {s.everythingElse && <span className="rk-pill is-else">{tr('Everything else')}</span>}
                      {s.printTickets && <span className="rk-pill is-else">🖨 {tr('Prints at the till')}</span>}
                      {canManage && <RowMenu actions={[
                        { label: tr('Edit'), onClick: () => { setFormError(null); setCatSearch(''); setDialog({ id: s.id, name: s.name, categories: s.categories, everythingElse: s.everythingElse, printTickets: s.printTickets }); } },
                        { label: s.active ? tr('Turn off') : tr('Turn on'), onClick: () => run(() => api.put('/restaurant/kitchen/stations/' + s.id, { active: !s.active }), s.active ? tr('Station turned off.') : tr('Station turned on.')) },
                        { label: tr('Delete'), danger: true, onClick: () => { if (window.confirm(tr('Delete the station {name}? Its dishes stop going to the kitchen screen.', { name: s.name }))) run(() => api.del('/restaurant/kitchen/stations/' + s.id), tr('Station removed.')); } }
                      ]} />}
                    </div>
                    <div className="rk-cats">
                      {s.categories.slice(0, 10).map((c) => <span key={c} className="rk-cat">{c}</span>)}
                      {s.categories.length > 10 && <span className="rk-cat is-more">{tr('+{n} more', { n: s.categories.length - 10 })}</span>}
                      {!s.categories.length && !s.everythingElse && <span className="dk-muted tl-small">{tr('No categories yet: nothing goes here.')}</span>}
                      {!s.categories.length && s.everythingElse && <span className="dk-muted tl-small">{tr('Every dish no other station cooks.')}</span>}
                    </div>
                    {today && today.dishes > 0 && (
                      <div className="rk-station-today">
                        <span>{today.dishes === 1 ? tr('1 dish today') : tr('{n} dishes today', { n: today.dishes })}{today.cooking ? ' · ' + tr('{n} cooking', { n: today.cooking }) : ''}</span>
                        {today.averageMinutes != null && (
                          <span className={'rk-bar ' + tone(today.averageMinutes)}><i style={{ width: (today.averageMinutes / maxStation) * 100 + '%' }} /><b>{tr('{n} min each', { n: Math.round(today.averageMinutes) })}</b></span>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section id="rs-routes" title={tr('Where each dish goes')} card
          sub={notSent.length ? tr('{n} categories go to no station, so their dishes are not sent to the kitchen (drinks from the fridge, things from the shop).', { n: notSent.length }) : tr('Every category of the menu goes to a station.')}>
          {!data.categories.length ? <p className="dk-muted tl-small">{tr('No menu yet.')}</p> : (
            <ul className="rk-routes">
              {data.categories.map((c) => (
                <li key={c.name || '—'} className={c.stationId ? '' : 'is-none'}>
                  <span className="rk-route-cat"><strong>{c.name || tr('No category')}</strong><small>{c.items === 1 ? tr('1 dish') : tr('{n} dishes', { n: c.items })}</small></span>
                  <span className="rk-route-arrow" aria-hidden="true">→</span>
                  <span className={'rk-route-to' + (c.stationId ? '' : ' is-none')}>{c.stationName || tr('Not sent')}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {data.inUse && (
        <Section id="rs-tickets" title={tr('Today\'s tickets')} sub={tr('Newest first, with the time from sent to ready. Amber after {warn} minutes, red after {late}.', { warn: timing.warnAfter, late: timing.lateAfter })}>
          {!data.tickets.length ? <p className="dk-muted tl-small">{tr('Nothing sent to the kitchen today yet.')}</p> : (
            <ul className="rk-tickets">
              {data.tickets.map((x) => (
                <li key={x.id} className={'rk-ticket is-' + x.status}>
                  <span className="rk-no">#{x.number}</span>
                  <span className="rk-ticket-main">
                    <strong>{x.tableName || x.label || tr('Counter')}</strong>
                    <small>{[tr('sent {time}', { time: timeOf(x.createdAt) }), x.waiterName].filter(Boolean).join(' · ')}</small>
                    <span className="rk-ticket-items">{x.items.map((i) => <span key={i.name + i.status} className={'is-' + i.status}>{i.qty}× {i.name}</span>)}</span>
                    {x.note && <span className="rk-ticket-note">✎ {x.note}</span>}
                  </span>
                  <span className={'rk-ticket-time ' + tone(x.readyMinutes)}>{x.readyMinutes != null ? minText(x.readyMinutes) : ''}</span>
                  <span className={'rk-pill is-' + x.status}>{STATUS[x.status] ? STATUS[x.status]() : x.status}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {dialog && (
        <div className="dialog-backdrop" onClick={() => !saving && setDialog(null)}>
          <form className="dialog rk-dialog" onClick={(e) => e.stopPropagation()} onSubmit={saveStation}>
            <h2>{dialog.id ? tr('Edit station') : tr('Add a station')}</h2>
            <p className="dk-muted">{tr('A part of the kitchen with its own screen. Pick the menu categories it cooks; their dishes go to its screen.')}</p>
            <div className="field">
              <label htmlFor="rk-name">{tr('Name')}</label>
              <input id="rk-name" className="input" required maxLength={40} autoFocus value={dialog.name} onChange={(e) => setDialog({ ...dialog, name: e.target.value })} placeholder={tr('e.g. Chinese kitchen, Grill, Bar')} />
            </div>
            <label className="rk-else">
              <input type="checkbox" checked={dialog.everythingElse} onChange={(e) => setDialog({ ...dialog, everythingElse: e.target.checked })} />
              <span><strong>{tr('Also take everything else')}</strong><small>{tr('Every dish whose category no station cooks comes here. Only one station can.')}</small></span>
            </label>
            <label className="rk-else">
              <input type="checkbox" checked={!!dialog.printTickets} onChange={(e) => setDialog({ ...dialog, printTickets: e.target.checked })} />
              <span><strong>{tr('No screen: print its tickets')}</strong><small>{tr('A station with no screen gets its tickets printed at the till when an order is sent or a course is called.')}</small></span>
            </label>
            <div className="rk-pick-head">
              <strong>{tr('Categories it cooks')} <span className="dk-muted">({dialog.categories.length})</span></strong>
              {data.categories.length > 8 && <SearchInput value={catSearch} onChange={setCatSearch} placeholder={tr('Search categories…')} />}
            </div>
            <div className="rk-pick">
              {data.categories.filter((c) => matchesQuery(catSearch, c.name)).map((c) => {
                const on = dialog.categories.some((x) => x.trim().toLowerCase() === c.name.trim().toLowerCase());
                const other = takenBy.get(c.name.trim().toLowerCase());
                const elsewhere = other && other.id !== dialog.id;
                return (
                  <label key={c.name || '—'} className={'rk-pick-row' + (on ? ' is-on' : '') + (elsewhere ? ' is-taken' : '')}>
                    <input type="checkbox" checked={on} disabled={!!elsewhere}
                      onChange={(e) => setDialog({ ...dialog, categories: e.target.checked ? dialog.categories.concat([c.name]) : dialog.categories.filter((x) => x.trim().toLowerCase() !== c.name.trim().toLowerCase()) })} />
                    <span className="rk-pick-name">{c.name || tr('No category')}</span>
                    <small>{elsewhere ? tr('at {name}', { name: other.name }) : c.items === 1 ? tr('1 dish') : tr('{n} dishes', { n: c.items })}</small>
                  </label>
                );
              })}
            </div>
            {formError && <div className="error-banner">{formError}</div>}
            <div className="dialog-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setDialog(null)} disabled={saving}>{tr('Cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={saving || !dialog.name.trim()}>{saving ? tr('Saving…') : dialog.id ? tr('Save') : tr('Add station')}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
