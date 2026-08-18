#!/usr/bin/env node
/*
 * Ports kernel.js's seed() (+ the parts of MIGRATIONS that shape the final
 * seed dataset, e.g. the Information Technology department and its head)
 * into real Postgres rows. Dev-only: TRUNCATEs every app table first, exactly
 * like the prototype's `BambooKernel.call('dev.reset')`.
 *
 * Run with: npm run seed
 */
var bcrypt = require('bcrypt');
var crypto = require('crypto');
var config = require('../config');
var { pool, withTransaction } = require('./pool');
var { PERMISSIONS, ROLE_DEFS, defaultSettingsRow } = require('./referenceData');

function uuid() { return crypto.randomUUID(); }

// ── departments (final state incl. Information Technology from migration 17) ─
var DEPT_DEFS = [
  { key: 'd_exec', code: 'EXE', name: 'Executive Office', managerKey: 'e_002' },
  { key: 'd_hr', code: 'HRA', name: 'Human Resources & Admin', managerKey: 'e_003' },
  { key: 'd_fin', code: 'FIN', name: 'Finance', managerKey: 'e_003' },
  { key: 'd_prod', code: 'PRD', name: 'Production', managerKey: 'e_011' },
  { key: 'd_raw', code: 'RAW', name: 'Harvesting & Raw Bamboo', managerKey: 'e_006' },
  { key: 'd_qc', code: 'QCL', name: 'Quality Control', managerKey: 'e_007' },
  { key: 'd_sal', code: 'SAL', name: 'Sales & Marketing', managerKey: 'e_008' },
  { key: 'd_log', code: 'LOG', name: 'Logistics & Warehouse', managerKey: 'e_009' },
  { key: 'd_mnt', code: 'MNT', name: 'Maintenance & Engineering', managerKey: 'e_010' },
  { key: 'd_it', code: 'ITD', name: 'Information Technology', managerKey: 'e_019' }
];

// ── employees + users (final state, verbatim from kernel.js seed()'s E array) ─
// [key, code, firstName, lastName, deptKey, positionTitle, managerKey, roleKey, hireDate]
var E = [
  ['e_001', 'BPL-001', 'Kelvin', 'Duho', 'd_hr', 'IT & Systems Administrator', 'e_003', 'administrator', '2019-03-04'],
  ['e_002', 'BPL-002', 'Andy', 'Chou', 'd_exec', 'Managing Director', null, 'executive', '2015-01-12'],
  ['e_003', 'BPL-003', 'Albert', 'Awini', 'd_hr', 'Finance & HR Manager', 'e_002', 'finance_hr_manager', '2017-06-19'],
  ['e_004', 'BPL-004', 'Peter', 'Njoroge', 'd_fin', 'Finance Manager', 'e_003', 'department_manager', '2018-02-05'],
  ['e_005', 'BPL-005', 'Frank', 'Kampewu', 'd_prod', 'General Manager', 'e_002', 'general_manager', '2016-09-01'],
  ['e_006', 'BPL-006', 'Samuel', 'Kiptoo', 'd_raw', 'Raw Material Manager', 'e_002', 'department_manager', '2018-11-13'],
  ['e_007', 'BPL-007', 'Faith', 'Wanjiru', 'd_qc', 'Quality Assurance Manager', 'e_005', 'department_manager', '2019-07-22'],
  ['e_008', 'BPL-008', 'Daniel', 'Omondi', 'd_sal', 'Sales & Marketing Manager', 'e_002', 'department_manager', '2017-04-03'],
  ['e_009', 'BPL-009', 'Esther', 'Chebet', 'd_log', 'Warehouse & Logistics Manager', 'e_002', 'department_manager', '2020-01-20'],
  ['e_010', 'BPL-010', 'Brian', 'Mutua', 'd_mnt', 'Maintenance Engineer', 'e_002', 'department_manager', '2019-10-07'],
  ['e_011', 'BPL-011', 'Isreal', 'Omozuafo', 'd_prod', 'Production Manager', 'e_002', 'department_manager', '2021-02-15'],
  ['e_012', 'BPL-012', 'Kevin', 'Barasa', 'd_prod', 'Treatment Line Supervisor', 'e_011', 'supervisor', '2021-05-04'],
  ['e_013', 'BPL-013', 'Alice', 'Kamau', 'd_prod', 'Machine Operator', 'e_011', 'employee', '2022-03-01'],
  ['e_014', 'BPL-014', 'John', 'Sitati', 'd_prod', 'Machine Operator', 'e_012', 'employee', '2022-08-16'],
  ['e_015', 'BPL-015', 'Lydia', 'Auma', 'd_qc', 'Quality Inspector', 'e_007', 'employee', '2023-01-09'],
  ['e_016', 'BPL-016', 'Moses', 'Wekesa', 'd_raw', 'Harvest Team Lead', 'e_006', 'supervisor', '2021-11-02'],
  ['e_017', 'BPL-017', 'Christine', 'Adhiambo', 'd_log', 'Store Clerk', 'e_009', 'employee', '2023-06-12'],
  ['e_018', 'BPL-018', 'Victor', 'Maina', 'd_sal', 'Sales Executive', 'e_008', 'employee', '2022-10-24'],
  ['e_019', 'BPL-019', 'Emmanuel', 'Chang', 'd_it', 'Head of IT Department', 'e_002', 'it_manager', '2020-04-06']
];

var LEAVE_TYPE_DEFS = [
  { key: 'lt_annual', name: 'Annual leave', daysPerYear: 21, paid: true },
  { key: 'lt_sick', name: 'Sick leave', daysPerYear: 14, paid: true },
  { key: 'lt_comp', name: 'Compassionate leave', daysPerYear: 5, paid: true },
  { key: 'lt_unpaid', name: 'Unpaid leave', daysPerYear: 0, paid: false },
  { key: 'lt_mat', name: 'Maternity / paternity', daysPerYear: 90, paid: true }
];

function ds(offset) { return new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10); }
function businessDays(a, b) {
  var s = new Date(a + 'T00:00'), e = new Date(b + 'T00:00'), n = 0;
  if (e < s) return 0;
  while (s <= e) { if (s.getDay() !== 0) n++; s = new Date(s.getTime() + 86400000); }
  return n;
}

async function truncateAll(client) {
  var res = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename != 'schema_migrations'"
  );
  var tables = res.rows.map(function (r) { return '"' + r.tablename + '"'; });
  if (!tables.length) return;
  await client.query('TRUNCATE TABLE ' + tables.join(', ') + ' RESTART IDENTITY CASCADE');
}

async function run() {
  await withTransaction(async function (client) {
    console.log('Truncating existing data...');
    await truncateAll(client);

    console.log('Seeding permission catalogue...');
    for (var i = 0; i < PERMISSIONS.length; i++) {
      var p = PERMISSIONS[i];
      await client.query('INSERT INTO permissions (key, "group", label) VALUES ($1, $2, $3)', [p.key, p.group, p.label]);
    }

    console.log('Seeding roles...');
    var roleIds = {};
    for (i = 0; i < ROLE_DEFS.length; i++) {
      var r = ROLE_DEFS[i];
      var id = uuid();
      roleIds[r.key] = id;
      await client.query(
        'INSERT INTO roles (id, key, name, is_system, description) VALUES ($1, $2, $3, true, $4)',
        [id, r.key, r.name, r.description]
      );
      for (var j = 0; j < r.permissions.length; j++) {
        await client.query('INSERT INTO role_permissions (role_id, permission_key) VALUES ($1, $2)', [id, r.permissions[j]]);
      }
    }

    console.log('Seeding departments...');
    var deptIds = {};
    DEPT_DEFS.forEach(function (d) { deptIds[d.key] = uuid(); });
    for (i = 0; i < DEPT_DEFS.length; i++) {
      var d = DEPT_DEFS[i];
      await client.query(
        'INSERT INTO departments (id, code, name, manager_id, status) VALUES ($1, $2, $3, NULL, $4)',
        [deptIds[d.key], d.code, d.name, 'active']
      );
    }
    // manager_id references employees, which don't exist yet — inserted NULL
    // above, patched once employee ids are known (see the UPDATE loop below).

    console.log('Seeding employees + users...');
    var empIds = {}; E.forEach(function (r) { empIds[r[0]] = uuid(); });
    var passwordHash = await bcrypt.hash('bamboo123', config.bcryptRounds);
    var userIds = {};
    for (i = 0; i < E.length; i++) {
      var row = E[i];
      var key = row[0], code = row[1], firstName = row[2], lastName = row[3], deptKey = row[4], title = row[5], managerKey = row[6], roleKey = row[7], hireDate = row[8];
      var email = (firstName + '.' + lastName).toLowerCase() + '@bplghana.com';
      var phone = '+233 24' + (1000000 + i * 4321).toString().slice(0, 7);
      var location = 'Tema Plant';
      var shift = deptKey === 'd_prod' ? 'Shift A · 06:00–14:00' : 'Day · 08:00–17:00';
      await client.query(
        'INSERT INTO employees (id, code, first_name, last_name, email, phone, department_id, position_title, manager_id, employment_type, hire_date, status, location, shift) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
        [empIds[key], code, firstName, lastName, email, phone, deptIds[deptKey], title, managerKey ? empIds[managerKey] : null, 'permanent', hireDate, 'active', location, shift]
      );
      var uid = uuid();
      userIds[key] = uid;
      await client.query(
        'INSERT INTO users (id, employee_id, email, password_hash, status, must_change_password) VALUES ($1,$2,$3,$4,$5,false)',
        [uid, empIds[key], email, passwordHash, 'active']
      );
      await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [uid, roleIds[roleKey]]);
    }

    // now that employees exist, fix up department manager_id (FK is deferred so
    // the earlier inserts were fine, but we inserted a placeholder — correct it)
    for (i = 0; i < DEPT_DEFS.length; i++) {
      var dd = DEPT_DEFS[i];
      if (dd.managerKey) {
        await client.query('UPDATE departments SET manager_id = $1 WHERE id = $2', [empIds[dd.managerKey], deptIds[dd.key]]);
      }
    }

    console.log('Seeding leave types + balances...');
    var leaveTypeIds = {}; LEAVE_TYPE_DEFS.forEach(function (t) { leaveTypeIds[t.key] = uuid(); });
    for (i = 0; i < LEAVE_TYPE_DEFS.length; i++) {
      var t = LEAVE_TYPE_DEFS[i];
      await client.query('INSERT INTO leave_types (id, name, days_per_year, paid) VALUES ($1,$2,$3,$4)', [leaveTypeIds[t.key], t.name, t.daysPerYear, t.paid]);
    }
    var year = new Date().getFullYear();
    for (i = 0; i < E.length; i++) {
      var empKey = E[i][0];
      for (j = 0; j < LEAVE_TYPE_DEFS.length; j++) {
        var lt = LEAVE_TYPE_DEFS[j];
        var used = lt.key === 'lt_annual' ? (i * 3) % 11 : 0;
        await client.query(
          'INSERT INTO leave_balances (id, employee_id, leave_type_id, year, entitled, used) VALUES ($1,$2,$3,$4,$5,$6)',
          [uuid(), empIds[empKey], leaveTypeIds[lt.key], year, lt.daysPerYear, used]
        );
      }
    }

    console.log('Seeding demo leave requests + approvals...');
    var leaveRequestDefs = [
      { key: 'lr_1', empKey: 'e_013', typeKey: 'lt_annual', start: ds(6), end: ds(10), days: 5, reason: 'Family visit upcountry.', status: 'pending', createdAt: ds(-1) + 'T09:12', decidedByKey: null, decisionNote: '' },
      { key: 'lr_2', empKey: 'e_015', typeKey: 'lt_sick', start: ds(-2), end: ds(-1), days: 2, reason: 'Medical certificate attached.', status: 'approved', createdAt: ds(-3) + 'T16:40', decidedByKey: 'e_007', decisionNote: 'Approved, get well.' },
      { key: 'lr_3', empKey: 'e_017', typeKey: 'lt_annual', start: ds(14), end: ds(20), days: 7, reason: 'Annual break.', status: 'pending', createdAt: ds(0) + 'T08:02', decidedByKey: null, decisionNote: '' },
      { key: 'lr_4', empKey: 'e_014', typeKey: 'lt_unpaid', start: ds(3), end: ds(4), days: 2, reason: 'Personal matters.', status: 'rejected', createdAt: ds(-4) + 'T11:20', decidedByKey: 'e_005', decisionNote: 'Line is short-staffed that week.' }
    ];
    var leaveRequestIds = {};
    for (i = 0; i < leaveRequestDefs.length; i++) {
      var lr = leaveRequestDefs[i];
      var lrId = uuid();
      leaveRequestIds[lr.key] = lrId;
      var decidedAt = lr.decidedByKey ? lr.createdAt : null;
      await client.query(
        'INSERT INTO leave_requests (id, employee_id, leave_type_id, start_date, end_date, days, reason, status, created_at, decided_by, decided_at, decision_note) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [lrId, empIds[lr.empKey], leaveTypeIds[lr.typeKey], lr.start, lr.end, lr.days, lr.reason, lr.status, lr.createdAt, lr.decidedByKey ? empIds[lr.decidedByKey] : null, decidedAt, lr.decisionNote]
      );
      if (lr.status === 'approved') {
        await client.query(
          'UPDATE leave_balances SET used = used + $1 WHERE employee_id = $2 AND leave_type_id = $3 AND year = $4',
          [lr.days, empIds[lr.empKey], leaveTypeIds[lr.typeKey], year]
        );
      }
      if (lr.status === 'pending') {
        var empDeptId = null;
        for (j = 0; j < E.length; j++) { if (E[j][0] === lr.empKey) { empDeptId = deptIds[E[j][4]]; break; } }
        await client.query(
          'INSERT INTO approvals (id, subject_type, subject_id, title, requested_by, assignee_permission, department_id, status, created_at) ' +
          "VALUES ($1,'leave_request',$2,'Leave request',$3,'leave.approve',$4,'pending',$5)",
          [uuid(), lrId, empIds[lr.empKey], empDeptId, lr.createdAt]
        );
      }
    }

    console.log('Seeding operations demo data (warehouses, suppliers, raw batches, products)...');
    var relDate = function (offset) { return new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10); };
    var whIds = { wh_1: uuid(), wh_2: uuid(), wh_3: uuid() };
    var warehouseDefs = [
      { key: 'wh_1', code: 'WH-RAW', name: 'Tema Raw Materials Store', location: 'Tema Plant' },
      { key: 'wh_2', code: 'WH-FG', name: 'Tema Finished Goods Warehouse', location: 'Tema Plant' },
      { key: 'wh_3', code: 'WH-ACC', name: 'Accra Distribution Store', location: 'Accra Office' }
    ];
    for (i = 0; i < warehouseDefs.length; i++) {
      var wd = warehouseDefs[i];
      await client.query('INSERT INTO warehouses (id, code, name, location) VALUES ($1,$2,$3,$4)', [whIds[wd.key], wd.code, wd.name, wd.location]);
    }

    var supIds = { sup_1: uuid(), sup_2: uuid(), sup_3: uuid() };
    var supplierDefs = [
      { key: 'sup_1', name: 'Ashanti Bamboo Growers Co-op', contactPerson: 'James Owusu', phone: '+233 24 210 0200', email: 'sales@ashantibamboo.com.gh', address: 'Ejisu, Ashanti Region', materialsSupplied: 'Raw bamboo poles (Bambusa vulgaris)' },
      { key: 'sup_2', name: 'Volta Bamboo Suppliers Ltd', contactPerson: 'Grace Adjei', phone: '+233 20 344 5566', email: 'info@voltabamboo.com.gh', address: 'Ho, Volta Region', materialsSupplied: 'Raw bamboo poles (Oxytenanthera abyssinica)' },
      { key: 'sup_3', name: 'GhanaPoly Packaging Ltd', contactPerson: 'Peter Owusu', phone: '+233 27 199 8877', email: 'orders@ghanapoly.com.gh', address: 'Tema Industrial Area', materialsSupplied: 'Packaging materials, shrink wrap' }
    ];
    for (i = 0; i < supplierDefs.length; i++) {
      var sd = supplierDefs[i];
      await client.query(
        "INSERT INTO suppliers (id, name, contact_person, phone, email, address, materials_supplied, payment_terms, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'Net 30','active')",
        [supIds[sd.key], sd.name, sd.contactPerson, sd.phone, sd.email, sd.address, sd.materialsSupplied]
      );
    }

    var rawBatchDefs = [
      { batchNo: 'RB-2026-041', species: 'Bambusa vulgaris', supplierKey: 'sup_1', dateReceived: relDate(-12), quantity: 3000, unit: 'kg', qualityGrade: 'A', cost: 210000, warehouseKey: 'wh_1' },
      { batchNo: 'RB-2026-042', species: 'Oxytenanthera abyssinica', supplierKey: 'sup_2', dateReceived: relDate(-6), quantity: 2500, unit: 'kg', qualityGrade: 'B', cost: 124000, warehouseKey: 'wh_1' },
      { batchNo: 'RB-2026-043', species: 'Bambusa vulgaris', supplierKey: 'sup_1', dateReceived: relDate(-2), quantity: 2800, unit: 'kg', qualityGrade: 'A', cost: 140000, warehouseKey: 'wh_1' }
    ];
    for (i = 0; i < rawBatchDefs.length; i++) {
      var rbd = rawBatchDefs[i];
      await client.query(
        "INSERT INTO raw_batches (batch_no, species, supplier_id, date_received, quantity, unit, quality_grade, cost, warehouse_id, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'in_stock')",
        [rbd.batchNo, rbd.species, supIds[rbd.supplierKey], rbd.dateReceived, rbd.quantity, rbd.unit, rbd.qualityGrade, rbd.cost, whIds[rbd.warehouseKey]]
      );
    }

    var productDefs = [
      { sku: 'BPL-FLR-001', name: 'Bamboo Flooring Plank 1.2m', category: 'Flooring', unit: 'plank', costPrice: 850, sellingPrice: 1400, currentStock: 640, reorderLevel: 200 },
      { sku: 'BPL-FUR-010', name: 'Bamboo Bar Stool', category: 'Furniture', unit: 'piece', costPrice: 1800, sellingPrice: 3200, currentStock: 38, reorderLevel: 50 },
      { sku: 'BPL-SKW-100', name: 'BBQ Skewer Pack (50pc)', category: 'Kitchenware', unit: 'pack', costPrice: 90, sellingPrice: 180, currentStock: 1250, reorderLevel: 300 },
      { sku: 'BPL-PNL-020', name: 'Woven Bamboo Wall Panel', category: 'Décor', unit: 'panel', costPrice: 1200, sellingPrice: 2100, currentStock: 22, reorderLevel: 40 }
    ];
    for (i = 0; i < productDefs.length; i++) {
      var pd = productDefs[i];
      await client.query(
        'INSERT INTO products (sku, name, category, unit, cost_price, selling_price, current_stock, reorder_level) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [pd.sku, pd.name, pd.category, pd.unit, pd.costPrice, pd.sellingPrice, pd.currentStock, pd.reorderLevel]
      );
    }

    console.log('Seeding company settings...');
    var s = defaultSettingsRow();
    await client.query(
      'INSERT INTO settings (id, company_name, short_name, country, currency, timezone, fiscal_year_start, work_week, standard_hours, late_after, plants, leave_approval_chain, integrations, commercial) ' +
      'VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
      [s.companyName, s.shortName, s.country, s.currency, s.timezone, s.fiscalYearStart, s.workWeek, s.standardHours, s.lateAfter, s.plants, s.leaveApprovalChain, JSON.stringify(s.integrations), JSON.stringify(s.commercial)]
    );

    console.log('Writing seed audit log entry...');
    await client.query(
      "INSERT INTO audit_logs (id, actor_user_id, actor_name, action, entity, entity_id, summary) VALUES ($1, NULL, 'System', 'system.seed', 'database', '-', 'Database initialised and seeded.')",
      [uuid()]
    );
  });

  console.log('Seed complete. Demo accounts (password "bamboo123" for all, @bplghana.com):');
  console.log('  kelvin.duho (System Administrator), andy.chou (Executive/MD), albert.awini (Finance & HR Manager),');
  console.log('  frank.kampewu (General Manager), isreal.omozuafo (Production Manager), emmanuel.chang (IT Manager), alice.kamau (Employee)');
}

run()
  .then(function () { console.log('Done.'); pool.end(); })
  .catch(function (err) { console.error('Seed failed:', err); pool.end(); process.exit(1); });
