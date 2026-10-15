DROP TABLE IF EXISTS marketing_routine_reminders;
ALTER TABLE marketing_request_routines DROP COLUMN IF EXISTS remind_by_sms;
ALTER TABLE marketing_request_routines DROP COLUMN IF EXISTS remind_due_days;
ALTER TABLE marketing_request_routines DROP COLUMN IF EXISTS remind_ahead_days;
