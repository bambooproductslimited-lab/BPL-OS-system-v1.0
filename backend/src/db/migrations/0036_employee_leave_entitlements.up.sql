-- A leave type's days_per_year is now just the company-wide fallback — HR
-- can give an individual employee their own personal annual entitlement
-- per leave type instead (seniority, a negotiated offer, a part-year
-- proration that should persist rather than being re-set every year). No
-- row here means "use the leave type's default" — see leave.service.js's
-- resolveDaysPerYear, used everywhere a balance actually gets granted
-- (new hire, year rollover, the per-request self-heal grant).
CREATE TABLE employee_leave_entitlements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type_id uuid NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
  days_per_year integer NOT NULL CHECK (days_per_year >= 0),
  UNIQUE (employee_id, leave_type_id)
);
