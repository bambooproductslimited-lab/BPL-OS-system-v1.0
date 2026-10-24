-- Where a site visit is, on the map (crmRoute.service.js): the rep's pin,
-- where their phone was when they pressed "I'm here", or Google's reading
-- of the visit's location when it planned the day's route. Without one,
-- the visit is listed but not on the map until someone places it.
ALTER TABLE crm_site_visits
  ADD COLUMN lat       double precision NULL,
  ADD COLUMN lng       double precision NULL,
  ADD COLUMN placed_by text NULL CHECK (placed_by IN ('pin', 'here', 'address'));
