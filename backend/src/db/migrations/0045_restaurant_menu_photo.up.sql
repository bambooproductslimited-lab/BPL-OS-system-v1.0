-- Restaurant module: a photo per menu item, for the redesigned POS till
-- grid. Same R2 object-storage pattern the Documents module and employee
-- ID documents already use (see backend/src/lib/storage.js) — only a
-- reference is stored here, never the image bytes.
ALTER TABLE restaurant_menu_items ADD COLUMN photo_object_key text NULL;
ALTER TABLE restaurant_menu_items ADD COLUMN photo_file_name text NULL;
