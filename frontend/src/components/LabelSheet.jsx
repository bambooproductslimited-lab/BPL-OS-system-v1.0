import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { money } from '../lib/currency';
import { tr } from '../lib/i18n.jsx';
import { code128Svg, encodable } from '../lib/code128';
import './LabelSheet.css';

// Price and barcode labels, printed on sticker sheets or a label printer —
// Square's "print labels": Products & Services (CatalogPage.jsx) and the
// restaurant menu (till/MenuStock.jsx), whose labels also say what
// allergens a dish has. labels: [{ key, name, sub, price, currency, code,
// allergens (words), qty }].

// Sheet layouts, in millimetres: page, columns × rows, label, margins, gaps.
const SHEETS = [
  { key: 'a4-24', label: 'A4 · 24 a sheet (3 × 8)', page: [210, 297], cols: 3, rows: 8, w: 63.5, h: 33.9, top: 13.1, left: 7.2, gx: 2.5, gy: 0 },
  { key: 'a4-14', label: 'A4 · 14 a sheet (2 × 7)', page: [210, 297], cols: 2, rows: 7, w: 99.1, h: 38.1, top: 15.1, left: 4.7, gx: 2.5, gy: 0 },
  { key: 'a4-40', label: 'A4 · 40 a sheet (4 × 10)', page: [210, 297], cols: 4, rows: 10, w: 48.5, h: 25.4, top: 21.5, left: 8, gx: 0, gy: 0 },
  { key: 'roll', label: 'Label printer · 50 × 30 mm', page: [50, 30], cols: 1, rows: 1, w: 50, h: 30, top: 0, left: 0, gx: 0, gy: 0 }
];

function Barcode({ code }) {
  if (!code || !encodable(code)) return null;
  const b = code128Svg(code, { height: 40 });
  return <svg className="lbl-bars" viewBox={'0 0 ' + b.width + ' ' + b.height} preserveAspectRatio="none" aria-label={code}><path d={b.path} /></svg>;
}

function Label({ l, show }) {
  return (
    <div className="lbl">
      <div className="lbl-top">
        <div className="lbl-names">
          {show.name && <strong className="lbl-name">{l.name}</strong>}
          {show.name && l.sub && <span className="lbl-sub">{l.sub}</span>}
        </div>
        {show.price && l.price != null && <b className="lbl-price">{money(l.price, l.currency)}</b>}
      </div>
      {show.allergens && l.allergens && l.allergens.length > 0 && <div className="lbl-alg">⚠ {l.allergens.join(' · ')}</div>}
      {show.barcode && l.code && <Barcode code={l.code} />}
      {show.code && l.code && <span className="lbl-code">{l.code}</span>}
    </div>
  );
}

export default function LabelSheet({ title, labels, onClose, allergens: hasAllergens }) {
  const [sheet, setSheet] = useState('a4-24');
  const [qty, setQty] = useState(() => Object.fromEntries(labels.map((l) => [l.key, l.qty || 1])));
  const [skip, setSkip] = useState(0); // labels already used on a started sheet
  const [show, setShow] = useState({ name: true, price: true, barcode: true, code: true, allergens: !!hasAllergens });
  const s = SHEETS.find((x) => x.key === sheet);
  const all = [];
  labels.forEach((l) => { for (let k = 0; k < (Number(qty[l.key]) || 0); k++) all.push(l); });
  const per = s.cols * s.rows;
  const cells = Array(sheet === 'roll' ? 0 : Math.min(skip, per - 1)).fill(null).concat(all);
  const pages = [];
  for (let i = 0; i < cells.length; i += per) pages.push(cells.slice(i, i + per));
  const noCode = labels.filter((l) => !l.code).length;

  useEffect(() => {
    const done = () => document.body.classList.remove('lbl-printing');
    window.addEventListener('afterprint', done);
    return () => { window.removeEventListener('afterprint', done); done(); };
  }, []);
  function print() {
    document.body.classList.add('lbl-printing');
    setTimeout(() => window.print(), 50);
  }
  const vars = { '--pw': s.page[0] + 'mm', '--ph': s.page[1] + 'mm', '--lw': s.w + 'mm', '--lh': s.h + 'mm', '--top': s.top + 'mm', '--left': s.left + 'mm', '--gx': s.gx + 'mm', '--gy': s.gy + 'mm', '--cols': s.cols };
  const sheets = pages.map((page, p) => (
    <div className="lbl-page" key={p} style={vars}>
      <div className="lbl-grid">{page.map((l, i) => (l ? <Label key={i} l={l} show={show} /> : <div key={i} className="lbl is-used" />))}</div>
    </div>
  ));

  // At the page's root, so a panel it opens from (the till settings) does not hold it.
  return createPortal(
    <div className="dialog-backdrop no-print lbs-over" onClick={onClose}>
      <div className="dialog lbs" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="lbs-title">
        <div className="lbs-head">
          <span className="lbs-ico" aria-hidden="true">🏷️</span>
          <div>
            <h2 id="lbs-title">{title}</h2>
            <p className="dk-muted">{tr('Barcodes any scanner reads, the till too. Print on sticker sheets or a label printer.')}</p>
          </div>
        </div>
        <div className="lbs-body">
          <div className="lbs-side">
            <label className="lbs-field">{tr('Labels')}
              <select className="input" value={sheet} onChange={(e) => setSheet(e.target.value)}>
                {SHEETS.map((x) => <option key={x.key} value={x.key}>{tr(x.label)}</option>)}
              </select>
            </label>
            {sheet !== 'roll' && (
              <label className="lbs-field">{tr('Already used on the first sheet')}
                <input className="input" type="number" min="0" max={per - 1} value={skip} onChange={(e) => setSkip(Math.max(0, Math.min(per - 1, Number(e.target.value) || 0)))} />
              </label>
            )}
            <div className="lbs-show">
              {[['name', 'Name'], ['price', 'Price'], ['barcode', 'Barcode'], ['code', 'Code under it']].concat(hasAllergens ? [['allergens', 'Allergens']] : []).map(([k, label]) => (
                <label key={k}><input type="checkbox" checked={show[k]} onChange={(e) => setShow({ ...show, [k]: e.target.checked })} /> {tr(label)}</label>
              ))}
            </div>
            <ul className="lbs-list">
              {labels.map((l) => (
                <li key={l.key}>
                  <span><strong>{l.name}</strong>{l.sub && <small className="dk-muted"> · {l.sub}</small>}{!l.code && <small className="lbs-nocode">{tr('no code')}</small>}</span>
                  <input className="input" type="number" min="0" max="500" value={qty[l.key]} onChange={(e) => setQty({ ...qty, [l.key]: Math.max(0, Math.min(500, Number(e.target.value) || 0)) })} aria-label={tr('How many of {name}', { name: l.name })} />
                </li>
              ))}
            </ul>
            {noCode > 0 && <p className="dk-muted tl-small">{noCode === 1 ? tr('1 has no code: its label has no barcode.') : tr('{n} have no code: their labels have no barcode.', { n: noCode })}</p>}
          </div>
          <div className="lbs-preview" aria-label={tr('Preview')}>
            {sheets.length ? sheets.slice(0, 2) : <p className="dk-muted">{tr('Nothing to print yet.')}</p>}
            {sheets.length > 2 && <p className="dk-muted tl-small">{tr('… and {n} more sheets', { n: sheets.length - 2 })}</p>}
          </div>
        </div>
        <div className="dialog-actions">
          <span className="dk-muted tl-small lbs-count">{all.length === 1 ? tr('1 label') : tr('{n} labels', { n: all.length })}{sheet !== 'roll' && pages.length ? ' · ' + (pages.length === 1 ? tr('1 sheet') : tr('{n} sheets', { n: pages.length })) : ''}</span>
          <button type="button" className="btn btn-secondary" onClick={onClose}>{tr('Close')}</button>
          <button type="button" className="btn btn-primary" onClick={print} disabled={!all.length}>🖨️ {tr('Print')}</button>
        </div>
      </div>
      {createPortal(<div className="lbl-print-root" aria-hidden="true"><style>{'@page { size: ' + s.page[0] + 'mm ' + s.page[1] + 'mm; margin: 0; }'}</style>{sheets}</div>, document.body)}
    </div>, document.body
  );
}
