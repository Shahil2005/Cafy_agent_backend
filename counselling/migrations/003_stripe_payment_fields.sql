-- Career counselling: Stripe one-time payment tracking on mentor_bookings.
-- Run in Resume Supabase SQL editor.

ALTER TABLE mentor_bookings ADD COLUMN IF NOT EXISTS stripe_checkout_session_id text;
ALTER TABLE mentor_bookings ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text;
ALTER TABLE mentor_bookings ADD COLUMN IF NOT EXISTS paid_at timestamptz;

CREATE INDEX IF NOT EXISTS mentor_bookings_stripe_checkout_session
ON mentor_bookings (stripe_checkout_session_id)
WHERE stripe_checkout_session_id IS NOT NULL;
