var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');

// Employee IDs (employees.code). New people get the next BPL-nnn unless an ID
// is given; an ID can be changed on the record, or set for many people at
// once from a pasted list of IDs and names (e.g. the TimeStation sheet):
// preview() matches each name to one person, apply() sets the chosen ones.

// Trimmed, upper case, no spaces: letters, numbers and dashes, up to 20.
function normalize(v) {
  var t = String(v == null ? '' : v).replace(/\s+/g, '').toUpperCase();
  if (!t) fail('invalid', 'Give an employee ID.');
  if (!/^[A-Z0-9][A-Z0-9-]{0,19}$/.test(t)) fail('invalid', 'An employee ID can only have letters, numbers and dashes (up to 20).');
  return t;
}

// Who else already has this ID, if anyone.
async function holder(q, code, exceptId) {
  return (await q.query('SELECT id, first_name, last_name FROM employees WHERE upper(code) = $1 AND ($2::uuid IS NULL OR id <> $2)', [code, exceptId || null])).rows[0] || null;
}
async function mustBeFree(q, code, exceptId) {
  var h = await holder(q, code, exceptId);
  if (h) fail('conflict', 'Employee ID ' + code + ' is already ' + h.first_name + ' ' + h.last_name + '\'s.');
}

// The next free BPL-nnn: one after the highest in use, so a merge or a
// changed ID never makes it pick one that is taken.
async function next(q) {
  q = q || pool;
  var r = await q.query("SELECT COALESCE(MAX(substring(code from 5)::int), 0) AS n FROM employees WHERE code ~ '^BPL-[0-9]{1,9}$'");
  var n = r.rows[0].n + 1;
  for (;;) {
    var code = 'BPL-' + String(n).padStart(3, '0');
    if (!(await holder(q, code, null))) return code;
    n++;
  }
}

// ── set IDs from a list ──────────────────────────────────────────────
// Names compare as words in any order, ignoring case, accents and marks:
// "Abrokwah Priscilla" is "Priscilla Abrokwah", "James" is "James —".
function words(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .split(/[^a-z0-9]+/).filter(Boolean).sort();
}
function same(a, b) { return a.length === b.length && a.every(function (w, i) { return w === b[i]; }); }
function within(a, b) { return a.every(function (w) { return b.indexOf(w) >= 0; }); }

// One line of the paste: an ID (has a digit, no spaces) and a name, either
// way round, split by tabs, commas or semicolons, or just spaces.
function parseLine(line) {
  var cells = line.split(/\t|;|,/).map(function (c) { return c.trim(); }).filter(Boolean);
  var id = null, name = [];
  if (cells.length > 1) {
    cells.forEach(function (c) { if (!id && /\d/.test(c) && !/\s/.test(c)) id = c; else name.push(c); });
  } else {
    var parts = line.trim().split(/\s+/);
    if (parts.length > 1 && /\d/.test(parts[0])) { id = parts[0]; name = parts.slice(1); }
    else if (parts.length > 1 && /\d/.test(parts[parts.length - 1])) { id = parts[parts.length - 1]; name = parts.slice(0, -1); }
  }
  name = name.join(' ').trim();
  return id && name ? { code: id, name: name } : null;
}

function person(e) {
  return { id: e.id, code: e.code, name: (e.first_name + ' ' + e.last_name).trim(), positionTitle: e.position_title || '', status: e.status };
}

// POST /api/employees/codes/preview { text }
async function preview(ctx, text) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  var lines = String(text || '').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
  if (!lines.length) fail('invalid', 'Paste the list of IDs and names first.');
  if (lines.length > 2000) fail('invalid', 'That is more than 2,000 lines; paste it in parts.');

  // Terminated records keep their history but don't take new IDs.
  var staff = (await pool.query("SELECT id, code, first_name, last_name, position_title, status FROM employees WHERE status <> 'terminated' ORDER BY first_name, last_name")).rows
    .map(function (e) { return Object.assign(person(e), { words: words(e.first_name + ' ' + e.last_name) }); });
  var all = (await pool.query('SELECT id, code, first_name, last_name, status FROM employees')).rows;
  var byCode = {};
  all.forEach(function (e) { byCode[String(e.code).toUpperCase()] = e; });

  var skipped = [], rows = [];
  lines.forEach(function (line) {
    var r = parseLine(line);
    if (!r) { skipped.push(line); return; }
    var code;
    try { code = normalize(r.code); } catch (e) { skipped.push(line); return; }
    var w = words(r.name);
    rows.push({ code: code, name: r.name, words: w, exact: staff.filter(function (s) { return w.length && same(s.words, w); }) });
  });

  // Someone matched exactly by one line isn't offered to the others as a maybe.
  var taken = {};
  rows.forEach(function (r) { if (r.exact.length === 1) taken[r.exact[0].id] = true; });
  var codeCount = {};
  rows.forEach(function (r) { codeCount[r.code] = (codeCount[r.code] || 0) + 1; });

  var out = rows.map(function (r) {
    var status, candidates = [];
    if (r.exact.length === 1) { status = 'match'; candidates = r.exact; }
    else if (r.exact.length > 1) { status = 'several'; candidates = r.exact; }
    else {
      candidates = staff.filter(function (s) { return !taken[s.id] && r.words.length && s.words.length && (within(r.words, s.words) || within(s.words, r.words)); });
      status = candidates.length ? 'maybe' : 'none';
    }
    var h = byCode[r.code];
    return {
      code: r.code, name: r.name, status: status,
      candidates: candidates.map(function (c) { return { id: c.id, code: c.code, name: c.name, positionTitle: c.positionTitle, status: c.status }; }),
      holder: h ? { id: h.id, code: h.code, name: (h.first_name + ' ' + h.last_name).trim(), terminated: h.status === 'terminated' } : null,
      repeated: codeCount[r.code] > 1
    };
  });
  return { rows: out, skipped: skipped };
}

// POST /api/employees/codes/apply { changes: [{ employeeId, code }] }
// All or nothing. IDs can swap between people in the same batch.
async function apply(ctx, changes) {
  if (!ctx.can('employee.write')) fail('forbidden', 'Your role does not allow this action (employee.write).');
  if (!Array.isArray(changes) || !changes.length) fail('invalid', 'Choose at least one person to give an ID to.');
  if (changes.length > 2000) fail('invalid', 'Too many at once.');
  var seenEmp = {}, seenCode = {};
  var list = changes.map(function (c) {
    var code = normalize(c && c.code);
    var id = String((c && c.employeeId) || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) fail('invalid', 'Choose who gets ID ' + code + '.');
    if (seenEmp[id]) fail('invalid', 'The same person was chosen twice.');
    if (seenCode[code]) fail('invalid', 'ID ' + code + ' is given to two people.');
    seenEmp[id] = seenCode[code] = true;
    return { id: id, code: code };
  });

  return withTransaction(async function (client) {
    var found = (await client.query("SELECT id, code, first_name, last_name, status FROM employees WHERE id = ANY($1::uuid[])", [list.map(function (c) { return c.id; })])).rows;
    var byId = {};
    found.forEach(function (e) { byId[e.id] = e; });
    list.forEach(function (c) {
      var e = byId[c.id];
      if (!e) fail('notfound', 'One of the people chosen is no longer in the directory.');
      if (e.status === 'terminated') fail('invalid', e.first_name + ' ' + e.last_name + ' has left; their ID stays as it is.');
    });
    var changing = list.filter(function (c) { return String(byId[c.id].code).toUpperCase() !== c.code; });
    // An ID held by someone outside this batch stays theirs.
    for (var i = 0; i < changing.length; i++) {
      var h = await holder(client, changing[i].code, changing[i].id);
      if (h && !seenEmp[h.id]) fail('conflict', 'Employee ID ' + changing[i].code + ' is already ' + h.first_name + ' ' + h.last_name + '\'s.');
    }
    // Step aside first so swaps within the batch don't collide.
    for (var j = 0; j < changing.length; j++) {
      await client.query("UPDATE employees SET code = '~' || id::text WHERE id = $1", [changing[j].id]);
    }
    for (var k = 0; k < changing.length; k++) {
      var c = changing[k], e = byId[c.id];
      await client.query('UPDATE employees SET code = $2, updated_at = now() WHERE id = $1', [c.id, c.code]);
      await audit(client, ctx, 'employee.update', 'employee', c.id, 'Employee ID of ' + e.first_name + ' ' + e.last_name + ' changed from ' + e.code + ' to ' + c.code + '.');
    }
    return { updated: changing.length, unchanged: list.length - changing.length };
  });
}

module.exports = { normalize: normalize, mustBeFree: mustBeFree, next: next, preview: preview, apply: apply, parseLine: parseLine, words: words, same: same };
