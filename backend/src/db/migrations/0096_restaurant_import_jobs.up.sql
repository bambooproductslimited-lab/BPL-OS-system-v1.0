-- Restaurant Square imports run in the background (services/
-- restaurantSquareImport.service.js). The import used to run inside one
-- web request that fetched a restaurant's whole Square history into memory
-- and saved it order by order — minutes for a busy restaurant, long enough
-- for the connection to be cut ("Failed to fetch") or the server to run
-- out of memory. Now pressing Import starts a job; the page polls this row
-- for progress. heartbeat_at shows the job is still alive: a job left
-- 'running' with an old heartbeat was stopped by a server restart, and a
-- new import simply carries on from the last order already saved.
CREATE TABLE restaurant_import_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  phase            text NOT NULL DEFAULT 'starting',
  full_import      boolean NOT NULL DEFAULT false,
  orders_since     timestamptz NULL,
  menu_imported    integer NOT NULL DEFAULT 0,
  menu_skipped     integer NOT NULL DEFAULT 0,
  orders_imported  integer NOT NULL DEFAULT 0,
  orders_skipped   integer NOT NULL DEFAULT 0,
  pages_done       integer NOT NULL DEFAULT 0,
  last_order_at    timestamptz NULL,
  error_count      integer NOT NULL DEFAULT 0,
  errors           jsonb NOT NULL DEFAULT '[]',
  message          text NULL,
  started_by       uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  heartbeat_at     timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz NULL
);
CREATE INDEX idx_restaurant_import_jobs_company ON restaurant_import_jobs (company_id, started_at DESC);
