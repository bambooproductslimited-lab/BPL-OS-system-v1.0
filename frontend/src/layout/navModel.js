// Ported from Bamboo OS.dc.html's navModel() — same grouping, labels, and
// permission gates (item.perm), so the sidebar structure matches the
// prototype's intended design exactly. `key` doubles as the route path
// segment. Screens not yet built render a "Coming soon" placeholder (see
// AppShell) rather than being left out of the nav — the shape of the app is
// part of what this pass is establishing.
export const NAV_GROUPS = [
  { label: 'Overview', items: [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'myspace', label: 'My space' }
  ] },
  { label: 'People', items: [
    { key: 'people', label: 'Employee directory', perm: 'employee.read' },
    { key: 'departments', label: 'Departments', perm: 'employee.read' },
    { key: 'attendance', label: 'Attendance' },
    { key: 'leave', label: 'Leave' }
  ] },
  { label: 'Work', items: [
    { key: 'tasks', label: 'Tasks', perm: 'task.read' },
    { key: 'projects', label: 'Projects', perm: 'project.read' },
    { key: 'messages', label: 'Messages' },
    { key: 'announcements', label: 'Announcements' },
    { key: 'documents', label: 'Documents', perm: 'document.read' }
  ] },
  { label: 'Operations', items: [
    { key: 'production', label: 'Raw bamboo & production', perm: 'production.read' },
    { key: 'inventory', label: 'Products & inventory', perm: 'inventory.read' },
    { key: 'suppliers', label: 'Suppliers', perm: 'supplier.read' },
    { key: 'procurement', label: 'Procurement', perm: 'procurement.request' },
    { key: 'assets', label: 'Assets & maintenance', perm: 'asset.read' },
    { key: 'waybills', label: 'Waybills', perm: 'waybill.read' },
    { key: 'toolroom', label: 'Tool room inventory', perm: 'toolroom.read' },
    { key: 'itdevices', label: 'IT device inventory', perm: 'itdevice.read' }
  ] },
  { label: 'Quotations & Invoicing', items: [
    { key: 'qioverview', label: 'Overview', perm: 'report.read' },
    { key: 'customers', label: 'Clients', perm: 'customer.read' },
    { key: 'estimates', label: 'Estimates', perm: 'quotation.read' },
    { key: 'quotations', label: 'Quotations', perm: 'quotation.read' },
    { key: 'invoices', label: 'Invoices', perm: 'invoice.read' },
    { key: 'payments', label: 'Payments', perm: 'invoice.read' },
    { key: 'receipts', label: 'Receipts', perm: 'invoice.read' },
    { key: 'catalog', label: 'Products & Services', perm: 'catalog.read' },
    { key: 'billingsettings', label: 'Settings', perm: 'settings.manage' }
  ] },
  { label: 'Finance', items: [
    { key: 'financedash', label: 'Finance dashboard', perm: 'report.read' },
    { key: 'expenses', label: 'Expenses', perm: 'expense.request' },
    { key: 'reports', label: 'Reports', perm: 'report.read' }
  ] },
  { label: 'Insights', items: [
    { key: 'marketing', label: 'Marketing dashboard', perm: 'customer.read' },
    { key: 'salesorders', label: 'Sales orders', perm: 'sales.read' }
  ] },
  { label: 'Intelligence', items: [
    { key: 'assistant', label: 'AI Assistant' }
  ] },
  { label: 'Governance', items: [
    { key: 'approvals', label: 'Approval centre', perm: 'approval.act' },
    { key: 'roles', label: 'Roles & permissions', perm: 'role.manage' },
    { key: 'users', label: 'User accounts', perm: 'user.manage' },
    { key: 'audit', label: 'Audit log', perm: 'audit.read' },
    { key: 'settings', label: 'Company settings', perm: 'employee.read' },
    { key: 'integrations', label: 'Integrations', perm: 'settings.manage' }
  ] }
];

export const ALL_NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);
