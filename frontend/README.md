# Bamboo OS Frontend

Real React + Vite frontend for the Bamboo Products Limited Company OS,
talking to the [`../backend`](../backend) API. This is the actual deployable
application — **not** `design_handoff_bamboo_company_os/Bamboo OS.dc.html`,
which is an artifact from a proprietary design tool (it depends on
`support.js`, a `_ds_bundle.js` design-system bundle, and a `DCLogic` base
class that only exist inside that tool's runtime) and cannot run standalone.
That file is the **design/behavior reference** — screens, copy, workflows,
the sidebar structure — not code to edit in place. This app is a fresh
implementation of that design, built screen by screen against the real API.

## Screens built so far

- **Login** — the split-screen sign-in matching the prototype's design, with
  one-click demo-account fill.
- **Dashboard** — KPI tiles (headcount, attendance, leave, plus five more
  that only appear when the signed-in role has the matching permission —
  low stock, pending purchase requests, assets due service, outstanding
  invoices, pending expense claims), an attendance-by-department table
  with progress bars, an unpermission-gated "Needs your attention" panel
  that links into Leave/Attendance/Approval centre, and a "Latest
  activity" audit feed visible only with `audit.read`. The prototype's
  `dashboardFocus` prop (a design-tool-only "operations vs executive" KPI
  filter with no in-app control) always resolves to its "operations"
  default here, i.e. the full KPI set.
- **App shell** — permission-scoped sidebar nav (ported from the prototype's
  `navModel()`), header, session handling. Every nav item routes somewhere;
  screens not built yet render a "Coming soon" placeholder.
- **Leave** — the full request → approve/reject/cancel lifecycle: a request
  form with a live remaining-balance hint, a filterable list (pending/
  approved/rejected/all) scoped to what the signed-in user can see, a
  confirm-with-note dialog for decisions, and self-service cancel on your
  own pending requests. This is the reference implementation for what a
  "real" screen looks like here — see "Adding the next screen" below.
- **Employee directory** — search (debounced) by name/code/job title,
  department filter, a show-terminated toggle, and (for `employee.write`)
  add/edit/terminate dialogs plus a permanent-purge action gated on
  `role.manage`. Visibility is entirely server-driven: an admin sees every
  employee with a "company-wide access" footnote, while an ungranted
  employee sees only themself with a "limited to your department and
  reporting line" footnote — the frontend doesn't compute this, it just
  renders whatever rows and footnote the API returns.
- **Departments** — a list plus an inline (non-modal) create/edit form,
  visible only with `department.manage`. Delete is only offered on
  departments with zero headcount, matching the backend's own guard.
- **Attendance** — the manager/HR roster view for a given day: a date
  picker, four summary tiles (in scope / present / late / no record), and
  a table of everyone in the signed-in user's scope for that date. With
  `attendance.adjust`, each row gets a "Correct" action (a dialog for
  clock in/out, status, and a required reason logged to the audit trail)
  and, once a real record exists, a "Delete" action. Clock in/out for
  yourself lives on "My space", not here — this screen is read-only plus
  corrections, matching the prototype's split between the two screens.
- **My space** — the self-service home screen: your own clock in/out with
  a live headline ("Not clocked in" / "On duty since 07:55" / a completed
  "07:55 → 17:00" range) and buttons that disable themselves correctly
  once you've clocked in or out for the day, your leave balances for the
  current year, and your own leave requests with self-service cancel on
  pending ones — the same `GET /api/me/summary` endpoint the Leave screen
  reads balances from.
- **Tasks** — scope toggle (my tasks / everything in scope), status and
  text search filters, an inline create form for `task.manage`, and a
  table with self-service inline editing: anyone who can see a task can
  change its status from the row (status changes aren't gated on
  `task.manage` — only who's *allowed to see the task* controls that, per
  the backend's `taskVisible()`), while start/due date edits and delete
  stay manager-only. Clicking a title opens a detail dialog with the full
  record, an edit form, and a comment thread anyone in scope can post to.
- **Projects** — a card grid (code, department, status tag, owner,
  deadline, and a task-completion progress bar), with a "New project"
  dialog for `project.manage`. Deliberately read-only otherwise: the
  prototype defines a `setProjectStatus` handler but never wires it to
  any control on this screen, so this screen doesn't add one either, even
  though the backend's `POST /projects/:id/status` endpoint exists and
  works. Visibility is department-scoped — a project shows up if it's in
  your department, you own it, or you're a member, which the frontend
  doesn't compute; it just renders whatever cards the API returns.
- **Announcements** — a feed (audience · date · publisher eyebrow, title,
  body) with a "Publish announcement" dialog for `announcement.publish`,
  audience defaulting to all staff or scoped to one department. `pinned`
  is always published as `false`, matching the prototype, which hardcodes
  it on publish and never renders a pin control or badge anywhere.
  Visibility follows the backend's `announcementVisible()`: all-staff
  posts show for everyone, department-scoped posts show for that
  department or for anyone with `employee.read.all`.
- **Documents** — a table (title, category, file name, visibility tag,
  uploaded date, uploader) with an "Add document" dialog for
  `document.manage`. Metadata only — there's no real file upload, matching
  both the prototype's own note in the dialog ("file storage is not wired
  up in this prototype") and the backend's known gaps. "My department
  only" visibility scopes to the *uploader's* department at upload time —
  there's no department picker in the dialog, because the prototype
  doesn't have one either.
- **Messages** — a two-pane inbox: a conversation list (peer name, date,
  a "You: " preview prefix on your own last message, an unread-count
  badge) on the left, and the active thread's bubbles (yours right-aligned
  in accent green, theirs left-aligned neutral) with a compose box on the
  right. A "New message" dialog picks a recipient from the active-employee
  directory (self excluded) and opens a thread. Opening a thread marks it
  read server-side, same as the prototype.

Also built: **Dashboard** — see its own entry above, at the top of the
Overview group.

**Operations group** (all five screens, completing this nav group):

- **Suppliers** — table + create/edit/delete dialog gated on
  `supplier.manage`; delete only offered when `batchCount === 0`.
- **Products & inventory** — table + create/edit dialog gated on
  `inventory.manage`, with a low-stock tag driven by the backend's own
  `currentStock <= reorderLevel` check.
- **Assets & maintenance** — asset registry (register-only — the
  prototype's asset rows have no edit/delete action, just the two
  toolbar buttons) plus a maintenance history log, both gated on
  `asset.manage`.
- **Raw bamboo & production** — the largest screen in the app: a raw
  bamboo receiving form + stock table (inline edit, not a dialog — matches
  the prototype's own top-of-page edit pattern), a warehouses table +
  dialog, and a production-batch recording form + table. All three forms
  are gated on `production.manage`; two fields the prototype tracks but
  never exposes a control for (raw batch unit, always `'kg'`; production
  line, always `'Weaving Line'`) are reproduced exactly rather than given
  new UI. The supplier and output-product `+ New` buttons inline in the
  forms open the same create dialogs as the Suppliers and
  Products & inventory screens, matching the prototype's shared-dialog
  pattern. Suppliers/products are only fetched when `production.manage`
  is present — a read-only viewer (e.g. a Line Supervisor) may hold
  `production.read` without `supplier.read`, and fetching a dropdown
  dataset the create form won't render for them just to 403 was a real
  bug caught while testing (see Testing section).
- **Procurement** — a purchase-request form gated on
  `procurement.request`, and a table with single-click Approve/Reject
  (no confirmation dialog — the prototype doesn't have one here, unlike
  Leave's decision dialog, because procurement decisions carry no note
  field) gated on `procurement.approve` and excluding your own requests.

**Governance group:**

- **Approval centre** — a single unified queue of everything with
  `approval.act` routed to you: leave requests, purchase requests, and
  expense claims, each rendered from the polymorphic
  `GET /approvals/queue` response (see `approvals.service.js`'s
  `subjectType`-gated detail query) with single-click Approve/Reject.
  **Deliberate deviation from the prototype**: its Approve/Reject buttons
  always call `leave.decide` regardless of subject type — a latent bug in
  the design that only works for leave requests, since procurement and
  expense approvals were added to the backend's queue after that dialog
  wiring was drawn (see `../backend/README.md`'s endpoint table, which
  marks `GET /approvals/queue` as "fully polymorphic" across all three
  subject types). This port dispatches each decision to the
  real endpoint for its `subjectType` (`POST /leave/:id/decision`,
  `POST /procurement/:id/decision`, `POST /expenses/:id/decision`)
  instead of carrying that bug forward — matching the buggy behavior here
  would make procurement/expense approvals silently fail against a real
  backend, which is a worse outcome than the one specific deviation.

**Finance group** (all three screens, completing this nav group):

- **Expenses** — a submit-claim form gated on `expense.request`, and a
  table with the fullest action surface of any list screen yet:
  Approve/Reject (pending, `expense.approve`, not your own claim),
  "Mark paid" (approved claims, `expense.approve`), and Edit/Delete (any
  pending claim you either own or can approve) — Edit opens the same
  "Edit expense claim" dialog for both the requester and an approver,
  and Delete goes through the app's shared confirm-delete dialog, since
  the prototype uses that generic pattern here (unlike Procurement's
  single-click Approve/Reject, which has no such dialog because it
  carries no note field).
- **Reports** — six KPI tiles (invoiced/collected/outstanding/orders/
  quotations-accepted/expenses-approved) plus two breakdown tables
  (expenses by category, sales by customer), all read from
  `GET /reports/summary` — no forms, purely a read view.
- **Finance dashboard** — six more KPI tiles (cash collected, net
  position, outstanding, overdue, pending claims, approved this month),
  a revenue-vs-expenses bar chart with a Months/Years period toggle and a
  count selector (3/6/9/12) that re-fetches `GET /reports/finance` with
  the new `periodType`/`periodCount` query params, recent payments,
  overdue invoices, and expense claims awaiting a decision. "Download
  CSV" is a client-side export (an in-browser `Blob` + `<a download>`,
  no server endpoint), ported line-for-line from the prototype's own
  `downloadFinanceCsv` handler. Since Quotations & Invoicing isn't built
  yet, invoices/payments stay at zero in a fresh database — the KPIs and
  tables are still live and correct, just quiet until that module exists.

**Quotations & Invoicing group** (all nine screens, completing this nav
group — Sales orders and the Marketing dashboard live in the separate
Insights group and are still placeholders):

- **Clients** (`customers`) — table with quoted/invoiced/paid/outstanding
  totals per customer, plus create/edit/delete dialogs gated on
  `customer.manage`. Delete is only offered when a customer has no
  quoted or invoiced total, matching the backend's own linked-records
  guard (it also blocks on linked estimates, which the frontend doesn't
  duplicate — it just surfaces the backend's error if that edge is hit).
- **Products & Services** (`catalog`) — table + add/edit dialog +
  archive/unarchive toggle + delete, all gated on `catalog.manage`.
  **Deliberate deviations**: (1) the prototype shows every write control
  here to anyone with `catalog.read`, no `catalog.manage` check at all —
  unlike every other CRUD screen in this app, and real seeded roles
  (supervisor, marketing_manager) have `catalog.read` without
  `catalog.manage`, so literal fidelity would show buttons that always
  403. Gated on `catalog.manage` instead for consistency with the rest
  of the app and the backend's actual enforcement. (2) the tax-rate
  dropdown needs `GET /commercial-settings`, which requires
  `settings.manage` — a narrower permission than `catalog.manage`
  (`department_manager` has the former without the latter in this
  app's seed). That fetch, and the field itself, are skipped entirely
  when the viewer lacks `settings.manage`; the backend already defaults
  an omitted `taxRateId` to its zero-rated tax.
- **Estimates** and **Quotations** — both use a shared line-item editor
  (`src/components/DocItemsEditor.jsx`, extracted once rather than
  tripled across the New Quotation/New Estimate/New Manual Invoice
  dialogs, which are near-identical in the prototype): catalogue-picker
  + description/qty/unit/price/discount/discount-type/tax-rate columns
  per line, an "+ Add line" button, and a live subtotal/discount/tax/
  total footer computed client-side with the same formula as the
  backend's `computeDocTotals`. Picking a catalogue item sets
  description/unit/price/qty but deliberately leaves tax rate untouched
  — a real quirk in the prototype's own `applyCatalogItem`, reproduced
  rather than "fixed", since it's intentional-looking dead code, not a
  crash. Estimates additionally support Finalize → Convert to quotation
  → Edit (draft only) → Delete (blocked once converted) and a
  print-style Preview; Quotations support Send → Accept/Reject →
  Convert to invoice and Preview, with no edit/delete (the backend
  doesn't expose them for quotations — once created, a quotation only
  moves through its status lifecycle). **Deviation**: the prototype's
  estimate row has an ungated `canFinalize` (unlike its sibling
  `canConvert`/`canEdit`/`canDelete`, which all check
  `can('quotation.manage')`) — gated the same way here for consistency
  and to match the backend's actual `estimates.setStatus` enforcement.
  Both "New …" buttons are additionally gated on `customer.read`, since
  the dialog's customer picker can't function without it — in this
  app's seed every `quotation.manage` role also has `customer.read`, so
  this never removes the button today, but it's a real dependency the
  code shouldn't silently assume holds forever.
- **Invoices** — manual creation (same shared line-item editor) plus an
  "issue invoice for a sales order" form, a print-style Preview, Record
  payment (a dialog pre-filled with the outstanding balance, method/
  date/reference/notes, generating a receipt server-side), Edit
  (due date/PO reference only — the only two fields the backend's
  `invoices.update` accepts), Void, and Delete (both blocked once any
  payment is recorded, matching the backend's guards). **Deviation,
  same shape as Catalog's tax-rate gap**: this app's seed has
  `invoice.manage` roles (`finance_manager`, `finance_hr_manager`) that
  lack `customer.read` and `sales.read` — unlike `quotation.manage`
  roles, which always carry `customer.read` here. So "New manual
  invoice" additionally needs `customer.read` (its dialog can't
  function without a customer list) and the sales-order form
  additionally needs `sales.read` (its dropdown is populated from
  `GET /sales-orders`) — both simply don't render for a role that can't
  populate the picker they need, verified end-to-end as
  `finance_hr_manager` (see Testing). Preview degrades gracefully too:
  without `customer.read` it still opens, using the invoice's own
  `customerName` from the list join and leaving the email blank instead
  of crashing.
- **Payments** — a read-only ledger (invoice, customer, amount, date,
  method, reference, received by) with one action: Delete, gated on
  `invoice.manage`. Deleting a payment also removes its linked receipt
  and rolls the invoice's `amountPaid`/`balanceDue`/`status` back
  server-side (`payments.service.js`'s `remove`) — verified end-to-end
  that a deleted payment correctly reverts a `paid` invoice to
  `unpaid` with its full balance restored.
- **Receipts** — a read-only ledger plus a print-style Preview dialog
  (ported from `dialog.receiptPreview`, including its "Print" button —
  `window.print()`, same as the prototype). Receipts have no create or
  delete of their own anywhere in the app; they're a pure byproduct of
  `invoices.recordPayment`.
- **Overview** (`qioverview`) — 14 KPI tiles (quotation counts by
  status, conversion rate, invoice totals, outstanding/overdue,
  revenue this month/year), a 6-month invoiced-vs-collected bar table,
  and four "recent/upcoming" tables (quotations, invoices, due dates,
  overdue, payments), all from `GET /reports/commercial`. Fixed a real
  backend gap while wiring this up: `reportsService.commercialDashboard`
  mapped `recentInvoices` through the same lean `invRow` helper used for
  `upcomingDue`/`overdueInvoices` (invoice number/customer/balance/due
  date only), but this screen's "Recent invoices" table needs the
  invoice's total and status — added a small `recentInvoiceRow` mapper
  for that one field instead of touching the other two, which were
  already correct for what they render.
- **Settings** (`billingsettings`) — document templates/defaults
  (quotation intro/footer, invoice footer, payment terms, terms &
  conditions, default validity/due-date windows), payment details shown
  on invoices (bank/mobile money details, instructions), a read-only
  document-numbering table (next number per doc kind, computed
  client-side the same way the prototype does), and a tax-rate table +
  add form. All gated on `settings.manage`, same permission the nav
  entry itself requires, so — unlike Catalog's tax-rate field — there's
  no viewer who can reach this screen without also being able to load
  its data.

**Insights group** (both screens):

- **Marketing dashboard** (`marketing`) — customer pipeline by category
  with share bars, a quotation funnel (sent/accepted/rejected-expired/
  conversion rate), top customers by sales value, recent quotations, and
  a leads-and-prospects follow-up table, all from
  `GET /api/reports/marketing` (requires `customer.read`, same
  permission the nav entry is gated on). Purely a read view — no forms.
- **Sales orders** (`salesorders`) — a "create order from an accepted
  quotation" form plus a table with a single status-advance action per
  row ("Start processing" then "Mark delivered"), backed by
  `GET/POST /api/sales-orders` and `POST /api/sales-orders/:id/status`.
  **Deviation**: the prototype's advance action (`hasNext`/`advance`)
  has no permission check at all, unlike the create form above it, which
  is wrapped in `can.salesManage` — real seeded roles have `sales.read`
  without `sales.manage` (supervisor), so literal fidelity would show a
  button that always 403s. Gated on `sales.manage` here too, matching
  `salesOrders.service.js`'s actual enforcement. The create form is
  additionally gated on `quotation.read` (its dropdown needs
  `GET /quotations` filtered to `accepted`) — same reasoning as the
  `customer.read`/`catalog.read`/`sales.read` gates added throughout the
  Quotations & Invoicing screens: every `sales.manage` role in this
  app's seed also has `quotation.read` today, but the code shouldn't
  silently assume that holds forever.

**Governance group** (the rest of it — Approval centre was built earlier):

- **Roles & permissions** (`roles`) — a permission × role matrix (one
  checkbox per permission/role pair), backed by `GET /api/roles`,
  `GET /api/roles/permissions` (the static catalogue), and
  `POST /api/roles/:roleId/permissions`. The System Administrator
  column is always disabled — the backend rejects any change to it
  ("must always retain full access") — and, beyond what the prototype
  itself locks, every checkbox is also disabled for a viewer without
  `role.manage`: `roles.list` only requires `employee.read`, so unlike
  most other screens here the read and write gates genuinely differ,
  even though the nav entry itself is gated on `role.manage` today.
- **User accounts** (`users`) — one row per login with an inline role
  select and an Enable/Disable action, backed by `GET /api/users`,
  `POST /api/users/:id/role`, and `POST /api/users/:id/status`. The
  signed-in user's own row has no role select or status button at all
  (the backend rejects changing your own role or disabling your own
  account), rather than showing controls that would round-trip into a
  403.
- **Audit log** (`audit`) — a debounced text filter (matches
  action/summary/actor name server-side) over the most recent 120
  entries, from `GET /api/audit?q=`.
- **Company settings** (`settings`) — company name/short name/country/
  currency/work week/late-cutoff fields plus a read-only "leave approval
  chain" line, from `GET/PATCH /api/settings`. **Viewing and saving use
  different permissions**: the nav entry (and `settings.get`) only need
  `employee.read`, which nearly every role has, but `settings.save`
  needs the much narrower `settings.manage` (e.g. `hr_manager` has the
  former without the latter in this app's seed) — so unlike Billing
  settings in Quotations & Invoicing, where both permissions always
  match, this screen genuinely needs a read-only mode: every field and
  the Save button are disabled with an explanatory note for anyone
  without `settings.manage`, matching the prototype's own
  `settingsLocked`/`settingsNote`. Deliberately omitted: the prototype
  also shows "Data schema v{{ schemaVersion }}" next to the approval
  chain — `schemaVersion` is a property of the design tool's own
  in-memory kernel with no equivalent in this Postgres-backed backend,
  so it's left out rather than inventing a fake version number.
- **Integrations** (`integrations`) — a card grid (TimeStation, Square,
  Slack, QuickBooks) with an API-key field and Connect/Disconnect,
  backed by `GET /api/settings/integrations` and its connect/disconnect
  endpoints (all three require `settings.manage`, matching the nav
  gate, so there's no read-only case to handle here). Once connected,
  the key field always shows a masked placeholder rather than
  re-displaying the stored value — ported from the prototype's own
  `keyValue: i.connected ? '••••••••••••' : draft`, which never shows a
  secret back once it's been saved, even though the backend's response
  technically includes the real value.

Everything else in the nav (Intelligence) is still a placeholder — the
backend routes exist and are tested, they just don't have a frontend
screen yet.

## Setup

```bash
cd frontend
npm install
cp .env.example .env.local   # VITE_API_URL, defaults to http://localhost:4000/api
npm run dev                  # http://localhost:5173
```

Requires the backend running against a migrated + seeded Postgres database
— see [`../backend/README.md`](../backend/README.md). The backend's
`CORS_ORIGIN` defaults to `http://localhost:5173`, matching Vite's default
port, so no config changes are needed to run both locally.

Sign in with any seeded demo account (password `bamboo123`) — the login
screen has one-click quick-fill buttons for all seven.

## Architecture

- **`src/api/client.js`** — the one place that knows the API base URL, the
  bearer token, and the backend's error shape (`{ error: { code, message } }`,
  see `backend/src/utils/errors.js`). Every other module calls through this.
- **`src/auth/AuthContext.jsx`** — session state (`login`/`logout`/`can(perm)`),
  and rehydration on page load: if a token is in `localStorage`, it calls
  `GET /api/me` to restore the session rather than trusting a stale client-side
  copy — the same "never trust the client" posture the backend README
  describes for permissions.
- **`src/auth/ProtectedRoute.jsx`** — redirects to `/login` (preserving the
  intended destination) when there's no session; shows a loading state
  during the rehydration round-trip so an authenticated user never
  flash-redirects to login on refresh.
- **`src/layout/navModel.js`** — ported directly from `Bamboo OS.dc.html`'s
  `navModel()`: same groups, labels, and `perm` gates. `AppShell.jsx` filters
  each group's items through `can(item.perm)`, so the sidebar a given role
  sees always matches what the backend would actually let them do — this is
  still just UX (the backend enforces permissions server-side regardless),
  but it should stay in sync with the real grant matrix, not drift from it.
- **`src/styles/theme.css`** — design tokens approximating the prototype's
  "Modernist" design system (flat, high-contrast, Archivo typeface, zero
  border-radius, strong 2px dividers, single accent color) per
  `design_handoff_bamboo_company_os/PROJECT_NOTES.md`. The prototype's own
  CSS bundle isn't available outside its design tool, so this is a fresh
  implementation of the same visual language, not a port of that file. Also
  holds the shared component primitives every list-style screen will reuse:
  `.table`, `.tag`/`.tag-neutral`/`.tag-outline`/`.tag-accent` (status
  colors, ported from the prototype's `tag(status)` mapping), `.seg`/
  `.seg-opt` (segmented filter control), `.dialog-backdrop`/`.dialog`
  (confirm/edit modals), `.toast`.

## Adding the next screen

1. Build the page component under `src/pages/`, calling `api.get/post/patch/put/del`
   from `src/api/client.js` against the matching route in
   `../backend/README.md`'s endpoint table.
2. Register it in `BUILT_SCREENS` in `src/App.jsx` (maps a nav `key` to a
   component) — it replaces that item's placeholder automatically, no other
   routing changes needed.
3. If the screen needs a permission check beyond what's already implied by
   its nav gate, use `useAuth().can('permission.key')`.

## Testing

Verified end-to-end with a real browser (Playwright) against the real
backend for each screen as it's built: login success/failure, demo account
fill, permission-scoped nav differing by role, session persistence across a
page reload (JWT rehydration), protected-route redirect when
unauthenticated, sign-out, and for Leave specifically — submitting a
request, the manager-approve and manager-reject flows (with the note
dialog), self-service cancel, the "no read-all -> only your own requests"
scoping, and a real validation-error round trip (end date before start
date) rendering the backend's exact message instead of crashing. For the
Employee directory and Departments screens: as an admin, search filtering,
create/edit/terminate/purge on employees and create/edit/delete on
departments (including the zero-headcount delete guard, checked both ways —
allowed on an empty department, hidden on one with staff); as an
unprivileged employee (no `employee.write`/`department.manage`), confirmed
the directory is scoped to just that person's own record, all write
buttons and the department form are absent, and none of that is a
frontend-only restriction — it mirrors what the backend actually returns
and allows. For Attendance: as an admin, the roster and summary tiles for
the full company scope, plus a correction saved through the dialog and
reflected immediately; as the same unprivileged employee, the roster
scoped to just her own row with no Correct/Delete controls. For My space:
clocking in (headline and button states updating live, status correctly
computed as "late" against the configured cutoff), clocking out, and the
leave balances/requests tables rendering real data from the same account.
For Tasks: as an admin, create/edit/comment/delete and a self-service
inline status change, all round-tripping correctly through the detail
dialog; as an employee with a task assigned to her but no `task.manage`,
confirmed the create form and delete are absent, the start/due date
inputs are disabled, but the status dropdown still works — matching the
backend's split between "can manage this task" and "can see this task".
For Projects: as an admin, creating projects in two different
departments; as the same employee (in the Production department, no
`project.manage`), confirmed she sees the Production project but not the
one created in Finance, and the "New project" button is absent — the
department-scoped visibility and the create gate both enforced
server-side. For Announcements: publishing one all-staff and one
Production-only notice as an admin, then confirming an employee in
Production sees both, while a Finance department manager with no
`employee.read.all` sees only the all-staff one — the same
`employeeReadAll`-widens-visibility rule the backend documents. For
Documents: uploading one doc at each visibility level (all staff,
department-only, managers-only) as an admin, confirming the visibility
tags render correctly and delete works; as the same Production employee
with no `document.manage`, confirmed she sees neither the
department-only doc (scoped to the uploader's own department, Human
Resources & Admin, not hers) nor the managers-only doc, and no add/remove
controls. For Messages: starting a new conversation from the directory,
sending a message, confirming it appears in the recipient's inbox with an
unread badge and the correct "You: " preview prefix, replying, and
confirming the badge clears once the thread is opened (the backend marks
messages read on GET /messages/:peerId). For the Dashboard: as an admin,
the full 10-tile KPI set, a 10-row department table, and both
attention-row links navigating correctly to `/leave` and `/attendance`;
as the same Production employee, confirmed only the 5 permission-free
KPIs render, the department table is scoped to just her own department,
and the "Latest activity" feed is absent (no `audit.read`) while the
attention panel still shows — it's not gated on any permission in the
prototype either, just informational. For the five Operations screens:
as an admin, the full create/edit/delete lifecycle on each (suppliers,
products, assets, maintenance records, warehouses, raw batches,
production batches, purchase requests), including the inline
"+ New supplier" and "+ New product" dialogs reachable from inside the
Raw bamboo & production form, and a purchase request approved by a
second account (a Finance & HR Manager with `employee.read.all`, so the
requester — in a different department — is both visible and decidable to
them); as a Line Supervisor (read-only: `production.read`/
`inventory.read`/`asset.read` but no `*.manage`, and no `supplier.read`
or `procurement.request` at all), confirmed every create form and
edit/delete control is absent, the Procurement nav item doesn't even
appear, and — this caught a real bug — the raw batches and warehouses
tables render correctly instead of both going blank behind a permission
error, which is what happened before fixing `ProductionPage` to stop
fetching suppliers/products for a viewer whose form for them will never
render. For the Approval centre: submitted one of each subject type
(leave, procurement, expense) as one account, then as a second account
whose `employee.read.all` and matching `*.approve` grants make all three
visible and decidable, approved the leave request and expense claim and
rejected the purchase request — each decision correctly hit its own
endpoint (confirmed by re-checking the Leave and Procurement screens
afterward, which showed "approved" and "rejected" respectively) rather
than every decision going through `leave.decide` the way the prototype's
buggy dialog wiring would have. For the Finance group: as an admin,
submitting two claims, editing and deleting one, confirming self-service
Edit/Delete works without `expense.approve` and that Approve/Reject
never appears on your own claims; as a Finance & HR Manager, approving
the edited claim (the amended amount carried through correctly) and then
marking it paid, watching the status tag move pending → approved → paid;
as a plain employee, confirming she's scoped to just her own submitted
claim with no decision controls. Reports and the Finance dashboard both
render their full KPI sets and tables cleanly against a database with no
invoices/payments yet (all real zeros, not broken empty states), and the
dashboard's Months/Years period toggle correctly re-fetches and
re-renders the trend chart. For Clients and Products & Services: as an
admin (full access, including the tax-rate field), creating and editing
a customer and a catalogue item and archiving the item; as a
`department_manager` (`catalog.manage` without `settings.manage`),
confirmed the tax-rate field is absent from the item dialog and
creation still succeeds. For the full Quotations & Invoicing document
chain, as an admin: created a customer and a catalogue item, then an
estimate (picking the catalogue item to verify the description/unit/
price/qty prefill and the tax-rate-left-untouched quirk, plus a second
manual line), previewed it, finalized it, converted it to a quotation
(status and total carried through unchanged), sent and accepted the
quotation, converted it to an invoice, recorded a full payment (a
receipt was generated and shown in the toast), and confirmed the
invoice's status/balance and its Preview dialog (subtotal, items, "Total
Due GHS 0", not marked partial) all reflect the paid state correctly.
Also verified, separately: creating a manual invoice and voiding it
(Void/Delete controls correctly disappear once voided); creating another
manual invoice, recording a payment, then deleting that payment from the
Payments screen and confirming the invoice correctly reverts to
`unpaid` with its full balance restored and the receipt disappears from
Receipts; the Overview screen's 14 KPI tiles and recent-activity tables
reflecting all of the above (including the voided and rolled-back
invoices) correctly; and Billing settings — editing and saving a field,
confirming it persists across a reload, and adding a new tax rate that
then appears in its table. As `finance_hr_manager` (`invoice.manage`,
`report.read`, `settings.manage`, but no `customer.read`/`catalog.read`/
`sales.read`/`quotation.read`): confirmed Invoices/Payments/Receipts/
Overview/Settings are all reachable and functional (Edit and Delete
visible on invoice/payment rows, Preview opens without crashing despite
the missing customer email, Overview and Settings both load fully),
while "New manual invoice" and the sales-order invoice form are both
correctly absent, and Estimates/Quotations/Clients/Products & Services
don't appear in the nav at all. As a Line Supervisor (`quotation.read`/
`sales.read`/`customer.read`/`catalog.read` only, no `*.manage`, no
`invoice.read`): confirmed Estimates and Quotations render read-only —
no "New …" button, only a Preview action on each row — and
Invoices/Payments/Receipts/Overview/Settings are all absent from the
nav. For the Insights group: as an admin, creating a lead-category
customer, then a quotation for them (sent, accepted), confirming the
Marketing dashboard's pipeline table, funnel tiles, leads-to-follow-up
table, and recent quotations all reflect it correctly, then creating a
sales order from that accepted quotation and walking it pending →
processing → delivered on the Sales orders screen, with the advance
button correctly disappearing once delivered; as a Line Supervisor
(`customer.read`/`quotation.read`/`sales.read`, no `sales.manage`):
confirmed both screens appear in the nav and the Marketing dashboard
loads fully (it's read-only regardless of role), while on Sales orders
both the "create order" form and every row's advance button are
correctly absent. For the rest of Governance: as an admin, on Roles &
permissions confirmed the System Administrator column's checkboxes are
all disabled and toggling a permission on then off for another role's
row round-trips correctly; on User accounts confirmed the signed-in
user's own row has neither a role select nor an Enable/Disable button,
disabling and re-enabling a different account's status round-trips
correctly, and changing another account's role does too; on the Audit
log confirmed entries from those actions appear and the filter narrows
correctly; on Company settings confirmed the form is editable, a saved
change persists across a reload, and the leave approval chain line
renders; on Integrations confirmed all four cards render, connecting
one with an API key marks it "Connected" with the key field masked, and
disconnecting reverts it. As a `department_manager` (`employee.read`
and `approval.act`, but no `role.manage`/`user.manage`/`audit.read`/
`settings.manage`): confirmed Roles & permissions, User accounts, Audit
log, and Integrations are all absent from the nav, while Company
settings is present but fully read-only — every field and the Save
button disabled, with the "your role cannot change company settings"
note shown. No automated browser test suite is checked in yet — the
backend's Node test runner pattern (`../backend/test/`) is the natural
fit to extend to this app once there are enough real screens to make it
worthwhile.

## Known gaps

- Every screen in every nav group is now built except Intelligence
  (the AI Assistant): Overview, People, Work, Operations, Quotations &
  Invoicing, Insights, Finance, and the full Governance group (Approval
  centre, Roles & permissions, User accounts, Audit log, Company
  settings, Integrations).
- Fonts load from Google Fonts (`Archivo`); if that's unreachable (offline,
  restricted network) the app falls back to `system-ui` — visually fine,
  just not pixel-identical to the prototype's typeface.
- No production build/deploy config yet (`npm run build` works via Vite's
  defaults, but hosting, env-specific API URLs, etc. aren't set up).
- Logout is client-side token discard, matching the backend's stateless JWT
  design (see `../backend/README.md`'s own known gaps).
