-- The twenty-second batch: export papers (exports.service.js), the
-- agreements register (agreements.service.js), overtime into payroll
-- (overtime.service.js), staff ID cards (staffCards.service.js), warranty
-- claims (warranty.service.js) and Ghana's public holidays loaded in one go
-- (utils/ghanaHolidays.js).

-- ── Export papers ──
-- A shipment abroad: what goes (the lines, with their HS codes), how it is
-- packed (the packages, their marks, weights and sizes), where and how it
-- travels, and the papers it needs. Three documents are printed from it: the
-- proforma invoice, the packing list and the certificate of origin.
ALTER TABLE products
  ADD COLUMN hs_code   text NOT NULL DEFAULT '',
  ADD COLUMN weight_kg numeric(12,3) NULL CHECK (weight_kg IS NULL OR weight_kg >= 0);

CREATE TABLE export_shipments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number              integer NOT NULL UNIQUE,
  sales_order_id      uuid NULL REFERENCES sales_orders(id) ON DELETE SET NULL,
  customer_id         uuid NULL REFERENCES customers(id) ON DELETE SET NULL,
  -- { name, address, country, phone, email, taxId }
  consignee           jsonb NOT NULL DEFAULT '{}',
  -- Who the shipping line tells when it lands, when not the consignee.
  notify              jsonb NOT NULL DEFAULT '{}',
  buyer_ref           text NOT NULL DEFAULT '',
  currency            text NOT NULL DEFAULT 'USD',
  incoterm            text NOT NULL DEFAULT 'FOB' CHECK (incoterm IN ('EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP')),
  incoterm_place      text NOT NULL DEFAULT '',
  transport           text NOT NULL DEFAULT 'sea' CHECK (transport IN ('sea', 'air', 'road')),
  port_loading        text NOT NULL DEFAULT '',
  port_discharge      text NOT NULL DEFAULT '',
  final_destination   text NOT NULL DEFAULT '',
  country             text NOT NULL DEFAULT '',
  vessel              text NOT NULL DEFAULT '',
  container_no        text NOT NULL DEFAULT '',
  seal_no             text NOT NULL DEFAULT '',
  bl_no               text NOT NULL DEFAULT '',
  ship_on             date NULL,
  payment_terms       text NOT NULL DEFAULT '',
  valid_days          integer NOT NULL DEFAULT 30 CHECK (valid_days BETWEEN 1 AND 365),
  freight             numeric(14,2) NOT NULL DEFAULT 0 CHECK (freight >= 0),
  insurance           numeric(14,2) NOT NULL DEFAULT 0 CHECK (insurance >= 0),
  -- [{ description, hsCode, qty, unit, unitPrice, productId }]
  lines               jsonb NOT NULL DEFAULT '[]',
  -- [{ marks, count, kind, contents, netKg, grossKg, l, w, h }] (cm)
  packages            jsonb NOT NULL DEFAULT '[]',
  -- { phyto: { done, ref, on }, fumigation, permit, customs, bl, origin }
  papers              jsonb NOT NULL DEFAULT '{}',
  origin_criterion    text NOT NULL DEFAULT 'wholly' CHECK (origin_criterion IN ('wholly', 'worked')),
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'proforma_sent', 'packed', 'shipped', 'cancelled')),
  proforma_sent_at    timestamptz NULL,
  packed_at           timestamptz NULL,
  shipped_at          timestamptz NULL,
  note                text NOT NULL DEFAULT '',
  created_by          uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_export_shipments_status ON export_shipments (status, created_at DESC);
CREATE INDEX idx_export_shipments_order ON export_shipments (sales_order_id) WHERE sales_order_id IS NOT NULL;

-- ── Agreements ──
-- Leases and contracts with suppliers, service firms and customers: who
-- with, from when to when, what it costs, how much notice it takes to end
-- or change it and whether it renews itself. The owner and whoever keeps the
-- agreements are reminded before the last day to give notice, and before it
-- ends. Renewing keeps the period before in the history. (Contracts a
-- customer signs online are kept apart, in Contracts.)
CREATE TABLE agreements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        integer NOT NULL UNIQUE,
  kind          text NOT NULL DEFAULT 'other' CHECK (kind IN ('lease', 'supplier', 'service', 'customer', 'loan', 'insurance', 'other')),
  title         text NOT NULL,
  party         text NOT NULL,
  supplier_id   uuid NULL REFERENCES suppliers(id) ON DELETE SET NULL,
  customer_id   uuid NULL REFERENCES customers(id) ON DELETE SET NULL,
  company_id    uuid NULL REFERENCES companies(id) ON DELETE SET NULL,
  site          text NOT NULL DEFAULT '',
  reference     text NOT NULL DEFAULT '',
  starts_on     date NULL,
  ends_on       date NULL,
  notice_days   integer NOT NULL DEFAULT 30 CHECK (notice_days BETWEEN 0 AND 730),
  auto_renews   boolean NOT NULL DEFAULT false,
  renew_months  integer NOT NULL DEFAULT 12 CHECK (renew_months BETWEEN 1 AND 120),
  value         numeric(14,2) NOT NULL DEFAULT 0 CHECK (value >= 0),
  currency      text NOT NULL DEFAULT 'GHS',
  per           text NOT NULL DEFAULT 'month' CHECK (per IN ('month', 'quarter', 'year', 'once')),
  escalation    numeric(6,2) NOT NULL DEFAULT 0 CHECK (escalation >= 0 AND escalation <= 100),
  owner_id      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  -- What we mean to do when the notice date comes.
  intent        text NULL CHECK (intent IN ('renew', 'renegotiate', 'end')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'renegotiating', 'ended')),
  ended_on      date NULL,
  end_note      text NOT NULL DEFAULT '',
  files         jsonb NOT NULL DEFAULT '[]',
  note          text NOT NULL DEFAULT '',
  created_by    uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX idx_agreements_ends ON agreements (ends_on) WHERE status <> 'ended';

CREATE TABLE agreement_periods (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id  uuid NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
  starts_on     date NULL,
  ends_on       date NULL,
  value         numeric(14,2) NOT NULL DEFAULT 0,
  currency      text NOT NULL DEFAULT 'GHS',
  per           text NOT NULL DEFAULT 'month',
  files         jsonb NOT NULL DEFAULT '[]',
  how           text NOT NULL DEFAULT 'renewed' CHECK (how IN ('renewed', 'auto')),
  note          text NOT NULL DEFAULT '',
  by_id         uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_agreement_periods ON agreement_periods (agreement_id, ends_on DESC);

-- ── Overtime ──
-- Hours worked past the day's shift, asked for by the person (or put in by
-- their manager), approved in the Approval centre, and paid by the next pay
-- run: hours × the hourly rate × the day's multiple (a weekday, a rest day
-- or a public holiday — settings.payroll.overtime).
CREATE TABLE overtime_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  day            date NOT NULL,
  hours          numeric(5,2) NOT NULL CHECK (hours > 0 AND hours <= 16),
  reason         text NOT NULL,
  day_kind       text NOT NULL DEFAULT 'weekday' CHECK (day_kind IN ('weekday', 'rest_day', 'holiday')),
  multiple       numeric(4,2) NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'paid', 'cancelled')),
  asked_by       uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  decided_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  decided_at     timestamptz NULL,
  decision_note  text NOT NULL DEFAULT '',
  pay_run_id     uuid NULL REFERENCES pay_runs(id) ON DELETE SET NULL,
  amount         numeric(14,2) NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_overtime_employee ON overtime_requests (employee_id, day);
CREATE INDEX idx_overtime_unpaid ON overtime_requests (status) WHERE status IN ('pending', 'approved');

ALTER TABLE payslips
  ADD COLUMN overtime_hours numeric(7,2) NOT NULL DEFAULT 0,
  ADD COLUMN overtime_pay   numeric(14,2) NOT NULL DEFAULT 0;

ALTER TABLE approvals DROP CONSTRAINT approvals_subject_type_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_subject_type_check
  CHECK (subject_type IN ('leave_request', 'procurement_request', 'expense', 'expense_topup', 'overtime'));

-- ── Staff ID cards ──
-- One card in force per person: printed with their photo and a QR code that
-- clocks them in at the kiosk and lets them through the gate. The code is
-- kept hashed (to find the card) and encrypted (to print it again); a new
-- card stops the one before.
CREATE TABLE staff_cards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        integer NOT NULL UNIQUE,
  employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  token_enc     text NOT NULL,
  valid_until   date NULL,
  issued_by     uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  printed_at    timestamptz NULL,
  revoked_at    timestamptz NULL,
  revoked_by    uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  revoke_reason text NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX idx_staff_cards_live ON staff_cards (employee_id) WHERE revoked_at IS NULL;

-- Each card shown at the gate: who, which way, and whether it was let
-- through.
CREATE TABLE gate_scans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id      uuid NULL REFERENCES staff_cards(id) ON DELETE SET NULL,
  employee_id  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  direction    text NOT NULL CHECK (direction IN ('in', 'out')),
  result       text NOT NULL CHECK (result IN ('ok', 'revoked', 'expired', 'inactive', 'unknown')),
  gate         text NOT NULL DEFAULT '',
  by_id        uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_gate_scans_at ON gate_scans (at DESC);
CREATE INDEX idx_gate_scans_employee ON gate_scans (employee_id, at DESC);

-- ── Warranty claims ──
-- Something wrong with a piece of BPL furniture, judged against its
-- warranty: from a customer's repair request or opened by staff on an
-- order. Its cause, the decision (accepted, goodwill or turned down), the
-- remedy, the repair visits made for it, and what it cost.
CREATE TABLE warranty_claims (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          integer NOT NULL UNIQUE,
  service_id      uuid NULL UNIQUE REFERENCES bpl_service_requests(id) ON DELETE SET NULL,
  shop_order_id   uuid NULL REFERENCES shop_orders(id) ON DELETE SET NULL,
  sales_order_id  uuid NULL REFERENCES sales_orders(id) ON DELETE SET NULL,
  customer_id     uuid NULL REFERENCES customers(id) ON DELETE SET NULL,
  name            text NOT NULL,
  phone           text NOT NULL DEFAULT '',
  email           text NOT NULL DEFAULT '',
  address         text NOT NULL DEFAULT '',
  product_id      uuid NULL REFERENCES products(id) ON DELETE SET NULL,
  item            text NOT NULL DEFAULT '',
  delivered_on    date NULL,
  warranty_until  date NULL,
  problem         text NOT NULL,
  photos          jsonb NOT NULL DEFAULT '[]',
  cause           text NULL CHECK (cause IN ('manufacturing', 'material', 'finish', 'hardware', 'transit', 'installation', 'misuse', 'wear', 'other')),
  decision        text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'accepted', 'goodwill', 'rejected')),
  decision_note   text NOT NULL DEFAULT '',
  decided_by      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  decided_at      timestamptz NULL,
  remedy          text NULL CHECK (remedy IN ('repair', 'replace', 'refund', 'credit', 'none')),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_hand', 'resolved', 'closed')),
  cost_parts      numeric(14,2) NOT NULL DEFAULT 0 CHECK (cost_parts >= 0),
  cost_labour     numeric(14,2) NOT NULL DEFAULT 0 CHECK (cost_labour >= 0),
  cost_transport  numeric(14,2) NOT NULL DEFAULT 0 CHECK (cost_transport >= 0),
  refund_amount   numeric(14,2) NOT NULL DEFAULT 0 CHECK (refund_amount >= 0),
  resolution      text NOT NULL DEFAULT '',
  resolved_on     date NULL,
  customer_happy  boolean NULL,
  created_by      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_warranty_claims_status ON warranty_claims (status, created_at DESC);

ALTER TABLE bpl_visits ADD COLUMN claim_id uuid NULL REFERENCES warranty_claims(id) ON DELETE SET NULL;
CREATE INDEX idx_bpl_visits_claim ON bpl_visits (claim_id) WHERE claim_id IS NOT NULL;

-- ── Public holidays ──
-- Loaded from Ghana's statutory list in one go: the Eids follow the moon and
-- are announced each year, so they are put in as estimates to confirm.
ALTER TABLE holidays
  ADD COLUMN estimated boolean NOT NULL DEFAULT false,
  ADD COLUMN source    text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ghana'));

INSERT INTO permissions (key, "group", label) VALUES
  ('agreement.manage', 'Finance', 'Keep the leases and contracts register, and renew them')
ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'agreement.manage' FROM roles r
WHERE r.key IN ('administrator', 'general_manager', 'executive', 'finance_manager', 'finance_hr_manager')
ON CONFLICT DO NOTHING;
