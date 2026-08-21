-- An engagement inbox for the social tracker: incoming comments (tied to a
-- post) and direct messages per channel, with a place to record the reply.
-- Same caveat as the rest of the tracker — none of the channels are
-- API-connected yet, so incoming items are logged here manually (or will
-- be synced automatically once a channel really is connected) and a
-- "reply" recorded here is the record of what staff sent back on the
-- actual platform, not something this app pushes there itself yet.
CREATE TABLE marketing_inbox_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id     uuid NOT NULL REFERENCES marketing_channels(id) ON DELETE CASCADE,
  post_id        uuid NULL REFERENCES marketing_posts(id) ON DELETE SET NULL,
  kind           text NOT NULL CHECK (kind IN ('comment', 'message')),
  author_name    text NOT NULL DEFAULT '',
  author_handle  text NOT NULL DEFAULT '',
  body           text NOT NULL DEFAULT '',
  received_at    timestamptz NOT NULL DEFAULT now(),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'replied', 'archived')),
  reply_body     text NOT NULL DEFAULT '',
  replied_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  replied_at     timestamptz NULL,
  created_by     uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_marketing_inbox_channel ON marketing_inbox_items(channel_id);
CREATE INDEX idx_marketing_inbox_post ON marketing_inbox_items(post_id);
CREATE INDEX idx_marketing_inbox_status ON marketing_inbox_items(status);
