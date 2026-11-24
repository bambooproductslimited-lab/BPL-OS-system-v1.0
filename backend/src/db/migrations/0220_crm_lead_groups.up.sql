-- Groups of leads (services/crmLeadGroups.service.js): the people met at a
-- fair or an event (GEXPO 2026), a business list, a campaign. A lead can be
-- in several groups; a group shows how far its people have got — contacted,
-- prospects, customers — so an event's follow-up can be seen and finished.
-- Contacts are added to a group by hand, from the leads already in the OS,
-- or from a file (a spreadsheet, a phone's contacts, a pasted list).
CREATE TABLE crm_lead_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (name <> ''),
  kind        text NOT NULL DEFAULT 'event' CHECK (kind IN ('event', 'list', 'campaign', 'other')),
  held_on     date NULL,                          -- when the event was (its first day)
  place       text NOT NULL DEFAULT '',
  notes       text NOT NULL DEFAULT '',
  created_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX crm_lead_groups_name ON crm_lead_groups (lower(name));

CREATE TABLE crm_lead_group_members (
  group_id  uuid NOT NULL REFERENCES crm_lead_groups(id) ON DELETE CASCADE,
  lead_id   uuid NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  added_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, lead_id)
);
CREATE INDEX idx_crm_lead_group_members_lead ON crm_lead_group_members (lead_id);

-- The fair and event lists already imported (crm_prospects, made leads in
-- migration 0132) become groups of their leads.
INSERT INTO crm_lead_groups (name, kind, created_at)
SELECT min(btrim(p.list_name)), 'event', min(p.created_at)
FROM crm_prospects p
WHERE btrim(p.list_name) <> '' AND EXISTS (SELECT 1 FROM crm_leads l WHERE l.prospect_id = p.id)
GROUP BY lower(btrim(p.list_name));
INSERT INTO crm_lead_group_members (group_id, lead_id, added_at)
SELECT g.id, l.id, l.created_at
FROM crm_leads l JOIN crm_prospects p ON p.id = l.prospect_id
JOIN crm_lead_groups g ON lower(g.name) = lower(btrim(p.list_name))
ON CONFLICT DO NOTHING;
