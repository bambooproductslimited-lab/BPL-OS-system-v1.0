DELETE FROM role_permissions WHERE permission_key IN ('onboard.manage', 'safety.manage', 'returns.manage', 'visitor.manage', 'gatepass.approve');
DELETE FROM permissions WHERE key IN ('onboard.manage', 'safety.manage', 'returns.manage', 'visitor.manage', 'gatepass.approve');
DROP TABLE IF EXISTS gate_passes;
DROP TABLE IF EXISTS visitors;
ALTER TABLE settings DROP COLUMN IF EXISTS depreciation;
ALTER TABLE assets
  DROP COLUMN IF EXISTS disposed_by,
  DROP COLUMN IF EXISTS disposal_note,
  DROP COLUMN IF EXISTS disposal_amount,
  DROP COLUMN IF EXISTS disposal_kind,
  DROP COLUMN IF EXISTS disposed_on,
  DROP COLUMN IF EXISTS depreciation_from,
  DROP COLUMN IF EXISTS residual_value,
  DROP COLUMN IF EXISTS reducing_rate,
  DROP COLUMN IF EXISTS useful_life_months,
  DROP COLUMN IF EXISTS depreciation_method;
DROP TABLE IF EXISTS tax_returns;
DROP TABLE IF EXISTS incident_actions;
DROP TABLE IF EXISTS incidents;
DROP TABLE IF EXISTS onboard_steps;
DROP TABLE IF EXISTS onboard_lists;
DROP TABLE IF EXISTS onboard_templates;
