-- The connector that lets claude.ai and the Claude apps reach Bamboo OS
-- (src/mcp/). Claude signs in the way any OAuth app does: it registers
-- itself (mcp_oauth_clients), sends the person to the OS's own sign-in and
-- approval page, gets a one-time code for them (mcp_oauth_codes) and trades
-- it for tokens (mcp_oauth_tokens). Every token belongs to one OS user, and
-- every tool call with it runs with that user's permissions, exactly like
-- the AI Assistant screen.
--
-- Codes and tokens are stored only as SHA-256 hashes: a copy of this table
-- is not a way in.
CREATE TABLE mcp_oauth_clients (
  client_id   text PRIMARY KEY,
  info        jsonb NOT NULL,           -- the registration, as the OAuth library keeps it
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mcp_oauth_codes (
  code_hash       text PRIMARY KEY,
  client_id       text NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_challenge  text NOT NULL,
  redirect_uri    text NOT NULL,
  scopes          text[] NOT NULL DEFAULT '{}',
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz NULL
);

CREATE TABLE mcp_oauth_tokens (
  token_hash  text PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('access', 'refresh')),
  client_id   text NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes      text[] NOT NULL DEFAULT '{}',
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_mcp_oauth_tokens_user ON mcp_oauth_tokens (user_id) WHERE revoked_at IS NULL;

-- Changes made through the connector are recorded alongside the Assistant's.
ALTER TABLE ai_actions ADD COLUMN source text NOT NULL DEFAULT 'assistant' CHECK (source IN ('assistant', 'connector'));
