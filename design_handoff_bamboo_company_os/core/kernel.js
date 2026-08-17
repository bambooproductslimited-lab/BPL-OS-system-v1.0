/* Bamboo Products Limited — Company OS
 * KERNEL: schema + migrations + repository + RBAC + validation + audit.
 *
 * This file is the application's "server boundary". The UI never touches the
 * persistence layer directly — it calls api.call(method, params) and every call
 * is authenticated, authorised, validated and audited here.
 *
 * PROTOTYPE NOTE (read before production): persistence is browser localStorage
 * and password hashing is a non-cryptographic digest. Both are deliberately
 * isolated behind Storage.* and Crypto.* below so they can be replaced by a
 * real API client (fetch -> Node/Postgres) without touching any screen code.
 */
(function () {
  'use strict';

  // ── storage adapter ───────────────────────────────────────────────────────
  var KEY = 'bpl.os.db.v1';
  var SESSION_KEY = 'bpl.os.session.v1';
  var Storage = {
    read: function () { try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; } },
    write: function (db) { localStorage.setItem(KEY, JSON.stringify(db)); },
    readSession: function () { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (e) { return null; } },
    writeSession: function (s) { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); }
  };

  var Crypto = {
    // Prototype digest only. Server-side replacement: bcrypt/argon2.
    hash: function (pw) {
      var h = 5381, i;
      for (i = 0; i < pw.length; i++) h = ((h << 5) + h + pw.charCodeAt(i)) | 0;
      return 'p1$' + (h >>> 0).toString(36);
    },
    verify: function (pw, hash) { return Crypto.hash(pw) === hash; },
    id: function (p) { return p + '_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); }
  };

  // ── permission catalogue ──────────────────────────────────────────────────
  // resource.action ; scope is resolved per-record (self / department / all)
  var PERMISSIONS = [
    { key: 'employee.read', group: 'People', label: 'View employee records' },
    { key: 'employee.write', group: 'People', label: 'Create & edit employees' },
    { key: 'employee.read.all', group: 'People', label: 'View all departments' },
    { key: 'department.manage', group: 'People', label: 'Manage departments' },
    { key: 'role.manage', group: 'Access', label: 'Manage roles & permissions' },
    { key: 'user.manage', group: 'Access', label: 'Manage user accounts' },
    { key: 'attendance.self', group: 'Attendance', label: 'Clock in / out' },
    { key: 'attendance.read.all', group: 'Attendance', label: 'View all attendance' },
    { key: 'attendance.adjust', group: 'Attendance', label: 'Correct attendance records' },
    { key: 'leave.request', group: 'Leave', label: 'Request leave' },
    { key: 'leave.read.all', group: 'Leave', label: 'View all leave' },
    { key: 'leave.approve', group: 'Leave', label: 'Approve leave' },
    { key: 'task.read', group: 'Work', label: 'View tasks' },
    { key: 'task.manage', group: 'Work', label: 'Create & assign tasks' },
    { key: 'project.read', group: 'Work', label: 'View projects' },
    { key: 'project.manage', group: 'Work', label: 'Manage projects' },
    { key: 'announcement.publish', group: 'Comms', label: 'Publish announcements' },
    { key: 'document.read', group: 'Comms', label: 'View documents' },
    { key: 'document.manage', group: 'Comms', label: 'Upload & manage documents' },
    { key: 'approval.act', group: 'Governance', label: 'Act on approval queue' },
    { key: 'audit.read', group: 'Governance', label: 'Read audit log' },
    { key: 'settings.manage', group: 'Governance', label: 'Manage company settings' },
    { key: 'production.read', group: 'Production', label: 'View raw bamboo & production batches' },
    { key: 'production.manage', group: 'Production', label: 'Record raw bamboo intake & production batches' },
    { key: 'inventory.read', group: 'Inventory', label: 'View products & stock' },
    { key: 'inventory.manage', group: 'Inventory', label: 'Manage products & stock transactions' },
    { key: 'warehouse.manage', group: 'Inventory', label: 'Manage warehouses' },
    { key: 'supplier.read', group: 'Procurement', label: 'View suppliers' },
    { key: 'supplier.manage', group: 'Procurement', label: 'Manage suppliers' },
    { key: 'procurement.request', group: 'Procurement', label: 'Submit purchase requests' },
    { key: 'procurement.read.all', group: 'Procurement', label: 'View all purchase requests' },
    { key: 'procurement.approve', group: 'Procurement', label: 'Approve purchase requests' },
    { key: 'asset.read', group: 'Assets', label: 'View company assets' },
    { key: 'asset.manage', group: 'Assets', label: 'Manage assets & maintenance' },
    { key: 'customer.read', group: 'Sales', label: 'View customers' },
    { key: 'customer.manage', group: 'Sales', label: 'Manage customers' },
    { key: 'quotation.read', group: 'Sales', label: 'View quotations' },
    { key: 'quotation.manage', group: 'Sales', label: 'Create & manage quotations' },
    { key: 'sales.read', group: 'Sales', label: 'View sales orders' },
    { key: 'sales.manage', group: 'Sales', label: 'Manage sales orders' },
    { key: 'invoice.read', group: 'Finance', label: 'View invoices' },
    { key: 'invoice.manage', group: 'Finance', label: 'Manage invoices & payments' },
    { key: 'expense.request', group: 'Finance', label: 'Submit expense claims' },
    { key: 'expense.approve', group: 'Finance', label: 'Approve expense claims' },
    { key: 'expense.read.all', group: 'Finance', label: 'View all expenses' },
    { key: 'report.read', group: 'Finance', label: 'View financial & operations reports' },
    { key: 'catalog.read', group: 'Commercial', label: 'View products & services catalogue' },
    { key: 'catalog.manage', group: 'Commercial', label: 'Manage products & services catalogue' }
  ];
  var ALL = PERMISSIONS.map(function (p) { return p.key; });

  // ── seed ──────────────────────────────────────────────────────────────────
  function seed() {
    var dept = function (id, code, name, managerId) { return { id: id, code: code, name: name, managerId: managerId, parentId: null, status: 'active' }; };
    var departments = [
      dept('d_exec', 'EXE', 'Executive Office', 'e_002'),
      dept('d_hr', 'HRA', 'Human Resources & Admin', 'e_003'),
      dept('d_fin', 'FIN', 'Finance', 'e_003'),
      dept('d_prod', 'PRD', 'Production', 'e_011'),
      dept('d_raw', 'RAW', 'Harvesting & Raw Bamboo', 'e_006'),
      dept('d_qc', 'QCL', 'Quality Control', 'e_007'),
      dept('d_sal', 'SAL', 'Sales & Marketing', 'e_008'),
      dept('d_log', 'LOG', 'Logistics & Warehouse', 'e_009'),
      dept('d_mnt', 'MNT', 'Maintenance & Engineering', 'e_010'),
      dept('d_it', 'ITD', 'Information Technology', 'e_019')
    ];

    var roles = [
      { id: 'r_admin', key: 'administrator', name: 'System Administrator', isSystem: true, description: 'Full access to every module and setting.', permissions: ALL.slice() },
      { id: 'r_exec', key: 'executive', name: 'Executive (MD)', isSystem: true, description: 'Company-wide read access plus final approvals.', permissions: ['employee.read', 'employee.read.all', 'attendance.read.all', 'leave.read.all', 'leave.approve', 'task.read', 'project.read', 'project.manage', 'announcement.publish', 'document.read', 'approval.act', 'audit.read', 'settings.manage'] },
      { id: 'r_hr', key: 'hr_manager', name: 'HR Manager', isSystem: true, description: 'Owns people data, attendance and the leave process.', permissions: ['employee.read', 'employee.read.all', 'employee.write', 'department.manage', 'user.manage', 'attendance.self', 'attendance.read.all', 'attendance.adjust', 'leave.request', 'leave.read.all', 'leave.approve', 'approval.act', 'task.read', 'task.manage', 'project.read', 'announcement.publish', 'document.read', 'document.manage', 'audit.read'] },
      { id: 'r_dept', key: 'department_manager', name: 'Department Manager', isSystem: true, description: 'Manages one department: its people, attendance, leave and work.', permissions: ['employee.read', 'attendance.self', 'attendance.read.all', 'leave.request', 'leave.read.all', 'leave.approve', 'approval.act', 'task.read', 'task.manage', 'project.read', 'project.manage', 'document.read', 'document.manage'] },
      { id: 'r_sup', key: 'supervisor', name: 'Line Supervisor', isSystem: true, description: 'Shift-floor supervision: attendance visibility and task assignment.', permissions: ['employee.read', 'attendance.self', 'attendance.read.all', 'leave.request', 'task.read', 'task.manage', 'project.read', 'document.read'] },
      { id: 'r_emp', key: 'employee', name: 'Employee', isSystem: true, description: 'Self-service only: own record, attendance, leave and tasks.', permissions: ['employee.read', 'attendance.self', 'leave.request', 'task.read', 'project.read', 'document.read'] },
      { id: 'r_mktg', key: 'marketing_manager', name: 'Marketing Manager', isSystem: true, description: 'Owns customers, quotations, sales pipeline and marketing insights.', permissions: ['employee.read', 'attendance.self', 'leave.request', 'task.read', 'task.manage', 'project.read', 'document.read', 'customer.read', 'customer.manage', 'quotation.read', 'quotation.manage', 'sales.read', 'sales.manage', 'catalog.read', 'report.read'] },
      { id: 'r_fin', key: 'finance_manager', name: 'Finance Manager', isSystem: true, description: 'Owns invoicing, payments, expense approvals and financial reporting.', permissions: ['employee.read', 'attendance.self', 'leave.request', 'task.read', 'project.read', 'document.read', 'invoice.read', 'invoice.manage', 'expense.request', 'expense.approve', 'expense.read.all', 'report.read', 'procurement.approve', 'settings.manage'] },
      { id: 'r_cs', key: 'customer_service_manager', name: 'Customer Service Manager', isSystem: true, description: 'Owns customer relationships and order/service follow-up.', permissions: ['employee.read', 'attendance.self', 'leave.request', 'task.read', 'task.manage', 'project.read', 'document.read', 'customer.read', 'customer.manage', 'quotation.read', 'sales.read', 'invoice.read'] },
      { id: 'r_it', key: 'it_manager', name: 'IT Manager', isSystem: true, description: 'Owns company assets, user accounts and system administration support.', permissions: ['employee.read', 'attendance.self', 'leave.request', 'task.read', 'task.manage', 'project.read', 'document.read', 'document.manage', 'asset.read', 'asset.manage', 'user.manage', 'audit.read', 'catalog.read'] },
      { id: 'r_hrfin', key: 'finance_hr_manager', name: 'Finance & HR Manager', isSystem: true, description: 'Combined Finance Manager and HR Manager responsibilities.', permissions: ['employee.read', 'employee.read.all', 'employee.write', 'department.manage', 'user.manage', 'attendance.self', 'attendance.read.all', 'attendance.adjust', 'leave.request', 'leave.read.all', 'leave.approve', 'approval.act', 'task.read', 'task.manage', 'project.read', 'announcement.publish', 'document.read', 'document.manage', 'audit.read', 'invoice.read', 'invoice.manage', 'expense.request', 'expense.approve', 'expense.read.all', 'report.read', 'procurement.approve', 'settings.manage'] },
      { id: 'r_gm', key: 'general_manager', name: 'General Manager', isSystem: true, description: 'Company-wide operational oversight across all departments — broader than a department manager, more hands-on than the MD.', permissions: ['employee.read', 'employee.read.all', 'employee.write', 'attendance.self', 'attendance.read.all', 'attendance.adjust', 'leave.request', 'leave.read.all', 'leave.approve', 'approval.act', 'task.read', 'task.manage', 'project.read', 'project.manage', 'announcement.publish', 'document.read', 'document.manage', 'production.read', 'inventory.read', 'supplier.read', 'procurement.approve', 'asset.read', 'customer.read', 'quotation.read', 'sales.read', 'invoice.read', 'expense.approve', 'expense.read.all', 'report.read', 'audit.read', 'catalog.read'] }
    ];

    var E = [
      ['e_001', 'BPL-001', 'Kelvin', 'Duho', 'd_hr', 'IT & Systems Administrator', 'e_003', ['r_admin'], '2019-03-04'],
      ['e_002', 'BPL-002', 'Andy', 'Chou', 'd_exec', 'Managing Director', null, ['r_exec'], '2015-01-12'],
      ['e_003', 'BPL-003', 'Albert', 'Awini', 'd_hr', 'Finance & HR Manager', 'e_002', ['r_hrfin'], '2017-06-19'],
      ['e_004', 'BPL-004', 'Peter', 'Njoroge', 'd_fin', 'Finance Manager', 'e_003', ['r_dept'], '2018-02-05'],
      ['e_005', 'BPL-005', 'Frank', 'Kampewu', 'd_prod', 'General Manager', 'e_002', ['r_gm'], '2016-09-01'],
      ['e_006', 'BPL-006', 'Samuel', 'Kiptoo', 'd_raw', 'Raw Material Manager', 'e_002', ['r_dept'], '2018-11-13'],
      ['e_007', 'BPL-007', 'Faith', 'Wanjiru', 'd_qc', 'Quality Assurance Manager', 'e_005', ['r_dept'], '2019-07-22'],
      ['e_008', 'BPL-008', 'Daniel', 'Omondi', 'd_sal', 'Sales & Marketing Manager', 'e_002', ['r_dept'], '2017-04-03'],
      ['e_009', 'BPL-009', 'Esther', 'Chebet', 'd_log', 'Warehouse & Logistics Manager', 'e_002', ['r_dept'], '2020-01-20'],
      ['e_010', 'BPL-010', 'Brian', 'Mutua', 'd_mnt', 'Maintenance Engineer', 'e_002', ['r_dept'], '2019-10-07'],
      ['e_011', 'BPL-011', 'Isreal', 'Omozuafo', 'd_prod', 'Production Manager', 'e_002', ['r_dept'], '2021-02-15'],
      ['e_012', 'BPL-012', 'Kevin', 'Barasa', 'd_prod', 'Treatment Line Supervisor', 'e_011', ['r_sup'], '2021-05-04'],
      ['e_013', 'BPL-013', 'Alice', 'Kamau', 'd_prod', 'Machine Operator', 'e_011', ['r_emp'], '2022-03-01'],
      ['e_014', 'BPL-014', 'John', 'Sitati', 'd_prod', 'Machine Operator', 'e_012', ['r_emp'], '2022-08-16'],
      ['e_015', 'BPL-015', 'Lydia', 'Auma', 'd_qc', 'Quality Inspector', 'e_007', ['r_emp'], '2023-01-09'],
      ['e_016', 'BPL-016', 'Moses', 'Wekesa', 'd_raw', 'Harvest Team Lead', 'e_006', ['r_sup'], '2021-11-02'],
      ['e_017', 'BPL-017', 'Christine', 'Adhiambo', 'd_log', 'Store Clerk', 'e_009', ['r_emp'], '2023-06-12'],
      ['e_018', 'BPL-018', 'Victor', 'Maina', 'd_sal', 'Sales Executive', 'e_008', ['r_emp'], '2022-10-24'],
      ['e_019', 'BPL-019', 'Emmanuel', 'Chang', 'd_it', 'Head of IT Department', 'e_002', ['r_it'], '2020-04-06']
    ];
    var employees = [], users = [];
    E.forEach(function (r) {
      var email = (r[2] + '.' + r[3]).toLowerCase() + '@bplghana.com';
      employees.push({
        id: r[0], code: r[1], firstName: r[2], lastName: r[3], email: email,
        phone: '+233 24' + (1000000 + employees.length * 4321).toString().slice(0, 7),
        departmentId: r[4], positionTitle: r[5], managerId: r[6], employmentType: 'permanent',
        hireDate: r[8], status: 'active', location: 'Tema Plant', shift: r[4] === 'd_prod' ? 'Shift A · 06:00–14:00' : 'Day · 08:00–17:00'
      });
      users.push({
        id: 'u' + r[0].slice(1), employeeId: r[0], email: email, passwordHash: Crypto.hash('bamboo123'),
        roleIds: r[7], status: 'active', lastLoginAt: null, mustChangePassword: false
      });
    });

    var leaveTypes = [
      { id: 'lt_annual', name: 'Annual leave', daysPerYear: 21, paid: true },
      { id: 'lt_sick', name: 'Sick leave', daysPerYear: 14, paid: true },
      { id: 'lt_comp', name: 'Compassionate leave', daysPerYear: 5, paid: true },
      { id: 'lt_unpaid', name: 'Unpaid leave', daysPerYear: 0, paid: false },
      { id: 'lt_mat', name: 'Maternity / paternity', daysPerYear: 90, paid: true }
    ];
    var year = new Date().getFullYear();
    var balances = [];
    employees.forEach(function (e, i) {
      leaveTypes.forEach(function (t) {
        balances.push({ id: 'lb_' + e.id + '_' + t.id, employeeId: e.id, leaveTypeId: t.id, year: year, entitled: t.daysPerYear, used: t.id === 'lt_annual' ? (i * 3) % 11 : 0 });
      });
    });

    // attendance for the last 10 working days
    var attendance = [], today = new Date(), d, i, j;
    for (i = 9; i >= 0; i--) {
      d = new Date(today.getTime() - i * 86400000);
      if (d.getDay() === 0) continue;
      var iso = d.toISOString().slice(0, 10);
      for (j = 0; j < employees.length; j++) {
        if (i === 0 && j % 4 === 1) continue; // some not yet clocked in today
        var late = (j + i) % 7 === 0;
        var inH = late ? '08:2' + (i % 6) : (employees[j].departmentId === 'd_prod' ? '06:0' + (i % 6) : '07:5' + (i % 6));
        var outH = employees[j].departmentId === 'd_prod' ? '14:1' + (i % 5) : '17:0' + (i % 5);
        attendance.push({
          id: 'at_' + employees[j].id + '_' + iso, employeeId: employees[j].id, date: iso,
          clockIn: inH, clockOut: i === 0 ? null : outH, status: late ? 'late' : 'present',
          source: 'web', note: '', adjustedBy: null
        });
      }
    }

    var ds = function (offset) { return new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10); };
    var leaveRequests = [
      { id: 'lr_1', employeeId: 'e_013', leaveTypeId: 'lt_annual', startDate: ds(6), endDate: ds(10), days: 5, reason: 'Family visit upcountry.', status: 'pending', createdAt: ds(-1) + 'T09:12', decidedBy: null, decidedAt: null, decisionNote: '' },
      { id: 'lr_2', employeeId: 'e_015', leaveTypeId: 'lt_sick', startDate: ds(-2), endDate: ds(-1), days: 2, reason: 'Medical certificate attached.', status: 'approved', createdAt: ds(-3) + 'T16:40', decidedBy: 'e_007', decidedAt: ds(-3) + 'T17:05', decisionNote: 'Approved, get well.' },
      { id: 'lr_3', employeeId: 'e_017', leaveTypeId: 'lt_annual', startDate: ds(14), endDate: ds(20), days: 7, reason: 'Annual break.', status: 'pending', createdAt: ds(0) + 'T08:02', decidedBy: null, decidedAt: null, decisionNote: '' },
      { id: 'lr_4', employeeId: 'e_014', leaveTypeId: 'lt_unpaid', startDate: ds(3), endDate: ds(4), days: 2, reason: 'Personal matters.', status: 'rejected', createdAt: ds(-4) + 'T11:20', decidedBy: 'e_005', decidedAt: ds(-4) + 'T14:00', decisionNote: 'Line is short-staffed that week.' }
    ];

    var approvals = leaveRequests.filter(function (l) { return l.status === 'pending'; }).map(function (l, i) {
      return { id: 'ap_' + (i + 1), subjectType: 'leave_request', subjectId: l.id, title: 'Leave request', requestedBy: l.employeeId, assigneePermission: 'leave.approve', departmentId: employees.filter(function (e) { return e.id === l.employeeId; })[0].departmentId, status: 'pending', createdAt: l.createdAt, decidedBy: null, decidedAt: null, comment: '' };
    });

    return {
      meta: { schemaVersion: 1, seededAt: new Date().toISOString() },
      settings: {
        companyName: 'Bamboo Products Limited', shortName: 'BPL', country: 'Ghana', currency: 'GHS',
        timezone: 'Africa/Accra', fiscalYearStart: '01-01', workWeek: 'Mon–Sat',
        standardHours: 8, lateAfter: '08:15', plants: ['Tema Plant', 'Accra Office'],
        leaveApprovalChain: ['department_manager', 'hr_manager']
      },
      departments: departments, roles: roles, employees: employees, users: users,
      leaveTypes: leaveTypes, leaveBalances: balances, attendance: attendance,
      leaveRequests: leaveRequests, approvals: approvals,
      tasks: [], projects: [], announcements: [], documents: [], notifications: [], messages: [],
      warehouses: [], rawBatches: [], productionBatches: [], products: [], inventoryTx: [],
      suppliers: [], procurementRequests: [], assets: [], maintenanceRecords: [],
      customers: [], quotations: [], salesOrders: [], invoices: [], expenses: [],
      catalogItems: [], estimates: [], payments: [], receipts: [],
      auditLogs: [{ id: 'al_0', at: new Date().toISOString(), actorUserId: 'system', action: 'system.seed', entity: 'database', entityId: '-', summary: 'Database initialised with Phase 1 schema (v1).' }]
    };
  }

  // ── migrations ────────────────────────────────────────────────────────────
  // Each migration takes the db forward one version. Never destructive without
  // a note; additive changes only in Phase 1.
  var MIGRATIONS = [
    { to: 19, note: 'Add internal staff messaging', up: function (db) {
      if (!db.messages) db.messages = [];
    } },
    { to: 18, note: 'Add third-party integrations settings (TimeStation, Square, etc.)', up: function (db) {
      if (!db.settings.integrations) {
        db.settings.integrations = [
          { id: 'timestation', name: 'TimeStation', category: 'Attendance', description: 'Sync biometric/kiosk clock-in data into Attendance.', connected: false, apiKey: '' },
          { id: 'squareup', name: 'Square', category: 'Payments & POS', description: 'Sync Square payments and orders with Invoices & Payments.', connected: false, apiKey: '' },
          { id: 'slack', name: 'Slack', category: 'Notifications', description: 'Send approval and announcement alerts to a Slack channel.', connected: false, apiKey: '' },
          { id: 'quickbooks', name: 'QuickBooks', category: 'Accounting', description: 'Sync invoices and expenses with QuickBooks.', connected: false, apiKey: '' }
        ];
      }
    } },
    { to: 17, note: 'Add Emmanuel Chang as Head of IT department', up: function (db) {
      if (!db.departments.some(function (x) { return x.id === 'd_it'; })) {
        db.departments.push({ id: 'd_it', code: 'ITD', name: 'Information Technology', managerId: 'e_019', parentId: null, status: 'active' });
      }
      if (!db.employees.some(function (x) { return x.id === 'e_019'; })) {
        var e = {
          id: 'e_019', code: 'BPL-019', firstName: 'Emmanuel', lastName: 'Chang',
          email: 'emmanuel.chang@bplghana.com', phone: '+233 24' + (1000000 + 19 * 4321).toString().slice(0, 7),
          departmentId: 'd_it', positionTitle: 'Head of IT Department', managerId: 'e_002', employmentType: 'permanent',
          hireDate: '2020-04-06', status: 'active', location: 'Tema Plant', shift: 'Day · 08:00–17:00'
        };
        db.employees.push(e);
        db.leaveTypes.forEach(function (t) { db.leaveBalances.push({ id: 'lb_' + e.id + '_' + t.id, employeeId: e.id, leaveTypeId: t.id, year: new Date().getFullYear(), entitled: t.daysPerYear, used: 0 }); });
        db.users.push({ id: 'u_e019', employeeId: e.id, email: e.email, passwordHash: Crypto.hash('bamboo123'), roleIds: ['r_it'], status: 'active', lastLoginAt: null, mustChangePassword: false });
      }
    } },
    { to: 16, note: 'Albert Awini becomes Finance & HR Manager', up: function (db) {
      if (!db.roles.some(function (x) { return x.key === 'finance_hr_manager'; })) {
        db.roles.push({
          id: 'r_hrfin', key: 'finance_hr_manager', name: 'Finance & HR Manager', isSystem: true,
          description: 'Combined Finance Manager and HR Manager responsibilities.',
          permissions: ['employee.read', 'employee.read.all', 'employee.write', 'department.manage', 'user.manage', 'attendance.self', 'attendance.read.all', 'attendance.adjust', 'leave.request', 'leave.read.all', 'leave.approve', 'approval.act', 'task.read', 'task.manage', 'project.read', 'announcement.publish', 'document.read', 'document.manage', 'audit.read', 'invoice.read', 'invoice.manage', 'expense.request', 'expense.approve', 'expense.read.all', 'report.read', 'procurement.approve', 'settings.manage']
        });
      }
      var e = find(db.employees, 'e_003');
      if (e) e.positionTitle = 'Finance & HR Manager';
      var u = db.users.filter(function (x) { return x.employeeId === 'e_003'; })[0];
      if (u) u.roleIds = ['r_hrfin'];
      var fin = find(db.departments, 'd_fin');
      if (fin) fin.managerId = 'e_003';
      var peter = find(db.employees, 'e_004');
      if (peter) peter.managerId = 'e_003';
    } },
    { to: 15, note: 'Isreal Omozuafo becomes Production Manager', up: function (db) {
      var e = find(db.employees, 'e_011');
      if (e) { e.positionTitle = 'Production Manager'; e.managerId = 'e_002'; }
      var u = db.users.filter(function (x) { return x.employeeId === 'e_011'; })[0];
      if (u) u.roleIds = ['r_dept'];
      var dept = find(db.departments, 'd_prod');
      if (dept) dept.managerId = 'e_011';
      var kevin = find(db.employees, 'e_012');
      if (kevin && kevin.managerId === 'e_005') kevin.managerId = 'e_011';
    } },
    { to: 14, note: 'Frank Kampewu becomes General Manager', up: function (db) {
      var e = find(db.employees, 'e_005');
      if (e) e.positionTitle = 'General Manager';
      var u = db.users.filter(function (x) { return x.employeeId === 'e_005'; })[0];
      if (u) u.roleIds = ['r_gm'];
    } },
    { to: 13, note: 'Add General Manager role', up: function (db) {
      if (!db.roles.some(function (x) { return x.key === 'general_manager'; })) {
        db.roles.push({
          id: 'r_gm', key: 'general_manager', name: 'General Manager', isSystem: true,
          description: 'Company-wide operational oversight across all departments — broader than a department manager, more hands-on than the MD.',
          permissions: ['employee.read', 'employee.read.all', 'employee.write', 'attendance.self', 'attendance.read.all', 'attendance.adjust', 'leave.request', 'leave.read.all', 'leave.approve', 'approval.act', 'task.read', 'task.manage', 'project.read', 'project.manage', 'announcement.publish', 'document.read', 'document.manage', 'production.read', 'inventory.read', 'supplier.read', 'procurement.approve', 'asset.read', 'customer.read', 'quotation.read', 'sales.read', 'invoice.read', 'expense.approve', 'expense.read.all', 'report.read', 'audit.read', 'catalog.read']
        });
      }
    } },
    { to: 12, note: 'Add Marketing Manager, Finance Manager, Customer Service Manager and IT Manager roles', up: function (db) {
      var newRoles = [
        { id: 'r_mktg', key: 'marketing_manager', name: 'Marketing Manager', isSystem: true, description: 'Owns customers, quotations, sales pipeline and marketing insights.', permissions: ['employee.read', 'attendance.self', 'leave.request', 'task.read', 'task.manage', 'project.read', 'document.read', 'customer.read', 'customer.manage', 'quotation.read', 'quotation.manage', 'sales.read', 'sales.manage', 'catalog.read', 'report.read'] },
        { id: 'r_fin', key: 'finance_manager', name: 'Finance Manager', isSystem: true, description: 'Owns invoicing, payments, expense approvals and financial reporting.', permissions: ['employee.read', 'attendance.self', 'leave.request', 'task.read', 'project.read', 'document.read', 'invoice.read', 'invoice.manage', 'expense.request', 'expense.approve', 'expense.read.all', 'report.read', 'procurement.approve', 'settings.manage'] },
        { id: 'r_cs', key: 'customer_service_manager', name: 'Customer Service Manager', isSystem: true, description: 'Owns customer relationships and order/service follow-up.', permissions: ['employee.read', 'attendance.self', 'leave.request', 'task.read', 'task.manage', 'project.read', 'document.read', 'customer.read', 'customer.manage', 'quotation.read', 'sales.read', 'invoice.read'] },
        { id: 'r_it', key: 'it_manager', name: 'IT Manager', isSystem: true, description: 'Owns company assets, user accounts and system administration support.', permissions: ['employee.read', 'attendance.self', 'leave.request', 'task.read', 'task.manage', 'project.read', 'document.read', 'document.manage', 'asset.read', 'asset.manage', 'user.manage', 'audit.read', 'catalog.read'] }
      ];
      newRoles.forEach(function (r) { if (!db.roles.some(function (x) { return x.key === r.key; })) db.roles.push(r); });
    } },
    { to: 11, note: 'Grant catalogue permissions to existing roles', up: function (db) {
      var grants = {
        executive: ['catalog.read'],
        department_manager: ['catalog.read', 'catalog.manage'],
        supervisor: ['catalog.read']
      };
      db.roles.forEach(function (r) { var g = grants[r.key]; if (!g) return; g.forEach(function (p) { if (r.permissions.indexOf(p) < 0) r.permissions.push(p); }); });
    } },
    { to: 10, note: 'Quotations, Estimates, Invoicing & Payments module: catalogue, estimates, multi-line quotations/invoices, payments, receipts, commercial settings', up: function (db) {
      db.settings.commercial = {
        currencies: ['GHS', 'USD', 'EUR', 'GBP'],
        taxRates: [
          { id: 'tx_vat', name: 'VAT', rate: 15 },
          { id: 'tx_nhil', name: 'NHIL', rate: 2.5 },
          { id: 'tx_getfund', name: 'GETFund', rate: 2.5 },
          { id: 'tx_wht', name: 'Withholding Tax', rate: 5 },
          { id: 'tx_zero', name: 'Zero-rated', rate: 0 }
        ],
        numbering: {
          estimate: { prefix: 'EST', padding: 4, includeYear: true, nextNumber: 2 },
          quotation: { prefix: 'QT', padding: 4, includeYear: true, nextNumber: 3 },
          invoice: { prefix: 'INV', padding: 4, includeYear: true, nextNumber: 3 },
          receipt: { prefix: 'RCT', padding: 4, includeYear: true, nextNumber: 2 }
        },
        templates: {
          quotationIntro: 'Thank you for the opportunity to quote for your requirements.',
          quotationFooter: 'This quotation is valid until the date shown above. Prices are in the stated currency and exclude any taxes not itemised.',
          invoiceFooter: 'Thank you for your business. Please make payment by the due date using the details provided.',
          paymentTerms: 'Net 30 days from invoice date.',
          termsAndConditions: 'Goods and services remain the property of Bamboo Products Limited until paid in full.',
          validityDays: 14,
          invoiceDueDays: 30
        },
        paymentDetails: {
          bankName: 'Ghana Commercial Bank', accountName: 'Bamboo Products Limited', accountNumber: '1021304050607',
          branch: 'Tema Branch', swift: 'GHCBGHAC', momoProvider: 'MTN Mobile Money', momoNumber: '024 700 1122',
          instructions: 'Please quote the invoice number as payment reference.'
        }
      };
      db.customers.forEach(function (c) {
        if (c.taxId === undefined) c.taxId = '';
        if (c.preferredCurrency === undefined) c.preferredCurrency = 'GHS';
        if (c.paymentTerms === undefined) c.paymentTerms = 'Net 30';
        if (c.billingAddress === undefined) c.billingAddress = c.address;
      });
      db.catalogItems = db.catalogItems.concat([
        { id: 'ci_1', name: 'Bamboo Dining Chair (retail)', code: 'SVC-FRN-001', description: 'Supply of Bamboo Dining Chair, per unit.', category: 'Furniture', unit: 'each', defaultQty: 1, unitPrice: 3500, costPrice: 1800, taxRateId: 'tx_vat', active: true },
        { id: 'ci_2', name: 'Bamboo Flooring Installation', code: 'SVC-FLR-INST', description: 'Supply and installation of bamboo flooring, per square metre.', category: 'Installation Service', unit: 'square meter', defaultQty: 50, unitPrice: 2200, costPrice: 1400, taxRateId: 'tx_vat', active: true },
        { id: 'ci_3', name: 'Site Survey & Consultation', code: 'SVC-CON-001', description: 'On-site measurement and product consultation.', category: 'Service', unit: 'day', defaultQty: 1, unitPrice: 1500, costPrice: 0, taxRateId: 'tx_zero', active: true },
        { id: 'ci_4', name: 'Delivery & Logistics', code: 'SVC-LOG-001', description: 'Delivery of goods to client site within the Greater Accra Region.', category: 'Logistics', unit: 'lot', defaultQty: 1, unitPrice: 800, costPrice: 300, taxRateId: 'tx_zero', active: true }
      ]);
      function d(o) { return new Date(Date.now() + o * 86400000).toISOString().slice(0, 10); }
      function computeTotals(items, docDiscount, docTaxRate) {
        var subtotal = 0, discountTotal = 0, taxTotal = 0;
        items.forEach(function (it) {
          var line = it.qty * it.unitPrice;
          var lineDiscount = it.discountType === 'percent' ? line * (it.discount || 0) / 100 : (it.discount || 0);
          var afterDiscount = line - lineDiscount;
          var lineTax = afterDiscount * (it.taxRate || 0) / 100;
          subtotal += line; discountTotal += lineDiscount; taxTotal += lineTax;
        });
        var docDiscountAmt = docDiscount ? (docDiscount.type === 'percent' ? (subtotal - discountTotal) * (docDiscount.value || 0) / 100 : (docDiscount.value || 0)) : 0;
        discountTotal += docDiscountAmt;
        var docTaxAmt = docTaxRate ? (subtotal - discountTotal) * (docTaxRate || 0) / 100 : 0;
        taxTotal += docTaxAmt;
        var grandTotal = subtotal - discountTotal + taxTotal;
        return { subtotal: subtotal, discountTotal: discountTotal, taxTotal: taxTotal, grandTotal: Math.round(grandTotal * 100) / 100 };
      }
      db.quotations.forEach(function (q) {
        q.items = q.items.map(function (it) { return Object.assign({ discount: 0, discountType: 'fixed', taxRate: 0 }, it); });
        var t = computeTotals(q.items, null, 0);
        q.subtotal = t.subtotal; q.discountTotal = t.discountTotal; q.taxTotal = t.taxTotal; q.grandTotal = q.total;
        q.title = q.title || 'Quotation for ' + (find(db.customers, q.customerId) || {}).name;
        q.terms = db.settings.commercial.templates.termsAndConditions;
        q.notes = q.notes || '';
      });
      db.estimates = db.estimates.concat([
        { id: 'es_1', estimateNo: 'EST-' + new Date().getFullYear() + '-0001', customerId: 'cu_2', items: [{ description: 'Bamboo Flooring Installation — pilot units (est.)', qty: 40, unit: 'square meter', unitPrice: 2200, discount: 0, discountType: 'fixed', taxRate: 15 }], subtotal: 88000, discountTotal: 0, taxTotal: 13200, grandTotal: 101200, status: 'finalized', createdBy: 'e_018', createdAt: d(-9), validUntil: d(12), internalNotes: 'Waiting on county budget approval before formal quotation.', clientNotes: 'Indicative pricing for the housing pilot.', terms: db.settings.commercial.templates.termsAndConditions }
      ]);
      db.invoices.forEach(function (i) {
        var order = i.salesOrderId && find(db.salesOrders, i.salesOrderId);
        i.items = (order ? order.items : [{ description: 'Invoiced amount', qty: 1, unitPrice: i.amount }]).map(function (it) { return Object.assign({ discount: 0, discountType: 'fixed', taxRate: 0 }, it); });
        i.subtotal = i.amount; i.discountTotal = 0; i.taxTotal = 0; i.grandTotal = i.amount;
        i.amountPaid = i.status === 'paid' ? i.amount : 0;
        i.balanceDue = i.grandTotal - i.amountPaid;
        i.poReference = i.poReference || '';
        i.bankInstructions = db.settings.commercial.paymentDetails.instructions;
      });
      var iv1 = find(db.invoices, 'iv_1');
      if (iv1 && iv1.amountPaid === 0) {
        var payAmt = Math.round(iv1.grandTotal * 0.4);
        var pay = { id: 'pmt_1', invoiceId: iv1.id, customerId: iv1.customerId, date: d(-3), amount: payAmt, currency: 'GHS', method: 'bank_transfer', reference: 'TRX-88213', receivedBy: 'e_004', notes: 'Part payment received ahead of delivery.' };
        db.payments = db.payments.concat([pay]);
        iv1.amountPaid = payAmt; iv1.balanceDue = iv1.grandTotal - payAmt; iv1.status = iv1.balanceDue > 0 ? 'partially_paid' : 'paid';
        db.receipts = db.receipts.concat([{ id: 'rct_1', receiptNo: 'RCT-' + new Date().getFullYear() + '-0001', paymentId: pay.id, invoiceId: iv1.id, customerId: iv1.customerId, date: pay.date, amount: pay.amount, method: pay.method, reference: pay.reference, balanceAfter: iv1.balanceDue, receivedBy: pay.receivedBy }]);
      }
      db.auditLogs.unshift({ id: Crypto.id('al'), at: new Date().toISOString(), actorUserId: 'system', action: 'system.migrate', entity: 'database', entityId: '10', summary: 'Added Quotations, Estimates, Invoicing & Payments module: catalogue, estimates, multi-line documents, payments, receipts, commercial settings.' });
    } },
    { to: 9, note: 'Correct company country to Ghana (settings, plants, phone numbers, place names, currency)', up: function (db) {
      db.settings.country = 'Ghana'; db.settings.currency = 'GHS'; db.settings.timezone = 'Africa/Accra';
      db.settings.plants = ['Tema Plant', 'Accra Office'];
      db.employees.forEach(function (e) {
        if (e.location === 'Thika Plant') e.location = 'Tema Plant';
        if (e.location === 'Nairobi Office') e.location = 'Accra Office';
        if (/^\+254/.test(e.phone)) e.phone = '+233 24' + e.phone.replace(/\D/g, '').slice(-7);
      });
      db.warehouses.forEach(function (w) {
        if (w.location === 'Thika Plant') w.location = 'Tema Plant';
        if (w.location === 'Nairobi Office') w.location = 'Accra Office';
        w.name = w.name.replace('Thika', 'Tema').replace('Nairobi', 'Accra');
      });
      var custRenames = {
        'Nyeri County Government — Housing Dept': { name: 'Eastern Regional Coordinating Council — Housing Dept', contactPerson: 'Eng. Paul Boateng', email: 'housing@easternrcc.gov.gh', phone: '+233 20 111 8822', address: 'Koforidua' },
        'EcoBuild Kenya Contractors': { name: 'EcoBuild Ghana Contractors', contactPerson: 'Michael Osei', email: 'procurement@ecobuildgh.com', phone: '+233 27 122 0033', address: 'Airport City, Accra' },
        'Coastal Furniture Traders': { contactPerson: 'Amina Sallah', email: 'amina@coastalfurniture.com.gh', phone: '+233 20 998 8811', address: 'Takoradi' },
        'Greenline Hardware Ltd': { email: 'susan@greenlinehardware.com.gh', phone: '+233 24 733 4455', address: 'Spintex Road, Accra' }
      };
      db.customers.forEach(function (c) {
        var patch = custRenames[c.name];
        if (patch) { Object.keys(patch).forEach(function (k) { c[k] = patch[k]; }); }
      });
      var supRenames = {
        'Mount Kenya Bamboo Growers Co-op': { name: 'Ashanti Bamboo Growers Co-op', contactPerson: 'James Owusu', phone: '+233 24 210 0200', email: 'sales@ashantibamboo.com.gh', address: 'Ejisu, Ashanti Region' },
        'Rift Valley Bamboo Suppliers Ltd': { name: 'Volta Bamboo Suppliers Ltd', contactPerson: 'Grace Adjei', phone: '+233 20 344 5566', email: 'info@voltabamboo.com.gh', address: 'Ho, Volta Region' },
        'Kenpoly Packaging Ltd': { name: 'GhanaPoly Packaging Ltd', contactPerson: 'Peter Owusu', phone: '+233 27 199 8877', email: 'orders@ghanapoly.com.gh', address: 'Tema Industrial Area' }
      };
      db.suppliers.forEach(function (s) {
        var patch = supRenames[s.name];
        if (patch) { Object.keys(patch).forEach(function (k) { s[k] = patch[k]; }); }
      });
      db.expenses.forEach(function (e) { if (e.description && e.description.indexOf('Mombasa') >= 0) e.description = e.description.replace('Mombasa', 'Takoradi'); });
      db.assets.forEach(function (a) {
        if (a.description === 'Isuzu NPR delivery truck KDA 221B') a.description = 'Isuzu NPR delivery truck GT 2214-24';
      });
      db.maintenanceRecords.forEach(function (m) { if (m.technician === 'External — Isuzu Kenya') m.technician = 'External — Isuzu Ghana'; });
      db.announcements.forEach(function (a) {
        if (a.title === 'Mashujaa Day — plant closed') {
          a.title = 'Founders\' Day — plant closed';
          a.body = 'The Tema plant and Accra office will be closed on 4 August for Founders\' Day. Production resumes the following working day.';
        }
      });
    } },
    { to: 7, note: 'Switch work email domain to bplghana.com', up: function (db) {
      db.employees.forEach(function (e) {
        if (/@bambooproducts\.co\.ke$/.test(e.email)) {
          var newEmail = e.email.replace(/@bambooproducts\.co\.ke$/, '@bplghana.com');
          var u = db.users.filter(function (x) { return x.employeeId === e.id; })[0];
          if (u) u.email = newEmail;
          e.email = newEmail;
        }
      });
    } },
    { to: 6, note: 'Rename Executive, HR Manager, Department Manager and Line Supervisor demo employees', up: function (db) {
      var renames = [
        { id: 'e_002', firstOld: 'Joseph', firstNew: 'Andy', lastNew: 'Chou' },
        { id: 'e_003', firstOld: 'Amina', firstNew: 'Albert', lastNew: 'Awini' },
        { id: 'e_005', firstOld: 'Ruth', firstNew: 'Frank', lastNew: 'Kampewu' },
        { id: 'e_011', firstOld: 'Mercy', firstNew: 'Isreal', lastNew: 'Omozuafo' }
      ];
      renames.forEach(function (r) {
        var e = find(db.employees, r.id);
        if (e && e.firstName === r.firstOld) {
          e.firstName = r.firstNew; e.lastName = r.lastNew;
          e.email = (r.firstNew + '.' + r.lastNew).toLowerCase() + '@bplghana.com';
          var u = db.users.filter(function (x) { return x.employeeId === r.id; })[0];
          if (u) u.email = e.email;
        }
      });
    } },
    { to: 5, note: 'Rename System Administrator to Kelvin Duho', up: function (db) {
      var e = find(db.employees, 'e_001');
      if (e && e.firstName === 'Grace') {
        e.firstName = 'Kelvin'; e.lastName = 'Duho'; e.email = 'kelvin.duho@bplghana.com';
        var u = db.users.filter(function (x) { return x.employeeId === 'e_001'; })[0];
        if (u) u.email = e.email;
      }
    } },
    { to: 4, note: 'Phase 3: customers, quotations, sales orders, invoices, expenses', up: function (db) {
      var grants = {
        administrator: ALL.slice(),
        executive: ['customer.read', 'quotation.read', 'sales.read', 'invoice.read', 'expense.read.all', 'report.read'],
        department_manager: ['customer.read', 'customer.manage', 'quotation.read', 'quotation.manage', 'sales.read', 'sales.manage', 'invoice.read', 'invoice.manage', 'expense.request', 'expense.approve', 'expense.read.all', 'report.read'],
        supervisor: ['customer.read', 'quotation.read', 'sales.read', 'expense.request'],
        employee: ['expense.request']
      };
      db.roles.forEach(function (r) { var g = grants[r.key]; if (!g) return; g.forEach(function (p) { if (r.permissions.indexOf(p) < 0) r.permissions.push(p); }); });

      function d(o) { return new Date(Date.now() + o * 86400000).toISOString().slice(0, 10); }
      db.customers = db.customers.concat([
        { id: 'cu_1', name: 'Greenline Hardware Ltd', contactPerson: 'Susan Wambui', email: 'susan@greenlinehardware.com.gh', phone: '+233 24 733 4455', address: 'Spintex Road, Accra', category: 'active', accountManagerId: 'e_008', status: 'active', notes: 'Repeat flooring buyer.' },
        { id: 'cu_2', name: 'Eastern Regional Coordinating Council — Housing Dept', contactPerson: 'Eng. Paul Boateng', email: 'housing@easternrcc.gov.gh', phone: '+233 20 111 8822', address: 'Koforidua', category: 'prospect', accountManagerId: 'e_018', status: 'active', notes: 'Evaluating bamboo flooring for a housing pilot.' },
        { id: 'cu_3', name: 'EcoBuild Ghana Contractors', contactPerson: 'Michael Osei', email: 'procurement@ecobuildgh.com', phone: '+233 27 122 0033', address: 'Airport City, Accra', category: 'vip', accountManagerId: 'e_008', status: 'active', notes: 'Large recurring furniture orders.' },
        { id: 'cu_4', name: 'Coastal Furniture Traders', contactPerson: 'Amina Sallah', email: 'amina@coastalfurniture.com.gh', phone: '+233 20 998 8811', address: 'Takoradi', category: 'lead', accountManagerId: 'e_018', status: 'active', notes: 'First enquiry, awaiting samples.' }
      ]);
      db.quotations = db.quotations.concat([
        { id: 'qt_1', quoteNo: 'QT-2601', customerId: 'cu_1', items: [{ description: 'Bamboo Flooring Plank 1.2m', qty: 200, unitPrice: 1600 }], total: 320000, status: 'sent', createdBy: 'e_018', createdAt: d(-6), validUntil: d(14) },
        { id: 'qt_2', quoteNo: 'QT-2602', customerId: 'cu_3', items: [{ description: 'Bamboo Bar Stool', qty: 50, unitPrice: 3200 }, { description: 'Woven Bamboo Wall Panel', qty: 20, unitPrice: 2100 }], total: 202000, status: 'accepted', createdBy: 'e_008', createdAt: d(-10), validUntil: d(5) }
      ]);
      db.salesOrders = db.salesOrders.concat([
        { id: 'so_1', orderNo: 'SO-1401', customerId: 'cu_3', quotationId: 'qt_2', items: db.quotations[db.quotations.length - 1].items, total: 202000, status: 'processing', createdAt: d(-8), createdBy: 'e_008' }
      ]);
      db.invoices = db.invoices.concat([
        { id: 'iv_1', invoiceNo: 'INV-3301', salesOrderId: 'so_1', customerId: 'cu_3', amount: 202000, status: 'unpaid', issuedAt: d(-7), dueDate: d(23), paidAt: null }
      ]);
      db.expenses = db.expenses.concat([
        { id: 'ex_1', requesterId: 'e_018', departmentId: 'd_sal', category: 'Travel', amount: 8500, date: d(-3), description: 'Client visit to Takoradi — fuel and accommodation.', projectId: null, status: 'pending', createdAt: d(-3) + 'T10:00', decidedBy: null, decidedAt: null },
        { id: 'ex_2', requesterId: 'e_009', departmentId: 'd_log', category: 'Fuel', amount: 15000, date: d(-5), description: 'Diesel for delivery truck.', projectId: null, status: 'approved', createdAt: d(-5) + 'T09:00', decidedBy: 'e_002', decidedAt: d(-4) + 'T11:00' },
        { id: 'ex_3', requesterId: 'e_013', departmentId: 'd_prod', category: 'Supplies', amount: 2200, date: d(-1), description: 'Safety gloves for weaving line.', projectId: null, status: 'pending', createdAt: d(-1) + 'T08:30', decidedBy: null, decidedAt: null }
      ]);
      db.approvals = db.approvals.concat(db.expenses.filter(function (e) { return e.status === 'pending'; }).map(function (e, i) {
        return { id: 'ap_ex_' + (i + 1), subjectType: 'expense', subjectId: e.id, title: 'Expense claim', requestedBy: e.requesterId, assigneePermission: 'expense.approve', departmentId: e.departmentId, status: 'pending', createdAt: e.createdAt, decidedBy: null, decidedAt: null, comment: '' };
      }));
      db.auditLogs.unshift({ id: Crypto.id('al'), at: new Date().toISOString(), actorUserId: 'system', action: 'system.migrate', entity: 'database', entityId: '4', summary: 'Seeded Phase 3 demo data: customers, quotations, sales orders, invoices, expenses.' });
    } },
    { to: 3, note: 'Phase 2: production, inventory, suppliers, procurement, assets & maintenance', up: function (db) {
      var grants = {
        administrator: ALL.slice(),
        executive: ['production.read', 'inventory.read', 'supplier.read', 'procurement.read.all', 'asset.read'],
        hr_manager: ['asset.read'],
        department_manager: ['production.read', 'production.manage', 'inventory.read', 'inventory.manage', 'warehouse.manage', 'supplier.read', 'supplier.manage', 'procurement.request', 'procurement.approve', 'asset.read', 'asset.manage'],
        supervisor: ['production.read', 'inventory.read', 'asset.read'],
        employee: ['procurement.request']
      };
      db.roles.forEach(function (r) { var g = grants[r.key]; if (!g) return; g.forEach(function (p) { if (r.permissions.indexOf(p) < 0) r.permissions.push(p); }); });

      function d(o) { return new Date(Date.now() + o * 86400000).toISOString().slice(0, 10); }
      db.warehouses = db.warehouses.concat([
        { id: 'wh_1', code: 'WH-RAW', name: 'Tema Raw Materials Store', location: 'Tema Plant' },
        { id: 'wh_2', code: 'WH-FG', name: 'Tema Finished Goods Warehouse', location: 'Tema Plant' },
        { id: 'wh_3', code: 'WH-ACC', name: 'Accra Distribution Store', location: 'Accra Office' }
      ]);
      db.suppliers = db.suppliers.concat([
        { id: 'sup_1', name: 'Ashanti Bamboo Growers Co-op', contactPerson: 'James Owusu', phone: '+233 24 210 0200', email: 'sales@ashantibamboo.com.gh', address: 'Ejisu, Ashanti Region', materialsSupplied: 'Raw bamboo poles (Bambusa vulgaris)', paymentTerms: 'Net 30', status: 'active' },
        { id: 'sup_2', name: 'Volta Bamboo Suppliers Ltd', contactPerson: 'Grace Adjei', phone: '+233 20 344 5566', email: 'info@voltabamboo.com.gh', address: 'Ho, Volta Region', materialsSupplied: 'Raw bamboo poles (Oxytenanthera abyssinica)', paymentTerms: 'Net 15', status: 'active' },
        { id: 'sup_3', name: 'GhanaPoly Packaging Ltd', contactPerson: 'Peter Owusu', phone: '+233 27 199 8877', email: 'orders@ghanapoly.com.gh', address: 'Tema Industrial Area', materialsSupplied: 'Packaging materials, shrink wrap', paymentTerms: 'Net 30', status: 'active' }
      ]);
      db.rawBatches = db.rawBatches.concat([
        { id: 'rb_1', batchNo: 'RB-2026-041', species: 'Bambusa vulgaris', supplierId: 'sup_1', dateReceived: d(-12), quantity: 3000, unit: 'kg', qualityGrade: 'A', cost: 210000, warehouseId: 'wh_1', status: 'in_stock' },
        { id: 'rb_2', batchNo: 'RB-2026-042', species: 'Oxytenanthera abyssinica', supplierId: 'sup_2', dateReceived: d(-6), quantity: 2500, unit: 'kg', qualityGrade: 'B', cost: 124000, warehouseId: 'wh_1', status: 'in_stock' },
        { id: 'rb_3', batchNo: 'RB-2026-043', species: 'Bambusa vulgaris', supplierId: 'sup_1', dateReceived: d(-2), quantity: 2800, unit: 'kg', qualityGrade: 'A', cost: 140000, warehouseId: 'wh_1', status: 'in_stock' }
      ]);
      db.products = db.products.concat([
        { id: 'pd_1', sku: 'BPL-FLR-001', name: 'Bamboo Flooring Plank 1.2m', category: 'Flooring', unit: 'plank', costPrice: 850, sellingPrice: 1400, currentStock: 640, reorderLevel: 200 },
        { id: 'pd_2', sku: 'BPL-FUR-010', name: 'Bamboo Bar Stool', category: 'Furniture', unit: 'piece', costPrice: 1800, sellingPrice: 3200, currentStock: 38, reorderLevel: 50 },
        { id: 'pd_3', sku: 'BPL-SKW-100', name: 'BBQ Skewer Pack (50pc)', category: 'Kitchenware', unit: 'pack', costPrice: 90, sellingPrice: 180, currentStock: 1250, reorderLevel: 300 },
        { id: 'pd_4', sku: 'BPL-PNL-020', name: 'Woven Bamboo Wall Panel', category: 'Décor', unit: 'panel', costPrice: 1200, sellingPrice: 2100, currentStock: 22, reorderLevel: 40 }
      ]);
      db.productionBatches = db.productionBatches.concat([
        { id: 'pb_1', batchNo: 'PB-2026-118', date: d(-5), productionLine: 'Weaving Line', supervisorId: 'e_011', employeeIds: ['e_013'], rawBatchId: 'rb_1', outputProductId: 'pd_1', inputQty: 1200, outputQty: 980, wasteQty: 180, rejectedQty: 40, notes: 'Standard run.', status: 'completed' },
        { id: 'pb_2', batchNo: 'PB-2026-119', date: d(-3), productionLine: 'Treatment Line', supervisorId: 'e_012', employeeIds: ['e_014'], rawBatchId: 'rb_2', outputProductId: 'pd_4', inputQty: 600, outputQty: 22, wasteQty: 60, rejectedQty: 8, notes: 'New panel design trial run.', status: 'completed' }
      ]);
      db.inventoryTx = db.inventoryTx.concat([
        { id: 'ivt_1', itemType: 'product', itemId: 'pd_1', warehouseId: 'wh_2', type: 'production_output', qty: 980, date: d(-5), userId: 'e_005', reference: 'PB-2026-118', notes: '' },
        { id: 'ivt_2', itemType: 'raw', itemId: 'rb_1', warehouseId: 'wh_1', type: 'production_consumption', qty: -1200, date: d(-5), userId: 'e_005', reference: 'PB-2026-118', notes: '' }
      ]);
      db.procurementRequests = db.procurementRequests.concat([
        { id: 'pr_1', requesterId: 'e_009', departmentId: 'd_log', item: 'Pallet wrap film (20 rolls)', quantity: 20, estimatedPrice: 24000, reason: 'Current stock will run out before month end.', requiredDate: d(10), priority: 'medium', status: 'pending', createdAt: d(-1) + 'T09:00', decidedBy: null, decidedAt: null },
        { id: 'pr_2', requesterId: 'e_010', departmentId: 'd_mnt', item: 'Bandsaw blades (10 units)', quantity: 10, estimatedPrice: 35000, reason: 'Blades on Line 2 planer are worn.', requiredDate: d(5), priority: 'high', status: 'pending', createdAt: d(-2) + 'T14:00', decidedBy: null, decidedAt: null },
        { id: 'pr_3', requesterId: 'e_006', departmentId: 'd_raw', item: 'Moisture meters (3 units)', quantity: 3, estimatedPrice: 45000, reason: 'Needed for incoming bamboo quality checks.', requiredDate: d(20), priority: 'low', status: 'approved', createdAt: d(-10) + 'T08:00', decidedBy: 'e_005', decidedAt: d(-9) + 'T10:00' }
      ]);
      db.approvals = db.approvals.concat(db.procurementRequests.filter(function (p) { return p.status === 'pending'; }).map(function (p, i) {
        return { id: 'ap_pr_' + (i + 1), subjectType: 'procurement_request', subjectId: p.id, title: 'Purchase request', requestedBy: p.requesterId, assigneePermission: 'procurement.approve', departmentId: p.departmentId, status: 'pending', createdAt: p.createdAt, decidedBy: null, decidedAt: null, comment: '' };
      }));
      db.assets = db.assets.concat([
        { id: 'as_1', assetNo: 'AST-0012', category: 'Machinery', description: 'Bamboo splitting machine — Line 2', purchaseDate: '2021-03-10', purchasePrice: 2400000, assignedEmployeeId: 'e_012', location: 'Thika Plant — Treatment Line', condition: 'good', warrantyUntil: '2026-03-10', nextServiceDate: d(18) },
        { id: 'as_2', assetNo: 'AST-0031', category: 'Vehicle', description: 'Isuzu NPR delivery truck GT 2214-24', purchaseDate: '2020-07-01', purchasePrice: 4800000, assignedEmployeeId: 'e_009', location: 'Thika Plant — Logistics Yard', condition: 'fair', warrantyUntil: '2023-07-01', nextServiceDate: d(6) },
        { id: 'as_3', assetNo: 'AST-0055', category: 'Computer', description: 'HP ProDesk — Finance office', purchaseDate: '2023-01-15', purchasePrice: 95000, assignedEmployeeId: 'e_004', location: 'Nairobi Office', condition: 'good', warrantyUntil: '2026-01-15', nextServiceDate: null }
      ]);
      db.maintenanceRecords = db.maintenanceRecords.concat([
        { id: 'mt_1', assetId: 'as_1', date: d(-30), technician: 'Brian Mutua', cost: 18000, faultReport: 'Blade misalignment causing uneven splits.', downtimeHours: 6, partsReplaced: 'Alignment guide', status: 'completed' },
        { id: 'mt_2', assetId: 'as_2', date: d(-2), technician: 'External — Isuzu Ghana', cost: 42000, faultReport: 'Routine service, brake pads replaced.', downtimeHours: 8, partsReplaced: 'Brake pads, oil filter', status: 'completed' }
      ]);
      db.auditLogs.unshift({ id: Crypto.id('al'), at: new Date().toISOString(), actorUserId: 'system', action: 'system.migrate', entity: 'database', entityId: '3', summary: 'Seeded Phase 2 demo data: production, inventory, suppliers, procurement, assets.' });
    } },
    { to: 2, note: 'seed Tasks, Projects, Announcements and Documents demo data', up: function (db) {
      function d(o) { return new Date(Date.now() + o * 86400000).toISOString().slice(0, 10); }
      db.projects = db.projects.concat([
        { id: 'pj_1', code: 'PRJ-001', name: 'Weaving Line Efficiency Upgrade', departmentId: 'd_prod', ownerId: 'e_005', memberIds: ['e_011', 'e_012', 'e_013', 'e_014'], startDate: d(-40), deadline: d(50), status: 'active', budget: 850000, description: 'Reduce changeover time and waste on the weaving line by re-sequencing shifts and retraining operators.' },
        { id: 'pj_2', code: 'PRJ-002', name: 'HR Digital Records Migration', departmentId: 'd_hr', ownerId: 'e_003', memberIds: ['e_001', 'e_003'], startDate: d(-20), deadline: d(70), status: 'planning', budget: 200000, description: 'Move paper personnel files into the document library with access controls.' },
        { id: 'pj_3', code: 'PRJ-003', name: 'ISO Certification Renewal', departmentId: 'd_qc', ownerId: 'e_007', memberIds: ['e_007', 'e_015'], startDate: d(-90), deadline: d(45), status: 'active', budget: 420000, description: 'Prepare documentation and floor readiness for the ISO 9001 recertification audit.' }
      ]);
      db.tasks = db.tasks.concat([
        { id: 'tk_1', title: 'Audit changeover times on Line 2', projectId: 'pj_1', assigneeIds: ['e_012'], priority: 'high', dueDate: d(3), status: 'in_progress', createdBy: 'e_005', createdAt: d(-6) + 'T09:00', description: 'Time ten changeovers and log causes of delay.', comments: [] },
        { id: 'tk_2', title: 'Retrain weaving operators on new sequence', projectId: 'pj_1', assigneeIds: ['e_011', 'e_012'], priority: 'medium', dueDate: d(10), status: 'not_started', createdBy: 'e_005', createdAt: d(-4) + 'T11:20', description: '', comments: [] },
        { id: 'tk_3', title: 'Scan personnel files for HR archive', projectId: 'pj_2', assigneeIds: ['e_001'], priority: 'low', dueDate: d(14), status: 'not_started', createdBy: 'e_003', createdAt: d(-2) + 'T08:30', description: 'Start with Production and QC department files.', comments: [] },
        { id: 'tk_4', title: 'Draft ISO internal audit checklist', projectId: 'pj_3', assigneeIds: ['e_015'], priority: 'high', dueDate: d(2), status: 'under_review', createdBy: 'e_007', createdAt: d(-8) + 'T10:00', description: '', comments: [{ id: 'cm_1', authorId: 'e_007', text: 'Please include the treatment line in scope.', at: d(-1) + 'T15:00' }] },
        { id: 'tk_5', title: 'Reconcile August raw bamboo intake log', projectId: null, assigneeIds: ['e_006'], priority: 'medium', dueDate: d(5), status: 'in_progress', createdBy: 'e_006', createdAt: d(-3) + 'T09:10', description: '', comments: [] }
      ]);
      db.announcements = db.announcements.concat([
        { id: 'an_1', title: 'Founders\' Day — plant closed', body: 'The Tema plant and Accra office will be closed on 4 August for Founders\' Day. Production resumes the following working day.', audience: 'all', publishedBy: 'e_003', publishedAt: d(-2) + 'T08:00', pinned: true },
        { id: 'an_2', title: 'New quality inspection checklist effective this week', body: 'QC will use the revised inspection checklist for all treatment-line batches starting Monday. See Documents for the updated form.', audience: 'd_qc', publishedBy: 'e_007', publishedAt: d(-1) + 'T14:00', pinned: false },
        { id: 'an_3', title: 'Q3 town hall — all staff', body: 'Join the Managing Director for a company-wide update on production targets and the ISO recertification, Friday 3pm in the main hall.', audience: 'all', publishedBy: 'e_002', publishedAt: d(0) + 'T07:30', pinned: true }
      ]);
      db.documents = db.documents.concat([
        { id: 'doc_1', title: 'Employee Handbook 2026', category: 'Policy', departmentId: null, visibility: 'all', uploadedBy: 'e_003', uploadedAt: d(-40), fileName: 'employee-handbook-2026.pdf' },
        { id: 'doc_2', title: 'Health & Safety Policy', category: 'Policy', departmentId: null, visibility: 'all', uploadedBy: 'e_003', uploadedAt: d(-40), fileName: 'health-safety-policy.pdf' },
        { id: 'doc_3', title: 'ISO 9001 Audit Pack (draft)', category: 'Production', departmentId: 'd_qc', visibility: 'managers', uploadedBy: 'e_007', uploadedAt: d(-5), fileName: 'iso9001-audit-pack-draft.pdf' },
        { id: 'doc_4', title: 'Weaving Line SOP', category: 'Production', departmentId: 'd_prod', visibility: 'department', uploadedBy: 'e_005', uploadedAt: d(-20), fileName: 'weaving-line-sop.pdf' }
      ]);
    } }
  ];

  function migrate(db) {
    ['tasks', 'projects', 'announcements', 'documents', 'notifications', 'warehouses', 'rawBatches', 'productionBatches', 'products', 'inventoryTx', 'suppliers', 'procurementRequests', 'assets', 'maintenanceRecords', 'customers', 'quotations', 'salesOrders', 'invoices', 'expenses', 'catalogItems', 'estimates', 'payments', 'receipts'].forEach(function (k) {
      if (!db[k]) db[k] = [];
    });
    MIGRATIONS.slice().sort(function (a, b) { return a.to - b.to; }).forEach(function (m) {
      if (db.meta.schemaVersion < m.to) {
        m.up(db); db.meta.schemaVersion = m.to;
        db.auditLogs.push({ id: Crypto.id('al'), at: new Date().toISOString(), actorUserId: 'system', action: 'system.migrate', entity: 'database', entityId: String(m.to), summary: 'Migration to v' + m.to + ': ' + m.note });
      }
    });
    return db;
  }

  var db = migrate(Storage.read() || seed());
  Storage.write(db);

  function commit() { Storage.write(db); }
  function find(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function todayISO() { return new Date().toISOString().slice(0, 10); }

  // ── RBAC ──────────────────────────────────────────────────────────────────
  function permissionsOf(user) {
    var set = {};
    (user.roleIds || []).forEach(function (rid) {
      var r = find(db.roles, rid);
      if (r) r.permissions.forEach(function (p) { set[p] = true; });
    });
    return Object.keys(set);
  }

  function ctxFor(user) {
    var emp = find(db.employees, user.employeeId);
    var perms = permissionsOf(user);
    var pset = {}; perms.forEach(function (p) { pset[p] = true; });
    return {
      user: user, employee: emp, permissions: perms,
      can: function (p) { return !!pset[p]; },
      roleNames: (user.roleIds || []).map(function (r) { var x = find(db.roles, r); return x ? x.name : r; })
    };
  }

  function projectVisible(ctx, p) {
    if (!ctx.can('project.read')) return false;
    if (ctx.can('employee.read.all')) return true;
    if (p.departmentId === ctx.employee.departmentId) return true;
    if (p.ownerId === ctx.employee.id) return true;
    return p.memberIds.indexOf(ctx.employee.id) >= 0;
  }
  function taskVisible(ctx, t) {
    if (t.assigneeIds.indexOf(ctx.employee.id) >= 0) return true;
    if (t.createdBy === ctx.employee.id) return true;
    if (!ctx.can('task.read')) return false;
    if (ctx.can('employee.read.all')) return true;
    if (t.projectId) { var pr = find(db.projects, t.projectId); if (pr && pr.departmentId === ctx.employee.departmentId) return true; }
    if (ctx.can('task.manage')) return t.assigneeIds.some(function (id) { return visibleEmployee(ctx, find(db.employees, id)); });
    return false;
  }
  function documentVisible(ctx, doc) {
    if (doc.visibility === 'all') return true;
    if (doc.visibility === 'managers') return ctx.can('document.manage') || ctx.can('employee.read.all');
    if (doc.visibility === 'department') return ctx.employee.departmentId === doc.departmentId || ctx.can('employee.read.all');
    return false;
  }
  function announcementVisible(ctx, a) {
    if (a.audience === 'all') return true;
    if (a.audience === ctx.employee.departmentId) return true;
    return ctx.can('employee.read.all');
  }
  function procurementVisible(ctx, r) {
    if (r.requesterId === ctx.employee.id) return true;
    if (ctx.can('procurement.read.all')) return true;
    if (ctx.can('procurement.approve')) return visibleEmployee(ctx, find(db.employees, r.requesterId));
    return false;
  }
  function expenseVisible(ctx, e) {
    if (e.requesterId === ctx.employee.id) return true;
    if (ctx.can('expense.read.all')) return true;
    if (ctx.can('expense.approve')) return visibleEmployee(ctx, find(db.employees, e.requesterId));
    return false;
  }

  // Record-level scope: can this actor see this employee?
  function visibleEmployee(ctx, emp) {
    if (!emp) return false;
    if (ctx.can('employee.read.all')) return true;
    if (emp.id === ctx.employee.id) return true;
    if (ctx.can('attendance.read.all') || ctx.can('leave.read.all') || ctx.can('task.manage')) {
      if (emp.departmentId === ctx.employee.departmentId) return true;
      if (emp.managerId === ctx.employee.id) return true;
      // whole reporting subtree
      var cur = emp, guard = 0;
      while (cur && cur.managerId && guard++ < 12) {
        if (cur.managerId === ctx.employee.id) return true;
        cur = find(db.employees, cur.managerId);
      }
    }
    return false;
  }

  // ── errors / validation ───────────────────────────────────────────────────
  function fail(code, message) { var e = new Error(message); e.code = code; throw e; }
  function require_(ctx, perm) { if (!ctx.can(perm)) fail('forbidden', 'Your role does not allow this action (' + perm + ').'); }
  var V = {
    text: function (v, label, max) { v = (v == null ? '' : String(v)).trim(); if (!v) fail('invalid', label + ' is required.'); if (max && v.length > max) fail('invalid', label + ' must be under ' + max + ' characters.'); return v; },
    email: function (v) { v = V.text(v, 'Email'); if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v)) fail('invalid', 'Enter a valid email address.'); return v.toLowerCase(); },
    date: function (v, label) { v = V.text(v, label); if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) fail('invalid', label + ' must be a valid date.'); return v; },
    oneOf: function (v, opts, label) { if (opts.indexOf(v) < 0) fail('invalid', label + ' is not a valid option.'); return v; }
  };

  function audit(ctx, action, entity, entityId, summary, meta) {
    db.auditLogs.unshift({
      id: Crypto.id('al'), at: new Date().toISOString(),
      actorUserId: ctx ? ctx.user.id : 'system',
      actorName: ctx && ctx.employee ? ctx.employee.firstName + ' ' + ctx.employee.lastName : 'System',
      action: action, entity: entity, entityId: entityId, summary: summary, meta: meta || null
    });
    if (db.auditLogs.length > 500) db.auditLogs.length = 500;
  }

  function notify(employeeId, title, body, link) {
    db.notifications.unshift({ id: Crypto.id('nt'), employeeId: employeeId, title: title, body: body, link: link || null, at: new Date().toISOString(), read: false });
  }

  function businessDays(a, b) {
    var s = new Date(a + 'T00:00'), e = new Date(b + 'T00:00'), n = 0;
    if (e < s) return 0;
    while (s <= e) { if (s.getDay() !== 0) n++; s = new Date(s.getTime() + 86400000); }
    return n;
  }

  function addDays(iso, n) { return new Date(new Date(iso + 'T00:00').getTime() + n * 86400000).toISOString().slice(0, 10); }

  function buildLineItems(rawItems) {
    var arr = Array.isArray(rawItems) ? rawItems : [];
    if (!arr.length) fail('invalid', 'Add at least one line item.');
    return arr.map(function (it) {
      var qty = Math.max(0.01, Number(it.qty) || 0), price = Math.max(0, Number(it.unitPrice) || 0);
      return {
        description: V.text(it.description, 'Item description', 160), qty: qty, unit: it.unit || 'each', unitPrice: price,
        discount: Math.max(0, Number(it.discount) || 0), discountType: it.discountType === 'percent' ? 'percent' : 'fixed',
        taxRate: Math.max(0, Number(it.taxRate) || 0)
      };
    });
  }

  function computeDocTotals(items, docDiscount, docTaxRate) {
    var subtotal = 0, discountTotal = 0, taxTotal = 0;
    items.forEach(function (it) {
      var line = it.qty * it.unitPrice;
      var lineDiscount = it.discountType === 'percent' ? line * (it.discount || 0) / 100 : (it.discount || 0);
      var afterDiscount = Math.max(0, line - lineDiscount);
      var lineTax = afterDiscount * (it.taxRate || 0) / 100;
      subtotal += line; discountTotal += lineDiscount; taxTotal += lineTax;
    });
    var docDiscountAmt = 0;
    if (docDiscount && docDiscount.value) docDiscountAmt = docDiscount.type === 'percent' ? (subtotal - discountTotal) * docDiscount.value / 100 : docDiscount.value;
    discountTotal += docDiscountAmt;
    var docTaxAmt = docTaxRate ? Math.max(0, subtotal - discountTotal) * docTaxRate / 100 : 0;
    taxTotal += docTaxAmt;
    var grandTotal = Math.max(0, subtotal - discountTotal) + taxTotal;
    return {
      subtotal: Math.round(subtotal * 100) / 100, discountTotal: Math.round(discountTotal * 100) / 100,
      taxTotal: Math.round(taxTotal * 100) / 100, grandTotal: Math.round(grandTotal * 100) / 100
    };
  }

  function nextDocNumber(kind) {
    var cfg = db.settings.commercial.numbering[kind];
    var year = new Date().getFullYear();
    var seq = String(cfg.nextNumber).padStart(cfg.padding, '0');
    cfg.nextNumber++;
    return cfg.prefix + '-' + (cfg.includeYear ? year + '-' : '') + seq;
  }

  function autoExpireQuotations() {
    var t = todayISO(); var changed = false;
    db.quotations.forEach(function (q) {
      if (['draft', 'sent', 'viewed'].indexOf(q.status) >= 0 && q.validUntil < t) { q.status = 'expired'; changed = true; }
    });
    if (changed) commit();
  }

  // ── API (the server boundary) ─────────────────────────────────────────────
  var handlers = {

    'auth.login': function (_ctx, p) {
      var email = String(p.email || '').trim().toLowerCase();
      var user = db.users.filter(function (u) { return u.email === email; })[0];
      if (!user || !Crypto.verify(String(p.password || ''), user.passwordHash)) fail('auth', 'Incorrect email or password.');
      if (user.status !== 'active') fail('auth', 'This account is disabled. Contact HR.');
      user.lastLoginAt = new Date().toISOString();
      var session = { userId: user.id, at: user.lastLoginAt, token: Crypto.id('tok') };
      Storage.writeSession(session);
      audit(ctxFor(user), 'auth.login', 'user', user.id, 'Signed in.');
      commit();
      return session;
    },
    'auth.logout': function (ctx) { audit(ctx, 'auth.logout', 'user', ctx.user.id, 'Signed out.'); Storage.writeSession(null); commit(); return true; },

    'me.summary': function (ctx) {
      var t = todayISO();
      var today = db.attendance.filter(function (a) { return a.employeeId === ctx.employee.id && a.date === t; })[0] || null;
      var bal = db.leaveBalances.filter(function (b) { return b.employeeId === ctx.employee.id && b.year === new Date().getFullYear(); });
      return {
        employee: ctx.employee, roleNames: ctx.roleNames, permissions: ctx.permissions,
        todayAttendance: today,
        balances: bal.map(function (b) { var t2 = find(db.leaveTypes, b.leaveTypeId); return { name: t2 ? t2.name : b.leaveTypeId, entitled: b.entitled, used: b.used, left: b.entitled - b.used }; }),
        myLeave: db.leaveRequests.filter(function (l) { return l.employeeId === ctx.employee.id; })
      };
    },

    'employees.list': function (ctx, p) {
      require_(ctx, 'employee.read');
      var q = (p && p.q || '').toLowerCase();
      return db.employees.filter(function (e) { return visibleEmployee(ctx, e); })
        .filter(function (e) { return (p && p.includeTerminated) || e.status !== 'terminated'; })
        .filter(function (e) {
          if (p && p.departmentId && e.departmentId !== p.departmentId) return false;
          if (!q) return true;
          return (e.firstName + ' ' + e.lastName + ' ' + e.code + ' ' + e.positionTitle + ' ' + e.email).toLowerCase().indexOf(q) >= 0;
        });
    },
    'employees.get': function (ctx, p) {
      require_(ctx, 'employee.read');
      var e = find(db.employees, p.id);
      if (!visibleEmployee(ctx, e)) fail('forbidden', 'You do not have access to that employee record.');
      return e;
    },
    'employees.create': function (ctx, p) {
      require_(ctx, 'employee.write');
      var e = {
        id: Crypto.id('e'), code: 'BPL-' + String(db.employees.length + 1).padStart(3, '0'),
        firstName: V.text(p.firstName, 'First name', 40), lastName: V.text(p.lastName, 'Last name', 40),
        email: V.email(p.email), phone: (p.phone || '').trim(),
        departmentId: V.oneOf(p.departmentId, db.departments.map(function (d) { return d.id; }), 'Department'),
        positionTitle: V.text(p.positionTitle, 'Job title', 60),
        managerId: p.managerId || null,
        employmentType: V.oneOf(p.employmentType || 'permanent', ['permanent', 'contract', 'casual', 'intern'], 'Employment type'),
        hireDate: V.date(p.hireDate || todayISO(), 'Hire date'), status: 'active',
        location: p.location || db.settings.plants[0], shift: p.shift || 'Day · 08:00–17:00'
      };
      if (db.employees.some(function (x) { return x.email === e.email; })) fail('invalid', 'That email is already in use.');
      db.employees.push(e);
      db.leaveTypes.forEach(function (t) { db.leaveBalances.push({ id: Crypto.id('lb'), employeeId: e.id, leaveTypeId: t.id, year: new Date().getFullYear(), entitled: t.daysPerYear, used: 0 }); });
      if (p.createAccount) {
        db.users.push({ id: Crypto.id('u'), employeeId: e.id, email: e.email, passwordHash: Crypto.hash('bamboo123'), roleIds: [p.roleId || 'r_emp'], status: 'active', lastLoginAt: null, mustChangePassword: true });
        audit(ctx, 'user.create', 'user', e.id, 'Created a login for ' + e.firstName + ' ' + e.lastName + '.');
      }
      audit(ctx, 'employee.create', 'employee', e.id, 'Added employee ' + e.code + ' — ' + e.firstName + ' ' + e.lastName + '.');
      commit(); return e;
    },
    'employees.update': function (ctx, p) {
      require_(ctx, 'employee.write');
      var e = find(db.employees, p.id); if (!e) fail('notfound', 'Employee not found.');
      var changed = [];
      ['firstName', 'lastName', 'phone', 'positionTitle', 'departmentId', 'managerId', 'employmentType', 'location', 'shift', 'status'].forEach(function (k) {
        if (p[k] !== undefined && p[k] !== e[k]) { changed.push(k); e[k] = p[k]; }
      });
      if (p.email !== undefined) { var em = V.email(p.email); if (em !== e.email) { changed.push('email'); e.email = em; } }
      audit(ctx, 'employee.update', 'employee', e.id, 'Updated ' + e.firstName + ' ' + e.lastName + ' (' + (changed.join(', ') || 'no change') + ').');
      commit(); return e;
    },
    'employees.terminate': function (ctx, p) {
      require_(ctx, 'employee.write');
      var e = find(db.employees, p.id); if (!e) fail('notfound', 'Employee not found.');
      if (e.id === ctx.employee.id) fail('forbidden', 'You cannot terminate your own employee record.');
      if (e.status === 'terminated') fail('conflict', 'This employee is already terminated.');
      e.status = 'terminated';
      var u = db.users.filter(function (x) { return x.employeeId === e.id; })[0];
      if (u) u.status = 'disabled';
      audit(ctx, 'employee.terminate', 'employee', e.id, 'Terminated ' + e.firstName + ' ' + e.lastName + ' — ' + (p.reason || 'no reason given') + '.');
      commit(); return e;
    },
    'employees.purgeTerminated': function (ctx) {
      require_(ctx, 'role.manage');
      var toRemove = db.employees.filter(function (e) { return e.status === 'terminated'; });
      var ids = toRemove.map(function (e) { return e.id; });
      if (!toRemove.length) fail('conflict', 'There are no terminated employees to remove.');
      db.employees = db.employees.filter(function (e) { return e.status !== 'terminated'; });
      db.users = db.users.filter(function (u) { return ids.indexOf(u.employeeId) < 0; });
      audit(ctx, 'employee.purge', 'employee', '-', 'Permanently removed ' + toRemove.length + ' terminated employee record(s): ' + toRemove.map(function (e) { return e.firstName + ' ' + e.lastName; }).join(', ') + '.');
      commit(); return { removed: toRemove.length };
    },

    'departments.list': function (ctx) {
      require_(ctx, 'employee.read');
      return db.departments.map(function (d) {
        var mgr = find(db.employees, d.managerId);
        return {
          id: d.id, code: d.code, name: d.name, status: d.status,
          managerName: mgr ? mgr.firstName + ' ' + mgr.lastName : '—',
          headcount: db.employees.filter(function (e) { return e.departmentId === d.id && e.status === 'active'; }).length
        };
      });
    },
    'departments.save': function (ctx, p) {
      require_(ctx, 'department.manage');
      var d = p.id ? find(db.departments, p.id) : null;
      var name = V.text(p.name, 'Department name', 60), code = V.text(p.code, 'Code', 5).toUpperCase();
      if (!d) { d = { id: Crypto.id('d'), status: 'active', parentId: null }; db.departments.push(d); }
      d.name = name; d.code = code; d.managerId = p.managerId || null;
      audit(ctx, 'department.save', 'department', d.id, 'Saved department ' + d.code + ' — ' + d.name + '.');
      commit(); return d;
    },
    'departments.delete': function (ctx, p) {
      require_(ctx, 'department.manage');
      var d = find(db.departments, p.id); if (!d) fail('notfound', 'Department not found.');
      var headcount = db.employees.filter(function (e) { return e.departmentId === d.id && e.status !== 'terminated'; }).length;
      if (headcount > 0) fail('conflict', 'Cannot delete ' + d.name + ' — ' + headcount + ' employee(s) are still assigned to it. Reassign them first.');
      db.departments = db.departments.filter(function (x) { return x.id !== d.id; });
      audit(ctx, 'department.delete', 'department', p.id, 'Deleted department ' + d.code + ' — ' + d.name + '.');
      commit(); return true;
    },

    'roles.list': function (ctx) { require_(ctx, 'employee.read'); return db.roles.map(function (r) { return Object.assign({}, r, { userCount: db.users.filter(function (u) { return u.roleIds.indexOf(r.id) >= 0; }).length }); }); },
    'roles.permissionCatalogue': function () { return PERMISSIONS; },
    'roles.setPermission': function (ctx, p) {
      require_(ctx, 'role.manage');
      var r = find(db.roles, p.roleId); if (!r) fail('notfound', 'Role not found.');
      if (r.key === 'administrator') fail('forbidden', 'The System Administrator role is locked — it must always retain full access.');
      var i = r.permissions.indexOf(p.permission);
      if (p.on && i < 0) r.permissions.push(p.permission);
      if (!p.on && i >= 0) r.permissions.splice(i, 1);
      audit(ctx, 'role.permission', 'role', r.id, (p.on ? 'Granted ' : 'Revoked ') + p.permission + ' ' + (p.on ? 'to ' : 'from ') + r.name + '.');
      commit(); return r;
    },
    'users.list': function (ctx) {
      require_(ctx, 'user.manage');
      return db.users.map(function (u) {
        var e = find(db.employees, u.employeeId);
        return { id: u.id, email: u.email, status: u.status, lastLoginAt: u.lastLoginAt, name: e ? e.firstName + ' ' + e.lastName : '—', roleNames: u.roleIds.map(function (r) { var x = find(db.roles, r); return x ? x.name : r; }), roleIds: u.roleIds };
      });
    },
    'users.setRole': function (ctx, p) {
      require_(ctx, 'user.manage');
      var u = find(db.users, p.userId); if (!u) fail('notfound', 'Account not found.');
      if (u.id === ctx.user.id) fail('forbidden', 'You cannot change your own role.');
      if (!find(db.roles, p.roleId)) fail('invalid', 'Unknown role.');
      u.roleIds = [p.roleId];
      audit(ctx, 'user.setRole', 'user', u.id, 'Set role of ' + u.email + ' to ' + find(db.roles, p.roleId).name + '.');
      commit(); return u;
    },
    'users.setStatus': function (ctx, p) {
      require_(ctx, 'user.manage');
      var u = find(db.users, p.userId); if (!u) fail('notfound', 'Account not found.');
      if (u.id === ctx.user.id) fail('forbidden', 'You cannot disable your own account.');
      u.status = V.oneOf(p.status, ['active', 'disabled'], 'Status');
      audit(ctx, 'user.setStatus', 'user', u.id, u.email + ' account ' + u.status + '.');
      commit(); return u;
    },

    'attendance.clockIn': function (ctx) {
      require_(ctx, 'attendance.self');
      var t = todayISO(), now = new Date().toTimeString().slice(0, 5);
      if (db.attendance.some(function (a) { return a.employeeId === ctx.employee.id && a.date === t; })) fail('conflict', 'You have already clocked in today.');
      var rec = { id: Crypto.id('at'), employeeId: ctx.employee.id, date: t, clockIn: now, clockOut: null, status: now > db.settings.lateAfter ? 'late' : 'present', source: 'web', note: '', adjustedBy: null };
      db.attendance.push(rec);
      audit(ctx, 'attendance.clockIn', 'attendance', rec.id, 'Clocked in at ' + now + (rec.status === 'late' ? ' (late).' : '.'));
      commit(); return rec;
    },
    'attendance.clockOut': function (ctx) {
      require_(ctx, 'attendance.self');
      var t = todayISO();
      var rec = db.attendance.filter(function (a) { return a.employeeId === ctx.employee.id && a.date === t; })[0];
      if (!rec) fail('conflict', 'You have not clocked in today.');
      if (rec.clockOut) fail('conflict', 'You have already clocked out today.');
      rec.clockOut = new Date().toTimeString().slice(0, 5);
      audit(ctx, 'attendance.clockOut', 'attendance', rec.id, 'Clocked out at ' + rec.clockOut + '.');
      commit(); return rec;
    },
    'attendance.list': function (ctx, p) {
      var date = (p && p.date) || todayISO();
      var mine = !ctx.can('attendance.read.all');
      var rows = db.attendance.filter(function (a) { return a.date === date; }).filter(function (a) {
        if (mine) return a.employeeId === ctx.employee.id;
        return visibleEmployee(ctx, find(db.employees, a.employeeId));
      });
      var scope = mine ? [ctx.employee] : db.employees.filter(function (e) { return visibleEmployee(ctx, e); });
      var byEmp = {}; rows.forEach(function (r) { byEmp[r.employeeId] = r; });
      return {
        date: date, scopeSize: scope.length,
        rows: scope.map(function (e) {
          var r = byEmp[e.id], d = find(db.departments, e.departmentId);
          return {
            id: r ? r.id : 'none_' + e.id, employeeId: e.id, name: e.firstName + ' ' + e.lastName, code: e.code,
            department: d ? d.name : '—', clockIn: r ? r.clockIn : null, clockOut: r ? r.clockOut : null,
            status: r ? r.status : 'absent', note: r ? r.note : ''
          };
        })
      };
    },
    'attendance.adjust': function (ctx, p) {
      require_(ctx, 'attendance.adjust');
      var rec = find(db.attendance, p.id);
      if (!rec) {
        var emp = find(db.employees, p.employeeId); if (!emp) fail('notfound', 'Employee not found.');
        rec = { id: Crypto.id('at'), employeeId: emp.id, date: V.date(p.date, 'Date'), clockIn: null, clockOut: null, status: 'present', source: 'adjustment', note: '', adjustedBy: null };
        db.attendance.push(rec);
      }
      if (p.clockIn !== undefined) rec.clockIn = p.clockIn || null;
      if (p.clockOut !== undefined) rec.clockOut = p.clockOut || null;
      if (p.status) rec.status = V.oneOf(p.status, ['present', 'late', 'absent', 'leave', 'off'], 'Status');
      rec.note = V.text(p.note, 'Reason for the correction', 200);
      rec.adjustedBy = ctx.employee.id;
      audit(ctx, 'attendance.adjust', 'attendance', rec.id, 'Corrected attendance for ' + rec.date + ': ' + rec.note);
      commit(); return rec;
    },
    'attendance.delete': function (ctx, p) {
      require_(ctx, 'attendance.adjust');
      var rec = find(db.attendance, p.id); if (!rec) fail('notfound', 'Attendance record not found.');
      db.attendance = db.attendance.filter(function (x) { return x.id !== rec.id; });
      audit(ctx, 'attendance.delete', 'attendance', p.id, 'Deleted attendance record for ' + rec.date + '.');
      commit(); return true;
    },

    'leave.types': function () { return db.leaveTypes; },
    'leave.list': function (ctx, p) {
      var all = ctx.can('leave.read.all');
      return db.leaveRequests.filter(function (l) {
        if (!all) return l.employeeId === ctx.employee.id;
        return l.employeeId === ctx.employee.id || visibleEmployee(ctx, find(db.employees, l.employeeId));
      }).filter(function (l) { return !p || !p.status || p.status === 'all' || l.status === p.status; })
        .map(function (l) {
          var e = find(db.employees, l.employeeId), t = find(db.leaveTypes, l.leaveTypeId), d = e && find(db.departments, e.departmentId);
          return Object.assign({}, l, { employeeName: e ? e.firstName + ' ' + e.lastName : '—', department: d ? d.name : '—', typeName: t ? t.name : '—' });
        }).sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
    },
    'leave.request': function (ctx, p) {
      require_(ctx, 'leave.request');
      var start = V.date(p.startDate, 'Start date'), end = V.date(p.endDate, 'End date');
      if (end < start) fail('invalid', 'The end date cannot be before the start date.');
      var type = find(db.leaveTypes, p.leaveTypeId); if (!type) fail('invalid', 'Choose a leave type.');
      var days = businessDays(start, end);
      if (db.leaveRequests.some(function (l) { return l.employeeId === ctx.employee.id && l.status !== 'rejected' && l.status !== 'cancelled' && !(l.endDate < start || l.startDate > end); }))
        fail('conflict', 'You already have a leave request covering those dates.');
      var bal = db.leaveBalances.filter(function (b) { return b.employeeId === ctx.employee.id && b.leaveTypeId === type.id && b.year === new Date().getFullYear(); })[0];
      if (bal && type.daysPerYear > 0 && days > bal.entitled - bal.used) fail('invalid', 'That exceeds your remaining ' + type.name.toLowerCase() + ' (' + (bal.entitled - bal.used) + ' days left).');
      var req = { id: Crypto.id('lr'), employeeId: ctx.employee.id, leaveTypeId: type.id, startDate: start, endDate: end, days: days, reason: V.text(p.reason, 'Reason', 300), status: 'pending', createdAt: new Date().toISOString().slice(0, 16), decidedBy: null, decidedAt: null, decisionNote: '' };
      db.leaveRequests.push(req);
      db.approvals.push({ id: Crypto.id('ap'), subjectType: 'leave_request', subjectId: req.id, title: 'Leave request', requestedBy: ctx.employee.id, assigneePermission: 'leave.approve', departmentId: ctx.employee.departmentId, status: 'pending', createdAt: req.createdAt, decidedBy: null, decidedAt: null, comment: '' });
      if (ctx.employee.managerId) notify(ctx.employee.managerId, 'Leave request to approve', ctx.employee.firstName + ' ' + ctx.employee.lastName + ' requested ' + days + ' day(s) of ' + type.name.toLowerCase() + '.', 'approvals');
      audit(ctx, 'leave.request', 'leave_request', req.id, 'Requested ' + days + ' day(s) of ' + type.name.toLowerCase() + ' (' + start + ' → ' + end + ').');
      commit(); return req;
    },
    'leave.decide': function (ctx, p) {
      require_(ctx, 'leave.approve');
      var req = find(db.leaveRequests, p.id); if (!req) fail('notfound', 'Request not found.');
      if (req.status !== 'pending') fail('conflict', 'That request has already been decided.');
      var emp = find(db.employees, req.employeeId);
      if (!visibleEmployee(ctx, emp)) fail('forbidden', 'That request is outside the people you are responsible for.');
      if (emp.id === ctx.employee.id) fail('forbidden', 'You cannot approve your own leave.');
      var decision = V.oneOf(p.decision, ['approved', 'rejected'], 'Decision');
      req.status = decision; req.decidedBy = ctx.employee.id; req.decidedAt = new Date().toISOString().slice(0, 16);
      req.decisionNote = (p.note || '').trim();
      if (decision === 'approved') {
        var bal = db.leaveBalances.filter(function (b) { return b.employeeId === req.employeeId && b.leaveTypeId === req.leaveTypeId && b.year === new Date().getFullYear(); })[0];
        if (bal) bal.used += req.days;
      }
      db.approvals.forEach(function (a) {
        if (a.subjectType === 'leave_request' && a.subjectId === req.id && a.status === 'pending') {
          a.status = decision; a.decidedBy = ctx.employee.id; a.decidedAt = req.decidedAt; a.comment = req.decisionNote;
        }
      });
      notify(req.employeeId, 'Leave ' + decision, 'Your leave request for ' + req.startDate + ' → ' + req.endDate + ' was ' + decision + '.', 'leave');
      audit(ctx, 'leave.decide', 'leave_request', req.id, decision.charAt(0).toUpperCase() + decision.slice(1) + ' ' + emp.firstName + ' ' + emp.lastName + '’s leave (' + req.days + ' day(s)).');
      commit(); return req;
    },
    'leave.cancel': function (ctx, p) {
      var req = find(db.leaveRequests, p.id); if (!req) fail('notfound', 'Request not found.');
      if (req.employeeId !== ctx.employee.id) fail('forbidden', 'You can only cancel your own request.');
      if (req.status !== 'pending') fail('conflict', 'Only a pending request can be cancelled.');
      req.status = 'cancelled';
      db.approvals.forEach(function (a) { if (a.subjectId === req.id && a.status === 'pending') a.status = 'cancelled'; });
      audit(ctx, 'leave.cancel', 'leave_request', req.id, 'Cancelled own leave request.');
      commit(); return req;
    },

    'approvals.queue': function (ctx) {
      require_(ctx, 'approval.act');
      return db.approvals.filter(function (a) { return a.status === 'pending'; })
        .filter(function (a) { return ctx.can(a.assigneePermission) && visibleEmployee(ctx, find(db.employees, a.requestedBy)) && a.requestedBy !== ctx.employee.id; })
        .map(function (a) {
          var e = find(db.employees, a.requestedBy);
          if (a.subjectType === 'procurement_request') {
            var pr = find(db.procurementRequests, a.subjectId);
            return { id: a.id, subjectId: a.subjectId, subjectType: a.subjectType, title: a.title, createdAt: a.createdAt, requesterName: e ? e.firstName + ' ' + e.lastName : '—', requesterRole: e ? e.positionTitle : '', detail: pr ? pr.item + ' × ' + pr.quantity + ' · est. GHS ' + pr.estimatedPrice.toLocaleString() : '', reason: pr ? pr.reason : '' };
          }
          if (a.subjectType === 'expense') {
            var ex = find(db.expenses, a.subjectId);
            return { id: a.id, subjectId: a.subjectId, subjectType: a.subjectType, title: a.title, createdAt: a.createdAt, requesterName: e ? e.firstName + ' ' + e.lastName : '—', requesterRole: e ? e.positionTitle : '', detail: ex ? ex.category + ' · GHS ' + ex.amount.toLocaleString() + ' · ' + ex.date : '', reason: ex ? ex.description : '' };
          }
          var subj = find(db.leaveRequests, a.subjectId), t = subj && find(db.leaveTypes, subj.leaveTypeId);
          return {
            id: a.id, subjectId: a.subjectId, subjectType: a.subjectType, title: a.title, createdAt: a.createdAt,
            requesterName: e ? e.firstName + ' ' + e.lastName : '—', requesterRole: e ? e.positionTitle : '',
            detail: subj ? (t ? t.name : 'Leave') + ' · ' + subj.days + ' day(s) · ' + subj.startDate + ' → ' + subj.endDate : '',
            reason: subj ? subj.reason : ''
          };
        });
    },

    'notifications.mine': function (ctx) { return db.notifications.filter(function (n) { return n.employeeId === ctx.employee.id; }); },
    'notifications.markRead': function (ctx, p) {
      db.notifications.forEach(function (n) { if (n.employeeId === ctx.employee.id && (!p || !p.id || n.id === p.id)) n.read = true; });
      commit(); return true;
    },

    'messages.inbox': function (ctx) {
      var mine = ctx.employee.id;
      var mine_msgs = db.messages.filter(function (m) { return m.fromId === mine || m.toId === mine; });
      var byPeer = {};
      mine_msgs.forEach(function (m) {
        var peerId = m.fromId === mine ? m.toId : m.fromId;
        if (!byPeer[peerId] || byPeer[peerId].at < m.at) byPeer[peerId] = m;
      });
      return Object.keys(byPeer).map(function (peerId) {
        var emp = find(db.employees, peerId), last = byPeer[peerId];
        var unread = db.messages.filter(function (m) { return m.fromId === peerId && m.toId === mine && !m.read; }).length;
        return {
          peerId: peerId, peerName: emp ? emp.firstName + ' ' + emp.lastName : '\u2014', peerTitle: emp ? emp.positionTitle : '',
          lastBody: last.body, lastAt: last.at, lastFromMe: last.fromId === mine, unread: unread
        };
      }).sort(function (a, b) { return a.lastAt < b.lastAt ? 1 : -1; });
    },
    'messages.directory': function (ctx) {
      return db.employees.filter(function (e) { return e.status === 'active' && e.id !== ctx.employee.id; })
        .map(function (e) { return { id: e.id, name: e.firstName + ' ' + e.lastName, title: e.positionTitle }; })
        .sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    },
    'messages.thread': function (ctx, p) {
      var mine = ctx.employee.id, peerId = p.peerId;
      var peer = find(db.employees, peerId); if (!peer) fail('notfound', 'Employee not found.');
      var thread = db.messages.filter(function (m) { return (m.fromId === mine && m.toId === peerId) || (m.fromId === peerId && m.toId === mine); })
        .sort(function (a, b) { return a.at < b.at ? -1 : 1; });
      thread.forEach(function (m) { if (m.toId === mine && !m.read) m.read = true; });
      commit();
      return { peerId: peer.id, peerName: peer.firstName + ' ' + peer.lastName, peerTitle: peer.positionTitle, messages: thread.map(function (m) { return { id: m.id, fromMe: m.fromId === mine, body: m.body, at: m.at }; }) };
    },
    'messages.send': function (ctx, p) {
      var toId = p.toId; var peer = find(db.employees, toId); if (!peer) fail('invalid', 'Choose a recipient.');
      if (toId === ctx.employee.id) fail('invalid', 'You cannot message yourself.');
      var body = V.text(p.body, 'Message', 2000);
      var msg = { id: Crypto.id('msg'), fromId: ctx.employee.id, toId: toId, body: body, at: new Date().toISOString(), read: false };
      db.messages.push(msg);
      notify(toId, 'New message from ' + ctx.employee.firstName + ' ' + ctx.employee.lastName, body.slice(0, 140), 'message:' + ctx.employee.id);
      audit(ctx, 'message.send', 'message', msg.id, 'Sent a message to ' + peer.firstName + ' ' + peer.lastName + '.');
      commit(); return msg;
    },
    'messages.unreadCount': function (ctx) {
      return db.messages.filter(function (m) { return m.toId === ctx.employee.id && !m.read; }).length;
    },

    'audit.list': function (ctx, p) {
      require_(ctx, 'audit.read');
      var q = (p && p.q || '').toLowerCase();
      return db.auditLogs.filter(function (l) { return !q || (l.action + ' ' + l.summary + ' ' + (l.actorName || '')).toLowerCase().indexOf(q) >= 0; }).slice(0, 120);
    },

    'settings.get': function (ctx) { require_(ctx, 'employee.read'); return db.settings; },
    'integrations.list': function (ctx) { require_(ctx, 'settings.manage'); return db.settings.integrations; },
    'integrations.connect': function (ctx, p) {
      require_(ctx, 'settings.manage');
      var i = (db.settings.integrations || []).filter(function (x) { return x.id === p.id; })[0]; if (!i) fail('notfound', 'Integration not found.');
      i.apiKey = V.text(p.apiKey, 'API key', 200);
      i.connected = true;
      audit(ctx, 'integration.connect', 'integration', i.id, 'Connected ' + i.name + '.');
      commit(); return i;
    },
    'integrations.disconnect': function (ctx, p) {
      require_(ctx, 'settings.manage');
      var i = (db.settings.integrations || []).filter(function (x) { return x.id === p.id; })[0]; if (!i) fail('notfound', 'Integration not found.');
      i.connected = false; i.apiKey = '';
      audit(ctx, 'integration.disconnect', 'integration', i.id, 'Disconnected ' + i.name + '.');
      commit(); return i;
    },
    'settings.save': function (ctx, p) {
      require_(ctx, 'settings.manage');
      ['companyName', 'shortName', 'country', 'currency', 'timezone', 'workWeek', 'lateAfter'].forEach(function (k) { if (p[k] !== undefined) db.settings[k] = V.text(p[k], k, 60); });
      if (p.standardHours !== undefined) db.settings.standardHours = Math.max(1, Math.min(12, Number(p.standardHours) || 8));
      audit(ctx, 'settings.save', 'settings', 'company', 'Updated company settings.');
      commit(); return db.settings;
    },

    'dashboard.load': function (ctx) {
      var t = todayISO();
      var visible = db.employees.filter(function (e) { return visibleEmployee(ctx, e); });
      var att = db.attendance.filter(function (a) { return a.date === t; });
      var ids = {}; visible.forEach(function (e) { ids[e.id] = true; });
      var inToday = att.filter(function (a) { return ids[a.employeeId]; });
      var pendingLeave = db.leaveRequests.filter(function (l) { return l.status === 'pending' && ids[l.employeeId]; });
      var queue = ctx.can('approval.act') ? handlers['approvals.queue'](ctx) : [];
      return {
        headcount: visible.length,
        presentToday: inToday.filter(function (a) { return a.status !== 'absent'; }).length,
        lateToday: inToday.filter(function (a) { return a.status === 'late'; }).length,
        notClockedIn: Math.max(0, visible.length - inToday.length),
        onLeaveToday: db.leaveRequests.filter(function (l) { return l.status === 'approved' && l.startDate <= t && l.endDate >= t && ids[l.employeeId]; }).length,
        pendingLeave: pendingLeave.length,
        approvalQueue: queue.length,
        departments: db.departments.map(function (d) {
          var people = visible.filter(function (e) { return e.departmentId === d.id; });
          var present = inToday.filter(function (a) { var e = find(db.employees, a.employeeId); return e && e.departmentId === d.id && a.status !== 'absent'; }).length;
          return { name: d.name, code: d.code, headcount: people.length, present: present, rate: people.length ? Math.round((present / people.length) * 100) : 0 };
        }).filter(function (d) { return d.headcount > 0; }),
        recentAudit: ctx.can('audit.read') ? db.auditLogs.slice(0, 6) : [],
        myOpenTasks: db.tasks.filter(function (t) { return t.assigneeIds.indexOf(ctx.employee.id) >= 0 && ['completed', 'cancelled'].indexOf(t.status) < 0; }).length,
        latestAnnouncement: (function () { var a = db.announcements.filter(function (a) { return announcementVisible(ctx, a); }).sort(function (a, b) { return a.publishedAt < b.publishedAt ? 1 : -1; })[0]; return a ? a.title : null; })(),
        lowStockCount: ctx.can('inventory.read') ? db.products.filter(function (p) { return p.currentStock <= p.reorderLevel; }).length : null,
        pendingProcurement: ctx.can('procurement.read.all') ? db.procurementRequests.filter(function (p) { return p.status === 'pending'; }).length : null,
        assetsDueService: ctx.can('asset.read') ? db.assets.filter(function (a) { return a.nextServiceDate && a.nextServiceDate <= (new Date(Date.now() + 7 * 86400000)).toISOString().slice(0, 10); }).length : null,
        outstandingInvoices: ctx.can('invoice.read') ? db.invoices.filter(function (i) { return i.status !== 'paid'; }).reduce(function (s, i) { return s + i.amount; }, 0) : null,
        pendingExpenses: ctx.can('expense.read.all') ? db.expenses.filter(function (e) { return e.status === 'pending'; }).length : null
      };
    },

    'projects.list': function (ctx) {
      require_(ctx, 'project.read');
      return db.projects.filter(function (p) { return projectVisible(ctx, p); }).map(function (p) {
        var owner = find(db.employees, p.ownerId), dept = find(db.departments, p.departmentId);
        var pt = db.tasks.filter(function (t) { return t.projectId === p.id; });
        return Object.assign({}, p, { ownerName: owner ? owner.firstName + ' ' + owner.lastName : '—', departmentName: dept ? dept.name : '—', taskCount: pt.length, doneCount: pt.filter(function (t) { return t.status === 'completed'; }).length });
      });
    },
    'projects.create': function (ctx, p) {
      require_(ctx, 'project.manage');
      var proj = {
        id: Crypto.id('pj'), code: 'PRJ-' + String(db.projects.length + 1).padStart(3, '0'),
        name: V.text(p.name, 'Project name', 80), departmentId: V.oneOf(p.departmentId, db.departments.map(function (x) { return x.id; }), 'Department'),
        ownerId: p.ownerId || ctx.employee.id, memberIds: p.memberIds || [], startDate: V.date(p.startDate || todayISO(), 'Start date'),
        deadline: V.date(p.deadline || todayISO(), 'Deadline'), status: 'planning', budget: Number(p.budget) || 0, description: (p.description || '').trim()
      };
      db.projects.push(proj);
      audit(ctx, 'project.create', 'project', proj.id, 'Created project ' + proj.code + ' — ' + proj.name + '.');
      commit(); return proj;
    },
    'projects.setStatus': function (ctx, p) {
      require_(ctx, 'project.manage');
      var proj = find(db.projects, p.id); if (!proj) fail('notfound', 'Project not found.');
      if (!projectVisible(ctx, proj)) fail('forbidden', 'Outside your scope.');
      proj.status = V.oneOf(p.status, ['planning', 'active', 'on_hold', 'delayed', 'completed', 'cancelled'], 'Status');
      audit(ctx, 'project.update', 'project', proj.id, 'Set ' + proj.code + ' to ' + proj.status + '.');
      commit(); return proj;
    },

    'tasks.list': function (ctx, p) {
      var scope = (p && p.scope) || 'mine';
      return db.tasks.filter(function (t) { return taskVisible(ctx, t); })
        .filter(function (t) { return scope !== 'mine' || t.assigneeIds.indexOf(ctx.employee.id) >= 0; })
        .filter(function (t) { return !p || !p.status || t.status === p.status; })
        .filter(function (t) { return !p || !p.q || t.title.toLowerCase().indexOf(p.q.toLowerCase()) >= 0; })
        .map(function (t) {
          var proj = t.projectId && find(db.projects, t.projectId);
          var overdue = t.dueDate < todayISO() && ['completed', 'cancelled'].indexOf(t.status) < 0;
          var daysOverdue = overdue ? Math.round((new Date(todayISO()) - new Date(t.dueDate)) / 86400000) : 0;
          return Object.assign({}, t, { projectName: proj ? proj.name : '—', assigneeNames: t.assigneeIds.map(function (id) { var e = find(db.employees, id); return e ? e.firstName + ' ' + e.lastName : '—'; }), overdue: overdue, daysOverdue: daysOverdue, commentCount: (t.comments || []).length });
        }).sort(function (a, b) { return a.dueDate < b.dueDate ? -1 : 1; });
    },
    'tasks.get': function (ctx, p) {
      var t = find(db.tasks, p.id); if (!t) fail('notfound', 'Task not found.');
      if (!taskVisible(ctx, t)) fail('forbidden', 'Outside your scope.');
      var proj = t.projectId && find(db.projects, t.projectId);
      var overdue = t.dueDate < todayISO() && ['completed', 'cancelled'].indexOf(t.status) < 0;
      var daysOverdue = overdue ? Math.round((new Date(todayISO()) - new Date(t.dueDate)) / 86400000) : 0;
      return Object.assign({}, t, {
        projectName: proj ? proj.name : '—', overdue: overdue, daysOverdue: daysOverdue,
        assigneeNames: t.assigneeIds.map(function (id) { var e = find(db.employees, id); return e ? e.firstName + ' ' + e.lastName : '—'; }),
        comments: (t.comments || []).map(function (c) { var e = find(db.employees, c.authorId); return Object.assign({}, c, { authorName: e ? e.firstName + ' ' + e.lastName : '—' }); })
      });
    },
    'tasks.create': function (ctx, p) {
      require_(ctx, 'task.manage');
      var ids = (p.assigneeIds && p.assigneeIds.length) ? p.assigneeIds : [ctx.employee.id];
      var t = {
        id: Crypto.id('tk'), title: V.text(p.title, 'Title', 100), projectId: p.projectId || null, assigneeIds: ids,
        priority: V.oneOf(p.priority || 'medium', ['low', 'medium', 'high'], 'Priority'), dueDate: V.date(p.dueDate || todayISO(), 'Due date'),
        status: 'not_started', createdBy: ctx.employee.id, createdAt: new Date().toISOString().slice(0, 16), description: (p.description || '').trim(), comments: []
      };
      db.tasks.push(t);
      ids.forEach(function (id) { if (id !== ctx.employee.id) notify(id, 'New task assigned', t.title, 'tasks'); });
      audit(ctx, 'task.create', 'task', t.id, 'Created task "' + t.title + '".');
      commit(); return t;
    },
    'tasks.setStatus': function (ctx, p) {
      var t = find(db.tasks, p.id); if (!t) fail('notfound', 'Task not found.');
      if (!taskVisible(ctx, t)) fail('forbidden', 'Outside your scope.');
      t.status = V.oneOf(p.status, ['not_started', 'in_progress', 'waiting', 'under_review', 'completed', 'cancelled'], 'Status');
      audit(ctx, 'task.status', 'task', t.id, 'Set "' + t.title + '" to ' + t.status + '.');
      commit(); return t;
    },
    'tasks.update': function (ctx, p) {
      require_(ctx, 'task.manage');
      var t = find(db.tasks, p.id); if (!t) fail('notfound', 'Task not found.');
      t.title = V.text(p.title, 'Title', 100); t.projectId = p.projectId || null;
      t.assigneeIds = (p.assigneeIds && p.assigneeIds.length) ? p.assigneeIds : t.assigneeIds;
      t.priority = V.oneOf(p.priority || t.priority, ['low', 'medium', 'high'], 'Priority');
      if (p.startedDate) { var sd = V.date(p.startedDate, 'Date started'); t.createdAt = sd + (t.createdAt || '').slice(10); }
      t.dueDate = V.date(p.dueDate || t.dueDate, 'Due date'); t.description = (p.description || '').trim();
      audit(ctx, 'task.update', 'task', t.id, 'Updated task "' + t.title + '".');
      commit(); return t;
    },
    'tasks.delete': function (ctx, p) {
      require_(ctx, 'task.manage');
      var t = find(db.tasks, p.id); if (!t) fail('notfound', 'Task not found.');
      db.tasks = db.tasks.filter(function (x) { return x.id !== t.id; });
      audit(ctx, 'task.delete', 'task', p.id, 'Deleted task "' + t.title + '".');
      commit(); return true;
    },
    'tasks.addComment': function (ctx, p) {
      var t = find(db.tasks, p.id); if (!t) fail('notfound', 'Task not found.');
      if (!taskVisible(ctx, t)) fail('forbidden', 'Outside your scope.');
      var body = V.text(p.body, 'Comment', 1000);
      var c = { id: Crypto.id('tc'), authorId: ctx.employee.id, body: body, at: new Date().toISOString() };
      if (!t.comments) t.comments = [];
      t.comments.push(c);
      t.assigneeIds.forEach(function (id) { if (id !== ctx.employee.id) notify(id, 'New comment on "' + t.title + '"', body.slice(0, 140), 'tasks'); });
      audit(ctx, 'task.comment', 'task', t.id, 'Commented on "' + t.title + '".');
      commit(); return t;
    },

    'announcements.list': function (ctx) {
      return db.announcements.filter(function (a) { return announcementVisible(ctx, a); }).map(function (a) {
        var pub = find(db.employees, a.publishedBy);
        return Object.assign({}, a, { publisherName: pub ? pub.firstName + ' ' + pub.lastName : '—' });
      }).sort(function (a, b) { if (a.pinned !== b.pinned) return a.pinned ? -1 : 1; return a.publishedAt < b.publishedAt ? 1 : -1; });
    },
    'announcements.publish': function (ctx, p) {
      require_(ctx, 'announcement.publish');
      var a = { id: Crypto.id('an'), title: V.text(p.title, 'Title', 120), body: V.text(p.body, 'Body', 2000), audience: p.audience || 'all', publishedBy: ctx.employee.id, publishedAt: new Date().toISOString().slice(0, 16), pinned: !!p.pinned };
      db.announcements.push(a);
      audit(ctx, 'announcement.publish', 'announcement', a.id, 'Published "' + a.title + '".');
      commit(); return a;
    },

    'documents.list': function (ctx) {
      require_(ctx, 'document.read');
      return db.documents.filter(function (d) { return documentVisible(ctx, d); }).map(function (d) {
        var up = find(db.employees, d.uploadedBy);
        return Object.assign({}, d, { uploaderName: up ? up.firstName + ' ' + up.lastName : '—' });
      }).sort(function (a, b) { return a.uploadedAt < b.uploadedAt ? 1 : -1; });
    },
    'documents.upload': function (ctx, p) {
      require_(ctx, 'document.manage');
      var doc = {
        id: Crypto.id('doc'), title: V.text(p.title, 'Title', 100), category: V.text(p.category, 'Category', 40),
        departmentId: p.visibility === 'department' ? ctx.employee.departmentId : null,
        visibility: V.oneOf(p.visibility || 'all', ['all', 'department', 'managers'], 'Visibility'),
        uploadedBy: ctx.employee.id, uploadedAt: todayISO(), fileName: V.text(p.fileName, 'File name', 120)
      };
      db.documents.push(doc);
      audit(ctx, 'document.upload', 'document', doc.id, 'Uploaded "' + doc.title + '".');
      commit(); return doc;
    },
    'documents.delete': function (ctx, p) {
      require_(ctx, 'document.manage');
      var i = db.documents.findIndex(function (x) { return x.id === p.id; }); if (i < 0) fail('notfound', 'Document not found.');
      var doc = db.documents[i]; db.documents.splice(i, 1);
      audit(ctx, 'document.delete', 'document', p.id, 'Removed "' + doc.title + '".');
      commit(); return true;
    },

    'employees.profile': function (ctx, p) {
      require_(ctx, 'employee.read');
      var e = find(db.employees, p.id); if (!e) fail('notfound', 'Employee not found.');
      if (!visibleEmployee(ctx, e)) fail('forbidden', 'You do not have access to that employee record.');
      var dept = find(db.departments, e.departmentId), mgr = e.managerId && find(db.employees, e.managerId);
      var att = db.attendance.filter(function (a) { return a.employeeId === e.id; }).sort(function (a, b) { return a.date < b.date ? 1 : -1; }).slice(0, 8);
      var leave = db.leaveRequests.filter(function (l) { return l.employeeId === e.id; }).map(function (l) { var t = find(db.leaveTypes, l.leaveTypeId); return Object.assign({}, l, { typeName: t ? t.name : '—' }); });
      var tasks = db.tasks.filter(function (t) { return t.assigneeIds.indexOf(e.id) >= 0; }).map(function (t) { return { id: t.id, title: t.title, status: t.status, dueDate: t.dueDate }; });
      var docs = (ctx.can('employee.read.all') || e.id === ctx.employee.id) ? db.documents.filter(function (dd) { return documentVisible(ctx, dd); }) : [];
      return { employee: e, departmentName: dept ? dept.name : '—', managerName: mgr ? mgr.firstName + ' ' + mgr.lastName : '—', attendance: att, leave: leave, tasks: tasks, documents: docs };
    },

    'warehouses.list': function (ctx) {
      require_(ctx, 'inventory.read');
      return db.warehouses.map(function (w) {
        var rawQty = db.rawBatches.filter(function (r) { return r.warehouseId === w.id; }).reduce(function (s, r) { return s + r.quantity; }, 0);
        return Object.assign({}, w, { rawQty: rawQty });
      });
    },
    'warehouses.create': function (ctx, p) {
      require_(ctx, 'warehouse.manage');
      var w = { id: Crypto.id('wh'), name: V.text(p.name, 'Warehouse name', 80), location: (p.location || '').trim(), capacity: Math.max(0, Number(p.capacity) || 0) };
      db.warehouses.push(w);
      audit(ctx, 'warehouse.create', 'warehouse', w.id, 'Added warehouse ' + w.name + '.');
      commit(); return w;
    },
    'warehouses.update': function (ctx, p) {
      require_(ctx, 'warehouse.manage');
      var w = find(db.warehouses, p.id); if (!w) fail('notfound', 'Warehouse not found.');
      w.name = V.text(p.name, 'Warehouse name', 80); w.location = (p.location || '').trim(); w.capacity = Math.max(0, Number(p.capacity) || 0);
      audit(ctx, 'warehouse.update', 'warehouse', w.id, 'Updated warehouse ' + w.name + '.');
      commit(); return w;
    },
    'warehouses.delete': function (ctx, p) {
      require_(ctx, 'warehouse.manage');
      var w = find(db.warehouses, p.id); if (!w) fail('notfound', 'Warehouse not found.');
      var inUse = db.rawBatches.some(function (r) { return r.warehouseId === w.id; }) || db.products.some(function (pr) { return pr.warehouseId === w.id; });
      if (inUse) fail('conflict', 'Cannot delete ' + w.name + ' — it has stock recorded against it.');
      db.warehouses = db.warehouses.filter(function (x) { return x.id !== w.id; });
      audit(ctx, 'warehouse.delete', 'warehouse', p.id, 'Deleted warehouse ' + w.name + '.');
      commit(); return true;
    },

    'suppliers.list': function (ctx) {
      require_(ctx, 'supplier.read');
      return db.suppliers.map(function (s) { return Object.assign({}, s, { batchCount: db.rawBatches.filter(function (r) { return r.supplierId === s.id; }).length }); });
    },
    'suppliers.create': function (ctx, p) {
      require_(ctx, 'supplier.manage');
      var s = {
        id: Crypto.id('sup'), name: V.text(p.name, 'Supplier name', 100), contactPerson: V.text(p.contactPerson, 'Contact person', 60),
        phone: (p.phone || '').trim(), email: (p.email || '').trim(), address: (p.address || '').trim(),
        materialsSupplied: V.text(p.materialsSupplied, 'Materials supplied', 200), paymentTerms: p.paymentTerms || 'Net 30', status: 'active'
      };
      db.suppliers.push(s);
      audit(ctx, 'supplier.create', 'supplier', s.id, 'Added supplier ' + s.name + '.');
      commit(); return s;
    },
    'suppliers.update': function (ctx, p) {
      require_(ctx, 'supplier.manage');
      var s = find(db.suppliers, p.id); if (!s) fail('notfound', 'Supplier not found.');
      s.name = V.text(p.name, 'Supplier name', 100); s.contactPerson = V.text(p.contactPerson, 'Contact person', 60);
      s.phone = (p.phone || '').trim(); s.email = (p.email || '').trim(); s.address = (p.address || '').trim();
      s.materialsSupplied = V.text(p.materialsSupplied, 'Materials supplied', 200); s.paymentTerms = p.paymentTerms || s.paymentTerms;
      audit(ctx, 'supplier.update', 'supplier', s.id, 'Updated supplier ' + s.name + '.');
      commit(); return s;
    },
    'suppliers.delete': function (ctx, p) {
      require_(ctx, 'supplier.manage');
      var s = find(db.suppliers, p.id); if (!s) fail('notfound', 'Supplier not found.');
      var inUse = db.rawBatches.some(function (r) { return r.supplierId === s.id; });
      if (inUse) fail('conflict', 'Cannot delete ' + s.name + ' — raw material batches reference this supplier.');
      db.suppliers = db.suppliers.filter(function (x) { return x.id !== s.id; });
      audit(ctx, 'supplier.delete', 'supplier', p.id, 'Deleted supplier ' + s.name + '.');
      commit(); return true;
    },

    'rawBatches.list': function (ctx) {
      require_(ctx, 'production.read');
      return db.rawBatches.map(function (r) {
        var sup = find(db.suppliers, r.supplierId), wh = find(db.warehouses, r.warehouseId);
        return Object.assign({}, r, { supplierName: sup ? sup.name : '—', warehouseName: wh ? wh.name : '—' });
      }).sort(function (a, b) { return a.dateReceived < b.dateReceived ? 1 : -1; });
    },
    'rawBatches.create': function (ctx, p) {
      require_(ctx, 'production.manage');
      var r = {
        id: Crypto.id('rb'), batchNo: 'RB-' + new Date().getFullYear() + '-' + String(db.rawBatches.length + 1).padStart(3, '0'),
        species: V.text(p.species, 'Species', 60), supplierId: V.oneOf(p.supplierId, db.suppliers.map(function (s) { return s.id; }), 'Supplier'),
        dateReceived: V.date(p.dateReceived || todayISO(), 'Date received'), quantity: Math.max(0, Number(p.quantity) || 0), unit: p.unit || 'kg',
        qualityGrade: V.oneOf(p.qualityGrade || 'B', ['A', 'B', 'C'], 'Quality grade'), cost: Math.max(0, Number(p.cost) || 0),
        warehouseId: V.oneOf(p.warehouseId, db.warehouses.map(function (w) { return w.id; }), 'Warehouse'), status: 'in_stock'
      };
      if (r.quantity <= 0) fail('invalid', 'Quantity must be greater than zero.');
      db.rawBatches.push(r);
      audit(ctx, 'rawbatch.create', 'raw_batch', r.id, 'Received ' + r.quantity + r.unit + ' of ' + r.species + ' (' + r.batchNo + ').');
      commit(); return r;
    },
    'rawBatches.update': function (ctx, p) {
      require_(ctx, 'production.manage');
      var r = find(db.rawBatches, p.id); if (!r) fail('notfound', 'Raw batch not found.');
      r.species = V.text(p.species, 'Species', 60); r.supplierId = V.oneOf(p.supplierId, db.suppliers.map(function (s) { return s.id; }), 'Supplier');
      var qty = Math.max(0, Number(p.quantity) || 0); if (qty <= 0) fail('invalid', 'Quantity must be greater than zero.');
      r.quantity = qty; r.unit = p.unit || r.unit; r.qualityGrade = V.oneOf(p.qualityGrade || r.qualityGrade, ['A', 'B', 'C'], 'Quality grade');
      r.cost = Math.max(0, Number(p.cost) || 0); r.warehouseId = V.oneOf(p.warehouseId, db.warehouses.map(function (w) { return w.id; }), 'Warehouse');
      audit(ctx, 'rawbatch.update', 'raw_batch', r.id, 'Updated batch ' + r.batchNo + '.');
      commit(); return r;
    },

    'products.list': function (ctx) {
      require_(ctx, 'inventory.read');
      return db.products.map(function (p) { return Object.assign({}, p, { lowStock: p.currentStock <= p.reorderLevel }); });
    },
    'products.create': function (ctx, p) {
      require_(ctx, 'inventory.manage');
      var prod = {
        id: Crypto.id('pd'), sku: V.text(p.sku, 'SKU', 30).toUpperCase(), name: V.text(p.name, 'Product name', 80),
        category: V.text(p.category, 'Category', 40), unit: p.unit || 'unit', costPrice: Math.max(0, Number(p.costPrice) || 0),
        sellingPrice: Math.max(0, Number(p.sellingPrice) || 0), currentStock: Math.max(0, Number(p.currentStock) || 0), reorderLevel: Math.max(0, Number(p.reorderLevel) || 0)
      };
      if (db.products.some(function (x) { return x.sku === prod.sku; })) fail('invalid', 'That SKU already exists.');
      db.products.push(prod);
      audit(ctx, 'product.create', 'product', prod.id, 'Added product ' + prod.sku + ' — ' + prod.name + '.');
      commit(); return prod;
    },
    'products.update': function (ctx, p) {
      require_(ctx, 'inventory.manage');
      var prod = find(db.products, p.id); if (!prod) fail('notfound', 'Product not found.');
      var sku = V.text(p.sku, 'SKU', 30).toUpperCase();
      if (sku !== prod.sku && db.products.some(function (x) { return x.sku === sku; })) fail('invalid', 'That SKU already exists.');
      prod.sku = sku; prod.name = V.text(p.name, 'Product name', 80); prod.category = V.text(p.category, 'Category', 40);
      prod.unit = p.unit || prod.unit; prod.costPrice = Math.max(0, Number(p.costPrice) || 0); prod.sellingPrice = Math.max(0, Number(p.sellingPrice) || 0);
      prod.currentStock = Math.max(0, Number(p.currentStock) || 0); prod.reorderLevel = Math.max(0, Number(p.reorderLevel) || 0);
      audit(ctx, 'product.update', 'product', prod.id, 'Updated product ' + prod.sku + '.');
      commit(); return prod;
    },

    'production.list': function (ctx) {
      require_(ctx, 'production.read');
      return db.productionBatches.map(function (b) {
        var rb = find(db.rawBatches, b.rawBatchId), prod = find(db.products, b.outputProductId), sup = find(db.employees, b.supervisorId);
        return Object.assign({}, b, {
          rawBatchNo: rb ? rb.batchNo : '—', productName: prod ? prod.name : '—', supervisorName: sup ? sup.firstName + ' ' + sup.lastName : '—',
          efficiency: b.inputQty ? Math.round((b.outputQty / b.inputQty) * 100) : 0
        });
      }).sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    },
    'production.create': function (ctx, p) {
      require_(ctx, 'production.manage');
      var rb = find(db.rawBatches, p.rawBatchId); if (!rb) fail('invalid', 'Choose a raw material batch.');
      var prod = find(db.products, p.outputProductId); if (!prod) fail('invalid', 'Choose an output product.');
      var inputQty = Math.max(0, Number(p.inputQty) || 0), outputQty = Math.max(0, Number(p.outputQty) || 0);
      var wasteQty = Math.max(0, Number(p.wasteQty) || 0), rejectedQty = Math.max(0, Number(p.rejectedQty) || 0);
      if (inputQty <= 0) fail('invalid', 'Input quantity must be greater than zero.');
      if (inputQty > rb.quantity) fail('invalid', 'Only ' + rb.quantity + rb.unit + ' remain in batch ' + rb.batchNo + '.');
      var b = {
        id: Crypto.id('pb'), batchNo: 'PB-' + new Date().getFullYear() + '-' + String(db.productionBatches.length + 118).padStart(3, '0'),
        date: V.date(p.date || todayISO(), 'Date'), productionLine: V.text(p.productionLine, 'Production line', 60), supervisorId: p.supervisorId || ctx.employee.id,
        employeeIds: p.employeeIds || [], rawBatchId: rb.id, outputProductId: prod.id, inputQty: inputQty, outputQty: outputQty, wasteQty: wasteQty, rejectedQty: rejectedQty,
        notes: (p.notes || '').trim(), status: 'completed'
      };
      db.productionBatches.push(b);
      rb.quantity -= inputQty; if (rb.quantity <= 0) rb.status = 'depleted';
      prod.currentStock += outputQty;
      db.inventoryTx.push({ id: Crypto.id('ivt'), itemType: 'raw', itemId: rb.id, warehouseId: rb.warehouseId, type: 'production_consumption', qty: -inputQty, date: b.date, userId: ctx.employee.id, reference: b.batchNo, notes: '' });
      db.inventoryTx.push({ id: Crypto.id('ivt'), itemType: 'product', itemId: prod.id, warehouseId: 'wh_2', type: 'production_output', qty: outputQty, date: b.date, userId: ctx.employee.id, reference: b.batchNo, notes: '' });
      audit(ctx, 'production.create', 'production_batch', b.id, 'Recorded batch ' + b.batchNo + ': ' + inputQty + rb.unit + ' → ' + outputQty + ' ' + prod.unit + '(s), ' + wasteQty + rb.unit + ' waste.');
      commit(); return b;
    },

    'procurement.list': function (ctx) {
      return db.procurementRequests.filter(function (r) { return procurementVisible(ctx, r); }).map(function (r) {
        var e = find(db.employees, r.requesterId), dept = find(db.departments, r.departmentId);
        return Object.assign({}, r, { requesterName: e ? e.firstName + ' ' + e.lastName : '—', departmentName: dept ? dept.name : '—' });
      }).sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
    },
    'procurement.request': function (ctx, p) {
      require_(ctx, 'procurement.request');
      var r = {
        id: Crypto.id('pr'), requesterId: ctx.employee.id, departmentId: ctx.employee.departmentId, item: V.text(p.item, 'Item', 100),
        quantity: Math.max(1, Number(p.quantity) || 1), estimatedPrice: Math.max(0, Number(p.estimatedPrice) || 0), reason: V.text(p.reason, 'Reason', 300),
        requiredDate: V.date(p.requiredDate || todayISO(), 'Required date'), priority: V.oneOf(p.priority || 'medium', ['low', 'medium', 'high'], 'Priority'),
        status: 'pending', createdAt: new Date().toISOString().slice(0, 16), decidedBy: null, decidedAt: null
      };
      db.procurementRequests.push(r);
      db.approvals.push({ id: Crypto.id('ap'), subjectType: 'procurement_request', subjectId: r.id, title: 'Purchase request', requestedBy: ctx.employee.id, assigneePermission: 'procurement.approve', departmentId: ctx.employee.departmentId, status: 'pending', createdAt: r.createdAt, decidedBy: null, decidedAt: null, comment: '' });
      if (ctx.employee.managerId) notify(ctx.employee.managerId, 'Purchase request to approve', ctx.employee.firstName + ' ' + ctx.employee.lastName + ' requested ' + r.item + '.', 'approvals');
      audit(ctx, 'procurement.request', 'procurement_request', r.id, 'Requested ' + r.item + ' (qty ' + r.quantity + ').');
      commit(); return r;
    },
    'procurement.decide': function (ctx, p) {
      require_(ctx, 'procurement.approve');
      var r = find(db.procurementRequests, p.id); if (!r) fail('notfound', 'Request not found.');
      if (r.status !== 'pending') fail('conflict', 'That request has already been decided.');
      if (!procurementVisible(ctx, r)) fail('forbidden', 'Outside your scope.');
      var decision = V.oneOf(p.decision, ['approved', 'rejected'], 'Decision');
      r.status = decision; r.decidedBy = ctx.employee.id; r.decidedAt = new Date().toISOString().slice(0, 16);
      db.approvals.forEach(function (a) { if (a.subjectType === 'procurement_request' && a.subjectId === r.id && a.status === 'pending') { a.status = decision; a.decidedBy = ctx.employee.id; a.decidedAt = r.decidedAt; } });
      notify(r.requesterId, 'Purchase request ' + decision, r.item + ' was ' + decision + '.', 'procurement');
      audit(ctx, 'procurement.decide', 'procurement_request', r.id, decision.charAt(0).toUpperCase() + decision.slice(1) + ' request for ' + r.item + '.');
      commit(); return r;
    },

    'assets.list': function (ctx) {
      require_(ctx, 'asset.read');
      var t = todayISO();
      return db.assets.map(function (a) {
        var e = find(db.employees, a.assignedEmployeeId);
        return Object.assign({}, a, { assigneeName: e ? e.firstName + ' ' + e.lastName : 'Unassigned', serviceDue: a.nextServiceDate && a.nextServiceDate <= (new Date(Date.now() + 7 * 86400000)).toISOString().slice(0, 10) });
      });
    },
    'assets.create': function (ctx, p) {
      require_(ctx, 'asset.manage');
      var a = {
        id: Crypto.id('as'), assetNo: 'AST-' + String(1000 + db.assets.length + 1).slice(1), category: V.text(p.category, 'Category', 40),
        description: V.text(p.description, 'Description', 120), purchaseDate: V.date(p.purchaseDate || todayISO(), 'Purchase date'),
        purchasePrice: Math.max(0, Number(p.purchasePrice) || 0), assignedEmployeeId: p.assignedEmployeeId || null,
        location: (p.location || '').trim(), condition: p.condition || 'good', warrantyUntil: p.warrantyUntil || null, nextServiceDate: p.nextServiceDate || null
      };
      db.assets.push(a);
      audit(ctx, 'asset.create', 'asset', a.id, 'Registered asset ' + a.assetNo + ' — ' + a.description + '.');
      commit(); return a;
    },

    'maintenance.list': function (ctx) {
      require_(ctx, 'asset.read');
      return db.maintenanceRecords.map(function (m) { var a = find(db.assets, m.assetId); return Object.assign({}, m, { assetLabel: a ? a.assetNo + ' — ' + a.description : '—' }); }).sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    },
    'maintenance.create': function (ctx, p) {
      require_(ctx, 'asset.manage');
      var asset = find(db.assets, p.assetId); if (!asset) fail('invalid', 'Choose an asset.');
      var m = {
        id: Crypto.id('mt'), assetId: asset.id, date: V.date(p.date || todayISO(), 'Date'), technician: V.text(p.technician, 'Technician', 60),
        cost: Math.max(0, Number(p.cost) || 0), faultReport: V.text(p.faultReport, 'Fault report', 300), downtimeHours: Math.max(0, Number(p.downtimeHours) || 0),
        partsReplaced: (p.partsReplaced || '').trim(), status: 'completed'
      };
      db.maintenanceRecords.push(m);
      if (p.nextServiceDate) asset.nextServiceDate = p.nextServiceDate;
      audit(ctx, 'maintenance.create', 'maintenance', m.id, 'Logged maintenance on ' + asset.assetNo + ': ' + m.faultReport);
      commit(); return m;
    },

    'customers.list': function (ctx) {
      require_(ctx, 'customer.read');
      return db.customers.map(function (c) {
        var m = find(db.employees, c.accountManagerId);
        var quoted = db.quotations.filter(function (q) { return q.customerId === c.id; }).reduce(function (s, q) { return s + q.grandTotal; }, 0);
        var invs = db.invoices.filter(function (i) { return i.customerId === c.id; });
        var invoiced = invs.reduce(function (s, i) { return s + i.grandTotal; }, 0);
        var paid = invs.reduce(function (s, i) { return s + i.amountPaid; }, 0);
        return Object.assign({}, c, { managerName: m ? m.firstName + ' ' + m.lastName : '—', quotedTotal: quoted, invoicedTotal: invoiced, paidTotal: paid, outstandingTotal: invoiced - paid });
      });
    },
    'customers.create': function (ctx, p) {
      require_(ctx, 'customer.manage');
      var c = {
        id: Crypto.id('cu'), name: V.text(p.name, 'Customer name', 100), contactPerson: (p.contactPerson || '').trim(),
        email: (p.email || '').trim(), phone: (p.phone || '').trim(), address: (p.address || '').trim(),
        category: V.oneOf(p.category || 'lead', ['lead', 'prospect', 'active', 'inactive', 'vip'], 'Category'),
        accountManagerId: p.accountManagerId || ctx.employee.id, status: 'active', notes: (p.notes || '').trim()
      };
      db.customers.push(c);
      audit(ctx, 'customer.create', 'customer', c.id, 'Added customer ' + c.name + '.');
      commit(); return c;
    },
    'customers.setCategory': function (ctx, p) {
      require_(ctx, 'customer.manage');
      var c = find(db.customers, p.id); if (!c) fail('notfound', 'Customer not found.');
      c.category = V.oneOf(p.category, ['lead', 'prospect', 'active', 'inactive', 'vip'], 'Category');
      audit(ctx, 'customer.update', 'customer', c.id, 'Set ' + c.name + ' to ' + c.category + '.');
      commit(); return c;
    },
    'customers.update': function (ctx, p) {
      require_(ctx, 'customer.manage');
      var c = find(db.customers, p.id); if (!c) fail('notfound', 'Customer not found.');
      c.name = V.text(p.name, 'Customer name', 100); c.contactPerson = (p.contactPerson || '').trim();
      c.email = (p.email || '').trim(); c.phone = (p.phone || '').trim(); c.address = (p.address || '').trim();
      c.billingAddress = (p.billingAddress || c.address || '').trim();
      c.category = V.oneOf(p.category || c.category, ['lead', 'prospect', 'active', 'inactive', 'vip'], 'Category');
      if (p.accountManagerId !== undefined) c.accountManagerId = p.accountManagerId || null;
      c.notes = (p.notes || '').trim();
      audit(ctx, 'customer.update', 'customer', c.id, 'Updated ' + c.name + '.');
      commit(); return c;
    },
    'customers.delete': function (ctx, p) {
      require_(ctx, 'customer.manage');
      var c = find(db.customers, p.id); if (!c) fail('notfound', 'Customer not found.');
      var linked = db.quotations.some(function (q) { return q.customerId === c.id; }) || db.estimates.some(function (e) { return e.customerId === c.id; }) || db.invoices.some(function (i) { return i.customerId === c.id; });
      if (linked) fail('conflict', 'Cannot delete ' + c.name + ' — they have quotations, estimates or invoices on record.');
      db.customers = db.customers.filter(function (x) { return x.id !== c.id; });
      audit(ctx, 'customer.delete', 'customer', p.id, 'Deleted customer ' + c.name + '.');
      commit(); return true;
    },

    'quotations.list': function (ctx) {
      require_(ctx, 'quotation.read');
      autoExpireQuotations();
      return db.quotations.map(function (q) { var c = find(db.customers, q.customerId); return Object.assign({}, q, { customerName: c ? c.name : '—' }); }).sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
    },
    'quotations.create': function (ctx, p) {
      require_(ctx, 'quotation.manage');
      var cust = find(db.customers, p.customerId); if (!cust) fail('invalid', 'Choose a customer.');
      var items = buildLineItems((p.items && p.items.length) ? p.items : (p.description ? [{ description: p.description, qty: p.qty, unitPrice: p.unitPrice }] : []));
      var totals = computeDocTotals(items, p.discount, p.taxRate);
      var num = nextDocNumber('quotation');
      var q = {
        id: Crypto.id('qt'), quoteNo: num, customerId: cust.id, title: V.text(p.title || 'Quotation for ' + cust.name, 'Title', 120),
        items: items, subtotal: totals.subtotal, discountTotal: totals.discountTotal, taxTotal: totals.taxTotal, grandTotal: totals.grandTotal, total: totals.grandTotal,
        status: 'draft', createdBy: ctx.employee.id, createdAt: todayISO(),
        validUntil: V.date(p.validUntil || addDays(todayISO(), db.settings.commercial.templates.validityDays), 'Valid until'),
        notes: (p.notes || '').trim(), terms: p.terms || db.settings.commercial.templates.termsAndConditions
      };
      db.quotations.push(q);
      audit(ctx, 'quotation.create', 'quotation', q.id, 'Created ' + q.quoteNo + ' for ' + cust.name + ' (GHS ' + totals.grandTotal.toLocaleString() + ').');
      commit(); return q;
    },
    'quotations.setStatus': function (ctx, p) {
      require_(ctx, 'quotation.manage');
      var q = find(db.quotations, p.id); if (!q) fail('notfound', 'Quotation not found.');
      q.status = V.oneOf(p.status, ['draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired', 'cancelled'], 'Status');
      audit(ctx, 'quotation.status', 'quotation', q.id, 'Set ' + q.quoteNo + ' to ' + q.status + '.');
      commit(); return q;
    },

    'salesOrders.list': function (ctx) {
      require_(ctx, 'sales.read');
      return db.salesOrders.map(function (o) { var c = find(db.customers, o.customerId); return Object.assign({}, o, { customerName: c ? c.name : '—' }); }).sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
    },
    'salesOrders.createFromQuotation': function (ctx, p) {
      require_(ctx, 'sales.manage');
      var q = find(db.quotations, p.quotationId); if (!q) fail('notfound', 'Quotation not found.');
      if (q.status !== 'accepted') fail('conflict', 'Only an accepted quotation can become a sales order.');
      if (db.salesOrders.some(function (o) { return o.quotationId === q.id; })) fail('conflict', 'A sales order already exists for this quotation.');
      var o = { id: Crypto.id('so'), orderNo: 'SO-' + String(1400 + db.salesOrders.length + 1), customerId: q.customerId, quotationId: q.id, items: q.items, total: q.total, status: 'pending', createdAt: todayISO(), createdBy: ctx.employee.id };
      db.salesOrders.push(o);
      audit(ctx, 'salesorder.create', 'sales_order', o.id, 'Created ' + o.orderNo + ' from ' + q.quoteNo + ' (GHS ' + o.total.toLocaleString() + ').');
      commit(); return o;
    },
    'salesOrders.setStatus': function (ctx, p) {
      require_(ctx, 'sales.manage');
      var o = find(db.salesOrders, p.id); if (!o) fail('notfound', 'Sales order not found.');
      o.status = V.oneOf(p.status, ['pending', 'processing', 'delivered', 'cancelled'], 'Status');
      audit(ctx, 'salesorder.status', 'sales_order', o.id, 'Set ' + o.orderNo + ' to ' + o.status + '.');
      commit(); return o;
    },

    'invoices.list': function (ctx) {
      require_(ctx, 'invoice.read');
      var t = todayISO();
      return db.invoices.map(function (i) { var c = find(db.customers, i.customerId); return Object.assign({}, i, { customerName: c ? c.name : '—', overdue: i.status === 'unpaid' && i.dueDate < t }); }).sort(function (a, b) { return a.issuedAt < b.issuedAt ? 1 : -1; });
    },
    'invoices.createFromOrder': function (ctx, p) {
      require_(ctx, 'invoice.manage');
      var o = find(db.salesOrders, p.salesOrderId); if (!o) fail('notfound', 'Sales order not found.');
      if (db.invoices.some(function (i) { return i.salesOrderId === o.id; })) fail('conflict', 'An invoice already exists for this order.');
      var items = buildLineItems(o.items);
      var totals = computeDocTotals(items, null, 0);
      var i = {
        id: Crypto.id('iv'), invoiceNo: nextDocNumber('invoice'), salesOrderId: o.id, customerId: o.customerId, items: items,
        subtotal: totals.subtotal, discountTotal: totals.discountTotal, taxTotal: totals.taxTotal, grandTotal: totals.grandTotal, amount: totals.grandTotal,
        amountPaid: 0, balanceDue: totals.grandTotal, status: 'unpaid', issuedAt: todayISO(),
        dueDate: addDays(todayISO(), db.settings.commercial.templates.invoiceDueDays), paidAt: null, poReference: '', bankInstructions: db.settings.commercial.paymentDetails.instructions
      };
      db.invoices.push(i);
      audit(ctx, 'invoice.create', 'invoice', i.id, 'Issued ' + i.invoiceNo + ' for ' + o.orderNo + ' (GHS ' + i.amount.toLocaleString() + ').');
      commit(); return i;
    },
    'invoices.createFromQuotation': function (ctx, p) {
      require_(ctx, 'invoice.manage');
      var q = find(db.quotations, p.quotationId); if (!q) fail('notfound', 'Quotation not found.');
      if (q.status !== 'accepted') fail('conflict', 'Only an accepted quotation can be invoiced.');
      if (db.invoices.some(function (i) { return i.quotationId === q.id; })) fail('conflict', 'An invoice already exists for this quotation.');
      var i = {
        id: Crypto.id('iv'), invoiceNo: nextDocNumber('invoice'), quotationId: q.id, salesOrderId: null, customerId: q.customerId, items: q.items,
        subtotal: q.subtotal, discountTotal: q.discountTotal, taxTotal: q.taxTotal, grandTotal: q.grandTotal, amount: q.grandTotal,
        amountPaid: 0, balanceDue: q.grandTotal, status: 'unpaid', issuedAt: todayISO(), poReference: (p.poReference || '').trim(),
        dueDate: addDays(todayISO(), db.settings.commercial.templates.invoiceDueDays), paidAt: null, bankInstructions: db.settings.commercial.paymentDetails.instructions
      };
      db.invoices.push(i);
      audit(ctx, 'invoice.create', 'invoice', i.id, 'Issued ' + i.invoiceNo + ' from ' + q.quoteNo + ' (GHS ' + i.amount.toLocaleString() + ').');
      commit(); return i;
    },
    'invoices.createManual': function (ctx, p) {
      require_(ctx, 'invoice.manage');
      var cust = find(db.customers, p.customerId); if (!cust) fail('invalid', 'Choose a customer.');
      var items = buildLineItems(p.items);
      var totals = computeDocTotals(items, p.discount, p.taxRate);
      var i = {
        id: Crypto.id('iv'), invoiceNo: nextDocNumber('invoice'), quotationId: null, salesOrderId: null, customerId: cust.id, items: items,
        subtotal: totals.subtotal, discountTotal: totals.discountTotal, taxTotal: totals.taxTotal, grandTotal: totals.grandTotal, amount: totals.grandTotal,
        amountPaid: 0, balanceDue: totals.grandTotal, status: 'unpaid', issuedAt: todayISO(), poReference: (p.poReference || '').trim(),
        dueDate: V.date(p.dueDate || addDays(todayISO(), db.settings.commercial.templates.invoiceDueDays), 'Due date'), paidAt: null, bankInstructions: db.settings.commercial.paymentDetails.instructions
      };
      db.invoices.push(i);
      audit(ctx, 'invoice.create', 'invoice', i.id, 'Manually created ' + i.invoiceNo + ' for ' + cust.name + ' (GHS ' + i.amount.toLocaleString() + ').');
      commit(); return i;
    },
    'invoices.recordPayment': function (ctx, p) {
      require_(ctx, 'invoice.manage');
      var i = find(db.invoices, p.invoiceId); if (!i) fail('notfound', 'Invoice not found.');
      if (i.status === 'void') fail('conflict', 'This invoice has been voided.');
      if (i.status === 'paid') fail('conflict', 'This invoice is already fully paid.');
      var amount = Math.round((Number(p.amount) || 0) * 100) / 100;
      if (amount <= 0) fail('invalid', 'Enter a payment amount greater than zero.');
      if (amount > i.balanceDue + 0.01) fail('invalid', 'That exceeds the outstanding balance of GHS ' + i.balanceDue.toLocaleString() + '.');
      var pay = {
        id: Crypto.id('pmt'), invoiceId: i.id, customerId: i.customerId, date: V.date(p.date || todayISO(), 'Payment date'),
        amount: amount, currency: 'GHS', method: V.oneOf(p.method || 'bank_transfer', ['cash', 'bank_transfer', 'mobile_money', 'card', 'cheque', 'other'], 'Payment method'),
        reference: (p.reference || '').trim(), receivedBy: ctx.employee.id, notes: (p.notes || '').trim()
      };
      db.payments.push(pay);
      i.amountPaid = Math.round((i.amountPaid + amount) * 100) / 100;
      i.balanceDue = Math.round((i.grandTotal - i.amountPaid) * 100) / 100;
      i.status = i.balanceDue <= 0.01 ? 'paid' : 'partially_paid';
      if (i.status === 'paid') i.paidAt = pay.date;
      var receipt = {
        id: Crypto.id('rct'), receiptNo: nextDocNumber('receipt'), paymentId: pay.id, invoiceId: i.id, customerId: i.customerId,
        date: pay.date, amount: pay.amount, method: pay.method, reference: pay.reference, balanceAfter: i.balanceDue, receivedBy: ctx.employee.id
      };
      db.receipts.push(receipt);
      var cust = find(db.customers, i.customerId);
      audit(ctx, 'payment.record', 'invoice', i.id, 'Recorded GHS ' + amount.toLocaleString() + ' payment on ' + i.invoiceNo + ' (' + (cust ? cust.name : '—') + '); balance GHS ' + i.balanceDue.toLocaleString() + '.');
      if (i.status === 'paid') audit(ctx, 'invoice.paid', 'invoice', i.id, i.invoiceNo + ' fully paid.');
      commit(); return { payment: pay, receipt: receipt, invoice: i };
    },
    'payments.delete': function (ctx, p) {
      require_(ctx, 'invoice.manage');
      var pay = find(db.payments, p.id); if (!pay) fail('notfound', 'Payment not found.');
      var i = find(db.invoices, pay.invoiceId); if (!i) fail('notfound', 'Related invoice not found.');
      db.payments = db.payments.filter(function (x) { return x.id !== pay.id; });
      db.receipts = db.receipts.filter(function (r) { return r.paymentId !== pay.id; });
      i.amountPaid = Math.round((i.amountPaid - pay.amount) * 100) / 100;
      i.balanceDue = Math.round((i.grandTotal - i.amountPaid) * 100) / 100;
      i.status = i.balanceDue <= 0.01 ? 'paid' : (i.amountPaid > 0 ? 'partially_paid' : 'unpaid');
      if (i.status !== 'paid') i.paidAt = null;
      audit(ctx, 'payment.delete', 'invoice', i.id, 'Removed GHS ' + pay.amount.toLocaleString() + ' payment from ' + i.invoiceNo + '.');
      commit(); return true;
    },
    'invoices.update': function (ctx, p) {
      require_(ctx, 'invoice.manage');
      var i = find(db.invoices, p.id); if (!i) fail('notfound', 'Invoice not found.');
      if (p.dueDate) i.dueDate = V.date(p.dueDate, 'Due date');
      if (p.poReference !== undefined) i.poReference = (p.poReference || '').trim();
      audit(ctx, 'invoice.update', 'invoice', i.id, 'Updated ' + i.invoiceNo + '.');
      commit(); return i;
    },
    'invoices.delete': function (ctx, p) {
      require_(ctx, 'invoice.manage');
      var i = find(db.invoices, p.id); if (!i) fail('notfound', 'Invoice not found.');
      if (i.amountPaid > 0) fail('conflict', 'Cannot delete an invoice that has payments recorded. Remove the payments first.');
      db.invoices = db.invoices.filter(function (x) { return x.id !== i.id; });
      audit(ctx, 'invoice.delete', 'invoice', p.id, 'Deleted invoice ' + i.invoiceNo + '.');
      commit(); return true;
    },
    'invoices.void': function (ctx, p) {
      require_(ctx, 'invoice.manage');
      var i = find(db.invoices, p.id); if (!i) fail('notfound', 'Invoice not found.');
      if (i.amountPaid > 0) fail('conflict', 'Cannot void an invoice that already has payments recorded against it.');
      i.status = 'void';
      audit(ctx, 'invoice.void', 'invoice', i.id, i.invoiceNo + ' voided.');
      commit(); return i;
    },
    'invoices.markPaid': function (ctx, p) {
      require_(ctx, 'invoice.manage');
      var i = find(db.invoices, p.id); if (!i) fail('notfound', 'Invoice not found.');
      if (i.status === 'paid') fail('conflict', 'Already marked paid.');
      return handlers['invoices.recordPayment'](ctx, { invoiceId: i.id, amount: i.balanceDue, method: 'bank_transfer', reference: 'Manual settlement' }).invoice;
    },

    'expenses.list': function (ctx) {
      var all = ctx.can('expense.read.all');
      return db.expenses.filter(function (e) { return all ? expenseVisible(ctx, e) : e.requesterId === ctx.employee.id; })
        .map(function (e) { var emp = find(db.employees, e.requesterId), dept = find(db.departments, e.departmentId); return Object.assign({}, e, { requesterName: emp ? emp.firstName + ' ' + emp.lastName : '—', departmentName: dept ? dept.name : '—' }); })
        .sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
    },
    'expenses.request': function (ctx, p) {
      require_(ctx, 'expense.request');
      var e = {
        id: Crypto.id('ex'), requesterId: ctx.employee.id, departmentId: ctx.employee.departmentId, category: V.text(p.category, 'Category', 40),
        amount: Math.max(0, Number(p.amount) || 0), date: V.date(p.date || todayISO(), 'Date'), description: V.text(p.description, 'Description', 300),
        projectId: p.projectId || null, status: 'pending', createdAt: new Date().toISOString().slice(0, 16), decidedBy: null, decidedAt: null
      };
      if (e.amount <= 0) fail('invalid', 'Amount must be greater than zero.');
      db.expenses.push(e);
      db.approvals.push({ id: Crypto.id('ap'), subjectType: 'expense', subjectId: e.id, title: 'Expense claim', requestedBy: ctx.employee.id, assigneePermission: 'expense.approve', departmentId: ctx.employee.departmentId, status: 'pending', createdAt: e.createdAt, decidedBy: null, decidedAt: null, comment: '' });
      if (ctx.employee.managerId) notify(ctx.employee.managerId, 'Expense claim to approve', ctx.employee.firstName + ' ' + ctx.employee.lastName + ' submitted a GHS ' + e.amount.toLocaleString() + ' claim.', 'approvals');
      audit(ctx, 'expense.request', 'expense', e.id, 'Submitted ' + e.category + ' expense of GHS ' + e.amount.toLocaleString() + '.');
      commit(); return e;
    },
    'expenses.decide': function (ctx, p) {
      require_(ctx, 'expense.approve');
      var e = find(db.expenses, p.id); if (!e) fail('notfound', 'Expense not found.');
      if (e.status !== 'pending') fail('conflict', 'That claim has already been decided.');
      if (!expenseVisible(ctx, e)) fail('forbidden', 'Outside your scope.');
      var decision = V.oneOf(p.decision, ['approved', 'rejected'], 'Decision');
      e.status = decision; e.decidedBy = ctx.employee.id; e.decidedAt = new Date().toISOString().slice(0, 16);
      db.approvals.forEach(function (a) { if (a.subjectType === 'expense' && a.subjectId === e.id && a.status === 'pending') { a.status = decision; a.decidedBy = ctx.employee.id; a.decidedAt = e.decidedAt; } });
      notify(e.requesterId, 'Expense claim ' + decision, e.category + ' claim of GHS ' + e.amount.toLocaleString() + ' was ' + decision + '.', 'expenses');
      audit(ctx, 'expense.decide', 'expense', e.id, decision.charAt(0).toUpperCase() + decision.slice(1) + ' expense claim (GHS ' + e.amount.toLocaleString() + ').');
      commit(); return e;
    },
    'expenses.update': function (ctx, p) {
      var e = find(db.expenses, p.id); if (!e) fail('notfound', 'Expense not found.');
      if (e.requesterId !== ctx.employee.id && !ctx.can('expense.approve')) fail('forbidden', 'You can only edit your own claims.');
      if (e.status !== 'pending') fail('conflict', 'Only a pending claim can be edited.');
      e.category = V.text(p.category, 'Category', 40); e.amount = Math.max(0.01, Number(p.amount) || 0);
      e.date = V.date(p.date || e.date, 'Date'); e.description = V.text(p.description, 'Description', 300);
      audit(ctx, 'expense.update', 'expense', e.id, 'Updated expense claim (GHS ' + e.amount.toLocaleString() + ').');
      commit(); return e;
    },
    'expenses.delete': function (ctx, p) {
      var e = find(db.expenses, p.id); if (!e) fail('notfound', 'Expense not found.');
      if (e.requesterId !== ctx.employee.id && !ctx.can('expense.approve')) fail('forbidden', 'You can only delete your own claims.');
      if (e.status !== 'pending') fail('conflict', 'Only a pending claim can be deleted.');
      db.expenses = db.expenses.filter(function (x) { return x.id !== e.id; });
      db.approvals = db.approvals.filter(function (a) { return !(a.subjectType === 'expense' && a.subjectId === e.id); });
      audit(ctx, 'expense.delete', 'expense', p.id, 'Deleted expense claim (GHS ' + e.amount.toLocaleString() + ').');
      commit(); return true;
    },
    'expenses.markPaid': function (ctx, p) {
      require_(ctx, 'expense.approve');
      var e = find(db.expenses, p.id); if (!e) fail('notfound', 'Expense not found.');
      if (e.status !== 'approved') fail('conflict', 'Only an approved claim can be marked paid.');
      e.status = 'paid';
      audit(ctx, 'expense.paid', 'expense', e.id, 'Marked expense claim paid (GHS ' + e.amount.toLocaleString() + ').');
      commit(); return e;
    },

    'reports.summary': function (ctx) {
      require_(ctx, 'report.read');
      var invoiced = db.invoices.reduce(function (s, i) { return s + i.amount; }, 0);
      var paid = db.invoices.filter(function (i) { return i.status === 'paid'; }).reduce(function (s, i) { return s + i.amount; }, 0);
      var byCat = {};
      db.expenses.filter(function (e) { return e.status !== 'rejected'; }).forEach(function (e) { byCat[e.category] = (byCat[e.category] || 0) + e.amount; });
      var byCustomer = {};
      db.salesOrders.forEach(function (o) { var c = find(db.customers, o.customerId); var name = c ? c.name : '—'; byCustomer[name] = (byCustomer[name] || 0) + o.total; });
      return {
        totalInvoiced: invoiced, totalPaid: paid, outstanding: invoiced - paid,
        quotationsSent: db.quotations.filter(function (q) { return q.status !== 'draft'; }).length,
        quotationsAccepted: db.quotations.filter(function (q) { return q.status === 'accepted'; }).length,
        ordersCount: db.salesOrders.length,
        expenseByCategory: Object.keys(byCat).map(function (k) { return { category: k, amount: byCat[k] }; }).sort(function (a, b) { return b.amount - a.amount; }),
        salesByCustomer: Object.keys(byCustomer).map(function (k) { return { customer: k, amount: byCustomer[k] }; }).sort(function (a, b) { return b.amount - a.amount; }),
        totalExpensesApproved: db.expenses.filter(function (e) { return e.status === 'approved' || e.status === 'paid'; }).reduce(function (s, e) { return s + e.amount; }, 0)
      };
    },

    // Phase 4 (architecture only): every field below is produced by re-using the
    // already-permission-scoped handlers above — the assistant can never see more
    // than the logged-in user could see by clicking through the app themselves.
    'ai.context': function (ctx) {
      function safe(name, params) { try { return handlers[name](ctx, params || {}); } catch (e) { return null; } }
      return {
        me: { name: ctx.employee.firstName + ' ' + ctx.employee.lastName, roles: ctx.roleNames, department: find(db.departments, ctx.employee.departmentId).name, title: ctx.employee.positionTitle },
        today: todayISO(),
        snapshot: safe('dashboard.load'),
        myTasks: safe('tasks.list', { scope: 'mine' }),
        pendingApprovals: ctx.can('approval.act') ? safe('approvals.queue') : null,
        financials: ctx.can('report.read') ? safe('reports.summary') : null
      };
    },

    'marketing.dashboard': function (ctx) {
      require_(ctx, 'customer.read');
      var cats = ['lead', 'prospect', 'active', 'vip', 'inactive'];
      var pipeline = cats.map(function (c) { return { category: c, count: db.customers.filter(function (x) { return x.category === c; }).length }; });
      var sent = db.quotations.filter(function (q) { return q.status !== 'draft'; });
      var accepted = db.quotations.filter(function (q) { return q.status === 'accepted'; });
      var rejected = db.quotations.filter(function (q) { return q.status === 'rejected' || q.status === 'expired'; });
      var byCustomer = {};
      db.salesOrders.forEach(function (o) { var c = find(db.customers, o.customerId); var name = c ? c.name : '\u2014'; byCustomer[name] = (byCustomer[name] || 0) + o.total; });
      var topCustomers = Object.keys(byCustomer).map(function (k) { return { name: k, total: byCustomer[k] }; }).sort(function (a, b) { return b.total - a.total; }).slice(0, 5);
      var leads = db.customers.filter(function (c) { return c.category === 'lead' || c.category === 'prospect'; }).map(function (c) { var m = find(db.employees, c.accountManagerId); return { name: c.name, contactPerson: c.contactPerson, email: c.email, phone: c.phone, category: c.category, managerName: m ? m.firstName + ' ' + m.lastName : '\u2014' }; });
      var recentQuotes = db.quotations.slice().sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; }).slice(0, 5).map(function (q) { var c = find(db.customers, q.customerId); return { quoteNo: q.quoteNo, customerName: c ? c.name : '\u2014', total: q.total, status: q.status }; });
      return {
        pipeline: pipeline, totalCustomers: db.customers.length,
        funnel: { sent: sent.length, accepted: accepted.length, rejected: rejected.length, conversionRate: sent.length ? Math.round((accepted.length / sent.length) * 100) : 0 },
        topCustomers: topCustomers, leads: leads, recentQuotes: recentQuotes
      };
    },

    'finance.dashboard': function (ctx, p) {
      require_(ctx, 'report.read');
      var t = todayISO();
      var periodType = (p && p.periodType === 'years') ? 'years' : 'months';
      var periodCount = Math.max(1, Math.min(12, Number(p && p.periodCount) || 6));
      var overdue = db.invoices.filter(function (i) { return i.status !== 'paid' && i.dueDate < t; }).map(function (i) {
        var c = find(db.customers, i.customerId);
        var days = Math.round((new Date(t) - new Date(i.dueDate)) / 86400000);
        return { invoiceNo: i.invoiceNo, customerName: c ? c.name : '\u2014', amount: i.amount, daysOverdue: days };
      }).sort(function (a, b) { return b.daysOverdue - a.daysOverdue; });
      var unpaid = db.invoices.filter(function (i) { return i.status !== 'paid'; });
      var paidThisMonth = db.invoices.filter(function (i) { return i.status === 'paid' && i.paidAt && i.paidAt.slice(0, 7) === t.slice(0, 7); }).reduce(function (s, i) { return s + i.amount; }, 0);
      var pendingExpenses = db.expenses.filter(function (e) { return e.status === 'pending'; }).map(function (e) {
        var emp = find(db.employees, e.requesterId), dept = find(db.departments, e.departmentId);
        return { category: e.category, amount: e.amount, requesterName: emp ? emp.firstName + ' ' + emp.lastName : '\u2014', departmentName: dept ? dept.name : '\u2014', date: e.date };
      });
      var approvedExpensesThisMonth = db.expenses.filter(function (e) { return (e.status === 'approved' || e.status === 'paid') && e.date.slice(0, 7) === t.slice(0, 7); }).reduce(function (s, e) { return s + e.amount; }, 0);
      var months = [];
      if (periodType === 'years') {
        for (var y = periodCount - 1; y >= 0; y--) {
          var yr = new Date().getFullYear() - y;
          var yrevenue = db.invoices.filter(function (i) { return i.status === 'paid' && i.paidAt && i.paidAt.slice(0, 4) === String(yr); }).reduce(function (s, i) { return s + i.amount; }, 0);
          var yexpense = db.expenses.filter(function (e) { return (e.status === 'approved' || e.status === 'paid') && e.date.slice(0, 4) === String(yr); }).reduce(function (s, e) { return s + e.amount; }, 0);
          months.push({ month: String(yr), revenue: yrevenue, expense: yexpense });
        }
      } else {
        for (var m = periodCount - 1; m >= 0; m--) {
          var dt = new Date(); dt.setMonth(dt.getMonth() - m);
          var key = dt.toISOString().slice(0, 7);
          var label = dt.toLocaleDateString('en-GB', { month: 'short', year: periodCount > 12 ? '2-digit' : undefined });
          var rev = db.invoices.filter(function (i) { return i.status === 'paid' && i.paidAt && i.paidAt.slice(0, 7) === key; }).reduce(function (s, i) { return s + i.amount; }, 0);
          var exp = db.expenses.filter(function (e) { return (e.status === 'approved' || e.status === 'paid') && e.date.slice(0, 7) === key; }).reduce(function (s, e) { return s + e.amount; }, 0);
          months.push({ month: label, revenue: rev, expense: exp });
        }
      }
      var recentPayments = db.payments.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; }).slice(0, 6).map(function (pm) {
        var c = find(db.customers, pm.customerId), i = find(db.invoices, pm.invoiceId);
        return { customerName: c ? c.name : '\u2014', invoiceNo: i ? i.invoiceNo : '\u2014', amount: pm.amount, date: pm.date, method: pm.method };
      });
      return {
        cashCollectedThisMonth: paidThisMonth,
        outstandingTotal: unpaid.reduce(function (s, i) { return s + i.amount; }, 0),
        unpaidCount: unpaid.length,
        overdueInvoices: overdue,
        overdueTotal: overdue.reduce(function (s, i) { return s + i.amount; }, 0),
        pendingExpenses: pendingExpenses,
        pendingExpensesTotal: pendingExpenses.reduce(function (s, e) { return s + e.amount; }, 0),
        approvedExpensesThisMonth: approvedExpensesThisMonth,
        netPositionThisMonth: paidThisMonth - approvedExpensesThisMonth,
        monthlyTrend: months,
        recentPayments: recentPayments
      };
    },

    'estimates.list': function (ctx) {
      require_(ctx, 'quotation.read');
      return db.estimates.map(function (es) { var c = find(db.customers, es.customerId); return Object.assign({}, es, { customerName: c ? c.name : '—' }); }).sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
    },
    'estimates.create': function (ctx, p) {
      require_(ctx, 'quotation.manage');
      var cust = find(db.customers, p.customerId); if (!cust) fail('invalid', 'Choose a customer.');
      var items = buildLineItems(p.items);
      var totals = computeDocTotals(items, p.discount, p.taxRate);
      var es = {
        id: Crypto.id('es'), estimateNo: nextDocNumber('estimate'), customerId: cust.id, items: items,
        subtotal: totals.subtotal, discountTotal: totals.discountTotal, taxTotal: totals.taxTotal, grandTotal: totals.grandTotal,
        status: 'draft', createdBy: ctx.employee.id, createdAt: todayISO(), validUntil: V.date(p.validUntil || addDays(todayISO(), db.settings.commercial.templates.validityDays), 'Valid until'),
        internalNotes: (p.internalNotes || '').trim(), clientNotes: (p.clientNotes || '').trim(), terms: p.terms || db.settings.commercial.templates.termsAndConditions
      };
      db.estimates.push(es);
      audit(ctx, 'estimate.create', 'estimate', es.id, 'Created ' + es.estimateNo + ' for ' + cust.name + ' (GHS ' + totals.grandTotal.toLocaleString() + ').');
      commit(); return es;
    },
    'estimates.setStatus': function (ctx, p) {
      require_(ctx, 'quotation.manage');
      var es = find(db.estimates, p.id); if (!es) fail('notfound', 'Estimate not found.');
      es.status = V.oneOf(p.status, ['draft', 'finalized', 'converted', 'archived'], 'Status');
      audit(ctx, 'estimate.status', 'estimate', es.id, 'Set ' + es.estimateNo + ' to ' + es.status + '.');
      commit(); return es;
    },
    'estimates.update': function (ctx, p) {
      require_(ctx, 'quotation.manage');
      var es = find(db.estimates, p.id); if (!es) fail('notfound', 'Estimate not found.');
      if (es.status !== 'draft') fail('conflict', 'Only a draft estimate can be edited.');
      var cust = find(db.customers, p.customerId); if (!cust) fail('invalid', 'Choose a customer.');
      var items = buildLineItems(p.items);
      var totals = computeDocTotals(items, p.discount, p.taxRate);
      es.customerId = cust.id; es.items = items; es.subtotal = totals.subtotal; es.discountTotal = totals.discountTotal;
      es.taxTotal = totals.taxTotal; es.grandTotal = totals.grandTotal;
      if (p.validUntil) es.validUntil = V.date(p.validUntil, 'Valid until');
      es.internalNotes = (p.internalNotes || '').trim(); es.clientNotes = (p.clientNotes || '').trim();
      audit(ctx, 'estimate.update', 'estimate', es.id, 'Updated ' + es.estimateNo + '.');
      commit(); return es;
    },
    'estimates.delete': function (ctx, p) {
      require_(ctx, 'quotation.manage');
      var es = find(db.estimates, p.id); if (!es) fail('notfound', 'Estimate not found.');
      if (es.status === 'converted') fail('conflict', 'Cannot delete an estimate that has already been converted to a quotation.');
      db.estimates = db.estimates.filter(function (x) { return x.id !== es.id; });
      audit(ctx, 'estimate.delete', 'estimate', p.id, 'Deleted estimate ' + es.estimateNo + '.');
      commit(); return true;
    },
    'estimates.convertToQuotation': function (ctx, p) {
      require_(ctx, 'quotation.manage');
      var es = find(db.estimates, p.id); if (!es) fail('notfound', 'Estimate not found.');
      if (es.status === 'converted') fail('conflict', 'This estimate has already been converted.');
      var cust = find(db.customers, es.customerId);
      var q = {
        id: Crypto.id('qt'), quoteNo: nextDocNumber('quotation'), customerId: es.customerId, title: 'Quotation for ' + (cust ? cust.name : ''),
        items: es.items, subtotal: es.subtotal, discountTotal: es.discountTotal, taxTotal: es.taxTotal, grandTotal: es.grandTotal, total: es.grandTotal,
        status: 'draft', createdBy: ctx.employee.id, createdAt: todayISO(), validUntil: es.validUntil, notes: es.clientNotes, terms: es.terms, fromEstimateId: es.id
      };
      db.quotations.push(q);
      es.status = 'converted';
      audit(ctx, 'estimate.convert', 'estimate', es.id, 'Converted ' + es.estimateNo + ' to quotation ' + q.quoteNo + '.');
      commit(); return q;
    },

    'catalog.list': function (ctx) { require_(ctx, 'catalog.read'); return db.catalogItems; },
    'catalog.create': function (ctx, p) {
      require_(ctx, 'catalog.manage');
      var item = {
        id: Crypto.id('ci'), name: V.text(p.name, 'Name', 100), code: (p.code || '').trim().toUpperCase(), description: (p.description || '').trim(),
        category: (p.category || '').trim(), unit: p.unit || 'each', defaultQty: Math.max(1, Number(p.defaultQty) || 1),
        unitPrice: Math.max(0, Number(p.unitPrice) || 0), costPrice: Math.max(0, Number(p.costPrice) || 0),
        taxRateId: p.taxRateId || 'tx_zero', active: true
      };
      db.catalogItems.push(item);
      audit(ctx, 'catalog.create', 'catalog_item', item.id, 'Added catalogue item ' + item.name + '.');
      commit(); return item;
    },
    'catalog.setActive': function (ctx, p) {
      require_(ctx, 'catalog.manage');
      var item = find(db.catalogItems, p.id); if (!item) fail('notfound', 'Item not found.');
      item.active = !!p.active;
      audit(ctx, 'catalog.status', 'catalog_item', item.id, (item.active ? 'Activated ' : 'Deactivated ') + item.name + '.');
      commit(); return item;
    },
    'catalog.update': function (ctx, p) {
      require_(ctx, 'catalog.manage');
      var item = find(db.catalogItems, p.id); if (!item) fail('notfound', 'Item not found.');
      item.name = V.text(p.name, 'Name', 100); item.code = (p.code || '').trim().toUpperCase(); item.description = (p.description || '').trim();
      item.category = (p.category || '').trim(); item.description = (p.description || '').trim(); item.unit = p.unit || item.unit; item.defaultQty = Math.max(1, Number(p.defaultQty) || 1);
      item.unitPrice = Math.max(0, Number(p.unitPrice) || 0); item.costPrice = Math.max(0, Number(p.costPrice) || 0); item.taxRateId = p.taxRateId || item.taxRateId;
      audit(ctx, 'catalog.update', 'catalog_item', item.id, 'Updated catalogue item ' + item.name + '.');
      commit(); return item;
    },
    'catalog.delete': function (ctx, p) {
      require_(ctx, 'catalog.manage');
      var item = find(db.catalogItems, p.id); if (!item) fail('notfound', 'Item not found.');
      db.catalogItems = db.catalogItems.filter(function (x) { return x.id !== item.id; });
      audit(ctx, 'catalog.delete', 'catalog_item', p.id, 'Deleted catalogue item ' + item.name + '.');
      commit(); return true;
    },

    'payments.list': function (ctx) {
      require_(ctx, 'invoice.read');
      return db.payments.map(function (pm) { var i = find(db.invoices, pm.invoiceId), c = find(db.customers, pm.customerId), r = find(db.employees, pm.receivedBy); return Object.assign({}, pm, { invoiceNo: i ? i.invoiceNo : '—', customerName: c ? c.name : '—', receivedByName: r ? r.firstName + ' ' + r.lastName : '—' }); }).sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    },
    'receipts.list': function (ctx) {
      require_(ctx, 'invoice.read');
      return db.receipts.map(function (r) { var i = find(db.invoices, r.invoiceId), c = find(db.customers, r.customerId), rb = find(db.employees, r.receivedBy); return Object.assign({}, r, { invoiceNo: i ? i.invoiceNo : '—', customerName: c ? c.name : '—', customerAddress: c ? (c.billingAddress || c.address || '') : '', receivedByName: rb ? rb.firstName + ' ' + rb.lastName : '—' }); }).sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    },

    'commercialSettings.get': function (ctx) { require_(ctx, 'settings.manage'); return db.settings.commercial; },
    'commercialSettings.save': function (ctx, p) {
      require_(ctx, 'settings.manage');
      var c = db.settings.commercial;
      if (p.templates) Object.assign(c.templates, p.templates);
      if (p.paymentDetails) Object.assign(c.paymentDetails, p.paymentDetails);
      audit(ctx, 'commercialSettings.save', 'settings', 'commercial', 'Updated quotations & invoicing settings.');
      commit(); return c;
    },
    'commercialSettings.addTaxRate': function (ctx, p) {
      require_(ctx, 'settings.manage');
      var t = { id: Crypto.id('tx'), name: V.text(p.name, 'Tax name', 40), rate: Math.max(0, Number(p.rate) || 0) };
      db.settings.commercial.taxRates.push(t);
      audit(ctx, 'commercialSettings.taxRate', 'settings', 'commercial', 'Added tax rate ' + t.name + ' (' + t.rate + '%).');
      commit(); return t;
    },

    'commercial.dashboard': function (ctx) {
      require_(ctx, 'report.read');
      var t = todayISO();
      autoExpireQuotations();
      var qs = db.quotations, invs = db.invoices;
      var sent = qs.filter(function (q) { return q.status !== 'draft'; });
      var accepted = qs.filter(function (q) { return q.status === 'accepted'; });
      var months = [];
      for (var m = 5; m >= 0; m--) {
        var dt = new Date(); dt.setMonth(dt.getMonth() - m);
        var key = dt.toISOString().slice(0, 7);
        var invoicedThisMonth = invs.filter(function (i) { return i.issuedAt.slice(0, 7) === key; }).reduce(function (s, i) { return s + i.grandTotal; }, 0);
        var paidThisMonth = db.payments.filter(function (pm) { return pm.date.slice(0, 7) === key; }).reduce(function (s, pm) { return s + pm.amount; }, 0);
        months.push({ month: dt.toLocaleDateString('en-GB', { month: 'short' }), invoiced: invoicedThisMonth, paid: paidThisMonth });
      }
      var upcoming = invs.filter(function (i) { return i.balanceDue > 0 && i.dueDate >= t; }).sort(function (a, b) { return a.dueDate < b.dueDate ? -1 : 1; }).slice(0, 5);
      var overdue = invs.filter(function (i) { return i.balanceDue > 0 && i.dueDate < t; }).sort(function (a, b) { return a.dueDate < b.dueDate ? -1 : 1; });
      var recentQuotes = qs.slice().sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; }).slice(0, 5);
      var recentInvoices = invs.slice().sort(function (a, b) { return a.issuedAt < b.issuedAt ? 1 : -1; }).slice(0, 5);
      var recentPayments = db.payments.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; }).slice(0, 5);
      var withName = function (list) { return list.map(function (x) { var c = find(db.customers, x.customerId); return Object.assign({}, x, { customerName: c ? c.name : '—' }); }); };
      var thisYear = t.slice(0, 4), thisMonth = t.slice(0, 7);
      return {
        totalQuotations: qs.length, awaitingResponse: qs.filter(function (q) { return q.status === 'sent' || q.status === 'viewed'; }).length,
        acceptedQuotations: accepted.length, rejectedQuotations: qs.filter(function (q) { return q.status === 'rejected'; }).length,
        expiredQuotations: qs.filter(function (q) { return q.status === 'expired'; }).length,
        totalQuotationValue: qs.reduce(function (s, q) { return s + q.grandTotal; }, 0),
        conversionRate: sent.length ? Math.round((accepted.length / sent.length) * 100) : 0,
        totalInvoices: invs.length, totalInvoicedAmount: invs.reduce(function (s, i) { return s + i.grandTotal; }, 0),
        totalPaid: invs.reduce(function (s, i) { return s + i.amountPaid; }, 0), outstandingBalance: invs.reduce(function (s, i) { return s + i.balanceDue; }, 0),
        overdueCount: overdue.length, overdueAmount: overdue.reduce(function (s, i) { return s + i.balanceDue; }, 0),
        revenueThisMonth: invs.filter(function (i) { return i.issuedAt.slice(0, 7) === thisMonth; }).reduce(function (s, i) { return s + i.grandTotal; }, 0),
        revenueThisYear: invs.filter(function (i) { return i.issuedAt.slice(0, 4) === thisYear; }).reduce(function (s, i) { return s + i.grandTotal; }, 0),
        monthly: months, upcomingDue: withName(upcoming), overdueInvoices: withName(overdue),
        recentQuotes: withName(recentQuotes), recentInvoices: withName(recentInvoices),
        recentPayments: recentPayments.map(function (pm) { var i = find(db.invoices, pm.invoiceId), c = find(db.customers, pm.customerId); return Object.assign({}, pm, { invoiceNo: i ? i.invoiceNo : '—', customerName: c ? c.name : '—' }); })
      };
    },

    'dev.reset': function () { db = migrate(seed()); Storage.write(db); Storage.writeSession(null); return true; }
  };

  function session() {
    var s = Storage.readSession(); if (!s) return null;
    var u = find(db.users, s.userId); if (!u || u.status !== 'active') { Storage.writeSession(null); return null; }
    return u;
  }

  var api = {
    call: function (method, params) {
      var h = handlers[method];
      if (!h) return { ok: false, error: { code: 'notfound', message: 'Unknown operation: ' + method } };
      var needsAuth = method.indexOf('auth.login') !== 0 && method.indexOf('dev.') !== 0 && method !== 'roles.permissionCatalogue';
      var user = session();
      if (needsAuth && !user) return { ok: false, error: { code: 'auth', message: 'Your session has ended. Please sign in again.' } };
      try {
        return { ok: true, data: h(user ? ctxFor(user) : null, params || {}) };
      } catch (e) {
        return { ok: false, error: { code: e.code || 'error', message: e.message || 'Something went wrong.' } };
      }
    },
    currentContext: function () { var u = session(); return u ? { userId: u.id, employeeId: u.employeeId, roleNames: ctxFor(u).roleNames, permissions: permissionsOf(u), email: u.email } : null; },
    lookups: function () {
      return {
        departments: db.departments.map(function (d) { return { id: d.id, name: d.name }; }),
        roles: db.roles.map(function (r) { return { id: r.id, name: r.name }; }),
        managers: db.employees.map(function (e) { return { id: e.id, name: e.firstName + ' ' + e.lastName + ' — ' + e.positionTitle }; }),
        leaveTypes: db.leaveTypes.map(function (t) { return { id: t.id, name: t.name }; }),
        warehouses: db.warehouses.map(function (w) { return { id: w.id, name: w.name }; }),
        suppliers: db.suppliers.map(function (s) { return { id: s.id, name: s.name }; }),
        rawBatches: db.rawBatches.filter(function (r) { return r.quantity > 0; }).map(function (r) { return { id: r.id, name: r.batchNo + ' — ' + r.species + ' (' + r.quantity + r.unit + ' left)' }; }),
        catalogItems: db.catalogItems.filter(function (c) { return c.active; }).map(function (c) { return { id: c.id, name: c.name, unit: c.unit, unitPrice: c.unitPrice, taxRateId: c.taxRateId, defaultQty: c.defaultQty }; }),
        taxRates: db.settings.commercial.taxRates.map(function (t) { return { id: t.id, name: t.name, rate: t.rate }; }),
        acceptedQuotations: db.quotations.filter(function (q) { return q.status === 'accepted' && !db.invoices.some(function (i) { return i.quotationId === q.id; }); }).map(function (q) { return { id: q.id, name: q.quoteNo + ' — GHS ' + q.grandTotal.toLocaleString() }; }),
        unpaidInvoices: db.invoices.filter(function (i) { return i.balanceDue > 0; }).map(function (i) { return { id: i.id, name: i.invoiceNo + ' — balance GHS ' + i.balanceDue.toLocaleString() }; }),
        products: db.products.map(function (p) { return { id: p.id, name: p.sku + ' — ' + p.name }; }),
        assets: db.assets.map(function (a) { return { id: a.id, name: a.assetNo + ' — ' + a.description }; }),
        customers: db.customers.map(function (c) { return { id: c.id, name: c.name }; }),
        quotations: db.quotations.filter(function (q) { return q.status === 'accepted'; }).map(function (q) { return { id: q.id, name: q.quoteNo + ' — GHS ' + q.total.toLocaleString() }; }),
        salesOrders: db.salesOrders.map(function (o) { return { id: o.id, name: o.orderNo }; }),
        demoAccounts: [
          { email: 'kelvin.duho@bplghana.com', role: 'System Administrator' },
          { email: 'andy.chou@bplghana.com', role: 'Executive (MD)' },
          { email: 'albert.awini@bplghana.com', role: 'Finance & HR Manager' },
          { email: 'frank.kampewu@bplghana.com', role: 'General Manager' },
          { email: 'isreal.omozuafo@bplghana.com', role: 'Production Manager' },
          { email: 'emmanuel.chang@bplghana.com', role: 'IT Manager' },
          { email: 'alice.kamau@bplghana.com', role: 'Employee' }
        ]
      };
    },
    schemaVersion: function () { return db.meta.schemaVersion; }
  };

  window.BambooKernel = api;
})();
