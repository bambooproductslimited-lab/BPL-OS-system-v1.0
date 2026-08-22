-- Meta (Facebook + Instagram) OAuth support. Reuses marketing_oauth_states
-- (channel_key='meta') and marketing_oauth_tokens (one row each for
-- channel_key='facebook' and 'instagram', both authenticated with the same
-- Facebook Page access token — Instagram Graph API calls are made against
-- that token scoped to the Page's linked Instagram Business account, there
-- is no separate "Instagram token").
--
-- Unlike TikTok's single-account flow, the Meta user who logs in may admin
-- more than one Facebook Page, so the callback can't finalize a connection
-- immediately — it has to let the user pick which Page first. This table
-- holds the exchanged long-lived user access token for that short window
-- between callback and the page-picker's "connect" call; rows are deleted
-- on pickup (one-time use, same reasoning as marketing_oauth_states) or
-- left to age out (read queries only accept rows under 15 minutes old, so
-- an abandoned pending row is simply inert, not a live credential).
CREATE TABLE marketing_oauth_pending (
  token             text PRIMARY KEY,
  channel_key       text NOT NULL,
  user_access_token text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
