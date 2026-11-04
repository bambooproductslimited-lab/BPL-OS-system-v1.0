-- The Bamboo print hub (services/restaurantPrintHub.service.js): a small
-- program on one computer that stays on at the restaurant. It finds the
-- printers on the restaurant's network by itself — every Epson, Star or
-- other receipt printer with a network cable (port 9100) — tells this
-- server about them, and prints their tickets. Nothing is set on the
-- printers. It uses the restaurant's printer link (restaurant_print_links).
CREATE TABLE restaurant_print_hubs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  hub_key       text NOT NULL,              -- made by the hub on its first start
  name          text NOT NULL DEFAULT '',   -- the computer's name
  platform      text NOT NULL DEFAULT '',
  version       text NOT NULL DEFAULT '',
  networks      text NOT NULL DEFAULT '',   -- what it looks through: 192.168.1.0/24
  last_seen_at  timestamptz NULL,
  last_scan_at  timestamptz NULL,
  last_ip       text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, hub_key)
);

-- A printer reached through a hub (via 'hub', at ip:port) or one asking by
-- itself (via 'cloudprnt'); what it is (make: star | epson | escpos; its
-- model), and the printer language it is sent: '' as its make says, or
-- 'star' / 'escpos' when chosen.
ALTER TABLE restaurant_printers
  ADD COLUMN via           text NOT NULL DEFAULT 'cloudprnt' CHECK (via IN ('cloudprnt', 'hub')),
  ADD COLUMN make          text NOT NULL DEFAULT '',
  ADD COLUMN model         text NOT NULL DEFAULT '',
  ADD COLUMN port          integer NULL,
  ADD COLUMN hub_id        uuid NULL REFERENCES restaurant_print_hubs(id) ON DELETE SET NULL,
  ADD COLUMN command_set   text NOT NULL DEFAULT '' CHECK (command_set IN ('', 'star', 'escpos')),
  ADD COLUMN cloud_seen_at timestamptz NULL,
  -- Found on the network but not a printer for tickets (taken off): the
  -- hub's reports leave it hidden.
  ADD COLUMN ignored       boolean NOT NULL DEFAULT false;
UPDATE restaurant_printers SET cloud_seen_at = last_seen_at;
