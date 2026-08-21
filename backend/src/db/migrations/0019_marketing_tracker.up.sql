-- Social & campaign tracker (Metricool-style): channels (Facebook,
-- Instagram, TikTok, WhatsApp Business, Website, ThomasNet), campaigns to
-- group posts under, a content calendar of posts with their engagement
-- numbers, and periodic follower/traffic snapshots per channel for growth
-- trend charts. `integration_key` links a channel to its row in
-- settings.integrations (see referenceData.js's defaultIntegrations()) so
-- the UI can show "connected"/"not connected" — actually pulling live
-- numbers from each platform's API is a separate integration build once
-- real developer credentials exist for that platform; everything here is
-- manually logged in the meantime, same as this app's other integrations
-- (Square, Slack, QuickBooks) work today.

CREATE TABLE marketing_channels (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key            text NOT NULL UNIQUE,
  name           text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('social', 'web', 'directory')),
  handle         text NOT NULL DEFAULT '',
  integration_key text NULL,
  notes          text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE marketing_campaigns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  start_date   date NULL,
  end_date     date NULL,
  status       text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'completed')),
  created_by   uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE marketing_posts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id    uuid NOT NULL REFERENCES marketing_channels(id) ON DELETE RESTRICT,
  campaign_id   uuid NULL REFERENCES marketing_campaigns(id) ON DELETE SET NULL,
  title         text NOT NULL DEFAULT '',
  caption       text NOT NULL DEFAULT '',
  media_url     text NOT NULL DEFAULT '',
  scheduled_at  timestamptz NULL,
  published_at  timestamptz NULL,
  status        text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'scheduled', 'published', 'failed')),
  likes         integer NOT NULL DEFAULT 0,
  comments      integer NOT NULL DEFAULT 0,
  shares        integer NOT NULL DEFAULT 0,
  reach         integer NOT NULL DEFAULT 0,
  impressions   integer NOT NULL DEFAULT 0,
  clicks        integer NOT NULL DEFAULT 0,
  leads         integer NOT NULL DEFAULT 0,
  created_by    uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_marketing_posts_channel ON marketing_posts(channel_id);
CREATE INDEX idx_marketing_posts_campaign ON marketing_posts(campaign_id);

CREATE TABLE marketing_channel_stats (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id   uuid NOT NULL REFERENCES marketing_channels(id) ON DELETE CASCADE,
  captured_on  date NOT NULL,
  followers    integer NOT NULL DEFAULT 0,
  created_by   uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, captured_on)
);
CREATE INDEX idx_marketing_channel_stats_channel ON marketing_channel_stats(channel_id);
