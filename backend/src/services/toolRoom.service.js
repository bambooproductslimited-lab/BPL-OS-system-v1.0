var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

// Tool room inventory: tools, equipment and materials kept in the factory's
// tool room — separate from the finished-goods Products & Inventory module.
// Tools/equipment are tracked as individual items that can be checked out
// to an employee; materials are tracked by quantity_on_hand/reorder_level
// like Products, just in this module instead (they're consumables the tool
// room issues, not stock the company sells).

function rowToItem(r, extra) {
  return Object.assign({
    id: r.id, code: r.code, name: r.name, kind: r.kind, category: r.category, unit: r.unit,
    quantityOnHand: Number(r.quantity_on_hand), reorderLevel: Number(r.reorder_level), condition: r.condition,
    location: r.location, checkedOutTo: r.checked_out_to, status: r.status, notes: r.notes
  }, extra || {});
}

async function list(ctx) {
  if (!ctx.can('toolroom.read')) fail('forbidden', 'Your role does not allow this action (toolroom.read).');
  var res = await pool.query(
    'SELECT t.*, e.first_name, e.last_name FROM tool_room_items t LEFT JOIN employees e ON e.id = t.checked_out_to ORDER BY t.code'
  );
  return res.rows.map(function (r) {
    return rowToItem(r, {
      checkedOutToName: r.first_name ? r.first_name + ' ' + r.last_name : null,
      lowStock: r.kind === 'material' && Number(r.quantity_on_hand) <= Number(r.reorder_level)
    });
  });
}

async function create(ctx, p) {
  if (!ctx.can('toolroom.manage')) fail('forbidden', 'Your role does not allow this action (toolroom.manage).');
  var code = V.text(p.code, 'Code', 30).toUpperCase();
  var name = V.text(p.name, 'Name', 100);
  var kind = V.oneOf(p.kind || 'tool', ['tool', 'equipment', 'material'], 'Kind');

  var existing = await pool.query('SELECT id FROM tool_room_items WHERE code = $1', [code]);
  if (existing.rows[0]) fail('invalid', 'That code already exists.');

  var res = await pool.query(
    "INSERT INTO tool_room_items (code, name, kind, category, unit, quantity_on_hand, reorder_level, condition, location, status) " +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'available') RETURNING *",
    [code, name, kind, (p.category || '').trim(), p.unit || 'each', Math.max(0, Number(p.quantityOnHand) || 0),
      Math.max(0, Number(p.reorderLevel) || 0), p.condition || 'good', (p.location || 'Tool room').trim()]
  );
  var item = res.rows[0];
  await audit(pool, ctx, 'toolroom.create', 'tool_room_item', item.id, 'Added ' + kind + ' ' + item.code + ' — ' + item.name + '.');
  return rowToItem(item);
}

async function update(ctx, id, p) {
  if (!ctx.can('toolroom.manage')) fail('forbidden', 'Your role does not allow this action (toolroom.manage).');
  var existing = await pool.query('SELECT * FROM tool_room_items WHERE id = $1', [id]);
  if (!existing.rows[0]) fail('notfound', 'Item not found.');

  var name = V.text(p.name, 'Name', 100);
  var category = (p.category || '').trim();
  var quantityOnHand = Math.max(0, Number(p.quantityOnHand) || 0);
  var reorderLevel = Math.max(0, Number(p.reorderLevel) || 0);
  var condition = V.oneOf(p.condition || 'good', ['good', 'fair', 'poor', 'under_repair'], 'Condition');
  var location = (p.location || 'Tool room').trim();

  var res = await pool.query(
    'UPDATE tool_room_items SET name = $1, category = $2, unit = $3, quantity_on_hand = $4, reorder_level = $5, condition = $6, location = $7, notes = $8 WHERE id = $9 RETURNING *',
    [name, category, p.unit || existing.rows[0].unit, quantityOnHand, reorderLevel, condition, location, (p.notes || '').trim(), id]
  );
  var item = res.rows[0];
  await audit(pool, ctx, 'toolroom.update', 'tool_room_item', item.id, 'Updated ' + item.code + '.');
  return rowToItem(item);
}

// Check a tool/equipment item out to an employee, or back in (employeeId null).
async function setCheckout(ctx, id, employeeId) {
  if (!ctx.can('toolroom.manage')) fail('forbidden', 'Your role does not allow this action (toolroom.manage).');
  var existing = await pool.query('SELECT * FROM tool_room_items WHERE id = $1', [id]);
  var item = existing.rows[0];
  if (!item) fail('notfound', 'Item not found.');
  if (item.kind === 'material') fail('invalid', 'Materials are tracked by quantity, not check-out.');

  var status = employeeId ? 'checked_out' : 'available';
  var res = await pool.query(
    'UPDATE tool_room_items SET checked_out_to = $1, status = $2 WHERE id = $3 RETURNING *',
    [employeeId || null, status, id]
  );
  var updated = res.rows[0];
  await audit(pool, ctx, 'toolroom.checkout', 'tool_room_item', updated.id, (employeeId ? 'Checked out ' : 'Checked in ') + updated.code + '.');
  return rowToItem(updated);
}

module.exports = { list: list, create: create, update: update, setCheckout: setCheckout };
