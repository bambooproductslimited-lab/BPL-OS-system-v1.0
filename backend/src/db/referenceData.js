// Single source of truth for the data every deployment needs regardless of
// whether it's a throwaway dev database (seed.js, which wipes everything and
// adds fake people/customers/quotations on top of this) or a real production
// one (bootstrap.js, which only ever adds this and one real admin account —
// never demo data, never a TRUNCATE). Both require() this file so the
// permission catalogue, role definitions, and default company settings can
// never drift between the two paths.

// ── permission catalogue (verbatim from kernel.js PERMISSIONS) ──────────────
var PERMISSIONS = [
  { key: 'employee.read', group: 'People', label: 'View employee records' },
  { key: 'employee.write', group: 'People', label: 'Create & edit employees' },
  { key: 'employee.read.all', group: 'People', label: 'View all departments' },
  { key: 'department.manage', group: 'People', label: 'Manage departments' },
  { key: 'role.manage', group: 'Access', label: 'Manage roles & permissions' },
  { key: 'user.manage', group: 'Access', label: 'Manage user accounts' },
  { key: 'user.create', group: 'Access', label: 'Create user accounts & set passwords' },
  { key: 'payroll.read', group: 'Finance', label: 'View pay runs & payslips' },
  { key: 'payroll.manage', group: 'Finance', label: 'Set employee pay rates, run & approve payroll' },
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
  { key: 'itdevice.read', group: 'Assets', label: 'View IT device inventory' },
  { key: 'itdevice.manage', group: 'Assets', label: 'Manage IT device inventory' },
  { key: 'waybill.read', group: 'Logistics', label: 'View waybills' },
  { key: 'waybill.manage', group: 'Logistics', label: 'Create & manage waybills' },
  { key: 'toolroom.read', group: 'Inventory', label: 'View tool room inventory' },
  { key: 'toolroom.manage', group: 'Inventory', label: 'Manage tool room inventory' },
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
  { key: 'report.manage', group: 'Finance', label: 'Edit balance sheet manual inputs (cash, loans, equity)' },
  { key: 'catalog.read', group: 'Commercial', label: 'View products & services catalogue' },
  { key: 'catalog.manage', group: 'Commercial', label: 'Manage products & services catalogue' },
  { key: 'marketing.read', group: 'Marketing', label: 'View the social & campaign tracker' },
  { key: 'marketing.manage', group: 'Marketing', label: 'Manage channels, campaigns & posts' }
];
var ALL = PERMISSIONS.map(function (p) { return p.key; });

// ── roles (verbatim from kernel.js seed(), final state incl. all 12 roles) ──
var ROLE_DEFS = [
  { key: 'administrator', name: 'System Administrator', description: 'Full access to every module and setting.', permissions: ALL.slice() },
  { key: 'executive', name: 'Executive (MD)', description: 'Company-wide read access plus final approvals.', permissions: ['employee.read', 'employee.read.all', 'attendance.read.all', 'leave.read.all', 'leave.approve', 'task.read', 'project.read', 'project.manage', 'announcement.publish', 'document.read', 'approval.act', 'audit.read', 'settings.manage', 'production.read', 'inventory.read', 'supplier.read', 'procurement.read.all', 'asset.read', 'customer.read', 'quotation.read', 'sales.read', 'invoice.read', 'expense.read.all', 'report.read', 'catalog.read', 'waybill.read', 'toolroom.read', 'itdevice.read', 'payroll.read', 'marketing.read'] },
  { key: 'hr_manager', name: 'HR Manager', description: 'Owns people data, attendance and the leave process.', permissions: ['employee.read', 'employee.read.all', 'employee.write', 'department.manage', 'user.manage', 'attendance.self', 'attendance.read.all', 'attendance.adjust', 'leave.request', 'leave.read.all', 'leave.approve', 'approval.act', 'task.read', 'task.manage', 'project.read', 'announcement.publish', 'document.read', 'document.manage', 'audit.read', 'asset.read', 'payroll.read', 'payroll.manage'] },
  { key: 'department_manager', name: 'Department Manager', description: 'Manages one department: its people, attendance, leave and work.', permissions: ['employee.read', 'attendance.self', 'attendance.read.all', 'leave.request', 'leave.read.all', 'leave.approve', 'approval.act', 'task.read', 'task.manage', 'project.read', 'project.manage', 'document.read', 'document.manage', 'catalog.read', 'catalog.manage', 'customer.read', 'customer.manage', 'quotation.read', 'quotation.manage', 'sales.read', 'sales.manage', 'invoice.read', 'invoice.manage', 'expense.request', 'expense.approve', 'expense.read.all', 'report.read', 'production.read', 'production.manage', 'inventory.read', 'inventory.manage', 'warehouse.manage', 'supplier.read', 'supplier.manage', 'procurement.request', 'procurement.approve', 'asset.read', 'asset.manage', 'waybill.read', 'waybill.manage', 'toolroom.read', 'toolroom.manage'] },
  { key: 'supervisor', name: 'Line Supervisor', description: 'Shift-floor supervision: attendance visibility and task assignment.', permissions: ['employee.read', 'attendance.self', 'attendance.read.all', 'leave.request', 'task.read', 'task.manage', 'project.read', 'document.read', 'catalog.read', 'customer.read', 'quotation.read', 'sales.read', 'expense.request', 'production.read', 'inventory.read', 'asset.read', 'waybill.read', 'toolroom.read'] },
  { key: 'employee', name: 'Employee', description: 'Self-service only: own record, attendance, leave and tasks.', permissions: ['employee.read', 'attendance.self', 'leave.request', 'task.read', 'project.read', 'document.read', 'expense.request', 'procurement.request'] },
  { key: 'marketing_manager', name: 'Marketing Manager', description: 'Owns customers, quotations, sales pipeline and marketing insights.', permissions: ['employee.read', 'attendance.self', 'leave.request', 'task.read', 'task.manage', 'project.read', 'document.read', 'customer.read', 'customer.manage', 'quotation.read', 'quotation.manage', 'sales.read', 'sales.manage', 'catalog.read', 'report.read', 'marketing.read', 'marketing.manage'] },
  { key: 'finance_manager', name: 'Finance Manager', description: 'Owns invoicing, payments, expense approvals and financial reporting.', permissions: ['employee.read', 'attendance.self', 'leave.request', 'task.read', 'project.read', 'document.read', 'invoice.read', 'invoice.manage', 'expense.request', 'expense.approve', 'expense.read.all', 'report.read', 'report.manage', 'procurement.approve', 'settings.manage', 'payroll.read', 'payroll.manage'] },
  { key: 'customer_service_manager', name: 'Customer Service Manager', description: 'Owns customer relationships and order/service follow-up.', permissions: ['employee.read', 'attendance.self', 'leave.request', 'task.read', 'task.manage', 'project.read', 'document.read', 'customer.read', 'customer.manage', 'quotation.read', 'sales.read', 'invoice.read'] },
  { key: 'it_manager', name: 'IT Manager', description: 'Owns company assets, user accounts and system administration support.', permissions: ['employee.read', 'attendance.self', 'leave.request', 'task.read', 'task.manage', 'project.read', 'document.read', 'document.manage', 'asset.read', 'asset.manage', 'user.manage', 'audit.read', 'catalog.read', 'itdevice.read', 'itdevice.manage'] },
  { key: 'finance_hr_manager', name: 'Finance & HR Manager', description: 'Combined Finance Manager and HR Manager responsibilities.', permissions: ['employee.read', 'employee.read.all', 'employee.write', 'department.manage', 'user.manage', 'attendance.self', 'attendance.read.all', 'attendance.adjust', 'leave.request', 'leave.read.all', 'leave.approve', 'approval.act', 'task.read', 'task.manage', 'project.read', 'announcement.publish', 'document.read', 'document.manage', 'audit.read', 'invoice.read', 'invoice.manage', 'expense.request', 'expense.approve', 'expense.read.all', 'report.read', 'report.manage', 'procurement.approve', 'settings.manage', 'payroll.read', 'payroll.manage'] },
  { key: 'general_manager', name: 'General Manager', description: 'Company-wide operational oversight across all departments — broader than a department manager, more hands-on than the MD.', permissions: ['employee.read', 'employee.read.all', 'employee.write', 'attendance.self', 'attendance.read.all', 'attendance.adjust', 'leave.request', 'leave.read.all', 'leave.approve', 'approval.act', 'task.read', 'task.manage', 'project.read', 'project.manage', 'announcement.publish', 'document.read', 'document.manage', 'production.read', 'inventory.read', 'supplier.read', 'procurement.approve', 'asset.read', 'customer.read', 'quotation.read', 'sales.read', 'invoice.read', 'expense.approve', 'expense.read.all', 'report.read', 'audit.read', 'catalog.read', 'waybill.read', 'toolroom.read', 'itdevice.read', 'payroll.read', 'marketing.read'] }
];

// ── default company settings row (id=1) — Bamboo Products Limited's real
// configuration, not sample data: real Ghana tax categories (VAT/NHIL/
// GETFund/WHT), GHS currency, the company's own name. Both seed.js and
// bootstrap.js insert this row verbatim; only the demo employees/customers/
// documents layered on top by seed.js are fake.
function defaultIntegrations() {
  return [
    { id: 'timestation', name: 'TimeStation', category: 'Attendance', description: 'Sync biometric/kiosk clock-in data into Attendance.', connected: false, apiKey: '' },
    { id: 'squareup', name: 'Square', category: 'Payments & POS', description: 'Sync Square payments and orders with Invoices & Payments.', connected: false, apiKey: '' },
    { id: 'slack', name: 'Slack', category: 'Notifications', description: 'Send approval and announcement alerts to a Slack channel.', connected: false, apiKey: '' },
    { id: 'quickbooks', name: 'QuickBooks', category: 'Accounting', description: 'Sync invoices and expenses with QuickBooks.', connected: false, apiKey: '' },
    { id: 'facebook', name: 'Facebook', category: 'Marketing', description: 'Pull page post reach, engagement and follower counts into the social tracker (requires a Meta developer app + Page access token).', connected: false, apiKey: '' },
    { id: 'instagram', name: 'Instagram', category: 'Marketing', description: 'Pull post/reel engagement and follower counts into the social tracker (requires a Meta developer app + Instagram professional account link).', connected: false, apiKey: '' },
    { id: 'tiktok', name: 'TikTok', category: 'Marketing', description: 'Pull video views and engagement into the social tracker (requires a TikTok for Business developer app).', connected: false, apiKey: '' },
    { id: 'whatsappbusiness', name: 'WhatsApp Business', category: 'Marketing', description: 'Track broadcast/catalogue activity in the social tracker (requires the WhatsApp Business Cloud API).', connected: false, apiKey: '' },
    { id: 'googleanalytics', name: 'Google Analytics', category: 'Marketing', description: 'Pull website visits into the social tracker’s Website channel (requires a GA4 property + service account).', connected: false, apiKey: '' },
    { id: 'youtube', name: 'YouTube', category: 'Marketing', description: 'Pull video views and engagement into the social tracker (requires a Google Cloud project with the YouTube Data API enabled).', connected: false, apiKey: '' },
    { id: 'twitch', name: 'Twitch', category: 'Marketing', description: 'Pull follower counts and recent VODs into the social tracker (requires a Twitch developer application).', connected: false, apiKey: '' },
    { id: 'linkedin', name: 'LinkedIn Page', category: 'Marketing', description: 'Track Company Page follower counts and posts (requires LinkedIn Community Management API partner access — application/approval required, not self-serve).', connected: false, apiKey: '' }
  ];
}
function defaultCommercial() {
  return {
    currencies: ['GHS', 'USD', 'EUR', 'GBP'],
    taxRates: [
      { id: 'tx_vat', name: 'VAT', rate: 15 },
      { id: 'tx_nhil', name: 'NHIL', rate: 2.5 },
      { id: 'tx_getfund', name: 'GETFund', rate: 2.5 },
      { id: 'tx_wht', name: 'Withholding Tax', rate: 5 },
      { id: 'tx_zero', name: 'Zero-rated', rate: 0 }
    ],
    numbering: {
      estimate: { prefix: 'EST', padding: 4, includeYear: true, nextNumber: 1 },
      quotation: { prefix: 'QT', padding: 4, includeYear: true, nextNumber: 1 },
      invoice: { prefix: 'INV', padding: 4, includeYear: true, nextNumber: 1 },
      receipt: { prefix: 'RCT', padding: 4, includeYear: true, nextNumber: 1 },
      waybill: { prefix: 'WB', padding: 4, includeYear: true, nextNumber: 1 },
      payrun: { prefix: 'PR', padding: 4, includeYear: true, nextNumber: 1 }
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
}
// Starting Ghana statutory payroll rates — SSNIT contribution split
// (5.5% employee / 13% employer of gross) and monthly PAYE income tax
// bands (the standard GRA "first X @0%, next Y @5%, ..." table, stored as
// band widths so a shorter pay period can prorate them — see
// payroll.service.js's computePaye()). These are a starting configuration,
// NOT guaranteed current law — verify against the latest GRA/SSNIT
// circulars (rates and bands are revised periodically) before relying on
// this for real statutory filings, and correct them here via Company
// Settings if they've changed; nothing else needs to change.
function defaultPayroll() {
  return {
    ssnitEmployeeRate: 5.5,
    ssnitEmployerRate: 13,
    payeBands: [
      { width: 490, rate: 0 },
      { width: 110, rate: 5 },
      { width: 130, rate: 10 },
      { width: 3166.67, rate: 17.5 },
      { width: 16000, rate: 25 },
      { width: 30520, rate: 30 },
      { width: null, rate: 35 }
    ]
  };
}

// Manual inputs for the Balance Sheet's Cash & bank / Liabilities / Equity
// lines — there's no general ledger or cash book in this system, so these
// can't be computed from transactional data the way Accounts Receivable,
// inventory value and fixed assets (at cost) are. Finance enters/updates
// these from Company Settings; everything else on the Balance Sheet is
// computed live. See reports.service.js's balanceSheet().
function defaultBalanceSheet() {
  return { cashAndBank: 0, accountsPayable: 0, loansPayable: 0, otherLiabilities: 0, ownersEquity: 0, notes: '' };
}

function defaultSettingsRow() {
  return {
    companyName: 'Bamboo Products Limited', shortName: 'BPL', country: 'Ghana', currency: 'GHS',
    timezone: 'Africa/Accra', fiscalYearStart: '01-01', workWeek: 'Mon–Sat', standardHours: 8, lateAfter: '07:20',
    plants: ['Tema Plant', 'Accra Office'], leaveApprovalChain: ['department_manager', 'hr_manager'],
    integrations: defaultIntegrations(), commercial: defaultCommercial(), payroll: defaultPayroll(), balanceSheet: defaultBalanceSheet()
  };
}

module.exports = { PERMISSIONS: PERMISSIONS, ROLE_DEFS: ROLE_DEFS, defaultSettingsRow: defaultSettingsRow };
