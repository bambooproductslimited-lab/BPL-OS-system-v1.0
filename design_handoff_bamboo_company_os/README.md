# Handoff: Bamboo Products Limited — Company OS

## Overview
A full-featured internal company operating system prototype for Bamboo Products Limited (Ghana): authentication/RBAC, HR (employees, departments, attendance, leave), work management (tasks with comments/edit/delete, projects, announcements, documents, approvals), internal staff-to-staff messaging, Phase 2 operations (raw bamboo intake, production batches, product catalog, inventory, warehouses, suppliers — all with full CRUD, procurement, assets/maintenance), Phase 3 commercial (CRM, quotations, sales orders, invoices, expenses, financial reporting with trend charts and CSV export), Phase 4 (a permission-scoped AI assistant, plus third-party integrations settings for TimeStation/Square/Slack/QuickBooks), and a full Quotations/Estimates/Invoicing/Payments/Receipts module with multi-line items, discounts, tax, document numbering, and branded printable document previews.

## About the design/prototype files
The files here are a **working HTML/JS prototype**, not production code to deploy as-is. All application logic lives in one client-side "kernel" module that simulates a server boundary (auth, RBAC, validation, persistence) entirely in the browser. The task for engineering is to **reimplement this same domain model and business logic as a real backend + frontend**, using the target stack's conventions — not to ship these files directly.

## Fidelity
This is a **functional hifi prototype**: real (simulated) CRUD, real permission enforcement, real computed values (totals, balances, statuses) — but running against `localStorage` instead of a database, and with placeholder-strength auth. Treat the UI screens as the intended real design (layout, copy, workflows, status vocabulary) and the kernel as the intended real data model and business rules.

## Architecture (as prototyped)
- `core/kernel.js` — the entire "server": in-memory/localStorage data store, seed data, versioned migrations, an RBAC permission catalogue, a `handlers` map of ~120 named operations (`employees.create`, `leave.decide`, `invoices.recordPayment`, etc.), input validation, audit logging, and in-app notifications. The UI only ever calls `BambooKernel.call(methodName, params)` — never touches storage directly. This 1:1 method-name-to-handler mapping is intentionally shaped like future REST endpoints (e.g. `leave.decide` → `POST /api/leave/:id/decision`).
- `Bamboo OS.dc.html` — the entire application UI: login, sidebar navigation (grouped by module), all screens, and modals/dialogs. Built as a single-page app with client-side routing via a `screen` state key (no URL router).

## What must change for production
1. **Move `core/kernel.js`'s logic to a real backend.** Every handler function becomes an API endpoint (or a set of resolvers). Keep the same operation names and parameter shapes where practical — the frontend's `this.call('method', params)` calls map directly to what would become `fetch('/api/method', {body: params})`.
2. **Replace the persistence layer.** `Storage.read/write` (backed by `localStorage`) becomes a real database — Postgres is recommended given the relational shape of the data (see Data Model below). The migrations array in `kernel.js` (`MIGRATIONS`, currently at schema version 11) should become real DB migrations (e.g. via Prisma/Knex/Rails-style migration files) — the existing list is a readable spec of every schema change made, in order, with human-readable notes.
3. **Replace authentication.** `Crypto.hash`/`Crypto.verify` in `kernel.js` are a **non-cryptographic placeholder** explicitly isolated for this reason — replace with bcrypt/argon2 password hashing and real server-side session tokens (or JWT) issued on login. Add rate limiting on login attempts.
8. **Build real integrations.** The Integrations screen (Settings → Integrations) currently only stores a connected flag + API key per provider (TimeStation, Square, Slack, QuickBooks) — no real sync happens. A production build needs actual webhook/polling integrations per provider (e.g. TimeStation clock events → Attendance records, Square payments → Invoices/Payments).
4. **Enforce permissions server-side only.** The prototype's RBAC (`PERMISSIONS` catalogue, `require_()` checks, `visibleEmployee()`/`procurementVisible()`/`expenseVisible()` scope functions in `kernel.js`) is the actual authorization spec — port it directly into backend middleware/guards. Never trust the frontend's `can()` UI checks as a security boundary; they exist only for UX (hiding buttons the user can't use).
5. **Add real file storage** for the Documents module (currently just stores a filename string, no actual file upload) — S3-compatible object storage is typical.
6. **Wire the AI Assistant to a real Claude API key server-side** (the prototype uses an in-browser `window.claude.complete` bridge available only in this design tool) — proxy assistant calls through your backend so the same permission-scoping (`ai.context` handler) is enforced server-side, not just client-side.
7. **Clear demo/seed data** before real company data is entered. The prototype seeds ~18 fictional employees, sample customers/suppliers/transactions, etc. (`seed()` in `kernel.js`). A production launch needs either a genuinely empty database or a one-time real data import, not this seed data.

## Data model (derived from `core/kernel.js`'s in-memory collections)
Each of these is presently an array on the in-memory `db` object; each should become a table:
`employees`, `users`, `roles`, `departments`, `attendance`, `leaveTypes`, `leaveBalances`, `leaveRequests`, `approvals` (generic polymorphic approval queue — `subjectType` + `subjectId`), `tasks`, `projects`, `announcements`, `documents`, `notifications`, `warehouses`, `rawBatches`, `productionBatches`, `products`, `inventoryTx`, `suppliers`, `procurementRequests`, `assets`, `maintenanceRecords`, `customers`, `quotations`, `salesOrders`, `invoices`, `expenses`, `catalogItems`, `estimates`, `payments`, `receipts`, `auditLogs`, plus a singleton `settings` row (including a nested `settings.commercial` config for tax rates, document numbering, templates, payment details).

Key relationships to preserve:
- `users.employeeId → employees.id` (1:1), `employees.departmentId → departments.id`, `employees.managerId → employees.id` (self-referential reporting line)
- `roles` hold a `permissions: string[]` array (`resource.action` strings) — users get roles, roles get permissions (no direct user→permission grants)
- `approvals` is a generic queue: `subjectType` (`leave_request` | `procurement_request` | `expense`) + `subjectId` lets one Approval Centre UI serve three different workflows
- `quotations`/`estimates`/`invoices` all share the same line-item shape (`{description, qty, unit, unitPrice, discount, discountType, taxRate}`) with computed `subtotal/discountTotal/taxTotal/grandTotal` — **snapshot pricing at document-creation time**, never recompute from live catalog prices later
- `invoices.amountPaid`/`balanceDue` are updated by `payments` records (via `invoices.recordPayment`), which also auto-generate a `receipts` record — preserve this "payment always produces a receipt" invariant
- `procurementRequests`/`expenses`/`leaveRequests` all follow the same request → approval → decision lifecycle pattern

## Roles & permissions (the authorization spec)
Twelve roles: `administrator` (all permissions), `executive` (company-wide read + final approvals), `hr_manager`, `department_manager`, `supervisor`, `employee`, `marketing_manager`, `finance_manager`, `customer_service_manager`, `it_manager`, `general_manager`, `finance_hr_manager` (combined Finance + HR). See the `PERMISSIONS` array and each role's `permissions` list in `kernel.js` for the exact, current grant matrix (also viewable live in the app's own Roles & Permissions screen, which lets an administrator toggle grants — read that screen's current state before porting, as it may have been edited since this file was generated). Record-level visibility (e.g. a department manager only sees their own department's people/leave/expenses) is resolved by `visibleEmployee()`/`procurementVisible()`/`expenseVisible()` — port these scope functions exactly, not just the flat permission checks.

## Screens (for UI recreation)
The sidebar is grouped into: Overview (Dashboard, My space), People (Employee directory, Departments, Attendance, Leave), Work (Tasks, Projects, Messages, Announcements, Documents), Operations (Raw bamboo & production, Products & inventory, Suppliers, Procurement, Assets & maintenance), Quotations & Invoicing (Overview, Clients, Estimates, Quotations, Invoices, Payments, Receipts, Products & Services, Settings), Finance (Finance dashboard, Expenses, Reports), Insights (Marketing dashboard, Sales orders), Intelligence (AI Assistant), Governance (Approval centre, Roles & permissions, User accounts, Audit log, Company settings, Integrations). Every screen and dialog's exact layout, copy, and field set is visible directly in `Bamboo OS.dc.html` — read that file screen-by-screen rather than re-describing it here, since it is the source of truth.

## Design system
Visual style follows the "Modernist" design system: flat, high-contrast, Archivo typeface, zero border radius, strong 2px dividers, a single accent color (default green `#3f7d3b`, user-tweakable via the app's Tweaks panel), light/dark neutral ramps. Tables, tags/status badges, buttons, and form fields all follow one consistent set of inline styles reused throughout — grep for `class="tag` / `class="btn` / `class="input` in the HTML for every variant in use.

## Files in this handoff
- `core/kernel.js` — the full business-logic/data-model reference (read this first — it is the actual spec)
- `Bamboo OS.dc.html` — the full UI reference
- `PROJECT_NOTES.md` — running build log: what's done per phase, test accounts, and the schema version history (schema version 19 as of this handoff)
