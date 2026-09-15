-- Poki — the group's property-rental business (apartments, offices, shops,
-- warehouses at Poki House, Community 9, Tema). Fourth company alongside
-- Bamboo Products Limited and the two restaurants (migration 0032), and the
-- first one whose revenue is recurring rather than transactional.
--
-- Design decision worth stating up front: Poki does NOT get its own parallel
-- invoice/payment/receipt stack. Rent and utility bills are rows in the
-- existing `invoices` table, so they inherit everything already built and in
-- production there — payments, receipts, share links, PDF preview, payment
-- schedules, arrears maths. What separates them is `company_id` (added
-- below) plus the rent-specific columns at the bottom of this file. The
-- alternative (poki_invoices + poki_payments + poki_receipts) would have
-- duplicated several hundred lines of live, tested money-handling code for
-- no gain.
--
-- company_id is deliberately NULLABLE with no backfill: every pre-existing
-- commercial row stays NULL and keeps behaving exactly as it does today.
-- NULL reads as "Bamboo Products Limited" (the only company that had
-- commercial documents before Poki existed), so nothing needs rewriting and
-- no live query changes meaning underneath the running app. Only the list
-- endpoints gain a filter.

-- ── the company ─────────────────────────────────────────────────────────
INSERT INTO companies (code, name)
VALUES ('PKI', 'Poki')
ON CONFLICT (code) DO NOTHING;

-- ── per-company billing identity ────────────────────────────────────────
-- Until now every printed document hardcoded Bamboo Products Limited's name
-- and address (see DocPreview.jsx). A Poki rent invoice has to go out under
-- Poki's own letterhead, so the identity moves onto the company row where
-- any of the four can carry its own. All nullable: a company with these
-- blank falls back to the hardcoded BPL defaults the preview already uses.
ALTER TABLE companies ADD COLUMN legal_name      text NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN address         text NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN ghana_post_gps  text NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN phone           text NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN email           text NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN tax_id          text NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN payment_details jsonb NOT NULL DEFAULT '{}';
ALTER TABLE companies ADD COLUMN invoice_footer  text NOT NULL DEFAULT '';

UPDATE companies SET
  legal_name     = 'Poki',
  address        = 'Poki House, 35 J.K. Siaw Street, Community 9, Tema, Greater Accra Region, Republic of Ghana',
  ghana_post_gps = 'GT-191-1859'
WHERE code = 'PKI';

-- ── company scoping on commercial documents ─────────────────────────────
ALTER TABLE customers  ADD COLUMN company_id uuid NULL REFERENCES companies(id) ON DELETE RESTRICT;
ALTER TABLE quotations ADD COLUMN company_id uuid NULL REFERENCES companies(id) ON DELETE RESTRICT;
ALTER TABLE estimates  ADD COLUMN company_id uuid NULL REFERENCES companies(id) ON DELETE RESTRICT;
ALTER TABLE invoices   ADD COLUMN company_id uuid NULL REFERENCES companies(id) ON DELETE RESTRICT;

CREATE INDEX idx_customers_company  ON customers(company_id);
CREATE INDEX idx_quotations_company ON quotations(company_id);
CREATE INDEX idx_estimates_company  ON estimates(company_id);
CREATE INDEX idx_invoices_company   ON invoices(company_id);

-- ── properties ──────────────────────────────────────────────────────────
-- Scoped by company_id rather than hardcoded to Poki, matching how the
-- restaurant tables (migration 0041) were done — a second rental company
-- later needs no schema change.
CREATE TABLE poki_properties (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code           text NOT NULL,
  name           text NOT NULL,
  property_type  text NOT NULL DEFAULT 'mixed' CHECK (property_type IN ('residential', 'commercial', 'mixed', 'land')),
  address        text NOT NULL DEFAULT '',
  city           text NOT NULL DEFAULT '',
  region         text NOT NULL DEFAULT '',
  ghana_post_gps text NOT NULL DEFAULT '',
  description    text NOT NULL DEFAULT '',
  acquired_on    date NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  notes          text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);
CREATE INDEX idx_poki_properties_company ON poki_properties(company_id);

-- ── units (the actual rentable spaces) ──────────────────────────────────
-- One row per lettable space: a flat, a single room, an office suite, a
-- shop, a warehouse bay. base_rent/rent_cycle are the ASKING terms; what a
-- sitting tenant actually pays lives on their lease, because a renewal can
-- change the rent without rewriting the unit.
--
-- utility_mode picks how this unit's electricity/water gets billed, chosen
-- per unit because a warehouse on its own ECG meter, a shop on a flat
-- monthly charge, and a room sharing the building's master bill all coexist
-- in the same property:
--   metered      — sub-meter readings, billed on consumption (poki_meters)
--   fixed        — flat amount per cycle (fixed_utility_amount)
--   apportioned  — a share of the property's master bill (poki_master_bills)
--   none         — tenant pays the utility company directly
CREATE TABLE poki_units (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id           uuid NOT NULL REFERENCES poki_properties(id) ON DELETE CASCADE,
  code                  text NOT NULL,
  name                  text NOT NULL DEFAULT '',
  unit_type             text NOT NULL DEFAULT 'room' CHECK (unit_type IN ('apartment', 'room', 'office', 'shop', 'warehouse', 'land', 'other')),
  floor                 text NOT NULL DEFAULT '',
  size_sqm              numeric(12,2) NOT NULL DEFAULT 0,
  bedrooms              integer NOT NULL DEFAULT 0,
  bathrooms             integer NOT NULL DEFAULT 0,
  base_rent             numeric(14,2) NOT NULL DEFAULT 0,
  currency              text NOT NULL DEFAULT 'GHS',
  rent_cycle            text NOT NULL DEFAULT 'monthly' CHECK (rent_cycle IN ('monthly', 'quarterly', 'semiannual', 'annual', 'one_off')),
  utility_mode          text NOT NULL DEFAULT 'none' CHECK (utility_mode IN ('none', 'metered', 'fixed', 'apportioned')),
  fixed_utility_amount  numeric(14,2) NOT NULL DEFAULT 0,
  apportion_share       numeric(7,3) NOT NULL DEFAULT 0,
  status                text NOT NULL DEFAULT 'vacant' CHECK (status IN ('vacant', 'occupied', 'reserved', 'maintenance', 'unavailable')),
  amenities             text NOT NULL DEFAULT '',
  notes                 text NOT NULL DEFAULT '',
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, code)
);
CREATE INDEX idx_poki_units_property ON poki_units(property_id);
CREATE INDEX idx_poki_units_status ON poki_units(status);

-- ── tenants ─────────────────────────────────────────────────────────────
-- A tenant is a PROFILE EXTENSION of a customer row, not a copy of one.
-- customer_id holds the billing identity (name, email, phone, address) so
-- every existing invoice/payment/receipt path works on a tenant untouched;
-- this table holds only what a landlord needs and a sales customer doesn't
-- (ID document, next of kin, employer). Nothing is duplicated between the
-- two, so there is no sync to drift. The linked customer carries
-- company_id = Poki, which is what keeps tenants out of BPL's client list.
CREATE TABLE poki_tenants (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id             uuid NOT NULL UNIQUE REFERENCES customers(id) ON DELETE RESTRICT,
  tenant_type             text NOT NULL DEFAULT 'individual' CHECK (tenant_type IN ('individual', 'company')),
  id_type                 text NOT NULL DEFAULT '' ,
  id_number               text NOT NULL DEFAULT '',
  occupation              text NOT NULL DEFAULT '',
  employer                text NOT NULL DEFAULT '',
  emergency_contact_name  text NOT NULL DEFAULT '',
  emergency_contact_phone text NOT NULL DEFAULT '',
  next_of_kin_name        text NOT NULL DEFAULT '',
  next_of_kin_phone       text NOT NULL DEFAULT '',
  onboarded_on            date NULL,
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('prospect', 'active', 'former', 'blacklisted')),
  notes                   text NOT NULL DEFAULT '',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- ── leases (tenant ↔ unit assignment) ───────────────────────────────────
-- The contract: who occupies which unit, for how long, at what rent, on
-- what cycle. rent_cycle is per lease (not forced company-wide) so a
-- monthly office and a warehouse on two years paid in advance coexist.
--
-- next_invoice_on drives rent-run generation: it's the period start the
-- next rent invoice should cover, advanced by one cycle each time one is
-- raised. Keeping it as stored state (rather than deriving it from the last
-- invoice each run) means a lease that starts mid-cycle, gets a manual
-- one-off invoice, or is paused, doesn't silently re-bill an old period.
CREATE TABLE poki_leases (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_no            text NOT NULL UNIQUE,
  unit_id             uuid NOT NULL REFERENCES poki_units(id) ON DELETE RESTRICT,
  tenant_id           uuid NOT NULL REFERENCES poki_tenants(id) ON DELETE RESTRICT,
  start_date          date NOT NULL,
  end_date            date NOT NULL,
  rent_amount         numeric(14,2) NOT NULL DEFAULT 0,
  currency            text NOT NULL DEFAULT 'GHS',
  rent_cycle          text NOT NULL DEFAULT 'monthly' CHECK (rent_cycle IN ('monthly', 'quarterly', 'semiannual', 'annual', 'one_off')),
  payment_day         integer NOT NULL DEFAULT 1 CHECK (payment_day BETWEEN 1 AND 28),
  next_invoice_on     date NULL,
  deposit_amount      numeric(14,2) NOT NULL DEFAULT 0,
  deposit_held        numeric(14,2) NOT NULL DEFAULT 0,
  deposit_refunded    numeric(14,2) NOT NULL DEFAULT 0,
  deposit_refunded_on date NULL,
  deposit_notes       text NOT NULL DEFAULT '',
  escalation_percent  numeric(6,3) NOT NULL DEFAULT 0,
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'expired', 'terminated', 'renewed')),
  signed_on           date NULL,
  terminated_on       date NULL,
  termination_reason  text NOT NULL DEFAULT '',
  agreement_body      text NOT NULL DEFAULT '',
  agreement_generated_at timestamptz NULL,
  renewed_from_id     uuid NULL REFERENCES poki_leases(id) ON DELETE SET NULL,
  notes               text NOT NULL DEFAULT '',
  created_by          uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX idx_poki_leases_unit ON poki_leases(unit_id);
CREATE INDEX idx_poki_leases_tenant ON poki_leases(tenant_id);
CREATE INDEX idx_poki_leases_status ON poki_leases(status);
CREATE INDEX idx_poki_leases_end_date ON poki_leases(end_date);

-- Only one lease can actively hold a unit at a time. A partial unique index
-- rather than a plain constraint so historical (expired/terminated) leases
-- on the same unit stay queryable — the occupancy history IS the point.
CREATE UNIQUE INDEX idx_poki_leases_one_active_per_unit
  ON poki_leases(unit_id) WHERE status = 'active';

-- ── utilities: sub-meters and their readings ────────────────────────────
CREATE TABLE poki_meters (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id      uuid NOT NULL REFERENCES poki_units(id) ON DELETE CASCADE,
  utility_type text NOT NULL DEFAULT 'electricity' CHECK (utility_type IN ('electricity', 'water', 'gas', 'other')),
  meter_number text NOT NULL DEFAULT '',
  measure_unit text NOT NULL DEFAULT 'kWh',
  rate         numeric(12,4) NOT NULL DEFAULT 0,
  active       boolean NOT NULL DEFAULT true,
  notes        text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_poki_meters_unit ON poki_meters(unit_id);

-- rate is snapshotted onto each reading (not read live off the meter at
-- billing time) for the same reason document_line_items snapshot prices: a
-- tariff change must not silently restate what an already-billed period
-- cost. invoice_id is set once the reading has been billed, which is also
-- what stops it being billed twice.
CREATE TABLE poki_meter_readings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meter_id          uuid NOT NULL REFERENCES poki_meters(id) ON DELETE CASCADE,
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  previous_reading  numeric(14,3) NOT NULL DEFAULT 0,
  current_reading   numeric(14,3) NOT NULL DEFAULT 0,
  consumption       numeric(14,3) NOT NULL DEFAULT 0,
  rate              numeric(12,4) NOT NULL DEFAULT 0,
  amount            numeric(14,2) NOT NULL DEFAULT 0,
  invoice_id        uuid NULL REFERENCES invoices(id) ON DELETE SET NULL,
  read_on           date NOT NULL DEFAULT CURRENT_DATE,
  read_by           uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  notes             text NOT NULL DEFAULT '',
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);
CREATE INDEX idx_poki_meter_readings_meter ON poki_meter_readings(meter_id);
CREATE INDEX idx_poki_meter_readings_invoice ON poki_meter_readings(invoice_id);

-- ── utilities: master bills to apportion across units ───────────────────
-- The whole-building ECG/Ghana Water bill, split over the units set to
-- 'apportioned'. split_method decides how: by each unit's apportion_share
-- percentage, equally between them, or weighted by floor area.
CREATE TABLE poki_master_bills (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL REFERENCES poki_properties(id) ON DELETE CASCADE,
  utility_type text NOT NULL DEFAULT 'electricity' CHECK (utility_type IN ('electricity', 'water', 'gas', 'other')),
  period_start date NOT NULL,
  period_end   date NOT NULL,
  total_amount numeric(14,2) NOT NULL DEFAULT 0,
  split_method text NOT NULL DEFAULT 'share' CHECK (split_method IN ('share', 'equal', 'sqm')),
  reference    text NOT NULL DEFAULT '',
  billed_at    timestamptz NULL,
  notes        text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);
CREATE INDEX idx_poki_master_bills_property ON poki_master_bills(property_id);

-- ── maintenance requests ────────────────────────────────────────────────
CREATE TABLE poki_maintenance_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id          uuid NOT NULL REFERENCES poki_units(id) ON DELETE CASCADE,
  lease_id         uuid NULL REFERENCES poki_leases(id) ON DELETE SET NULL,
  title            text NOT NULL,
  description      text NOT NULL DEFAULT '',
  category         text NOT NULL DEFAULT 'general',
  priority         text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed', 'cancelled')),
  reported_on      date NOT NULL DEFAULT CURRENT_DATE,
  reported_by      text NOT NULL DEFAULT '',
  assigned_to      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  cost             numeric(14,2) NOT NULL DEFAULT 0,
  charge_to_tenant boolean NOT NULL DEFAULT false,
  resolved_on      date NULL,
  resolution_notes text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_poki_maintenance_unit ON poki_maintenance_requests(unit_id);
CREATE INDEX idx_poki_maintenance_status ON poki_maintenance_requests(status);

-- ── lease agreement templates ───────────────────────────────────────────
-- Body is plain text with {{placeholders}} (tenant name, unit, rent, dates)
-- substituted at generation time; the RESULT is written to
-- poki_leases.agreement_body, so editing a template never rewrites
-- agreements already generated and signed against the old wording.
CREATE TABLE poki_agreement_templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name       text NOT NULL,
  unit_type  text NOT NULL DEFAULT 'any',
  body       text NOT NULL DEFAULT '',
  is_default boolean NOT NULL DEFAULT false,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_poki_agreement_templates_company ON poki_agreement_templates(company_id);

-- ── rent/utility specifics on the shared invoice table ──────────────────
-- doc_kind separates a rent invoice from a utility bill from an ordinary
-- BPL sales invoice, so each list and report can filter to its own kind.
-- Existing rows default to 'sale', which is what they all are.
ALTER TABLE invoices ADD COLUMN doc_kind      text NOT NULL DEFAULT 'sale' CHECK (doc_kind IN ('sale', 'rent', 'utility', 'deposit', 'maintenance', 'other'));
ALTER TABLE invoices ADD COLUMN poki_lease_id uuid NULL REFERENCES poki_leases(id) ON DELETE SET NULL;
ALTER TABLE invoices ADD COLUMN period_start  date NULL;
ALTER TABLE invoices ADD COLUMN period_end    date NULL;
CREATE INDEX idx_invoices_poki_lease ON invoices(poki_lease_id);
CREATE INDEX idx_invoices_doc_kind ON invoices(doc_kind);

-- ── document numbering for leases ───────────────────────────────────────
-- nextDocNumber(client, kind) reads settings.commercial.numbering[kind] and
-- would throw on a missing key, so the lease counter is added to the live
-- settings row here as well as to referenceData.js's defaults for fresh
-- installs.
UPDATE settings
SET commercial = jsonb_set(
      commercial,
      '{numbering,lease}',
      '{"prefix": "LSE", "padding": 4, "includeYear": true, "nextNumber": 1}'::jsonb,
      true
    )
WHERE id = 1 AND NOT (commercial -> 'numbering' ? 'lease');
