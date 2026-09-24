import { msg } from '../lib/i18n.jsx';

// Ported from Bamboo OS.dc.html's navModel() — same grouping, labels, and
// permission gates (item.perm), so the sidebar structure matches the
// prototype's intended design exactly. `key` doubles as the route path
// segment. Screens not yet built render a "Coming soon" placeholder (see
// AppShell) rather than being left out of the nav — the shape of the app is
// part of what this pass is establishing.
// `icon` names a shared path in layout/navIcons.jsx (AppShell's <Icon>).
//
// Labels are wrapped in msg(), not tr(): this list is built once, when the
// module loads, and a tr() here would fix the sidebar in whatever language
// was active at that moment. AppShell translates them as it renders.
export const NAV_GROUPS = [
  { label: msg('Overview'), items: [
    { key: 'dashboard', label: msg('Dashboard'), icon: 'home' },
    { key: 'myspace', label: msg('My space'), icon: 'user' }
  ] },
  { label: msg('People'), items: [
    { key: 'people', label: msg('Employee directory'), perm: 'employee.read', icon: 'users' },
    { key: 'departments', label: msg('Companies'), perm: 'employee.read', icon: 'building' },
    { key: 'attendance', label: msg('Attendance'), icon: 'clock' },
    { key: 'leave', label: msg('Leave'), icon: 'calendar' },
    { key: 'leavetypes', label: msg('Leave types & balances'), perm: 'employee.write', icon: 'calendar' }
  ] },
  { label: msg('Work'), items: [
    { key: 'tasks', label: msg('Tasks'), perm: 'task.read', icon: 'checklist' },
    { key: 'projects', label: msg('Projects'), perm: 'project.read', icon: 'folder' },
    { key: 'messages', label: msg('Messages'), icon: 'chat' },
    { key: 'announcements', label: msg('Announcements'), icon: 'megaphone' },
    { key: 'documents', label: msg('Documents'), perm: 'document.read', icon: 'document' }
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
    { key: 'toolroom', label: msg('Tool room inventory'), perm: 'toolroom.read', icon: 'toolbox' },
    { key: 'itdevices', label: msg('IT device inventory'), perm: 'itdevice.read', icon: 'device' }
  ] },
  { label: msg('Restaurants'), items: [
    { key: 'restaurant', label: msg('Menu & inventory'), perm: 'restaurant.read', icon: 'utensils' }
  ] },
  { label: msg('Poki Rentals'), items: [
    { key: 'pokidash', label: msg('Overview'), perm: 'poki.read', icon: 'chart' },
    { key: 'pokiproperties', label: msg('Properties & units'), perm: 'poki.read', icon: 'building' },
    { key: 'pokitenants', label: msg('Tenants'), perm: 'poki.read', icon: 'users' },
    { key: 'pokiestimates', label: msg('Letting offers'), perm: 'poki.read', icon: 'receipt' },
    { key: 'pokibookings', label: msg('Bookings'), perm: 'poki.read', icon: 'document' },
    { key: 'pokibilling', label: msg('Rent & utilities'), perm: 'poki.read', icon: 'cash' },
    { key: 'pokimaintenance', label: msg('Maintenance'), perm: 'poki.read', icon: 'wrench' }
  ] },
  { label: msg('Quotations & Invoicing'), items: [
    { key: 'qioverview', label: msg('Overview'), perm: 'report.read', icon: 'chart' },
    { key: 'customers', label: msg('Clients'), perm: 'customer.read', icon: 'building' },
    { key: 'estimates', label: msg('Estimates'), perm: 'quotation.read', icon: 'document' },
    { key: 'quotations', label: msg('Quotations'), perm: 'quotation.read', icon: 'document' },
    { key: 'invoices', label: msg('Invoices'), perm: 'invoice.read', icon: 'document' },
    { key: 'payments', label: msg('Payments'), perm: 'invoice.read', icon: 'cash' },
    { key: 'receipts', label: msg('Receipts'), perm: 'invoice.read', icon: 'receipt' },
    { key: 'catalog', label: msg('Products & Services'), perm: 'catalog.read', icon: 'box' },
    { key: 'billingsettings', label: msg('Settings'), perm: 'settings.manage', icon: 'gear' }
  ] },
  { label: msg('Finance'), items: [
    { key: 'financedash', label: msg('Finance dashboard'), perm: 'report.read', icon: 'chart' },
    { key: 'payroll', label: msg('Payroll'), perm: 'payroll.read', icon: 'cash' },
    { key: 'expenses', label: msg('Expenses'), perm: 'expense.request', icon: 'receipt' },
    { key: 'reminders', label: msg('Payment reminders'), perm: ['invoice.read', 'poki.read', 'poki.manage'], icon: 'bell' },
    { key: 'reports', label: msg('Reports'), perm: 'report.read', icon: 'chart' },
    { key: 'financialreports', label: msg('Financial reports'), perm: 'report.read', icon: 'chart' }
  ] },
  { label: msg('Insights'), items: [
    { key: 'marketing', label: msg('Marketing dashboard'), perm: 'customer.read', icon: 'chart' },
    { key: 'socialtracker', label: msg('Social & campaign tracker'), perm: 'marketing.read', icon: 'megaphone' },
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
