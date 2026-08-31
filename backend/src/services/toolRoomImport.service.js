var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { parseCsvBuffer, field, parseMoneyLoose } = require('../lib/csvImport');

// Import from the tool room's own tracking sheet — same shape of feature as
// itDeviceImport.service.js (see that file for the shared reasoning on
// header-alias matching and per-row preview/commit), applied to
// tool_room_items instead. Unlike IT devices, a tool room sheet row is
// already one item (no Total/In-Use expansion needed) — quantity here means
// "how many of this exact code are on hand", which materials genuinely
// track, so it maps straight onto quantity_on_hand.

var KIND_ALIASES = {
  tool: 'tool', tools: 'tool',
  equipment: 'equipment', equip: 'equipment', machine: 'equipment', machinery: 'equipment',
  material: 'material', materials: 'material', consumable: 'material', consumables: 'material', supply: 'material', supplies: 'material'
};
function mapKind(raw) {
  var key = String(raw || '').trim().toLowerCase();
  if (KIND_ALIASES[key]) return { value: KIND_ALIASES[key], recognized: true };
  return { value: 'tool', recognized: !key };
}

var CONDITION_ALIASES = {
  good: 'good', new: 'good', excellent: 'good',
  fair: 'fair', ok: 'fair', okay: 'fair', average: 'fair',
  poor: 'poor', bad: 'poor', worn: 'poor',
  'under repair': 'under_repair', repair: 'under_repair', 'being repaired': 'under_repair', broken: 'under_repair', damaged: 'under_repair'
};
function mapCondition(raw) {
  var key = String(raw || '').trim().toLowerCase();
  if (CONDITION_ALIASES[key]) return { value: CONDITION_ALIASES[key], recognized: true };
  return { value: 'good', recognized: !key };
}

function buildEmployeeIndex(employees) {
  return employees.map(function (e) {
    return { id: e.id, first: (e.first_name || '').toLowerCase(), last: (e.last_name || '').toLowerCase() };
  }).filter(function (e) { return e.first.length >= 3 || e.last.length >= 3; });
}
function matchEmployee(text, index) {
  var words = String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  var hits = index.filter(function (e) {
    return (e.first.length >= 3 && words.indexOf(e.first) >= 0) || (e.last.length >= 3 && words.indexOf(e.last) >= 0);
  });
  var uniqueIds = Array.from(new Set(hits.map(function (h) { return h.id; })));
  return uniqueIds.length === 1 ? uniqueIds[0] : null;
}

// Codes are capped at 30 chars (V.text in toolRoom.service.js#create) and
// must be unique — derive one from the name's initials when the sheet
// doesn't already have one, same numeric-suffix-on-clash approach
// timestation.service.js#deriveDeptCode uses for department codes.
function deriveCode(name, takenCodes) {
  var words = String(name || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  var base = (words.length > 1 ? words.map(function (w) { return w[0]; }).join('') : (words[0] || 'ITEM')).slice(0, 8);
  if (!base) base = 'ITEM';
  var code = base, n = 1;
  while (takenCodes.has(code)) { code = base + '-' + (n++); }
  takenCodes.add(code);
  return code;
}

async function preview(ctx, buffer) {
  if (!ctx.can('toolroom.manage')) fail('forbidden', 'Your role does not allow this action (toolroom.manage).');

  var rows = parseCsvBuffer(buffer);
  if (!rows.length) fail('invalid', 'That file has no data rows.');

  var empRes = await pool.query('SELECT id, first_name, last_name FROM employees WHERE status <> $1', ['terminated']);
  var empIndex = buildEmployeeIndex(empRes.rows);

  var existingRes = await pool.query('SELECT code FROM tool_room_items');
  var existingCodes = new Set(existingRes.rows.map(function (r) { return r.code; }));
  var takenCodes = new Set(existingCodes);

  var out = [];
  rows.forEach(function (row, rowIdx) {
    var n = row.norm;
    var code = field(n, ['code', 'itemcode', 'tag']).toUpperCase();
    var name = field(n, ['name', 'item', 'description', 'itemname']);
    var kindRaw = field(n, ['kind', 'type']);
    var category = field(n, ['category']);
    var unit = field(n, ['unit', 'uom']) || 'each';
    var qty = parseMoneyLoose(field(n, ['quantity', 'qty', 'quantityonhand', 'onhand', 'stock']), 0);
    var reorderLevel = parseMoneyLoose(field(n, ['reorder', 'reorderlevel', 'minqty', 'minimum']), 0);
    var conditionRaw = field(n, ['condition']);
    var location = field(n, ['location', 'store', 'store room', 'storeroom']);
    var whoWhere = field(n, ['checkedoutto', 'assignedto', 'holder', 'whowhere', 'who', 'where']);
    var notes = field(n, ['notes', 'remark', 'remarks']);

    if (!name) return; // blank spreadsheet row — skip silently, not an error

    var kindMap = mapKind(kindRaw);
    var conditionMap = mapCondition(conditionRaw);
    var warnings = [];
    if (!kindMap.recognized && kindRaw) warnings.push('Unrecognized kind "' + kindRaw + '" — imported as Tool; review after import.');
    if (!conditionMap.recognized && conditionRaw) warnings.push('Unrecognized condition "' + conditionRaw + '" — imported as Good; review after import.');

    if (!code) code = deriveCode(name, takenCodes);
    else takenCodes.add(code);

    var willSkip = existingCodes.has(code);
    if (willSkip) warnings.push('Code ' + code + ' already exists — will be skipped.');

    var assignedEmployeeId = null;
    if (kindMap.value !== 'material' && whoWhere) {
      assignedEmployeeId = matchEmployee(whoWhere, empIndex);
      if (!assignedEmployeeId) warnings.push('"' + whoWhere + '" didn’t match one employee uniquely — left unassigned.');
    } else if (kindMap.value === 'material' && whoWhere) {
      warnings.push('Materials can’t be checked out — "' + whoWhere + '" was ignored.');
    }

    out.push({
      code: code,
      name: name,
      kind: kindMap.value,
      category: category,
      unit: unit,
      quantityOnHand: Math.max(0, qty),
      reorderLevel: Math.max(0, reorderLevel),
      condition: conditionMap.value,
      location: location || 'Tool room',
      assignedEmployeeId: assignedEmployeeId,
      notes: notes,
      sourceRow: field(n, ['id']) || String(rowIdx + 1),
      willSkip: willSkip,
      warnings: warnings
    });
  });

  return { rows: out };
}

async function commit(ctx, rows) {
  if (!ctx.can('toolroom.manage')) fail('forbidden', 'Your role does not allow this action (toolroom.manage).');
  if (!Array.isArray(rows) || !rows.length) fail('invalid', 'Nothing to import.');

  var existingRes = await pool.query('SELECT code FROM tool_room_items');
  var existingCodes = new Set(existingRes.rows.map(function (r) { return r.code; }));

  var created = 0, skipped = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var code = String(r.code || '').trim().toUpperCase();
    if (!code || existingCodes.has(code)) { skipped++; continue; }
    existingCodes.add(code);

    var status = r.assignedEmployeeId && r.kind !== 'material' ? 'checked_out' : 'available';
    var res = await pool.query(
      "INSERT INTO tool_room_items (code, name, kind, category, unit, quantity_on_hand, reorder_level, condition, location, checked_out_to, status, notes) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id",
      [code, (r.name || '').trim(), r.kind || 'tool', (r.category || '').trim(), r.unit || 'each',
        Math.max(0, Number(r.quantityOnHand) || 0), Math.max(0, Number(r.reorderLevel) || 0), r.condition || 'good',
        (r.location || 'Tool room').trim(), r.assignedEmployeeId || null, status, (r.notes || '').trim()]
    );
    if (res.rows[0]) created++;
  }

  await audit(pool, ctx, 'toolroom.import', 'tool_room_item', 'bulk', 'Imported ' + created + ' item(s) from tool room sheet' + (skipped ? ' (' + skipped + ' skipped — duplicate code)' : '') + '.');
  return { created: created, skipped: skipped };
}

module.exports = { preview: preview, commit: commit };
