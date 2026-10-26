import { useCallback, useEffect, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { msg, tr } from '../../lib/i18n.jsx';
import { menuBoardUrl } from './customerScreenLink';
import './fourteenth.css';

// Menu boards in the back office (backend restaurantMenuBoards, migration
// 0195; the board itself is pages/MenuBoardPage.jsx): a TV opened at
// /menu-board shows 6 numbers; typed here with what it shows, it shows the
// menu as the till sells it — happy-hour prices, sold out greyed — and,
// if asked, the orders ready for pickup beside it.

const THEMES = { night: ['🌙', msg('Night')], bamboo: ['🎋', msg('Bamboo')], light: ['☀️', msg('Light')] };
const LAYOUTS = { grid: ['▦', msg('Tiles with photos')], list: ['☰', msg('A price list')] };
function blank() { return { categories: [], title: '', layout: 'grid', theme: 'night', rotate: 12, photos: true, ready: false, prices: true }; }

function Options({ o, set, categories }) {
  const toggle = (c) => set({ ...o, categories: o.categories.indexOf(c) >= 0 ? o.categories.filter((x) => x !== c) : o.categories.concat([c]) });
  return (
    <div className="mbs-opts">
      <label><span>{tr('Title on the board (optional)')}</span><input className="input" maxLength={60} value={o.title} onChange={(e) => set({ ...o, title: e.target.value })} placeholder={tr('e.g. Today at the grill')} /></label>
      <div className="mbs-row"><span>{tr('What it shows')}</span>
        <div className="mbs-chips">
          <button type="button" className={!o.categories.length ? 'is-on' : ''} onClick={() => set({ ...o, categories: [] })}>{tr('The whole menu')}</button>
          {categories.map((c) => <button key={c} type="button" aria-pressed={o.categories.indexOf(c) >= 0} className={o.categories.indexOf(c) >= 0 ? 'is-on' : ''} onClick={() => toggle(c)}>{c}</button>)}
        </div>
      </div>
      <div className="mbs-row"><span>{tr('Look')}</span>
        <div className="mbs-chips">{Object.keys(LAYOUTS).map((k) => <button key={k} type="button" className={o.layout === k ? 'is-on' : ''} onClick={() => set({ ...o, layout: k })}>{LAYOUTS[k][0]} {tr(LAYOUTS[k][1])}</button>)}</div>
        <div className="mbs-chips">{Object.keys(THEMES).map((k) => <button key={k} type="button" className={'mbs-theme is-' + k + (o.theme === k ? ' is-on' : '')} onClick={() => set({ ...o, theme: k })}>{THEMES[k][0]} {tr(THEMES[k][1])}</button>)}</div>
      </div>
      <div className="mbs-row"><span>{tr('A page stays')}</span>
        <div className="mbs-chips">{[8, 12, 20, 30].map((s) => <button key={s} type="button" className={o.rotate === s ? 'is-on' : ''} onClick={() => set({ ...o, rotate: s })}>{tr('{n} s', { n: s })}</button>)}</div>
      </div>
      <div className="mbs-switches">
        {[['photos', tr('Photos of the dishes')], ['prices', tr('Prices')], ['ready', tr('Orders ready for pickup beside the menu')]].map(([k, label]) => (
          <button key={k} type="button" role="switch" aria-checked={!!o[k]} className="ts-toggle-row" onClick={() => set({ ...o, [k]: !o[k] })}>
            <span><strong>{label}</strong></span><span className={'ts-switch' + (o[k] ? ' is-on' : '')} aria-hidden="true"><i /></span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function MenuBoardsTab({ token, pin, onFail }) {
  const [data, setData] = useState(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [opts, setOpts] = useState(blank);
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const call = useCallback((body) => posFetch('POST', '/pos/settings/menu-boards', token, { managerPin: pin || undefined, ...body }), [token, pin]);
  useEffect(() => { call({ action: 'list' }).then(setData).catch(onFail); }, [call, onFail]);
  async function run(body, done) {
    setBusy(true); setFlash(null);
    try { setData(await call(body)); if (done) done(); } catch (e) { onFail(e); } finally { setBusy(false); }
  }
  if (!data) return <section className="ts-sec"><p className="dk-muted">{tr('Loading…')}</p></section>;
  return (
    <section className="ts-sec mbs">
      {flash && <div className="ts-flash" role="status">{flash}</div>}
      <div className="mbs-how">
        <span className="mbs-tv" aria-hidden="true"><i>🍔</i><i>🥤</i><i>🍰</i></span>
        <div>
          <strong>{tr('Your menu on a TV')}</strong>
          <p>{tr('Open this on the TV\'s browser: it shows 6 numbers. Type them here with what it shows. Prices change by themselves in happy hour, and sold-out dishes grey out.')}</p>
          <code>{menuBoardUrl()}</code>
        </div>
      </div>
      {data.boards.map((b) => (
        <article key={b.id} className="mbs-board">
          <header>
            <span className={'mbs-dot' + (b.online ? ' is-on' : '')} aria-hidden="true" />
            <div><strong>{b.name}</strong><small>{b.online ? tr('On now') : tr('Not seen for a while')} · {b.options.categories.length ? b.options.categories.join(', ') : tr('The whole menu')} · {tr(LAYOUTS[b.options.layout][1])} · {THEMES[b.options.theme][0]}</small></div>
            <button type="button" className="pos-link" onClick={() => setEdit(edit && edit.id === b.id ? null : { id: b.id, name: b.name, options: b.options })}>{tr('Change')}</button>
            <button type="button" className="pos-link is-bad" disabled={busy} onClick={() => { if (window.confirm(tr('Take "{name}" off? The TV shows a new code.', { name: b.name }))) run({ action: 'remove', id: b.id }); }}>{tr('Take it off')}</button>
          </header>
          {edit && edit.id === b.id && (
            <form onSubmit={(e) => { e.preventDefault(); run({ action: 'save', id: b.id, name: edit.name, options: edit.options }, () => { setEdit(null); setFlash(tr('Saved: the board shows it in a moment.')); }); }}>
              <label><span>{tr('Name')}</span><input className="input" maxLength={40} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
              <Options o={edit.options} set={(o) => setEdit({ ...edit, options: o })} categories={data.categories} />
              <button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save')}</button>
            </form>
          )}
        </article>
      ))}
      <form className="mbs-pair" onSubmit={(e) => { e.preventDefault(); run({ action: 'pair', code, name: name || tr('Menu board'), options: opts }, () => { setCode(''); setName(''); setOpts(blank()); setFlash('📺 ' + tr('The board now shows your menu.')); }); }}>
        <h3>＋ {tr('Add a menu board')}</h3>
        <div className="mbs-pair-top">
          <label><span>{tr('The 6 numbers on the TV')}</span><input className="input mbs-code" inputMode="numeric" maxLength={7} value={code} onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))} placeholder="123 456" /></label>
          <label><span>{tr('Name')}</span><input className="input" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('e.g. TV by the bar')} /></label>
        </div>
        <Options o={opts} set={setOpts} categories={data.categories} />
        <button type="submit" className="btn btn-primary" disabled={busy || code.replace(/\D/g, '').length !== 6}>📺 {tr('Show the menu on it')}</button>
      </form>
    </section>
  );
}
