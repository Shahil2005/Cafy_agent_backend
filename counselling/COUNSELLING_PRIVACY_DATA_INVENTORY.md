# Career Counselling — Privacy Data Inventory

**Purpose:** Field-level inventory of personal data collected, stored, and shared in the Career Counselling booking flow, for drafting / updating the Cafy Privacy Policy.

**Scope:** `ProductBackend/counselling/`, Product-Site counselling UI, mentor APIs, Stripe checkout, Cal.com client, webhooks, Redis, Firestore.

**Related policy files:**
- `Product-Site/src/constants/privacyPolicyContent.ts`
- `CompanySite/src/pages/Privacy.tsx`
- `Product-Site/src/constants/termsOfServiceContent.ts`

**Current gap:** Policy §5.2 only says name, email, and notes are shared with the mentor. It does **not** name Cal.com / Cal.eu, Redis holds, Stripe booking metadata, meeting URLs, or retention of cancelled booking rows.

---

## 1. Data collected from the user (booker)

| Data | Source | Required? | Where it goes |
|------|--------|-----------|---------------|
| Firebase user id (`uid`) | Auth session | **Yes** | `mentor_bookings.user_id`; Stripe `client_reference_id` + metadata `firebaseUid`; Redis hold value |
| Email address | Firebase auth token | **Yes** (must be verified) | `mentor_bookings.user_email`; Cal.com `attendee.email`; Stripe Customer email |
| Email verified flag | Firebase token | Must be `true` | Gate only — not stored on booking row |
| Display name (first + last) | Firestore `users/{uid}` | No — fallback: email local-part → `"Cafy User"` | Cal.com `attendee.name` only |
| Mentor chosen (`mentorId`) | Booking UI | **Yes** | `mentor_bookings.mentor_id` (+ denormalized `mentor_name`) |
| Duration (30 / 45 / 60 min) | Booking UI | **Yes** | `mentor_bookings.duration_minutes`; Cal event type |
| Chosen slot start time | Booking UI (from Cal availability) | **Yes** | `mentor_bookings.slot_starts_at` / `slot_ends_at`; Cal.com `start` |
| Session goal / notes | Confirm / checkout textarea | **No** — max 2000 chars (500 in Stripe metadata) | `mentor_bookings.goal`; Cal.com notes + `metadata.cafyGoal`; Stripe `metadata.goal` |
| Attendee timezone | Browser `Intl` timezone | **No** — max 64 chars | Cal.com `attendee.timeZone`; Stripe `metadata.attendeeTimeZone` |
| Price tier + amount | Derived from subscription | System-set | `mentor_bookings.price_tier`, `amount_pence` |
| Stripe Checkout / PaymentIntent ids | Stripe (after pay) | If payment on | `mentor_bookings.stripe_*`; `paid_at`; `payment_released` |
| Card number / CVC | Stripe Checkout (hosted) | If payment on | **Never stored by Cafy** — Stripe only (PCI) |
| IP address | Rate limiter (unauthenticated key) | Indirect | Redis `rl:counselling:{ip}` — 60s window; not a counselling DB field |

### Auth gates

- Backend: `assertVerifiedBooker` requires email and `emailVerified !== false` (`counselling/service.ts`).
- Frontend: `ProtectedRoute` requires verified email for `/career-counselling`.

### API / UI field sources

- Schemas: `ProductBackend/counselling/schema.ts`
- UI: `Product-Site/src/components/counselling/BookingModal.tsx`
- Client API: `Product-Site/src/services/counsellingService.ts`

### Returned to the client after booking

Public mapping includes: `id`, `mentorId`, `mentorName`, `status`, `slotStartsAt`, `slotEndsAt`, `durationMinutes`, `meetingUrl`, `goal`, `bookedDay`, `bookedTime`, `createdAt`, `reservationExpiresAt`.

**Not** exposed in the public booking mapping: `user_email`, Stripe ids, `cal_booking_uid`.

---

## 2. Mentor / counsellor data

### Public (`GET /api/mentors`)

| Field | DB column | Displayed |
|-------|-----------|-----------|
| `id` | `id` | Yes |
| `slug` | `slug` | Yes |
| `name` | `name` | Yes |
| `quals` | `quals` | Yes |
| `title` | `title` | Yes |
| `org` | `org` | Yes |
| `domain` | `domain` | Yes |
| `exp` | `exp` | Yes |
| `linkedin` | `linkedin` | Yes (external link) |
| `photoUrl` | `photo_url` → public URL | Yes |
| `bookingAvailable` | Derived from Cal config | Yes when counselling enabled |

### Server-only (booking config — not in public mentor JSON)

- `cal_host` (`cal.com` \| `cal.eu`)
- `cal_username`
- `cal_event_slug_30` / `_45` / `_60`
- `cal_timezone` (default `Europe/London`)
- `booking_enabled`, `is_active`, `is_test`

### Photos

- Bucket: `MENTOR_PHOTOS_BUCKET` (default `mentor-photos`) on Resume Supabase
- Resolved via `ProductBackend/lib/mentorStorage.ts`

Policy already lists career mentors as data subjects; a separate counsellor agreement also applies.

---

## 3. Where data is stored

### Resume Supabase — `mentor_bookings`

| Column | Purpose |
|--------|---------|
| `id` | Booking / reservation id |
| `user_id` | Firebase uid |
| `user_email` | Booker email |
| `mentor_id`, `mentor_name` | Mentor reference + denormalized name |
| `status` | `pending` \| `reserved` \| `confirmed` \| `cancelled` \| `expired` \| `failed` |
| `slot_starts_at`, `slot_ends_at`, `duration_minutes` | Session timing |
| `reservation_expires_at` | Hold expiry |
| `cal_booking_uid` | Cal.com booking uid |
| `meeting_url` | Video meeting link |
| `goal` | Session focus notes |
| `booked_day`, `booked_time` | Legacy local display fields |
| `price_tier`, `amount_pence` | Pricing snapshot |
| `payment_released` | Payment gate |
| `stripe_checkout_session_id`, `stripe_payment_intent_id`, `paid_at` | Stripe payment trail |
| `created_at` | Timestamp |

### Resume Supabase — `mentors` + Storage

- Profile + Cal config columns (see §2)
- Public photo objects in `mentor-photos` (or configured bucket)

### Redis (Upstash)

| Key pattern | Value | TTL |
|-------------|-------|-----|
| `counselling:hold:{mentorId}:{slotISO}` | Firebase `userId` | Default `CALCOM_SLOT_HOLD_MINUTES` (10) × 60s; extended to ≥30 min for Stripe checkout |
| `rl:counselling:{uid\|ip}` | Rate-limit counter | 60s window |

### Firestore

| Path | Data |
|------|------|
| `users/{uid}` | Read `firstName` / `lastName` for attendee name; subscription / Stripe customer linkage |
| `counselling_webhook_events/{sha256}` | `{ trigger, processedAt }` — Cal webhook dedupe (no TTL in code) |

### In-memory (backend)

- Slots cache keyed by mentor/duration/dates — **45s TTL**, no user PII

### Stripe

- Customer: `email`, `metadata.firebaseUid`
- Checkout Session metadata and PaymentIntent id (see §4)

### Cal.com / Cal.eu

- Booking with attendee name/email/timezone, optional goal notes/metadata, meeting URL
- Host calendars / invites (Cal’s own email)

### Logs / Sentry

- Console: Cal API errors, webhook reconcile logs (booking ids, cal uids, organizer username)
- Sentry on errors: tags `feature: counselling`; extras may include `reservationId`, `checkoutSessionId`, `uid`, `calBookingUid`
- Auth middleware: `Sentry.setUser({ id: uid })`

---

## 4. Third-party sharing

### Cal.com — create booking payload

Sent by `ProductBackend/counselling/calcomClient.ts`:

```json
{
  "eventTypeSlug": "<duration event slug>",
  "username": "<mentor cal_username>",
  "start": "<UTC start>",
  "attendee": {
    "name": "<display name>",
    "email": "<user email>",
    "timeZone": "<attendee timezone>"
  },
  "metadata": { "cafyGoal": "<optional goal>" },
  "bookingFieldsResponses": { "notes": "<optional goal>" }
}
```

- API base: `https://api.cal.com/v2` or `https://api.cal.eu/v2` from mentor `cal_host`
- Slots GET: mentor calendar only (no student PII)
- Inbound webhooks may include: booking uid, times, location/video URL, organizer, attendees’ email/name, additional notes

### Stripe — Checkout Session create

From `ProductBackend/counselling/checkoutService.ts`:

- `mode: payment`
- `customer` (email + `metadata.firebaseUid`)
- `client_reference_id`: Firebase uid
- `success_url` / `cancel_url` with `session_id` query param on success
- `metadata`:
  - `type: counselling`
  - `firebaseUid`
  - `reservationId`
  - `goal` (≤500 chars)
  - `attendeeTimeZone` (≤64 chars)

**PCI:** Card data entered on Stripe-hosted Checkout; Cafy stores session/PaymentIntent ids only.

### Email

- No Cafy SMTP path in counselling code
- Cal.com sends the calendar invite (UI success copy reflects this)
- Mentors receive attendee details via Cal.com

### Analytics

- No counselling-specific trackers in this feature
- Site-wide GA4 / PostHog apply if enabled (covered by general privacy policy)

---

## 5. Data flow by step

| Step | Personal data in motion |
|------|-------------------------|
| **Browse mentors** | Public mentor profile (name, photo, LinkedIn, org, quals). No student PII required for list. |
| **Load availability** | Auth required. Backend queries Cal slots for mentor; Redis/DB filter holds. No goal yet. |
| **Reserve** | uid + verified email + slot + pricing → Redis hold + `mentor_bookings` (`status=reserved`). Cancels user’s other active reservations. |
| **Checkout** (if payment on) | Optional goal + timezone → DB + Stripe metadata; redirect to Stripe; hold extended ≥30 min. |
| **Confirm** (skip-payment) | Name + email + timezone + goal → Cal.com create; DB → `confirmed`, `cal_booking_uid`, `meeting_url`; Redis hold released. |
| **Confirm** (paid) | Stripe webhook `checkout.session.completed` **or** client `POST /confirm-payment` → mark paid → same Cal.com confirm. |
| **Join session** | Client opens `meeting_url` (Meet / Zoom / Cal Video depending on Cal event config). |
| **Cancel reservation** | User cancel / modal close: status `cancelled`, Redis DEL. Stale cron every 5 min → `expired`. |
| **Cal webhook cancel** | Match `cal_booking_uid` → status `cancelled` (row kept). |
| **Cal webhook reschedule** | Update slot times, meeting URL, possibly new `cal_booking_uid`. |

---

## 6. Retention / deletion

| Mechanism | Behavior |
|-----------|----------|
| Redis slot hold | TTL default **~10 minutes**; checkout extend **≥30 minutes** |
| Reservation expiry | DB `reservation_expires_at`; cron every **5 minutes** sets `status='expired'` and releases Redis |
| User cancel hold | Soft status `cancelled` — **row retained** |
| Cal cancel | Soft status `cancelled` — **row retained** |
| Hard delete | **No** `DELETE` from `mentor_bookings` in counselling code |
| Account / counselling erasure | **No** counselling-specific delete path for bookings / Cal.com / Stripe sessions in this feature |
| Webhook dedupe Firestore | No TTL in code |
| Slots memory cache | 45 seconds |
| Payment records | Kept on row; general policy retains payment records **6 years** |

---

## 7. Cookies / tracking / auth

| Item | Detail |
|------|--------|
| Session auth | Firebase Bearer ID token on counselling APIs |
| Email verification | Required (frontend + backend) |
| Stripe redirect | Query params `booking=success\|canceled` and `session_id=...` on `/career-counselling` (stripped after use) |
| Meeting URLs | Stored in DB; shown in My Sessions / success; opens third-party host |
| Counselling-specific cookies | None |
| Rate limits | Per uid (or IP); path `/api/counselling/webhook` excluded from some global limits |

---

## 8. What the current Privacy Policy already says

### Mentors / sharing (`§5.2`)

- Name, email, and any notes added to the booking are shared with the mentor
- Mentors are bound by a confidentiality agreement

### Processors (`§5.1`)

Lists Stripe, Google, PostHog, Vercel, AWS, Hostinger, Rewardful — **Cal.com is not listed**.

### Terms (related, not privacy)

- Mentor sessions non-refundable once booked; reschedule ≥24h free; cancel &lt;24h forfeits fee
- Mentors are independent contractors; not legal/immigration/psych advice

---

## 9. Gaps to close in the Privacy Policy

1. **Add Cal.com / Cal.eu as processors** — attendee name, email, timezone, goal notes, meeting links; dual regions via `cal_host`.
2. **Expand Stripe disclosure for counselling** — Checkout metadata includes `goal`, `firebaseUid`, `reservationId`, `attendeeTimeZone`.
3. **Document Redis** — short-lived Firebase uid keyed by mentor + slot; rate-limit keys may store uid/IP.
4. **Spell out `mentor_bookings` categories** — email, goal, meeting URL, Stripe ids, price snapshot.
5. **Qualify erasure** — policy promises account deletion within 30 days, but counselling code has no hard-delete / Cal.com erasure path.
6. **Soft-cancelled / expired rows** — retained indefinitely in code.
7. **Mentor photos** — public Supabase bucket; note region if outside UK.
8. **PCI wording** — confirm Cafy never receives PAN for counselling Checkout (already true for Stripe-hosted flow).
9. **Webhook dedupe Firestore** — collection name / retention unspecified.
10. **Sentry** — may receive `reservationId` / uid / `checkoutSessionId` on errors.
11. **Product vs Terms** — 24h cancel/reschedule rules are contractual; in-app cancel only releases unpaid holds.
12. **“Confidentiality agreement”** — ensure the mentor contract covers Cal.com-shared notes.
13. **Premium pricing linkage** — counselling records linked to subscription tier.
14. **International transfers** — Cal.com (US) vs Cal.eu (EEA) depending on mentor.

---

## 10. Suggested policy language (draft — not legal advice)

### §2.x Career counselling bookings

When you book a career mentor session we process: your account email and user id; your name from your profile (or a fallback derived from your email); the mentor you select; session date, time, duration, and timezone; optional session notes/goal you enter; booking and payment status; and, after confirmation, the meeting link for your session. Card payments are processed by Stripe — Cafy does not store full card numbers.

### §5.x Scheduling provider + mentors

We use Cal.com or Cal.eu (depending on the mentor’s scheduling region) to check availability, create the booking, send calendar invitations, and provide the video meeting link. We send them your name, email, timezone, session time, and any notes you add.

The mentor you book receives those details through the scheduling system so they can run the session. Mentors are independent contractors bound by a confidentiality agreement.

### §5.1 Processors — add

- Cal.com / Cal.eu (scheduling, calendar invites, and meeting links) — [https://cal.com/privacy](https://cal.com/privacy)

### §7.x Counselling retention

Temporary slot holds are stored for a short period (typically up to about 10 minutes, or longer while you complete checkout) and then expire. Confirmed, cancelled, expired, and failed booking records are retained in our systems for service history, dispute handling, and legal/accounting needs. Payment-related counselling records are retained for up to 6 years. Meeting links and calendar data may also be retained by Cal.com / Cal.eu and the meeting provider under their policies.

---

## 11. Key file index

| Area | Path |
|------|------|
| API schemas | `ProductBackend/counselling/schema.ts` |
| Booking logic | `ProductBackend/counselling/service.ts` |
| Cal client | `ProductBackend/counselling/calcomClient.ts` |
| Stripe checkout | `ProductBackend/counselling/checkoutService.ts` |
| Payment confirm | `ProductBackend/counselling/paymentWebhook.ts` |
| Cal webhook | `ProductBackend/counselling/webhookService.ts` |
| DB row type | `ProductBackend/counselling/bookingRepository.ts` |
| Redis holds | `ProductBackend/counselling/slotHold.ts` |
| Mentors public | `ProductBackend/lib/mentorService.ts` |
| Photos | `ProductBackend/lib/mentorStorage.ts` |
| UI booking | `Product-Site/src/components/counselling/BookingModal.tsx` |
| Client API | `Product-Site/src/services/counsellingService.ts` |
| Privacy copy | `Product-Site/src/constants/privacyPolicyContent.ts` |
| Terms copy | `Product-Site/src/constants/termsOfServiceContent.ts` |

---

*Generated from the counselling codebase for privacy-policy drafting. Have counsel review before publishing.*
