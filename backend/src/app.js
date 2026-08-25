var express = require('express');
var cors = require('cors');
var helmet = require('helmet');
var config = require('./config');
var { AppError } = require('./utils/errors');

var authRoutes = require('./routes/auth.routes');
var meRoutes = require('./routes/me.routes');
var leaveRoutes = require('./routes/leave.routes');
var approvalsRoutes = require('./routes/approvals.routes');
var employeesRoutes = require('./routes/employees.routes');
var departmentsRoutes = require('./routes/departments.routes');
var rolesRoutes = require('./routes/roles.routes');
var usersRoutes = require('./routes/users.routes');
var attendanceRoutes = require('./routes/attendance.routes');
var notificationsRoutes = require('./routes/notifications.routes');
var auditRoutes = require('./routes/audit.routes');
var settingsRoutes = require('./routes/settings.routes');
var dashboardRoutes = require('./routes/dashboard.routes');
var tasksRoutes = require('./routes/tasks.routes');
var projectsRoutes = require('./routes/projects.routes');
var announcementsRoutes = require('./routes/announcements.routes');
var documentsRoutes = require('./routes/documents.routes');
var messagesRoutes = require('./routes/messages.routes');
var warehousesRoutes = require('./routes/warehouses.routes');
var suppliersRoutes = require('./routes/suppliers.routes');
var rawBatchesRoutes = require('./routes/rawBatches.routes');
var productsRoutes = require('./routes/products.routes');
var productionRoutes = require('./routes/production.routes');
var procurementRoutes = require('./routes/procurement.routes');
var assetsRoutes = require('./routes/assets.routes');
var waybillsRoutes = require('./routes/waybills.routes');
var toolRoomRoutes = require('./routes/toolRoom.routes');
var itDevicesRoutes = require('./routes/itDevices.routes');
var payrollRoutes = require('./routes/payroll.routes');
var maintenanceRoutes = require('./routes/maintenance.routes');
var customersRoutes = require('./routes/customers.routes');
var catalogRoutes = require('./routes/catalog.routes');
var quotationsRoutes = require('./routes/quotations.routes');
var estimatesRoutes = require('./routes/estimates.routes');
var salesOrdersRoutes = require('./routes/salesOrders.routes');
var invoicesRoutes = require('./routes/invoices.routes');
var paymentsRoutes = require('./routes/payments.routes');
var receiptsRoutes = require('./routes/receipts.routes');
var expensesRoutes = require('./routes/expenses.routes');
var commercialSettingsRoutes = require('./routes/commercialSettings.routes');
var reportsRoutes = require('./routes/reports.routes');
var aiRoutes = require('./routes/ai.routes');
var marketingRoutes = require('./routes/marketing.routes');
var oauthRoutes = require('./routes/oauth.routes');
var whatsappRoutes = require('./routes/whatsapp.routes');

var app = express();

app.use(helmet());
app.use(cors({ origin: config.corsOrigin, credentials: true }));
// verify captures the raw request bytes onto req.rawBody before JSON
// parsing discards them — whatsapp.routes.js's webhook needs the exact
// raw bytes (not a re-serialized object) to check Meta's HMAC signature.
app.use(express.json({ verify: function (req, res, buf) { req.rawBody = buf; } }));

app.get('/api/health', function (req, res) { res.json({ ok: true }); });

app.use('/api/auth', authRoutes);
app.use('/api/me', meRoutes);
app.use('/api/leave', leaveRoutes);
app.use('/api/approvals', approvalsRoutes);
app.use('/api/employees', employeesRoutes);
app.use('/api/departments', departmentsRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api/announcements', announcementsRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/warehouses', warehousesRoutes);
app.use('/api/suppliers', suppliersRoutes);
app.use('/api/raw-batches', rawBatchesRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/production', productionRoutes);
app.use('/api/procurement', procurementRoutes);
app.use('/api/assets', assetsRoutes);
app.use('/api/waybills', waybillsRoutes);
app.use('/api/tool-room', toolRoomRoutes);
app.use('/api/it-devices', itDevicesRoutes);
app.use('/api/payroll', payrollRoutes);
app.use('/api/maintenance', maintenanceRoutes);
app.use('/api/customers', customersRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/api/quotations', quotationsRoutes);
app.use('/api/estimates', estimatesRoutes);
app.use('/api/sales-orders', salesOrdersRoutes);
app.use('/api/invoices', invoicesRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/receipts', receiptsRoutes);
app.use('/api/expenses', expensesRoutes);
app.use('/api/commercial-settings', commercialSettingsRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/ai', aiRoutes);
// oauthRoutes and whatsappRoutes are mounted first and at a more specific
// prefix than marketingRoutes so their public (non-requireAuth) routes are
// reached before marketingRoutes' router.use(requireAuth) can intercept
// them — Express matches mounts in registration order, not by specificity.
app.use('/api/marketing/oauth', oauthRoutes);
app.use('/api/marketing/whatsapp', whatsappRoutes);
app.use('/api/marketing', marketingRoutes);

app.use(function (req, res) {
  res.status(404).json({ error: { code: 'notfound', message: 'Unknown endpoint: ' + req.method + ' ' + req.path } });
});

// Central error handler — mirrors kernel.js's api.call() catch block, mapping
// AppError's kernel-style codes (auth/forbidden/invalid/notfound/conflict) to
// real HTTP status codes instead of an always-200 { ok:false } envelope.
app.use(function (err, req, res, next) { // eslint-disable-line no-unused-vars
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  console.error(err);
  res.status(500).json({ error: { code: 'error', message: 'Something went wrong.' } });
});

module.exports = app;
