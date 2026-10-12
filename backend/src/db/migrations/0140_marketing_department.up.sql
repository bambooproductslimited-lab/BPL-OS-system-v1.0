-- The marketing department (services/mk*.service.js, pages/marketing/*):
-- campaigns grow into plans with an objective, audience, channels, budget,
-- owner, targets, a tracking code and a review afterwards; leads can be
-- credited to the campaign that brought them; the yearly budget and every
-- spend; requests from the rest of the company (a flyer, a post, a banner);
-- events with their checklist; promotions and their uses; the brand kit;
-- competitors and what was seen of them; saved audiences.

ALTER TABLE marketing_campaigns DROP CONSTRAINT marketing_campaigns_status_check;
ALTER TABLE marketing_campaigns ADD CONSTRAINT marketing_campaigns_status_check
  CHECK (status IN ('draft', 'planned', 'active', 'paused', 'completed', 'cancelled'));
ALTER TABLE marketing_campaigns
  ADD COLUMN objective      text NOT NULL DEFAULT 'awareness' CHECK (objective IN ('awareness', 'leads', 'sales', 'launch', 'loyalty', 'event')),
  ADD COLUMN audience       text NOT NULL DEFAULT '',
  ADD COLUMN key_message    text NOT NULL DEFAULT '',
  ADD COLUMN channels       text[] NOT NULL DEFAULT '{}',
  ADD COLUMN budget         numeric(14,2) NOT NULL DEFAULT 0 CHECK (budget >= 0),
  ADD COLUMN owner_id       uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  ADD COLUMN code           text NULL,
  ADD COLUMN target_leads   integer NULL CHECK (target_leads IS NULL OR target_leads >= 0),
  ADD COLUMN target_revenue numeric(14,2) NULL CHECK (target_revenue IS NULL OR target_revenue >= 0),
  ADD COLUMN target_reach   integer NULL CHECK (target_reach IS NULL OR target_reach >= 0),
  ADD COLUMN review         text NOT NULL DEFAULT '',
  ADD COLUMN updated_at     timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX idx_marketing_campaigns_code ON marketing_campaigns (company_id, lower(code)) WHERE code IS NOT NULL AND code <> '';

-- The campaign a lead came from. Left empty, a lead whose source is the
-- campaign's tracking code, received while the campaign ran, still counts.
ALTER TABLE crm_leads ADD COLUMN campaign_id uuid NULL REFERENCES marketing_campaigns(id) ON DELETE SET NULL;
CREATE INDEX idx_crm_leads_campaign ON crm_leads(campaign_id) WHERE campaign_id IS NOT NULL;

CREATE TABLE marketing_budgets (
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  year        integer NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  category    text NOT NULL,
  amount      numeric(14,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  updated_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, year, category)
);

CREATE TABLE marketing_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name            text NOT NULL,
  kind            text NOT NULL DEFAULT 'other' CHECK (kind IN ('trade_fair', 'exhibition', 'launch', 'showroom', 'tasting', 'sponsorship', 'community', 'webinar', 'other')),
  starts_on       date NOT NULL,
  ends_on         date NULL,
  venue           text NOT NULL DEFAULT '',
  budget          numeric(14,2) NOT NULL DEFAULT 0 CHECK (budget >= 0),
  campaign_id     uuid NULL REFERENCES marketing_campaigns(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'confirmed', 'done', 'cancelled')),
  owner_id        uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  target_leads    integer NULL CHECK (target_leads IS NULL OR target_leads >= 0),
  leads_captured  integer NOT NULL DEFAULT 0 CHECK (leads_captured >= 0),
  visitors        integer NOT NULL DEFAULT 0 CHECK (visitors >= 0),
  sales           numeric(14,2) NOT NULL DEFAULT 0 CHECK (sales >= 0),
  notes           text NOT NULL DEFAULT '',
  outcome         text NOT NULL DEFAULT '',
  created_by      uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_marketing_events_company ON marketing_events(company_id, starts_on);
CREATE TABLE marketing_event_tasks (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id  uuid NOT NULL REFERENCES marketing_events(id) ON DELETE CASCADE,
  title     text NOT NULL,
  due_on    date NULL,
  done      boolean NOT NULL DEFAULT false,
  done_by   uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  done_at   timestamptz NULL,
  sort      integer NOT NULL DEFAULT 0
);
CREATE INDEX idx_marketing_event_tasks_event ON marketing_event_tasks(event_id);

CREATE TABLE marketing_spend (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  campaign_id   uuid NULL REFERENCES marketing_campaigns(id) ON DELETE SET NULL,
  event_id      uuid NULL REFERENCES marketing_events(id) ON DELETE SET NULL,
  category      text NOT NULL,
  vendor        text NOT NULL DEFAULT '',
  description   text NOT NULL,
  amount        numeric(14,2) NOT NULL CHECK (amount > 0),
  spent_on      date NOT NULL,
  status        text NOT NULL DEFAULT 'paid' CHECK (status IN ('committed', 'paid')),
  receipt_key   text NULL,
  receipt_name  text NULL,
  created_by    uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_marketing_spend_company ON marketing_spend(company_id, spent_on);
CREATE INDEX idx_marketing_spend_campaign ON marketing_spend(campaign_id) WHERE campaign_id IS NOT NULL;

CREATE SEQUENCE marketing_request_number_seq;
CREATE TABLE marketing_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        integer NOT NULL DEFAULT nextval('marketing_request_number_seq') UNIQUE,
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title         text NOT NULL,
  kind          text NOT NULL DEFAULT 'other' CHECK (kind IN ('social_post', 'flyer', 'brochure', 'banner', 'signage', 'video', 'photos', 'website', 'presentation', 'event', 'other')),
  brief         text NOT NULL DEFAULT '',
  audience      text NOT NULL DEFAULT '',
  due_on        date NULL,
  priority      text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'urgent')),
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'review', 'done', 'declined')),
  requested_by  uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  assigned_to   uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  campaign_id   uuid NULL REFERENCES marketing_campaigns(id) ON DELETE SET NULL,
  note          text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  done_at       timestamptz NULL
);
ALTER SEQUENCE marketing_request_number_seq OWNED BY marketing_requests.number;
CREATE INDEX idx_marketing_requests_status ON marketing_requests(company_id, status);
CREATE TABLE marketing_request_comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid NOT NULL REFERENCES marketing_requests(id) ON DELETE CASCADE,
  author_id   uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE marketing_request_files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id   uuid NOT NULL REFERENCES marketing_requests(id) ON DELETE CASCADE,
  file_key     text NOT NULL,
  file_name    text NOT NULL,
  mime         text NOT NULL DEFAULT '',
  size_bytes   integer NOT NULL DEFAULT 0,
  delivered    boolean NOT NULL DEFAULT false,
  uploaded_by  uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE marketing_promotions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name         text NOT NULL,
  code         text NULL,
  kind         text NOT NULL DEFAULT 'percent' CHECK (kind IN ('percent', 'amount', 'bundle', 'free_item', 'other')),
  value        numeric(14,2) NULL CHECK (value IS NULL OR value >= 0),
  details      text NOT NULL DEFAULT '',
  starts_on    date NOT NULL,
  ends_on      date NULL,
  channels     text[] NOT NULL DEFAULT '{}',
  campaign_id  uuid NULL REFERENCES marketing_campaigns(id) ON DELETE SET NULL,
  active       boolean NOT NULL DEFAULT true,
  target_uses  integer NULL CHECK (target_uses IS NULL OR target_uses >= 0),
  created_by   uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_marketing_promotions_company ON marketing_promotions(company_id, starts_on);
CREATE TABLE marketing_promotion_uses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id  uuid NOT NULL REFERENCES marketing_promotions(id) ON DELETE CASCADE,
  used_on       date NOT NULL,
  uses          integer NOT NULL CHECK (uses > 0),
  revenue       numeric(14,2) NOT NULL DEFAULT 0 CHECK (revenue >= 0),
  discount      numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  note          text NOT NULL DEFAULT '',
  created_by    uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_marketing_promotion_uses_promo ON marketing_promotion_uses(promotion_id);

CREATE TABLE marketing_brand (
  company_id  uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  tagline     text NOT NULL DEFAULT '',
  voice       text NOT NULL DEFAULT '',
  colours     jsonb NOT NULL DEFAULT '[]',
  fonts       text NOT NULL DEFAULT '',
  dos         text NOT NULL DEFAULT '',
  donts       text NOT NULL DEFAULT '',
  updated_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE marketing_assets (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind           text NOT NULL DEFAULT 'other' CHECK (kind IN ('logo', 'guideline', 'template', 'photo', 'video', 'font', 'print', 'other')),
  name           text NOT NULL,
  description    text NOT NULL DEFAULT '',
  file_key       text NOT NULL,
  file_name      text NOT NULL,
  mime           text NOT NULL DEFAULT '',
  size_bytes     integer NOT NULL DEFAULT 0,
  tags           text[] NOT NULL DEFAULT '{}',
  licence_until  date NULL,
  downloads      integer NOT NULL DEFAULT 0,
  uploaded_by    uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_marketing_assets_company ON marketing_assets(company_id, kind);

CREATE TABLE marketing_competitors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name            text NOT NULL,
  website         text NOT NULL DEFAULT '',
  location        text NOT NULL DEFAULT '',
  price_position  text NOT NULL DEFAULT 'unknown' CHECK (price_position IN ('lower', 'similar', 'higher', 'unknown')),
  strengths       text NOT NULL DEFAULT '',
  weaknesses      text NOT NULL DEFAULT '',
  notes           text NOT NULL DEFAULT '',
  created_by      uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE marketing_intel (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  competitor_id  uuid NULL REFERENCES marketing_competitors(id) ON DELETE CASCADE,
  kind           text NOT NULL DEFAULT 'other' CHECK (kind IN ('price', 'promotion', 'product', 'news', 'review', 'other')),
  body           text NOT NULL,
  product        text NOT NULL DEFAULT '',
  price          numeric(14,2) NULL CHECK (price IS NULL OR price >= 0),
  our_price      numeric(14,2) NULL CHECK (our_price IS NULL OR our_price >= 0),
  seen_on        date NOT NULL DEFAULT current_date,
  source         text NOT NULL DEFAULT '',
  created_by     uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_marketing_intel_company ON marketing_intel(company_id, seen_on DESC);

CREATE TABLE marketing_audiences (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  rules        jsonb NOT NULL DEFAULT '{}',
  created_by   uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
