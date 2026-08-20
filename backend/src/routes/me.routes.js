var express = require('express');
var { requireAuth } = require('../middleware/auth');
var { pool } = require('../db/pool');
var { serializeEmployee } = require('../services/context.service');
var { rowToLeaveRequest } = require('../services/leave.service');
var { rowToAttendance } = require('../services/attendance.service');

var router = express.Router();

function serializeCtx(ctx) {
  return {
    userId: ctx.user.id,
    email: ctx.user.email,
    employee: serializeEmployee(ctx.employee),
    roleNames: ctx.roleNames,
    permissions: ctx.permissions
  };
}

// kernel.js: api.currentContext() -> GET /api/me
router.get('/', requireAuth, function (req, res) {
  res.json(serializeCtx(req.ctx));
});

// kernel.js: handlers['me.summary'] -> GET /api/me/summary
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
      'SELECT lb.entitled, lb.used, lt.name FROM leave_balances lb ' +
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
        return { name: b.name, entitled: b.entitled, used: b.used, left: b.entitled - b.used };
      }),
      myLeave: myLeaveRes.rows.map(rowToLeaveRequest)
    });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.serializeCtx = serializeCtx;
