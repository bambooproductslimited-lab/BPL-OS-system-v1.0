-- When a quotation went out and when the client answered, so the page can
-- say how long one has been waiting and how quickly clients decide.
ALTER TABLE quotations ADD COLUMN sent_at timestamptz NULL;
ALTER TABLE quotations ADD COLUMN answered_at timestamptz NULL;
-- Earlier quotations: the best we know is the day they were made.
UPDATE quotations SET sent_at = created_at WHERE status IN ('sent', 'viewed', 'accepted', 'rejected', 'expired');
UPDATE quotations SET answered_at = created_at WHERE status IN ('accepted', 'rejected');
