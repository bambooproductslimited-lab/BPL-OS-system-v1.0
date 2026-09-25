-- Tool room (toolRoom.service.js): when a tool went out and when it is due
-- back, and a log of every movement — tools checked out and back in (with
-- the condition they came back in), materials issued to someone or
-- restocked, counts corrected, items retired — so the page can say who has
-- what, what is overdue and how fast each material is used.
ALTER TABLE tool_room_items
  ADD COLUMN checked_out_at timestamptz,
  ADD COLUMN due_back date,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_at timestamptz;

CREATE TABLE tool_room_moves (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id      uuid NOT NULL REFERENCES tool_room_items(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('checkout', 'checkin', 'issue', 'restock', 'count', 'retire', 'restore')),
  employee_id  uuid REFERENCES employees(id) ON DELETE SET NULL,
  quantity     numeric(12,2),
  due_back     date,
  condition    text,
  note         text NOT NULL DEFAULT '',
  created_by   uuid REFERENCES employees(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_tool_room_moves_item ON tool_room_moves(item_id, created_at DESC);
CREATE INDEX idx_tool_room_moves_employee ON tool_room_moves(employee_id);

-- items already out when this arrives: out since now, as far as we know
UPDATE tool_room_items SET checked_out_at = now() WHERE status = 'checked_out';
