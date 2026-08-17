-- kernel.js Phase 2: db.warehouses, db.rawBatches, db.productionBatches, db.products,
-- db.inventoryTx, db.suppliers, db.procurementRequests, db.assets, db.maintenanceRecords
-- Not yet wired to routes in this pass — created now for schema completeness.

CREATE TABLE warehouses (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code      text NOT NULL UNIQUE,
  name      text NOT NULL,
  location  text NOT NULL DEFAULT ''
);

CREATE TABLE suppliers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  contact_person      text NOT NULL DEFAULT '',
  phone               text NOT NULL DEFAULT '',
  email               text NOT NULL DEFAULT '',
  address             text NOT NULL DEFAULT '',
  materials_supplied  text NOT NULL DEFAULT '',
  payment_terms       text NOT NULL DEFAULT '',
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))
);

CREATE TABLE raw_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_no        text NOT NULL UNIQUE,
  species         text NOT NULL,
  supplier_id     uuid NULL REFERENCES suppliers(id) ON DELETE SET NULL,
  date_received   date NOT NULL,
  quantity        numeric(12,2) NOT NULL,
  unit            text NOT NULL DEFAULT 'kg',
  quality_grade   text NOT NULL DEFAULT '',
  cost            numeric(14,2) NOT NULL DEFAULT 0,
  warehouse_id    uuid NULL REFERENCES warehouses(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'in_stock' CHECK (status IN ('in_stock', 'consumed', 'disposed'))
);

CREATE TABLE products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku             text NOT NULL UNIQUE,
  name            text NOT NULL,
  category        text NOT NULL DEFAULT '',
  unit            text NOT NULL DEFAULT 'each',
  cost_price      numeric(12,2) NOT NULL DEFAULT 0,
  selling_price   numeric(12,2) NOT NULL DEFAULT 0,
  current_stock   numeric(12,2) NOT NULL DEFAULT 0,
  reorder_level   numeric(12,2) NOT NULL DEFAULT 0
);

CREATE TABLE production_batches (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_no           text NOT NULL UNIQUE,
  date               date NOT NULL,
  production_line    text NOT NULL DEFAULT '',
  supervisor_id      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  raw_batch_id       uuid NULL REFERENCES raw_batches(id) ON DELETE SET NULL,
  output_product_id  uuid NULL REFERENCES products(id) ON DELETE SET NULL,
  input_qty          numeric(12,2) NOT NULL DEFAULT 0,
  output_qty         numeric(12,2) NOT NULL DEFAULT 0,
  waste_qty          numeric(12,2) NOT NULL DEFAULT 0,
  rejected_qty       numeric(12,2) NOT NULL DEFAULT 0,
  notes              text NOT NULL DEFAULT '',
  status             text NOT NULL DEFAULT 'completed' CHECK (status IN ('in_progress', 'completed', 'cancelled'))
);

CREATE TABLE production_batch_employees (
  production_batch_id  uuid NOT NULL REFERENCES production_batches(id) ON DELETE CASCADE,
  employee_id          uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  PRIMARY KEY (production_batch_id, employee_id)
);

CREATE TABLE inventory_tx (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_type     text NOT NULL CHECK (item_type IN ('product', 'raw')),
  item_id       uuid NOT NULL, -- references products.id or raw_batches.id depending on item_type
  warehouse_id  uuid NULL REFERENCES warehouses(id) ON DELETE SET NULL,
  type          text NOT NULL, -- e.g. 'production_output', 'production_consumption', 'adjustment', 'sale'
  qty           numeric(12,2) NOT NULL, -- signed: negative = stock out
  date          date NOT NULL,
  user_id       uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  reference     text NOT NULL DEFAULT '',
  notes         text NOT NULL DEFAULT ''
);

CREATE TABLE procurement_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id    uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  department_id   uuid NULL REFERENCES departments(id) ON DELETE SET NULL,
  item            text NOT NULL,
  quantity        numeric(12,2) NOT NULL,
  estimated_price numeric(14,2) NOT NULL DEFAULT 0,
  reason          text NOT NULL DEFAULT '',
  required_date   date NULL,
  priority        text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_by      uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  decided_at      timestamptz NULL
);

CREATE TABLE assets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_no              text NOT NULL UNIQUE,
  category              text NOT NULL DEFAULT '',
  description           text NOT NULL,
  purchase_date         date NULL,
  purchase_price        numeric(14,2) NOT NULL DEFAULT 0,
  assigned_employee_id  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  location              text NOT NULL DEFAULT '',
  condition             text NOT NULL DEFAULT 'good' CHECK (condition IN ('good', 'fair', 'poor')),
  warranty_until        date NULL,
  next_service_date     date NULL
);

CREATE TABLE maintenance_records (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id         uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  date             date NOT NULL,
  technician       text NOT NULL DEFAULT '',
  cost             numeric(14,2) NOT NULL DEFAULT 0,
  fault_report     text NOT NULL DEFAULT '',
  downtime_hours   numeric(8,2) NOT NULL DEFAULT 0,
  parts_replaced   text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'completed' CHECK (status IN ('scheduled', 'in_progress', 'completed'))
);

CREATE INDEX idx_raw_batches_supplier_id ON raw_batches(supplier_id);
CREATE INDEX idx_production_batches_raw_batch_id ON production_batches(raw_batch_id);
CREATE INDEX idx_inventory_tx_item ON inventory_tx(item_type, item_id);
CREATE INDEX idx_procurement_requests_status ON procurement_requests(status);
CREATE INDEX idx_maintenance_records_asset_id ON maintenance_records(asset_id);
