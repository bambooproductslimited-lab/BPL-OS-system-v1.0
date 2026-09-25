UPDATE settings SET commercial = commercial #- '{numbering,salesOrder}' WHERE id = 1;
ALTER TABLE sales_orders DROP COLUMN notes;
ALTER TABLE sales_orders DROP COLUMN delivered_at;
ALTER TABLE sales_orders DROP COLUMN promised_date;
