import { msg } from '../lib/i18n.jsx';

// Ported from Bamboo OS.dc.html's navModel() — same grouping, labels, and
// permission gates (item.perm), so the sidebar structure matches the
// prototype's intended design exactly. `key` doubles as the route path
// segment. Screens not yet built render a "Coming soon" placeholder (see
// AppShell) rather than being left out of the nav — the shape of the app is
// part of what this pass is establishing.
// `icon` names a shared path in layout/navIcons.jsx (AppShell's <Icon>).
// `hidden: true` keeps an item's route and page title but leaves it out of
// the sidebar (a page reached from links and notifications only).
//
// Labels are wrapped in msg(), not tr(): this list is built once, when the
// module loads, and a tr() here would fix the sidebar in whatever language
// was active at that moment. AppShell translates them as it renders.
export const NAV_GROUPS = [
  { label: msg('Overview'), items: [
    { key: 'dashboard', label: msg('Dashboard'), icon: 'home' },
    { key: 'myspace', label: msg('My space'), icon: 'user' },
    // The quarter's objectives and key results, open to everyone (pages/GoalsPage.jsx).
    { key: 'goals', label: msg('Goals'), icon: 'target' }
  ] },
  { label: msg('People'), items: [
    { key: 'people', label: msg('Employee directory'), perm: 'employee.read', icon: 'users' },
    { key: 'departments', label: msg('Companies'), perm: 'employee.read', icon: 'building' },
    { key: 'attendance', label: msg('Attendance'), icon: 'clock' },
    { key: 'leave', label: msg('Leave'), icon: 'calendar' },
    { key: 'leavetypes', label: msg('Leave types & balances'), perm: 'employee.write', icon: 'calendar' },
    // Reviews, hiring and certificates (pages/ReviewsPage, RecruitmentPage,
    // TrainingPage). A reviewer without review.manage gets to their reviews
    // from My space and the notifications.
    { key: 'reviews', label: msg('Performance reviews'), perm: 'review.manage', icon: 'sparkle' },
    { key: 'recruitment', label: msg('Recruitment'), perm: 'recruit.manage', icon: 'target' },
    { key: 'training', label: msg('Training and certificates'), perm: 'training.manage', icon: 'shield' },
    // First days and last ones; incidents and near misses (pages/OnboardingPage,
    // SafetyPage). Everyone's own steps and reports are in My space.
    { key: 'onboarding', label: msg('Joiners and leavers'), perm: 'onboard.manage', icon: 'key' },
    { key: 'safety', label: msg('Health and safety'), perm: 'safety.manage', icon: 'bell' },
    // Confidential cases and grievances (pages/DisciplinePage.jsx); the ideas
    // box and pulse surveys, open to everyone (pages/VoicePage.jsx).
    { key: 'discipline', label: msg('Discipline and grievances'), perm: 'discipline.manage', icon: 'pen' },
    // Policies to read and sign (pages/PoliciesPage.jsx); each person signs in My space.
    { key: 'policies', label: msg('Policies'), perm: 'policy.manage', icon: 'document' },
    { key: 'voice', label: msg('Staff voice'), icon: 'chat' }
  ] },
  { label: msg('Work'), items: [
    { key: 'tasks', label: msg('Work orders'), perm: 'task.read', icon: 'checklist' },
    { key: 'projects', label: msg('Projects'), perm: 'project.read', icon: 'folder' },
    { key: 'messages', label: msg('Messages'), icon: 'chat' },
    { key: 'announcements', label: msg('Announcements'), icon: 'megaphone' },
    { key: 'documents', label: msg('Documents'), perm: 'document.read', icon: 'document' },
    // Anyone tells whoever looks after machines that one is broken (pages/ReportProblemPage.jsx).
    { key: 'report-problem', label: msg('Report a problem'), icon: 'wrench' }
  ] },
  { label: msg('Operations'), items: [
    { key: 'production', label: msg('Raw bamboo & production'), perm: 'production.read', icon: 'leaf' },
    { key: 'inventory', label: msg('Products & inventory'), perm: 'inventory.read', icon: 'box' },
    { key: 'stocksheet', label: msg('Daily stock sheet'), perm: 'inventory.read', icon: 'checklist' },
    { key: 'stocksummary', label: msg('Stock summary'), perm: 'inventory.read', icon: 'chart' },
    { key: 'suppliers', label: msg('Suppliers'), perm: 'supplier.read', icon: 'building' },
    { key: 'procurement', label: msg('Procurement'), perm: 'procurement.request', icon: 'cart' },
    { key: 'assets', label: msg('Assets & maintenance'), perm: 'asset.read', icon: 'wrench' },
    { key: 'waybills', label: msg('Waybills'), perm: 'waybill.read', icon: 'truck' },
    // The company's vans and cars, their fuel and papers (pages/VehiclesPage.jsx);
    // a driver reaches their own from My space.
    { key: 'vehicles', label: msg('Vehicles and fuel'), perm: ['vehicle.read', 'vehicle.manage'], icon: 'truck' },
    { key: 'toolroom', label: msg('Tool room inventory'), perm: 'toolroom.read', icon: 'toolbox' },
    { key: 'itdevices', label: msg('IT device inventory'), perm: 'itdevice.read', icon: 'device' },
    // The front desk and the gate (pages/VisitorsPage.jsx); staff add their
    // own visitors from My space.
    { key: 'visitors', label: msg('Visitors and gate passes'), perm: ['visitor.manage', 'gatepass.approve'], icon: 'users' },
    // Batches checked on the floor (pages/QualityPage.jsx); boots, gloves and
    // uniforms handed out (pages/PpePage.jsx) — each person's own in My space.
    { key: 'quality', label: msg('Quality'), perm: ['quality.manage', 'production.read'], icon: 'sparkle' },
    { key: 'ppe', label: msg('Uniforms and PPE'), perm: 'ppe.manage', icon: 'shield' },
    // What the companies must hold to trade, and when each ends (pages/LicencesPage.jsx).
    { key: 'licences', label: msg('Licences and permits'), perm: 'licence.manage', icon: 'key' },
    // The kilns, borate tanks and drying sheds (pages/KilnsPage.jsx); what
    // each product is made of and costs (pages/BomPage.jsx); how each
    // supplier has done (pages/ScorecardsPage.jsx).
    { key: 'kilns', label: msg('Kilns and treatment'), perm: ['production.read', 'production.manage'], icon: 'sun' },
    { key: 'bom', label: msg('Bills of materials'), perm: ['production.read', 'production.manage', 'inventory.read'], icon: 'layers' },
    { key: 'scorecards', label: msg('Supplier scorecards'), perm: ['supplier.read', 'supplier.manage', 'procurement.approve', 'restaurant.read', 'restaurant.manage'], icon: 'chart' },
    // N of a product made from its bill (pages/ProductionJobsPage.jsx); the
    // farmers who grow bamboo for us (pages/OutgrowersPage.jsx); power cuts,
    // generators and prepaid electricity (pages/PowerPage.jsx); one request
    // for prices to several suppliers (pages/RfqPage.jsx).
    { key: 'production-jobs', label: msg('Production jobs'), perm: ['production.read', 'production.manage', 'inventory.read'], icon: 'toolbox' },
    { key: 'outgrowers', label: msg('Bamboo outgrowers'), perm: ['supplier.read', 'supplier.manage', 'procurement.approve', 'bill.read'], icon: 'leaf' },
    { key: 'power', label: msg('Power and generators'), perm: ['power.manage', 'report.read', 'restaurant.manage'], icon: 'plug' },
    { key: 'rfqs', label: msg('Requests for quotes'), perm: ['procurement.approve', 'supplier.manage', 'supplier.read', 'procurement.read.all', 'restaurant.manage'], icon: 'receipt' }
  ] },
  { label: msg('Restaurants'), items: [
    { key: 'restaurant', label: msg('Menu & inventory'), perm: 'restaurant.read', icon: 'utensils' },
    // Guests, the order log for phone/WhatsApp/Bolt orders, feedback (pages/RestaurantCrmPage.jsx).
    { key: 'restaurantcrm', label: msg('Guest CRM'), perm: 'restaurant.read', icon: 'users' },
    // Today across the restaurants, on the owner's phone (pages/OwnerPage.jsx).
    { key: 'owner', label: msg('Owner\'s view'), perm: 'restaurant.read', icon: 'chart' }
  ] },
  { label: msg('Poki Properties'), items: [
    { key: 'pokidash', label: msg('Overview'), perm: 'poki.read', icon: 'chart' },
    { key: 'pokiproperties', label: msg('Properties & units'), perm: 'poki.read', icon: 'building' },
    { key: 'pokitenants', label: msg('Tenants'), perm: 'poki.read', icon: 'users' },
    { key: 'pokiestimates', label: msg('Letting offers'), perm: 'poki.read', icon: 'receipt' },
    { key: 'pokibookings', label: msg('Bookings'), perm: 'poki.read', icon: 'document' },
    { key: 'pokibilling', label: msg('Rent & utilities'), perm: 'poki.read', icon: 'cash' },
    { key: 'pokimaintenance', label: msg('Maintenance'), perm: 'poki.read', icon: 'wrench' }
  ] },
  { label: msg('Sales & CRM'), items: [
    // A rep's day: leads, prospects and customers in three lanes, ranked (pages/crm/CrmBoardPage.jsx).
    { key: 'crmboard', label: msg('My sales board'), perm: 'crm.read', icon: 'target' },
    { key: 'crm', label: msg('Overview'), perm: 'crm.read', icon: 'chart' },
    // Each with a second tab (pages/crm/CrmTabs.jsx): My follow-ups; Prospects.
    { key: 'crminbox', label: msg('Inbox & follow-ups'), perm: 'crm.read', icon: 'chat' },
    { key: 'crmleads', label: msg('Leads'), perm: 'crm.read', icon: 'users' },
    { key: 'crmcustomers', label: msg('Customers & prospects'), perm: 'crm.read', icon: 'user' },
    { key: 'crmvisits', label: msg('Site visits'), perm: 'crm.read', icon: 'calendar' },
    { key: 'appointments', label: msg('Appointments'), perm: 'crm.read', icon: 'clock' },
    { key: 'crmroute', label: msg('Today\'s route'), perm: 'crm.read', icon: 'route' },
    { key: 'crmhealth', label: msg('Data health'), perm: 'crm.read', icon: 'shield' }
  ] },
  { label: msg('Marketing'), items: [
    { key: 'mkhome', label: msg('Marketing home'), perm: 'marketing.read', icon: 'megaphone' },
    { key: 'mkcampaigns', label: msg('Campaigns'), perm: 'marketing.read', icon: 'target' },
    { key: 'mkcalendar', label: msg('Marketing calendar'), perm: 'marketing.read', icon: 'calendar' },
    { key: 'socialtracker', label: msg('Social & content'), perm: 'marketing.read', icon: 'chat' },
    { key: 'mkrequests', label: msg('Requests to marketing'), icon: 'checklist' },
    { key: 'mkbudget', label: msg('Budget & spend'), perm: 'marketing.read', icon: 'cash' },
    { key: 'mkevents', label: msg('Events'), perm: 'marketing.read', icon: 'bell' },
    { key: 'mkpromotions', label: msg('Promotions & offers'), perm: 'marketing.read', icon: 'receipt' },
    { key: 'mkaudiences', label: msg('Audiences'), perm: 'marketing.read', icon: 'users' },
    { key: 'mkbrand', label: msg('Brand kit'), icon: 'sparkle' },
    { key: 'mkmarket', label: msg('Competitors & market'), perm: 'marketing.read', icon: 'chart' },
    { key: 'crmmarketing', label: msg('Content ideas'), perm: 'crm.read', icon: 'leaf' },
    { key: 'marketing', label: msg('Customer journey'), perm: 'customer.read', icon: 'layers' }
  ] },
  { label: msg('Quotations & Invoicing'), items: [
    { key: 'qioverview', label: msg('Overview'), perm: 'report.read', icon: 'chart' },
    { key: 'customers', label: msg('Clients'), perm: 'customer.read', icon: 'building' },
    { key: 'estimates', label: msg('Estimates'), perm: 'quotation.read', icon: 'document' },
    { key: 'quotations', label: msg('Quotations'), perm: 'quotation.read', icon: 'document' },
    { key: 'invoices', label: msg('Invoices'), perm: 'invoice.read', icon: 'document' },
    { key: 'payments', label: msg('Payments'), perm: 'invoice.read', icon: 'cash' },
    // Who owes what and for how long; statements of account and credit
    // limits (pages/StatementsPage.jsx).
    { key: 'statements', label: msg('Customer statements'), perm: 'invoice.read', icon: 'document' },
    { key: 'receipts', label: msg('Receipts'), perm: 'invoice.read', icon: 'receipt' },
    { key: 'catalog', label: msg('Products & Services'), perm: 'catalog.read', icon: 'box' },
    { key: 'shoporders', label: msg('Online shop'), perm: 'invoice.read', icon: 'cart' },
    // Deliveries, fitting and repairs (pages/VisitsPage.jsx); a crew member
    // without invoice.read opens it from their notification (?mine=1).
    { key: 'bplvisits', label: msg('Deliveries and fitting'), perm: 'invoice.read', icon: 'truck' },
    { key: 'paymentlinks', label: msg('Payment links'), perm: 'invoice.read', icon: 'link' },
    { key: 'contracts', label: msg('Contracts'), perm: 'quotation.read', icon: 'pen' },
    { key: 'billingsettings', label: msg('Settings'), perm: 'settings.manage', icon: 'gear' }
  ] },
  { label: msg('Finance'), items: [
    { key: 'financedash', label: msg('Finance dashboard'), perm: 'report.read', icon: 'chart' },
    { key: 'payroll', label: msg('Payroll'), perm: 'payroll.read', icon: 'cash' },
    // Spending company money: each officer's float as their own running
    // sheet (pages/expenseSheets), and anyone who paid from their own pocket
    // records it there too. The older expense claims stay reachable as
    // history (hidden: a route and a page title, not in the menu).
    { key: 'expensesheets', label: msg('Expenses'), perm: ['expense.request', 'expensesheet.read.all', 'expensesheet.manage'], icon: 'cash' },
    { key: 'expenses', label: msg('Expense claims'), perm: 'expense.request', icon: 'receipt', hidden: true },
    // What we owe suppliers, BPL and the restaurants (pages/BillsPage.jsx).
    { key: 'bills', label: msg('Bills to pay'), perm: 'bill.read', icon: 'receipt' },
    // The next 13 weeks of money in and out, by company (pages/CashFlowPage.jsx).
    { key: 'cashflow', label: msg('Cash flow forecast'), perm: 'report.read', icon: 'chart' },
    // Each month's budget by category against what was spent (pages/BudgetsPage.jsx).
    { key: 'budgets', label: msg('Budgets'), perm: 'report.read', icon: 'target' },
    // Bank statements matched to the money recorded (pages/BankPage.jsx).
    { key: 'bank', label: msg('Bank reconciliation'), perm: 'bank.manage', icon: 'building' },
    // PAYE, SSNIT, VAT and withholding by month; what the assets are still
    // worth (pages/ReturnsPage, DepreciationPage).
    { key: 'returns', label: msg('Statutory returns'), perm: 'returns.manage', icon: 'document' },
    { key: 'depreciation', label: msg('Depreciation'), perm: ['asset.read', 'report.read'], icon: 'chart' },
    // Staff asking for part of their pay early, repaid from payroll
    // (pages/AdvancesPage.jsx); staff ask from My space.
    { key: 'advances', label: msg('Salary advances'), perm: 'advance.manage', icon: 'cash' },
    // Sales reps' commission on paid-up deals (the CRM's figures; crm.read).
    { key: 'crmcommissions', label: msg('Commissions'), perm: 'crm.read', icon: 'cash' },
    { key: 'reminders', label: msg('Payment reminders'), perm: ['invoice.read', 'poki.read', 'poki.manage'], icon: 'bell' },
    { key: 'reports', label: msg('Reports'), perm: 'report.read', icon: 'chart' },
    { key: 'financialreports', label: msg('Financial reports'), perm: 'report.read', icon: 'chart' },
    // The month for the owners as a PDF, emailed (pages/ManagementReportPage.jsx).
    { key: 'monthly-report', label: msg('Monthly report'), perm: 'report.read', icon: 'document' }
  ] },
  { label: msg('Insights'), items: [
    { key: 'salesorders', label: msg('Sales orders'), perm: 'sales.read', icon: 'cart' }
  ] },
  { label: msg('Intelligence'), items: [
    { key: 'assistant', label: msg('AI Assistant'), icon: 'sparkle' }
  ] },
  { label: msg('Governance'), items: [
    { key: 'approvals', label: msg('Approval centre'), perm: 'approval.act', icon: 'shield' },
    { key: 'roles', label: msg('Roles & permissions'), perm: 'role.manage', icon: 'key' },
    { key: 'users', label: msg('User accounts'), perm: 'user.manage', icon: 'users' },
    { key: 'audit', label: msg('Audit log'), perm: 'audit.read', icon: 'history' },
    { key: 'settings', label: msg('Company settings'), perm: 'employee.read', icon: 'gear' },
    { key: 'integrations', label: msg('Integrations'), perm: 'settings.manage', icon: 'plug' }
  ] }
];

export const ALL_NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);
