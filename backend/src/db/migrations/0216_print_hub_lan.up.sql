-- Outage mode (tools/print-hub, restaurantPrintHub.service.js outage): the
-- print hub also answers on the restaurant's own network, so the tills and
-- the kitchen screens keep working with each other while the internet is
-- down (a power cut can keep it down for days). Where it answers — its
-- addresses on the network, its port for the tills (HTTPS, with its own
-- certificate, which each till trusts once), its setup page — and the key
-- the tills and kitchen screens give it, handed to them by this server
-- while the internet is on.
ALTER TABLE restaurant_print_hubs
  ADD COLUMN lan_ips        text[]  NOT NULL DEFAULT '{}',
  ADD COLUMN lan_port       integer NULL,
  ADD COLUMN lan_setup_port integer NULL,
  ADD COLUMN lan_key        text    NOT NULL DEFAULT '',
  ADD COLUMN lan_ca         text    NOT NULL DEFAULT '';  -- the SHA-256 of its certificate authority
