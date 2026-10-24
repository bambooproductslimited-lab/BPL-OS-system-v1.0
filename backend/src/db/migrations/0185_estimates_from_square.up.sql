-- Estimates brought over from Square (squareEstimates.service.js). Square
-- has no way for another app to read its estimates, so they come from the
-- PDFs Square makes of them; each keeps Square's number, so bringing the
-- same one again finds it instead of making a second copy.
ALTER TABLE estimates ADD COLUMN external_id text NULL;
ALTER TABLE estimates ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'square'));
CREATE UNIQUE INDEX ux_estimates_external_id ON estimates (external_id) WHERE external_id IS NOT NULL;
