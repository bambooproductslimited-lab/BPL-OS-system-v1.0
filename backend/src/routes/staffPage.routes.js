var express = require('express');
var { requireAuth } = require('../middleware/auth');
var staff = require('../services/staffPage.service');

// The staff page (staffPage.service.js). Two routers:
//  - /api/staff, beside the kiosk and My Jobs, outside requireAuth: its own
//    sign-in (a phone number and a texted code; Authorization: Bearer
//    <staff page token>), reaching only the signed-in person's own page;
//  - /api/staff-page, inside the OS: HR's side (People → Staff page).

function bearer(req) {
  var h = String(req.headers.authorization || '');
  return h.indexOf('Bearer ') === 0 ? h.slice(7).trim() : '';
}
function run(fn) {
  return async function (req, res, next) {
    try { res.json(await fn(req)); } catch (e) { next(e); }
  };
}

var page = express.Router();
page.post('/code', run(function (req) { return staff.sendCode(req.body, req.ip); }));
page.post('/sign-in', run(function (req) { return staff.signIn(req.body, req.ip, req.get('user-agent')); }));
page.post('/choose', run(function (req) { return staff.choose(bearer(req), req.body); }));
page.post('/sign-out', run(function (req) { return staff.signOut(bearer(req)); }));
page.get('/me', run(function (req) { return staff.me(bearer(req)); }));
page.get('/attendance', run(function (req) { return staff.attendance(bearer(req), req.query.month); }));
page.post('/leave/preview', run(function (req) { return staff.leavePreview(bearer(req), req.body); }));
page.post('/leave', run(function (req) { return staff.askLeave(bearer(req), req.body); }));
page.post('/leave/:id/cancel', run(function (req) { return staff.cancelLeave(bearer(req), req.params.id); }));
page.get('/payslips', run(function (req) { return staff.payslips(bearer(req)); }));

var hr = express.Router();
hr.use(requireAuth);
hr.get('/', run(function (req) { return staff.hrOverview(req.ctx); }));
hr.post('/:employeeId/sign-out', run(function (req) { return staff.hrSignOut(req.ctx, req.params.employeeId); }));

module.exports = { page: page, hr: hr };
