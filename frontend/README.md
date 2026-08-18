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

Everything else in the nav (the whole Operations and Commercial modules,
governance screens, etc.) is still a placeholder — the backend routes
exist and are tested, they just don't have a frontend screen yet.

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
server-side. No automated browser test suite is checked in yet — the
backend's Node test runner pattern (`../backend/test/`) is the natural fit
to extend to this app once there are enough real screens to make it
worthwhile.

## Known gaps

- Login, the shell, Leave, Employee directory, Departments, Attendance,
  My space, Tasks, and Projects are built; every other nav item is still
  a placeholder.
- Fonts load from Google Fonts (`Archivo`); if that's unreachable (offline,
  restricted network) the app falls back to `system-ui` — visually fine,
  just not pixel-identical to the prototype's typeface.
- No production build/deploy config yet (`npm run build` works via Vite's
  defaults, but hosting, env-specific API URLs, etc. aren't set up).
- Logout is client-side token discard, matching the backend's stateless JWT
  design (see `../backend/README.md`'s own known gaps).
