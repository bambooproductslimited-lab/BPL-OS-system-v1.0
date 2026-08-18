# Deploying Bamboo OS

This app is two parts with two different hosting needs:

- **Backend** (`backend/`) — Node/Express + PostgreSQL. Needs a host that
  runs a persistent process and a real Postgres database. Your Hostinger
  **Business Web Hosting** plan can't do this — it's shared hosting built
  for PHP/static sites, with no PostgreSQL and no way to bind a long-running
  Node server to a port. This guide uses **Render** instead (free/cheap,
  supports both).
- **Frontend** (`frontend/`) — a React app that builds down to static
  HTML/CSS/JS. This runs fine on Hostinger — it's just files.

So: backend + database on Render, frontend on your existing Hostinger
hosting. They talk to each other over plain HTTPS; there's no requirement
that they live on the same host.

## Before you start

- A GitHub account with this repo pushed to it (it already is, on this
  branch).
- A [Render](https://render.com) account (free to create; the blueprint
  below uses paid plans for the reasons explained inline in `render.yaml`).
- Your Hostinger hPanel login, with FTP or File Manager access to your
  hosting's `public_html`.
- Decide on the **one real person** who'll be your first administrator —
  their name, a real email, and a password (min. 8 characters) you'll set
  once during deploy.

## Step 1 — Deploy the backend + database on Render

1. In the Render dashboard: **New > Blueprint**, connect your GitHub
   account, and pick this repository and branch. Render reads
   [`render.yaml`](./render.yaml) at the repo root and shows you two
   resources it's about to create: a Postgres database (`bamboo-os-db`)
   and a web service (`bamboo-os-backend`).
2. Before confirming, Render will prompt you to fill in the env vars marked
   `sync: false` in `render.yaml`:
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_FIRST_NAME`, `ADMIN_LAST_NAME`
     — your first real admin account. The build runs `npm run bootstrap`
     (see `backend/src/db/bootstrap.js`), which creates exactly this one
     account plus the role/permission catalogue every deployment needs —
     it never inserts fake demo data and never deletes anything, so it's
     safe to leave these set (or blank the password back out afterward).
   - `ANTHROPIC_API_KEY` — optional. Leave blank and the AI Assistant
     screen still works, it just always replies that it isn't configured.
     Get a key at [console.anthropic.com](https://console.anthropic.com/)
     any time later and add it here to turn on real answers — no redeploy
     of the frontend needed, just set the var and it takes effect on the
     backend's next restart.
3. Click **Apply**. Render provisions the database, then builds and starts
   the backend (`npm install && npm run migrate && npm run bootstrap`,
   then `npm start`). First deploy takes a few minutes.
4. Once it's live, Render shows you the backend's public URL — something
   like `https://bamboo-os-backend.onrender.com`. Copy it; you need it in
   the next step, and it must be reachable before the frontend below can
   log in successfully.

**Never run `npm run seed` against this database.** It TRUNCATEs every
table and fills it with fake demo people, customers, and invoices — exactly
what you want for local development, and exactly what would destroy real
company data here. The Render build only ever runs `migrate` (safe,
additive) and `bootstrap` (safe, additive, idempotent). Once real people
and data exist, add more users the normal way — through the app itself
(Employee directory → add employee → User accounts → assign a role) — not
by re-running either script.

## Step 2 — Build the frontend pointed at your backend

Locally (or in this session), point the frontend's build at the Render
backend URL from step 1, then build:

```bash
cd frontend
echo "VITE_API_URL=https://<your-backend>.onrender.com/api" > .env.production
npm install
npm run build
```

This produces `frontend/dist/` — a folder of plain static files (`index.html`,
an `assets/` folder with hashed JS/CSS). That's the entire deliverable for
this step; nothing else in `frontend/` needs to go to Hostinger.

## Step 3 — Upload the build to Hostinger

In hPanel, open **File Manager** (or connect via FTP/SFTP using the
credentials under **Files → FTP Accounts**) and upload everything inside
`frontend/dist/` into `public_html/` (or a subfolder, e.g.
`public_html/app/`, if this should live at a path rather than your domain
root). Keep the folder structure intact — `assets/` needs to stay a
subfolder alongside `index.html`.

Since this is a single-page app using client-side routing, direct links to
a route like `yourdomain.com/employees` need to be rewritten to
`index.html` by the web server, or a hard refresh on any page but the
homepage will 404. Add a `.htaccess` file in the same folder as
`index.html` (Hostinger's web server is Apache/LiteSpeed, which reads this):

```apache
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /
  RewriteRule ^index\.html$ - [L]
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteRule . /index.html [L]
</IfModule>
```

## Step 4 — Point the backend's CORS at your real domain

Back in the Render dashboard, open the `bamboo-os-backend` service →
**Environment**, and change `CORS_ORIGIN` from the `render.yaml` default
(`http://localhost:5173`) to your actual Hostinger domain, e.g.
`https://yourdomain.com` (no trailing slash; comma-separate if you're
serving from more than one origin). Save — Render redeploys automatically.
Until this matches, the browser will block every API call from the
frontend with a CORS error even though both sides are individually up.

## Step 5 — Verify

Visit your Hostinger domain, sign in with the admin email/password from
step 1, and confirm the dashboard loads. From there, use the app itself
(Governance → User accounts, Employee directory) to bring on real people —
see `backend/README.md` and `frontend/README.md` for what every screen
does.

## Costs and alternatives

Render's paid Postgres + web service starter plans run roughly $6–7/mo
each at time of writing (check Render's current pricing) — real cost for
real production use, not the free-tier trap `render.yaml`'s comments
explain. If you'd rather not commit to that, or want a different platform:
[Railway](https://railway.app) is a close equivalent (usage-based, no
free-tier expiry surprise) — connect the repo, add a PostgreSQL plugin from
their dashboard, set the same environment variables listed above manually
(Railway doesn't read `render.yaml`), and use the same `buildCommand`/
`startCommand` from this file. Steps 2–5 above are unchanged either way.

## Everyday operations

- `npm run migrate` is safe to run any time (tracks what's applied,
  idempotent) — Render already runs it on every deploy automatically.
- `npm run bootstrap` is also safe to re-run; every step after the first
  successful run is a no-op.
- Backups: enable Render's automated Postgres backups (or your own
  `pg_dump` schedule) before this holds real company data — not set up by
  this guide.
