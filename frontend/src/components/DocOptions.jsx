import { money } from '../lib/currency';
import { tr } from '../lib/i18n.jsx';
import { computeDocTotals } from './DocItemsEditor';
import { dropOption, linesForOption, OPTION_KEYS, optionLetter } from '../lib/docOptions';

// The options panel of a quotation's lines (DocItemsEditor): two or three
// packages for the customer to choose from, each with its name, a word on
// what makes it different and its total as the lines stand.

const HINTS = ['e.g. Standard', 'e.g. Premium', 'e.g. Deluxe'];

export default function DocOptions({ options, items, onChange, onItemsChange, docDiscount, docTaxRate, currency }) {
  function set(key, field, value) { onChange(options.map((o) => (o.key === key ? { ...o, [field]: value } : o))); }
  function drop(key) { const r = dropOption(options, items, key); onChange(r.options); onItemsChange(r.items); }
  return (
    <section className="dop">
      <div className="dop-head">
        <span className="dop-art" aria-hidden="true">🎁</span>
        <div>
          <strong>{tr('Options for the customer')}</strong>
          <small>{tr('They pick one when they approve it online. Set each line below: in every option, or only in one.')}</small>
        </div>
        <button type="button" className="btn btn-secondary doc-items-remove" onClick={() => { onChange([]); onItemsChange(items.map((it) => ({ ...it, optionKey: '' }))); }} title={tr('No options')} aria-label={tr('No options')}>✕</button>
      </div>
      <div className="dop-grid">
        {options.map((o, i) => {
          const lines = linesForOption(items, o.key);
          const own = items.filter((it) => it.optionKey === o.key).length;
          const t = computeDocTotals(lines, docDiscount, docTaxRate);
          return (
            <div key={o.key} className={'dop-card is-' + o.key} style={{ '--i': i }}>
              <div className="dop-card-top">
                <span className="dop-letter">{optionLetter(o.key)}</span>
                <input className="input" value={o.name} maxLength={60} placeholder={tr(HINTS[i])} onChange={(e) => set(o.key, 'name', e.target.value)} aria-label={tr('Name of option {letter}', { letter: optionLetter(o.key) })} />
                {options.length > 2 && <button type="button" className="dop-x" onClick={() => drop(o.key)} aria-label={tr('Take option {letter} away', { letter: optionLetter(o.key) })}>✕</button>}
              </div>
              <input className="input dop-note" value={o.note || ''} maxLength={300} placeholder={tr('What makes it different (optional)')} onChange={(e) => set(o.key, 'note', e.target.value)} />
              <div className="dop-sum">
                <span className={own ? '' : 'is-none'}>{own ? (own === 1 ? tr('1 line of its own') : tr('{n} lines of its own', { n: own })) : tr('No line of its own yet')}</span>
                <strong>{money(t.grandTotal, currency)}</strong>
              </div>
            </div>
          );
        })}
        {options.length < OPTION_KEYS.length && (
          <button type="button" className="dop-add" onClick={() => onChange(options.concat([{ key: OPTION_KEYS[options.length], name: '', note: '' }]))}>＋ {tr('A third option')}</button>
        )}
      </div>
    </section>
  );
}
