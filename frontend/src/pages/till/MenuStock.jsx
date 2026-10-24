import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/DashKit';
import { posFetch } from '../../lib/posApi';
import { money } from '../../lib/currency';
import { activeIntlLocale, msg, tr } from '../../lib/i18n.jsx';
import AddOnGroups from './AddOnGroups';
import ComboEditor from './Combos';
import { comboBodyOf, comboDraftOf } from './comboDraft';
import { ALLERGENS, allergenIcon, allergenWords } from './tillService';
import LabelSheet from '../../components/LabelSheet';
import { saveFile } from '../../lib/saveFile';

// The menu and the stock, kept from the till (restaurantTillMenu.service.js):
// MenuTab in the till settings, for a manager — add a dish, change its
// price, sizes and category, take it off the till for now, remove it, and
// say whether it counts its stock; StockTab — what is left of each counted
// dish or drink, of the supplies and the ingredients, counted, received,
// thrown away, with each one's history. StockTab also opens from the till
// for whoever's role may count the stock (no manager PIN then).

function emptyItem(category) { return { name: '', category: category || '', price: '', active: true, trackStock: false, stockQty: '', lowStock: '', variations: [], allergens: [], sku: '', description: '', itemType: 'Prepared food and beverage', containsAlcohol: null, combo: [] }; }
// Square's item types (backend restaurantTillMenu ITEM_TYPES): the item library downloads in its layout.
const ITEM_TYPES = [['Prepared food and beverage', msg('Prepared food and drink')], ['Physical good', msg('Physical good')], ['Service', msg('Service')], ['Digital', msg('Digital')], ['Event', msg('Event')], ['Donation', msg('Donation')], ['Membership', msg('Membership')]];

export function MenuTab({ token, pin, onFail }) {
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [edit, setEdit] = useState(null); // the dish being added or changed
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const [view, setView] = useState('dishes'); // 'dishes' | 'addons' (till/AddOnGroups.jsx)
  const [labels, setLabels] = useState(false); // price labels with allergens (components/LabelSheet.jsx)
  const call = useCallback((body) => posFetch('POST', '/pos/settings/menu', token, { managerPin: pin || undefined, ...body }), [token, pin]);
  useEffect(() => { call({ action: 'list' }).then(setData).catch(onFail); }, [call, onFail]);
  const shown = useMemo(() => {
    if (!data) return [];
    const s = q.trim().toLowerCase();
    return data.items.filter((i) => (!cat || i.category === cat) && (!s || i.name.toLowerCase().includes(s)));
  }, [data, q, cat]);
  function open(i) {
    setFlash(null);
    setEdit(i ? { ...i, price: String(i.price), stockQty: '', lowStock: i.trackStock ? String(i.lowStock) : '', variations: i.variations.map((v) => ({ ...v, price: String(v.price) })), combo: comboDraftOf(i.combo) } : emptyItem(cat));
  }
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const d = await call({ action: 'save', item: { ...edit, price: Number(edit.price), lowStock: edit.lowStock === '' ? 0 : Number(edit.lowStock), stockQty: edit.stockQty === '' ? undefined : Number(edit.stockQty), combo: comboBodyOf(edit.combo) } });
      setData(d); setEdit(null); setFlash(edit.id ? tr('{name} saved. The till shows it now.', { name: edit.name }) : tr('{name} added to the menu.', { name: edit.name }));
    } catch (err) { onFail(err); } finally { setBusy(false); }
  }
  async function remove() {
    if (!window.confirm(tr('Remove {name} from the menu for good? Past sales keep its name. To hide it for now, turn off "On the till" instead.', { name: edit.name }))) return;
    setBusy(true);
    try { setData(await call({ action: 'remove', id: edit.id })); setFlash(tr('{name} removed.', { name: edit.name })); setEdit(null); } catch (err) { onFail(err); } finally { setBusy(false); }
  }
  function setVar(i, p) { setEdit({ ...edit, variations: edit.variations.map((v, k) => (k === i ? { ...v, ...p } : v)) }); }
  // The whole menu, laid out exactly like Square's item library (an .xlsx of the same sheets and columns).
  async function downloadLibrary() {
    setBusy(true);
    try { saveFile(await posFetch('POST', '/pos/settings/export', token, { managerPin: pin || undefined, kind: 'catalog' })); }
    catch (err) { onFail(err); } finally { setBusy(false); }
  }
  if (!data) return <section className="ts-sec"><p className="dk-muted">{tr('Loading…')}</p></section>;
  const viewSwitch = (
    <div className="dk-segment ts-mn-view" role="tablist">
      <button type="button" role="tab" aria-selected={view === 'dishes'} className={view === 'dishes' ? 'is-on' : ''} onClick={() => setView('dishes')}>{tr('Dishes')} {data.items.length}</button>
      <button type="button" role="tab" aria-selected={view === 'addons'} className={view === 'addons' ? 'is-on' : ''} onClick={() => setView('addons')}>✚ {tr('Add-ons')} {(data.groups || []).length}</button>
    </div>
  );
  if (view === 'addons' && !edit) {
    return (
      <>
        <div className="ts-mn-viewbar">{viewSwitch}</div>
        {flash && <div className="ts-flash" role="status"><Icon name="check" />{flash}</div>}
        <AddOnGroups data={data} call={call} onData={setData} onFail={onFail} onFlash={setFlash} />
      </>
    );
  }

  if (edit) {
    const startCounting = edit.trackStock && !(data.items.find((i) => i.id === edit.id) || {}).trackStock;
    return (
      <form className="ts-sec ts-mn-edit" onSubmit={save}>
        <button type="button" className="pos-link ts-back" onClick={() => setEdit(null)}>← {tr('Back to the menu')}</button>
        <h3>{edit.id ? edit.name : tr('A new dish')}</h3>
        <div className="ts-mn-grid">
          <div className="field"><label htmlFor="mn-name">{tr('Name')}</label><input id="mn-name" className="input" required maxLength={100} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
          <div className="field">
            <label htmlFor="mn-cat">{tr('Category')}</label>
            <input id="mn-cat" className="input" list="mn-cats" maxLength={40} value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })} placeholder={tr('e.g. Grill, Drinks')} />
            <datalist id="mn-cats">{data.categories.map((c) => <option key={c} value={c} />)}</datalist>
          </div>
          <div className="field"><label htmlFor="mn-price">{tr('Price')}</label><input id="mn-price" className="input" type="number" min="0" step="0.01" inputMode="decimal" required value={edit.price} onChange={(e) => setEdit({ ...edit, price: e.target.value })} /></div>
        </div>
        <details className="ts-mn-catalog" open={!!(edit.sku || edit.description)}>
          <summary><span aria-hidden="true">🏷️</span> {tr('Item library details')}<small>{tr('SKU, description and item type, as in Square\'s item library')}</small></summary>
          <div className="ts-mn-grid">
            <div className="field"><label htmlFor="mn-sku">{tr('SKU')}</label><input id="mn-sku" className="input" maxLength={80} value={edit.sku || ''} onChange={(e) => setEdit({ ...edit, sku: e.target.value })} placeholder={tr('e.g. GRL-001')} /></div>
            <div className="field"><label htmlFor="mn-type">{tr('Item type')}</label>
              <select id="mn-type" className="input" value={edit.itemType || ''} onChange={(e) => setEdit({ ...edit, itemType: e.target.value })}>
                <option value="">—</option>
                {ITEM_TYPES.map(([k, label]) => <option key={k} value={k}>{tr(label)}</option>)}
              </select>
            </div>
            <div className="field"><label htmlFor="mn-alc">{tr('Contains alcohol')}</label>
              <select id="mn-alc" className="input" value={edit.containsAlcohol == null ? '' : edit.containsAlcohol ? 'Y' : 'N'} onChange={(e) => setEdit({ ...edit, containsAlcohol: e.target.value === '' ? null : e.target.value === 'Y' })}>
                <option value="">—</option><option value="Y">{tr('Yes')}</option><option value="N">{tr('No')}</option>
              </select>
            </div>
          </div>
          <div className="field"><label htmlFor="mn-desc">{tr('Description')}</label><textarea id="mn-desc" className="input" rows={2} maxLength={4000} value={edit.description || ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} placeholder={tr('What it is, for the website and the item library')} /></div>
        </details>
        {(data.groups || []).some((g) => edit.id && g.itemIds.includes(edit.id)) && (
          <p className="ts-ao-on">✚ {tr('Add-ons: {names}', { names: data.groups.filter((g) => g.itemIds.includes(edit.id)).map((g) => g.name).join(', ') })}</p>
        )}
        <div className="ts-mn-sizes">
          <span className="ts-label">{tr('Sizes (optional)')}</span>
          <small className="dk-muted">{tr('A dish with sizes is sold at each size\'s price, e.g. Small and Large.')}</small>
          {edit.variations.map((v, i) => !v.remove && (
            <div key={v.id || 'n' + i} className="ts-mn-size">
              <input className="input" maxLength={60} value={v.name} onChange={(e) => setVar(i, { name: e.target.value })} placeholder={tr('Size, e.g. Large')} aria-label={tr('Size')} />
              <input className="input" type="number" min="0" step="0.01" inputMode="decimal" value={v.price} onChange={(e) => setVar(i, { price: e.target.value })} aria-label={tr('Price')} />
              <input className="input ts-mn-sku" maxLength={80} value={v.sku || ''} onChange={(e) => setVar(i, { sku: e.target.value })} placeholder={tr('SKU')} aria-label={tr('SKU of {size}', { size: v.name || tr('this size') })} />
              <button type="button" className="pos-link is-bad" onClick={() => (v.id ? setVar(i, { remove: true }) : setEdit({ ...edit, variations: edit.variations.filter((x, k) => k !== i) }))}>{tr('Remove')}</button>
            </div>
          ))}
          <button type="button" className="pos-link" onClick={() => setEdit({ ...edit, variations: edit.variations.concat([{ name: '', price: edit.price }]) })}>+ {tr('Add a size')}</button>
        </div>
        {/* A dish that is a choice in another combo cannot be one itself. */}
        {!data.items.some((i) => (i.combo || []).some((s) => s.options.some((o) => o.menuItemId === edit.id))) && (
          <ComboEditor slots={edit.combo || []} onChange={(combo) => setEdit({ ...edit, combo })} items={data.items} selfId={edit.id} price={edit.price} />
        )}
        <div className="ts-mn-allergens">
          <span className="ts-label">{tr('Allergens')}</span>
          <small className="dk-muted">{tr('What it has. The till warns before adding it to an order with an allergy alert; the kitchen and the website show it.')}</small>
          <div className="ts-chips">
            {ALLERGENS.map(([k, icon, label]) => {
              const on = (edit.allergens || []).includes(k);
              return <button key={k} type="button" aria-pressed={on} className={'ts-chip' + (on ? ' is-on is-allergen' : '')} onClick={() => setEdit({ ...edit, allergens: on ? edit.allergens.filter((x) => x !== k) : (edit.allergens || []).concat([k]) })}><span aria-hidden="true">{icon}</span> {tr(label)}</button>;
            })}
          </div>
        </div>
        <button type="button" role="switch" aria-checked={edit.active} className="ts-toggle-row" onClick={() => setEdit({ ...edit, active: !edit.active })}>
          <span><strong>{tr('On the till')}</strong><small>{tr('Off: hidden from the till for now (sold out for the day, out of season), kept on the menu.')}</small></span>
          <span className={'ts-switch' + (edit.active ? ' is-on' : '')} aria-hidden="true"><i /></span>
        </button>
        <button type="button" role="switch" aria-checked={edit.trackStock} className="ts-toggle-row" onClick={() => setEdit({ ...edit, trackStock: !edit.trackStock })}>
          <span><strong>{tr('Count its stock')}</strong><small>{tr('For drinks and things counted one by one. Each sale takes it off; when new stock comes in, enter it under Stock. The till shows what is left and stops at none.')}</small></span>
          <span className={'ts-switch' + (edit.trackStock ? ' is-on' : '')} aria-hidden="true"><i /></span>
        </button>
        {edit.trackStock && (
          <div className="ts-mn-grid">
            {startCounting && <div className="field"><label htmlFor="mn-qty">{tr('How many are there now')}</label><input id="mn-qty" className="input" type="number" min="0" step="1" required value={edit.stockQty} onChange={(e) => setEdit({ ...edit, stockQty: e.target.value })} /></div>}
            <div className="field"><label htmlFor="mn-low">{tr('Warn when this few are left')}</label><input id="mn-low" className="input" type="number" min="0" step="1" value={edit.lowStock} onChange={(e) => setEdit({ ...edit, lowStock: e.target.value })} placeholder="0" /></div>
          </div>
        )}
        <div className="ts-mn-actions">
          {edit.id && <button type="button" className="pos-link is-bad" disabled={busy} onClick={remove}>{tr('Remove from the menu')}</button>}
          <button type="button" className="btn btn-secondary" onClick={() => setEdit(null)}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? tr('Saving…') : edit.id ? tr('Save dish') : tr('Add to the menu')}</button>
        </div>
      </form>
    );
  }

  const cats = data.categories;
  return (
    <section className="ts-sec ts-mn">
      <div className="ts-mn-viewbar">{viewSwitch}</div>
      <div className="ts-mn-tools">
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Find a dish…')} aria-label={tr('Find a dish…')} />
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={downloadLibrary} title={tr('The same sheets and columns as Square\'s item library')}>⬇ {tr('Item library (Square format)')}</button>
        <button type="button" className="btn btn-secondary" disabled={!shown.length} onClick={() => setLabels(true)} title={tr('Price labels with allergens, for the dishes shown')}>🏷️ {tr('Labels')}</button>
        <button type="button" className="btn btn-primary" onClick={() => open(null)}><Icon name="spark" /> {tr('Add a dish')}</button>
      </div>
      {labels && (
        <LabelSheet title={cat ? tr('Labels: {category}', { category: cat }) : tr('Labels for the menu')} allergens onClose={() => setLabels(false)}
          labels={shown.filter((i) => i.active).flatMap((i) => {
            const alg = (i.allergens || []).map((k) => allergenWords(k, tr));
            return i.variations.length
              ? i.variations.map((v, k) => ({ key: i.id + ':' + k, name: i.name, sub: v.name, price: v.price, code: v.sku || i.sku || '', allergens: alg, qty: 1 }))
              : [{ key: i.id, name: i.name, price: i.price, code: i.sku || '', allergens: alg, qty: 1 }];
          })} />
      )}
      <div className="ts-chips ts-mn-cats" role="radiogroup" aria-label={tr('Category')}>
        <button type="button" role="radio" aria-checked={!cat} className={!cat ? 'is-on' : ''} onClick={() => setCat('')}>{tr('Everything')} {data.items.length}</button>
        {cats.map((c) => <button key={c} type="button" role="radio" aria-checked={cat === c} className={cat === c ? 'is-on' : ''} onClick={() => setCat(c)}>{c}</button>)}
      </div>
      {flash && <div className="ts-flash" role="status"><Icon name="check" />{flash}</div>}
      {!shown.length ? <div className="dk-empty"><Icon name="info" /><p>{tr('No dish matches.')}</p></div> : (
        <ul className="ts-mn-list">
          {shown.map((i) => (
            <li key={i.id} className={i.active ? '' : 'is-off'}>
              <button type="button" className="ts-mn-row" onClick={() => open(i)}>
                <span className="ts-mn-pic" aria-hidden="true">{i.thumbUrl ? <img src={i.thumbUrl} alt="" loading="lazy" /> : i.name.replace(/^zq\s+/i, '').slice(0, 1).toUpperCase()}</span>
                <span className="ts-mn-main">
                  <strong>{i.name}{(i.combo || []).length > 0 && <span className="cb-tag">🍱 {tr('Combo')}</span>}</strong>
                  <small>{[i.category, i.sku ? tr('SKU {sku}', { sku: i.sku }) : null, i.variations.length ? tr('{n} sizes', { n: i.variations.length }) : null, i.sold30 ? tr('{n} sold in 30 days', { n: i.sold30 }) : null, !i.active ? tr('off the till') : null].filter(Boolean).join(' · ')}</small>
                </span>
                {i.trackStock && <span className={'ts-mn-stock' + (i.stockQty <= 0 ? ' is-out' : i.stockQty <= i.lowStock ? ' is-low' : '')}>{i.stockQty <= 0 ? tr('None left') : tr('{n} left', { n: i.stockQty })}</span>}
                {(i.allergens || []).length > 0 && <span className="ts-mn-alg" title={tr('Allergens')}>{i.allergens.map((k) => <i key={k}>{allergenIcon(k)}</i>)}</span>}
                <b className="ts-mn-price">{i.variations.length ? i.variations.map((v) => money(v.price)).join(' / ') : money(i.price)}</b>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const MOVE_KINDS = [['count', msg('Count')], ['received', msg('Came in')], ['wasted', msg('Thrown away')], ['used', msg('Used')]];
const MOVE_LABEL = { count: msg('Counted'), received: msg('Came in'), wasted: msg('Thrown away'), used: msg('Used'), sold: msg('Sold'), voided: msg('Sale voided') };
const GROUPS = [['menu', msg('Dishes and drinks')], ['supplies', msg('Supplies')], ['ingredients', msg('Ingredients')]];

export function StockTab({ token, pin, onFail }) {
  const [data, setData] = useState(null);
  const [group, setGroup] = useState('menu');
  const [open, setOpen] = useState(null); // `${type}:${id}`
  const [kind, setKind] = useState('count');
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const [hist, setHist] = useState(null);
  const [busy, setBusy] = useState(false);
  const call = useCallback((body) => posFetch('POST', '/pos/stock', token, { managerPin: pin || undefined, ...body }), [token, pin]);
  useEffect(() => { call({ action: 'list' }).then(setData).catch(onFail); }, [call, onFail]);
  async function pick(it) {
    const key = it.type + ':' + it.id;
    if (open === key) { setOpen(null); return; }
    setOpen(key); setKind('count'); setQty(''); setNote(''); setHist(null);
    try { setHist(await call({ action: 'history', type: it.type, id: it.id })); } catch (err) { onFail(err); }
  }
  async function move(it) {
    setBusy(true);
    try {
      const d = await call({ action: 'move', type: it.type, id: it.id, kind, qty: Number(qty), note });
      setData(d); setQty(''); setNote('');
      setHist(await call({ action: 'history', type: it.type, id: it.id }));
    } catch (err) { onFail(err); } finally { setBusy(false); }
  }
  if (!data) return <section className="ts-sec"><p className="dk-muted">{tr('Loading…')}</p></section>;
  const list = data[group];
  const lowCount = (k) => data[k].filter((i) => i.isLow).length;
  return (
    <section className="ts-sec ts-st">
      <p className="dk-muted">{tr('What is left of each thing counted. A sale takes counted dishes and drinks off by itself; when new stock comes in, or after counting, enter it here.')}</p>
      <div className="dk-segment pos-seg ts-st-groups" role="radiogroup" aria-label={tr('Show')}>
        {GROUPS.map(([k, label]) => (
          <button key={k} type="button" role="radio" aria-checked={group === k} className={group === k ? 'is-on' : ''} onClick={() => { setGroup(k); setOpen(null); }}>
            {tr(label)}<span className={'pos-seg-n' + (lowCount(k) ? ' is-low' : '')}>{lowCount(k) ? tr('{n} low', { n: lowCount(k) }) : data[k].length}</span>
          </button>
        ))}
      </div>
      {!list.length ? (
        <div className="dk-empty"><Icon name="layers" /><p>{group === 'menu' ? tr('No dish counts its stock yet. Turn on "Count its stock" on a dish in Menu.') : tr('Nothing here yet. They are added in the app under Restaurants → Stock.')}</p></div>
      ) : (
        <ul className="ts-st-list">
          {list.map((it) => {
            const key = it.type + ':' + it.id;
            return (
              <li key={key} className={(it.qty <= 0 ? 'is-out' : it.isLow ? 'is-low' : '') + (open === key ? ' is-open' : '')}>
                <button type="button" className="ts-st-row" aria-expanded={open === key} onClick={() => pick(it)}>
                  <span className="ts-st-main">
                    <strong>{it.name}</strong>
                    <small>{[it.category, it.held ? tr('{n} on open orders', { n: it.held }) : null, it.lastCounted ? tr('last counted {date}', { date: new Date(it.lastCounted.at).toLocaleDateString(activeIntlLocale(), { day: 'numeric', month: 'short' }) }) : tr('never counted'), it.expiryDate ? tr('expires {date}', { date: it.expiryDate }) : null].filter(Boolean).join(' · ')}</small>
                  </span>
                  {it.isLow && <span className="ts-st-flag">{it.qty <= 0 ? tr('None left') : tr('Low')}</span>}
                  <b className="ts-st-qty">{it.qty}<small>{it.unit === 'each' ? '' : ' ' + it.unit}</small></b>
                </button>
                {open === key && (
                  <div className="ts-st-detail">
                    <form className="ts-st-form" onSubmit={(e) => { e.preventDefault(); move(it); }}>
                      <div className="ts-chips" role="radiogroup" aria-label={tr('What happened')}>
                        {MOVE_KINDS.map(([k, label]) => <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'is-on' : ''} onClick={() => setKind(k)}>{tr(label)}</button>)}
                      </div>
                      <label className="ts-st-qty-in"><span>{kind === 'count' ? tr('How many are there') : tr('How many')}</span>
                        <input className="input" type="number" min="0" step="any" inputMode="decimal" required value={qty} onChange={(e) => setQty(e.target.value)} autoFocus /></label>
                      <input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder={tr('Note (optional), e.g. the supplier')} aria-label={tr('Note')} />
                      <button type="submit" className="btn btn-primary tl-btn" disabled={busy || qty === ''}>{tr('Save')}</button>
                    </form>
                    {kind !== 'count' && qty !== '' && <p className="ts-hint">{tr('{name} goes from {from} to {to}.', { name: it.name, from: it.qty, to: Math.round((it.qty + (kind === 'received' ? 1 : -1) * Number(qty)) * 100) / 100 })}</p>}
                    {hist && (
                      <ol className="ts-st-hist">
                        {hist.slice(0, 12).map((h) => (
                          <li key={h.id} className={'is-' + h.kind}>
                            <span>{MOVE_LABEL[h.kind] ? tr(MOVE_LABEL[h.kind]) : h.kind}{h.orderNo ? ' · ' + h.orderNo : ''}{h.note ? ' · ' + h.note : ''}<small>{[new Date(h.at).toLocaleString(activeIntlLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }), h.by].filter(Boolean).join(' · ')}</small></span>
                            <b>{h.delta > 0 ? '+' : ''}{h.delta}</b><em>{h.after}</em>
                          </li>
                        ))}
                        {!hist.length && <li className="dk-muted">{tr('No history yet.')}</li>}
                      </ol>
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
