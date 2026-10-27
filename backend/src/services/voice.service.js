var crypto = require('crypto');
var { pool, withTransaction } = require('../db/pool');
var config = require('../config');
var { fail } = require('../utils/errors');
var { audit } = require('../utils/audit');
var { notify } = require('../utils/notify');

// Staff voice (People → Staff voice; migration 0200). Pulse surveys: a few
// questions — a 1 to 5 scale, "would you recommend working here" from 0 to
// 10 (eNPS), a choice, a free answer — to everyone, a company or a
// department. Anonymous by default: an answer keeps no name, only a hash of
// the survey and the person that stops a second answer, and any group (a
// department) is only shown once at least MIN_GROUP people in it have
// answered. The ideas box: anyone shares an idea, openly or without their
// name, everyone votes; whoever runs it answers and moves it along. People
// answer and vote from My space too; surveys closing tomorrow remind whoever
// has not answered (jobs/dailyAlerts.js).

var MIN_GROUP = 5;
var KINDS = ['scale', 'enps', 'choice', 'text'];
var CATEGORIES = ['workplace', 'safety', 'products', 'customers', 'saving', 'wellbeing', 'training', 'other'];
var STATUSES = ['new', 'reviewing', 'planned', 'done', 'not_now'];
var STATUS_WORDS = { new: 'New', reviewing: 'Being looked at', planned: 'Planned', done: 'Done', not_now: 'Not now' };

function text(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function today() { return new Date().toISOString().slice(0, 10); }
function dayText(d) { return d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function nameOf(f, l) { return f ? (f + ' ' + (l || '')).trim() : null; }
function uuidOr(v) { return /^[0-9a-f-]{36}$/i.test(String(v || '')) ? v : null; }
function me(ctx) { return ctx.employee ? ctx.employee.id : null; }
function can(ctx) { return ctx.can('voice.manage'); }
function need(ctx) { if (!can(ctx)) fail('forbidden', 'Your role does not allow this action (voice.manage).'); }
function staffOnly(ctx) { if (!me(ctx)) fail('forbidden', 'Only staff take part here.'); }
// The same person and survey always give the same token; it cannot be read back to a name.
function tokenOf(surveyId, employeeId) { return crypto.createHmac('sha256', String(config.jwt.secret)).update('voice:' + surveyId + ':' + employeeId).digest('hex'); }

// Who a survey goes to: everyone, a company, a department.
async function audienceOf(s) {
  var where = ["e.status = 'active'"], args = [];
  if (s.department_id) { args.push(s.department_id); where.push('e.department_id = $' + args.length); }
  else if (s.company_id) { args.push(s.company_id); where.push('d.company_id = $' + args.length); }
  return (await pool.query('SELECT e.id, e.department_id FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE ' + where.join(' AND '), args)).rows;
}
async function inAudience(s, employeeId) {
  var row = (await pool.query("SELECT e.department_id, d.company_id FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = $1 AND e.status = 'active'", [employeeId])).rows[0];
  if (!row) return false;
  if (s.department_id) return row.department_id === s.department_id;
  if (s.company_id) return row.company_id === s.company_id;
  return true;
}

function cleanQuestions(qs) {
  return (Array.isArray(qs) ? qs : []).slice(0, 15).map(function (q, n) {
    var kind = KINDS.indexOf(q && q.kind) >= 0 ? q.kind : 'scale';
    var options = kind === 'choice' ? (Array.isArray(q.options) ? q.options : []).map(function (o) { return text(o, 60); }).filter(Boolean).slice(0, 8) : [];
    return { id: 'q' + (n + 1), kind: kind, text: text(q && q.text, 200), options: options, optional: kind === 'text' ? true : !!(q && q.optional) };
  }).filter(function (q) { return q.text.length >= 3 && (q.kind !== 'choice' || q.options.length >= 2); });
}

var SSEL = 'SELECT s.*, c.name AS company, d.name AS department, (SELECT count(*)::int FROM voice_responses r WHERE r.survey_id = s.id) AS responses FROM voice_surveys s LEFT JOIN companies c ON c.id = s.company_id LEFT JOIN departments d ON d.id = s.department_id ';
function surveyOut(s) {
  return {
    id: s.id, title: s.title, intro: s.intro, questions: s.questions || [], status: s.status, anonymous: s.anonymous,
    audience: s.department ? s.department : s.company ? s.company : null, companyId: s.company_id, departmentId: s.department_id,
    opensOn: dayText(s.opens_on), closesOn: dayText(s.closes_on), invited: s.invited, responses: s.responses,
    rate: s.invited ? Math.round(s.responses / s.invited * 100) : null, createdAt: s.created_at, closedAt: s.closed_at
  };
}

// eNPS: the share who would recommend (9, 10) less those who would not (0–6).
function enpsOf(values) {
  if (!values.length) return null;
  var pro = values.filter(function (v) { return v >= 9; }).length, det = values.filter(function (v) { return v <= 6; }).length;
  return { score: Math.round((pro - det) / values.length * 100), promoters: pro, passives: values.length - pro - det, detractors: det, n: values.length };
}

// What a survey's answers add up to, keeping groups too small to show back.
function resultsOf(s, responses, departments) {
  var shown = responses.length >= MIN_GROUP || !s.anonymous;
  return (s.questions || []).map(function (q) {
    var values = responses.map(function (r) { return (r.answers || {})[q.id]; }).filter(function (v) { return v !== undefined && v !== null && v !== ''; });
    var out = { id: q.id, kind: q.kind, text: q.text, answered: values.length, hidden: !shown };
    if (!shown) return out;
    if (q.kind === 'scale') {
      var nums = values.map(Number).filter(function (v) { return v >= 1 && v <= 5; });
      out.average = nums.length ? Math.round(nums.reduce(function (a, v) { return a + v; }, 0) / nums.length * 10) / 10 : null;
      out.counts = [1, 2, 3, 4, 5].map(function (v) { return nums.filter(function (x) { return x === v; }).length; });
      out.favourable = nums.length ? Math.round(nums.filter(function (v) { return v >= 4; }).length / nums.length * 100) : null;
    } else if (q.kind === 'enps') {
      var tens = values.map(Number).filter(function (v) { return v >= 0 && v <= 10; });
      out.enps = enpsOf(tens);
      out.counts = Array.from({ length: 11 }, function (_, v) { return tens.filter(function (x) { return x === v; }).length; });
    } else if (q.kind === 'choice') {
      out.options = (q.options || []).map(function (o) { return { option: o, count: values.filter(function (v) { return v === o; }).length }; });
    } else {
      // Free answers, in an order that says nothing about who wrote them.
      out.answers = values.map(function (v) { return text(v, 1000); }).filter(Boolean).sort();
    }
    if (q.kind === 'scale' || q.kind === 'enps') {
      out.byDepartment = departments.map(function (d) {
        var mine = responses.filter(function (r) { return r.department_id === d.id; }).map(function (r) { return Number((r.answers || {})[q.id]); }).filter(function (v) { return !isNaN(v); });
        if (mine.length < MIN_GROUP && s.anonymous) return { department: d.name, n: mine.length, hidden: true };
        return { department: d.name, n: mine.length, value: q.kind === 'enps' ? (enpsOf(mine) || {}).score : Math.round(mine.reduce(function (a, v) { return a + v; }, 0) / (mine.length || 1) * 10) / 10 };
      }).filter(function (x) { return x.n > 0; });
    }
    return out;
  });
}

var ISEL = 'SELECT i.*, e.first_name, e.last_name, r.first_name AS r_first, r.last_name AS r_last, (SELECT count(*)::int FROM voice_votes v WHERE v.idea_id = i.id) AS votes ' +
  'FROM voice_ideas i LEFT JOIN employees e ON e.id = i.author_id LEFT JOIN employees r ON r.id = i.responded_by ';
function ideaOut(i, myVotes, myId) {
  return {
    id: i.id, number: i.number, ref: 'ID-' + String(i.number).padStart(3, '0'), title: i.title, body: i.body, category: i.category, status: i.status,
    author: i.anonymous ? null : nameOf(i.first_name, i.last_name), anonymous: i.anonymous, mine: !!myId && i.author_id === myId,
    votes: i.votes, voted: myVotes.indexOf(i.id) >= 0, response: i.response, respondedBy: nameOf(i.r_first, i.r_last), respondedAt: i.responded_at, createdAt: i.created_at
  };
}

// GET /api/voice?sort=top|new&status= — the ideas box, and the surveys.
async function overview(ctx, q) {
  staffOnly(ctx);
  q = q || {};
  var status = STATUSES.indexOf(q.status) >= 0 ? q.status : '';
  var args = [], where = [];
  if (status) { args.push(status); where.push('i.status = $' + args.length); }
  var order = q.sort === 'new' ? 'i.created_at DESC' : "CASE WHEN i.status IN ('done', 'not_now') THEN 1 ELSE 0 END, votes DESC, i.created_at DESC";
  var ideas = (await pool.query(ISEL + (where.length ? 'WHERE ' + where.join(' AND ') : '') + ' ORDER BY ' + order + ' LIMIT 200', args)).rows;
  var myVotes = (await pool.query('SELECT idea_id FROM voice_votes WHERE employee_id = $1', [me(ctx)])).rows.map(function (r) { return r.idea_id; });
  var counts = (await pool.query('SELECT status, count(*)::int AS n FROM voice_ideas GROUP BY 1')).rows;
  var surveys = (await pool.query(SSEL + (can(ctx) ? '' : "WHERE s.status = 'open' ") + 'ORDER BY s.created_at DESC LIMIT 40')).rows.map(surveyOut);
  // Which open surveys this person has answered, and which are for them.
  for (var i = 0; i < surveys.length; i++) {
    var s = surveys[i];
    if (s.status !== 'open') continue;
    s.forMe = await inAudience({ company_id: s.companyId, department_id: s.departmentId }, me(ctx));
    s.answered = !!(await pool.query('SELECT 1 FROM voice_responses WHERE survey_id = $1 AND token = $2', [s.id, tokenOf(s.id, me(ctx))])).rows[0];
  }
  if (!can(ctx)) surveys = surveys.filter(function (x) { return x.forMe; });
  // eNPS across the surveys that asked it, oldest first.
  var trend = [];
  if (can(ctx)) {
    var closed = (await pool.query(SSEL + "WHERE s.status IN ('open', 'closed') ORDER BY coalesce(s.opens_on, s.created_at::date)")).rows;
    for (var k = 0; k < closed.length; k++) {
      var qe = (closed[k].questions || []).find(function (x) { return x.kind === 'enps'; });
      if (!qe || closed[k].responses < MIN_GROUP) continue;
      var vals = (await pool.query('SELECT answers FROM voice_responses WHERE survey_id = $1', [closed[k].id])).rows.map(function (r) { return Number((r.answers || {})[qe.id]); }).filter(function (v) { return v >= 0 && v <= 10; });
      var e = enpsOf(vals);
      if (e) trend.push({ surveyId: closed[k].id, title: closed[k].title, on: dayText(closed[k].opens_on) || dayText(closed[k].created_at), score: e.score, n: e.n });
    }
  }
  var companies = can(ctx) ? (await pool.query('SELECT id, name FROM companies ORDER BY name')).rows : [];
  var departments = can(ctx) ? (await pool.query('SELECT d.id, d.name, c.name AS company FROM departments d LEFT JOIN companies c ON c.id = d.company_id ORDER BY c.name, d.name')).rows : [];
  return {
    ideas: ideas.map(function (i) { return ideaOut(i, myVotes, me(ctx)); }), surveys: surveys, trend: trend, companies: companies, departments: departments,
    categories: CATEGORIES, statuses: STATUSES, canManage: can(ctx), minGroup: MIN_GROUP,
    summary: {
      ideas: counts.reduce(function (a, r) { return a + r.n; }, 0),
      fresh: (counts.find(function (r) { return r.status === 'new'; }) || { n: 0 }).n,
      planned: (counts.find(function (r) { return r.status === 'planned'; }) || { n: 0 }).n,
      done: (counts.find(function (r) { return r.status === 'done'; }) || { n: 0 }).n,
      openSurveys: surveys.filter(function (x) { return x.status === 'open'; }).length,
      enps: trend.length ? trend[trend.length - 1].score : null,
      enpsBefore: trend.length > 1 ? trend[trend.length - 2].score : null
    }
  };
}

// POST /api/voice/ideas { title, body, category, anonymous }
async function shareIdea(ctx, p) {
  staffOnly(ctx);
  p = p || {};
  var title = text(p.title, 140);
  if (title.length < 5) fail('invalid', 'Give your idea a title.');
  var body = text(p.body, 3000);
  var company = ((await pool.query('SELECT d.company_id FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = $1', [me(ctx)])).rows[0] || {}).company_id || null;
  var row = await withTransaction(async function (db) {
    await db.query('LOCK TABLE voice_ideas IN SHARE ROW EXCLUSIVE MODE');
    var n = (await db.query('SELECT coalesce(max(number), 0) + 1 AS n FROM voice_ideas')).rows[0].n;
    var r = (await db.query('INSERT INTO voice_ideas (number, title, body, category, author_id, anonymous, company_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [n, title, body, CATEGORIES.indexOf(p.category) >= 0 ? p.category : 'other', me(ctx), !!p.anonymous, company])).rows[0];
    // Whoever shares it votes for it.
    await db.query('INSERT INTO voice_votes (idea_id, employee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [r.id, me(ctx)]);
    return r;
  });
  var holders = await require('./staffAlerts.service').holdersOf(['voice.manage']);
  for (var i = 0; i < holders.length; i++) if (holders[i].employee_id !== me(ctx)) await notify(pool, holders[i].employee_id, '💡 A new idea: ' + title, p.anonymous ? 'Shared without a name.' : 'From ' + nameOf(ctx.employee.first_name, ctx.employee.last_name) + '.', '/voice?idea=' + row.id);
  await audit(pool, ctx, 'voice.idea', 'voice_idea', row.id, 'Idea ' + 'ID-' + String(row.number).padStart(3, '0') + ' shared' + (p.anonymous ? ' without a name' : '') + '.');
  return ideaOf(ctx, row.id);
}

async function ideaOf(ctx, id) {
  var i = (await pool.query(ISEL + 'WHERE i.id = $1', [uuidOr(id)])).rows[0];
  if (!i) fail('notfound', 'That idea is gone.');
  var myVotes = (await pool.query('SELECT idea_id FROM voice_votes WHERE employee_id = $1 AND idea_id = $2', [me(ctx), i.id])).rows.map(function (r) { return r.idea_id; });
  return ideaOut(i, myVotes, me(ctx));
}

// POST /api/voice/ideas/:id/vote { on }
async function vote(ctx, id, p) {
  staffOnly(ctx);
  var i = (await pool.query('SELECT id, status FROM voice_ideas WHERE id = $1', [uuidOr(id)])).rows[0];
  if (!i) fail('notfound', 'That idea is gone.');
  if (p && p.on === false) await pool.query('DELETE FROM voice_votes WHERE idea_id = $1 AND employee_id = $2', [i.id, me(ctx)]);
  else {
    if (i.status === 'done' || i.status === 'not_now') fail('conflict', 'That idea is settled.');
    await pool.query('INSERT INTO voice_votes (idea_id, employee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [i.id, me(ctx)]);
  }
  return ideaOf(ctx, i.id);
}

// PUT /api/voice/ideas/:id { status, response } — the answer, and where it stands.
async function answerIdea(ctx, id, p) {
  need(ctx);
  p = p || {};
  var i = (await pool.query('SELECT * FROM voice_ideas WHERE id = $1', [uuidOr(id)])).rows[0];
  if (!i) fail('notfound', 'That idea is gone.');
  var status = STATUSES.indexOf(p.status) >= 0 ? p.status : i.status;
  var response = p.response === undefined ? i.response : text(p.response, 2000);
  if ((status === 'not_now' || status === 'done' || status === 'planned') && response.length < 5) fail('invalid', 'Tell them why, or what happens next.');
  await pool.query('UPDATE voice_ideas SET status = $2, response = $3, responded_by = $4, responded_at = now() WHERE id = $1', [i.id, status, response, me(ctx)]);
  var ref = 'ID-' + String(i.number).padStart(3, '0');
  if (i.author_id && i.author_id !== me(ctx) && (status !== i.status || response !== i.response)) {
    await notify(pool, i.author_id, '💡 Your idea "' + i.title + '": ' + STATUS_WORDS[status].toLowerCase(), response.slice(0, 160), '/voice?idea=' + i.id);
  }
  await audit(pool, ctx, 'voice.answer', 'voice_idea', i.id, ref + ': ' + status + '.');
  return ideaOf(ctx, i.id);
}

// POST /api/voice/surveys { title, intro, questions, companyId, departmentId, anonymous, closesOn }
async function saveSurvey(ctx, id, p) {
  need(ctx);
  p = p || {};
  var title = text(p.title, 120);
  if (title.length < 4) fail('invalid', 'Give the survey a title.');
  var questions = cleanQuestions(p.questions);
  if (!questions.length) fail('invalid', 'Ask at least one question.');
  var closes = /^\d{4}-\d{2}-\d{2}$/.test(String(p.closesOn || '')) ? p.closesOn : null;
  if (closes && closes < today()) fail('invalid', 'It would close in the past.');
  var dept = uuidOr(p.departmentId), company = dept ? null : uuidOr(p.companyId);
  var row;
  if (id) {
    var cur = (await pool.query('SELECT * FROM voice_surveys WHERE id = $1', [uuidOr(id)])).rows[0];
    if (!cur) fail('notfound', 'That survey is gone.');
    if (cur.status !== 'draft') fail('conflict', 'It has been sent: its questions stay as they were.');
    row = (await pool.query('UPDATE voice_surveys SET title = $2, intro = $3, questions = $4, company_id = $5, department_id = $6, anonymous = $7, closes_on = $8 WHERE id = $1 RETURNING *',
      [cur.id, title, text(p.intro, 1000), JSON.stringify(questions), company, dept, p.anonymous !== false, closes])).rows[0];
  } else {
    row = (await pool.query('INSERT INTO voice_surveys (title, intro, questions, company_id, department_id, anonymous, closes_on, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [title, text(p.intro, 1000), JSON.stringify(questions), company, dept, p.anonymous !== false, closes, me(ctx)])).rows[0];
  }
  await audit(pool, ctx, 'voice.survey', 'voice_survey', row.id, 'Survey "' + title + '" saved.');
  return survey(ctx, row.id);
}

// POST /api/voice/surveys/:id/open — sent to its people; /close — no more answers.
async function setSurvey(ctx, id, to) {
  need(ctx);
  var s = (await pool.query('SELECT * FROM voice_surveys WHERE id = $1', [uuidOr(id)])).rows[0];
  if (!s) fail('notfound', 'That survey is gone.');
  if (to === 'open') {
    if (s.status !== 'draft') fail('conflict', 'It has been sent already.');
    var people = await audienceOf(s);
    if (!people.length) fail('invalid', 'No one is in that group.');
    var closes = dayText(s.closes_on) || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    await pool.query("UPDATE voice_surveys SET status = 'open', opens_on = current_date, closes_on = $2, invited = $3 WHERE id = $1", [s.id, closes, people.length]);
    for (var i = 0; i < people.length; i++) {
      await notify(pool, people[i].id, '📣 ' + s.title, (s.anonymous ? 'Anonymous, a couple of minutes' : 'A couple of minutes') + ' — open until ' + closes + '. Answer it in My space.', '/myspace');
    }
  } else {
    if (s.status !== 'open') fail('conflict', 'It is not open.');
    await pool.query("UPDATE voice_surveys SET status = 'closed', closed_at = now() WHERE id = $1", [s.id]);
  }
  await audit(pool, ctx, 'voice.survey', 'voice_survey', s.id, 'Survey "' + s.title + '" ' + (to === 'open' ? 'sent' : 'closed') + '.');
  return survey(ctx, s.id);
}

// GET /api/voice/surveys/:id — whoever runs it sees the results; anyone it is
// for sees its questions, and whether they have answered.
async function survey(ctx, id) {
  staffOnly(ctx);
  var s = (await pool.query(SSEL + 'WHERE s.id = $1', [uuidOr(id)])).rows[0];
  if (!s) fail('notfound', 'That survey is gone.');
  var out = surveyOut(s);
  out.answered = !!(await pool.query('SELECT 1 FROM voice_responses WHERE survey_id = $1 AND token = $2', [s.id, tokenOf(s.id, me(ctx))])).rows[0];
  if (can(ctx)) {
    var responses = (await pool.query('SELECT answers, department_id FROM voice_responses WHERE survey_id = $1', [s.id])).rows;
    var departments = (await pool.query('SELECT DISTINCT d.id, d.name FROM voice_responses r JOIN departments d ON d.id = r.department_id WHERE r.survey_id = $1 ORDER BY d.name', [s.id])).rows;
    out.results = resultsOf(s, responses, departments);
    out.hidden = s.anonymous && responses.length < MIN_GROUP;
    out.canManage = true;
    out.minGroup = MIN_GROUP;
  } else if (s.status !== 'open' || !(await inAudience(s, me(ctx)))) {
    fail('forbidden', 'That survey is not for you.');
  }
  return out;
}

// POST /api/voice/surveys/:id/answer { answers: { q1: 4, q2: 9, q3: 'text' } }
async function answer(ctx, id, p) {
  staffOnly(ctx);
  var s = (await pool.query('SELECT * FROM voice_surveys WHERE id = $1', [uuidOr(id)])).rows[0];
  if (!s) fail('notfound', 'That survey is gone.');
  if (s.status !== 'open' || (s.closes_on && dayText(s.closes_on) < today())) fail('conflict', 'That survey has closed.');
  if (!(await inAudience(s, me(ctx)))) fail('forbidden', 'That survey is not for you.');
  var given = (p && p.answers) || {};
  var answers = {};
  (s.questions || []).forEach(function (q) {
    var v = given[q.id];
    if (v === undefined || v === null || v === '') { if (!q.optional) fail('invalid', 'Answer: ' + q.text); return; }
    if (q.kind === 'scale') { v = Math.round(Number(v)); if (!(v >= 1 && v <= 5)) fail('invalid', 'Pick 1 to 5: ' + q.text); }
    else if (q.kind === 'enps') { v = Math.round(Number(v)); if (!(v >= 0 && v <= 10)) fail('invalid', 'Pick 0 to 10: ' + q.text); }
    else if (q.kind === 'choice') { if ((q.options || []).indexOf(v) < 0) fail('invalid', 'Pick one: ' + q.text); }
    else v = text(v, 1000);
    answers[q.id] = v;
  });
  var dept = ((await pool.query('SELECT department_id FROM employees WHERE id = $1', [me(ctx)])).rows[0] || {}).department_id || null;
  try {
    await pool.query('INSERT INTO voice_responses (survey_id, token, employee_id, department_id, answers) VALUES ($1,$2,$3,$4,$5)',
      [s.id, tokenOf(s.id, me(ctx)), s.anonymous ? null : me(ctx), dept, JSON.stringify(answers)]);
  } catch (e) {
    if (e.code === '23505') fail('conflict', 'You have answered it already. Thank you!');
    throw e;
  }
  return { ok: true, anonymous: s.anonymous };
}

// GET /api/voice/mine — My space: surveys to answer, my ideas, the top ones.
async function mine(ctx) {
  if (!me(ctx)) return { surveys: [], ideas: [], top: [] };
  var open = (await pool.query(SSEL + "WHERE s.status = 'open' AND (s.closes_on IS NULL OR s.closes_on >= current_date) ORDER BY s.closes_on")).rows;
  var surveys = [];
  for (var i = 0; i < open.length; i++) {
    if (!(await inAudience(open[i], me(ctx)))) continue;
    var done = !!(await pool.query('SELECT 1 FROM voice_responses WHERE survey_id = $1 AND token = $2', [open[i].id, tokenOf(open[i].id, me(ctx))])).rows[0];
    var o = surveyOut(open[i]);
    o.answered = done;
    surveys.push(o);
  }
  var myVotes = (await pool.query('SELECT idea_id FROM voice_votes WHERE employee_id = $1', [me(ctx)])).rows.map(function (r) { return r.idea_id; });
  var ideas = (await pool.query(ISEL + 'WHERE i.author_id = $1 ORDER BY i.created_at DESC LIMIT 5', [me(ctx)])).rows.map(function (x) { return ideaOut(x, myVotes, me(ctx)); });
  var top = (await pool.query(ISEL + "WHERE i.status IN ('new', 'reviewing', 'planned') ORDER BY votes DESC, i.created_at DESC LIMIT 3")).rows.map(function (x) { return ideaOut(x, myVotes, me(ctx)); });
  return { surveys: surveys, ideas: ideas, top: top, categories: CATEGORIES };
}

// For the daily round: surveys past their day are closed; those closing
// tomorrow, and who in them has not answered yet.
async function closeDue() {
  return (await pool.query("UPDATE voice_surveys SET status = 'closed', closed_at = now() WHERE status = 'open' AND closes_on < current_date RETURNING id, title")).rows;
}
async function closingTomorrow() {
  var rows = (await pool.query("SELECT * FROM voice_surveys WHERE status = 'open' AND closes_on = current_date + 1")).rows;
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var people = await audienceOf(rows[i]);
    var answered = (await pool.query('SELECT token FROM voice_responses WHERE survey_id = $1', [rows[i].id])).rows.map(function (r) { return r.token; });
    out.push({ survey: rows[i], waiting: people.filter(function (pp) { return answered.indexOf(tokenOf(rows[i].id, pp.id)) < 0; }).map(function (pp) { return pp.id; }) });
  }
  return out;
}

module.exports = {
  overview: overview, shareIdea: shareIdea, vote: vote, answerIdea: answerIdea, saveSurvey: saveSurvey, setSurvey: setSurvey, survey: survey, answer: answer, mine: mine,
  closeDue: closeDue, closingTomorrow: closingTomorrow, tokenOf: tokenOf, MIN_GROUP: MIN_GROUP
};
