DELETE FROM document_shares WHERE created_by IS NULL;
ALTER TABLE document_shares ALTER COLUMN created_by SET NOT NULL;

DELETE FROM payment_reminders WHERE channel = 'email';
ALTER TABLE payment_reminders DROP CONSTRAINT payment_reminders_channel_check;
ALTER TABLE payment_reminders ADD CONSTRAINT payment_reminders_channel_check CHECK (channel IN ('whatsapp', 'sms'));
ALTER TABLE payment_reminders DROP COLUMN email;
ALTER TABLE payment_reminders ALTER COLUMN phone SET NOT NULL;

DROP TABLE document_emails;
ALTER TABLE settings DROP COLUMN client_emails;
