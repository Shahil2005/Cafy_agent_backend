-- Extend mentor_bookings.status to support reserve → confirm flow.
-- Run in Resume Supabase SQL editor if you already applied 001 before this was added.
-- (Fresh installs: 001 now includes this — you do not need 002.)

ALTER TABLE mentor_bookings DROP CONSTRAINT IF EXISTS mentor_bookings_status_check;

ALTER TABLE mentor_bookings ADD CONSTRAINT mentor_bookings_status_check
  CHECK (status IN ('pending', 'reserved', 'confirmed', 'cancelled', 'expired', 'failed'));
