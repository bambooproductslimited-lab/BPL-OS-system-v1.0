ALTER TABLE restaurant_import_jobs DROP COLUMN IF EXISTS photos_skipped;
ALTER TABLE restaurant_import_jobs DROP COLUMN IF EXISTS photos_imported;
ALTER TABLE restaurant_menu_items DROP COLUMN IF EXISTS photo_square_image_id;
