-- Sales orders (salesOrders.service.js): the date promised to the client,
-- when it was delivered, notes, and a proper number sequence (numbers used
-- to be worked out by counting orders, which two people creating orders at
-- once could duplicate). New numbers look like SO-2026-0001, so they can't
-- clash with the older SO-1401 style.
ALTER TABLE sales_orders ADD COLUMN promised_date date NULL;
ALTER TABLE sales_orders ADD COLUMN delivered_at timestamptz NULL;
ALTER TABLE sales_orders ADD COLUMN notes text NOT NULL DEFAULT '';
UPDATE sales_orders SET delivered_at = created_at WHERE status = 'delivered';

UPDATE settings
SET commercial = jsonb_set(
      commercial,
      '{numbering,salesOrder}',
      '{"prefix": "SO", "padding": 4, "includeYear": true, "nextNumber": 1}'::jsonb,
      true
    )
WHERE id = 1 AND NOT (commercial -> 'numbering' ? 'salesOrder');
