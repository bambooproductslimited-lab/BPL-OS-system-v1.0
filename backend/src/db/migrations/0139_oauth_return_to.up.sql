-- Where the browser goes back to after a platform's sign-in window
-- (routes/oauth.routes.js): the OS address the person started from — the
-- OS can be open on more than one address (oseitutu.com, the Hostinger
-- one) and only the one they are signed in on can finish the connection.
ALTER TABLE marketing_oauth_states ADD COLUMN IF NOT EXISTS return_to text;
