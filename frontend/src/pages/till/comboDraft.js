// A combo's slots as the menu editor edits them (till/Combos.jsx), and as
// the server wants them (backend restaurantTillMenu saveCombo).

// The slots as the server sends them, as this editor edits them.
export function comboDraftOf(slots) {
  return (slots || []).map((s) => ({
    name: s.name, minPick: s.minPick, maxPick: s.maxPick,
    options: s.options.map((o) => ({ menuItemId: o.menuItemId, variationId: o.variationId || null, extra: o.extra ? String(o.extra) : '' }))
  }));
}
// And as the server wants them.
export function comboBodyOf(slots) {
  return (slots || []).map((s) => ({ name: s.name.trim(), minPick: Number(s.minPick), maxPick: Number(s.maxPick), options: s.options.map((o) => ({ menuItemId: o.menuItemId, variationId: o.variationId || null, extra: Number(o.extra) || 0 })) }));
}
