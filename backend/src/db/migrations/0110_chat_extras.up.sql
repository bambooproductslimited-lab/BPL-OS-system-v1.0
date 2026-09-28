-- Chats grow up again (messages.service.js): reply to a message, edit or
-- delete your own, forward, pin, @mention, react with an emoji, and share
-- an OS record (a task, invoice, quotation, client, lead or leave request)
-- as a card. record is a snapshot taken when it was shared ({type, id,
-- title, sub}); opening it goes through that page's own permissions.
-- conversations.updated_at moves on any change, so an open chat only
-- reloads when something happened; typing_at and employees.last_seen_at
-- drive "typing…" and "online".
ALTER TABLE messages
  ADD COLUMN reply_to   uuid NULL REFERENCES messages(id) ON DELETE SET NULL,
  ADD COLUMN edited_at  timestamptz NULL,
  ADD COLUMN deleted_at timestamptz NULL,
  ADD COLUMN forwarded  boolean NOT NULL DEFAULT false,
  ADD COLUMN pinned_at  timestamptz NULL,
  ADD COLUMN pinned_by  uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  ADD COLUMN record     jsonb NULL,
  ADD COLUMN mentions   uuid[] NOT NULL DEFAULT '{}';
CREATE INDEX idx_messages_pinned ON messages (conversation_id) WHERE pinned_at IS NOT NULL;

CREATE TABLE message_reactions (
  message_id  uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  emoji       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, employee_id)
);

ALTER TABLE conversations ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE conversation_members ADD COLUMN typing_at timestamptz NULL;
ALTER TABLE employees ADD COLUMN last_seen_at timestamptz NULL;
