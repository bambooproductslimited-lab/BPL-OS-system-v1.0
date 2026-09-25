-- Raw bamboo & production (rawBatches.service.js, production.service.js).
--
-- raw_batches.quantity is what is left of a batch: recording production
-- takes from it. What was received is kept apart (received_qty) so the page
-- can show how much of a delivery has been used, written off or is left,
-- and the cost per unit. Existing batches get it back from their own
-- production. disposed_qty is what was written off (rotten, split, stolen).
ALTER TABLE raw_batches
  ADD COLUMN received_qty numeric(12,2),
  ADD COLUMN disposed_qty numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN notes text NOT NULL DEFAULT '',
  ADD COLUMN created_by uuid REFERENCES employees(id) ON DELETE SET NULL;

UPDATE raw_batches rb SET received_qty = rb.quantity + coalesce((
  SELECT sum(pb.input_qty) FROM production_batches pb WHERE pb.raw_batch_id = rb.id AND pb.status <> 'cancelled'
), 0);
ALTER TABLE raw_batches ALTER COLUMN received_qty SET NOT NULL;

-- A production record entered by mistake is cancelled, not deleted: the
-- raw bamboo goes back to its batch and the output comes off stock.
ALTER TABLE production_batches
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancelled_by uuid REFERENCES employees(id) ON DELETE SET NULL,
  ADD COLUMN cancel_reason text NOT NULL DEFAULT '',
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
