-- Share links now always expire.
--
-- A document share link is a bearer URL: anyone holding it sees the
-- customer's name, email, phone, address and the document's financials,
-- with no login. Until now a link could be created with no expiry at all,
-- so one forwarded on — or sitting in an old WhatsApp thread — stayed live
-- indefinitely. A security review flagged that; 30 days is the new default
-- and the ceiling.
--
-- Existing perpetual links are given 30 days from this migration rather
-- than 30 days from when they were created. Dating it from creation would
-- silently break links already sent to customers the moment this deploys;
-- this way everyone holding one keeps it for a further 30 days and the
-- perpetual grant still ends.
UPDATE document_shares
   SET expires_at = now() + interval '30 days'
 WHERE expires_at IS NULL;

-- NOT NULL is what actually guarantees it. Without this the rule lives
-- only in application code, one refactor away from a null slipping back
-- through and restoring permanent links by accident.
ALTER TABLE document_shares ALTER COLUMN expires_at SET NOT NULL;
