import { useCallback, useEffect, useState } from 'react';
import { posFetch } from '../../lib/posApi';
import { activeIntlLocale, msg, tr } from '../../lib/i18n.jsx';
import './thirteenth.css';

// Opening and closing checklists (backend restaurantChecklists.service,
// migration 0194): on the till, today's lists — tap a thing done, type a
// reading (the fridge's temperature) — and who did each; in the back
// office, a manager writes the lists and sees the last two weeks.

const AT = [['open', '🌅', msg('Opening')], ['close', '🌙', msg('Closing')], ['any', '🕑', msg('Any time')]];
function atOf(k) { return AT.find((a) => a[0] === k) || AT[2]; }
function timeOf(iso) { return new Date(iso).toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' }); }
function rangeText(it) {
  const u = it.unit ? ' ' + it.unit : '';
  if (it.min != null && it.max != null) return tr('{min} to {max}', { min: it.min, max: it.max }) + u;
  if (it.min != null) return tr('at least {n}', { n: it.min }) + u;
  if (it.max != null) return tr('no more than {n}', { n: it.max }) + u;
  return '';
}

function Reading({ it, onSave, busy }) {
  const [v, setV] = useState(it.value != null ? String(it.value) : '');
  return (
    <form className="ckl-read" onSubmit={(e) => { e.preventDefault(); onSave(v); }}>
      <input className="input" type="number" step="any" inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} aria-label={it.text} placeholder="–" />
      {it.unit && <span className="ckl-unit">{it.unit}</span>}
      <button type="submit" className="btn btn-secondary" disabled={busy || v === ''}>{it.done ? tr('Update') : tr('Save')}</button>
    </form>
  );
}

export function ChecklistsDialog({ token, onClose }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  useEffect(() => {
    posFetch('GET', '/pos/checklists', token).then((d) => { setData(d); const first = d.lists.find((l) => !l.finished) || d.lists[0]; if (first) setOpen(first.id); }).catch((e) => setError(e.message));
  }, [token]);
  async function mark(l, it, body) {
    setBusy(l.id + it.key); setError(null);
    try { setData(await posFetch('POST', '/pos/checklists/mark', token, { checklistId: l.id, key: it.key, ...body })); } catch (e) { setError(e.message); } finally { setBusy(null); }
  }
  return (
    <div className="dialog-backdrop" onClick={() => onClose(data)}>
      <div className="dialog ckl" role="dialog" aria-modal="true" aria-labelledby="ckl-title" onClick={(e) => e.stopPropagation()}>
        <div className="ckl-head">
          <span className="ckl-head-art" aria-hidden="true">✅</span>
          <div><h2 id="ckl-title">{tr('Checklists')}</h2>
            <p>{!data ? tr('Loading…') : !data.lists.length ? tr('No checklists yet: a manager writes them in the back office.') : data.open ? tr('{n} still to finish today', { n: data.open }) : '🎉 ' + tr('All done today')}</p></div>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {data && data.lists.map((l, li) => {
          const [, icon, label] = atOf(l.at);
          const pct = l.total ? l.done / l.total : 0;
          const isOpen = open === l.id;
          return (
            <section key={l.id} className={'ckl-list' + (l.finished ? ' is-done' : '') + (l.bad ? ' is-bad' : '')} style={{ '--i': li }}>
              <button type="button" className="ckl-list-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : l.id)}>
                <span className="ckl-ring" style={{ '--p': pct }} aria-hidden="true"><b>{l.finished ? '✓' : l.done + '/' + l.total}</b></span>
                <span className="ckl-list-name"><strong>{l.name}</strong><small>{icon} {tr(label)}{l.finished ? ' · ' + tr('done by {name} at {time}', { name: l.finished.by, time: timeOf(l.finished.at) }) : ''}{l.bad ? ' · ⚠️ ' + (l.bad === 1 ? tr('1 reading out of range') : tr('{n} readings out of range', { n: l.bad })) : ''}</small></span>
                <span className="ckl-chev" aria-hidden="true">{isOpen ? '▴' : '▾'}</span>
              </button>
              {isOpen && (
                <ul className="ckl-items">
                  {l.items.map((it) => (
                    <li key={it.key} className={(it.done ? 'is-done' : '') + (it.bad ? ' is-bad' : '')}>
                      {it.kind === 'reading' ? <span className="ckl-box is-read" aria-hidden="true">🌡️</span>
                        : <button type="button" className="ckl-box" aria-pressed={!!it.done} disabled={busy === l.id + it.key} onClick={() => mark(l, it, { done: !it.done })} aria-label={it.text}>{it.done ? '✓' : ''}</button>}
                      <span className="ckl-text">
                        <strong>{it.text}</strong>
                        {it.kind === 'reading' && rangeText(it) && <small>{tr('Should be {range}', { range: rangeText(it) })}</small>}
                        {it.done && <small className="ckl-by">{it.kind === 'reading' ? (it.bad ? '⚠️ ' : '✓ ') + it.value + (it.unit ? ' ' + it.unit : '') + ' · ' : '✓ '}{it.by} · {timeOf(it.at)}</small>}
                      </span>
                      {it.kind === 'reading' && <Reading it={it} busy={busy === l.id + it.key} onSave={(v) => mark(l, it, { value: v })} />}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
        <div className="dialog-actions"><button type="button" className="btn btn-primary" onClick={() => onClose(data)}>{tr('Close')}</button></div>
      </div>
    </div>
  );
}

function blankItem() { return { text: '', kind: 'tick', unit: '', min: '', max: '' }; }

// The back office: the lists, and how the last two weeks went.
export function ChecklistsTab({ token, pin, onFail }) {
  const [data, setData] = useState(null);
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const call = useCallback((body) => posFetch('POST', '/pos/checklists/manage', token, { managerPin: pin || undefined, ...body }), [token, pin]);
  useEffect(() => { call({ action: 'list' }).then(setData).catch(onFail); }, [call, onFail]);
  async function run(body) {
    setBusy(true);
    try { setData(await call(body)); setEdit(null); } catch (e) { onFail(e); } finally { setBusy(false); }
  }
  function setItem(i, patch) { setEdit({ ...edit, items: edit.items.map((x, k) => (k === i ? { ...x, ...patch } : x)) }); }
  if (!data) return <section className="ts-sec"><p className="dk-muted">{tr('Loading…')}</p></section>;
  if (edit) {
    return (
      <form className="ts-sec ckl-edit" onSubmit={(e) => { e.preventDefault(); run({ action: 'save', list: { ...edit, items: edit.items.map((x) => ({ ...x, min: x.min === '' ? null : Number(x.min), max: x.max === '' ? null : Number(x.max) })) } }); }}>
        <button type="button" className="pos-link ts-back" onClick={() => setEdit(null)}>← {tr('Back to the checklists')}</button>
        <div className="ckl-edit-top">
          <div className="field"><label htmlFor="ckl-name">{tr('Name')}</label><input id="ckl-name" className="input" required maxLength={60} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder={tr('e.g. Opening the kitchen')} /></div>
          <div className="ts-chips" role="radiogroup" aria-label={tr('When')}>
            {AT.map(([k, icon, label]) => <button key={k} type="button" role="radio" aria-checked={edit.at === k} className={edit.at === k ? 'is-on' : ''} onClick={() => setEdit({ ...edit, at: k })}>{icon} {tr(label)}</button>)}
          </div>
        </div>
        <ol className="ckl-edit-items">
          {edit.items.map((it, i) => (
            <li key={i}>
              <input className="input" maxLength={140} value={it.text} onChange={(e) => setItem(i, { text: e.target.value })} placeholder={it.kind === 'reading' ? tr('e.g. Fridge 1 temperature') : tr('e.g. Gas on, no smell')} aria-label={tr('Thing {n}', { n: i + 1 })} />
              <div className="ts-chips">
                <button type="button" className={it.kind === 'tick' ? 'is-on' : ''} onClick={() => setItem(i, { kind: 'tick' })}>✓ {tr('Tick')}</button>
                <button type="button" className={it.kind === 'reading' ? 'is-on' : ''} onClick={() => setItem(i, { kind: 'reading' })}>🌡️ {tr('Reading')}</button>
              </div>
              {it.kind === 'reading' && (
                <div className="ckl-edit-range">
                  <input className="input" maxLength={12} value={it.unit || ''} onChange={(e) => setItem(i, { unit: e.target.value })} placeholder={tr('Unit, e.g. °C')} aria-label={tr('Unit')} />
                  <input className="input" type="number" step="any" value={it.min ?? ''} onChange={(e) => setItem(i, { min: e.target.value })} placeholder={tr('Lowest')} aria-label={tr('Lowest it may be')} />
                  <input className="input" type="number" step="any" value={it.max ?? ''} onChange={(e) => setItem(i, { max: e.target.value })} placeholder={tr('Highest')} aria-label={tr('Highest it may be')} />
                </div>
              )}
              <button type="button" className="pos-link is-bad" onClick={() => setEdit({ ...edit, items: edit.items.filter((x, k) => k !== i) })} aria-label={tr('Take it off')}>✕</button>
            </li>
          ))}
        </ol>
        <button type="button" className="pos-link" onClick={() => setEdit({ ...edit, items: edit.items.concat([blankItem()]) })}>+ {tr('Add a thing')}</button>
        <div className="dialog-actions"><button type="submit" className="btn btn-primary" disabled={busy}>{tr('Save checklist')}</button></div>
      </form>
    );
  }
  return (
    <section className="ts-sec ckl-tab">
      <p className="dk-muted">{tr('Lists of things to do and to check, ticked on the till each day: a reading out of its range is flagged for you.')}</p>
      <div className="ckl-cards">
        {data.lists.map((l, i) => {
          const [, icon, label] = atOf(l.at);
          return (
            <article key={l.id} className="ckl-card" style={{ '--i': i }}>
              <header><span aria-hidden="true">{icon}</span><strong>{l.name}</strong><small>{tr(label)}</small></header>
              <ul>{l.items.slice(0, 6).map((it) => <li key={it.key}>{it.kind === 'reading' ? '🌡️ ' : '✓ '}{it.text}{it.kind === 'reading' && rangeText(it) ? <small> · {rangeText(it)}</small> : null}</li>)}{l.items.length > 6 && <li className="dk-muted">+{l.items.length - 6}</li>}</ul>
              <footer>
                <button type="button" className="pos-link" onClick={() => setEdit({ id: l.id, name: l.name, at: l.at, items: l.items.map((x) => ({ ...x, min: x.min ?? '', max: x.max ?? '' })) })}>{tr('Edit')}</button>
                <button type="button" className="pos-link is-bad" disabled={busy} onClick={() => { if (window.confirm(tr('Take "{name}" off the till?', { name: l.name }))) run({ action: 'remove', id: l.id }); }}>{tr('Take it off')}</button>
              </footer>
            </article>
          );
        })}
        <button type="button" className="ckl-card is-new" onClick={() => setEdit({ name: '', at: 'open', items: [blankItem(), { ...blankItem(), kind: 'reading', unit: '°C', min: '0', max: '5' }] })}>＋ {tr('New checklist')}</button>
      </div>
      {data.lists.length > 0 && (
        <div className="ckl-hist">
          <h3>{tr('The last two weeks')}</h3>
          <div className="ckl-hist-scroll">
            <table>
              <thead><tr><th>{tr('Day')}</th>{data.lists.map((l) => <th key={l.id}>{l.name}</th>)}</tr></thead>
              <tbody>
                {data.history.map((d) => (
                  <tr key={d.day}>
                    <th>{new Date(d.day + 'T12:00:00Z').toLocaleDateString(activeIntlLocale(), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}</th>
                    {d.lists.map((x) => (
                      <td key={x.id} className={x.finished ? 'is-done' : x.done ? 'is-part' : 'is-none'}>
                        <b>{x.finished ? '✓' : x.done + '/' + x.total}</b>
                        {x.finished && <small>{x.finished.by} · {timeOf(x.finished.at)}</small>}
                        {x.bad.map((b, k) => <small key={k} className="is-bad">⚠️ {b.text}: {b.value}{b.unit ? ' ' + b.unit : ''}</small>)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
