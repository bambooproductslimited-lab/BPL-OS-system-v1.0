-- A unit can be let in a currency other than the company's own, at a rate
-- the letting agent sets rather than one fetched from a market feed.
--
-- The rate lives on the unit, not in a settings table, because that is how
-- the business wants it: each unit remembers the rate it was set up with and
-- keeps it until someone edits that unit. A rate in Settings would silently
-- re-price every unit the moment it moved, which is the opposite of what a
-- letting agent wants when an asking rent has already been quoted.
--
-- fx_rate is "how many GHS one unit of this unit's currency is worth", so a
-- unit priced in USD at 15.50 stores 15.50. GHS units store 1, which keeps
-- the arithmetic uniform: GHS equivalent = amount * fx_rate, always.
--
-- The amounts themselves stay in the unit's own currency. base_rent on a USD
-- unit is 500 USD, not its GHS equivalent, and the booking and invoice
-- raised from it are in USD too — poki_bookings already inherits
-- poki_units.currency. fx_rate exists so the figure can be SHOWN in GHS
-- beside it, not to convert what is stored.
ALTER TABLE poki_units
  ADD COLUMN fx_rate numeric(14,6) NOT NULL DEFAULT 1;

ALTER TABLE poki_units
  ADD CONSTRAINT poki_units_fx_rate_positive CHECK (fx_rate > 0);

-- Every existing unit is in GHS, so 1 is right for all of them and the
-- default has already applied it.
COMMENT ON COLUMN poki_units.fx_rate IS
  'GHS per 1 unit of this unit''s currency. 1 for GHS units. Set by hand when the unit is created or edited; never fetched.';
