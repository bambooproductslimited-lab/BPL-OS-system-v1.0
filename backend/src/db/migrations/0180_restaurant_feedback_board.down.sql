DELETE FROM restaurant_displays WHERE kind = 'board';
ALTER TABLE restaurant_displays DROP CONSTRAINT restaurant_displays_kind_check;
ALTER TABLE restaurant_displays ADD CONSTRAINT restaurant_displays_kind_check CHECK (kind IN ('screen', 'kiosk'));
DROP TABLE IF EXISTS restaurant_feedback;
