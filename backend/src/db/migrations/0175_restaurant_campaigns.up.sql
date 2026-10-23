-- Texts and emails to a restaurant's guests (restaurantCampaigns.service.js):
-- a campaign written in the till's back office and sent now or at a set
-- time to a chosen audience (everyone, regulars, those who have not come
-- back, new guests, loyalty members, birthdays this month), and the
-- automatic ones the restaurant turns on (we miss you, happy birthday,
-- thank you for coming). Each message sent, failed or skipped is kept.
--
-- A guest's email and birthday, and whether they want to hear from the
-- restaurant: unknown until they say; 'no' (said at the till or with the
-- unsubscribe link every message carries) is never sent to again.
ALTER TABLE restaurant_guests
  ADD COLUMN email text NOT NULL DEFAULT '',
  ADD COLUMN birthday date NULL,
  ADD COLUMN marketing text NOT NULL DEFAULT 'unknown' CHECK (marketing IN ('unknown', 'yes', 'no')),
  ADD COLUMN marketing_at timestamptz NULL,
  ADD COLUMN unsubscribe_token text NULL;
CREATE UNIQUE INDEX uq_restaurant_guests_unsubscribe ON restaurant_guests (unsubscribe_token) WHERE unsubscribe_token IS NOT NULL;

CREATE TABLE restaurant_campaigns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual', 'lapsed', 'birthday', 'welcome')),
  name        text NOT NULL,
  channel     text NOT NULL CHECK (channel IN ('sms', 'email', 'both')),
  audience    jsonb NOT NULL DEFAULT '{}',
  subject     text NOT NULL DEFAULT '',
  message     text NOT NULL,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'cancelled', 'auto')),
  send_at     timestamptz NULL,
  started_at  timestamptz NULL,
  finished_at timestamptz NULL,
  counts      jsonb NOT NULL DEFAULT '{}',
  created_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_campaigns_company ON restaurant_campaigns (company_id, created_at DESC);
CREATE INDEX idx_restaurant_campaigns_due ON restaurant_campaigns (send_at) WHERE status = 'scheduled';
CREATE UNIQUE INDEX uq_restaurant_campaigns_auto ON restaurant_campaigns (company_id, kind) WHERE kind <> 'manual';

CREATE TABLE restaurant_campaign_sends (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES restaurant_campaigns(id) ON DELETE CASCADE,
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  guest_id    uuid NULL REFERENCES restaurant_guests(id) ON DELETE SET NULL,
  channel     text NOT NULL CHECK (channel IN ('sms', 'email')),
  to_addr     text NOT NULL DEFAULT '',
  status      text NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  error       text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_campaign_sends_campaign ON restaurant_campaign_sends (campaign_id);
CREATE INDEX idx_restaurant_campaign_sends_guest ON restaurant_campaign_sends (company_id, guest_id, created_at DESC);
