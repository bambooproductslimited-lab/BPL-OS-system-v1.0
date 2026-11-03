-- The restaurant's network printers, as on Square (restaurantPrinters
-- .service.js): Star printers on the restaurant's network (Ethernet) that
-- fetch what to print from this server (Star CloudPRNT), each with a
-- profile — the kitchen stations whose tickets it prints, the order summary
-- for the cashier, receipts and bills from the tills, void tickets.
--
-- restaurant_print_links: the restaurant's own printer link, put in each
-- printer's CloudPRNT settings (the printer's server URL); a printer that
-- calls it the first time is added to the restaurant, waiting for a name.
CREATE TABLE restaurant_print_links (
  company_id  uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  token       text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE restaurant_printers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  mac           text NOT NULL,
  name          text NOT NULL DEFAULT '',
  paper_mm      integer NOT NULL DEFAULT 80 CHECK (paper_mm IN (58, 80)),
  station_ids   uuid[] NOT NULL DEFAULT '{}',
  stubs         boolean NOT NULL DEFAULT false,
  receipts      boolean NOT NULL DEFAULT false,
  voids         boolean NOT NULL DEFAULT true,
  copies        integer NOT NULL DEFAULT 1 CHECK (copies BETWEEN 1 AND 3),
  status_code   text NOT NULL DEFAULT '',
  last_seen_at  timestamptz NULL,
  last_ip       text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, mac)
);

-- What each printer has to print, oldest first: drawn as a picture when the
-- printer asks for it (lib/ticketImage.js), done when it says it printed.
CREATE TABLE restaurant_print_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  printer_id  uuid NOT NULL REFERENCES restaurant_printers(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('kitchen', 'stub', 'void', 'receipt', 'bill', 'report', 'test')),
  title       text NOT NULL DEFAULT '',
  doc         jsonb NOT NULL,
  kick        boolean NOT NULL DEFAULT false,
  ticket_id   uuid NULL REFERENCES restaurant_kitchen_tickets(id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'printing', 'printed', 'failed', 'cancelled')),
  attempts    integer NOT NULL DEFAULT 0,
  error       text NOT NULL DEFAULT '',
  created_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz NULL,
  done_at     timestamptz NULL
);
CREATE INDEX idx_restaurant_print_jobs_waiting ON restaurant_print_jobs (printer_id, created_at) WHERE status IN ('queued', 'printing');
CREATE INDEX idx_restaurant_print_jobs_company ON restaurant_print_jobs (company_id, created_at DESC);
