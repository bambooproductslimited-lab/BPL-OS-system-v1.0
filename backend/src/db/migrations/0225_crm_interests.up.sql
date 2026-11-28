-- What a customer is interested in or asked about, read from their chats
-- (crmInterests.service.js): on their profile, and on every lead on it.
-- One row per customer profile, read again when they write something new.
CREATE TABLE crm_interests (
  customer_id    uuid PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  summary        text NOT NULL DEFAULT '',
  interests      jsonb NOT NULL DEFAULT '[]',   -- [{ item, productId, productName, quantity, details }]
  questions      jsonb NOT NULL DEFAULT '[]',   -- [{ topic, text }]
  intent         text NOT NULL DEFAULT '',      -- ready_to_buy, interested, just_asking, after_sale, not_a_customer, unclear
  next_step      text NOT NULL DEFAULT '',
  source         text NOT NULL DEFAULT 'rules' CHECK (source IN ('ai', 'rules')),
  model          text NOT NULL DEFAULT '',
  messages_read  integer NOT NULL DEFAULT 0,
  read_up_to     timestamptz NULL,              -- the newest message read
  analysed_at    timestamptz NOT NULL DEFAULT now(),
  error          text NOT NULL DEFAULT ''
);
