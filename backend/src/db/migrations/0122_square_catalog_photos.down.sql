ALTER TABLE square_import_jobs DROP COLUMN photos_skipped;
ALTER TABLE square_import_jobs DROP COLUMN photos_imported;
DROP INDEX IF EXISTS idx_catalog_item_photos_square;
ALTER TABLE catalog_item_photos DROP COLUMN square_image_id;
