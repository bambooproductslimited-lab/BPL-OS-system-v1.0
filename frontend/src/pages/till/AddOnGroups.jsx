import { useMemo, useState } from 'react';
import { Icon } from '../../components/DashKit';
import { money } from '../../lib/currency';
import { tr } from '../../lib/i18n.jsx';

// Add-ons in the till settings' Menu (till/MenuStock.jsx; backend
// restaurantTillMenu saveGroup): a group of choices ("Pick a side", "Extras")
// with how many to pick, each choice with its price, and the dishes that
// take it. The till asks for them when one of those dishes is tapped.

function ruleWords(g) {
  const min = Number(g.minPick) || 0, max = g.maxPick === '' || g.maxPick == null ? null : Number(g.maxPick);
  if (min && max && min === max) return tr('Pick {n}', { n: min });
  if (min && max) return tr('Pick {a} to {b}', { a: min, b: max });
  if (min) return tr('Pick at least {n}', { n: min });
  if (max) return tr('Up to {n}', { n: max });
  return tr('Optional');
}
function blank() { return { name: '', minPick: '0', maxPick: '', active: true, options: [{ name: '', price: '0' }], itemIds: [] }; }

export default function AddOnGroups({ data, call, onData, onFail, onFlash }) {
  const [edit, setEdit] = useState(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const items = data.items;
  const shownItems = useMemo(() => {
    const s = q.trim().toLowerCase();
    return items.filter((i) => !s || i.name.toLowerCase().includes(s) || (i.category || '').toLowerCase().includes(s));
  }, [items, q]);
  const groups = data.groups || [];

  function open(g) {
    setQ('');
    setEdit(g ? { ...g, minPick: String(g.minPick), maxPick: g.maxPick == null ? '' : String(g.maxPick), options: g.options.map((o) => ({ ...o, price: String(o.price) })), itemIds: g.itemIds.slice() } : blank());
  }
  function setOpt(i, p) { setEdit({ ...edit, options: edit.options.map((o, k) => (k === i ? { ...o, ...p } : o)) }); }
  function toggleItem(id) { setEdit({ ...edit, itemIds: edit.itemIds.includes(id) ? edit.itemIds.filter((x) => x !== id) : edit.itemIds.concat([id]) }); }
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const d = await call({ action: 'saveGroup', group: { ...edit, minPick: Number(edit.minPick) || 0, maxPick: edit.maxPick === '' ? null : Number(edit.maxPick), options: edit.options.map((o) => ({ ...o, price: Number(o.price) || 0 })) } });
      onData(d); onFlash(tr('{name} saved. The till asks for them on its dishes now.', { name: edit.name })); setEdit(null);
    } catch (err) { onFail(err); } finally { setBusy(false); }
  }
  async function remove() {
    if (!window.confirm(tr('Remove the add-ons {name}? Past sales keep what was picked.', { name: edit.name }))) return;
    setBusy(true);
    try { onData(await call({ action: 'removeGroup', id: edit.id })); onFlash(tr('{name} removed.', { name: edit.name })); setEdit(null); } catch (err) { onFail(err); } finally { setBusy(false); }
  }

  if (edit) {
    const cats = Array.from(new Set(shownItems.map((i) => i.category)));
    return (
      <form className="ts-sec ts-mn-edit ts-ao-edit" onSubmit={save}>
        <button type="button" className="pos-link ts-back" onClick={() => setEdit(null)}>← {tr('Back to the add-ons')}</button>
        <h3>{edit.id ? edit.name : tr('New add-ons')}</h3>
        <div className="ts-mn-grid">
          <div className="field"><label htmlFor="ao-name">{tr('Name')}</label><input id="ao-name" className="input" required maxLength={60} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder={tr('e.g. Pick a side, Extras')} /></div>
          <div className="field"><label htmlFor="ao-min">{tr('Must pick at least')}</label><input id="ao-min" className="input" type="number" min="0" step="1" value={edit.minPick} onChange={(e) => setEdit({ ...edit, minPick: e.target.value })} /></div>
          <div className="field"><label htmlFor="ao-max">{tr('At most (empty: any)')}</label><input id="ao-max" className="input" type="number" min="1" step="1" value={edit.maxPick} onChange={(e) => setEdit({ ...edit, maxPick: e.target.value })} placeholder={tr('any')} /></div>
        </div>
        <p className="ts-ao-rule">{ruleWords(edit)}</p>
        <div className="ts-mn-sizes">
          <span className="ts-label">{tr('Choices')}</span>
          <small className="dk-muted">{tr('Each with what it adds to the price (0 for free). On the till each can also be asked for as no, extra or on the side.')}</small>
          {edit.options.map((o, i) => !o.remove && (
            <div key={o.id || 'n' + i} className="ts-mn-size ts-ao-opt">
              <input className="input" maxLength={60} value={o.name} onChange={(e) => setOpt(i, { name: e.target.value })} placeholder={tr('e.g. Banku, Fried egg')} aria-label={tr('Choice')} />
              <input className="input" type="number" min="0" step="0.01" inputMode="decimal" value={o.price} onChange={(e) => setOpt(i, { price: e.target.value })} aria-label={tr('Adds')} />
              <label className="ts-bill-check"><input type="checkbox" checked={o.active !== false} onChange={(e) => setOpt(i, { active: e.target.checked })} />{tr('On')}</label>
              <button type="button" className="pos-link is-bad" onClick={() => (o.id ? setOpt(i, { remove: true }) : setEdit({ ...edit, options: edit.options.filter((x, k) => k !== i) }))}>{tr('Remove')}</button>
            </div>
          ))}
          <button type="button" className="pos-link" onClick={() => setEdit({ ...edit, options: edit.options.concat([{ name: '', price: '0' }]) })}>+ {tr('A choice')}</button>
        </div>
        <div className="ts-ao-items">
          <span className="ts-label">{tr('On these dishes ({n})', { n: edit.itemIds.length })}</span>
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('Find a dish…')} aria-label={tr('Find a dish…')} />
          <div className="ts-ao-list">
            {cats.map((c) => (
              <div key={c} className="ts-ao-cat">
                <div className="ts-ao-cat-h">
                  <b>{c}</b>
                  <button type="button" className="pos-link" onClick={() => {
                    const ids = shownItems.filter((i) => i.category === c).map((i) => i.id);
                    const all = ids.every((id) => edit.itemIds.includes(id));
                    setEdit({ ...edit, itemIds: all ? edit.itemIds.filter((x) => !ids.includes(x)) : Array.from(new Set(edit.itemIds.concat(ids))) });
                  }}>{shownItems.filter((i) => i.category === c).every((i) => edit.itemIds.includes(i.id)) ? tr('None') : tr('All')}</button>
                </div>
                {shownItems.filter((i) => i.category === c).map((i) => (
                  <label key={i.id} className={'ts-ao-item' + (edit.itemIds.includes(i.id) ? ' is-on' : '')}>
                    <input type="checkbox" checked={edit.itemIds.includes(i.id)} onChange={() => toggleItem(i.id)} />{i.name}
                  </label>
                ))}
              </div>
            ))}
          </div>
        </div>
        <button type="button" role="switch" aria-checked={edit.active} className="ts-toggle-row" onClick={() => setEdit({ ...edit, active: !edit.active })}>
          <span><strong>{tr('In use')}</strong><small>{tr('Off: the till stops asking for them, kept for later.')}</small></span>
          <span className={'ts-switch' + (edit.active ? ' is-on' : '')} aria-hidden="true"><i /></span>
        </button>
        <div className="ts-mn-actions">
          {edit.id && <button type="button" className="pos-link is-bad" disabled={busy} onClick={remove}>{tr('Remove the add-ons')}</button>}
          <button type="button" className="btn btn-secondary" onClick={() => setEdit(null)}>{tr('Cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? tr('Saving…') : tr('Save add-ons')}</button>
        </div>
      </form>
    );
  }

  return (
    <section className="ts-sec ts-ao">
      <div className="ts-mn-tools">
        <p className="dk-muted">{tr('Choices a dish asks for on the till, the website and the table\'s QR menu: a side to pick, extras that cost more.')}</p>
        <button type="button" className="btn btn-primary" onClick={() => open(null)}><Icon name="spark" /> {tr('New add-ons')}</button>
      </div>
      {!groups.length ? <div className="dk-empty"><Icon name="info" /><p>{tr('No add-ons yet. Make a group, e.g. "Pick a side" with rice, banku and plantain, and put it on the dishes that take it.')}</p></div> : (
        <ul className="ts-ao-groups is-plain">
          {groups.map((g) => (
            <li key={g.id} className={g.active ? '' : 'is-off'}>
              <button type="button" className="ts-ao-group" onClick={() => open(g)}>
                <span className="ts-ao-ico" aria-hidden="true">✚</span>
                <span className="ts-mn-main">
                  <strong>{g.name}</strong>
                  <small>{[ruleWords(g), g.itemIds.length === 1 ? tr('on 1 dish') : tr('on {n} dishes', { n: g.itemIds.length }), !g.active ? tr('not in use') : null].filter(Boolean).join(' · ')}</small>
                  <span className="ts-ao-opts">{g.options.map((o) => <em key={o.id} className={o.active ? '' : 'is-off'}>{o.name}{o.price > 0 ? ' +' + money(o.price) : ''}</em>)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
