var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { parseCsvBuffer, field, parseIntLoose, parseDateLoose } = require('../lib/csvImport');

// Import from the IT department's own tracking sheet. The sheet's shape
// doesn't match it_devices 1:1: one sheet row is a device MODEL in a given
// state/location with a Total/In-Use count (e.g. "iPad Air 2, Total 2,
// In-Use 2, BG1"), not one physical device. it_devices has no quantity
// concept — each row is one serial-tagged unit — so a sheet row with
// Total > 1 is expanded into that many individual device records here,
// all sharing brand/model/status/location, distinguished only by an
// auto-generated device tag. The original sheet row's Total/In-Use and
// its own "ID" column are kept in notes for traceability back to the
// source row.
//
// "Username" / "Open Pass" columns are device login credentials (mostly
// short numeric passcodes in the real sheet). They are NOT imported by
// default — importing plaintext credentials into a database multiple
// staff can read is the kind of thing that should be an explicit choice,
// not a silent default. Passing includeCredentials: true opts in.

var STATUS_ALIASES = {
  deployed: 'in_use', 'in use': 'in_use', active: 'in_use', issued: 'in_use',
  inventory: 'in_storage', storage: 'in_storage', 'in storage': 'in_storage', stock: 'in_storage', spare: 'in_storage',
  repair: 'under_repair', 'under repair': 'under_repair', 'being repaired': 'under_repair', broken: 'under_repair',
  retired: 'retired', decommissioned: 'retired', disposed: 'retired',
  lost: 'lost', missing: 'lost', stolen: 'lost'
};

function mapStatus(raw) {
  var key = String(raw || '').trim().toLowerCase();
  if (STATUS_ALIASES[key]) return { value: STATUS_ALIASES[key], recognized: true };
  return { value: 'in_storage', recognized: !key };
}

function buildEmployeeIndex(employees) {
  // Only match on names of 3+ characters so short/common fragments (e.g.
  // "Ad") don't cause false matches against unrelated "Who/Where?" text.
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

async function preview(ctx, buffer, opts) {
  if (!ctx.can('itdevice.manage')) fail('forbidden', 'Your role does not allow this action (itdevice.manage).');
  var includeCredentials = !!(opts && opts.includeCredentials);

  var rows = parseCsvBuffer(buffer);
  if (!rows.length) fail('invalid', 'That file has no data rows.');

  var empRes = await pool.query('SELECT id, first_name, last_name FROM employees WHERE status <> $1', ['terminated']);
  var empIndex = buildEmployeeIndex(empRes.rows);

  var existingTagsRes = await pool.query('SELECT device_tag FROM it_devices');
  var existingTags = new Set(existingTagsRes.rows.map(function (r) { return r.device_tag; }));

  var out = [];
  var seenTags = new Set();

  rows.forEach(function (row, rowIdx) {
    var n = row.norm;
    var sourceId = field(n, ['id']) || String(rowIdx + 1);
    var brand = field(n, ['brand']);
    var device = field(n, ['device']);
    var model = field(n, ['model']);
    var total = Math.max(1, Math.min(200, parseIntLoose(field(n, ['total']), 1)));
    var inUse = parseIntLoose(field(n, ['inuse']), null);
    var statusRaw = field(n, ['status']);
    var whoWhere = field(n, ['whowhere', 'who', 'where']);
    var number = field(n, ['number']);
    var username = field(n, ['username']);
    var openPass = field(n, ['openpass', 'openpassword', 'passcode', 'password']);
    var link = field(n, ['link']);
    var remark = field(n, ['remark', 'remarks', 'notes']);
    var lastChecked = field(n, ['lastcheckeddateec', 'lastcheckeddate', 'lastchecked']);
    var dateReceived = parseDateLoose(field(n, ['datereceive', 'datereceived', 'daterecieve', 'daterecieved']));

    if (!brand && !device && !model) return; // blank spreadsheet row — skip silently, not an error

    var statusMap = mapStatus(statusRaw);
    var assignedEmployeeId = matchEmployee(whoWhere, empIndex);

    for (var unit = 1; unit <= total; unit++) {
      var deviceTag = 'IT-' + sourceId + (total > 1 ? '-' + unit : '');
      var warnings = [];
      if (!statusMap.recognized && statusRaw) warnings.push('Unrecognized status "' + statusRaw + '" — imported as In storage; review after import.');
      if (!statusRaw) warnings.push('No status in sheet — imported as In storage.');
      if (whoWhere && !assignedEmployeeId) warnings.push('"' + whoWhere + '" didn’t match one employee uniquely — kept as location text only, not assigned.');
      if (existingTags.has(deviceTag) || seenTags.has(deviceTag)) {
        warnings.push('Device tag ' + deviceTag + ' already exists — this unit will be skipped on import.');
      }
      seenTags.add(deviceTag);

      var noteParts = [];
      if (remark) noteParts.push(remark);
      if (link) noteParts.push('Link: ' + link);
      if (lastChecked) noteParts.push('Last checked: ' + lastChecked);
      if (includeCredentials && (username || openPass)) {
        noteParts.push('Login: ' + (username ? 'user "' + username + '"' : '') + (username && openPass ? ', ' : '') + (openPass ? 'passcode "' + openPass + '"' : ''));
      }
      noteParts.push('Imported from IT sheet, row ' + sourceId + (total > 1 ? ' (unit ' + unit + ' of ' + total + (inUse != null ? ', ' + inUse + ' in use' : '') + ')' : ''));

      out.push({
        deviceTag: deviceTag,
        category: device,
        brand: brand,
        model: model,
        serialNumber: number && number !== '-' ? number : '',
        assignedEmployeeId: assignedEmployeeId,
        location: !assignedEmployeeId ? whoWhere : '',
        purchaseDate: dateReceived,
        condition: 'good',
        status: statusMap.value,
        notes: noteParts.join(' — '),
        sourceRow: sourceId,
        willSkip: existingTags.has(deviceTag) || false,
        warnings: warnings
      });
    }
  });

  return { rows: out, includeCredentials: includeCredentials };
}

async function commit(ctx, rows) {
  if (!ctx.can('itdevice.manage')) fail('forbidden', 'Your role does not allow this action (itdevice.manage).');
  if (!Array.isArray(rows) || !rows.length) fail('invalid', 'Nothing to import.');

  var existingTagsRes = await pool.query('SELECT device_tag FROM it_devices');
  var existingTags = new Set(existingTagsRes.rows.map(function (r) { return r.device_tag; }));

  var created = 0, skipped = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var deviceTag = String(r.deviceTag || '').trim().toUpperCase();
    if (!deviceTag || existingTags.has(deviceTag)) { skipped++; continue; }
    existingTags.add(deviceTag);
    await pool.query(
      "INSERT INTO it_devices (device_tag, category, brand, model, serial_number, assigned_employee_id, location, purchase_date, condition, status, notes) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [deviceTag, (r.category || '').trim(), (r.brand || '').trim(), (r.model || '').trim(), (r.serialNumber || '').trim(),
        r.assignedEmployeeId || null, (r.location || '').trim(), r.purchaseDate || null, r.condition || 'good',
        r.status || 'in_storage', (r.notes || '').trim()]
    );
    created++;
  }

  await audit(pool, ctx, 'itdevice.import', 'it_device', 'bulk', 'Imported ' + created + ' device(s) from IT inventory sheet' + (skipped ? ' (' + skipped + ' skipped — duplicate tag)' : '') + '.');
  return { created: created, skipped: skipped };
}

module.exports = { preview: preview, commit: commit };
