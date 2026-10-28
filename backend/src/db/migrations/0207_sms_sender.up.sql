-- The sender ID texts come from, chosen in Company settings → Text messages
-- (else the server's MNOTIFY_SENDER_ID), and the last word on it from
-- mNotify: { name, state: approved | pending | rejected | not_registered |
-- refused | unknown, said, at }. sms.service.js.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS sms_sender_id text NULL;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS sms_sender_check jsonb NULL;
