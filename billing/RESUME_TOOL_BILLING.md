# ResumeTool billing (unified subscription)

ResumeTool shares **one Stripe subscription** with Product-Site (`users/{uid}/subscription`). Usage is tracked separately in `usage.resumeTool` with **free** and **paid** buckets.

## Enable

**ProductBackend `.env`:**

```env
RESUME_TOOL_BILLING_ENABLED=true
# Comma-separated: Cafy Product first, Resume studio second (CORS + Stripe return URLs)
FRONTEND_URL=https://app.cafy.careers,http://localhost:3000

RESUME_FREE_AI_LIMIT=2
RESUME_FREE_IMPORT_LIMIT=1
RESUME_FREE_PDF_DOWNLOAD_LIMIT=5

# Premium monthly (£18): unlimited for each 1-month billing period (default)
RESUME_MONTHLY_UNLIMITED=true
# Only used when RESUME_MONTHLY_UNLIMITED=false:
# RESUME_MONTHLY_AI_LIMIT=20
# RESUME_MONTHLY_IMPORT_LIMIT=10
# RESUME_MONTHLY_PDF_DOWNLOAD_LIMIT=-1

# Premium quarterly (£60): unlimited for each 3-month billing period (default)
RESUME_QUARTERLY_UNLIMITED=true
```

`FRONTEND_URL` is the only frontend-origin variable: first URL = Cafy Product checkout, second = Resume studio checkout; all listed origins are allowed for CORS.

`RESUME_TOOL_FRONTEND_URL` is deprecated (optional override only).

This does **not** authenticate ResumeTool `/api/*` routes — those need a Firebase `Authorization` header (or `x-firebase-token`) from a signed-in user.

**ResumeTool `.env`:**

```env
NEXT_PUBLIC_RESUME_TOOL_BILLING_ENABLED=true
NEXT_PUBLIC_API_URL=https://api.cafy.careers
NEXT_PUBLIC_STRIPE_PRICE_MONTHLY=price_...
NEXT_PUBLIC_STRIPE_PRICE_QUARTERLY=price_...
```

**UI:** `/pricing` (plans + usage), header shows **Pricing** + compact usage when billing is enabled.

Legacy names `NEXT_PUBLIC_PRODUCT_BACKEND_URL` / `PRODUCT_BACKEND_URL` still work as fallbacks if `NEXT_PUBLIC_API_URL` is unset.

## Premium plans

| Plan | Price | Resume studio |
|------|-------|----------------|
| **Monthly** | £18 / month | Unlimited AI, imports, and PDF downloads for each 1-month billing period |
| **Quarterly** | £60 / 3 months | Unlimited AI, imports, and PDF downloads for each 3-month billing period |

Both paid tiers share the same unlimited ResumeTool entitlements. The only difference is billing interval and price. Free tier limits are lifetime caps.

## Metered operations

| Operation | Routes | Counter |
|-----------|--------|---------|
| `analyse` | `/api/analyze`, `/api/builder/analyze-jd` | `aiRuns` |
| `optimise` | `/api/builder/optimize` | `aiRuns` |
| `import` | `/api/builder/import` | `imports` only (not AI pool) |
| `pdf_download` | `/api/builder/pdf` | `pdfDownloads` |

**Not metered:** `/api/builder/compare` (compare score).

## API

- `POST /api/billing/resume-tool/reserve` — body `{ "operation": "analyse" | "optimise" | "import" | "pdf_download" }`. A successful reserve returns `reservationId`.
- `POST /api/billing/resume-tool/refund` — body `{ "operation", "reservationId" }`. Refunds that one reserve, once, within 30 minutes. A call without a live reservation does not change usage.
- `GET /api/billing/status` — includes `resumeTool` when enabled

## Security

- Limits enforced only in ProductBackend Firestore transactions.
- ResumeTool passes Firebase ID token; backend verifies via existing `verifyToken`.
- Clients cannot write `usage.resumeTool` or `resumeToolReservations` (Firestore rules).
- The reservation id stays on the ResumeTool server. It is not returned to the browser.

## Checkout from ResumeTool

```json
POST /api/billing/create-checkout
{ "priceId": "...", "returnApp": "resume-tool" }
```

Portal: `{ "returnApp": "resume-tool" }`.
