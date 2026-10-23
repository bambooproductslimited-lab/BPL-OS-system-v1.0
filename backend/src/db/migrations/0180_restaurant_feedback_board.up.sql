-- Guests' feedback from their receipt (restaurantFeedback.service.js): how
-- it was (1 to 5), what was good or not, the dishes, a comment; an unhappy
-- one waits for a manager to follow it up privately.
CREATE TABLE restaurant_feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id    uuid NOT NULL UNIQUE REFERENCES restaurant_orders(id) ON DELETE CASCADE,
  guest_id    uuid NULL REFERENCES restaurant_guests(id) ON DELETE SET NULL,
  rating      smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  tags        text[] NOT NULL DEFAULT '{}',
  dishes      jsonb NOT NULL DEFAULT '[]',
  comment     text NOT NULL DEFAULT '',
  contact_ok  boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'seen', 'resolved')),
  reply       text NOT NULL DEFAULT '',
  resolved_by uuid NULL REFERENCES employees(id) ON DELETE SET NULL,
  resolved_at timestamptz NULL,
  ip          text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_restaurant_feedback_company ON restaurant_feedback (company_id, created_at DESC);

-- The ready-for-pickup board: a screen facing the customers, paired with
-- the till like the customer screen and the kiosk (restaurantDisplays).
ALTER TABLE restaurant_displays DROP CONSTRAINT restaurant_displays_kind_check;
ALTER TABLE restaurant_displays ADD CONSTRAINT restaurant_displays_kind_check CHECK (kind IN ('screen', 'kiosk', 'board'));
