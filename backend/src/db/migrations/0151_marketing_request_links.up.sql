-- Links on a request to marketing (mkRequests.service.js addLink): a
-- reference to look at (a Google Drive folder, a Canva design, a post to
-- copy), or the finished work where it lives (the published post, the
-- shared folder) — delivered, from marketing, like a delivered file.
-- Only http and https addresses are kept.
CREATE TABLE marketing_request_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid NOT NULL REFERENCES marketing_requests(id) ON DELETE CASCADE,
  url         text NOT NULL CHECK (url ~* '^https?://'),
  label       text NOT NULL DEFAULT '',
  delivered   boolean NOT NULL DEFAULT false,
  added_by    uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  -- the clock, not the transaction's start: links given with a new request
  -- keep the order they were given in
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX marketing_request_links_request ON marketing_request_links (request_id, created_at);
