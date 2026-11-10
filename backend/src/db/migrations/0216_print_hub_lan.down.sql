ALTER TABLE restaurant_print_hubs
  DROP COLUMN IF EXISTS lan_ips,
  DROP COLUMN IF EXISTS lan_port,
  DROP COLUMN IF EXISTS lan_setup_port,
  DROP COLUMN IF EXISTS lan_key,
  DROP COLUMN IF EXISTS lan_ca;
