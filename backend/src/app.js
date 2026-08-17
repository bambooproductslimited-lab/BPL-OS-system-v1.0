var express = require('express');
var cors = require('cors');
var helmet = require('helmet');
var config = require('./config');
var { AppError } = require('./utils/errors');

var authRoutes = require('./routes/auth.routes');
var meRoutes = require('./routes/me.routes');
var leaveRoutes = require('./routes/leave.routes');
var approvalsRoutes = require('./routes/approvals.routes');

var app = express();

app.use(helmet());
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json());

app.get('/api/health', function (req, res) { res.json({ ok: true }); });

app.use('/api/auth', authRoutes);
app.use('/api/me', meRoutes);
app.use('/api/leave', leaveRoutes);
app.use('/api/approvals', approvalsRoutes);

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
