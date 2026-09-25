-- Expense claims: a photo or PDF of the receipt (kept like chat files, see
-- lib/fileStore.js), the reason given when a claim is decided, and who
-- paid it out and when.
ALTER TABLE expenses ADD COLUMN receipt_key text NULL;
ALTER TABLE expenses ADD COLUMN receipt_name text NULL;
ALTER TABLE expenses ADD COLUMN receipt_type text NULL;
ALTER TABLE expenses ADD COLUMN decision_note text NOT NULL DEFAULT '';
ALTER TABLE expenses ADD COLUMN paid_at timestamptz NULL;
ALTER TABLE expenses ADD COLUMN paid_by uuid NULL REFERENCES employees(id) ON DELETE SET NULL;
