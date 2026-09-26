-- The Square import on the Integrations page runs in the background
-- (services/squareImport.service.js), like the restaurant imports
-- (migration 0096). It used to run inside one web request that fetched the
-- whole Square history into memory — long enough for the connection to be
-- cut ("Failed to fetch") before it finished. Now pressing the button
-- starts a job and the page polls this row for progress; heartbeat_at shows
-- the job is still alive, and an old heartbeat on a 'running' row means a
-- server restart stopped it (running it again updates the same rows, since
-- everything is saved by its Square id).
CREATE TABLE square_import_jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status              text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  phase               text NOT NULL DEFAULT 'starting',
  customers_imported  integer NOT NULL DEFAULT 0,
  customers_skipped   integer NOT NULL DEFAULT 0,
  catalog_imported    integer NOT NULL DEFAULT 0,
  catalog_skipped     integer NOT NULL DEFAULT 0,
  invoices_imported   integer NOT NULL DEFAULT 0,
  invoices_skipped    integer NOT NULL DEFAULT 0,
  payments_imported   integer NOT NULL DEFAULT 0,
  payments_skipped    integer NOT NULL DEFAULT 0,
  pages_done          integer NOT NULL DEFAULT 0,
  error_count         integer NOT NULL DEFAULT 0,
  errors              jsonb NOT NULL DEFAULT '[]',
  message             text NULL,
  started_by          uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  started_at          timestamptz NOT NULL DEFAULT now(),
  heartbeat_at        timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz NULL
);
CREATE INDEX idx_square_import_jobs_started ON square_import_jobs (started_at DESC);
