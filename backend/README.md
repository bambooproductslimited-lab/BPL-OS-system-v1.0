# Bamboo OS Backend

Real Node.js/Express + PostgreSQL backend for the Bamboo Products Limited
Company OS, replacing the design prototype's `core/kernel.js` (which ran
entirely client-side against `localStorage`, with a non-cryptographic
password digest standing in for real auth).

This first pass implements **auth + the leave request resource end-to-end**
as a proof of concept, plus the **full database schema** for every module in
the original data model (see [`PROJECT_NOTES.md`](../design_handoff_bamboo_company_os/PROJECT_NOTES.md)
and [`README.md`](../design_handoff_bamboo_company_os/README.md) in
`design_handoff_bamboo_company_os/` for the prototype's own account of the
system). Every file here is commented with which part of `kernel.js` it
ports from, so this can be extended module-by-module.

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

`0001`–`0005` cover everything the auth + leave PoC actually uses
(extensions, departments/employees, roles/permissions/users, leave/attendance/
approvals, audit/notifications/settings). `0006`–`0008` create the tables for
every other module in the prototype's data model (tasks/projects/announcements/
documents/messages, production/inventory/procurement/assets, and the
commercial quotation/invoice/payment stack) so the schema is ready ahead of
those modules' routes — see "Extending to the rest" below.

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

## Seeding

`npm run seed` ports `kernel.js`'s `seed()` **plus** the parts of its
`MIGRATIONS` array that shape the final dataset (the Information Technology
department + Emmanuel Chang from migration 17, the final 12-role permission
grants after migrations 3/4/11's additive grants are folded in, etc.) — see
the comments at the top of `src/db/seed.js` for exactly which permissions
came from which migration. It is **destructive**: it `TRUNCATE`s every table
first, exactly like the prototype's `BambooKernel.call('dev.reset')`. Don't
point it at anything with real data.

Not currently seeded (out of scope for this pass, tracked as a gap rather
than silently dropped): the 10-working-day attendance history `seed()`
generates. Add it to `src/db/seed.js` alongside `leave_balances` when the
attendance routes are built.

## RBAC

`src/middleware/rbac.js` ports `require_(ctx, perm)` → `requirePermission(perm)`
middleware, and `visibleEmployee(ctx, emp)` verbatim (self → department →
whole reporting subtree via a walk up `manager_id` → `employee.read.all`
escapes all of it). `src/services/context.service.js` ports `ctxFor(user)` /
`permissionsOf(user)` — every authenticated request gets a `req.ctx` with
`.can(perm)`, exactly like the kernel's per-call `ctx`. **Permissions are
resolved server-side on every request from the roles in the database**, never
trusted from the client, matching `PROJECT_NOTES.md`'s explicit warning not
to treat the frontend's `can()` checks as a security boundary.

## Endpoints (this pass)

| Kernel method | Route |
|---|---|
| `auth.login` | `POST /api/auth/login` |
| `auth.logout` | `POST /api/auth/logout` |
| `api.currentContext()` | `GET /api/me` |
| `me.summary` | `GET /api/me/summary` |
| `leave.types` | `GET /api/leave/types` |
| `leave.list` | `GET /api/leave?status=` |
| `leave.request` | `POST /api/leave` |
| `leave.decide` | `POST /api/leave/:id/decision` |
| `leave.cancel` | `POST /api/leave/:id/cancel` |
| `approvals.queue` | `GET /api/approvals/queue` (leave requests only for now — see below) |

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
`src/services/leave.service.js`).

## Testing

`test/smoke.test.js` is an end-to-end integration test (Node's built-in test
runner + `fetch`, no extra dependencies) covering login success/failure,
the 401/403/404/409 paths, the full leave request → approve/reject/cancel
lifecycle, balance updates, and record-level visibility scoping. It runs the
real Express app against a real Postgres connection:

```bash
npm run migrate
npm run seed    # tests depend on the seeded demo accounts
npm test
```

## Extending to the rest

The tables already exist (migrations `0006`–`0008`). For each remaining
kernel method group:

1. Add a `src/services/<module>.service.js` porting that group's handlers
   from `kernel.js`, same pattern as `leave.service.js`: validate with `V.*`
   from `src/utils/validate.js`, run mutations through `withTransaction`
   when more than one table changes, call `audit()` and `notify()` at the
   same points the kernel does.
2. Add a `src/routes/<module>.routes.js`, `requireAuth` + `requirePermission()`
   at the same permission gates the kernel's `require_()` calls used.
3. Mount it in `src/app.js`.

`approvals.service.js` is deliberately generic over `subject_type` already —
extending `procurement_request` and `expense` approvals is adding their
detail-lookup branch there, not restructuring the queue.

## Known gaps in this pass

- Logout is stateless (JWT expiry-bounded, `JWT_EXPIRES_IN`); there's no
  server-side revocation list. Add one if immediate forced-logout is a
  requirement.
- File storage (Documents module), the AI Assistant proxy, and the real
  TimeStation/Square/Slack/QuickBooks integrations are all still
  architecture-only, same as the prototype — `PROJECT_NOTES.md` items 5–6
  weren't in scope for this pass.
