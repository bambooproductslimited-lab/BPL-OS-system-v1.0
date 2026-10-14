UPDATE restaurant_guests SET source = 'manual' WHERE source = 'message';
ALTER TABLE restaurant_guests DROP CONSTRAINT restaurant_guests_source_check;
ALTER TABLE restaurant_guests ADD CONSTRAINT restaurant_guests_source_check CHECK (source IN ('manual', 'till', 'order', 'import', 'square'));
DROP TABLE IF EXISTS restaurant_messages;
DROP TABLE IF EXISTS restaurant_conversations;
DROP TABLE IF EXISTS company_whatsapp;
