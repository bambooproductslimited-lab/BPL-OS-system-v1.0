var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');

// The inbox's pulse (GET /api/crm/inbox/pulse), for the Inbox page's banner
// and its "How we're replying" panels: how fast customers get an answer,
// who is waiting longest, which channels they write on, when in the week
// they write, and who on the team answers most — from the live channels
// only (WhatsApp, email, Instagram, Facebook; not chats imported from
// WhatsApp's export file, which say nothing about how fast we answer now).
//
// A customer's "turn" starts with their first message after one of ours
// (or their very first). It is answered by our next message in that
// conversation — sent from the OS, or on the channel itself (a reply typed
// on the phone comes back as ours too). Times are as they are: an evening
// message answered the next morning counts its night.

var LIVE = ['whatsapp', 'email', 'instagram', 'facebook'];
var DAY = 86400000;

function need(ctx, perm) { if (!ctx.can(perm)) fail('forbidden', 'Your role does not allow this action (' + perm + ').'); }
function median(xs) {
  if (!xs.length) return null;
  var s = xs.slice().sort(function (a, b) { return a - b; });
  var m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}
function isoDay(d) { return new Date(d).toISOString().slice(0, 10); }
function photoOf(key, at) { return key && at ? new Date(at).getTime() : null; }

// Each customer turn since `since`, with when (and by whom) it was answered.
async function turns(since) {
  return (await pool.query(
    'WITH m AS (' +
    '  SELECT m.conversation_id, m.direction, m.sent_at, cv.channel, ' +
    '         lag(m.direction) OVER (PARTITION BY m.conversation_id ORDER BY m.sent_at, m.created_at) AS prev ' +
    '  FROM crm_messages m JOIN crm_conversations cv ON cv.id = m.conversation_id ' +
    "  WHERE NOT cv.imported AND cv.status <> 'spam' AND cv.channel = ANY($1) AND m.sent_at >= $2::timestamptz - interval '7 days'" +
    '), t AS (' +
    "  SELECT conversation_id, channel, sent_at FROM m WHERE direction = 'in' AND (prev IS NULL OR prev = 'out') AND sent_at >= $2" +
    ') ' +
    'SELECT t.channel, t.sent_at, r.sent_at AS replied_at, r.sent_by FROM t LEFT JOIN LATERAL (' +
    "  SELECT o.sent_at, o.sent_by FROM crm_messages o WHERE o.conversation_id = t.conversation_id AND o.direction = 'out' AND o.sent_at >= t.sent_at " +
    '  ORDER BY o.sent_at LIMIT 1) r ON true',
    [LIVE, since])).rows;
}

// Answered within the hour, out of the turns that have had their hour.
function speed(list, now) {
  var mins = [], due = 0, fast = 0;
  list.forEach(function (t) {
    var m = t.replied_at ? (new Date(t.replied_at) - new Date(t.sent_at)) / 60000 : null;
    if (m !== null) mins.push(m);
    if (m !== null || now - new Date(t.sent_at) >= 3600000) { due++; if (m !== null && m <= 60) fast++; }
  });
  return { turns: list.length, answered: mins.length, median: median(mins), within1h: due ? Math.round(fast / due * 100) : null };
}

async function pulse(ctx) {
  need(ctx, 'crm.read');
  var now = Date.now();
  var weekAgo = new Date(now - 7 * DAY), monthAgo = new Date(now - 30 * DAY);
  var todayStart = new Date(isoDay(now) + 'T00:00:00Z');

  var week = await turns(weekAgo);
  var today = week.filter(function (t) { return new Date(t.sent_at) >= todayStart; });

  // Who answered, this week: replies written in the OS carry their writer.
  var by = {};
  week.forEach(function (t) {
    if (!t.replied_at || !t.sent_by) return;
    (by[t.sent_by] = by[t.sent_by] || []).push((new Date(t.replied_at) - new Date(t.sent_at)) / 60000);
  });
  var ids = Object.keys(by);
  var people = ids.length ? (await pool.query('SELECT id, first_name, last_name, photo_key, photo_updated_at FROM employees WHERE id = ANY($1)', [ids])).rows : [];
  var repliers = people.map(function (e) {
    return { id: e.id, name: [e.first_name, e.last_name].filter(Boolean).join(' '), photo: photoOf(e.photo_key, e.photo_updated_at), replies: by[e.id].length, median: median(by[e.id]) };
  }).sort(function (a, b) { return b.replies - a.replies || a.median - b.median || a.name.localeCompare(b.name); });

  // Messages each way, day by day (the last 7 days), and by channel.
  var daily = (await pool.query(
    "SELECT (m.sent_at AT TIME ZONE 'UTC')::date::text AS d, count(*) FILTER (WHERE m.direction = 'in')::int AS n_in, count(*) FILTER (WHERE m.direction = 'out')::int AS n_out " +
    'FROM crm_messages m JOIN crm_conversations cv ON cv.id = m.conversation_id ' +
    "WHERE NOT cv.imported AND cv.status <> 'spam' AND cv.channel = ANY($1) AND m.sent_at >= $2 GROUP BY 1", [LIVE, new Date(isoDay(now - 6 * DAY) + 'T00:00:00Z')])).rows;
  var dayMap = {};
  daily.forEach(function (r) { dayMap[r.d] = r; });
  var days = Array.from({ length: 7 }, function (_, i) {
    var k = isoDay(now - (6 - i) * DAY);
    return { day: k, in: dayMap[k] ? dayMap[k].n_in : 0, out: dayMap[k] ? dayMap[k].n_out : 0 };
  });
  var chRows = (await pool.query(
    'SELECT cv.channel, count(*)::int AS n FROM crm_messages m JOIN crm_conversations cv ON cv.id = m.conversation_id ' +
    "WHERE NOT cv.imported AND cv.status <> 'spam' AND cv.channel = ANY($1) AND m.direction = 'in' AND m.sent_at >= $2 GROUP BY 1", [LIVE, weekAgo])).rows;
  var channels = LIVE.map(function (k) { var r = chRows.find(function (x) { return x.channel === k; }); return { channel: k, in: r ? r.n : 0 }; });

  // When customers write: weekday (Monday first) by hour, the last 30 days.
  var heatRows = (await pool.query(
    "SELECT (extract(isodow FROM m.sent_at AT TIME ZONE 'UTC')::int - 1) AS dow, extract(hour FROM m.sent_at AT TIME ZONE 'UTC')::int AS h, count(*)::int AS n " +
    'FROM crm_messages m JOIN crm_conversations cv ON cv.id = m.conversation_id ' +
    "WHERE NOT cv.imported AND cv.status <> 'spam' AND cv.channel = ANY($1) AND m.direction = 'in' AND m.sent_at >= $2 GROUP BY 1, 2", [LIVE, monthAgo])).rows;
  var heat = Array.from({ length: 7 }, function () { return Array(24).fill(0); });
  var busiest = null, heatMax = 0;
  heatRows.forEach(function (r) {
    heat[r.dow][r.h] = r.n;
    if (r.n > heatMax) { heatMax = r.n; busiest = { dow: r.dow, hour: r.h, n: r.n }; }
  });

  // Who is waiting longest right now.
  var waiting = (await pool.query(
    "SELECT cv.id, cv.channel, cv.last_message_at, cv.contact_name, cv.contact_label, c.name AS customer_name, count(*) OVER ()::int AS total " +
    'FROM crm_conversations cv LEFT JOIN customers c ON c.id = cv.customer_id ' +
    "WHERE cv.status = 'open' AND cv.last_direction = 'in' AND NOT cv.imported ORDER BY cv.last_message_at ASC NULLS LAST LIMIT 6")).rows;

  return {
    reply: Object.assign(speed(week, now), { today: speed(today, now) }),
    today: { in: dayMap[isoDay(now)] ? dayMap[isoDay(now)].n_in : 0, out: dayMap[isoDay(now)] ? dayMap[isoDay(now)].n_out : 0 },
    days: days,
    channels: channels,
    heat: { grid: heat, max: heatMax, busiest: busiest },
    repliers: repliers.slice(0, 6),
    waiting: {
      total: waiting.length ? waiting[0].total : 0,
      longest: waiting.map(function (r) { return { id: r.id, channel: r.channel, since: r.last_message_at, name: r.customer_name || r.contact_name || r.contact_label || '' }; })
    }
  };
}

module.exports = { pulse: pulse, LIVE: LIVE };
