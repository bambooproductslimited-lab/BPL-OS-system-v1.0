-- Marketing request routines: a request that comes round on its own —
-- every N weeks on chosen weekdays, or every N months on a day of the
-- month — with the same brief, lead, team and campaign each time. A job
-- (jobs/mkRoutines.js) makes each one on its day; due_after_days later it
-- is needed by.
CREATE TABLE marketing_request_routines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title           text NOT NULL,
  kind            text NOT NULL DEFAULT 'other' CHECK (kind IN ('social_post', 'flyer', 'brochure', 'banner', 'signage', 'video', 'photos', 'website', 'presentation', 'event', 'other')),
  brief           text NOT NULL DEFAULT '',
  audience        text NOT NULL DEFAULT '',
  priority        text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'urgent')),
  every           text NOT NULL CHECK (every IN ('week', 'month')),
  every_n         smallint NOT NULL DEFAULT 1 CHECK (every_n BETWEEN 1 AND 12),
  weekdays        smallint[] NOT NULL DEFAULT '{}',          -- 0 Sunday … 6 Saturday, for 'week'
  month_day       smallint NULL CHECK (month_day BETWEEN 1 AND 31), -- for 'month'; past the month's end = its last day
  due_after_days  smallint NOT NULL DEFAULT 0 CHECK (due_after_days BETWEEN 0 AND 60),
  starts_on       date NOT NULL,
  ends_on         date NULL,
  next_on         date NULL,                                 -- the next day one is made; NULL once it has ended
  paused          boolean NOT NULL DEFAULT false,
  requested_by    uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  assigned_to     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  campaign_id     uuid NULL REFERENCES marketing_campaigns(id) ON DELETE SET NULL,
  team            uuid[] NOT NULL DEFAULT '{}',
  made_count      integer NOT NULL DEFAULT 0,
  last_made_on    date NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (every <> 'week' OR cardinality(weekdays) > 0),
  CHECK (every <> 'month' OR month_day IS NOT NULL),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX idx_marketing_request_routines_next ON marketing_request_routines(next_on) WHERE NOT paused;

-- Which routine made a request, and for which day: one request per day.
ALTER TABLE marketing_requests ADD COLUMN routine_id uuid NULL REFERENCES marketing_request_routines(id) ON DELETE SET NULL;
ALTER TABLE marketing_requests ADD COLUMN routine_on date NULL;
CREATE UNIQUE INDEX ux_marketing_requests_routine_on ON marketing_requests(routine_id, routine_on);
