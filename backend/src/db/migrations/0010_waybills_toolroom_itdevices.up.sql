-- Waybills (goods dispatched from the factory or showroom), Tool Room
-- inventory (tools/equipment/materials kept in the tool room, separate from
-- the finished-goods Products & Inventory module), and IT Device inventory
-- (company devices/gadgets, separate from the general Assets & Maintenance
-- module — owned/tracked by IT specifically).

CREATE TABLE waybills (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  waybill_no     text NOT NULL UNIQUE,
  origin         text NOT NULL CHECK (origin IN ('factory', 'showroom')),
  destination    text NOT NULL DEFAULT '',
  customer_id    uuid NULL REFERENCES customers(id) ON DELETE SET NULL,
  driver_name    text NOT NULL DEFAULT '',
  vehicle_no     text NOT NULL DEFAULT '',
  dispatched_by  uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  received_by    text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'dispatched' CHECK (status IN ('dispatched', 'delivered', 'cancelled')),
  notes          text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now(),
  delivered_at   timestamptz NULL
);

CREATE TABLE tool_room_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text NOT NULL UNIQUE,
  name              text NOT NULL,
  kind              text NOT NULL DEFAULT 'tool' CHECK (kind IN ('tool', 'equipment', 'material')),
  category          text NOT NULL DEFAULT '',
  unit              text NOT NULL DEFAULT 'each',
  quantity_on_hand  numeric(12,2) NOT NULL DEFAULT 0,
  reorder_level     numeric(12,2) NOT NULL DEFAULT 0,
  condition         text NOT NULL DEFAULT 'good' CHECK (condition IN ('good', 'fair', 'poor', 'under_repair')),
  location          text NOT NULL DEFAULT 'Tool room',
  checked_out_to    uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'checked_out', 'retired')),
  notes             text NOT NULL DEFAULT ''
);

CREATE TABLE it_devices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_tag            text NOT NULL UNIQUE,
  category              text NOT NULL DEFAULT '',
  brand                 text NOT NULL DEFAULT '',
  model                 text NOT NULL DEFAULT '',
  serial_number         text NOT NULL DEFAULT '',
  assigned_employee_id  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  department_id         uuid NULL REFERENCES departments(id) ON DELETE SET NULL,
  location              text NOT NULL DEFAULT '',
  purchase_date         date NULL,
  purchase_price        numeric(14,2) NOT NULL DEFAULT 0,
  warranty_until        date NULL,
  condition             text NOT NULL DEFAULT 'good' CHECK (condition IN ('good', 'fair', 'poor')),
  status                text NOT NULL DEFAULT 'in_use' CHECK (status IN ('in_use', 'in_storage', 'under_repair', 'retired', 'lost')),
  notes                 text NOT NULL DEFAULT ''
);

-- Waybill line items (description/qty/unit only, no pricing) reuse the
-- shared document_line_items table quotations/estimates/invoices already
-- use — its document_type CHECK needs 'waybill' added to allow that.
ALTER TABLE document_line_items DROP CONSTRAINT document_line_items_document_type_check;
ALTER TABLE document_line_items ADD CONSTRAINT document_line_items_document_type_check
  CHECK (document_type IN ('quotation', 'estimate', 'sales_order', 'invoice', 'waybill'));

CREATE INDEX idx_waybills_status ON waybills(status);
CREATE INDEX idx_tool_room_items_checked_out_to ON tool_room_items(checked_out_to);
CREATE INDEX idx_it_devices_assigned_employee_id ON it_devices(assigned_employee_id);
