UPDATE settings
SET commercial = jsonb_set(
  commercial,
  '{currencies}',
  (SELECT jsonb_agg(c) FROM jsonb_array_elements(commercial->'currencies') c WHERE c <> '"CNY"')
)
WHERE id = 1
  AND commercial->'currencies' @> '["CNY"]'::jsonb;
