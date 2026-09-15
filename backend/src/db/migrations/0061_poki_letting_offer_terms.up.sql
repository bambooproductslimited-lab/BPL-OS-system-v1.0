-- Poki's own letting-offer terms.
--
-- Until now companies.invoice_footer for PKI was empty, so every letting
-- offer printed with a blank Terms block. That was deliberate — the group's
-- template names Bamboo Products Limited and describes a sale of goods
-- ("Goods and services remain the property of Bamboo Products Limited until
-- paid in full"), neither of which is true of a tenancy, and a blank block
-- beats a confidently wrong one on a document going to a prospect.
--
-- These cover the stage BEFORE a tenancy exists. They deliberately do not
-- repeat the rent, utility, repair or termination clauses: those belong in
-- the tenancy agreement, which governs once signed. pokiEstimates.service.js
-- reads this column as the default for a new offer, and the caller can still
-- override it per offer.
--
-- NOT reviewed by a lawyer. Clauses 3 and 5 touch on advance rent and
-- deposit handling, where Ghana's Rent Act (Act 220) sets the statutory
-- position; clause 3 in particular means twelve months in advance on an
-- annual tenancy, which needs checking for residential units.
UPDATE companies
   SET invoice_footer = '1. This is an offer of a tenancy, not a tenancy. No tenancy arises, and no right to occupy is granted, until a written tenancy agreement has been signed by both parties and the sums set out in this offer have been received in cleared funds.

2. This offer stands until the "valid until" date shown above. After that date it lapses automatically and the unit may be offered to another applicant. Poki Properties may withdraw this offer at any time before a tenancy agreement is signed.

3. The security deposit and the first billing period''s rent are payable in full, in cleared funds, before keys are handed over. The billing period is the one shown above — a month on a monthly tenancy, a year on an annual one.

4. This offer is subject to satisfactory identification. Each individual tenant must produce a valid Ghana Card or passport before a tenancy agreement is signed. Where the tenant is a company, the director giving the guarantee under clause 8 must do the same.

5. The security deposit is held against unpaid rent, unpaid utility charges, and damage beyond fair wear and tear. It is not rent and may not be used by the tenant in place of a rent payment. It is refunded within 14 days of the end of the tenancy, after the outgoing inspection, less any sums properly deducted under this clause.

6. Utilities are charged as described in the notes above. Where a unit is sub-metered, charges follow actual recorded usage; where a share of a building bill applies, the share stated for that unit applies.

7. The unit is offered in its present condition. A condition inventory will be prepared and signed by both parties at handover, and forms the reference point for the end-of-tenancy inspection.

8. Where this offer is made to a company, the company remains liable for the obligations of the tenancy, and a named director of that company guarantees those obligations personally. The guarantee is given in the tenancy agreement and continues for as long as any sum under the tenancy remains unpaid.

9. Any variation of this offer is valid only if confirmed in writing by Poki Properties.

10. This offer, and any tenancy following from it, is governed by the laws of the Republic of Ghana.'
 WHERE code = 'PKI';
