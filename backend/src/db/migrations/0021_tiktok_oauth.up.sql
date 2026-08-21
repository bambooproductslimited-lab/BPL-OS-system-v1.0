-- Real TikTok OAuth support for the social tracker: a short-lived state
-- table for the OAuth handshake (CSRF protection), and a token table
-- holding the access/refresh token pair once a channel is connected.
-- marketing_posts gets an external_id + source so a repeat sync updates
-- the same row (matched by channel + external_id) instead of duplicating
-- it, while posts logged manually (source='manual', external_id NULL)
-- are untouched by syncing.

CREATE TABLE marketing_oauth_states (
  state       text PRIMARY KEY,
  channel_key text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE marketing_oauth_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_key   text NOT NULL UNIQUE REFERENCES marketing_channels(key) ON DELETE CASCADE,
  access_token  text NOT NULL,
  refresh_token text NOT NULL DEFAULT '',
  open_id       text NOT NULL DEFAULT '',
  scope         text NOT NULL DEFAULT '',
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE marketing_posts ADD COLUMN external_id text NULL;
ALTER TABLE marketing_posts ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'synced'));
CREATE UNIQUE INDEX idx_marketing_posts_channel_external ON marketing_posts(channel_id, external_id) WHERE external_id IS NOT NULL;
