# Test Stripe payments (local)

## 1. Prerequisites

- Stripe **Test mode** on (Dashboard toggle).
- Backend `.env`: `STRIPE_SECRET_KEY=sk_test_...`, `STRIPE_WEBHOOK_SECRET`, GBP `STRIPE_PRICE_MONTHLY` / `STRIPE_PRICE_QUARTERLY`, `BILLING_ENABLED=true`, `FRONTEND_URL=https://app.cafy.careers,http://localhost:3000` (Cafy Product + Resume studio).
- Frontend `.env`: `VITE_BACKEND_URL=https://api.cafy.careers`, matching `VITE_STRIPE_PRICE_*`.
- Backend running: `npm run dev` (default port **5000**).
- Frontend running: `npm run dev` (e.g. **5173**).

## 2. Webhook forwarding (required for Premium to unlock)

In a separate terminal:

```bash
stripe login
stripe listen --forward-to https://api.cafy.careers/api/billing/webhook
```

Copy the `whsec_...` secret into backend `.env` as `STRIPE_WEBHOOK_SECRET` and restart the backend.

In [Stripe Dashboard → Webhooks](https://dashboard.stripe.com/test/webhooks), you can use the CLI endpoint or add the same URL for deployed environments.

Listen for events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`.

## 3. Test card

| Field | Value |
|-------|--------|
| Number | `4242 4242 4242 4242` |
| Expiry | Any future date |
| CVC | Any 3 digits |
| Postcode | Any valid UK postcode |

## 4. Happy path

1. Log in to Cafy.
2. Go to **/subscription**.
3. **Free plan** card should show **Your plan**; paid cards **Continue to payment**.
4. Click **Continue to payment** on Monthly or 3-month.
5. On Stripe Checkout → optional **Add promotion code** → pay.
6. Land on **/subscription/success** → wait for “You’re on Premium”.
7. Return to **/subscription**:
   - Your paid card: **Your plan · Monthly** or **Your plan · 3 months**
   - Other paid card: **Subscribed to Premium Monthly** (or 3-month) — disabled
   - Free card: **Free tier** — not “Your plan”
8. Profile → billing card should match the same plan name.

## 5. Promotion code test

Create in **Stripe Dashboard** → Coupons → Promotion code (e.g. `CAFYTEST100`, GBP prices only).

**Ads funnel (auto-apply):** open `https://app.cafy.careers/?promo=CAFYTEST100` (or local with `?promo=`), complete signup/login → onboarding → plan page. Confirm the banner shows the code, then choose Monthly or 3-month — Checkout should show the discount already applied.

**Manual entry:** Subscribe without `?promo=` → on **Stripe Checkout** → **Add promotion code**.

If you already subscribed on this account, use a **second test user** or **cancel the test subscription immediately** in Stripe test mode, then checkout again.

Confirm payment completes and Premium activates via webhook.

**Does the discount apply every payment?** That is set on the **Coupon** in Stripe Dashboard (e.g. once, forever on the subscription, or for N months). Cafy does not re-apply codes on renewals — Stripe bills the subscription and webhooks keep Premium in sync. A code entered at **first Checkout** only affects that subscription if the coupon duration says so; renewals without a lasting discount charge full price automatically.

## 6. Block second subscription

While Premium Monthly is active, the 3-month card should say **Subscribed to Premium Monthly** (not a generic “Already subscribed”). Clicking it should not open checkout; **Manage billing** is used to switch plans.

## 7. Troubleshooting

| Symptom | Fix |
|---------|-----|
| Paid but still Free | Webhook not received — check `stripe listen`, `STRIPE_WEBHOOK_SECRET`, backend logs |
| INR instead of £ | Use GBP `price_...` in `.env`; disable Adaptive pricing in Stripe |
| 409 on checkout | Expected if already subscribed — use Customer Portal |
| Checkout 503 | `BILLING_ENABLED` or Stripe keys missing |

## 8. Firestore check

`users/{uid}/subscription` → `provider: "stripe"`, `plan: "premium"`, `status: "active"`, `billingInterval: "monthly"` or `"quarterly"`.

## 9. Security (comm + jobs bypass fixes)

| Case | Expect |
|------|--------|
| POST `/api/generate` without `operation` | **400** `INVALID_AI_OPERATION` |
| Free user, `operation: comm_cover_letter` × (limit+1) | Last request **402** |
| Free jobs + `excludedJobIds=1,2,3` | Same jobs as without exclusions |
| Free search | `totalCount` ≤ 1 |

## 10. Jobs portal (Premium gating)

| Case | Expect |
|------|--------|
| Free, browse, page=1 | ≤10 jobs, `totalCount` / `globalTotalCount` from DB, `access.isPremium: false` |
| Free, browse, page=2 | **403** `JOBS_PREMIUM_REQUIRED`, empty `jobs` |
| Free, search, page=1 | `totalCount` = full matches, `jobs.length` ≤ 1, blur upsell in UI |
| Free, search, page=2 | **403** |
| Premium, browse, page=2 | Next 10 preference-based jobs |
| Premium, search | Full paginated search results |

Free user **Explore more** (browse or search) → browse opens upgrade modal; search goes to `/subscription` (no page 2 data).

Jobs API responses only include allowlisted public job/company fields (no `select *` to the client).

## 11. Cancel subscription in Stripe

| Cancel type in Stripe | What Cafy should show |
|-----------------------|------------------------|
| **At period end** (Customer Portal / Dashboard) | **Premium until end date** + banner “Cancels on …” (`cancelAtPeriodEnd: true`) |
| **Immediately** | **Free plan** after sync (`plan: free`, `status: canceled`) |

`/api/billing/status` now **re-syncs from Stripe** on each load (fixes missed webhooks in local dev).

**Local dev:** run `stripe listen --forward-to https://api.cafy.careers/api/billing/webhook` so cancellations update without opening the app.

After cancelling in Dashboard: refresh **Subscription** page or profile — status should match Stripe.

## 12. ResumeTool (unified subscription)

See [RESUME_TOOL_BILLING.md](./RESUME_TOOL_BILLING.md).

1. Enable `RESUME_TOOL_BILLING_ENABLED=true` on backend and `NEXT_PUBLIC_RESUME_TOOL_BILLING_ENABLED=true` on ResumeTool.
2. Premium on **Product-Site** → `GET /api/billing/status` shows `resumeTool.tier` = `premium_monthly` or `premium_quarterly` without a second checkout.
3. Free user: 2 AI uses (analyse / optimise only), then `402` on reserve.
4. Import increments `imports` only (separate from AI pool).
5. Compare (`/api/builder/compare`) does **not** call reserve.
6. Paid usage uses `usage.resumeTool.paid` only; `free` bucket unchanged after upgrade.
