-- The restaurant report (restaurantReport.service.js): sales by kitchen
-- group, shifts and hours, the month's top items and the kitchen bonus.
--
-- gross: what a line sold for before discounts (Square's gross sales). The
-- item ranking and the kitchen bonus work on gross sales; everything else
-- on what was actually taken (line_total). Lines saved before this column
-- existed fall back to price x qty.
ALTER TABLE restaurant_order_items ADD COLUMN gross numeric NULL;

-- One row per restaurant: which kitchen group each menu category belongs
-- to ({ "<category>": "<group>" }; a category left out is guessed from its
-- name), the shifts ([{ name, start }] with start an hour 0-23) and the
-- bonus rule ({ groups: [...], top, rate } with rate a percentage).
CREATE TABLE restaurant_report_settings (
  company_id  uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  groups      jsonb NOT NULL DEFAULT '{}'::jsonb,
  shifts      jsonb NULL,
  bonus       jsonb NULL,
  updated_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
