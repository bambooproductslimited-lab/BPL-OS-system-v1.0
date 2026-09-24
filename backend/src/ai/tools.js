var { pool } = require('../db/pool');
var { fail } = require('../utils/errors');
var { V } = require('../utils/validate');
var { audit } = require('../utils/audit');

var dashboardService = require('../services/dashboard.service');
var reportsService = require('../services/reports.service');
var employeesService = require('../services/employees.service');
var attendanceService = require('../services/attendance.service');
var productsService = require('../services/products.service');
var customersService = require('../services/customers.service');
var invoicesService = require('../services/invoices.service');
var quotationsService = require('../services/quotations.service');
var suppliersService = require('../services/suppliers.service');
var tasksService = require('../services/tasks.service');
var leaveService = require('../services/leave.service');
var approvalsService = require('../services/approvals.service');
var procurementService = require('../services/procurement.service');
var expensesService = require('../services/expenses.service');

// What Claude can look up and do in Bamboo OS, shared by the AI Assistant
// screen (services/ai.service.js) and the connector that lets claude.ai and
// the Claude apps reach the OS (mcp/server.js).
//
// Every tool runs through the same service functions the screens call, with
// the signed-in person's own ctx — so Claude sees exactly what that person
// could see, and can do only what they could do. There is no separate
// "AI permission" to keep in step: if a role can't open Invoices, Claude
// can't read invoices on that person's behalf either. toolsFor() also hides
// the tools a person has no permission for, so Claude doesn't offer them.
//
// Two kinds of tool:
//
//   read    — look something up and return it. Nothing changes.
//   action  — change something (create a task, request leave…). prepare()
//             checks the request and describes it; execute() does it. On
//             the Assistant screen execute() runs only when the person
//             presses Confirm (see ai/actions.js). Through the connector,
//             Claude's own apps ask the person to approve each such call
//             before it is made, and it runs at once.
//
// Results are JSON, trimmed to the fields that answer questions — ids and
// internal columns are left out unless a follow-up needs them — and lists
// are capped, saying so, so one broad question can't flood the context.

var LIST_LIMIT = 50;

function capped(items, map, limit) {
  var n = limit || LIST_LIMIT;
  var shown = items.slice(0, n).map(map);
  return { total: items.length, shown: shown.length, note: items.length > n ? 'Showing the first ' + n + ' of ' + items.length + ' — narrow the search to see others.' : undefined, items: shown };
}

function matches(query) {
  var words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  return function () {
    var hay = Array.prototype.slice.call(arguments).map(function (v) { return String(v == null ? '' : v); }).join(' ').toLowerCase();
    return words.every(function (w) { return hay.indexOf(w) >= 0; });
  };
}

function money(list) {
  return (list || []).map(function (m) { return m.currency + ' ' + Number(m.amount).toFixed(2); }).join(' + ') || '0';
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

// DATE columns arrive as 'YYYY-MM-DD' strings (db/pool.js), timestamps as
// Date objects — both become a plain day.
function day(v) {
  if (!v) return null;
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

// Resolves a person named in a request ("give it to Kofi") to one visible
// employee — refusing when the name matches nobody or several people, so an
// action is never pointed at the wrong person.
async function resolveEmployee(ctx, name) {
  var list = await employeesService.list(ctx, {});
  var m = matches(name);
  var hits = list.filter(function (e) { return m(e.firstName, e.lastName, e.code, e.email); });
  if (!hits.length) fail('invalid', 'No employee matches "' + name + '".');
  if (hits.length > 1) {
    fail('invalid', '"' + name + '" matches ' + hits.length + ' people: ' +
      hits.slice(0, 6).map(function (e) { return e.firstName + ' ' + e.lastName + ' (' + e.code + ')'; }).join(', ') + '. Say which one.');
  }
  return hits[0];
}

async function resolveProduct(ctx, skuOrName) {
  var list = await productsService.list(ctx);
  var key = String(skuOrName || '').trim().toLowerCase();
  var exact = list.filter(function (p) { return p.sku.toLowerCase() === key || p.name.toLowerCase() === key; });
  if (exact.length === 1) return exact[0];
  var m = matches(skuOrName);
  var hits = list.filter(function (p) { return m(p.sku, p.name); });
  if (!hits.length) fail('invalid', 'No product matches "' + skuOrName + '".');
  if (hits.length > 1) {
    fail('invalid', '"' + skuOrName + '" matches ' + hits.length + ' products: ' +
      hits.slice(0, 8).map(function (p) { return p.name + ' (' + p.sku + ')'; }).join(', ') + '. Give the SKU.');
  }
  return hits[0];
}

var TOOLS = [
  // ---- read -------------------------------------------------------------
  {
    name: 'get_company_overview',
    kind: 'read',
    description: "Today's snapshot of the company as this person is allowed to see it: headcount, who is present, late or on leave, attendance by department, pending leave and approvals, low-stock count, open procurement, assets due service, outstanding invoices and expense claims, and — for people with report access — revenue this month and year. Start here for broad \"how are we doing\" questions.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run: async function (ctx) {
      var d = await dashboardService.load(ctx);
      var out = {
        today: todayISO(), headcount: d.headcount, presentToday: d.presentToday, lateToday: d.lateToday,
        notClockedIn: d.notClockedIn, onLeaveToday: d.onLeaveToday, pendingLeaveRequests: d.pendingLeave,
        approvalQueue: d.approvalQueue, departments: d.departments, lowStockProducts: d.lowStockCount,
        pendingPurchaseRequests: d.pendingProcurement, assetsDueServiceWithin7Days: d.assetsDueService,
        outstandingInvoices: d.outstandingInvoices, pendingExpenseClaims: d.pendingExpenses
      };
      if (ctx.can('report.read')) {
        var c = await reportsService.commercialDashboard(ctx, null, { allCompanies: true });
        out.revenueThisMonth = money(c.revenueThisMonthByCurrency);
        out.revenueThisYear = money(c.revenueThisYearByCurrency);
        out.outstandingBalance = money(c.outstandingByCurrency);
        out.overdueInvoices = { count: c.overdueCount, amount: money(c.overdueAmountByCurrency) };
        out.quotations = { total: c.totalQuotations, awaitingResponse: c.awaitingResponse, conversionRatePercent: c.conversionRate };
      }
      return out;
    }
  },
  {
    name: 'search_employees',
    kind: 'read',
    perm: 'employee.read',
    description: 'Find employees by name, employee code, job title or department (all words must match). Leave query empty to list everyone this person can see. Returns code, name, title, department, contact details, employment type and shift.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Words to match, e.g. "Kofi", "BPL-012", "security", "store clerk". Empty for everyone.' } },
      additionalProperties: false
    },
    run: async function (ctx, input) {
      var list = await employeesService.list(ctx, {});
      var depts = (await pool.query('SELECT id, name FROM departments')).rows;
      var deptName = {};
      depts.forEach(function (d) { deptName[d.id] = d.name; });
      var m = matches(input.query);
      var hits = list.filter(function (e) { return m(e.firstName, e.lastName, e.code, e.positionTitle, deptName[e.departmentId], e.email); });
      return capped(hits, function (e) {
        return {
          code: e.code, name: e.firstName + ' ' + e.lastName, title: e.positionTitle, department: deptName[e.departmentId] || '',
          email: e.email, phone: e.phone, employmentType: e.employmentType, status: e.status, shift: e.shift, location: e.location
        };
      });
    }
  },
  {
    name: 'get_attendance',
    kind: 'read',
    description: "Attendance for one day: each employee this person can see, with status (present, late, absent, leave, off), clock-in and clock-out times, and whether the clock-out was automatic (the kiosk clocks a forgotten shift out after 11 hours). Defaults to today.",
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD. Omit for today.' },
        status: { type: 'string', enum: ['present', 'late', 'absent', 'leave', 'off'], description: 'Only people with this status.' }
      },
      additionalProperties: false
    },
    run: async function (ctx, input) {
      var date = input.date ? V.date(input.date, 'Date') : todayISO();
      var res = await attendanceService.list(ctx, { date: date });
      var rows = res.rows.filter(function (r) { return !input.status || r.status === input.status; });
      var counts = {};
      res.rows.forEach(function (r) { counts[r.status] = (counts[r.status] || 0) + 1; });
      return Object.assign({ date: date, countsByStatus: counts }, capped(rows, function (r) {
        return {
          name: r.name, code: r.code, department: r.department, status: r.status,
          clockIn: r.clockIn ? String(r.clockIn).slice(0, 5) : null, clockOut: r.clockOut ? String(r.clockOut).slice(0, 5) : null,
          autoClockedOut: r.autoClockedOut || undefined, note: r.note || undefined
        };
      }, 100));
    }
  },
  {
    name: 'search_products',
    kind: 'read',
    perm: 'inventory.read',
    description: 'Finished goods and store items in Products & inventory: SKU, name, category, unit, stock on hand, reorder level, cost and selling price. Filter by words in the name/SKU/category, or ask for low-stock items only.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to match, e.g. "slats", "PVC elbow", "Plumbing". Empty for all.' },
        low_stock_only: { type: 'boolean', description: 'Only items at or below their reorder level.' }
      },
      additionalProperties: false
    },
    run: async function (ctx, input) {
      var list = await productsService.list(ctx);
      var m = matches(input.query);
      var hits = list.filter(function (p) { return m(p.sku, p.name, p.category) && (!input.low_stock_only || p.lowStock); });
      return capped(hits, function (p) {
        return { sku: p.sku, name: p.name, category: p.category, unit: p.unit, stock: p.currentStock, reorderLevel: p.reorderLevel, lowStock: p.lowStock, costPrice: p.costPrice, sellingPrice: p.sellingPrice };
      });
    }
  },
  {
    name: 'search_customers',
    kind: 'read',
    perm: 'customer.read',
    description: 'Customers (clients) with contact details, category (lead, prospect, active, vip, inactive), account manager, and what has been quoted, invoiced, paid and is outstanding for each.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Words to match in the name, contact, email or phone. Empty for all.' } },
      additionalProperties: false
    },
    run: async function (ctx, input) {
      var list = await customersService.list(ctx);
      var m = matches(input.query);
      return capped(list.filter(function (c) { return m(c.name, c.contactPerson, c.email, c.phone); }), function (c) {
        return {
          name: c.name, contactPerson: c.contactPerson, phone: c.phone, email: c.email, category: c.category, accountManager: c.managerName,
          quoted: money(c.quotedTotals),
          invoiced: money((c.invoicedTotals || []).map(function (t) { return { currency: t.currency, amount: t.invoiced }; })),
          outstanding: money((c.invoicedTotals || []).map(function (t) { return { currency: t.currency, amount: t.outstanding }; }))
        };
      });
    }
  },
  {
    name: 'list_invoices',
    kind: 'read',
    perm: 'invoice.read',
    description: 'Invoices with customer, amounts, balance due, status and due date. Filter by status or customer name.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['unpaid', 'partially_paid', 'paid', 'void', 'overdue', 'open'], description: '"open" means anything not fully paid or void; "overdue" means open and past its due date.' },
        customer: { type: 'string', description: 'Words to match in the customer name.' }
      },
      additionalProperties: false
    },
    run: async function (ctx, input) {
      var list = await invoicesService.list(ctx);
      var m = matches(input.customer);
      var hits = list.filter(function (i) {
        if (!m(i.customerName)) return false;
        var open = i.status === 'unpaid' || i.status === 'partially_paid';
        if (input.status === 'open') return open;
        if (input.status === 'overdue') return open && i.overdue;
        return !input.status || i.status === input.status;
      });
      return capped(hits, function (i) {
        return {
          invoiceNo: i.invoiceNo, customer: i.customerName, currency: i.currency, total: i.grandTotal, paid: i.amountPaid,
          balanceDue: i.balanceDue, status: i.status, overdue: i.overdue || undefined, issued: day(i.issuedAt), due: day(i.dueDate)
        };
      });
    }
  },
  {
    name: 'list_quotations',
    kind: 'read',
    perm: 'quotation.read',
    description: 'Quotations with customer, title, total, status (draft, sent, viewed, accepted, rejected, expired) and validity.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired', 'cancelled'] },
        customer: { type: 'string', description: 'Words to match in the customer name.' }
      },
      additionalProperties: false
    },
    run: async function (ctx, input) {
      var list = await quotationsService.list(ctx);
      var m = matches(input.customer);
      return capped(list.filter(function (q) { return m(q.customerName) && (!input.status || q.status === input.status); }), function (q) {
        return { quoteNo: q.quoteNo, customer: q.customerName, title: q.title, currency: q.currency, total: q.grandTotal, status: q.status, created: day(q.createdAt), validUntil: q.validUntil };
      });
    }
  },
  {
    name: 'search_suppliers',
    kind: 'read',
    perm: 'supplier.read',
    description: 'Suppliers and bamboo farmers: name, phone, town, district, region, materials supplied, quoted price, quality assessment, sourcing status, expected quantity and IOU balance.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Words to match in the name, phone, town, district, region or materials. Empty for all.' } },
      additionalProperties: false
    },
    run: async function (ctx, input) {
      var list = await suppliersService.list(ctx);
      var m = matches(input.query);
      return capped(list.filter(function (s) { return m(s.name, s.phone, s.town, s.district, s.region, s.materialsSupplied); }), function (s) {
        return {
          name: s.name, phone: s.phone, town: s.town, district: s.district, region: s.region, materials: s.materialsSupplied,
          quotedPrice: s.quotedPrice === null ? undefined : s.quotedPrice + ' per ' + s.priceUnit, assessment: s.assessment || undefined,
          sourcingStatus: s.sourcingStatus || undefined, expectedQty: s.expectedQty === null ? undefined : s.expectedQty,
          iou: s.iouAmount ? s.iouAmount : undefined, status: s.status
        };
      });
    }
  },
  {
    name: 'list_tasks',
    kind: 'read',
    perm: 'task.read',
    description: 'Tasks with title, project, priority, status and due date. "mine" is tasks assigned to this person; "all" is every task they can see.',
    input_schema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['mine', 'all'] },
        status: { type: 'string', enum: ['not_started', 'in_progress', 'under_review', 'done'] },
        overdue_only: { type: 'boolean' }
      },
      additionalProperties: false
    },
    run: async function (ctx, input) {
      var list = await tasksService.list(ctx, { scope: input.scope || 'mine' });
      var t = todayISO();
      var hits = list.filter(function (x) {
        if (input.status && x.status !== input.status) return false;
        if (input.overdue_only && !(x.status !== 'done' && x.dueDate && day(x.dueDate) < t)) return false;
        return true;
      });
      return capped(hits, function (x) {
        return { title: x.title, project: x.projectName || undefined, priority: x.priority, status: x.status, due: day(x.dueDate), assignees: x.assigneeNames || undefined };
      });
    }
  },
  {
    name: 'list_leave_requests',
    kind: 'read',
    description: "Leave requests this person can see — their own, or their team's for managers — with type, dates, days and status. Also returns the leave types that exist.",
    input_schema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'cancelled'] } },
      additionalProperties: false
    },
    run: async function (ctx, input) {
      var list = await leaveService.list(ctx, {});
      var types = await leaveService.listTypes();
      return Object.assign({ leaveTypes: types.map(function (x) { return x.name + ' (' + x.days_per_year + ' days/year' + (x.paid ? '' : ', unpaid') + ')'; }) },
        capped(list.filter(function (l) { return !input.status || l.status === input.status; }), function (l) {
          return { employee: l.employeeName, type: l.typeName, from: l.startDate, to: l.endDate, days: l.days, status: l.status, reason: l.reason || undefined };
        }));
    }
  },
  {
    name: 'get_approval_queue',
    kind: 'read',
    perm: 'approval.act',
    description: 'Items waiting for this person to approve or reject: leave requests, purchase requests and expense claims.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run: async function (ctx) {
      var list = await approvalsService.queue(ctx, {});
      return capped(list, function (a) {
        return { type: a.subjectType, requester: a.requesterName, role: a.requesterRole, department: a.department, detail: a.detail, reason: a.reason, since: day(a.createdAt) };
      });
    }
  },
  {
    name: 'list_purchase_requests',
    kind: 'read',
    description: 'Purchase (procurement) requests this person can see: item, quantity, estimated price, priority, status and who asked.',
    input_schema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'cancelled'] } },
      additionalProperties: false
    },
    run: async function (ctx, input) {
      var list = await procurementService.list(ctx);
      return capped(list.filter(function (r) { return !input.status || r.status === input.status; }), function (r) {
        return { item: r.item, quantity: r.quantity, estimatedPrice: r.estimatedPrice, priority: r.priority, status: r.status, requester: r.requesterName, department: r.departmentName, requiredBy: r.requiredDate };
      });
    }
  },
  {
    name: 'list_expense_claims',
    kind: 'read',
    description: "Expense claims this person can see (their own, or everyone's for finance roles): category, amount, status and who claimed.",
    input_schema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['pending', 'approved', 'rejected', 'paid'] } },
      additionalProperties: false
    },
    run: async function (ctx, input) {
      var list = await expensesService.list(ctx);
      return capped(list.filter(function (x) { return !input.status || x.status === input.status; }), function (x) {
        return { category: x.category, amount: x.amount, currency: x.currency || 'GHS', status: x.status, requester: x.requesterName, date: x.date || day(x.createdAt), description: x.description || undefined };
      });
    }
  },

  // ---- actions ----------------------------------------------------------
  {
    name: 'create_task',
    kind: 'action',
    perm: 'task.manage',
    description: 'Create a task and assign it.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title (up to 100 characters).' },
        description: { type: 'string' },
        due_date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        assignees: { type: 'array', items: { type: 'string' }, description: 'Names or employee codes of the people to assign. Defaults to the person asking.' }
      },
      required: ['title'],
      additionalProperties: false
    },
    prepare: async function (ctx, input) {
      var title = V.text(input.title, 'Title', 100);
      var due = input.due_date ? V.date(input.due_date, 'Due date') : todayISO();
      var priority = V.oneOf(input.priority || 'medium', ['low', 'medium', 'high'], 'Priority');
      var people = [];
      for (var i = 0; i < (input.assignees || []).length; i++) people.push(await resolveEmployee(ctx, input.assignees[i]));
      var names = people.length ? people.map(function (e) { return e.firstName + ' ' + e.lastName; }).join(', ') : 'you';
      return {
        summary: 'Create task "' + title + '" for ' + names + ', due ' + due + ' (' + priority + ' priority).',
        payload: { title: title, description: String(input.description || '').slice(0, 2000), dueDate: due, priority: priority, assigneeIds: people.map(function (e) { return e.id; }) }
      };
    },
    execute: async function (ctx, p) {
      var t = await tasksService.create(ctx, p);
      return { message: 'Task created: ' + (t.title || p.title) + '.' };
    }
  },
  {
    name: 'request_leave',
    kind: 'action',
    perm: 'leave.request',
    description: 'Submit a leave request for the person asking. Weekends and public holidays are not counted.',
    input_schema: {
      type: 'object',
      properties: {
        leave_type: { type: 'string', description: 'Name of the leave type, e.g. "Annual". list_leave_requests returns the types that exist.' },
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        end_date: { type: 'string', description: 'YYYY-MM-DD' },
        reason: { type: 'string' }
      },
      required: ['leave_type', 'start_date', 'end_date'],
      additionalProperties: false
    },
    prepare: async function (ctx, input) {
      var start = V.date(input.start_date, 'Start date');
      var end = V.date(input.end_date, 'End date');
      if (end < start) fail('invalid', 'The end date is before the start date.');
      var types = await leaveService.listTypes();
      var m = matches(input.leave_type);
      var hits = types.filter(function (t) { return m(t.name); });
      if (hits.length !== 1) {
        fail('invalid', (hits.length ? 'Several leave types match' : 'No leave type matches') + ' "' + input.leave_type + '". Types: ' + types.map(function (t) { return t.name; }).join(', ') + '.');
      }
      return {
        summary: 'Request ' + hits[0].name + ' from ' + start + ' to ' + end + (input.reason ? ' — "' + String(input.reason).slice(0, 120) + '"' : '') + '.',
        payload: { leaveTypeId: hits[0].id, startDate: start, endDate: end, reason: String(input.reason || '').slice(0, 500) }
      };
    },
    execute: async function (ctx, p) {
      var r = await leaveService.requestLeave(ctx, p);
      return { message: 'Leave request submitted for approval (' + r.days + ' working day(s)).' };
    }
  },
  {
    name: 'submit_purchase_request',
    kind: 'action',
    perm: 'procurement.request',
    description: 'Raise a purchase request for approval.',
    input_schema: {
      type: 'object',
      properties: {
        item: { type: 'string' },
        quantity: { type: 'number' },
        reason: { type: 'string', description: 'Why it is needed.' },
        estimated_price: { type: 'number', description: 'Estimated total price in GHS, if known.' },
        required_date: { type: 'string', description: 'YYYY-MM-DD' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'] }
      },
      required: ['item', 'quantity', 'reason'],
      additionalProperties: false
    },
    prepare: async function (ctx, input) {
      var item = V.text(input.item, 'Item', 100);
      var reason = V.text(input.reason, 'Reason', 300);
      var qty = Math.max(1, Number(input.quantity) || 1);
      var required = input.required_date ? V.date(input.required_date, 'Required date') : todayISO();
      var priority = V.oneOf(input.priority || 'medium', ['low', 'medium', 'high'], 'Priority');
      var price = Math.max(0, Number(input.estimated_price) || 0);
      return {
        summary: 'Request ' + qty + ' × ' + item + (price ? ' (about GHS ' + price.toFixed(2) + ')' : '') + ', needed by ' + required + ' — "' + reason + '".',
        payload: { item: item, quantity: qty, reason: reason, estimatedPrice: price, requiredDate: required, priority: priority }
      };
    },
    execute: async function (ctx, p) {
      await procurementService.create(ctx, p);
      return { message: 'Purchase request submitted for approval.' };
    }
  },
  {
    name: 'add_customer',
    kind: 'action',
    perm: 'customer.manage',
    description: 'Add a new customer. Check search_customers first so the same customer is not added twice.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        contact_person: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        address: { type: 'string' },
        category: { type: 'string', enum: ['lead', 'prospect', 'active', 'vip', 'inactive'] }
      },
      required: ['name'],
      additionalProperties: false
    },
    prepare: async function (ctx, input) {
      var name = V.text(input.name, 'Customer name', 100);
      var category = V.oneOf(input.category || 'lead', ['lead', 'prospect', 'active', 'inactive', 'vip'], 'Category');
      var existing = (await customersService.list(ctx)).filter(function (c) { return c.name.trim().toLowerCase() === name.trim().toLowerCase(); });
      if (existing.length) fail('conflict', 'A customer called "' + name + '" already exists.');
      var details = [input.contact_person, input.phone, input.email].filter(Boolean).join(', ');
      return {
        summary: 'Add customer "' + name + '" (' + category + ')' + (details ? ' — ' + details : '') + '.',
        payload: { name: name, category: category, contactPerson: input.contact_person || '', phone: input.phone || '', email: input.email || '', address: input.address || '' }
      };
    },
    execute: async function (ctx, p) {
      var c = await customersService.create(ctx, p);
      return { message: 'Customer added: ' + c.name + '.' };
    }
  },
  {
    name: 'update_product_stock',
    kind: 'action',
    destructive: true, // overwrites the recorded quantity
    perm: 'inventory.manage',
    description: 'Set the stock on hand of one product after a count or correction, recorded in the stock history with the reason.',
    input_schema: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'SKU (best) or product name.' },
        new_stock: { type: 'number', description: 'The correct quantity on hand now.' },
        reason: { type: 'string', description: 'e.g. "Recount on 24 Sep", "Breakage".' }
      },
      required: ['product', 'new_stock', 'reason'],
      additionalProperties: false
    },
    prepare: async function (ctx, input) {
      var p = await resolveProduct(ctx, input.product);
      var qty = Number(input.new_stock);
      if (!isFinite(qty) || qty < 0) fail('invalid', 'Stock must be 0 or more.');
      var reason = V.text(input.reason, 'Reason', 200);
      return {
        summary: 'Set stock of ' + p.name + ' (' + p.sku + ') from ' + p.currentStock + ' to ' + qty + ' ' + p.unit + ' — "' + reason + '".',
        payload: { productId: p.id, newStock: qty, reason: reason }
      };
    },
    execute: async function (ctx, payload) {
      var cur = (await pool.query('SELECT * FROM products WHERE id = $1', [payload.productId])).rows[0];
      if (!cur) fail('notfound', 'That product no longer exists.');
      await productsService.update(ctx, cur.id, {
        sku: cur.sku, name: cur.name, category: cur.category, unit: cur.unit, costPrice: cur.cost_price,
        sellingPrice: cur.selling_price, currentStock: payload.newStock, reorderLevel: cur.reorder_level
      });
      var diff = payload.newStock - Number(cur.current_stock);
      if (diff) {
        await pool.query(
          "INSERT INTO inventory_tx (item_type, item_id, type, qty, date, user_id, reference, notes) VALUES ('product',$1,'adjustment',$2,$3,$4,'Claude',$5)",
          [cur.id, diff, todayISO(), ctx.employee.id, payload.reason]
        );
      }
      await audit(pool, ctx, 'product.stockAdjust', 'product', cur.id, 'Stock of ' + cur.sku + ' set to ' + payload.newStock + ' via Claude: ' + payload.reason);
      return { message: 'Stock of ' + cur.name + ' is now ' + payload.newStock + '.' };
    }
  }
];

var BY_NAME = {};
TOOLS.forEach(function (t) { BY_NAME[t.name] = t; });

// The tools this person may use — the rest are not shown to Claude at all.
function toolsFor(ctx) {
  return TOOLS.filter(function (t) { return !t.perm || ctx.can(t.perm); });
}

function get(name) { return BY_NAME[name] || null; }

module.exports = { TOOLS: TOOLS, toolsFor: toolsFor, get: get, resolveEmployee: resolveEmployee, resolveProduct: resolveProduct };
