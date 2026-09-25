DROP TABLE tool_room_moves;
ALTER TABLE tool_room_items DROP COLUMN updated_at, DROP COLUMN created_at, DROP COLUMN due_back, DROP COLUMN checked_out_at;
