-- Restaurant module: cash-drawer shift tracking, matching the "Drawer
-- Report" format the business already prints from its current POS
-- (Starting Cash, Cash Sales, Paid In/Out log, Expected vs. Actual in
-- Drawer, Difference). One session per cashier per shift (not per till
-- device) — two people sharing one counter iPad across a day get their
-- own separate reports, each tied to their own name, the same way the
-- reference receipt is headed "Drawer Report: chantel".
CREATE TABLE restaurant_drawer_sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  cashier_id           uuid NOT NULL REFERENCES employees(id),
  opened_at            timestamptz NOT NULL DEFAULT now(),
  closed_at            timestamptz NULL,
  starting_cash        numeric NOT NULL DEFAULT 0,
  closing_actual_cash  numeric NULL,
  closing_note         text NOT NULL DEFAULT '',
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed'))
);
CREATE INDEX idx_restaurant_drawer_sessions_company ON restaurant_drawer_sessions(company_id, opened_at);

-- Enforced here rather than only in application code — a partial unique
-- index (not a CHECK, which can't see other rows) is the standard
-- Postgres way to say "at most one open row per cashier", and holds even
-- if two requests race (e.g. the same PIN logged in on two devices at
-- once).
CREATE UNIQUE INDEX idx_restaurant_drawer_sessions_one_open_per_cashier
  ON restaurant_drawer_sessions(cashier_id) WHERE status = 'open';

-- Paid In/Out log — the receipt's "Delivery JV" style entries. amount is
-- always positive; direction says which way it moved, same convention as
-- attendance/payroll elsewhere in this codebase preferring an explicit
-- sign flag over a signed number that's easy to misread.
CREATE TABLE restaurant_drawer_movements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES restaurant_drawer_sessions(id) ON DELETE CASCADE,
  direction   text NOT NULL CHECK (direction IN ('in', 'out')),
  amount      numeric NOT NULL CHECK (amount > 0),
  note        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_drawer_movements_session ON restaurant_drawer_movements(session_id);
