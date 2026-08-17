// Ported from kernel.js's audit(ctx, action, entity, entityId, summary, meta).
// Takes an explicit `db` executor (the pg pool, or a transaction client) so
// callers that need audit + business-logic writes to commit atomically can
// pass their transaction client through.
async function audit(db, ctx, action, entity, entityId, summary, meta) {
  await db.query(
    'INSERT INTO audit_logs (actor_user_id, actor_name, action, entity, entity_id, summary, meta) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [
      ctx ? ctx.user.id : null,
      ctx && ctx.employee ? ctx.employee.first_name + ' ' + ctx.employee.last_name : 'System',
      action, entity, String(entityId), summary, meta ? JSON.stringify(meta) : null
    ]
  );
}

module.exports = { audit: audit };
