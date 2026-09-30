-- Emails to customers and tenants (documentEmails.service.js): an invoice,
-- quotation, estimate or Poki bill sent from its preview with the PDF
-- attached; payment reminders and payment receipts sent on their own.

-- Company settings → Email: the automatic ones can be switched off.
ALTER TABLE settings ADD COLUMN client_emails jsonb NOT NULL DEFAULT '{}';

-- Every email that went to a customer: what, to whom, by whom or on its own.
CREATE TABLE document_emails (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type  text NOT NULL CHECK (document_type IN ('invoice', 'quotation', 'estimate', 'receipt')),
  document_id    uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('document', 'reminder', 'receipt')),
  to_address     text NOT NULL,
  cc             text NOT NULL DEFAULT '',
  subject        text NOT NULL,
  automatic      boolean NOT NULL DEFAULT false,
  sent_by        uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  sent_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_document_emails_document ON document_emails (document_type, document_id, sent_at DESC);
CREATE INDEX idx_document_emails_auto_day ON document_emails (sent_at) WHERE automatic;
-- A payment's receipt goes out on its own once, however often it's asked.
CREATE UNIQUE INDEX idx_document_emails_auto_receipt ON document_emails (document_id) WHERE automatic AND kind = 'receipt';

-- Payment reminders by email sit with the texts and WhatsApp messages.
ALTER TABLE payment_reminders ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE payment_reminders ADD COLUMN email text NULL;
ALTER TABLE payment_reminders DROP CONSTRAINT payment_reminders_channel_check;
ALTER TABLE payment_reminders ADD CONSTRAINT payment_reminders_channel_check CHECK (channel IN ('whatsapp', 'sms', 'email'));

-- The link in an automatic email is made by the OS itself, not a person.
ALTER TABLE document_shares ALTER COLUMN created_by DROP NOT NULL;
