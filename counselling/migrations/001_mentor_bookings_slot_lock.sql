-- Career counselling: prevent two active bookings for the same mentor + slot.
-- Run in Resume Supabase SQL editor (guudgjvrxljuoyieifyt).
--
-- Already ran an older 001 (before status CHECK was added)? Skip this file — run
-- 002_mentor_bookings_status_check.sql only.

-- Optional columns for reserve → confirm flow (safe if already present)
ALTER TABLE mentor_bookings ADD COLUMN IF NOT EXISTS reservation_expires_at timestamptz;
ALTER TABLE mentor_bookings ADD COLUMN IF NOT EXISTS slot_starts_at timestamptz;
ALTER TABLE mentor_bookings ADD COLUMN IF NOT EXISTS slot_ends_at timestamptz;
ALTER TABLE mentor_bookings ADD COLUMN IF NOT EXISTS duration_minutes int;
ALTER TABLE mentor_bookings ADD COLUMN IF NOT EXISTS cal_booking_uid text;
ALTER TABLE mentor_bookings ADD COLUMN IF NOT EXISTS meeting_url text;
ALTER TABLE mentor_bookings ADD COLUMN IF NOT EXISTS price_tier text;
ALTER TABLE mentor_bookings ADD COLUMN IF NOT EXISTS amount_pence int;

ALTER TABLE mentor_bookings DROP CONSTRAINT IF EXISTS mentor_bookings_status_check;

ALTER TABLE mentor_bookings ADD CONSTRAINT mentor_bookings_status_check
  CHECK (status IN ('pending', 'reserved', 'confirmed', 'cancelled', 'expired', 'failed'));

CREATE UNIQUE INDEX IF NOT EXISTS mentor_bookings_one_active_slot
ON mentor_bookings (mentor_id, slot_starts_at)
WHERE status IN ('reserved', 'confirmed');

CREATE INDEX IF NOT EXISTS mentor_bookings_mentor_slot_status
ON mentor_bookings (mentor_id, status, slot_starts_at);
