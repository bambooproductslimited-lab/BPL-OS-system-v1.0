-- The restaurant Square import brings each menu item's Square picture
-- (restaurantSquareImport.service.js). photo_square_image_id says which
-- Square picture the item's photo is: set, it came from Square and a later
-- import replaces it if the picture changed there; empty with a photo, it
-- was uploaded here and an import never touches it.
ALTER TABLE restaurant_menu_items ADD COLUMN photo_square_image_id text NULL;
ALTER TABLE restaurant_import_jobs ADD COLUMN photos_imported integer NOT NULL DEFAULT 0;
ALTER TABLE restaurant_import_jobs ADD COLUMN photos_skipped integer NOT NULL DEFAULT 0;
