-- Recurring invoices only go out when a person starts them (pokiRecurring
-- run() needs a person now). Who billed each period is kept, so automatic
-- reminders can tell an invoice a person billed from one the old morning
-- run raised by itself (billed_by NULL), which they leave alone.
ALTER TABLE poki_recurring_charge_runs ADD COLUMN billed_by uuid NULL REFERENCES employees(id) ON DELETE SET NULL;
