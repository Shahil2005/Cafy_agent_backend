# Career counselling — local dev (Cal.com + webhooks)

Use this while **Cal.com is not on production yet**. Nothing here changes your live Vercel app until you deploy code and add a production webhook URL.

## Recommended setup (no live impact)

| Environment | Cal.com webhook URL | Notes |
|-------------|---------------------|--------|
| **Local** | `https://YOUR-NGROK.ngrok-free.app/api/counselling/webhook` | ngrok → `localhost:5000` |
| **Production (later)** | `https://api.cafy.careers/api/counselling/webhook` | Add as a **second** webhook in Cal.com |

Do **not** point your only Cal.com webhook at ngrok when production goes live — add a separate subscription for each environment.

## 1. Backend env (local `.env`)

```env
COUNSELLING_ENABLED=true
COUNSELLING_SHOW_TEST_MENTORS=true
# Payment off until Stripe is wired (default)
# COUNSELLING_REQUIRE_PAYMENT=false

# Stripe one-time prices (when COUNSELLING_REQUIRE_PAYMENT=true)
STRIPE_PRICE_COUNSELLING_30_STANDARD=price_...
STRIPE_PRICE_COUNSELLING_45_STANDARD=price_...
STRIPE_PRICE_COUNSELLING_60_STANDARD=price_...
STRIPE_PRICE_COUNSELLING_30_PREMIUM=price_...
STRIPE_PRICE_COUNSELLING_45_PREMIUM=price_...
STRIPE_PRICE_COUNSELLING_60_PREMIUM=price_...

CALCOM_API_KEY=cal_...
CALCOM_API_URL=https://api.cal.com/v2
CALCOM_WEBHOOK_SECRET=choose-a-long-random-string

CALCOM_MIN_NOTICE_MINUTES=60
CALCOM_BOOKING_WINDOW_DAYS=10
CALCOM_SLOT_HOLD_MINUTES=10
```

Use **test mentors** (`is_test=true`) so dev bookings do not block real counsellor calendars.

## 2. Supabase migration (once)

Run `001_mentor_bookings_slot_lock.sql`, **`002_mentor_bookings_status_check.sql`**, and **`003_stripe_payment_fields.sql`** in the **Resume** Supabase SQL editor.

## 3. Start backend

```bash
cd ProductBackend
npm run dev
```

Server listens on **https://api.cafy.careers**.

## 4. Expose localhost (ngrok)

In a **second terminal**:

```bash
ngrok http 5000
```

Copy the **https** URL, e.g. `https://abc123.ngrok-free.app`.

## 5. Cal.com webhook (one subscription for local)

1. [Cal.com](https://app.cal.com) → **Settings** → **Developer** → **Webhooks**
2. **Subscriber URL:** `https://abc123.ngrok-free.app/api/counselling/webhook`
3. **Events:** `BOOKING_CREATED`, `BOOKING_RESCHEDULED`, `BOOKING_CANCELLED`
4. **Secret:** same value as `CALCOM_WEBHOOK_SECRET` in `.env`
5. Save

## 6. Test booking flow

1. Career Counselling → pick a test mentor → choose duration.
2. Pick a slot → app calls **`POST /api/counselling/reserve`** (Redis hold + DB row `status=reserved`).
3. Confirm screen shows a countdown (`CALCOM_SLOT_HOLD_MINUTES`).
4. Submit → **`POST /api/counselling/confirm`** creates the Cal.com booking and sets `status=confirmed`.
   When `COUNSELLING_REQUIRE_PAYMENT=true`, confirm runs via **Stripe webhook** or **`POST /api/counselling/confirm-payment`** on the success redirect (`session_id` in URL).
5. Back / close / expiry → **`POST /api/counselling/reserve/cancel`** releases the hold.

Legacy one-shot **`POST /api/counselling/book`** still works (reserve + confirm internally).

Watch ProductBackend logs for `[counselling webhook]` when rescheduling or cancelling in Cal.com.

Optional: ngrok inspector at http://127.0.0.1:4040

## API summary

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/counselling/public-config` | Feature flag + payment status (no auth) |
| GET | `/api/counselling/config` | Prices, hold duration, payment flags |
| GET | `/api/counselling/availability` | Cal.com slots minus holds + DB reservations |
| POST | `/api/counselling/reserve` | Hold slot when user picks a time |
| POST | `/api/counselling/checkout` | Stripe Checkout for a reservation (when payment required) |
| POST | `/api/counselling/confirm-payment` | Sync paid Stripe session → Cal.com book (return URL fallback) |
| POST | `/api/counselling/confirm` | Cal.com book + confirm (skip-payment / internal only) |
| POST | `/api/counselling/reserve/cancel` | Release hold when user backs out |
| POST | `/api/counselling/book` | Legacy one-shot |
| GET | `/api/counselling/bookings` | User's sessions |
| POST | `/api/counselling/webhook` | Cal.com events (raw body, HMAC) |

## What the webhook does

| Event | Cafy action |
|-------|-------------|
| `BOOKING_CREATED` | No-op if row already exists (app already saved on confirm) |
| `BOOKING_RESCHEDULED` | Updates `slot_starts_at`, `meeting_url`, `cal_booking_uid` |
| `BOOKING_CANCELLED` | Sets `status=cancelled` |

Matches rows by `cal_booking_uid` in Supabase `mentor_bookings`.

## When you go live later

1. Deploy backend with this webhook route and reserve/confirm/checkout APIs.
2. Run the Supabase migrations if not already applied (including `003_stripe_payment_fields.sql`).
3. On production set `CALCOM_WEBHOOK_SECRET` and add Cal.com webhook: `https://api.cafy.careers/api/counselling/webhook`.
4. Set `COUNSELLING_REQUIRE_PAYMENT=true` and configure `STRIPE_PRICE_COUNSELLING_*` env vars.
5. Unset `COUNSELLING_SHOW_TEST_MENTORS` on production.
6. Ensure Redis is available in production (`COUNSELLING_REQUIRE_REDIS` defaults to required in prod).
7. Stripe `checkout.session.completed` on `/api/billing/webhook` confirms counselling bookings (metadata `type=counselling`).

## Stripe comparison

```bash
# Stripe (billing + counselling checkout)
stripe listen --forward-to https://api.cafy.careers/api/billing/webhook
```

## Troubleshooting

| Issue | Fix |
|-------|-----|
| 401 Invalid signature | `CALCOM_WEBHOOK_SECRET` must match Cal.com webhook secret |
| 404 | Backend running? URL ends with `/api/counselling/webhook`? |
| No events | ngrok running? Correct Cal.com account? |
| Reschedule not updating | Row must have `cal_booking_uid` from confirm |
| Slot held by another user | Wait for hold to expire or pick another slot |
| BOOKING_LOCK_UNAVAILABLE | Redis down in prod — fix Redis or set `COUNSELLING_REQUIRE_REDIS=false` locally only |
| duplicate key / 409 | Migration not applied — run `001_mentor_bookings_slot_lock.sql` |
