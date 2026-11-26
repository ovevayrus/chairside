ALTER TABLE bookings ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'moved', 'cancelled'));
ALTER TABLE bookings ADD COLUMN service_id TEXT;
ALTER TABLE bookings ADD COLUMN replaced_booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN cleanup_pending INTEGER NOT NULL DEFAULT 0
  CHECK (cleanup_pending IN (0, 1));
ALTER TABLE bookings ADD COLUMN pending_action_id TEXT REFERENCES actions(id) ON DELETE SET NULL;

UPDATE bookings SET service_id=(
  SELECT service_id FROM requests WHERE id=bookings.request_id
);

CREATE UNIQUE INDEX bookings_one_replacement
  ON bookings(replaced_booking_id) WHERE replaced_booking_id IS NOT NULL;
CREATE INDEX bookings_upcoming
  ON bookings(shop_id, slot_start_utc) WHERE status='active' AND reply_status='sent';

ALTER TABLE requests ADD COLUMN booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL;
ALTER TABLE offers ADD COLUMN booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL;
