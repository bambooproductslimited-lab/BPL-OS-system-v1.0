-- Financial Reports section: adds the one thing that can't be computed
-- from existing transactional tables — Balance Sheet manual inputs (cash &
-- bank, accounts payable, loans, owner's equity), since there's no general
-- ledger or cash book in this system. Everything else (Profit & Loss, Cash
-- Flow, Balance Sheet's AR/inventory/fixed-asset lines, AR aging, expense
-- detail) is computed live in reports.service.js from invoices, payments,
-- expenses, payslips, products and assets — no new tables needed for those.
ALTER TABLE settings ADD COLUMN balance_sheet jsonb NOT NULL DEFAULT '{}';
