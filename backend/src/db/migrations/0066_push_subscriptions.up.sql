-- Web Push: the per-device subscriptions notifications are delivered to,
-- and the server's own signing keypair.
--
-- A subscription belongs to a DEVICE, not to a person: the browser issues
-- one endpoint per browser profile, and the same employee signing in on a
-- phone, an office desktop and the shop-floor iPad has three of them.
-- employee_id is who to deliver to; endpoint is the identity of the device.
CREATE TABLE push_subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  endpoint     text NOT NULL UNIQUE,
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  user_agent   text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz NULL
);

-- Delivery always looks up by employee.
CREATE INDEX idx_push_subscriptions_employee ON push_subscriptions(employee_id);

-- The VAPID keypair that identifies this server to Google's, Mozilla's and
-- Apple's push services. It has to stay the same forever: every
-- subscription a device has already handed us is bound to the public key
-- that was in force when it subscribed, so regenerating these silently
-- breaks every existing device until it re-subscribes.
--
-- Kept in the database rather than in an environment variable so that
-- turning this on takes no manual step and no secret has to be copied
-- between systems — the server generates the pair the first time it needs
-- one. VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY still override it if this
-- deployment would rather manage them itself (see push.service.js).
CREATE TABLE push_vapid_keys (
  id          smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  public_key  text NOT NULL,
  private_key text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
