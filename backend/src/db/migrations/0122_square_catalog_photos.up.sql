-- The Square import keeps the catalogue it brought in (it used to delete
-- and re-create every Square item, which took their photos with them) and
-- brings each item's Square pictures. A picture from Square is remembered
-- by its Square image id, so importing again never adds it twice.
ALTER TABLE catalog_item_photos ADD COLUMN square_image_id text NULL;
CREATE UNIQUE INDEX idx_catalog_item_photos_square ON catalog_item_photos (item_id, square_image_id) WHERE square_image_id IS NOT NULL;
ALTER TABLE square_import_jobs ADD COLUMN photos_imported integer NOT NULL DEFAULT 0;
ALTER TABLE square_import_jobs ADD COLUMN photos_skipped integer NOT NULL DEFAULT 0;
