var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');

// Discipline and grievances (People → Discipline and grievances; migration
// 0200). HR opens a case about someone, sends them a query letter with a day
// to reply by, holds a hearing with a panel, decides the outcome — a warning
// lasts 3, 6 or 12 months — and the person may appeal. Anyone raises a
// grievance from My space. Confidential: only discipline.manage sees the
// cases; the person sees their own once a query reaches them, and what was
// shared with them (the query, the hearing, the outcome), never HR's notes.
// Late replies and hearings tomorrow are chased each day (jobs/dailyAlerts.js).

var DISCIPLINE = ['lateness', 'absence', 'misconduct', 'performance', 'safety_breach', 'theft', 'harassment', 'insubordination', 'policy_breach', 'other'];
var GRIEVANCE = ['pay', 'workload', 'treatment', 'harassment', 'conditions', 'safety', 'discrimination', 'other'];
var OUTCOMES = { discipline: ['no_action', 'counselling', 'verbal_warning', 'written_warning', 'final_warning', 'suspension', 'dismissal'], grievance: ['upheld', 'partly_upheld', 'not_upheld'] };
// How long a warning stays on someone's record, in months.
var WARNING_MONTHS = { verbal_warning: 3, written_warning: 6, final_warning: 12, suspension: 12 };
var LADDER = ['counselling', 'verbal_warning', 'written_warning', 'final_warning', 'dismissal'];
var OUTCOME_WORDS = { no_action: 'No action', counselling: 'Counselling', verbal_warning: 'Verbal warning', written_warning: 'Written warning', final_warning: 'Final written warning', suspension: 'Suspension', dismissal: 'Dismissal', upheld: 'Upheld', partly_upheld: 'Partly upheld', not_upheld: 'Not upheld' };
var APPEAL_DAYS = 10;

function text(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function nameOf(f, l) { return f ? (f + ' ' + (l || '')).trim() : null; }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }
function can(ctx) { return ctx.can('discipline.manage'); }
function need(ctx) { if (!can(ctx)) fail('forbidden', 'Your role does not allow this action (discipline.manage).'); }
function refOf(c) { return (c.kind === 'grievance' ? 'GR-' : 'DC-') + String(c.number).padStart(4, '0'); }
function addMonths(day, n) { var d = new Date(day + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); }

var SEL = 'SELECT c.*, e.first_name, e.last_name, e.position_title, e.code AS emp_code, d.name AS department, co.name AS company, ' +
  'a.first_name AS a_first, a.last_name AS a_last, h.first_name AS h_first, h.last_name AS h_last ' +
  'FROM discipline_cases c JOIN employees e ON e.id = c.employee_id LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN companies co ON co.id = d.company_id ' +
  'LEFT JOIN employees a ON a.id = c.against_id LEFT JOIN employees h ON h.id = c.handler_id ';

function warningActive(c) { return !!(c.warning_until && dayText(c.warning_until) >= today() && c.appeal_result !== 'overturned'); }
function caseOut(c) {
  var replyLate = c.status === 'awaiting_reply' && c.reply_due && dayText(c.reply_due) < today();
  return {
    id: c.id, number: c.number, ref: refOf(c), kind: c.kind, category: c.category, title: c.title, details: c.details, occurredOn: dayText(c.occurred_on), status: c.status,
    person: { id: c.employee_id, name: nameOf(c.first_name, c.last_name), position: c.position_title || '', department: c.department || '', company: c.company || '', code: c.emp_code },
    against: c.against_id ? { id: c.against_id, name: nameOf(c.a_first, c.a_last) } : null,
    handler: c.handler_id ? { id: c.handler_id, name: nameOf(c.h_first, c.h_last) } : null,
    query: c.query_sent_at ? { text: c.query_text, sentAt: c.query_sent_at, replyDue: dayText(c.reply_due), late: replyLate } : null,
    reply: c.replied_at ? { text: c.reply_text, at: c.replied_at } : null,
    hearing: c.hearing_at ? { at: c.hearing_at, place: c.hearing_place, panel: c.panel || [] } : null,
    outcome: c.outcome ? { outcome: c.outcome, note: c.outcome_note, suspensionDays: c.suspension_days, warningUntil: dayText(c.warning_until), active: warningActive(c), at: c.decided_at } : null,
    appeal: c.appealed_at ? { text: c.appeal_text, at: c.appealed_at, result: c.appeal_result, note: c.appeal_note, decidedAt: c.appeal_decided_at } : null,
    createdAt: c.created_at, closedAt: c.closed_at
  };
}

// The person's record: their other cases and the warnings still running.
async function historyOf(employeeId, notId) {
  var rows = (await pool.query(SEL + "WHERE c.employee_id = $1 AND c.kind = 'discipline' AND c.id <> $2 ORDER BY c.created_at DESC", [employeeId, notId || '00000000-0000-0000-0000-000000000000'])).rows;
  return rows.map(function (c) { return { id: c.id, ref: refOf(c), title: c.title, category: c.category, status: c.status, outcome: c.outcome, warningUntil: dayText(c.warning_until), active: warningActive(c), at: c.decided_at || c.created_at }; });
}
// The next step up from the strongest warning still running.
function suggest(history) {
  var active = history.filter(function (h) { return h.active; }).map(function (h) { return LADDER.indexOf(h.outcome === 'suspension' ? 'final_warning' : h.outcome); }).filter(function (i) { return i >= 0; });
  if (!active.length) return null;
  return LADDER[Math.min(LADDER.length - 1, Math.max.apply(null, active) + 1)];
}

// GET /api/discipline?status=open|closed|all&kind=
async function overview(ctx, q) {
  need(ctx);
  q = q || {};
  var status = ['open', 'closed', 'all'].indexOf(q.status) >= 0 ? q.status : 'open';
  var where = [], args = [];
  if (me(ctx)) { args.push(me(ctx)); where.push(notMine(args.length)); }
  if (status === 'open') where.push("c.status NOT IN ('closed', 'withdrawn')");
  if (status === 'closed') where.push("c.status IN ('closed', 'withdrawn')");
  if (q.kind === 'discipline' || q.kind === 'grievance') { args.push(q.kind); where.push('c.kind = $' + args.length); }
  var list = (await pool.query(SEL + (where.length ? 'WHERE ' + where.join(' AND ') : '') + ' ORDER BY c.created_at DESC LIMIT 200', args)).rows.map(caseOut);
  var all = (await pool.query(SEL + "WHERE (c.status NOT IN ('closed', 'withdrawn') OR c.warning_until >= current_date)" + (me(ctx) ? ' AND ' + notMine(1) : ''), me(ctx) ? [me(ctx)] : [])).rows;
  var open = all.filter(function (c) { return c.status !== 'closed' && c.status !== 'withdrawn'; });
  var weekEnd = new Date(Date.now() + 7 * 86400000);
  var warnings = all.filter(warningActive).map(function (c) {
    return { caseId: c.id, ref: refOf(c), person: { id: c.employee_id, name: nameOf(c.first_name, c.last_name), department: c.department || '' }, outcome: c.outcome, until: dayText(c.warning_until), category: c.category };
  }).sort(function (a, b) { return a.until < b.until ? -1 : 1; });
  var hearings = open.filter(function (c) { return c.status === 'hearing' && c.hearing_at && new Date(c.hearing_at) >= new Date(Date.now() - 86400000); })
    .map(function (c) { return { caseId: c.id, ref: refOf(c), at: c.hearing_at, place: c.hearing_place, person: nameOf(c.first_name, c.last_name), title: c.title }; })
    .sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
  // By month, a year: cases opened, each kind.
  var start = new Date(); start.setUTCDate(1); start.setUTCMonth(start.getUTCMonth() - 11);
  var byMonth = (await pool.query("SELECT to_char(created_at, 'YYYY-MM') AS m, kind, count(*)::int AS n FROM discipline_cases WHERE created_at >= $1 GROUP BY 1, 2", [start.toISOString().slice(0, 10)])).rows;
  var months = [];
  for (var k = 0; k < 12; k++) {
    var d = new Date(start); d.setUTCMonth(start.getUTCMonth() + k);
    var key = d.toISOString().slice(0, 7);
    months.push({ month: key, discipline: (byMonth.find(function (r) { return r.m === key && r.kind === 'discipline'; }) || { n: 0 }).n, grievance: (byMonth.find(function (r) { return r.m === key && r.kind === 'grievance'; }) || { n: 0 }).n });
  }
  var cats = (await pool.query("SELECT kind, category, count(*)::int AS n FROM discipline_cases WHERE created_at >= now() - interval '12 months' GROUP BY 1, 2 ORDER BY 3 DESC")).rows;
  var people = (await pool.query("SELECT e.id, e.first_name, e.last_name, e.position_title, d.name AS department FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.status = 'active' ORDER BY e.first_name, e.last_name")).rows.map(function (p) {
    return { id: p.id, name: nameOf(p.first_name, p.last_name), position: p.position_title || '', department: p.department || '' };
  });
  return {
    status: status, kind: q.kind || '', cases: list, warnings: warnings, hearings: hearings, months: months, categories: cats, people: people,
    lists: { discipline: DISCIPLINE, grievance: GRIEVANCE, outcomes: OUTCOMES },
    summary: {
      open: open.filter(function (c) { return c.kind === 'discipline'; }).length,
      grievances: open.filter(function (c) { return c.kind === 'grievance'; }).length,
      awaitingReply: open.filter(function (c) { return c.status === 'awaiting_reply'; }).length,
      lateReplies: open.filter(function (c) { return c.status === 'awaiting_reply' && c.reply_due && dayText(c.reply_due) < today(); }).length,
      hearingsWeek: hearings.filter(function (h) { return new Date(h.at) <= weekEnd; }).length,
      warnings: warnings.length,
      appeals: open.filter(function (c) { return c.status === 'appealed'; }).length
    }
  };
}

async function caseOf(id) {
  var c = (await pool.query(SEL + 'WHERE c.id = $1', [uuidOr(id)])).rows[0];
  if (!c) fail('notfound', 'That case is gone.');
  return c;
}
// Whether this person sees the case at all, and as whom.
// Someone who handles cases never handles one about themselves, and does not
// see a grievance raised about them.
function roleIn(ctx, c) {
  if (c.employee_id === me(ctx)) return c.kind === 'grievance' || c.query_sent_at || c.decided_at ? 'person' : null;
  if (c.against_id && c.against_id === me(ctx)) return null;
  return can(ctx) ? 'hr' : null;
}
function hrOnly(ctx, c) { if (roleIn(ctx, c) !== 'hr') fail('forbidden', 'Someone else handles this case.'); }
// Cases HR lists: never their own, nor a grievance about them ($n is them).
function notMine(n) { return '(c.employee_id <> $' + n + ' AND c.against_id IS DISTINCT FROM $' + n + ')'; }

async function eventsOf(c, role) {
  return (await pool.query('SELECT ev.*, e.first_name, e.last_name FROM discipline_events ev LEFT JOIN employees e ON e.id = ev.by_id WHERE ev.case_id = $1' + (role === 'hr' ? '' : ' AND ev.shared') + ' ORDER BY ev.at', [c.id])).rows.map(function (ev) {
    return { id: ev.id, kind: ev.kind, body: ev.body, shared: ev.shared, by: nameOf(ev.first_name, ev.last_name), at: ev.at };
  });
}

// GET /api/discipline/:id
async function get(ctx, id) {
  var c = await caseOf(id);
  var role = roleIn(ctx, c);
  if (!role) fail('forbidden', 'That case is not yours to see.');
  var out = caseOut(c);
  out.events = await eventsOf(c, role);
  out.role = role;
  out.canManage = role === 'hr';
  if (role === 'hr') {
    out.history = c.kind === 'discipline' ? await historyOf(c.employee_id, c.id) : [];
    out.suggested = c.kind === 'discipline' ? suggest(out.history) : null;
    var panel = (c.panel || []).map(function (p) { return p.id; }).filter(Boolean);
    out.panelNames = panel.length ? (await pool.query('SELECT id, first_name, last_name FROM employees WHERE id = ANY($1)', [panel])).rows.map(function (p) { return { id: p.id, name: nameOf(p.first_name, p.last_name) }; }) : [];
  } else {
    // What the person sees: no HR notes, not who handles it beyond a name.
    out.details = c.kind === 'grievance' ? c.details : '';
  }
  out.canReply = role === 'person' && c.status === 'awaiting_reply';
  out.canAppeal = role === 'person' && c.kind === 'discipline' && c.status === 'decided' && !c.appealed_at && c.outcome && c.outcome !== 'no_action' && c.decided_at && (Date.now() - new Date(c.decided_at).getTime()) <= APPEAL_DAYS * 86400000;
  out.appealBy = c.decided_at ? dayText(new Date(new Date(c.decided_at).getTime() + APPEAL_DAYS * 86400000)) : null;
  return out;
}

async function event(db, caseId, kind, body, shared, by) {
  await db.query('INSERT INTO discipline_events (case_id, kind, body, shared, by_id) VALUES ($1,$2,$3,$4,$5)', [caseId, kind, body || '', !!shared, by]);
}
async function nextNumber(db) {
  await db.query('LOCK TABLE discipline_cases IN SHARE ROW EXCLUSIVE MODE');
  return (await db.query('SELECT coalesce(max(number), 0) + 1 AS n FROM discipline_cases')).rows[0].n;
}

// POST /api/discipline { employeeId, category, title, details, occurredOn, handlerId }
async function open(ctx, p) {
  need(ctx);
  p = p || {};
  var emp = uuidOr(p.employeeId);
  var person = emp && (await pool.query("SELECT id, first_name, last_name FROM employees WHERE id = $1 AND status = 'active'", [emp])).rows[0];
  if (!person) fail('invalid', 'Who is it about?');
  if (emp === me(ctx)) fail('invalid', 'Someone else handles a case about you.');
  var title = text(p.title, 160);
  if (title.length < 4) fail('invalid', 'Give it a title: what happened, in a few words.');
  var category = DISCIPLINE.indexOf(p.category) >= 0 ? p.category : 'other';
  var occurred = /^\d{4}-\d{2}-\d{2}$/.test(String(p.occurredOn || '')) ? p.occurredOn : null;
  if (occurred && occurred > today()) fail('invalid', 'When did it happen? Today or before.');
  var handler = uuidOr(p.handlerId) || me(ctx);
  var row = await withTransaction(async function (db) {
    var n = await nextNumber(db);
    var c = (await db.query('INSERT INTO discipline_cases (number, kind, employee_id, category, title, details, occurred_on, handler_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [n, 'discipline', emp, category, title, text(p.details, 5000), occurred, handler, me(ctx)])).rows[0];
    await event(db, c.id, 'opened', title, false, me(ctx));
    return c;
  });
  if (handler !== me(ctx)) await notify(pool, handler, '🗂️ A case for you: ' + refOf(row), nameOf(person.first_name, person.last_name) + ' — ' + title, '/discipline?case=' + row.id);
  await audit(pool, ctx, 'discipline.open', 'employee', emp, refOf(row) + ' opened.');
  return get(ctx, row.id);
}

// POST /api/discipline/grievance { category, title, details, againstId } —
// anyone, about how they are treated, their pay, their conditions.
async function grievance(ctx, p) {
  p = p || {};
  if (!me(ctx)) fail('forbidden', 'Only staff raise a grievance here.');
  var title = text(p.title, 160);
  if (title.length < 4) fail('invalid', 'Give it a title, in a few words.');
  var details = text(p.details, 5000);
  if (details.length < 10) fail('invalid', 'Say what happened and what you would like done.');
  var against = uuidOr(p.againstId);
  if (against === me(ctx)) against = null;
  var row = await withTransaction(async function (db) {
    var n = await nextNumber(db);
    var c = (await db.query('INSERT INTO discipline_cases (number, kind, employee_id, against_id, category, title, details, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [n, 'grievance', me(ctx), against, GRIEVANCE.indexOf(p.category) >= 0 ? p.category : 'other', title, details, me(ctx)])).rows[0];
    await event(db, c.id, 'opened', title, true, me(ctx));
    return c;
  });
  var holders = await require('./staffAlerts.service').holdersOf(['discipline.manage']);
  for (var i = 0; i < holders.length; i++) {
    if (holders[i].employee_id === me(ctx) || holders[i].employee_id === against) continue;
    await notify(pool, holders[i].employee_id, '📮 A grievance: ' + refOf(row), title, '/discipline?case=' + row.id);
  }
  await audit(pool, ctx, 'discipline.grievance', 'employee', me(ctx), refOf(row) + ' raised.');
  return get(ctx, row.id);
}

function openOnly(c) { if (c.status === 'closed' || c.status === 'withdrawn') fail('conflict', 'It is closed: reopen it first.'); }

// POST /api/discipline/:id/note { body } — HR's own note, never shared.
async function note(ctx, id, p) {
  need(ctx);
  var c = await caseOf(id);
  hrOnly(ctx, c);
  var body = text(p && p.body, 3000);
  if (body.length < 2) fail('invalid', 'Write the note.');
  await event(pool, c.id, 'note', body, false, me(ctx));
  await pool.query('UPDATE discipline_cases SET updated_at = now() WHERE id = $1', [c.id]);
  return get(ctx, c.id);
}

// POST /api/discipline/:id/query { text, replyDue } — the letter asking them
// to explain; it reaches them in My space.
async function query(ctx, id, p) {
  need(ctx);
  p = p || {};
  var c = await caseOf(id);
  hrOnly(ctx, c);
  openOnly(c);
  if (c.kind !== 'discipline') fail('invalid', 'A grievance has no query.');
  var body = text(p.text, 5000);
  if (body.length < 20) fail('invalid', 'Write the query: what happened, and what they are asked to explain.');
  var due = /^\d{4}-\d{2}-\d{2}$/.test(String(p.replyDue || '')) ? p.replyDue : fail('invalid', 'By when should they reply?');
  if (due < today()) fail('invalid', 'The reply day is in the past.');
  await pool.query("UPDATE discipline_cases SET query_text = $2, query_sent_at = now(), reply_due = $3, reply_text = '', replied_at = NULL, status = 'awaiting_reply', updated_at = now() WHERE id = $1", [c.id, body, due]);
  await event(pool, c.id, 'query', body, true, me(ctx));
  await notify(pool, c.employee_id, '📩 A letter from HR needs your reply', refOf(c) + ': ' + c.title + '. Please reply by ' + due + ' in My space.', '/myspace');
  await audit(pool, ctx, 'discipline.query', 'employee', c.employee_id, 'Query sent on ' + refOf(c) + ', reply by ' + due + '.');
  return get(ctx, c.id);
}

// POST /api/discipline/:id/reply { text } — the person, from My space (or HR
// writing down a reply handed in on paper).
async function reply(ctx, id, p) {
  var c = await caseOf(id);
  var role = roleIn(ctx, c);
  if (role !== 'person' && role !== 'hr') fail('forbidden', 'That case is not yours.');
  if (c.status !== 'awaiting_reply') fail('conflict', 'No reply is waited for.');
  var body = text(p && p.text, 5000);
  if (body.length < 5) fail('invalid', 'Write your reply.');
  await pool.query("UPDATE discipline_cases SET reply_text = $2, replied_at = now(), status = 'open', updated_at = now() WHERE id = $1", [c.id, body]);
  await event(pool, c.id, 'reply', body, true, me(ctx));
  if (role === 'person' && c.handler_id) await notify(pool, c.handler_id, '✉️ ' + nameOf(c.first_name, c.last_name) + ' replied — ' + refOf(c), body.slice(0, 160), '/discipline?case=' + c.id);
  await audit(pool, ctx, 'discipline.reply', 'employee', c.employee_id, 'Reply on ' + refOf(c) + (role === 'hr' ? ' recorded by HR.' : '.'));
  return role === 'hr' ? get(ctx, c.id) : { ok: true };
}

// POST /api/discipline/:id/hearing { at, place, panelIds }
async function hearing(ctx, id, p) {
  need(ctx);
  p = p || {};
  var c = await caseOf(id);
  hrOnly(ctx, c);
  openOnly(c);
  var at = new Date(p.at || '');
  if (isNaN(at.getTime())) fail('invalid', 'When is the hearing?');
  if (at.getTime() < Date.now() - 3600000) fail('invalid', 'The hearing is in the past.');
  var panel = (Array.isArray(p.panelIds) ? p.panelIds : []).map(uuidOr).filter(Boolean).filter(function (x) { return x !== c.employee_id; }).slice(0, 5);
  var place = text(p.place, 120);
  await pool.query("UPDATE discipline_cases SET hearing_at = $2, hearing_place = $3, panel = $4, status = 'hearing', updated_at = now() WHERE id = $1",
    [c.id, at, place, JSON.stringify(panel.map(function (x) { return { id: x }; }))]);
  var when = at.toISOString().slice(0, 16).replace('T', ' ');
  await event(pool, c.id, 'hearing', when + (place ? ' · ' + place : ''), true, me(ctx));
  await notify(pool, c.employee_id, '📅 A hearing: ' + refOf(c), when + (place ? ', ' + place : '') + '. You may bring a colleague with you.', '/myspace');
  for (var i = 0; i < panel.length; i++) if (panel[i] !== me(ctx)) await notify(pool, panel[i], '📅 You sit on a hearing panel — ' + refOf(c), when + (place ? ', ' + place : ''), '/discipline?case=' + c.id);
  await audit(pool, ctx, 'discipline.hearing', 'employee', c.employee_id, 'Hearing on ' + refOf(c) + ' set for ' + when + '.');
  return get(ctx, c.id);
}

// POST /api/discipline/:id/decide { outcome, note, suspensionDays, startLeaving }
async function decide(ctx, id, p) {
  need(ctx);
  p = p || {};
  var c = await caseOf(id);
  hrOnly(ctx, c);
  openOnly(c);
  var outcome = OUTCOMES[c.kind].indexOf(p.outcome) >= 0 ? p.outcome : fail('invalid', 'What was decided?');
  var noteText = text(p.note, 5000);
  if (noteText.length < 10) fail('invalid', 'Write down why: it goes in the outcome letter.');
  var days = outcome === 'suspension' ? Math.max(1, Math.min(30, Math.round(Number(p.suspensionDays) || 0))) : 0;
  if (outcome === 'suspension' && !(Number(p.suspensionDays) > 0)) fail('invalid', 'How many days of suspension?');
  var until = WARNING_MONTHS[outcome] ? addMonths(today(), WARNING_MONTHS[outcome]) : null;
  await pool.query("UPDATE discipline_cases SET outcome = $2, outcome_note = $3, suspension_days = $4, warning_until = $5, decided_at = now(), decided_by = $6, status = 'decided', updated_at = now() WHERE id = $1",
    [c.id, outcome, noteText, days, until, me(ctx)]);
  await event(pool, c.id, 'outcome', OUTCOME_WORDS[outcome] + (until ? ' (until ' + until + ')' : '') + ': ' + noteText, true, me(ctx));
  var tell = c.kind === 'grievance' ? '📬 Your grievance ' + refOf(c) + ': ' + OUTCOME_WORDS[outcome].toLowerCase() : '📬 The outcome of ' + refOf(c) + ': ' + OUTCOME_WORDS[outcome].toLowerCase();
  await notify(pool, c.employee_id, tell, c.kind === 'discipline' && outcome !== 'no_action' ? 'Read it in My space. You may appeal within ' + APPEAL_DAYS + ' days.' : 'Read it in My space.', '/myspace');
  var leaving = null;
  if (outcome === 'dismissal' && p.startLeaving) {
    try { leaving = await require('./onboarding.service').start(ctx, { employeeId: c.employee_id, kind: 'leave', day: today(), reason: 'dismissed' }, { system: true }); } catch (e) { leaving = null; }
  }
  await audit(pool, ctx, 'discipline.decide', 'employee', c.employee_id, refOf(c) + ': ' + OUTCOME_WORDS[outcome] + '.');
  var out = await get(ctx, c.id);
  out.leavingList = leaving ? leaving.id : null;
  return out;
}

// POST /api/discipline/:id/appeal { text } — the person, within 10 days.
async function appeal(ctx, id, p) {
  var c = await caseOf(id);
  var role = roleIn(ctx, c);
  // HR may write down an appeal handed in on paper (forPerson).
  if (role !== 'person' && !(role === 'hr' && p && p.forPerson)) fail('forbidden', 'Only they can appeal.');
  if (c.kind !== 'discipline' || c.status !== 'decided' || c.appealed_at || !c.outcome || c.outcome === 'no_action') fail('conflict', 'It cannot be appealed.');
  if (role === 'person' && Date.now() - new Date(c.decided_at).getTime() > APPEAL_DAYS * 86400000) fail('conflict', 'The ' + APPEAL_DAYS + ' days to appeal have passed.');
  var body = text(p && p.text, 5000);
  if (body.length < 10) fail('invalid', 'Say why you appeal.');
  await pool.query("UPDATE discipline_cases SET appeal_text = $2, appealed_at = now(), status = 'appealed', updated_at = now() WHERE id = $1", [c.id, body]);
  await event(pool, c.id, 'appeal', body, true, me(ctx));
  var holders = await require('./staffAlerts.service').holdersOf(['discipline.manage']);
  for (var i = 0; i < holders.length; i++) if (holders[i].employee_id !== c.employee_id) await notify(pool, holders[i].employee_id, '⚖️ An appeal — ' + refOf(c), nameOf(c.first_name, c.last_name) + ': ' + body.slice(0, 140), '/discipline?case=' + c.id);
  await audit(pool, ctx, 'discipline.appeal', 'employee', c.employee_id, 'Appeal on ' + refOf(c) + '.');
  return role === 'hr' ? get(ctx, c.id) : { ok: true };
}

// POST /api/discipline/:id/appeal-result { result: stands|reduced|overturned, note, outcome }
async function appealResult(ctx, id, p) {
  need(ctx);
  p = p || {};
  var c = await caseOf(id);
  hrOnly(ctx, c);
  if (c.status !== 'appealed') fail('conflict', 'There is no appeal waiting.');
  var result = ['stands', 'reduced', 'overturned'].indexOf(p.result) >= 0 ? p.result : fail('invalid', 'What did the appeal decide?');
  var noteText = text(p.note, 3000);
  if (noteText.length < 10) fail('invalid', 'Write down why.');
  var outcome = c.outcome, until = dayText(c.warning_until);
  if (result === 'overturned') until = null;
  if (result === 'reduced') {
    var lower = OUTCOMES.discipline.indexOf(p.outcome) >= 0 && LADDER.indexOf(p.outcome) < LADDER.indexOf(c.outcome === 'suspension' ? 'final_warning' : c.outcome) ? p.outcome : fail('invalid', 'Reduced to what?');
    outcome = lower;
    until = WARNING_MONTHS[lower] ? addMonths(dayText(c.decided_at), WARNING_MONTHS[lower]) : null;
  }
  await pool.query("UPDATE discipline_cases SET appeal_result = $2, appeal_note = $3, appeal_decided_at = now(), outcome = $4, warning_until = $5, status = 'closed', closed_at = now(), updated_at = now() WHERE id = $1",
    [c.id, result, noteText, outcome, until]);
  await event(pool, c.id, 'appeal_result', (result === 'stands' ? 'The decision stands' : result === 'overturned' ? 'Overturned' : 'Reduced to ' + OUTCOME_WORDS[outcome].toLowerCase()) + ': ' + noteText, true, me(ctx));
  await notify(pool, c.employee_id, '⚖️ Your appeal on ' + refOf(c) + ': ' + (result === 'stands' ? 'the decision stands' : result === 'overturned' ? 'overturned' : 'reduced'), 'Read it in My space.', '/myspace');
  await audit(pool, ctx, 'discipline.appeal', 'employee', c.employee_id, 'Appeal on ' + refOf(c) + ': ' + result + '.');
  return get(ctx, c.id);
}

// POST /api/discipline/:id/close, /withdraw, /reopen
async function setStatus(ctx, id, to, p) {
  var c = await caseOf(id);
  var role = roleIn(ctx, c);
  var raiser = c.kind === 'grievance' && c.employee_id === me(ctx);
  if (role !== 'hr' && !(to === 'withdrawn' && raiser)) fail('forbidden', 'Your role does not allow this action (discipline.manage).');
  var why = text(p && p.note, 1000);
  if (to === 'closed') {
    openOnly(c);
    if (c.kind === 'discipline' && !c.outcome) fail('conflict', 'Decide the outcome first, or withdraw it.');
    await pool.query("UPDATE discipline_cases SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = $1", [c.id]);
  } else if (to === 'withdrawn') {
    openOnly(c);
    await pool.query("UPDATE discipline_cases SET status = 'withdrawn', closed_at = now(), warning_until = NULL, updated_at = now() WHERE id = $1", [c.id]);
  } else {
    if (c.status !== 'closed' && c.status !== 'withdrawn') fail('conflict', 'It is open.');
    await pool.query("UPDATE discipline_cases SET status = $2, closed_at = NULL, updated_at = now() WHERE id = $1", [c.id, c.outcome ? 'decided' : c.query_sent_at && !c.replied_at ? 'awaiting_reply' : 'open']);
  }
  await event(pool, c.id, to === 'reopen' ? 'reopened' : to, why, to !== 'reopen', me(ctx));
  if (to === 'withdrawn' && c.kind === 'discipline' && c.query_sent_at) await notify(pool, c.employee_id, '🗂️ ' + refOf(c) + ' was withdrawn', 'Nothing further will happen on it.', '/myspace');
  await audit(pool, ctx, 'discipline.' + to, 'employee', c.employee_id, refOf(c) + ' ' + to + '.');
  return role === 'hr' ? get(ctx, c.id) : { ok: true };
}

// GET /api/discipline/mine — My space: letters to reply to, hearings, the
// outcomes and warnings that are mine, the grievances I raised.
async function mine(ctx) {
  var id = me(ctx);
  if (!id) return { cases: [], warnings: [], against: [] };
  var rows = (await pool.query(SEL + "WHERE c.employee_id = $1 AND (c.kind = 'grievance' OR c.query_sent_at IS NOT NULL OR c.decided_at IS NOT NULL) ORDER BY coalesce(c.updated_at, c.created_at) DESC LIMIT 12", [id])).rows;
  var cases = [];
  for (var i = 0; i < rows.length; i++) {
    var c = rows[i];
    var shown = c.status !== 'closed' && c.status !== 'withdrawn' || warningActive(c) || (c.closed_at && Date.now() - new Date(c.closed_at).getTime() < 30 * 86400000);
    if (!shown) continue;
    var o = await get(ctx, c.id);
    cases.push(o);
  }
  return {
    cases: cases,
    warnings: rows.filter(warningActive).map(function (c) { return { ref: refOf(c), outcome: c.outcome, until: dayText(c.warning_until) }; }),
    categories: GRIEVANCE,
    people: (await pool.query("SELECT id, first_name, last_name FROM employees WHERE status = 'active' AND id <> $1 ORDER BY first_name, last_name", [id])).rows.map(function (p) { return { id: p.id, name: nameOf(p.first_name, p.last_name) }; })
  };
}

// For the daily round: replies late, hearings tomorrow, warnings ending.
async function dueItems() {
  var late = (await pool.query("SELECT c.id, c.number, c.kind, c.title, c.reply_due, c.handler_id, e.first_name, e.last_name FROM discipline_cases c JOIN employees e ON e.id = c.employee_id WHERE c.status = 'awaiting_reply' AND c.reply_due < current_date")).rows;
  var hearings = (await pool.query("SELECT c.id, c.number, c.kind, c.title, c.hearing_at, c.hearing_place, c.panel, c.employee_id, c.handler_id FROM discipline_cases c WHERE c.status = 'hearing' AND c.hearing_at::date = current_date + 1")).rows;
  var ending = (await pool.query("SELECT c.id, c.number, c.kind, c.outcome, c.warning_until, c.employee_id FROM discipline_cases c WHERE c.warning_until = current_date - 1 AND coalesce(c.appeal_result, '') <> 'overturned' AND c.status <> 'withdrawn'")).rows;
  return { late: late, hearings: hearings, ending: ending };
}

module.exports = {
  overview: overview, get: get, open: open, grievance: grievance, note: note, query: query, reply: reply, hearing: hearing, decide: decide,
  appeal: appeal, appealResult: appealResult, setStatus: setStatus, mine: mine, dueItems: dueItems, refOf: refOf, OUTCOME_WORDS: OUTCOME_WORDS, WARNING_MONTHS: WARNING_MONTHS
};
