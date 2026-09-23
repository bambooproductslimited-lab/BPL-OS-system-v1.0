-- The fields a bamboo farmer register actually carries, added to suppliers
-- rather than to a separate "farmers" table: a farmer who sells us poles IS
-- a supplier, and raw_batches.supplier_id already points here — putting
-- farmers anywhere else would split one relationship across two tables.
--
-- Everything is optional and defaults empty, so a supplier of glue or
-- packaging carries none of it and loses nothing.
--
-- Status and assessment are deliberately free text, not a CHECK list. The
-- sourcing team's own vocabulary ("Schedule for meeting", "Cutting sample",
-- "Yet to cut") is the useful one and will keep growing; a constraint would
-- only force it into words nobody on the ground uses. They are also kept
-- apart from the existing `status` column, which stays the plain
-- active/inactive switch the rest of the app filters on.
ALTER TABLE suppliers
  ADD COLUMN region             text          NOT NULL DEFAULT '',
  ADD COLUMN town               text          NOT NULL DEFAULT '',
  ADD COLUMN district           text          NOT NULL DEFAULT '',
  ADD COLUMN phone2             text          NOT NULL DEFAULT '',
  -- A quoted price per unit of what they sell — for a bamboo farmer, GHS
  -- per pole. Kept with its unit so the same column serves a supplier who
  -- quotes per kg or per litre.
  ADD COLUMN quoted_price       numeric(12,2) NULL CHECK (quoted_price IS NULL OR quoted_price >= 0),
  ADD COLUMN price_unit         text          NOT NULL DEFAULT '',
  ADD COLUMN assessment         text          NOT NULL DEFAULT '',
  ADD COLUMN sourcing_status    text          NOT NULL DEFAULT '',
  ADD COLUMN expected_qty       numeric(12,2) NULL CHECK (expected_qty IS NULL OR expected_qty >= 0),
  -- Recorded exactly as the sourcing sheet has it, under its own name. The
  -- sheet does not say which way an IOU runs, so neither does this column —
  -- see iou_notes for the story behind each figure.
  ADD COLUMN iou_amount         numeric(14,2) NULL,
  ADD COLUMN iou_notes          text          NOT NULL DEFAULT '',
  ADD COLUMN first_contact_date date          NULL,
  ADD COLUMN notes              text          NOT NULL DEFAULT '';
