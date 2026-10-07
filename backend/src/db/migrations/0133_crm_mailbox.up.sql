-- The sales mailbox the CRM inbox reads and replies from, connected on
-- Integrations (services/crmMailbox.service.js) rather than typed into the
-- server's settings. One row. The password is kept sealed (AES-256-GCM, a
-- key derived from the server's secret), never returned to any screen.
CREATE TABLE crm_mailbox (
  id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  provider      text NOT NULL DEFAULT 'other' CHECK (provider IN ('gmail', 'hostinger', 'other')),
  address       text NOT NULL,
  password_enc  text NOT NULL,
  imap_host     text NOT NULL,
  imap_port     int NOT NULL DEFAULT 993,
  smtp_host     text NOT NULL,
  smtp_port     int NOT NULL DEFAULT 465,
  inbox_folder  text NOT NULL DEFAULT 'INBOX',
  sent_folder   text NOT NULL DEFAULT '',
  from_name     text NOT NULL DEFAULT '',
  connected_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  connected_at  timestamptz NOT NULL DEFAULT now()
);
