-- What Meta says about the company's WhatsApp account (webhook fields
-- account_update, phone_number_quality_update, message_template_status_update),
-- shown as warnings on Sales & CRM → Data health.
CREATE TABLE IF NOT EXISTS whatsapp_alerts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('account', 'quality', 'template')),
  event        text NOT NULL,
  tone         text NOT NULL CHECK (tone IN ('good', 'info', 'warn', 'bad')),
  details      jsonb NOT NULL DEFAULT '{}',
  at           timestamptz NOT NULL DEFAULT now(),
  dismissed_at timestamptz,
  dismissed_by uuid REFERENCES employees(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS whatsapp_alerts_open ON whatsapp_alerts (at DESC) WHERE dismissed_at IS NULL;
