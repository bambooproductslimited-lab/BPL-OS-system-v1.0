-- Products & Services (catalog.service.js): photos of each item. An item
-- can have several; the first (position 0) is its cover. A photo can be
-- tagged to one variation (the bedside lamp vs the pole light of one item),
-- so pickers show that variation its own photo. Only the file reference is
-- kept here (lib/fileStore.js), never the image bytes.
CREATE TABLE catalog_item_photos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id      uuid NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  variation_id uuid NULL REFERENCES catalog_item_variations(id) ON DELETE SET NULL,
  photo_key    text NOT NULL,
  caption      text NOT NULL DEFAULT '',
  position     integer NOT NULL DEFAULT 0,
  created_by   uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_catalog_item_photos_item ON catalog_item_photos(item_id, position);
