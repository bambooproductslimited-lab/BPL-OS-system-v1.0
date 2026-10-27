var { pool, withTransaction } = require('../db/pool');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');

// Staff performance reviews (People → Performance reviews; migration 0198):
// HR opens a round for a period and the companies it covers; everyone in
// them gets a review, with their manager (their own, else their
// department's) as the reviewer. Each person rates themselves from My space
// and says how it went; the reviewer then scores the same points, writes
// what went well, what to work on and the goals for the next period; the
// person reads it and signs it, with a word of their own if they like.

var DEFAULT_QUESTIONS = ['quality', 'reliability', 'teamwork', 'initiative', 'customers'];
var KNOWN = { quality: 'Quality of work', reliability: 'Reliability and time-keeping', teamwork: 'Teamwork', initiative: 'Initiative', customers: 'Care for customers and safety', learning: 'Learning and skills', leadership: 'Leading others' };
var DAY = /^\d{4}-\d{2}-\d{2}$/;

function text(v, max) { return String(v == null ? '' : v).replace(/[ \t]+/g, ' ').trim().slice(0, max); }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function nameOf(f, l) { return f ? (f + ' ' + (l || '')).trim() : null; }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function need(ctx) { if (!ctx.can('review.manage')) fail('forbidden', 'Your role does not allow this action (review.manage).'); }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }

function questionsOf(round) {
  return (round.questions || []).map(function (q) { return typeof q === 'string' ? { key: q, label: KNOWN[q] || q } : { key: q.key, label: q.label || KNOWN[q.key] || q.key }; });
}
// Scores 1–5 for the round's questions; anything else dropped.
function cleanScores(round, s, all) {
  var out = {};
  questionsOf(round).forEach(function (q) {
    var v = Math.round(Number((s || {})[q.key]));
    if (v >= 1 && v <= 5) out[q.key] = v;
  });
  if (all && Object.keys(out).length < questionsOf(round).length) fail('invalid', 'Give a score from 1 to 5 for every point.');
  return out;
}
function avg(scores) { var v = Object.keys(scores).map(function (k) { return scores[k]; }); return v.length ? Math.round(v.reduce(function (a, b) { return a + b; }, 0) / v.length * 10) / 10 : null; }

var SELECT = 'SELECT r.*, w.name AS round_name, w.period_start, w.period_end, w.self_due, w.due_on, w.questions, w.status AS round_status, ' +
  'e.first_name, e.last_name, e.code, e.position_title, c.name AS company, d.name AS department, m.first_name AS m_first, m.last_name AS m_last ' +
  'FROM reviews r JOIN review_rounds w ON w.id = r.round_id JOIN employees e ON e.id = r.employee_id LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN companies c ON c.id = d.company_id ' +
  'LEFT JOIN employees m ON m.id = r.reviewer_id ';

// What one person may see of a review: the reviewer and HR see it all; the
// person sees their own part, and the reviewer's once it is done.
function reviewOut(r, ctx) {
  var mine = me(ctx) === r.employee_id, reviewer = me(ctx) === r.reviewer_id, hr = ctx.can('review.manage');
  var showManager = hr || reviewer || r.status === 'done' || r.status === 'signed';
  var round = { questions: r.questions };
  return {
    id: r.id, roundId: r.round_id, round: { name: r.round_name, periodStart: dayText(r.period_start), periodEnd: dayText(r.period_end), selfDue: dayText(r.self_due), dueOn: dayText(r.due_on), status: r.round_status },
    employee: { id: r.employee_id, name: nameOf(r.first_name, r.last_name), code: r.code, position: r.position_title || '', company: r.company || '', department: r.department || '' },
    reviewer: r.reviewer_id ? { id: r.reviewer_id, name: nameOf(r.m_first, r.m_last) } : null,
    status: r.status, questions: questionsOf(round),
    self: { scores: r.self_scores || {}, comment: r.self_comment, at: r.self_at, average: avg(r.self_scores || {}) },
    manager: showManager ? { scores: r.scores || {}, strengths: r.strengths, improve: r.improve, goals: r.goals || [], overall: r.overall == null ? null : Number(r.overall), at: r.manager_at } : null,
    employeeComment: r.employee_comment, signedAt: r.signed_at,
    you: { employee: mine, reviewer: reviewer, hr: hr },
    late: r.status === 'self' ? dayText(r.self_due) < today() : r.status === 'manager' ? dayText(r.due_on) < today() : false
  };
}
async function one(id) {
  var r = (await pool.query(SELECT + 'WHERE r.id = $1', [uuidOr(id)])).rows[0];
  if (!r) fail('notfound', 'That review is gone.');
  return r;
}
function canSee(ctx, r) { return ctx.can('review.manage') || me(ctx) === r.employee_id || me(ctx) === r.reviewer_id; }

// GET /api/reviews?round= — HR: every review of a round; a reviewer: theirs.
async function list(ctx, q) {
  q = q || {};
  var hr = ctx.can('review.manage');
  var rounds = (await pool.query("SELECT w.*, (SELECT count(*)::int FROM reviews WHERE round_id = w.id) AS n, (SELECT count(*)::int FROM reviews WHERE round_id = w.id AND status IN ('done', 'signed')) AS done, " +
    "(SELECT count(*)::int FROM reviews WHERE round_id = w.id AND status = 'signed') AS signed, (SELECT round(avg(overall), 1) FROM reviews WHERE round_id = w.id AND overall IS NOT NULL) AS avg FROM review_rounds w " +
    // Without review.manage, only the rounds in which the caller reviews someone.
    'WHERE $1::boolean OR EXISTS (SELECT 1 FROM reviews x WHERE x.round_id = w.id AND x.reviewer_id = $2) ORDER BY w.period_end DESC, w.created_at DESC LIMIT 20', [hr, me(ctx)])).rows;
  var round = rounds.find(function (w) { return w.id === q.round; }) || rounds[0] || null;
  var rows = [];
  if (round) rows = (await pool.query(SELECT + 'WHERE r.round_id = $1' + (hr ? '' : ' AND r.reviewer_id = $2') + " ORDER BY (r.status = 'manager') DESC, c.name, e.first_name", hr ? [round.id] : [round.id, me(ctx)])).rows;
  var mine = me(ctx) ? (await pool.query(SELECT + "WHERE r.reviewer_id = $1 AND r.status IN ('self', 'manager') AND w.status = 'open'", [me(ctx)])).rows.length : 0;
  var reviews = rows.map(function (r) { return reviewOut(r, ctx); });
  var count = function (s) { return reviews.filter(function (r) { return r.status === s; }).length; };
  return {
    rounds: rounds.map(function (w) { return { id: w.id, name: w.name, periodStart: dayText(w.period_start), periodEnd: dayText(w.period_end), selfDue: dayText(w.self_due), dueOn: dayText(w.due_on), status: w.status, reviews: w.n, done: w.done, signed: w.signed, average: w.avg == null ? null : Number(w.avg) }; }),
    round: round ? round.id : null, reviews: reviews,
    summary: { self: count('self'), manager: count('manager'), done: count('done'), signed: count('signed'), late: reviews.filter(function (r) { return r.late; }).length, noReviewer: reviews.filter(function (r) { return !r.reviewer; }).length },
    toReview: mine, canManage: hr, known: KNOWN, defaults: DEFAULT_QUESTIONS,
    companies: hr ? (await pool.query("SELECT id, code, name FROM companies WHERE coalesce(status, 'active') = 'active' ORDER BY name")).rows : [],
    people: hr ? (await pool.query("SELECT id, first_name, last_name FROM employees WHERE status = 'active' ORDER BY first_name, last_name LIMIT 1000")).rows.map(function (e) { return { id: e.id, name: nameOf(e.first_name, e.last_name) }; }) : []
  };
}

// GET /api/reviews/mine — my own reviews, and how many I have to write.
async function mine(ctx) {
  if (!me(ctx)) return { reviews: [], toReview: 0 };
  var rows = (await pool.query(SELECT + 'WHERE r.employee_id = $1 ORDER BY w.period_end DESC LIMIT 6', [me(ctx)])).rows;
  var toReview = (await pool.query("SELECT count(*)::int AS n FROM reviews r JOIN review_rounds w ON w.id = r.round_id WHERE r.reviewer_id = $1 AND r.status IN ('self', 'manager') AND w.status = 'open'", [me(ctx)])).rows[0].n;
  return { reviews: rows.map(function (r) { return reviewOut(r, ctx); }), toReview: toReview };
}

async function get(ctx, id) {
  var r = await one(id);
  if (!canSee(ctx, r)) fail('forbidden', 'That review is not yours to read.');
  return reviewOut(r, ctx);
}

// POST /api/reviews/rounds { name, periodStart, periodEnd, selfDue, dueOn, companyIds, questions }
async function openRound(ctx, p) {
  need(ctx);
  p = p || {};
  var name = text(p.name, 80);
  if (name.length < 3) fail('invalid', 'Name the round, e.g. Second half 2026.');
  ['periodStart', 'periodEnd', 'selfDue', 'dueOn'].forEach(function (k) { if (!DAY.test(String(p[k] || ''))) fail('invalid', 'Pick the dates: the period, when self-reviews and reviews are due.'); });
  if (p.periodEnd < p.periodStart) fail('invalid', 'The period cannot end before it starts.');
  if (p.dueOn < p.selfDue) fail('invalid', 'Reviews are due after the self-reviews.');
  var keys = (Array.isArray(p.questions) ? p.questions : DEFAULT_QUESTIONS).filter(function (k, i, a) { return KNOWN[k] && a.indexOf(k) === i; });
  var custom = (Array.isArray(p.custom) ? p.custom : []).map(function (t) { return text(t, 80); }).filter(function (t) { return t.length >= 3; }).slice(0, 4);
  var questions = keys.concat(custom.map(function (t, i) { return { key: 'custom' + (i + 1), label: t }; }));
  if (questions.length < 2) fail('invalid', 'Choose at least two points to score.');
  var companyIds = (Array.isArray(p.companyIds) ? p.companyIds : []).map(uuidOr).filter(Boolean);
  if (!companyIds.length) fail('invalid', 'Which companies does the round cover?');
  var res = await withTransaction(async function (db) {
    var w = (await db.query('INSERT INTO review_rounds (name, period_start, period_end, self_due, due_on, questions, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [name, p.periodStart, p.periodEnd, p.selfDue, p.dueOn, JSON.stringify(questions), me(ctx)])).rows[0];
    // Everyone active in those companies; their own manager reviews them,
    // else their department's (never themselves).
    var people = (await db.query("SELECT e.id, CASE WHEN e.manager_id IS NOT NULL AND e.manager_id <> e.id THEN e.manager_id WHEN d.manager_id IS NOT NULL AND d.manager_id <> e.id THEN d.manager_id END AS reviewer " +
      "FROM employees e JOIN departments d ON d.id = e.department_id WHERE e.status = 'active' AND d.company_id = ANY($1::uuid[])", [companyIds])).rows;
    for (var i = 0; i < people.length; i++) await db.query('INSERT INTO reviews (round_id, employee_id, reviewer_id) VALUES ($1, $2, $3)', [w.id, people[i].id, people[i].reviewer]);
    return { round: w, people: people };
  });
  for (var i = 0; i < res.people.length; i++) {
    await notify(pool, res.people[i].id, '📝 Your review: ' + name, 'Rate how your ' + dayText(res.round.period_start) + ' to ' + dayText(res.round.period_end) + ' went, by ' + dayText(res.round.self_due) + '. Your manager reviews it next.', '/myspace');
  }
  await audit(pool, ctx, 'review.round', 'review_round', res.round.id, 'Opened the review round ' + name + ' for ' + res.people.length + ' people.');
  return list(ctx, { round: res.round.id });
}

// POST /api/reviews/rounds/:id/close
async function closeRound(ctx, id) {
  need(ctx);
  var w = (await pool.query("UPDATE review_rounds SET status = 'closed' WHERE id = $1 RETURNING *", [uuidOr(id)])).rows[0];
  if (!w) fail('notfound', 'That round is gone.');
  await audit(pool, ctx, 'review.round', 'review_round', w.id, 'Closed the review round ' + w.name + '.');
  return list(ctx, { round: w.id });
}

// POST /api/reviews/:id/reviewer { reviewerId }
async function setReviewer(ctx, id, p) {
  need(ctx);
  var r = await one(id);
  var rid = uuidOr((p || {}).reviewerId);
  if (!rid) fail('invalid', 'Who reviews them?');
  if (rid === r.employee_id) fail('invalid', 'Someone else reviews them.');
  var who = (await pool.query("SELECT id, first_name, last_name FROM employees WHERE id = $1 AND status = 'active'", [rid])).rows[0];
  if (!who) fail('invalid', 'Pick someone on the staff.');
  await pool.query('UPDATE reviews SET reviewer_id = $2, updated_at = now() WHERE id = $1', [r.id, rid]);
  if (r.status === 'manager') await notify(pool, rid, '📝 Review ' + nameOf(r.first_name, r.last_name), 'Their self-review is in: your turn.', '/reviews?open=' + r.id);
  await audit(pool, ctx, 'review.reviewer', 'review', r.id, nameOf(who.first_name, who.last_name) + ' reviews ' + nameOf(r.first_name, r.last_name) + ' (' + r.round_name + ').');
  return reviewOut(await one(r.id), ctx);
}

// POST /api/reviews/:id/self { scores, comment }
async function selfReview(ctx, id, p) {
  p = p || {};
  var r = await one(id);
  if (me(ctx) !== r.employee_id) fail('forbidden', 'Only they write their own self-review.');
  if (r.round_status !== 'open') fail('conflict', 'That round is closed.');
  if (r.status !== 'self') fail('conflict', 'Your self-review is in already.');
  var scores = cleanScores({ questions: r.questions }, p.scores, true);
  var comment = text(p.comment, 2000);
  if (comment.length < 10) fail('invalid', 'Say a few words about how it went.');
  await pool.query("UPDATE reviews SET self_scores = $2, self_comment = $3, self_at = now(), status = 'manager', updated_at = now() WHERE id = $1", [r.id, scores, comment]);
  if (r.reviewer_id) await notify(pool, r.reviewer_id, '📝 Review ' + nameOf(r.first_name, r.last_name), 'Their self-review is in. Your review is due by ' + dayText(r.due_on) + '.', '/reviews?open=' + r.id);
  await audit(pool, ctx, 'review.self', 'review', r.id, nameOf(r.first_name, r.last_name) + ' sent their self-review (' + r.round_name + ').');
  return reviewOut(await one(r.id), ctx);
}

// POST /api/reviews/:id/manager { scores, strengths, improve, goals: [text] }
async function managerReview(ctx, id, p) {
  p = p || {};
  var r = await one(id);
  if (me(ctx) !== r.reviewer_id && !ctx.can('review.manage')) fail('forbidden', 'Only their reviewer writes this.');
  if (me(ctx) === r.employee_id) fail('forbidden', 'Someone else reviews you.');
  if (r.round_status !== 'open') fail('conflict', 'That round is closed.');
  if (r.status === 'done' || r.status === 'signed') fail('conflict', 'The review is done already.');
  var scores = cleanScores({ questions: r.questions }, p.scores, true);
  var strengths = text(p.strengths, 2000), improve = text(p.improve, 2000);
  if (strengths.length < 5) fail('invalid', 'What went well? A few words.');
  var goals = (Array.isArray(p.goals) ? p.goals : []).map(function (g) { return text(typeof g === 'string' ? g : g && g.text, 200); }).filter(function (g) { return g.length >= 3; }).slice(0, 6);
  if (!goals.length) fail('invalid', 'Set at least one goal for the next period.');
  var overall = avg(scores);
  await pool.query("UPDATE reviews SET scores = $2, strengths = $3, improve = $4, goals = $5, overall = $6, manager_at = now(), status = 'done', reviewer_id = coalesce(reviewer_id, $7), updated_at = now() WHERE id = $1",
    [r.id, scores, strengths, improve, JSON.stringify(goals.map(function (g) { return { text: g }; })), overall, me(ctx)]);
  await notify(pool, r.employee_id, '📝 Your review is ready to read', r.round_name + ': read it and sign it in My space.', '/myspace');
  await audit(pool, ctx, 'review.manager', 'review', r.id, 'Reviewed ' + nameOf(r.first_name, r.last_name) + ' (' + r.round_name + '): ' + overall + ' of 5.');
  return reviewOut(await one(r.id), ctx);
}

// POST /api/reviews/:id/sign { comment }
async function sign(ctx, id, p) {
  var r = await one(id);
  if (me(ctx) !== r.employee_id) fail('forbidden', 'Only they sign their own review.');
  if (r.status !== 'done') fail('conflict', r.status === 'signed' ? 'You signed it already.' : 'Your reviewer has not finished it yet.');
  var comment = text((p || {}).comment, 1000);
  await pool.query("UPDATE reviews SET employee_comment = $2, signed_at = now(), status = 'signed', updated_at = now() WHERE id = $1", [r.id, comment]);
  if (r.reviewer_id) await notify(pool, r.reviewer_id, '✍️ ' + nameOf(r.first_name, r.last_name) + ' signed their review', comment || r.round_name, '/reviews?open=' + r.id);
  await audit(pool, ctx, 'review.sign', 'review', r.id, nameOf(r.first_name, r.last_name) + ' signed their review (' + r.round_name + ').');
  return reviewOut(await one(r.id), ctx);
}

module.exports = { list: list, mine: mine, get: get, openRound: openRound, closeRound: closeRound, setReviewer: setReviewer, selfReview: selfReview, managerReview: managerReview, sign: sign, KNOWN: KNOWN };
