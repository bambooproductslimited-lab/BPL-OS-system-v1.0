-- Poki letting estimates.
--
-- Before a lease exists, Poki quotes a prospective tenant what it costs to
-- take a unit: rent upfront, the security deposit, and any fixed utility
-- charge. That is an estimate in every respect the existing table already
-- models — line items, totals, validity date, payment schedule, share
-- links, PDF preview — so it is a row in `estimates`, separated by the
-- company_id added in migration 0056, rather than a parallel table. The
-- same reasoning as rent and utility invoices reusing `invoices`.
--
-- Two columns carry what a letting offer needs beyond a sale estimate:
-- which unit is being offered, and which kind of offer it is. Both are
-- defaulted and nullable, so every existing estimate stays exactly as it
-- is and the Bamboo Products screens are unaffected.
ALTER TABLE estimates ADD COLUMN doc_kind text NOT NULL DEFAULT 'sale'
  CHECK (doc_kind IN ('sale', 'letting', 'maintenance', 'other'));
ALTER TABLE estimates ADD COLUMN poki_unit_id uuid NULL REFERENCES poki_units(id) ON DELETE SET NULL;
CREATE INDEX idx_estimates_poki_unit ON estimates(poki_unit_id);
CREATE INDEX idx_estimates_doc_kind ON estimates(doc_kind);

-- An accepted letting offer becomes a lease, the way an accepted estimate
-- becomes a quotation on the Bamboo Products side. That link is recorded
-- on the lease in the same direction as quotations.from_estimate_id, so
-- the offer that produced a tenancy stays traceable after the fact.
-- ON DELETE SET NULL: losing the estimate must never take the lease with
-- it — the lease is the binding document.
ALTER TABLE poki_leases ADD COLUMN from_estimate_id uuid NULL REFERENCES estimates(id) ON DELETE SET NULL;
CREATE INDEX idx_poki_leases_from_estimate ON poki_leases(from_estimate_id);
