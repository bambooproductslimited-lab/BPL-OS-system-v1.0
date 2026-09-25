-- AI Assistant conversations (services/ai.service.js). The chat used to live
-- only in the browser tab, lost on leaving the page. Now each conversation
-- is kept for the person who had it — no one else can open it — so they can
-- come back to it, carry on, or delete it. Each message keeps the ids of the
-- changes the assistant prepared with it (ai_actions), so their Confirm /
-- Cancel cards come back with the current status.
CREATE TABLE ai_conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_conversations_user ON ai_conversations (user_id, updated_at DESC);

CREATE TABLE ai_messages (
  id               bigserial PRIMARY KEY,   -- also the order within a conversation
  conversation_id  uuid NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('user', 'assistant')),
  text             text NOT NULL,
  action_ids       uuid[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_messages_conversation ON ai_messages (conversation_id, id);

ALTER TABLE ai_actions ADD COLUMN conversation_id uuid NULL REFERENCES ai_conversations(id) ON DELETE SET NULL;
