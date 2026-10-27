var crypto = require('crypto');
var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');
var fileStore = require('../lib/fileStore');

// Recruitment (People → Recruitment; migration 0198): job openings for any
// of the companies, shown on the jobs page (online.bplghana.com/jobs) while
// open; people apply there with their CV, or are added by hand (a walk-in, a
// referral). Each applicant moves through the stages — new, screening,
// interview (when and with whom), offer, hired or not — with a rating and
// notes; hired, they go into the employee directory in one step.

var KINDS = ['full_time', 'part_time', 'contract', 'internship', 'casual'];
var STAGES = ['new', 'screening', 'interview', 'offer', 'hired', 'rejected'];
var SOURCES = ['website', 'walk_in', 'referral', 'other'];
var DAY = /^\d{4}-\d{2}-\d{2}$/;
var MAX_CV = 3500 * 1024;
var PER_HOUR = 5; // applications from one address in an hour

function text(v, max) { return String(v == null ? '' : v).replace(/[ \t]+/g, ' ').trim().slice(0, max); }
function para(v, max) { return String(v == null ? '' : v).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, max); }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function nameOf(f, l) { return f ? (f + ' ' + (l || '')).trim() : null; }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function need(ctx) { if (!ctx.can('recruit.manage')) fail('forbidden', 'Your role does not allow this action (recruit.manage).'); }
function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '')); }
function slugOf(title) { return (String(title).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'job') + '-' + crypto.randomBytes(3).toString('hex'); }

// What a CV file is, by its first bytes: a PDF, a photo, or a Word document.
function cvType(buf, name) {
  var t = require('./shopQuotes.service').photoType(buf);
  if (t) return t;
  var head = buf.slice(0, 8);
  if (head.slice(0, 5).toString('latin1') === '%PDF-') return { type: 'application/pdf', ext: 'pdf' };
  if (head[0] === 0x50 && head[1] === 0x4b && /\.docx$/i.test(name || '')) return { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' };
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return { type: 'application/msword', ext: 'doc' };
  return null;
}
async function keepCv(dataUrl, name, who) {
  var m = /^data:[^;,]*;base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) fail('invalid', 'That CV did not come through: choose the file again.');
  var buf = Buffer.from(m[1], 'base64');
  if (!buf.length) fail('invalid', 'That file is empty.');
  if (buf.length > MAX_CV) fail('invalid', 'That CV is too big (3.5 MB at most).');
  var t = cvType(buf, name);
  if (!t) fail('invalid', 'Send your CV as a PDF, a Word document or a photo.');
  var base = ('cv-' + text(who, 40)).replace(/[^\w.-]+/g, '-').toLowerCase();
  return { key: await fileStore.put(base + '.' + t.ext, buf, t.type), type: t.type, name: base + '.' + t.ext, size: buf.length };
}

function openingOut(o, counts) {
  counts = counts || {};
  return {
    id: o.id, companyId: o.company_id, company: o.company_name, departmentId: o.department_id, department: o.department_name || '', title: o.title, slug: o.slug, location: o.location, kind: o.kind,
    description: o.description, requirements: o.requirements, pay: o.pay, closesOn: dayText(o.closes_on), status: o.status, createdAt: o.created_at,
    open: o.status === 'open' && (!o.closes_on || dayText(o.closes_on) >= today()),
    applicants: counts.n || 0, newOnes: counts.fresh || 0, byStage: STAGES.reduce(function (a, s) { a[s] = counts[s] || 0; return a; }, {})
  };
}
var OSEL = 'SELECT o.*, c.name AS company_name, c.code AS company_code, d.name AS department_name FROM job_openings o JOIN companies c ON c.id = o.company_id LEFT JOIN departments d ON d.id = o.department_id ';
async function openingOf(id) {
  var o = (await pool.query(OSEL + 'WHERE o.id = $1', [uuidOr(id)])).rows[0];
  if (!o) fail('notfound', 'That job is gone.');
  return o;
}
async function countsOf(ids) {
  var out = new Map();
  if (!ids.length) return out;
  (await pool.query("SELECT opening_id, stage, count(*)::int AS n FROM job_applicants WHERE opening_id = ANY($1::uuid[]) GROUP BY 1, 2", [ids])).rows.forEach(function (r) {
    var c = out.get(r.opening_id) || { n: 0, fresh: 0 };
    c[r.stage] = r.n; c.n += r.n; if (r.stage === 'new') c.fresh += r.n;
    out.set(r.opening_id, c);
  });
  return out;
}

function applicantOut(a, notes) {
  return {
    id: a.id, openingId: a.opening_id, opening: a.title ? { title: a.title, company: a.company_name } : null, name: a.name, email: a.email, phone: a.phone, note: a.note,
    cv: a.cv ? { name: a.cv.name, type: a.cv.type, size: a.cv.size } : null, source: a.source, stage: a.stage, rating: a.rating,
    interviewAt: a.interview_at, interviewer: a.interviewer_id ? { id: a.interviewer_id, name: nameOf(a.i_first, a.i_last) } : null,
    rejectReason: a.reject_reason, employeeId: a.employee_id, createdAt: a.created_at, updatedAt: a.updated_at,
    notes: notes || undefined
  };
}
var ASEL = 'SELECT a.*, o.title, c.name AS company_name, i.first_name AS i_first, i.last_name AS i_last FROM job_applicants a JOIN job_openings o ON o.id = a.opening_id JOIN companies c ON c.id = o.company_id LEFT JOIN employees i ON i.id = a.interviewer_id ';
async function applicantOf(id) {
  var a = (await pool.query(ASEL + 'WHERE a.id = $1', [uuidOr(id)])).rows[0];
  if (!a) fail('notfound', 'That applicant is gone.');
  return a;
}

// GET /api/recruitment
async function overview(ctx) {
  need(ctx);
  var rows = (await pool.query(OSEL + "ORDER BY (o.status = 'open') DESC, o.created_at DESC LIMIT 200")).rows;
  var counts = await countsOf(rows.map(function (r) { return r.id; }));
  var openings = rows.map(function (o) { return openingOut(o, counts.get(o.id)); });
  var interviews = (await pool.query(ASEL + "WHERE a.stage = 'interview' AND a.interview_at >= now() - interval '2 hours' ORDER BY a.interview_at LIMIT 12")).rows.map(function (a) { return applicantOut(a); });
  var recent = (await pool.query(ASEL + "WHERE a.stage = 'new' ORDER BY a.created_at DESC LIMIT 8")).rows.map(function (a) { return applicantOut(a); });
  return {
    openings: openings, interviews: interviews, recent: recent,
    summary: {
      open: openings.filter(function (o) { return o.open; }).length, applicants: openings.reduce(function (a, o) { return a + o.applicants; }, 0), fresh: openings.reduce(function (a, o) { return a + o.newOnes; }, 0),
      interviews: interviews.length, hired90: (await pool.query("SELECT count(*)::int AS n FROM job_applicants WHERE stage = 'hired' AND updated_at > now() - interval '90 days'")).rows[0].n
    },
    companies: (await pool.query("SELECT id, code, name FROM companies WHERE coalesce(status, 'active') = 'active' ORDER BY name")).rows,
    departments: (await pool.query("SELECT id, name, company_id AS \"companyId\" FROM departments WHERE coalesce(status, 'active') = 'active' ORDER BY name")).rows,
    people: (await pool.query("SELECT id, first_name, last_name FROM employees WHERE status = 'active' ORDER BY first_name, last_name LIMIT 1000")).rows.map(function (e) { return { id: e.id, name: nameOf(e.first_name, e.last_name) }; }),
    kinds: KINDS, stages: STAGES, sources: SOURCES, canHire: ctx.can('employee.write')
  };
}

// GET /api/recruitment/openings/:id — the job and its applicants.
async function opening(ctx, id) {
  need(ctx);
  var o = await openingOf(id);
  var counts = await countsOf([o.id]);
  var apps = (await pool.query(ASEL + "WHERE a.opening_id = $1 ORDER BY array_position(ARRAY['interview','offer','screening','new','hired','rejected'], a.stage), a.rating DESC NULLS LAST, a.created_at DESC", [o.id])).rows;
  return { opening: openingOut(o, counts.get(o.id)), applicants: apps.map(function (a) { return applicantOut(a); }) };
}

// POST /api/recruitment/openings { id?, companyId, departmentId, title, location, kind, description, requirements, pay, closesOn, status }
async function saveOpening(ctx, p) {
  need(ctx);
  p = p || {};
  var co = (await pool.query('SELECT id FROM companies WHERE id = $1', [uuidOr(p.companyId)])).rows[0];
  if (!co) fail('invalid', 'Which company is hiring?');
  var title = text(p.title, 100);
  if (title.length < 3) fail('invalid', 'What is the job? e.g. Bamboo furniture finisher.');
  var description = para(p.description, 5000);
  if (description.length < 20) fail('invalid', 'Describe the job in a few lines.');
  var status = ['draft', 'open', 'closed'].indexOf(p.status) >= 0 ? p.status : 'draft';
  var closes = DAY.test(String(p.closesOn || '')) ? p.closesOn : null;
  var dept = uuidOr(p.departmentId);
  if (dept && !(await pool.query('SELECT 1 FROM departments WHERE id = $1 AND company_id = $2', [dept, co.id])).rows[0]) dept = null;
  var f = [co.id, dept, title, text(p.location, 80), KINDS.indexOf(p.kind) >= 0 ? p.kind : 'full_time', description, para(p.requirements, 3000), text(p.pay, 80), closes, status];
  var id;
  if (p.id) {
    id = (await openingOf(p.id)).id;
    await pool.query('UPDATE job_openings SET company_id = $2, department_id = $3, title = $4, location = $5, kind = $6, description = $7, requirements = $8, pay = $9, closes_on = $10, status = $11, updated_at = now() WHERE id = $1', [id].concat(f));
  } else {
    id = (await pool.query('INSERT INTO job_openings (company_id, department_id, title, location, kind, description, requirements, pay, closes_on, status, slug, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id',
      f.concat([slugOf(title), ctx.employee ? ctx.employee.id : null]))).rows[0].id;
  }
  await audit(pool, ctx, 'recruit.opening', 'job_opening', id, (p.id ? 'Changed' : 'Added') + ' the job ' + title + ' (' + status + ').');
  return opening(ctx, id);
}

// POST /api/recruitment/applicants { openingId, name, email, phone, note, source, cv? } — added by hand.
async function addApplicant(ctx, p) {
  need(ctx);
  p = p || {};
  var o = await openingOf(p.openingId);
  var name = text(p.name, 80);
  if (name.length < 3) fail('invalid', 'Their full name?');
  var email = text(p.email, 120).toLowerCase(), phone = text(p.phone, 30);
  if (email && !isEmail(email)) fail('invalid', 'That email address does not look right.');
  if (!email && phone.replace(/\D/g, '').length < 9) fail('invalid', 'An email address or a phone number, to reach them.');
  var cv = p.cv ? await keepCv(p.cv, p.cvName, name) : null;
  var a = (await pool.query('INSERT INTO job_applicants (opening_id, name, email, phone, note, cv, source) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [o.id, name, email, phone, para(p.note, 2000), cv, SOURCES.indexOf(p.source) >= 0 && p.source !== 'website' ? p.source : 'walk_in'])).rows[0];
  await audit(pool, ctx, 'recruit.applicant', 'job_applicant', a.id, 'Added ' + name + ' as an applicant for ' + o.title + '.');
  return applicant(ctx, a.id);
}

// GET /api/recruitment/applicants/:id
async function applicant(ctx, id) {
  need(ctx);
  var a = await applicantOf(id);
  var notes = (await pool.query('SELECT n.*, e.first_name, e.last_name FROM job_applicant_notes n LEFT JOIN employees e ON e.id = n.by_id WHERE n.applicant_id = $1 ORDER BY n.created_at DESC', [a.id])).rows.map(function (n) {
    return { id: n.id, text: n.text, by: nameOf(n.first_name, n.last_name), at: n.created_at };
  });
  var out = applicantOut(a, notes);
  out.others = (await pool.query("SELECT a.id, o.title, a.stage FROM job_applicants a JOIN job_openings o ON o.id = a.opening_id WHERE a.id <> $1 AND ((a.email <> '' AND a.email = $2) OR (a.phone <> '' AND a.phone = $3))", [a.id, a.email, a.phone])).rows;
  return out;
}

// PUT /api/recruitment/applicants/:id { stage, rating, interviewAt, interviewerId, rejectReason }
async function updateApplicant(ctx, id, p) {
  need(ctx);
  p = p || {};
  var a = await applicantOf(id);
  if (a.stage === 'hired') fail('conflict', 'They are hired already.');
  var stage = p.stage === undefined ? a.stage : STAGES.indexOf(p.stage) >= 0 && p.stage !== 'hired' ? p.stage : fail('invalid', 'Which stage?');
  var rating = p.rating === undefined ? a.rating : p.rating === null || p.rating === '' ? null : Math.round(Number(p.rating));
  if (rating != null && !(rating >= 1 && rating <= 5)) fail('invalid', 'A rating from 1 to 5.');
  var at = p.interviewAt === undefined ? a.interview_at : p.interviewAt ? new Date(p.interviewAt) : null;
  if (at && isNaN(at.getTime())) fail('invalid', 'When is the interview?');
  if (stage === 'interview' && !at) fail('invalid', 'When is the interview?');
  var interviewer = p.interviewerId === undefined ? a.interviewer_id : uuidOr(p.interviewerId);
  var reason = p.rejectReason === undefined ? a.reject_reason : text(p.rejectReason, 300);
  if (stage === 'rejected' && reason.length < 3) fail('invalid', 'Why not? A few words, for the record.');
  await pool.query('UPDATE job_applicants SET stage = $2, rating = $3, interview_at = $4, interviewer_id = $5, reject_reason = $6, updated_at = now() WHERE id = $1', [a.id, stage, rating, at, interviewer, reason]);
  var changed = [];
  if (stage !== a.stage) changed.push('moved to ' + stage);
  if (String(at || '') !== String(a.interview_at || '') && at) changed.push('interview ' + at.toISOString().slice(0, 16).replace('T', ' '));
  if (rating !== a.rating) changed.push('rated ' + (rating || 'none'));
  if (interviewer && (interviewer !== a.interviewer_id || (at && String(at) !== String(a.interview_at || '')))) {
    await notify(pool, interviewer, '🗓️ Interview: ' + a.name, a.title + ' — ' + at.toISOString().slice(0, 16).replace('T', ' ') + ' (GMT)', '/recruitment?applicant=' + a.id);
  }
  if (changed.length) await audit(pool, ctx, 'recruit.applicant', 'job_applicant', a.id, a.name + ' (' + a.title + '): ' + changed.join(', ') + '.');
  return applicant(ctx, a.id);
}

// POST /api/recruitment/applicants/:id/notes { text }
async function addNote(ctx, id, p) {
  need(ctx);
  var a = await applicantOf(id);
  var t = para((p || {}).text, 2000);
  if (t.length < 2) fail('invalid', 'Write the note.');
  await pool.query('INSERT INTO job_applicant_notes (applicant_id, by_id, text) VALUES ($1, $2, $3)', [a.id, ctx.employee ? ctx.employee.id : null, t]);
  return applicant(ctx, a.id);
}

// POST /api/recruitment/applicants/:id/hire { departmentId, positionTitle, hireDate, employmentType }
// They go into the employee directory (employees.service create).
async function hire(ctx, id, p) {
  need(ctx);
  if (!ctx.can('employee.write')) fail('forbidden', 'Adding them to the staff needs employee.write.');
  p = p || {};
  var a = await applicantOf(id);
  if (a.stage === 'hired') fail('conflict', 'They are hired already.');
  if (!a.email) fail('invalid', 'Add their email address first: the employee record needs one.');
  var o = await openingOf(a.opening_id);
  var parts = a.name.split(' ');
  var first = parts.shift(), last = parts.join(' ') || '-';
  var emp = await require('./employees.service').create(ctx, {
    firstName: first, lastName: last, email: a.email, phone: a.phone, departmentId: uuidOr(p.departmentId) || o.department_id,
    positionTitle: text(p.positionTitle, 60) || o.title, hireDate: DAY.test(String(p.hireDate || '')) ? p.hireDate : today(),
    employmentType: ['permanent', 'contract', 'casual', 'day_rate'].indexOf(p.employmentType) >= 0 ? p.employmentType : o.kind === 'contract' ? 'contract' : o.kind === 'casual' ? 'casual' : 'permanent'
  });
  await pool.query("UPDATE job_applicants SET stage = 'hired', employee_id = $2, updated_at = now() WHERE id = $1", [a.id, emp.id]);
  await audit(pool, ctx, 'recruit.hire', 'job_applicant', a.id, 'Hired ' + a.name + ' as ' + (text(p.positionTitle, 60) || o.title) + ' (' + emp.code + ').');
  var out = await applicant(ctx, a.id);
  out.employee = { id: emp.id, code: emp.code };
  // Their first-day checklist, ready (onboarding.service.js).
  try { out.checklist = await require('./onboarding.service').start(ctx, { employeeId: emp.id, kind: 'join', day: DAY.test(String(p.hireDate || '')) ? p.hireDate : today() }, { system: true }); }
  catch (e) { out.checklist = null; }
  return out;
}

async function cvOf(ctx, id) {
  need(ctx);
  var a = await applicantOf(id);
  if (!a.cv) fail('notfound', 'No CV for them.');
  return { key: a.cv.key, name: a.cv.name, type: a.cv.type };
}

// ── The public jobs page ──

function publicOut(o) {
  return { slug: o.slug, title: o.title, company: o.company_name, department: o.department_name || '', location: o.location, kind: o.kind, description: o.description, requirements: o.requirements, pay: o.pay, closesOn: dayText(o.closes_on), postedAt: o.created_at };
}
var OPEN = "o.status = 'open' AND (o.closes_on IS NULL OR o.closes_on >= current_date)";

// GET /api/jobs
async function publicList() {
  return { jobs: (await pool.query(OSEL + 'WHERE ' + OPEN + ' ORDER BY o.created_at DESC LIMIT 50')).rows.map(publicOut), kinds: KINDS };
}
// GET /api/jobs/:slug
async function publicJob(slug) {
  var o = (await pool.query(OSEL + 'WHERE o.slug = $1', [String(slug || '').slice(0, 80)])).rows[0];
  if (!o) fail('notfound', 'That job is not there any more.');
  var out = publicOut(o);
  out.open = o.status === 'open' && (!o.closes_on || dayText(o.closes_on) >= today());
  return out;
}
// POST /api/jobs/:slug/apply { name, email, phone, note, cv, cvName, website (a trap for robots) }
async function apply(slug, p, ip) {
  p = p || {};
  var o = (await pool.query(OSEL + 'WHERE o.slug = $1 AND ' + OPEN, [String(slug || '').slice(0, 80)])).rows[0];
  if (!o) fail('notfound', 'That job is closed now.');
  if (p.website) return { ok: true }; // a robot filled the hidden field
  var recent = (await pool.query("SELECT count(*)::int AS n FROM job_applicants WHERE ip = $1 AND created_at > now() - interval '1 hour'", [String(ip || '')])).rows[0].n;
  if (recent >= PER_HOUR) fail('ratelimited', 'Too many applications from here: try again in an hour.');
  var name = text(p.name, 80);
  if (name.length < 3 || name.indexOf(' ') < 0) fail('invalid', 'Your full name, please.');
  var email = text(p.email, 120).toLowerCase();
  if (!isEmail(email)) fail('invalid', 'Your email address, so we can answer.');
  var phone = text(p.phone, 30);
  if (phone.replace(/\D/g, '').length < 9) fail('invalid', 'Your phone number, please.');
  var dup = (await pool.query('SELECT 1 FROM job_applicants WHERE opening_id = $1 AND email = $2', [o.id, email])).rows[0];
  if (dup) fail('conflict', 'You have applied for this job already: we will be in touch.');
  if (!p.cv) fail('invalid', 'Add your CV (a PDF, a Word document or a photo).');
  var cv = await keepCv(p.cv, p.cvName, name);
  var a = (await pool.query("INSERT INTO job_applicants (opening_id, name, email, phone, note, cv, source, ip) VALUES ($1,$2,$3,$4,$5,$6,'website',$7) RETURNING id",
    [o.id, name, email, phone, para(p.note, 2000), cv, String(ip || '').slice(0, 60)])).rows[0];
  var holders = await require('./staffAlerts.service').holdersOf(['recruit.manage']);
  for (var i = 0; i < holders.length; i++) await notify(pool, holders[i].employee_id, '📨 New applicant: ' + name, o.title + ' · ' + o.company_name, '/recruitment?applicant=' + a.id);
  var mail = require('./mail.service');
  if (mail.configured()) {
    mail.send({
      to: email, fromName: o.company_name, subject: 'Your application: ' + o.title,
      text: 'Dear ' + name.split(' ')[0] + ',\n\nThank you for applying for ' + o.title + ' at ' + o.company_name + '. We have your CV and will be in touch if you are shortlisted.\n\n' + o.company_name
    }).catch(function (e) { console.error('Application email failed:', e.message); });
  }
  return { ok: true, title: o.title, company: o.company_name };
}

module.exports = {
  overview: overview, opening: opening, saveOpening: saveOpening, addApplicant: addApplicant, applicant: applicant, updateApplicant: updateApplicant, addNote: addNote, hire: hire, cvOf: cvOf,
  publicList: publicList, publicJob: publicJob, apply: apply, STAGES: STAGES
};
