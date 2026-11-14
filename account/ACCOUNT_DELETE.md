# Account deletion (production)

## Endpoint

`POST /api/account/delete` (Firebase ID token)

Body: `{ "confirmationPhrase": "Delete my Account" }`

Also: `POST /api/account/assert-signup-allowed` — blocks re-registration of that email for **10 days** after a **successful** deletion.

## Pipeline order

1. Reject if `legalHold` / `deletionHold` on `users/{uid}`
2. **Stop Stripe billing** for paid and `past_due` / `unpaid` alike (no refunds, no further charges):
   - Delete draft invoices; void open invoices
   - Cancel every live subscription **immediately** (`invoice_now: false`, `prorate: false` — no final charge, no prorated refund)
   - Void any invoices left open after cancel
   - Cancel open PaymentIntents still waiting to charge
   - Detach saved payment methods (cards) from the customer
   - Re-check Stripe: if any live subscription or open invoice remains, **abort** with `STRIPE_CANCEL_FAILED` (502) before any data is wiped, so the user can retry while they can still sign in
   - Clear `firebaseUid` on customer metadata; capture Stripe Customer email for the tombstone
   - Stripe Customer + paid invoice history kept for tax/disputes (not charged again)
3. Delete Supabase Storage `ProductResumes/{uid}/**`
4. Anonymize counselling `mentor_bookings` PII for `user_id`
5. Delete `emailOutbox` / `emailFeedback` docs for that uid (and feedback by email)
6. Remove RTDB `presence/{uid}`
7. Recursive delete Firestore `users/{uid}` (+ subcollections)
8. `admin.auth().deleteUser(uid)`
9. **Only on full success:** write `deleted_users` tombstone(s) for **Auth email and Stripe checkout email** (if different) + `accountDeletionEvents` (`status: completed`)

### Paid + past-due users

Same stop-billing path. Subscription ends immediately (not at period end). No refund for unused time via account delete. Open/draft invoices and pending PaymentIntents are stopped so Stripe does not charge again. Prior successful charges stay on the Stripe customer for tax/disputes. Statutory 14-day cooling-off (email to support) is separate from this delete path.

Not wiped (vendor / ops limits): Cal.com attendee copies of past bookings, GA4 aggregates, Stripe invoices / customer object, infra backups.

Failed mid-pipeline writes **no** tombstone and **no** audit row (logs only). Stripe may already be cancelled if step 2 ran. If step 2 cannot confirm billing is stopped, nothing else is deleted.

## Retained (after success)

- Tombstone emails (`authEmail` + `stripeCheckoutEmail`, `blockedUntil` = delete + 10 days). Either address fails re-signup until then.
- Stripe invoices / customer (tax, disputes)
- Backups until expiry
- Third-party copies already shared

## Support

- Incomplete delete (no Auth user or empty profile, no tombstone): check server logs; cancel Stripe manually if needed; optionally write tombstone by ops
- Legal hold: set `users/{uid}.legalHold = true` before disputes
- Early re-register / “can’t login with Google after delete”: Firebase treats it as a **new** signup → `assert-signup-allowed` returns `EMAIL_DELETED` (403) and removes the fresh Auth user. Clear or shorten `blockedUntil` on `deleted_users/{sha256(lowercased email)}` (ops only), or delete that doc to allow immediate re-signup.

## Rate limit

5 deletes / uid / hour in production (`accountDeleteLimiter`).
