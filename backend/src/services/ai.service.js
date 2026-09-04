var { pool } = require('../db/pool');
var { V } = require('../utils/validate');
var config = require('../config');
var dashboardService = require('./dashboard.service');
var approvalsService = require('./approvals.service');
var reportsService = require('./reports.service');

// The AI Assistant screen in the design prototype (Bamboo OS.dc.html)
// calls window.claude.complete, a bridge that only exists inside that
// design tool's own preview runtime — there is no equivalent client-side
// API in a real deployment. This is the real version: a server-side proxy
// to the Anthropic Messages API, gated behind an operator-supplied
// ANTHROPIC_API_KEY (see .env.example), with the same graceful "not
// available" and "something went wrong" fallbacks the prototype's own
// sendAi() has for when the bridge is missing or errors — returned as a
// normal assistant reply, not an HTTP error, since the chat UI renders
// both as an ordinary message bubble rather than an app-level error.

var SYSTEM_PROMPT_INTRO =
  'You are the Bamboo Products Limited Company OS assistant. Answer ONLY using the JSON company ' +
  'snapshot below — it already reflects exactly what this user is permitted to see (a null or ' +
  'missing field means they lack that permission; explain that plainly rather than guessing at the ' +
  'real number). Be concise, use GHS for money, and never invent numbers not present in the data. ' +
  'You do not take actions — you only answer questions about what is shown.';

function todayISO() { return new Date().toISOString().slice(0, 10); }

// Builds the permission-scoped snapshot described above. Reuses
// dashboard.service.js's own already-permission-gated load() for the bulk
// of it (headcount/attendance/leave/tasks/low-stock count/procurement/
// assets/invoices/expenses), then adds a few detail lists the sample
// questions ("Which products are below reorder level?", "What is in my
// approval queue?", "How is this month's revenue looking?") need beyond
// what the dashboard's KPI tiles show.
async function buildContext(ctx) {
  var dash = await dashboardService.load(ctx);
  var context = {
    today: todayISO(),
    headcount: dash.headcount,
    presentToday: dash.presentToday,
    lateToday: dash.lateToday,
    notClockedIn: dash.notClockedIn,
    onLeaveToday: dash.onLeaveToday,
    pendingLeaveRequests: dash.pendingLeave,
    departmentAttendance: dash.departments,
    myOpenTasks: dash.myOpenTasks,
    latestAnnouncement: dash.latestAnnouncement,
    lowStockProductCount: dash.lowStockCount,
    lowStockProducts: null,
    pendingProcurementRequests: dash.pendingProcurement,
    assetsDueServiceWithin7Days: dash.assetsDueService,
    outstandingInvoiceTotal: dash.outstandingInvoices,
    pendingExpenseClaims: dash.pendingExpenses,
    myApprovalQueue: null,
    revenueThisMonth: null,
    revenueThisYear: null,
    outstandingBalance: null
  };

  if (ctx.can('inventory.read') && dash.lowStockCount) {
    var lowStockRes = await pool.query(
      'SELECT name, sku, current_stock, reorder_level FROM products WHERE current_stock <= reorder_level ORDER BY name LIMIT 25'
    );
    context.lowStockProducts = lowStockRes.rows.map(function (r) {
      return { name: r.name, sku: r.sku, currentStock: Number(r.current_stock), reorderLevel: Number(r.reorder_level) };
    });
  }

  if (ctx.can('approval.act')) {
    var queue = await approvalsService.queue(ctx);
    context.myApprovalQueue = queue.slice(0, 25).map(function (a) {
      return { type: a.subjectType, title: a.title, detail: a.detail, requesterName: a.requesterName };
    });
  }

  if (ctx.can('report.read')) {
    var commercial = await reportsService.commercialDashboard(ctx);
    context.revenueThisMonth = commercial.revenueThisMonth;
    context.revenueThisYear = commercial.revenueThisYear;
    context.outstandingBalance = commercial.outstandingBalance;
  }

  return context;
}

async function callAnthropic(system, messages) {
  var res = await fetch(config.ai.baseUrl + '/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.ai.apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: config.ai.model,
      max_tokens: 1024,
      system: system,
      messages: messages
    })
  });
  var data = await res.json();
  if (!res.ok) {
    var msg = (data && data.error && data.error.message) || ('Anthropic API returned ' + res.status + '.');
    throw new Error(msg);
  }
  var block = (data.content || []).find(function (c) { return c.type === 'text'; });
  return block ? block.text : '';
}

// kernel.js: handlers['ai.chat'] (real equivalent of the prototype's
// sendAi() + ai.context — see the module comment above)
async function chat(ctx, message, history) {
  var text = V.text(message, 'Message', 2000);

  if (!config.ai.apiKey) {
    return { reply: 'The AI assistant needs an ANTHROPIC_API_KEY configured on the server, which is not set for this environment.' };
  }

  var priorMessages = (Array.isArray(history) ? history : [])
    .filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && m.text; })
    .slice(-20)
    .map(function (m) { return { role: m.role, content: String(m.text).slice(0, 4000) }; });

  try {
    var context = await buildContext(ctx);
    var system = SYSTEM_PROMPT_INTRO + '\n\nSNAPSHOT:\n' + JSON.stringify(context);
    var reply = await callAnthropic(system, priorMessages.concat([{ role: 'user', content: text }]));
    return { reply: reply || "I couldn't come up with an answer to that." };
  } catch (err) {
    return { reply: 'Something went wrong answering that: ' + err.message };
  }
}

module.exports = { chat: chat, buildContext: buildContext, callAnthropic: callAnthropic };
