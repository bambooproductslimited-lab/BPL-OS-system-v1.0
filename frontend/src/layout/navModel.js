// Ported from Bamboo OS.dc.html's navModel() — same grouping, labels, and
// permission gates (item.perm), so the sidebar structure matches the
// prototype's intended design exactly. `key` doubles as the route path
// segment. Screens not yet built render a "Coming soon" placeholder (see
// AppShell) rather than being left out of the nav — the shape of the app is
// part of what this pass is establishing.
// `icon` names a shared path in layout/navIcons.jsx (AppShell's <Icon>).
export const NAV_GROUPS = [
  { label: 'Overview', items: [
    { key: 'dashboard', label: 'Dashboard', icon: 'home' },
    { key: 'myspace', label: 'My space', icon: 'user' }
  ] },
  { label: 'People', items: [
    { key: 'people', label: 'Employee directory', perm: 'employee.read', icon: 'users' },
    { key: 'departments', label: 'Companies', perm: 'employee.read', icon: 'building' },
    { key: 'attendance', label: 'Attendance', icon: 'clock' },
    { key: 'leave', label: 'Leave', icon: 'calendar' }
  ] },
  { label: 'Work', items: [
    { key: 'tasks', label: 'Tasks', perm: 'task.read', icon: 'checklist' },
    { key: 'projects', label: 'Projects', perm: 'project.read', icon: 'folder' },
    { key: 'messages', label: 'Messages', icon: 'chat' },
    { key: 'announcements', label: 'Announcements', icon: 'megaphone' },
    { key: 'documents', label: 'Documents', perm: 'document.read', icon: 'document' }
  ] },
  { label: 'Operations', items: [
    { key: 'production', label: 'Raw bamboo & production', perm: 'production.read', icon: 'leaf' },
    { key: 'inventory', label: 'Products & inventory', perm: 'inventory.read', icon: 'box' },
    { key: 'suppliers', label: 'Suppliers', perm: 'supplier.read', icon: 'building' },
    { key: 'procurement', label: 'Procurement', perm: 'procurement.request', icon: 'cart' },
    { key: 'assets', label: 'Assets & maintenance', perm: 'asset.read', icon: 'wrench' },
    { key: 'waybills', label: 'Waybills', perm: 'waybill.read', icon: 'truck' },
    { key: 'toolroom', label: 'Tool room inventory', perm: 'toolroom.read', icon: 'toolbox' },
    { key: 'itdevices', label: 'IT device inventory', perm: 'itdevice.read', icon: 'device' }
  ] },
  { label: 'Quotations & Invoicing', items: [
    { key: 'qioverview', label: 'Overview', perm: 'report.read', icon: 'chart' },
    { key: 'customers', label: 'Clients', perm: 'customer.read', icon: 'building' },
    { key: 'estimates', label: 'Estimates', perm: 'quotation.read', icon: 'document' },
    { key: 'quotations', label: 'Quotations', perm: 'quotation.read', icon: 'document' },
    { key: 'invoices', label: 'Invoices', perm: 'invoice.read', icon: 'document' },
    { key: 'payments', label: 'Payments', perm: 'invoice.read', icon: 'cash' },
    { key: 'receipts', label: 'Receipts', perm: 'invoice.read', icon: 'receipt' },
    { key: 'catalog', label: 'Products & Services', perm: 'catalog.read', icon: 'box' },
    { key: 'billingsettings', label: 'Settings', perm: 'settings.manage', icon: 'gear' }
  ] },
  { label: 'Finance', items: [
    { key: 'financedash', label: 'Finance dashboard', perm: 'report.read', icon: 'chart' },
    { key: 'payroll', label: 'Payroll', perm: 'payroll.read', icon: 'cash' },
    { key: 'expenses', label: 'Expenses', perm: 'expense.request', icon: 'receipt' },
    { key: 'reports', label: 'Reports', perm: 'report.read', icon: 'chart' },
    { key: 'financialreports', label: 'Financial reports', perm: 'report.read', icon: 'chart' }
  ] },
  { label: 'Insights', items: [
    { key: 'marketing', label: 'Marketing dashboard', perm: 'customer.read', icon: 'chart' },
    { key: 'socialtracker', label: 'Social & campaign tracker', perm: 'marketing.read', icon: 'megaphone' },
    { key: 'salesorders', label: 'Sales orders', perm: 'sales.read', icon: 'cart' }
  ] },
  { label: 'Intelligence', items: [
    { key: 'assistant', label: 'AI Assistant', icon: 'sparkle' }
  ] },
  { label: 'Governance', items: [
    { key: 'approvals', label: 'Approval centre', perm: 'approval.act', icon: 'shield' },
    { key: 'roles', label: 'Roles & permissions', perm: 'role.manage', icon: 'key' },
    { key: 'users', label: 'User accounts', perm: 'user.manage', icon: 'users' },
    { key: 'audit', label: 'Audit log', perm: 'audit.read', icon: 'history' },
    { key: 'settings', label: 'Company settings', perm: 'employee.read', icon: 'gear' },
    { key: 'integrations', label: 'Integrations', perm: 'settings.manage', icon: 'plug' }
  ] }
];

export const ALL_NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);
