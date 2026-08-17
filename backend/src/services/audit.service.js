var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');

// kernel.js: handlers['audit.list']
async function list(ctx, q) {
  if (!ctx.can('audit.read')) fail('forbidden', 'Your role does not allow this action (audit.read).');
  q = String(q || '').toLowerCase();

  var res;
  if (q) {
    res = await pool.query(
      "SELECT * FROM audit_logs WHERE lower(action || ' ' || summary || ' ' || coalesce(actor_name,'')) LIKE $1 ORDER BY at DESC LIMIT 120",
      ['%' + q + '%']
    );
  } else {
    res = await pool.query('SELECT * FROM audit_logs ORDER BY at DESC LIMIT 120');
  }

  return res.rows.map(function (l) {
    return {
      id: l.id, at: l.at, actorUserId: l.actor_user_id, actorName: l.actor_name,
      action: l.action, entity: l.entity, entityId: l.entity_id, summary: l.summary, meta: l.meta
    };
  });
}

module.exports = { list: list };
