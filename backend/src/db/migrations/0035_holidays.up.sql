-- Public holidays, one list per company (a restaurant/bar can observe a
-- different set of closed days than the factory). Used two ways: reduces
-- how many days a leave type actually grants for that company/year (see
-- leave.service.js's countHolidays), and — like Sundays already are — a
-- holiday date inside an approved leave request isn't charged against the
-- employee's balance (businessDays() in utils/validate.js).
CREATE TABLE holidays (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  date       date NOT NULL,
  name       text NOT NULL DEFAULT '',
  UNIQUE (company_id, date)
);

CREATE INDEX idx_holidays_company_id ON holidays(company_id);
