-- Each restaurant's own message inbox, in its Guest CRM
-- (services/restaurantInbox.service.js): guests' WhatsApp messages to the
-- restaurant's number, and Messenger and Instagram direct messages to its
-- Page and account (connected on the Social tracker). Kept apart from the
-- sales CRM's crm_conversations: these are guests, not sales leads, and
-- restaurant staff answer them.

-- A restaurant's WhatsApp number, connected with Meta's Embedded Signup as
-- Bamboo Products' is (whatsapp_connection). Messages are told apart by the
-- number they were sent to (phone_number_id).
CREATE TABLE company_whatsapp (
  company_id            uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  waba_id               text NOT NULL,
  phone_number_id       text NOT NULL UNIQUE,
  display_phone         text NOT NULL DEFAULT '',
  verified_name         text NOT NULL DEFAULT '',
  access_token          text NOT NULL,
  coexistence           boolean NOT NULL DEFAULT false,
  connected_by          uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  connected_at          timestamptz NOT NULL DEFAULT now(),
  history_requested_at  timestamptz NULL,
  contacts_requested_at timestamptz NULL,
  last_error            text NULL
);

-- One chat with one guest on one channel.
CREATE TABLE restaurant_conversations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  channel             text NOT NULL CHECK (channel IN ('whatsapp', 'facebook', 'instagram')),
  external_thread_id  text NOT NULL,                 -- the number, or Meta's conversation id
  contact_key         text NOT NULL DEFAULT '',      -- the number (233…) or the person's Messenger/Instagram id
  contact_name        text NOT NULL DEFAULT '',
  contact_handle      text NOT NULL DEFAULT '',      -- +233 24 …, or @username
  guest_id            uuid NULL REFERENCES restaurant_guests(id) ON DELETE SET NULL,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  unread              integer NOT NULL DEFAULT 0,
  message_count       integer NOT NULL DEFAULT 0,
  last_message_at     timestamptz NULL,
  last_direction      text NULL CHECK (last_direction IN ('in', 'out')),
  last_preview        text NOT NULL DEFAULT '',
  imported            boolean NOT NULL DEFAULT false,  -- past chats brought in when the number was connected
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, channel, external_thread_id)
);
CREATE INDEX idx_restaurant_conversations_list ON restaurant_conversations (company_id, last_message_at DESC);
CREATE INDEX idx_restaurant_conversations_guest ON restaurant_conversations (guest_id);

CREATE TABLE restaurant_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES restaurant_conversations(id) ON DELETE CASCADE,
  external_id      text NULL,
  direction        text NOT NULL CHECK (direction IN ('in', 'out')),
  author_name      text NOT NULL DEFAULT '',
  body             text NOT NULL DEFAULT '',
  attachments      jsonb NOT NULL DEFAULT '[]',
  sent_at          timestamptz NOT NULL,
  sent_by          uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_restaurant_messages_external ON restaurant_messages (conversation_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX idx_restaurant_messages_conversation ON restaurant_messages (conversation_id, sent_at);

-- A guest can now first come from a message.
ALTER TABLE restaurant_guests DROP CONSTRAINT restaurant_guests_source_check;
ALTER TABLE restaurant_guests ADD CONSTRAINT restaurant_guests_source_check CHECK (source IN ('manual', 'till', 'order', 'import', 'square', 'message'));
