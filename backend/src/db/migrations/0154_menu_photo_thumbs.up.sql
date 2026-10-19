-- A small square of each menu photo for the till's tiles (WebP, a few KB),
-- made the first time it is asked for and kept beside the photo
-- (restaurant.service.js getMenuItemThumb). photo_thumb_of is the photo it
-- was made from: when the photo changes, a new one is made.
ALTER TABLE restaurant_menu_items ADD COLUMN photo_thumb_key text NULL;
ALTER TABLE restaurant_menu_items ADD COLUMN photo_thumb_of text NULL;
