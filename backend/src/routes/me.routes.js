var express = require('express');
var { requireAuth } = require('../middleware/auth');
var { pool } = require('../db/pool');
var { serializeEmployee } = require('../services/context.service');
var { rowToLeaveRequest } = require('../services/leave.service');
var { rowToAttendance } = require('../services/attendance.service');
var authService = require('../services/auth.service');
var { fail } = require('../utils/errors');

var router = express.Router();

function serializeCtx(ctx) {
  return {
    userId: ctx.user.id,
    email: ctx.user.email,
    mustChangePassword: ctx.user.mustChangePassword,
    locale: ctx.user.locale,
    employee: serializeEmployee(ctx.employee),
    roleNames: ctx.roleNames,
    permissions: ctx.permissions
  };
}

// kernel.js: api.currentContext() -> GET /api/me
router.get('/', requireAuth, function (req, res) {
  res.json(serializeCtx(req.ctx));
});

// Self-service password change — see middleware/auth.js's
// PASSWORD_CHANGE_ALLOWLIST for why this route (and only this one, plus
// GET / and logout) stays reachable while must_change_password is set.
router.post('/password', requireAuth, async function (req, res, next) {
  try {
    await authService.changeOwnPassword(req.ctx, req.body.currentPassword, req.body.newPassword);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// The signed-in user's interface language. Anything the frontend has a
// catalogue for is accepted as-is (see migration 0065 on why the column
// carries no CHECK constraint) — it's only ever read back by that same
// frontend, which falls back to English for a code it doesn't know. Length
// is bounded so this can't be used to park arbitrary data on a user row.
router.post('/locale', requireAuth, async function (req, res, next) {
  try {
    var locale = String(req.body.locale || '').trim();
    if (!/^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{2,8})?$/.test(locale)) fail('invalid', 'Not a valid language code.');
    await pool.query('UPDATE users SET locale = $1 WHERE id = $2', [locale, req.ctx.user.id]);
    res.json({ locale: locale });
  } catch (e) { next(e); }
});

// kernel.js: handlers['me.summary'] -> GET /api/me/summary
// Two-step sign-in, for the signed-in person's own account (twoStep.service.js).
var twoStep = require('../services/twoStep.service');
router.get('/two-step', requireAuth, async function (req, res, next) {
  try { res.json(await twoStep.status(req.ctx)); } catch (e) { next(e); }
});
router.post('/two-step/setup', requireAuth, async function (req, res, next) {
  try { res.json(await twoStep.startSetup(req.ctx)); } catch (e) { next(e); }
});
router.post('/two-step/enable', requireAuth, async function (req, res, next) {
  try { res.json(await twoStep.enable(req.ctx, req.body.code)); } catch (e) { next(e); }
});
router.post('/two-step/sms/setup', requireAuth, async function (req, res, next) {
  try { res.json(await twoStep.startSmsSetup(req.ctx, req.body.phone)); } catch (e) { next(e); }
});
router.post('/two-step/sms/enable', requireAuth, async function (req, res, next) {
  try { res.json(await twoStep.enableSms(req.ctx, req.body.code)); } catch (e) { next(e); }
});
router.post('/two-step/email/setup', requireAuth, async function (req, res, next) {
  try { res.json(await twoStep.startEmailSetup(req.ctx)); } catch (e) { next(e); }
});
router.post('/two-step/email/enable', requireAuth, async function (req, res, next) {
  try { res.json(await twoStep.enableEmail(req.ctx, req.body.code)); } catch (e) { next(e); }
});
router.post('/two-step/disable', requireAuth, async function (req, res, next) {
  try { res.json(await twoStep.disable(req.ctx, req.body.password, req.body.method)); } catch (e) { next(e); }
});
router.post('/two-step/backup-codes', requireAuth, async function (req, res, next) {
  try { res.json(await twoStep.newBackupCodes(req.ctx, req.body.password)); } catch (e) { next(e); }
});

// Everything My space shows about the signed-in person (mySpace.service.js).
router.get('/overview', requireAuth, async function (req, res, next) {
  try { res.json(await require('../services/mySpace.service').overview(req.ctx)); } catch (e) { next(e); }
});

router.get('/summary', requireAuth, async function (req, res, next) {
  try {
    var ctx = req.ctx;
    var today = new Date().toISOString().slice(0, 10);
    var year = new Date().getFullYear();

    var attendanceRes = await pool.query(
      'SELECT * FROM attendance WHERE employee_id = $1 AND date = $2',
      [ctx.employee.id, today]
    );
    var balancesRes = await pool.query(
      'SELECT lb.entitled, lb.used, lt.id AS leave_type_id, lt.name, lt.paid FROM leave_balances lb ' +
      'JOIN leave_types lt ON lt.id = lb.leave_type_id ' +
      'WHERE lb.employee_id = $1 AND lb.year = $2 AND lt.active ORDER BY lt.name',
      [ctx.employee.id, year]
    );
    var myLeaveRes = await pool.query(
      'SELECT * FROM leave_requests WHERE employee_id = $1 ORDER BY created_at DESC',
      [ctx.employee.id]
    );

    res.json({
      employee: serializeEmployee(ctx.employee),
      roleNames: ctx.roleNames,
      permissions: ctx.permissions,
      todayAttendance: attendanceRes.rows[0] ? rowToAttendance(attendanceRes.rows[0]) : null,
      balances: balancesRes.rows.map(function (b) {
        return { leaveTypeId: b.leave_type_id, name: b.name, paid: b.paid, entitled: b.entitled, used: b.used, left: b.entitled - b.used };
      }),
      myLeave: myLeaveRes.rows.map(rowToLeaveRequest)
    });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.serializeCtx = serializeCtx;
