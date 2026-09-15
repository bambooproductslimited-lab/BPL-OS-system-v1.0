-- Lease expiry reminders.
--
-- A tenancy that lapses unnoticed frees its unit automatically and stops
-- billing, so the window to chase a renewal or start re-letting has to be
-- pushed at whoever manages Poki rather than waiting to be noticed on a
-- dashboard. These become ordinary notification-bell rows.
--
-- This table exists purely so a reminder fires once. There is no scheduler
-- in this deployment — periodic work runs as a lazy sweep when someone
-- opens the relevant screen, the same pattern as autoExpireLeases and
-- autoExpireQuotations — which means the sweep may run many times a day,
-- from more than one instance. The unique constraint, not the caller, is
-- what guarantees one notification per milestone.
--
-- end_date is part of that key on purpose. A renewal or extension moves
-- the lease's end date, and the milestones must then fire again for the
-- NEW date: keyed on lease and milestone alone, extending a lease would
-- silently suppress every future reminder for it.
CREATE TABLE poki_lease_reminders (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id   uuid NOT NULL REFERENCES poki_leases(id) ON DELETE CASCADE,
  milestone  text NOT NULL,
  end_date   date NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lease_id, milestone, end_date)
);

CREATE INDEX idx_poki_lease_reminders_lease ON poki_lease_reminders(lease_id);
