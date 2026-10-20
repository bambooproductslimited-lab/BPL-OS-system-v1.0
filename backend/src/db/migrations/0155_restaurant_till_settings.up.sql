-- The till's settings, per restaurant (restaurantTillAccess.service.js):
-- what each role may do on the till and the kitchen screen, which ways of
-- paying the till offers, the receipt's own lines, signing out after a
-- while unused, whether a table needs its waiter, and when the kitchen
-- screen turns amber and red. Missing keys fall back to the defaults.
CREATE TABLE restaurant_till_settings (
  company_id uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  settings   jsonb NOT NULL DEFAULT '{}',
  updated_by uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Each person's role on a restaurant's till; anyone not listed has the
-- restaurant's default role (settings.defaultRole).
CREATE TABLE restaurant_till_staff (
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('manager', 'cashier', 'waiter', 'kitchen', 'none')),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, employee_id)
);
