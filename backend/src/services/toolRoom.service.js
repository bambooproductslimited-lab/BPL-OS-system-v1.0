var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

// Tool room inventory: tools, equipment and materials kept in the factory's
// tool room — separate from the finished-goods Products & Inventory module.
// Tools/equipment are tracked as individual items that are checked out to an
// employee (with a day they are due back) and checked back in (with the
// condition they came back in); materials are tracked by quantity_on_hand /
// reorder_level and are issued to people or restocked. Every movement is
// logged in tool_room_moves (migration 0088), which is what the item's
// history, "who has what" and "how fast is it used" come from.

var CONDITIONS = ['good', 'fair', 'poor', 'under_repair'];

function todayISO() { return new Date().toISOString().slice(0, 10); }
function isoDate(d) { return d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null; }
function has(p, k) { return p && Object.prototype.hasOwnProperty.call(p, k) && p[k] !== undefined; }
function num(v) { return Math.round(Number(v) * 100) / 100; }
function fullName(first, last) { return first ? first + (last ? ' ' + last : '') : null; }
function photoStamp(key, at) { return key && at ? new Date(at).getTime() : null; }
function note(v) { return String(v || '').trim().slice(0, 300); }
function quantity(v, label) {
  var q = Number(v);
  if (!Number.isFinite(q) || q <= 0 || q > 1e9) fail('invalid', (label || 'Quantity') + ' must be more than 0.');
  return num(q);
}

function rowToItem(r, extra) {
  return Object.assign({
    id: r.id, code: r.code, name: r.name, kind: r.kind, category: r.category, unit: r.unit,
    quantityOnHand: Number(r.quantity_on_hand), reorderLevel: Number(r.reorder_level), condition: r.condition,
    location: r.location, checkedOutTo: r.checked_out_to, status: r.status, notes: r.notes,
    checkedOutAt: r.checked_out_at || null, dueBack: isoDate(r.due_back),
    createdAt: r.created_at || null, updatedAt: r.updated_at || null
  }, extra || {});
}

async function logMove(ctx, itemId, kind, m) {
  m = m || {};
  await pool.query(
    'INSERT INTO tool_room_moves (item_id, kind, employee_id, quantity, due_back, condition, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [itemId, kind, m.employeeId || null, m.quantity === undefined ? null : m.quantity, m.dueBack || null, m.condition || null, m.note || '', ctx.employee ? ctx.employee.id : null]
  );
}

async function findItem(id) {
  var item = (await pool.query('SELECT * FROM tool_room_items WHERE id = $1', [id])).rows[0];
  if (!item) fail('notfound', 'Item not found.');
  return item;
}

async function list(ctx) {
  if (!ctx.can('toolroom.read')) fail('forbidden', 'Your role does not allow this action (toolroom.read).');
  var res = await pool.query(
    'SELECT t.*, e.first_name, e.last_name, e.photo_key, e.photo_updated_at, e.phone AS holder_phone, m.times_out, m.used30, m.last_move ' +
    'FROM tool_room_items t LEFT JOIN employees e ON e.id = t.checked_out_to ' +
    'LEFT JOIN (SELECT item_id, count(*) FILTER (WHERE kind = \'checkout\') AS times_out, ' +
    "  coalesce(sum(quantity) FILTER (WHERE kind = 'issue' AND created_at > now() - interval '30 days'), 0) AS used30, max(created_at) AS last_move " +
    '  FROM tool_room_moves GROUP BY item_id) m ON m.item_id = t.id ' +
    'ORDER BY t.code'
  );
  var today = todayISO();
  return res.rows.map(function (r) {
    var out = r.status === 'checked_out';
    return rowToItem(r, {
      checkedOutToName: fullName(r.first_name, r.last_name),
      checkedOutToPhoto: photoStamp(r.photo_key, r.photo_updated_at),
      checkedOutToPhone: r.holder_phone || null,
      lowStock: r.kind === 'material' && r.status !== 'retired' && Number(r.quantity_on_hand) <= Number(r.reorder_level),
      overdue: out && !!r.due_back && isoDate(r.due_back) < today,
      daysOut: out && r.checked_out_at ? Math.max(0, Math.floor((Date.now() - new Date(r.checked_out_at).getTime()) / 86400000)) : null,
      timesOut: Number(r.times_out || 0),
      used30: Number(r.used30 || 0),
      lastMoveAt: r.last_move || null
    });
  });
}

// Everything that happened to one item, newest first.
async function history(ctx, id) {
  if (!ctx.can('toolroom.read')) fail('forbidden', 'Your role does not allow this action (toolroom.read).');
  await findItem(id);
  var res = await pool.query(
    'SELECT m.*, e.first_name, e.last_name, e.photo_key, e.photo_updated_at, b.first_name AS by_first, b.last_name AS by_last ' +
    'FROM tool_room_moves m LEFT JOIN employees e ON e.id = m.employee_id LEFT JOIN employees b ON b.id = m.created_by ' +
    'WHERE m.item_id = $1 ORDER BY m.created_at DESC, m.id LIMIT 200', [id]
  );
  return res.rows.map(function (r) {
    return {
      id: r.id, kind: r.kind, at: r.created_at, employeeId: r.employee_id,
      employeeName: fullName(r.first_name, r.last_name), employeePhoto: photoStamp(r.photo_key, r.photo_updated_at),
      quantity: r.quantity === null ? null : Number(r.quantity), dueBack: isoDate(r.due_back), condition: r.condition,
      note: r.note, byName: fullName(r.by_first, r.by_last)
    };
  });
}

async function create(ctx, p) {
  if (!ctx.can('toolroom.manage')) fail('forbidden', 'Your role does not allow this action (toolroom.manage).');
  var code = V.text(p.code, 'Code', 30).toUpperCase();
  var name = V.text(p.name, 'Name', 100);
  var kind = V.oneOf(p.kind || 'tool', ['tool', 'equipment', 'material'], 'Kind');
  var condition = V.oneOf(p.condition || 'good', CONDITIONS, 'Condition');

  var existing = await pool.query('SELECT id FROM tool_room_items WHERE code = $1', [code]);
  if (existing.rows[0]) fail('invalid', 'That code already exists.');

  var qty = Math.max(0, num(Number(p.quantityOnHand) || 0));
  var res = await pool.query(
    "INSERT INTO tool_room_items (code, name, kind, category, unit, quantity_on_hand, reorder_level, condition, location, notes, status) " +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'available') RETURNING *",
    [code, name, kind, String(p.category || '').trim().slice(0, 60), String(p.unit || 'each').trim().slice(0, 20) || 'each', qty,
      Math.max(0, num(Number(p.reorderLevel) || 0)), condition, String(p.location || 'Tool room').trim().slice(0, 100) || 'Tool room',
      String(p.notes || '').trim().slice(0, 1000)]
  );
  var item = res.rows[0];
  if (kind === 'material') await logMove(ctx, item.id, 'count', { quantity: qty, note: 'Opening count' });
  await audit(pool, ctx, 'toolroom.create', 'tool_room_item', item.id, 'Added ' + kind + ' ' + item.code + ' — ' + item.name + '.');
  return rowToItem(item);
}

// Only what was sent changes. A new quantity is logged as a count, so the
// history shows where a jump in stock came from.
async function update(ctx, id, p) {
  if (!ctx.can('toolroom.manage')) fail('forbidden', 'Your role does not allow this action (toolroom.manage).');
  p = p || {};
  var cur = await findItem(id);

  var name = has(p, 'name') ? V.text(p.name, 'Name', 100) : cur.name;
  var category = has(p, 'category') ? String(p.category || '').trim().slice(0, 60) : cur.category;
  var unit = has(p, 'unit') ? (String(p.unit || '').trim().slice(0, 20) || cur.unit) : cur.unit;
  var qty = has(p, 'quantityOnHand') && p.quantityOnHand !== '' ? Math.max(0, num(Number(p.quantityOnHand) || 0)) : Number(cur.quantity_on_hand);
  var reorderLevel = has(p, 'reorderLevel') ? Math.max(0, num(Number(p.reorderLevel) || 0)) : Number(cur.reorder_level);
  var condition = has(p, 'condition') ? V.oneOf(p.condition || 'good', CONDITIONS, 'Condition') : cur.condition;
  var location = has(p, 'location') ? (String(p.location || '').trim().slice(0, 100) || 'Tool room') : cur.location;
  var notes = has(p, 'notes') ? String(p.notes || '').trim().slice(0, 1000) : cur.notes;

  var res = await pool.query(
    'UPDATE tool_room_items SET name = $1, category = $2, unit = $3, quantity_on_hand = $4, reorder_level = $5, condition = $6, location = $7, notes = $8, updated_at = now() WHERE id = $9 RETURNING *',
    [name, category, unit, qty, reorderLevel, condition, location, notes, id]
  );
  var item = res.rows[0];
  if (cur.kind === 'material' && qty !== Number(cur.quantity_on_hand)) {
    await logMove(ctx, id, 'count', { quantity: qty, note: note(p.countNote) || 'Count corrected (was ' + Number(cur.quantity_on_hand) + ')' });
  }
  await audit(pool, ctx, 'toolroom.update', 'tool_room_item', item.id, 'Updated ' + item.code + '.');
  return rowToItem(item);
}

async function checkout(ctx, id, p) {
  if (!ctx.can('toolroom.manage')) fail('forbidden', 'Your role does not allow this action (toolroom.manage).');
  p = p || {};
  var item = await findItem(id);
  if (item.kind === 'material') fail('invalid', 'Materials are tracked by quantity, not check-out. Issue them instead.');
  if (item.status === 'retired') fail('invalid', item.name + ' is retired.');
  if (item.condition === 'under_repair') fail('invalid', item.name + ' is under repair.');
  if (!p.employeeId) fail('invalid', 'Choose who is taking it.');
  var emp = (await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = $1', [p.employeeId])).rows[0];
  if (!emp) fail('invalid', 'That employee was not found.');
  var dueBack = p.dueBack ? V.date(p.dueBack, 'Due back') : null;
  if (dueBack && dueBack < todayISO()) fail('invalid', 'The due-back day cannot be in the past.');

  var res = await pool.query(
    "UPDATE tool_room_items SET checked_out_to = $1, status = 'checked_out', checked_out_at = now(), due_back = $2, updated_at = now() " +
    "WHERE id = $3 AND status = 'available' RETURNING *",
    [emp.id, dueBack, id]
  );
  if (!res.rows[0]) fail('invalid', item.name + ' is already checked out.');
  await logMove(ctx, id, 'checkout', { employeeId: emp.id, dueBack: dueBack, note: note(p.note) });
  await audit(pool, ctx, 'toolroom.checkout', 'tool_room_item', id, 'Checked out ' + item.code + ' to ' + emp.first_name + ' ' + emp.last_name + '.');
  return rowToItem(res.rows[0]);
}

async function checkin(ctx, id, p) {
  if (!ctx.can('toolroom.manage')) fail('forbidden', 'Your role does not allow this action (toolroom.manage).');
  p = p || {};
  var item = await findItem(id);
  if (item.status !== 'checked_out') fail('invalid', item.name + ' is not checked out.');
  var condition = p.condition ? V.oneOf(p.condition, CONDITIONS, 'Condition') : item.condition;

  var res = await pool.query(
    "UPDATE tool_room_items SET checked_out_to = NULL, status = 'available', checked_out_at = NULL, due_back = NULL, condition = $1, updated_at = now() " +
    "WHERE id = $2 AND status = 'checked_out' RETURNING *",
    [condition, id]
  );
  if (!res.rows[0]) fail('invalid', item.name + ' is not checked out.');
  await logMove(ctx, id, 'checkin', { employeeId: item.checked_out_to, condition: condition, note: note(p.note) });
  await audit(pool, ctx, 'toolroom.checkout', 'tool_room_item', id, 'Checked in ' + item.code + '.');
  return rowToItem(res.rows[0]);
}

// The old single endpoint: an employee checks it out, none checks it in.
async function setCheckout(ctx, id, employeeId) {
  return employeeId ? checkout(ctx, id, { employeeId: employeeId }) : checkin(ctx, id, {});
}

// Materials: hand some out (to someone, optionally) or put more on the shelf.
async function issue(ctx, id, p) {
  if (!ctx.can('toolroom.manage')) fail('forbidden', 'Your role does not allow this action (toolroom.manage).');
  p = p || {};
  var item = await findItem(id);
  if (item.kind !== 'material') fail('invalid', 'Only materials are issued; tools and equipment are checked out.');
  if (item.status === 'retired') fail('invalid', item.name + ' is retired.');
  var qty = quantity(p.quantity);
  var employeeId = null;
  if (p.employeeId) {
    var emp = (await pool.query('SELECT id FROM employees WHERE id = $1', [p.employeeId])).rows[0];
    if (!emp) fail('invalid', 'That employee was not found.');
    employeeId = emp.id;
  }
  var res = await pool.query(
    'UPDATE tool_room_items SET quantity_on_hand = quantity_on_hand - $1, updated_at = now() WHERE id = $2 AND quantity_on_hand >= $1 RETURNING *',
    [qty, id]
  );
  if (!res.rows[0]) fail('invalid', 'Only ' + Number(item.quantity_on_hand) + ' ' + item.unit + ' of ' + item.name + ' are on the shelf.');
  await logMove(ctx, id, 'issue', { employeeId: employeeId, quantity: qty, note: note(p.note) });
  await audit(pool, ctx, 'toolroom.issue', 'tool_room_item', id, 'Issued ' + qty + ' ' + item.unit + ' of ' + item.code + '.');
  return rowToItem(res.rows[0]);
}

async function restock(ctx, id, p) {
  if (!ctx.can('toolroom.manage')) fail('forbidden', 'Your role does not allow this action (toolroom.manage).');
  p = p || {};
  var item = await findItem(id);
  if (item.kind !== 'material') fail('invalid', 'Only materials are restocked.');
  var qty = quantity(p.quantity);
  var res = await pool.query('UPDATE tool_room_items SET quantity_on_hand = quantity_on_hand + $1, updated_at = now() WHERE id = $2 RETURNING *', [qty, id]);
  await logMove(ctx, id, 'restock', { quantity: qty, note: note(p.note) });
  await audit(pool, ctx, 'toolroom.restock', 'tool_room_item', id, 'Restocked ' + qty + ' ' + item.unit + ' of ' + item.code + '.');
  return rowToItem(res.rows[0]);
}

// Retire an item that is no longer used (lost, broken beyond repair, used
// up), or bring it back. Its history stays.
async function setRetired(ctx, id, retired, p) {
  if (!ctx.can('toolroom.manage')) fail('forbidden', 'Your role does not allow this action (toolroom.manage).');
  var item = await findItem(id);
  if (retired && item.status === 'checked_out') fail('invalid', 'Check ' + item.name + ' back in before retiring it.');
  if (retired === (item.status === 'retired')) return rowToItem(item);
  var res = await pool.query('UPDATE tool_room_items SET status = $1, updated_at = now() WHERE id = $2 RETURNING *', [retired ? 'retired' : 'available', id]);
  await logMove(ctx, id, retired ? 'retire' : 'restore', { note: note(p && p.note) });
  await audit(pool, ctx, retired ? 'toolroom.retire' : 'toolroom.restore', 'tool_room_item', id, (retired ? 'Retired ' : 'Brought back ') + item.code + '.');
  return rowToItem(res.rows[0]);
}

module.exports = {
  list: list, history: history, create: create, update: update, setCheckout: setCheckout,
  checkout: checkout, checkin: checkin, issue: issue, restock: restock, setRetired: setRetired
};
