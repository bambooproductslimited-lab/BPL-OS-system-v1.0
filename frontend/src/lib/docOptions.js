// Quotation options (backend quotations.service cleanOptions, migration
// 0193): two or three packages, each made of the lines in all of them plus
// its own; the customer picks one when approving. Keys go a, b, c in order.
export const OPTION_KEYS = ['a', 'b', 'c'];

export function linesForOption(items, key) {
  return (items || []).filter((it) => !it.optionKey || it.optionKey === key);
}
export function optionLetter(key) { return String(key || '').toUpperCase(); }
// Still to choose: offered, and nobody has picked one yet.
export function optionsOpen(doc) { return !!(doc && (doc.options || []).length && !doc.optionChosen); }
// The lines, grouped the way the customer reads them: those in every
// option first, then each option's own.
export function optionSections(items, options) {
  return [{ key: '', items: (items || []).filter((it) => !it.optionKey) }]
    .concat((options || []).map((o) => ({ key: o.key, option: o, items: (items || []).filter((it) => it.optionKey === o.key) })))
    .filter((s) => s.items.length || s.key);
}
// Taking an option away: the others move up a letter, and its own lines
// stay, in every option, for the person to move or remove.
export function dropOption(options, items, key) {
  const left = options.filter((o) => o.key !== key);
  const next = left.length < 2 ? [] : left.map((o, i) => ({ ...o, key: OPTION_KEYS[i] }));
  const map = {};
  if (next.length) left.forEach((o, i) => { map[o.key] = OPTION_KEYS[i]; });
  return { options: next, items: items.map((it) => ({ ...it, optionKey: map[it.optionKey] || '' })) };
}
