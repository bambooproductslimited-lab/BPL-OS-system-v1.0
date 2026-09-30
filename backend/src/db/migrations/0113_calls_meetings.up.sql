-- Voice and video calls in chats, and scheduled meetings (messages.service
-- and calls.service). The audio and video travel through LiveKit, a calling
-- service; the OS keeps who called whom, when, and for how long, and hands
-- each person a short-lived pass to the call's room.
--
-- A call belongs to a chat (one-to-one or group). A meeting is a call booked
-- ahead in a chat, with a time, a title and, when wanted, a link for guests
-- outside the company (clients, suppliers) that works without an account.
CREATE TABLE meetings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  title           text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('voice', 'video')),
  starts_at       timestamptz NOT NULL,
  duration_min    integer NOT NULL DEFAULT 30 CHECK (duration_min BETWEEN 5 AND 480),
  note            text NOT NULL DEFAULT '',
  created_by      uuid REFERENCES employees(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  guest_token     text UNIQUE,
  cancelled_at    timestamptz,
  reminded_at     timestamptz
);
CREATE INDEX idx_meetings_conversation ON meetings (conversation_id, starts_at);
CREATE INDEX idx_meetings_upcoming ON meetings (starts_at) WHERE cancelled_at IS NULL;

CREATE TABLE calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  meeting_id      uuid REFERENCES meetings(id) ON DELETE SET NULL,
  kind            text NOT NULL CHECK (kind IN ('voice', 'video')),
  room            text NOT NULL UNIQUE,
  started_by      uuid REFERENCES employees(id) ON DELETE SET NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz
);
-- One call running per chat at a time.
CREATE UNIQUE INDEX idx_calls_one_live ON calls (conversation_id) WHERE ended_at IS NULL;

CREATE TABLE call_participants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id     uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  employee_id uuid REFERENCES employees(id) ON DELETE CASCADE,
  guest_name  text,
  joined_at   timestamptz NOT NULL DEFAULT now(),
  seen_at     timestamptz NOT NULL DEFAULT now(),
  left_at     timestamptz,
  declined    boolean NOT NULL DEFAULT false,
  CHECK ((employee_id IS NULL) <> (guest_name IS NULL))
);
CREATE INDEX idx_call_participants_call ON call_participants (call_id);
CREATE INDEX idx_call_participants_employee ON call_participants (employee_id);
