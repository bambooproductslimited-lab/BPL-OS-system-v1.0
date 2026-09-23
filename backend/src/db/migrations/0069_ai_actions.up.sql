-- Things the AI Assistant has offered to do, waiting for the person to press
-- Confirm (see src/ai/actions.js).
--
-- Claude never changes anything on its own from the Assistant screen. When
-- asked to create a task, request leave, add a customer and so on, it
-- prepares the change: the tool checks the request and describes it, and the
-- description and the checked values are stored here as 'pending'. The
-- change is made only when the same signed-in person presses Confirm on the
-- card the screen shows, within 30 minutes. Cancel, or no answer, and
-- nothing happens.
--
-- The row is also the record of what was done on whose behalf: the tool, the
-- exact values used, when it was decided and what came of it.
CREATE TABLE ai_actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool        text NOT NULL,
  summary     text NOT NULL,
  payload     jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'done', 'cancelled', 'failed', 'expired')),
  result      text NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz NULL
);

CREATE INDEX idx_ai_actions_user ON ai_actions (user_id, created_at DESC);
