-- What the ordering website sells (restaurantOnline): a dish can be taken
-- off it, and so can a whole section of the menu, by its name — the till
-- still sells them. Switched on the delivery screen (restaurantDelivery
-- onlineMenu).
ALTER TABLE restaurant_menu_items ADD COLUMN online boolean NOT NULL DEFAULT true;

CREATE TABLE restaurant_online_categories_off (
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category    text NOT NULL,
  updated_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, category)
);
