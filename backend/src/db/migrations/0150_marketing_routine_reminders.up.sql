-- Reminders for marketing request routines (mkRoutines.service.js remind):
--   remind_ahead_days  a heads-up to the lead and team N days before a
--                      routine comes round (NULL: none);
--   remind_due_days    a reminder N days before a request it made is
--                      needed, and on the day, while it isn't done (0: on
--                      the day only; NULL: none);
--   remind_by_sms      also as a text (when texts are set up and
--                      "routineRemindersBySms" is on in Company settings).
ALTER TABLE marketing_request_routines
  ADD COLUMN remind_ahead_days smallint NULL DEFAULT 1 CHECK (remind_ahead_days BETWEEN 1 AND 7),
  ADD COLUMN remind_due_days   smallint NULL DEFAULT 1 CHECK (remind_due_days BETWEEN 0 AND 3),
  ADD COLUMN remind_by_sms     boolean NOT NULL DEFAULT true;

-- Each reminder sent, so however often the job runs one goes out once:
-- 'ahead' per routine and day it comes round, 'due' per request and day.
CREATE TABLE marketing_routine_reminders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('ahead', 'due')),
  routine_id  uuid NULL REFERENCES marketing_request_routines(id) ON DELETE CASCADE,
  request_id  uuid NULL REFERENCES marketing_requests(id) ON DELETE CASCADE,
  for_day     date NOT NULL,  -- ahead: the day it comes round; due: the reminder's day
  people      integer NOT NULL DEFAULT 0,
  texts       integer NOT NULL DEFAULT 0,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'ahead' AND routine_id IS NOT NULL) OR (kind = 'due' AND request_id IS NOT NULL))
);
CREATE UNIQUE INDEX ux_marketing_routine_reminders_ahead ON marketing_routine_reminders(routine_id, for_day) WHERE kind = 'ahead';
CREATE UNIQUE INDEX ux_marketing_routine_reminders_due ON marketing_routine_reminders(request_id, for_day) WHERE kind = 'due';
