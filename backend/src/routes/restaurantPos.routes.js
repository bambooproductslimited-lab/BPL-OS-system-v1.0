var express = require('express');
var restaurantPosService = require('../services/restaurantPos.service');
var kitchen = require('../services/restaurantKitchen.service');
var money = require('../services/restaurantTillMoney.service');
var access = require('../services/restaurantTillAccess.service');
var screens = require('../services/restaurantKdsScreens.service');

// The till's own endpoints — mounted at /api/pos in app.js, deliberately
// public like /api/kiosk (see kiosk.routes.js's comment): no logged-in
// user, just a 4-digit PIN and then a short-lived till-session token this
// router itself issues and checks (posAuth below), not the app's normal
// requireAuth/req.ctx.

var router = express.Router();

function posAuth(req, res, next) {
  var header = req.headers.authorization || '';
  var token = header.indexOf('Bearer ') === 0 ? header.slice(7) : null;
  req.posToken = token;
  next();
}

router.post('/login', async function (req, res, next) {
  try { res.json(await restaurantPosService.login(req.body.pin, req.ip, req.body.app, req.body.screenToken)); } catch (e) { next(e); }
});
// Signing out (to step away, or after the till went unused), for the
// activity log; a cash drawer stays open.
router.post('/logout', posAuth, async function (req, res, next) {
  try { res.json(await restaurantPosService.signOut(req.posToken, req.body && req.body.reason)); } catch (e) { next(e); }
});
// A kitchen screen says hello: its state, or a new waiting screen with a
// code for a manager to set it up (restaurantKdsScreens.service.js).
router.post('/kds/screen', async function (req, res, next) {
  try { res.json(await screens.hello(req.body && req.body.screenToken, req.ip, req.headers['user-agent'])); } catch (e) { next(e); }
});

// What the person signed in may do, and the till's settings; the settings
// themselves, opened and saved by a manager (restaurantTillAccess.service.js).
router.get('/access', posAuth, async function (req, res, next) {
  try { res.json(await access.profile(req.posToken)); } catch (e) { next(e); }
});
router.post('/settings/open', posAuth, async function (req, res, next) {
  try { res.json(await access.openSettings(req.posToken, req.body.managerPin, req.ip)); } catch (e) { next(e); }
});
router.put('/settings', posAuth, async function (req, res, next) {
  try { res.json(await access.saveSettings(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
// Customers' VIP and IOU accounts, what happened on the till and the
// kitchen screen, and the sales — for a manager, with their PIN in the body.
router.post('/settings/customers', posAuth, async function (req, res, next) {
  try { res.json(await access.settingsCustomers(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
router.post('/settings/activity', posAuth, async function (req, res, next) {
  try { res.json(await access.activityReport(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
router.post('/settings/sales', posAuth, async function (req, res, next) {
  try { res.json(await access.salesReport(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
// The monthly report (restaurantReport.service.js) — kitchen groups, shifts
// and hours, best sellers and the kitchen bonus, over the sales imported
// from Square and the till's own — for a manager in the back office.
router.post('/settings/monthly-report', posAuth, async function (req, res, next) {
  try { res.json(await access.monthlyReport(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
// The kitchen screens: listed, set up by their code, changed, taken off.
router.post('/settings/screens', posAuth, async function (req, res, next) {
  try { res.json(await access.kitchenScreens(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
// Drawer history (and closing one left open), disputes, IOUs and VIP money.
router.post('/settings/drawers', posAuth, async function (req, res, next) {
  try { res.json(await access.drawers(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
router.post('/settings/disputes', posAuth, async function (req, res, next) {
  try { res.json(await access.disputes(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
router.post('/settings/accounts', posAuth, async function (req, res, next) {
  try { res.json(await access.accounts(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
// The menu, by a manager; the stock, by a manager or a stock keeper.
router.post('/settings/menu', posAuth, async function (req, res, next) {
  try { res.json(await access.menu(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
router.post('/stock', posAuth, async function (req, res, next) {
  try { res.json(await access.stock(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
// Waste (anyone on the till), stock takes (a manager or a stock keeper),
// the waste report (a manager) — restaurantWaste.service.js.
router.post('/waste', posAuth, async function (req, res, next) {
  try { res.json(await require('../services/restaurantWaste.service').till(req.posToken, req.body)); } catch (e) { next(e); }
});
router.post('/stock-take', posAuth, async function (req, res, next) {
  try { res.json(await require('../services/restaurantWaste.service').stockTake(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
router.post('/settings/waste', posAuth, async function (req, res, next) {
  try { res.json(await require('../services/restaurantWaste.service').wasteReport(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
// Notes for the team (restaurantTeamNotes.service.js): the ones up now and
// "Got it"; written and followed by a manager.
router.get('/team-notes', posAuth, async function (req, res, next) {
  try { res.json(await require('../services/restaurantTeamNotes.service').mine(req.posToken)); } catch (e) { next(e); }
});
router.post('/team-notes/read', posAuth, async function (req, res, next) {
  try { res.json(await require('../services/restaurantTeamNotes.service').read(req.posToken, req.body && req.body.ids)); } catch (e) { next(e); }
});
router.post('/team-notes/manage', posAuth, async function (req, res, next) {
  try { res.json(await require('../services/restaurantTeamNotes.service').manage(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
// The kitchen's prep list, checklists, and stock sent between restaurants (migration 0194).
router.post('/prep', posAuth, async function (req, res, next) {
  try { res.json(await require('../services/restaurantPrep.service').prep(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
router.get('/checklists', posAuth, async function (req, res, next) {
  try { res.json(await require('../services/restaurantChecklists.service').mine(req.posToken)); } catch (e) { next(e); }
});
router.post('/checklists/mark', posAuth, async function (req, res, next) {
  try { res.json(await require('../services/restaurantChecklists.service').mark(req.posToken, req.body)); } catch (e) { next(e); }
});
router.post('/checklists/manage', posAuth, async function (req, res, next) {
  try { res.json(await require('../services/restaurantChecklists.service').manage(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
router.get('/transfers/waiting', posAuth, async function (req, res, next) {
  try { res.json(await require('../services/restaurantTransfers.service').waiting(req.posToken)); } catch (e) { next(e); }
});
router.post('/transfers', posAuth, async function (req, res, next) {
  try { res.json(await require('../services/restaurantTransfers.service').transfers(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
// The cash office (migration 0195): cash into the safe and petty cash from
// the drawer; the safe, the bank and petty cash in the back office.
router.post('/cash-office/drop', posAuth, async function (req, res, next) {
  try { res.json(await require('../services/restaurantCashOffice.service').drop(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
router.post('/cash-office/petty', posAuth, async function (req, res, next) {
  try { res.json(await require('../services/restaurantCashOffice.service').petty(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
router.get('/cash-office/photo/:kind/:id', posAuth, async function (req, res, next) {
  try {
    var f = await require('../services/restaurantCashOffice.service').photoOf(req.posToken, req.params.kind, req.params.id);
    await require('../lib/fileStore').send(res, f.key, f.name, true);
  } catch (e) { next(e); }
});
// Bills to pay, the restaurant's (migration 0196), by a manager; their photos.
router.post('/settings/bills', posAuth, async function (req, res, next) {
  try { res.json(await require('../services/bills.service').tillTab(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
router.get('/bills/:id/files/:n', posAuth, async function (req, res, next) {
  try { var f = await require('../services/bills.service').tillFileKey(req.posToken, req.params.id, req.params.n); await require('../lib/fileStore').send(res, f.key, f.name, true); } catch (e) { next(e); }
});
// Equipment (migration 0196): anyone reports a problem; the manager looks after it.
router.get('/equipment', posAuth, async function (req, res, next) {
  try { res.json(await require('../services/restaurantEquipment.service').choices(req.posToken)); } catch (e) { next(e); }
});
router.post('/equipment/report', posAuth, async function (req, res, next) {
  try { res.json(await require('../services/restaurantEquipment.service').report(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
router.get('/equipment/photo/:id/:n', posAuth, async function (req, res, next) {
  try { var f = await require('../services/restaurantEquipment.service').photoOf(req.posToken, req.params.id, req.params.n); await require('../lib/fileStore').send(res, f.key, f.name, true); } catch (e) { next(e); }
});
router.post('/settings/equipment', posAuth, async function (req, res, next) {
  try { res.json(await require('../services/restaurantEquipment.service').tab(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
router.post('/settings/cash-office', posAuth, async function (req, res, next) {
  try { res.json(await require('../services/restaurantCashOffice.service').office(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
// Low stock, suppliers and purchase orders, by a manager.
router.post('/settings/purchasing', posAuth, async function (req, res, next) {
  try { res.json(await access.purchasing(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
// Closing the day, by a manager.
router.post('/settings/closeday', posAuth, async function (req, res, next) {
  try { res.json(await access.closeDay(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
// The rota, by a manager; who is on today, for the till.
router.post('/settings/rota', posAuth, async function (req, res, next) {
  try { res.json(await access.rota(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
router.get('/rota/today', posAuth, async function (req, res, next) {
  try { res.json(await access.rotaToday(req.posToken)); } catch (e) { next(e); }
});
router.post('/rota/swaps', posAuth, async function (req, res, next) {
  try { res.json(await access.rotaSwaps(req.posToken, req.body)); } catch (e) { next(e); }
});
// Timecards, by a manager; the time clock on the PIN pad, by PIN alone.
router.post('/settings/timecards', posAuth, async function (req, res, next) {
  try { res.json(await access.timecards(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
router.post('/timeclock', async function (req, res, next) {
  try { res.json(await require('../services/restaurantTimecards.service').timeclock(req.body.pin, req.body.action, req.ip)); } catch (e) { next(e); }
});
// A complaint or a wrong charge raised on the till.
router.post('/disputes', posAuth, async function (req, res, next) {
  try { res.status(201).json(await restaurantPosService.raiseDispute(req.posToken, req.body)); } catch (e) { next(e); }
});

router.get('/menu', posAuth, async function (req, res, next) {
  try { res.json(await restaurantPosService.menuForSession(req.posToken)); } catch (e) { next(e); }
});

router.get('/menu/mostly-bought', posAuth, async function (req, res, next) {
  try { res.json(await restaurantPosService.mostlyBought(req.posToken)); } catch (e) { next(e); }
});

router.post('/menu-items/:id/favorite', posAuth, async function (req, res, next) {
  try { res.json(await restaurantPosService.toggleFavorite(req.posToken, req.params.id)); } catch (e) { next(e); }
});

router.post('/orders', posAuth, async function (req, res, next) {
  try { res.status(201).json(await restaurantPosService.createOrder(req.posToken, req.body)); } catch (e) { next(e); }
});

router.get('/orders/:id/receipt', posAuth, async function (req, res, next) {
  try { res.json(await restaurantPosService.receiptForSession(req.posToken, req.params.id)); } catch (e) { next(e); }
});
// The receipt sent to the customer: by text message, or a WhatsApp message
// the till opens (restaurantPos sendReceipt).
router.post('/orders/:id/receipt/send', posAuth, async function (req, res, next) {
  try { res.json(await restaurantPosService.sendReceipt(req.posToken, req.params.id, req.body, req.ip)); } catch (e) { next(e); }
});
// A manager's PIN for a discount, a dish on the house or the service charge taken off.
router.post('/approve', posAuth, async function (req, res, next) {
  try { res.json(await restaurantPosService.approve(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});

// Refunds (approved with a manager's PIN), VIP balances and IOUs
// (restaurantTillMoney.service.js).
router.get('/refunds/sales', posAuth, async function (req, res, next) {
  try { res.json(await money.salesToRefund(req.posToken, req.query.q)); } catch (e) { next(e); }
});
router.get('/refunds/sales/:id', posAuth, async function (req, res, next) {
  try { res.json(await money.saleForRefund(req.posToken, req.params.id)); } catch (e) { next(e); }
});
router.post('/refunds/sales/:id', posAuth, async function (req, res, next) {
  try { res.status(201).json(await money.refundSale(req.posToken, req.params.id, req.body, req.ip)); } catch (e) { next(e); }
});
router.get('/vip', posAuth, async function (req, res, next) {
  try { res.json(await money.vipGuests(req.posToken, req.query.q)); } catch (e) { next(e); }
});
router.get('/vip/:guestId', posAuth, async function (req, res, next) {
  try { res.json(await money.vipGuest(req.posToken, req.params.guestId)); } catch (e) { next(e); }
});
router.post('/vip/topups', posAuth, async function (req, res, next) {
  try { res.status(201).json(await money.vipTopUp(req.posToken, req.body)); } catch (e) { next(e); }
});
// Pay out, for a VIP account: money on the balance given back in cash (a manager's PIN).
router.post('/vip/cashouts', posAuth, async function (req, res, next) {
  try { res.status(201).json(await money.vipCashOut(req.posToken, req.body, req.ip)); } catch (e) { next(e); }
});
// Pay in, for an IOU account: some of a customer's IOUs paid back together.
router.post('/ious/pay', posAuth, async function (req, res, next) {
  try { res.json(await money.payIous(req.posToken, req.body)); } catch (e) { next(e); }
});
// Pay out, for an IOU account: cash lent, owed until it is paid back.
router.post('/ious/advances', posAuth, async function (req, res, next) {
  try { res.status(201).json(await money.iouAdvance(req.posToken, req.body)); } catch (e) { next(e); }
});
router.get('/ious', posAuth, async function (req, res, next) {
  try { res.json(await money.iouList(req.posToken, req.query.q)); } catch (e) { next(e); }
});
router.post('/ious/:id/paid', posAuth, async function (req, res, next) {
  try { res.json(await money.payIou(req.posToken, req.params.id, req.body)); } catch (e) { next(e); }
});

// Open tables: orders kept to add to and pay later (paid through POST
// /orders with tabId).
router.get('/tabs', posAuth, async function (req, res, next) {
  try { res.json(await restaurantPosService.listTabs(req.posToken)); } catch (e) { next(e); }
});
router.post('/tabs', posAuth, async function (req, res, next) {
  try { res.status(req.body.id ? 200 : 201).json(await restaurantPosService.saveTab(req.posToken, req.body)); } catch (e) { next(e); }
});
router.delete('/tabs/:id', posAuth, async function (req, res, next) {
  try { res.json(await restaurantPosService.removeTab(req.posToken, req.params.id)); } catch (e) { next(e); }
});
// Bills: some dishes moved to another order, one order joined to another,
// an order moved to another table or waiter.
router.post('/tabs/:id/move-dishes', posAuth, async function (req, res, next) {
  try { res.json(await restaurantPosService.moveDishes(req.posToken, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/tabs/:id/join', posAuth, async function (req, res, next) {
  try { res.json(await restaurantPosService.mergeTabs(req.posToken, req.params.id, req.body)); } catch (e) { next(e); }
});
router.post('/tabs/:id/move', posAuth, async function (req, res, next) {
  try { res.json(await restaurantPosService.moveTab(req.posToken, req.params.id, req.body)); } catch (e) { next(e); }
});
// The next course called: what waited at the kitchen is cooked now.
router.post('/tabs/:id/fire', posAuth, async function (req, res, next) {
  try { res.json(await restaurantPosService.fireCourse(req.posToken, req.params.id, req.body)); } catch (e) { next(e); }
});

// This cashier's shift so far.
// The kitchen display (/kds), signed in with a staff PIN like the till,
// and what is ready to take out, for the till (restaurantKitchen.service.js).
router.get('/kds', posAuth, async function (req, res, next) {
  try { res.json(await kitchen.board(req.posToken, req.query)); } catch (e) { next(e); }
});
router.post('/kds/items/:id', posAuth, async function (req, res, next) {
  try { res.json(await kitchen.setItemDone(req.posToken, req.params.id, req.body && req.body.done !== false)); } catch (e) { next(e); }
});
router.post('/kds/tickets/:id/done', posAuth, async function (req, res, next) {
  try { res.json(await kitchen.finishTicket(req.posToken, req.params.id, req.body && req.body.station)); } catch (e) { next(e); }
});
router.post('/kds/tickets/:id/served', posAuth, async function (req, res, next) {
  try { res.json(await kitchen.serveTicket(req.posToken, req.params.id, req.body && req.body.from)); } catch (e) { next(e); }
});
// The ticket printed for the runner when the food is done.
router.post('/kds/tickets/:id/printed', posAuth, async function (req, res, next) {
  try { res.json(await kitchen.printTicket(req.posToken, req.params.id)); } catch (e) { next(e); }
});
router.post('/kds/tickets/:id/recall', posAuth, async function (req, res, next) {
  try { res.json(await kitchen.recallTicket(req.posToken, req.params.id)); } catch (e) { next(e); }
});
router.get('/kitchen', posAuth, async function (req, res, next) {
  try { res.json(await kitchen.tillSummary(req.posToken)); } catch (e) { next(e); }
});

router.get('/shift', posAuth, async function (req, res, next) {
  try { res.json(await restaurantPosService.shiftSummary(req.posToken)); } catch (e) { next(e); }
});

router.get('/drawer', posAuth, async function (req, res, next) {
  try { res.json(await restaurantPosService.getOpenDrawerSession(req.posToken)); } catch (e) { next(e); }
});
router.post('/drawer/open', posAuth, async function (req, res, next) {
  try { res.status(201).json(await restaurantPosService.openDrawerSession(req.posToken, req.body.startingCash)); } catch (e) { next(e); }
});
router.post('/drawer/movements', posAuth, async function (req, res, next) {
  try { res.status(201).json(await restaurantPosService.addDrawerMovement(req.posToken, req.body)); } catch (e) { next(e); }
});
router.post('/drawer/close', posAuth, async function (req, res, next) {
  try { res.json(await restaurantPosService.closeDrawerSession(req.posToken, req.body)); } catch (e) { next(e); }
});

router.get('/tables', posAuth, async function (req, res, next) {
  try { res.json(await restaurantPosService.tablesForSession(req.posToken)); } catch (e) { next(e); }
});
router.get('/waiters', posAuth, async function (req, res, next) {
  try { res.json(await restaurantPosService.waitersForSession(req.posToken)); } catch (e) { next(e); }
});
router.get('/guests', posAuth, async function (req, res, next) {
  try { res.json(await restaurantPosService.guestsForSession(req.posToken, req.query.q)); } catch (e) { next(e); }
});
router.post('/guests', posAuth, async function (req, res, next) {
  try { res.status(201).json(await restaurantPosService.createGuestForSession(req.posToken, req.body)); } catch (e) { next(e); }
});

module.exports = router;
