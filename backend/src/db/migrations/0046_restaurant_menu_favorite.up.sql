-- Restaurant module: a "favorite" flag on menu items for the POS till's
-- quick-access tabs (Favorites/Recent/Mostly bought/All items). Shared
-- across whoever is on the till, not per-cashier — the till has no
-- concept of a persistent user account (see restaurantPos.service.js's
-- PIN-session model), and a shared "our top picks" set pinned by whoever
-- curates it is more useful for a busy counter than everyone having to
-- rebuild their own list each shift.
ALTER TABLE restaurant_menu_items ADD COLUMN favorite boolean NOT NULL DEFAULT false;
