import { useState } from 'react';
import { tr } from '../../lib/i18n.jsx';
import { modsWords } from './tillBill';
import { ALLERGENS, allergenWords, clashes, courseName } from './tillService';

// The table's service on the till (RestaurantPosPage.jsx): an order's
// allergy alert, and the kitchen's tickets for a station without a screen,
// to print when no thermal printer is connected (backend restaurantKitchen
// chitsFor).

// What a guest is allergic to: the allergens, and a note ("seat 2: no nuts
// at all"). The kitchen's ticket shows it in red, and the dishes that have one.
export function AllergyDialog({ value, onSave, onClose }) {
  const [list, setList] = useState((value && value.list) || []);
  const [note, setNote] = useState((value && value.note) || '');
  const toggle = (k) => setList(list.includes(k) ? list.filter((x) => x !== k) : list.concat([k]));
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog tl-dialog tl-allergy" role="dialog" aria-modal="true" aria-labelledby="tl-allergy-title" onClick={(e) => e.stopPropagation()}>
        <span className="tl-dialog-ico is-allergy" aria-hidden="true">⚠</span>
        <h2 id="tl-allergy-title">{tr('Allergy alert')}</h2>
        <p className="dk-muted">{tr('The kitchen sees it in red on every ticket of this order, and each dish that has it. The till warns you before you add one.')}</p>
        <div className="tl-allergy-grid" role="group" aria-label={tr('Allergens')}>
          {ALLERGENS.map(([k, icon, label]) => (
            <button key={k} type="button" aria-pressed={list.includes(k)} className={'tl-allergen' + (list.includes(k) ? ' is-on' : '')} onClick={() => toggle(k)}>
              <span aria-hidden="true">{icon}</span>{tr(label)}
            </button>
          ))}
        </div>
        <div className="field">
          <label htmlFor="tl-allergy-note">{tr('A note for the kitchen')}</label>
          <input id="tl-allergy-note" className="input" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr('e.g. seat 2: no nuts at all, not even the oil')} />
        </div>
        <div className="dialog-actions">
          {value && <button type="button" className="btn btn-secondary" onClick={() => onSave(null)}>{tr('No allergy')}</button>}
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={!list.length && !note.trim()} onClick={() => onSave({ list, note: note.trim() })}>{tr('Save the alert')}</button>
        </div>
      </div>
    </div>
  );
}

// An order's allergy alert as a red strip (the till's order, the kitchen screen).
export function AllergyStrip({ allergy, onClick, className }) {
  if (!allergy || (!(allergy.list || []).length && !allergy.note)) return null;
  const words = (allergy.list || []).map((k) => allergenWords(k, tr)).join(' · ');
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} className={'tl-allergy-strip' + (className ? ' ' + className : '')} onClick={onClick}>
      <b aria-hidden="true">⚠</b>
      <span><strong>{tr('Allergy')}</strong>{words}{allergy.note ? <small>{allergy.note}</small> : null}</span>
    </Tag>
  );
}

function chitHtml(c, settings) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const where = c.fulfillment === 'pickup' ? tr('Counter') : c.fulfillment === 'delivery' ? tr('Delivery') : (c.tableName || c.label || tr('Counter'));
  const items = c.items.map((it) => {
    const bad = clashes(it.allergens, { list: c.allergens });
    return '<li><b>' + (it.seat ? '[S' + it.seat + '] ' : '') + esc(it.qty) + ' × ' + esc(it.name) + '</b>' +
      ((it.mods || []).length ? '<i>+ ' + esc(modsWords(it.mods, tr)) + '</i>' : '') + (it.note ? '<i>✎ ' + esc(it.note) + '</i>' : '') +
      (bad.length ? '<em>⚠ ' + esc(bad.map((k) => allergenWords(k, tr)).join(', ')) + '</em>' : '') + '</li>';
  }).join('');
  return '<section><h1>' + esc(c.station) + '</h1><h2>#' + esc(c.number) + ' · ' + esc(where) + '</h2>' +
    (c.course ? '<h3>' + esc(courseName(settings, c.course, tr)) + '</h3>' : '') +
    ((c.allergens || []).length || c.allergy ? '<p class="al">⚠ ' + esc((c.allergens || []).map((k) => allergenWords(k, tr)).join(', ')) + (c.allergy ? '<br>' + esc(c.allergy) : '') + '</p>' : '') +
    (c.guests ? '<p>' + esc(tr('{n} guests', { n: c.guests })) + '</p>' : '') + '<ul>' + items + '</ul>' + (c.note ? '<p>✎ ' + esc(c.note) + '</p>' : '') + '</section>';
}

// The tickets to print for stations without a screen, when no thermal
// printer is connected: shown, and printed through the browser.
export function KitchenChits({ chits, settings, onClose }) {
  function print() {
    const w = window.open('', '_blank', 'width=420,height=640');
    if (!w) return;
    w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>' + tr('Kitchen tickets') + '</title><style>' +
      'body{font:14px/1.35 system-ui,sans-serif;margin:0;padding:8px;width:72mm}section{border-bottom:2px dashed #000;padding:6px 0 12px;page-break-after:always}' +
      'h1{font-size:13px;letter-spacing:.08em;text-transform:uppercase;margin:0}h2{font-size:22px;margin:2px 0}h3{font-size:15px;margin:0 0 4px;text-transform:uppercase}' +
      'ul{list-style:none;padding:0;margin:6px 0}li{margin:0 0 6px}li b{display:block;font-size:16px}li i,li em{display:block;font-style:normal;font-size:13px}li em,.al{font-weight:800}' +
      '.al{border:2px solid #000;padding:4px 6px}</style></head><body>' + chits.map((c) => chitHtml(c, settings)).join('') + '</body></html>');
    w.document.close();
    w.focus();
    w.print();
  }
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog tl-dialog tl-chits" role="dialog" aria-modal="true" aria-labelledby="tl-chits-title" onClick={(e) => e.stopPropagation()}>
        <span className="tl-dialog-ico is-chits" aria-hidden="true">🖨</span>
        <h2 id="tl-chits-title">{chits.length === 1 ? tr('A kitchen ticket to print') : tr('{n} kitchen tickets to print', { n: chits.length })}</h2>
        <p className="dk-muted">{tr('These stations have no screen: print their tickets and take them over. Connect a receipt printer and they print by themselves.')}</p>
        <div className="tl-chit-list">
          {chits.map((c, i) => (
            <article key={i} className="tl-chit">
              <header><small>{c.station}</small><strong>#{c.number}</strong><span>{c.fulfillment === 'pickup' ? tr('Counter') : c.fulfillment === 'delivery' ? tr('Delivery') : (c.tableName || c.label)}</span></header>
              {c.course > 0 && <p className="tl-chit-course">{courseName(settings, c.course, tr)}</p>}
              <AllergyStrip allergy={(c.allergens || []).length || c.allergy ? { list: c.allergens, note: c.allergy } : null} />
              <ul className="is-plain">
                {c.items.map((it, j) => {
                  const bad = clashes(it.allergens, { list: c.allergens });
                  return (
                    <li key={j} className={bad.length ? 'is-clash' : ''}>
                      <b>{it.seat ? <em className="tl-seat">S{it.seat}</em> : null}{it.qty} × {it.name}</b>
                      {(it.mods || []).length > 0 && <small>+ {modsWords(it.mods, tr)}</small>}
                      {it.note && <small>✎ {it.note}</small>}
                      {bad.length > 0 && <small className="is-bad">⚠ {bad.map((k) => allergenWords(k, tr)).join(', ')}</small>}
                    </li>
                  );
                })}
              </ul>
            </article>
          ))}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button>
          <button type="button" className="btn btn-primary" onClick={print}>🖨 {tr('Print them')}</button>
        </div>
      </div>
    </div>
  );
}
