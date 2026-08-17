# Bamboo Products Limited — Company OS

## What this is
Internal operating system for Bamboo Products Limited. Phases 1–4 built (Phase 4 AI Assistant
scoped; forecasting/automation still architecture-only). Plus a full Quotations, Estimates,
Invoicing & Payments module, internal staff messaging, and third-party integrations settings.

## Architecture (as built here)
- `core/kernel.js` — the **server boundary**: schema, seed data, versioned migrations, RBAC,
  input validation, audit logging, notifications. All screens call `BambooKernel.call(method, params)`
  and every call is authenticated, authorised, validated and audited inside this file.
- `Bamboo OS.dc.html` — the single application shell: login, navigation, role-aware dashboards
  and every screen across all phases. No screen reaches into storage directly.

## Prototype boundaries (deliberate, isolated, labelled)
- Persistence is `localStorage` behind `Storage.*` in the kernel.
- Password hashing is a non-cryptographic digest behind `Crypto.*`.
Both are swapped for a real API client (fetch → Node/Express + Postgres, bcrypt/argon2) without
touching a single screen. Handler names in `handlers` map 1:1 to future REST routes
(`leave.decide` → `POST /api/leave/:id/decision`).

## Roles
administrator · executive (MD) · hr_manager · department_manager · supervisor · employee ·
marketing_manager · finance_manager · customer_service_manager · it_manager · general_manager ·
finance_hr_manager (combined Finance + HR).
Permissions are `resource.action` strings; record visibility is resolved by scope
(self → department → reporting subtree → all) in `visibleEmployee()`.

## Test accounts
Password `bamboo123` for all, `@bplghana.com`: kelvin.duho (System Administrator),
andy.chou (Executive/MD), albert.awini (Finance & HR Manager), frank.kampewu (General Manager),
isreal.omozuafo (Production Manager), emmanuel.chang (IT Manager), alice.kamau (Employee).

## Migrations
`MIGRATIONS` in `core/kernel.js`; current `schemaVersion: 19`. Add `{to, note, up}` entries — never
edit `seed()` for a schema change to an existing database.

## Reset
`BambooKernel.call('dev.reset')` in the console re-seeds the database.

## Build order
Phase 1 (done): kernel, auth, RBAC, navigation, dashboards, self-service, directory, departments
(with edit/delete), attendance (with edit/delete), leave, tasks (edit/delete, comments, status
dropdown, date-started + overdue tracking), projects, announcements, documents, approval centre,
roles & permissions, user accounts, audit log, settings, notifications, employee profile page,
internal staff-to-staff messaging (inbox/thread, notification click-through).
Phase 2 (done): raw bamboo intake (edit), production batches, product catalog & inventory (edit),
warehouses (add/edit/delete), suppliers (add/edit/delete), procurement requests (approval-centre
integrated), assets & maintenance.
Phase 3 (done): customers/CRM (edit/delete), quotations (preview, edit, delete), sales orders,
invoices (preview, edit, delete), expense claims (edit/delete, approval-centre integrated),
financial & operations reporting, finance dashboard (revenue/expense trend chart with month/year
toggle, net cash position, recent payments feed, CSV export).
Phase 3.5 (done): Quotations & Invoicing module — clients, estimates (preview, edit, delete),
quotations, invoices, payments, receipts (preview), products & services catalogue (edit/delete/
archive/description), templates, commercial settings, document numbering. Estimate/quotation/
invoice previews use a branded printable layout (logo, company address, customer/details/payment
columns, items table, totals) matching a reference invoice format.
Phase 4 (started): permission-scoped AI Assistant (reuses existing scoped handlers as its only data
source — never sees more than the logged-in user could see themselves); third-party integrations
settings (TimeStation, Square, Slack, QuickBooks — credential storage only, no real sync yet).
Not yet built: forecasting, automated report generation, inventory/production predictions, document
intelligence, mobile app, accounting integrations, biometric attendance, WhatsApp notifications,
customer/supplier portals — these remain architecture-only per the original brief.
