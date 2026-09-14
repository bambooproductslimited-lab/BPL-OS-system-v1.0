-- A one-time, expiring link HR can send an employee so they enroll their
-- own kiosk face match from their own phone, instead of an HR staffer
-- doing the camera walk on the employee's behalf. Unlike document_shares'
-- expires_at (nullable — "Never"), this one is NOT NULL: a leaked link
-- otherwise lets whoever holds it enroll THEIR OWN face against someone
-- else's clock-in identity, so every link both expires and is deleted the
-- moment it's used (see kiosk.service.js's enrollFaceViaLink) rather than
-- staying valid indefinitely or being reusable.
CREATE TABLE face_enroll_links (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token        text NOT NULL UNIQUE,
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  created_by   uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_face_enroll_links_employee ON face_enroll_links(employee_id);
