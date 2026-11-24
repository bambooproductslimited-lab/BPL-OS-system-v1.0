var ExcelJS = require('exceljs');
var { parse } = require('csv-parse/sync');
var { fail } = require('../utils/errors');

// Contacts from whatever people bring back from a fair or an event, for
// services/crmLeadGroups.service.js: a spreadsheet (.xlsx or .csv) with any
// column headings, a phone's contacts exported as a .vcf file, or a list
// pasted from anywhere (a sheet, a WhatsApp message, a typed list). Each
// becomes { name, company, phone, email, location, interest, notes }.
//
// Columns are recognised by their headings, spelt however the sheet spells
// them ("Full Name", "Tel.", "Organisation", "Interested in"). A list with
// no headings is read cell by cell: an email is an email, a phone number is
// a phone number, the first words left are the name and the next the
// company. Within a cell, a phone number or an email written after the name
// ("Kofi Mensah 024 412 3456") is taken out of it.

var MAX_ROWS = 2000;

function normHeader(h) { return String(h == null ? '' : h).trim().toLowerCase().replace(/[^a-z0-9]/g, ''); }

var COLS = {
  name: ['name', 'names', 'fullname', 'contactname', 'contactperson', 'customername', 'prospectname', 'visitorname', 'clientname', 'person', 'nameofcontact', 'participant', 'attendee', 'yourname'],
  first: ['firstname', 'givenname', 'first', 'othernames', 'forename'],
  last: ['lastname', 'surname', 'familyname', 'last'],
  company: ['company', 'companyname', 'organisation', 'organization', 'organisationname', 'organizationname', 'business', 'businessname', 'firm', 'org', 'institution', 'companyorganisation', 'companyorganization', 'employer', 'brand'],
  phone: ['phone', 'phonenumber', 'phoneno', 'tel', 'telephone', 'telephonenumber', 'mobile', 'mobilenumber', 'mobileno', 'contactnumber', 'contactno', 'whatsapp', 'whatsappnumber', 'whatsappno', 'cell', 'cellphone', 'number', 'phone1', 'tel1', 'telno', 'mobilephone'],
  phone2: ['phone2', 'mobile2', 'tel2', 'otherphone', 'alternativephone', 'altphone', 'secondphone', 'officephone', 'workphone'],
  email: ['email', 'emailaddress', 'mail', 'emailid', 'email1', 'eemail'],
  location: ['location', 'city', 'town', 'address', 'region', 'area', 'country', 'place', 'residence', 'district'],
  interest: ['interest', 'interests', 'interestedin', 'productofinterest', 'productsofinterest', 'product', 'products', 'item', 'items', 'need', 'needs', 'enquiry', 'inquiry', 'lookingfor', 'requirement', 'requirements', 'whattheywant', 'service', 'services'],
  title: ['title', 'position', 'jobtitle', 'role', 'designation', 'occupation', 'profession'],
  website: ['website', 'web', 'url', 'site', 'webaddress'],
  notes: ['notes', 'note', 'comments', 'comment', 'remarks', 'remark', 'feedback', 'details', 'description', 'followup', 'followupnotes'],
  contact: ['contact', 'contacts', 'contactdetails', 'contactinfo', 'contactinformation']
};
var FIELD_OF = {};
Object.keys(COLS).forEach(function (f) { COLS[f].forEach(function (h) { FIELD_OF[h] = f; }); });
// Headings to leave out: a row number, a date, a signature.
var SKIP = { sn: 1, no: 1, sno: 1, serialno: 1, serialnumber: 1, number_: 1, date: 1, signature: 1, sign: 1, time: 1, timestamp: 1 };

function fieldOfHeader(h) {
  var n = normHeader(h);
  if (!n || SKIP[n]) return null;
  if (FIELD_OF[n]) return FIELD_OF[n];
  // "Phone Number (WhatsApp)", "Email of contact", "Company / Organisation".
  var order = ['email', 'phone2', 'phone', 'company', 'first', 'last', 'name', 'interest', 'location', 'title', 'website', 'notes', 'contact'];
  for (var i = 0; i < order.length; i++) {
    var f = order[i];
    for (var j = 0; j < COLS[f].length; j++) {
      var a = COLS[f][j];
      if (a.length >= 4 && n.indexOf(a) === 0) return f;
    }
  }
  return null;
}

var EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
var PHONE_RE = /(?:\+|00)?\d[\d\s\-().]{7,}\d/g;
function digitsOf(s) { return String(s || '').replace(/\D/g, ''); }
function looksLikePhone(s) {
  var t = String(s || '').trim();
  var d = digitsOf(t);
  return d.length >= 9 && d.length <= 15 && d.length / t.replace(/\s/g, '').length >= 0.7;
}
// The same number however it is written: 0244 123 456, +233 24 412 3456, 233244123456.
function phoneKey(s) {
  var d = digitsOf(s);
  if (d.indexOf('00') === 0) d = d.slice(2);
  return d.length >= 9 ? d.slice(-9) : '';
}
function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    if ('result' in v) return cellText(v.result);
    if (Array.isArray(v.richText)) return v.richText.map(function (t) { return t.text; }).join('');
    if ('text' in v) return String(v.text);
    if ('hyperlink' in v) return String(v.hyperlink).replace(/^mailto:/, '');
    return '';
  }
  return String(v);
}
// A number saved as a number loses its leading 0 (244123456 for 0244123456).
function fixPhone(s) {
  var t = clean(s);
  if (/^\d{9}$/.test(t) && /^[2-5]/.test(t)) return '0' + t;
  return t;
}

// Takes the emails and phone numbers out of a piece of text; what is left
// is words.
function pull(text, into) {
  var rest = String(text || '');
  rest = rest.replace(EMAIL_RE, function (m) { into.emails.push(m); return ' '; });
  rest = rest.replace(PHONE_RE, function (m) { if (looksLikePhone(m)) { into.phones.push(clean(m)); return ' '; } return m; });
  return clean(rest.replace(/^[\s,;:|/-]+|[\s,;:|/-]+$/g, ''));
}

function finish(c) {
  var out = {
    name: clean(c.name).slice(0, 120), company: clean(c.company).slice(0, 120),
    phone: fixPhone(c.phones[0] || '').slice(0, 40), email: clean(c.emails[0] || '').toLowerCase().slice(0, 120),
    location: clean(c.location).slice(0, 120), interest: clean(c.interest).slice(0, 200), notes: ''
  };
  var notes = [];
  if (c.title) notes.push('Position: ' + clean(c.title));
  if (c.phones.length > 1) notes.push('Other phone: ' + c.phones.slice(1).map(fixPhone).join(', '));
  if (c.emails.length > 1) notes.push('Other email: ' + c.emails.slice(1).join(', '));
  if (c.website) notes.push('Website: ' + clean(c.website));
  if (c.extra.length) notes.push(c.extra.map(clean).filter(Boolean).join(' · '));
  if (c.notes) notes.push(clean(c.notes));
  out.notes = notes.filter(Boolean).join('\n').slice(0, 2000);
  return out;
}
function blank() { return { name: '', company: '', phones: [], emails: [], location: '', interest: '', title: '', website: '', notes: '', extra: [] }; }

// One row of a table with headings.
function fromColumns(cells, fields) {
  var c = blank(), first = '', last = '';
  cells.forEach(function (raw, i) {
    var f = fields[i];
    var v = clean(cellText(raw));
    if (!v || !f) return;
    if (f === 'email') { pull(v, c); if (!c.emails.length) c.extra.push(v); return; }
    if (f === 'phone' || f === 'phone2') { var left = pull(v, c); if (left) c.extra.push(left); return; }
    if (f === 'contact') { var w = pull(v, c); if (w && !c.name) c.name = w; else if (w) c.extra.push(w); return; }
    if (f === 'first') { first = v; return; }
    if (f === 'last') { last = v; return; }
    if (f === 'name') { var nm = pull(v, c); c.name = c.name ? c.name + ' ' + nm : nm; return; }
    if (f === 'notes') { c.notes = c.notes ? c.notes + ' · ' + v : v; return; }
    c[f] = c[f] ? c[f] + ', ' + v : v;
  });
  if (!c.name && (first || last)) c.name = clean(first + ' ' + last);
  return finish(c);
}

// One row, or one line, with no headings.
function fromCells(cells) {
  var c = blank(), words = [];
  cells.forEach(function (raw) {
    var w = pull(cellText(raw), c);
    if (w) words.push(w);
  });
  c.name = words[0] || '';
  c.company = words[1] || '';
  c.extra = words.slice(2);
  return finish(c);
}

// The heading row: among the top ten rows, the one with the most known
// headings — a name, phone, email or company one among them, at least one
// spelt exactly or two in all, and no phone number or email in it (a
// contact's row is not a heading row).
var EMAIL_ONE = /[^@\s]+@[^@\s]+\.[a-z]{2,}/i;
function findHeader(rows) {
  var best = -1, bestN = 0;
  for (var i = 0; i < Math.min(rows.length, 10); i++) {
    var heads = rows[i].map(function (h) { return cellText(h); });
    var fields = heads.map(fieldOfHeader);
    var n = fields.filter(Boolean).length;
    var exact = heads.filter(function (h) { return FIELD_OF[normHeader(h)]; }).length;
    var key = fields.some(function (f) { return f === 'name' || f === 'phone' || f === 'email' || f === 'first' || f === 'company' || f === 'contact'; });
    var contactish = heads.some(function (h) { return looksLikePhone(h) || EMAIL_ONE.test(h); });
    if (!contactish && key && (exact >= 1 || n >= 2) && n > bestN) { best = i; bestN = n; if (n >= 2) break; }
  }
  return best;
}

function fromTable(rows) {
  rows = rows.filter(function (r) { return r.some(function (v) { return clean(cellText(v)); }); });
  var h = findHeader(rows);
  var columns = [];
  var contacts;
  if (h >= 0) {
    var fields = rows[h].map(function (x) { return fieldOfHeader(cellText(x)); });
    columns = rows[h].map(function (x, i) { return { heading: clean(cellText(x)), field: fields[i] }; }).filter(function (c) { return c.heading; });
    contacts = rows.slice(h + 1).map(function (r) { return fromColumns(r, fields); });
  } else {
    contacts = rows.map(fromCells);
  }
  // A numbered sign-up sheet's unused rows: nothing but the number.
  contacts = contacts.filter(function (c) { return c.name || c.company || c.phone || c.email || c.location || c.interest || c.notes; });
  return { columns: columns, contacts: contacts };
}

// ── vCard (.vcf): a phone's contacts ─────────────────────────────────
function qp(s) {
  var bytes = [];
  s = s.replace(/=\r?\n/g, '');
  for (var i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-F]{2}$/i.test(s.substr(i + 1, 2))) { bytes.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; } else bytes.push(s.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes).toString('utf8');
}
function unescapeV(s) { return String(s).replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1'); }
function fromVcf(text) {
  // Long lines are folded: a line starting with a space goes on the one before.
  var lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  // Quoted-printable soft line breaks end in "=".
  var joined = [];
  lines.forEach(function (l) { if (joined.length && /ENCODING=QUOTED-PRINTABLE/i.test(joined[joined.length - 1]) && /=$/.test(joined[joined.length - 1])) joined[joined.length - 1] = joined[joined.length - 1].slice(0, -1) + l; else joined.push(l); });
  var contacts = [], c = null, fn = '', n = '';
  joined.forEach(function (line) {
    var m = /^([^:]+):(.*)$/.exec(line);
    if (!m) return;
    var head = m[1], value = m[2];
    var parts = head.split(';');
    var prop = parts[0].replace(/^[^.]*\./, '').toUpperCase();
    if (/ENCODING=QUOTED-PRINTABLE/i.test(head)) value = qp(value);
    if (prop === 'BEGIN' && /VCARD/i.test(value)) { c = blank(); fn = ''; n = ''; return; }
    if (!c) return;
    if (prop === 'END') {
      var np = n.split(';');
      c.name = clean(fn) || clean([np[1], np[2], np[0]].filter(Boolean).join(' '));
      contacts.push(finish(c)); c = null; return;
    }
    var v = unescapeV(value);
    if (prop === 'FN') fn = v;
    else if (prop === 'N') n = value.split(';').map(unescapeV).join(';');
    else if (prop === 'ORG') c.company = clean(value.split(';').map(unescapeV).filter(Boolean).join(', '));
    else if (prop === 'TEL') { if (clean(v)) c.phones.push(clean(v.replace(/^tel:/i, ''))); }
    else if (prop === 'EMAIL') { if (clean(v)) c.emails.push(clean(v)); }
    else if (prop === 'ADR') { if (!c.location) c.location = clean(value.split(';').map(unescapeV).filter(function (x) { return clean(x); }).join(', ')); }
    else if (prop === 'TITLE' || prop === 'ROLE') { if (!c.title) c.title = v; }
    else if (prop === 'URL') { if (!c.website) c.website = v; }
    else if (prop === 'NOTE') c.notes = c.notes ? c.notes + ' · ' + v : v;
  });
  return { columns: [], contacts: contacts };
}

// ── pasted text ─────────────────────────────────────────────────────
function fromText(text) {
  var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').filter(function (l) { return clean(l); });
  var tabbed = lines.some(function (l) { return l.indexOf('\t') >= 0; });
  var rows = lines.map(function (l) {
    if (tabbed) return l.split('\t');
    // "Kofi Mensah, Mensah Ltd, 024 412 3456" or "Kofi Mensah; 0244123456".
    return l.split(/\s*[;,|]\s*/);
  });
  return fromTable(rows);
}

async function fromXlsx(buffer) {
  var wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch (e) { fail('invalid', 'That file could not be read as an Excel workbook. Save it as .xlsx (or .csv) and try again.'); }
  // The sheet with the most rows that look like contacts.
  var best = null;
  wb.worksheets.forEach(function (ws) {
    var rows = [];
    ws.eachRow({ includeEmpty: false }, function (row) {
      if (rows.length > MAX_ROWS + 10) return;
      rows.push(Array.from(row.values).slice(1));
    });
    var t = fromTable(rows);
    var good = t.contacts.filter(function (c) { return c.name || c.phone || c.email; }).length;
    if (!best || good > best.good) best = { good: good, table: t, sheet: ws.name };
  });
  if (!best) fail('invalid', 'That workbook has no sheets.');
  best.table.sheet = best.sheet;
  return best.table;
}

function fromCsv(buffer) {
  var text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  var rows;
  try { rows = parse(text, { relax_column_count: true, skip_empty_lines: true, bom: true, relax_quotes: true, delimiter: [',', ';', '\t'] }); } catch (e) {
    fail('invalid', 'That file could not be read as CSV. Save the sheet as .xlsx or .csv and try again.');
  }
  return fromTable(rows);
}

function extOf(name) { var m = /\.([a-z0-9]+)$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; }

// file: a multer file (or none); text: what was pasted.
async function read(file, text) {
  var out, format;
  if (file && file.buffer && file.buffer.length) {
    var ext = extOf(file.originalname);
    if (ext === 'xlsx') { out = await fromXlsx(file.buffer); format = 'xlsx'; }
    else if (ext === 'csv' || ext === 'txt') { out = fromCsv(file.buffer); format = 'csv'; }
    else if (ext === 'vcf') { out = fromVcf(file.buffer.toString('utf8')); format = 'vcf'; }
    else fail('invalid', 'Choose an Excel (.xlsx), CSV (.csv) or contacts (.vcf) file.');
  } else if (clean(text)) {
    out = fromText(text); format = 'text';
  } else fail('invalid', 'Choose a file or paste the contacts first.');
  if (out.contacts.length > MAX_ROWS) fail('invalid', 'That is more than ' + MAX_ROWS + ' contacts. Split it into smaller files.');
  out.format = format;
  return out;
}

module.exports = { read: read, phoneKey: phoneKey, fieldOfHeader: fieldOfHeader, fromText: fromText, fromVcf: fromVcf, MAX_ROWS: MAX_ROWS };
