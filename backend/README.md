# Bamboo OS Backend

Real Node.js/Express + PostgreSQL backend for the Bamboo Products Limited
Company OS, replacing the design prototype's `core/kernel.js` (which ran
entirely client-side against `localStorage`, with a non-cryptographic
password digest standing in for real auth).

Every kernel.js handler group has a real route now — auth, people/governance,
work/comms, operations, and the full commercial (quotation-to-cash) module —
except `ai.context` (needs a real Claude API key proxied server-side) and
`dev.reset` (a browser-only convenience superseded by `npm run db:reset`
here). See [`PROJECT_NOTES.md`](../design_handoff_bamboo_company_os/PROJECT_NOTES.md)
and [`README.md`](../design_handoff_bamboo_company_os/README.md) in
`design_handoff_bamboo_company_os/` for the prototype's own account of the
system. Every service/route file is commented with which kernel.js handler
it ports from.

## Stack

- **Express** — one route per kernel method, same naming convention the
  kernel's handler map already used (`leave.decide` → `POST /api/leave/:id/decision`).
- **PostgreSQL** — schema derived from `kernel.js`'s `seed()` and `MIGRATIONS`
  array, applied via plain numbered SQL migration files (see below).
- **bcrypt** — replaces `Crypto.hash`/`Crypto.verify`.
- **JWT** (`jsonwebtoken`) — replaces the kernel's `Storage.writeSession`.
- **express-rate-limit** — login throttling, plus a DB-backed per-account
  lockout after repeated failures (`users.failed_login_attempts` / `locked_until`),
  neither of which the prototype had (it explicitly called these out as
  needed for production in `PROJECT_NOTES.md`).

## Setup

```bash
cd backend
npm install
cp .env.example .env        # then edit JWT_SECRET etc. for anything beyond local dev

# Local Postgres, if you don't already have one:
#   createuser bamboo --pwprompt   (password: bamboo, or match your .env)
#   createdb bamboo_os -O bamboo

npm run migrate              # creates every table
npm run seed                 # wipes + reseeds demo data (dev only — see below)
npm run dev                  # or `npm start`; listens on PORT (default 4000)
```

Demo accounts (password `bamboo123` for all, `@bplghana.com`), same as the
prototype: `kelvin.duho` (System Administrator), `andy.chou` (Executive/MD),
`albert.awini` (Finance & HR Manager), `frank.kampewu` (General Manager),
`isreal.omozuafo` (Production Manager), `emmanuel.chang` (IT Manager),
`alice.kamau` (Employee).

```bash
curl -X POST localhost:4000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"alice.kamau@bplghana.com","password":"bamboo123"}'
# -> { "token": "...", "session": { ... } }

curl localhost:4000/api/leave -H "Authorization: Bearer <token>"
```

The AI Assistant (`POST /api/ai/chat`) is optional — it works with no
setup, but every reply is a fixed "not configured" message until you set
`ANTHROPIC_API_KEY` in `.env` (get one at
[console.anthropic.com](https://console.anthropic.com/)). See "AI
Assistant" below.

## Migrations

`src/db/migrations/*.up.sql` / `*.down.sql`, tracked in a `schema_migrations`
table. Unlike the kernel's single `MIGRATIONS` array (which mutated an
in-memory object), these are real, individually reviewable SQL files, applied
in filename order:

```bash
npm run migrate          # apply all pending
npm run migrate:down     # roll back the most recent one
npm run migrate:status   # show applied / pending
```

- `0001` — pgcrypto extension (`gen_random_uuid()`).
- `0002`–`0005` — core people/governance/leave schema.
- `0006`–`0008` — work/comms, operations, and commercial schema.
- `0009` — CHECK constraint corrections found while porting the routes for
  `0006`–`0008` (see below) plus two columns the handlers needed
  (`warehouses.capacity`, `quotations.from_estimate_id`).

Two schema decisions worth flagging since they depart from the prototype's
raw JS-object shape by necessity of being a real relational schema:

- **UUID primary keys** everywhere (`gen_random_uuid()`), instead of the
  prototype's short string ids (`'e_001'`, `'lr_1'`, ...). Employees keep a
  human-readable `code` column (`'BPL-013'`) since the UI shows it.
- **Deferred FKs** on `departments.manager_id` and `employees.manager_id`
  (`DEFERRABLE INITIALLY DEFERRED`) — the seed data has departments and
  employees referencing each other (a department's manager is an employee;
  an employee's manager can be an employee inserted later in seed order), so
  the constraint is checked at transaction commit rather than per-statement.
- Quotations/estimates/sales orders/invoices share one
  `document_line_items` table (`document_type` + `document_id`), matching
  `PROJECT_NOTES.md`'s note that these four document types share one
  line-item shape with snapshot pricing.

## Seeding

`npm run seed` ports `kernel.js`'s `seed()` **plus** the parts of its
`MIGRATIONS` array that shape the final dataset (the Information Technology
department + Emmanuel Chang from migration 17, the final 12-role permission
grants after migrations 3/4/11's additive grants are folded in, Phase 2
operations demo data, commercial settings/integrations from migrations 10/18,
etc.) — see the comments at the top of `src/db/seed.js` for exactly which
permissions came from which migration. It is **destructive**: it `TRUNCATE`s
every table first, exactly like the prototype's `BambooKernel.call('dev.reset')`.
Don't point it at anything with real data.

Not currently seeded (tracked as a gap, not silently dropped): the
10-working-day attendance history `seed()` generates, and the Phase 3
customers/quotations/invoices/expenses demo records (the commercial routes
are fully implemented and tested — just exercised against data created
through the API in tests rather than pre-seeded).

## RBAC

`src/middleware/rbac.js` ports `require_(ctx, perm)` → `requirePermission(perm)`
middleware, and `visibleEmployee(ctx, emp)` verbatim (self → department →
whole reporting subtree via a walk up `manager_id` → `employee.read.all`
escapes all of it). The same pattern is ported per-module for the other
record-level scope functions: `taskVisible`/`projectVisible`
(`tasks.service.js`/`projects.service.js`), `documentVisible`/
`announcementVisible` (`documents.service.js`/`announcements.service.js`),
`procurementVisible` (`procurement.service.js`), `expenseVisible`
(`expenses.service.js`). `src/services/context.service.js` ports `ctxFor(user)`
/ `permissionsOf(user)` — every authenticated request gets a `req.ctx` with
`.can(perm)`, exactly like the kernel's per-call `ctx`. **Permissions are
resolved server-side on every request from the roles in the database**, never
trusted from the client, matching `PROJECT_NOTES.md`'s explicit warning not
to treat the frontend's `can()` checks as a security boundary.

## Endpoints

Base path `/api`. Every route requires `Authorization: Bearer <token>` except
`POST /auth/login` and `GET /roles/permissions` (the kernel exempts exactly
these two from its `needsAuth` check).

| Module | Kernel methods | Routes |
|---|---|---|
| Auth | `auth.login`, `auth.logout` | `POST /auth/login`, `POST /auth/logout` |
| Me | `api.currentContext()`, `me.summary` | `GET /me`, `GET /me/summary` |
| Leave | `leave.types/list/request/decide/cancel` | `GET /leave/types`, `GET /leave`, `POST /leave`, `POST /leave/:id/decision`, `POST /leave/:id/cancel` |
| Approvals | `approvals.queue` | `GET /approvals/queue` (leave / procurement / expense — fully polymorphic) |
| Employees | `employees.list/get/create/update/terminate/purgeTerminated/profile` | `GET /employees`, `POST /employees`, `POST /employees/purge-terminated`, `GET /employees/:id`, `GET /employees/:id/profile`, `PATCH /employees/:id`, `POST /employees/:id/terminate` |
| Departments | `departments.list/save/delete` | `GET /departments`, `POST /departments`, `PUT /departments/:id`, `DELETE /departments/:id` |
| Roles | `roles.list/permissionCatalogue/setPermission` | `GET /roles`, `GET /roles/permissions`, `POST /roles/:roleId/permissions` |
| Users | `users.list/setRole/setStatus` | `GET /users`, `POST /users/:id/role`, `POST /users/:id/status` |
| Attendance | `attendance.clockIn/clockOut/list/adjust/delete` | `POST /attendance/clock-in`, `POST /attendance/clock-out`, `GET /attendance`, `POST /attendance/adjust`, `DELETE /attendance/:id` |
| Notifications | `notifications.mine/markRead` | `GET /notifications`, `POST /notifications/read` |
| Audit | `audit.list` | `GET /audit` |
| Settings | `settings.get/save`, `integrations.list/connect/disconnect` | `GET /settings`, `PATCH /settings`, `GET /settings/integrations`, `POST /settings/integrations/:id/connect`, `POST /settings/integrations/:id/disconnect` |
| Dashboard | `dashboard.load` | `GET /dashboard` |
| Tasks | `tasks.list/get/create/update/delete/setStatus/addComment` | `GET /tasks`, `POST /tasks`, `GET /tasks/:id`, `PATCH /tasks/:id`, `DELETE /tasks/:id`, `POST /tasks/:id/status`, `POST /tasks/:id/comments` |
| Projects | `projects.list/create/setStatus` | `GET /projects`, `POST /projects`, `POST /projects/:id/status` |
| Announcements | `announcements.list/publish` | `GET /announcements`, `POST /announcements` |
| Documents | `documents.list/upload/delete` | `GET /documents`, `POST /documents`, `DELETE /documents/:id` |
| Messages | `messages.inbox/directory/thread/send/unreadCount` | `GET /messages`, `GET /messages/directory`, `GET /messages/unread-count`, `GET /messages/:peerId`, `POST /messages/:peerId` |
| Warehouses | `warehouses.list/create/update/delete` | `GET /warehouses`, `POST /warehouses`, `PUT /warehouses/:id`, `DELETE /warehouses/:id` |
| Suppliers | `suppliers.list/create/update/delete` | `GET /suppliers`, `POST /suppliers`, `PUT /suppliers/:id`, `DELETE /suppliers/:id` |
| Raw batches | `rawBatches.list/create/update` | `GET /raw-batches`, `POST /raw-batches`, `PUT /raw-batches/:id` |
| Products | `products.list/create/update` | `GET /products`, `POST /products`, `PUT /products/:id` |
| Production | `production.list/create` | `GET /production`, `POST /production` |
| Procurement | `procurement.list/request/decide` | `GET /procurement`, `POST /procurement`, `POST /procurement/:id/decision` |
| Assets | `assets.list/create` | `GET /assets`, `POST /assets` |
| Maintenance | `maintenance.list/create` | `GET /maintenance`, `POST /maintenance` |
| Customers | `customers.list/create/update/setCategory/delete` | `GET /customers`, `POST /customers`, `PUT /customers/:id`, `POST /customers/:id/category`, `DELETE /customers/:id` |
| Catalog | `catalog.list/create/update/setActive/delete` | `GET /catalog`, `POST /catalog`, `PUT /catalog/:id`, `POST /catalog/:id/active`, `DELETE /catalog/:id` |
| Quotations | `quotations.list/create/setStatus` | `GET /quotations`, `POST /quotations`, `POST /quotations/:id/status` |
| Estimates | `estimates.list/create/update/delete/setStatus/convertToQuotation` | `GET /estimates`, `POST /estimates`, `PUT /estimates/:id`, `DELETE /estimates/:id`, `POST /estimates/:id/status`, `POST /estimates/:id/convert` |
| Sales orders | `salesOrders.list/createFromQuotation/setStatus` | `GET /sales-orders`, `POST /sales-orders`, `POST /sales-orders/:id/status` |
| Invoices | `invoices.list/createFromOrder/createFromQuotation/createManual/update/delete/void/markPaid/recordPayment` | `GET /invoices`, `POST /invoices`, `POST /invoices/from-order`, `POST /invoices/from-quotation`, `PATCH /invoices/:id`, `DELETE /invoices/:id`, `POST /invoices/:id/void`, `POST /invoices/:id/mark-paid`, `POST /invoices/:id/payments` |
| Payments | `payments.list/delete` | `GET /payments`, `DELETE /payments/:id` |
| Receipts | `receipts.list` | `GET /receipts` |
| Expenses | `expenses.list/request/decide/update/delete/markPaid` | `GET /expenses`, `POST /expenses`, `PATCH /expenses/:id`, `DELETE /expenses/:id`, `POST /expenses/:id/decision`, `POST /expenses/:id/mark-paid` |
| Commercial settings | `commercialSettings.get/save/addTaxRate` | `GET /commercial-settings`, `PATCH /commercial-settings`, `POST /commercial-settings/tax-rates` |
| Reports | `reports.summary`, `marketing.dashboard`, `finance.dashboard`, `commercial.dashboard` | `GET /reports/summary`, `GET /reports/marketing`, `GET /reports/finance`, `GET /reports/commercial` |
| AI Assistant | `ai.chat` — no kernel equivalent, see below | `POST /ai/chat` |

Errors use the kernel's own error codes (`invalid` / `auth` / `forbidden` /
`notfound` / `conflict`) mapped to real HTTP status codes (400/401/403/404/409)
instead of the kernel's always-200 `{ ok:false, error }` envelope — so the
frontend's existing error-code branching (`if (err.code === 'forbidden')`
etc.) still works, it just reads `response.status` / the parsed body instead
of `result.ok`.

## What a frontend swap looks like

Every screen currently does:

```js
const result = await BambooKernel.call('leave.decide', { id, decision, note });
if (!result.ok) { showError(result.error.message); return; }
useResult(result.data);
```

Becomes:

```js
const res = await fetch(`/api/leave/${id}/decision`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ decision, note })
});
if (!res.ok) { const { error } = await res.json(); showError(error.message); return; }
useResult(await res.json());
```

Same params in, same shaped record out — the field names inside each record
are the kernel's own `camelCase` field names (e.g. `startDate`, `decidedBy`),
not the database's `snake_case` columns; each service module maps rows back
to that shape before returning (see `rowToLeaveRequest` in
`src/services/leave.service.js`, and the equivalent `rowTo*` mapper in every
other service).

## AI Assistant

`POST /api/ai/chat` has no kernel equivalent — the design prototype's own
AI Assistant screen calls `window.claude.complete`, a bridge that only
exists inside that design tool's own preview runtime. This is a real
implementation instead: `src/services/ai.service.js`'s `chat(ctx, message,
history)` assembles a permission-scoped JSON snapshot of company data
(`buildContext`, reusing `dashboard.service.js`'s already-permission-gated
`load()` plus a few detail lists — low-stock products, the caller's own
approval queue, this month's/year's revenue — each included only if
`ctx.can(...)` allows it, mirroring the prototype's own "nulls mean they
lack that permission" intent), then proxies to Anthropic's Messages API
with that snapshot as system context.

Requires `ANTHROPIC_API_KEY` in `.env` (get one at
[console.anthropic.com](https://console.anthropic.com/)); optionally
`ANTHROPIC_MODEL` (default `claude-sonnet-5`) and `ANTHROPIC_BASE_URL`
(default `https://api.anthropic.com`) — see `.env.example`. Left unset,
the endpoint still returns `200` with a normal chat reply — "The AI
assistant needs an ANTHROPIC_API_KEY configured on the server, which is
not set for this environment." — rather than an error, since the frontend
renders it as an ordinary message bubble, matching the prototype's own
`sendAi()`, which turns both the missing-bridge case and any API error
into an assistant-role chat message instead of a thrown error. No
permission gate beyond `requireAuth` — the nav entry itself is ungated in
`navModel.js`, and every reply is already scoped by what `buildContext`
included for that caller.

## Testing

Six integration test files (Node's built-in test runner + `fetch`, no extra
dependencies), one per batch, all running the real Express app against a
real Postgres connection:

- `test/smoke.test.js` — auth + leave end-to-end (the original PoC).
- `test/people-governance.test.js` — employees/departments/roles/users/
  attendance/audit/settings/dashboard.
- `test/work-comms.test.js` — tasks/projects/announcements/documents/messages.
- `test/operations.test.js` — warehouses/suppliers/raw batches/products/
  production/procurement/assets/maintenance.
- `test/commercial.test.js` — the full quote-to-cash flow, expense approvals
  through the shared queue, estimate conversion, reports, commercial settings.

```bash
npm run migrate
npm run seed    # tests depend on the seeded demo accounts
npm test
```

## Known gaps

- Logout is stateless (JWT expiry-bounded, `JWT_EXPIRES_IN`); there's no
  server-side revocation list. Add one if immediate forced-logout is a
  requirement.
- File storage (Documents module — currently stores a filename string, no
  actual upload) and real TimeStation/Square/Slack/QuickBooks sync
  (currently credential storage only, matching the prototype's own scope)
  are still architecture-only — `PROJECT_NOTES.md` items 5 and 8. The AI
  Assistant proxy (item 6) is implemented — see "AI Assistant" above —
  though it needs an operator-supplied `ANTHROPIC_API_KEY` to answer for
  real rather than returning its "not configured" fallback.
- The real frontend (`../frontend`, React + Vite) now covers every screen
  in the prototype's nav except the rest of Intelligence beyond the AI
  Assistant — see `../frontend/README.md`. `Bamboo OS.dc.html` itself is
  unchanged and remains the design/behavior reference, not something this
  backend serves. Production secrets/deployment and replacing the seed
  data with real company data are still open, per `PROJECT_NOTES.md`'s
  launch checklist.
