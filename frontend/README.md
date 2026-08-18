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

## This pass: app shell + login only

Per the prototype's own permission-gated navigation model, this first slice
proves out the architecture — auth, session handling, routing, the
permission-scoped sidebar — against the real backend, with one working
screen (login) and a full but mostly-placeholder navigation shell. No
feature screens (employee directory, leave, dashboard data, etc.) are built
yet; each nav item routes somewhere real, but most render "Coming soon"
until their turn.

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
  implementation of the same visual language, not a port of that file.

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
backend: login success/failure, demo account fill, permission-scoped nav
differing by role, session persistence across a page reload (JWT
rehydration), protected-route redirect when unauthenticated, and sign-out.
No automated browser test suite is checked in yet — the backend's Node
test runner pattern (`../backend/test/`) is the natural fit to extend to
this app once there are enough real screens to make it worthwhile.

## Known gaps

- Only login + the shell are built; every other nav item is a placeholder.
- Fonts load from Google Fonts (`Archivo`); if that's unreachable (offline,
  restricted network) the app falls back to `system-ui` — visually fine,
  just not pixel-identical to the prototype's typeface.
- No production build/deploy config yet (`npm run build` works via Vite's
  defaults, but hosting, env-specific API URLs, etc. aren't set up).
- Logout is client-side token discard, matching the backend's stateless JWT
  design (see `../backend/README.md`'s own known gaps).
