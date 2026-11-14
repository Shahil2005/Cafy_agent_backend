/** Bookings and most v2 endpoints */
const CAL_API_VERSION = '2024-08-13';
/** Slots endpoint requires 2024-09-04 per Cal.com docs */
const CAL_SLOTS_API_VERSION = '2024-09-04';

export function isCounsellingEnabled(): boolean {
    return process.env.COUNSELLING_ENABLED === 'true';
}

/**
 * Payment required when either:
 * - COUNSELLING_REQUIRE_PAYMENT=true, or
 * - COUNSELLING_SKIP_PAYMENT=false (legacy / inverse flag in .env)
 * Default: skip payment (local dev).
 */
export function isCounsellingPaymentRequired(): boolean {
    if (process.env.COUNSELLING_REQUIRE_PAYMENT === 'true') {
        return true;
    }
    if (process.env.COUNSELLING_SKIP_PAYMENT === 'false') {
        return true;
    }
    return false;
}

export function isCounsellingSkipPayment(): boolean {
    return !isCounsellingPaymentRequired();
}

export function getCalComApiKey(): string {
    const key = process.env.CALCOM_API_KEY?.trim();
    if (!key) {
        throw new Error('CALCOM_API_KEY is not configured');
    }
    return key;
}

export function getCalComApiBaseForHost(host: 'cal.com' | 'cal.eu'): string {
    if (host === 'cal.eu') {
        return 'https://api.cal.eu/v2';
    }
    const configured = process.env.CALCOM_API_URL?.trim().replace(/\/$/, '');
    return configured || 'https://api.cal.com/v2';
}

export function getCalApiVersion(): string {
    return CAL_API_VERSION;
}

export function getCalSlotsApiVersion(): string {
    return CAL_SLOTS_API_VERSION;
}

export function getMinNoticeMinutes(): number {
    const parsed = Number.parseInt(process.env.CALCOM_MIN_NOTICE_MINUTES ?? '60', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60;
}

export function getBookingWindowDays(): number {
    const parsed = Number.parseInt(process.env.CALCOM_BOOKING_WINDOW_DAYS ?? '10', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

export function getSlotHoldMinutes(): number {
    const parsed = Number.parseInt(process.env.CALCOM_SLOT_HOLD_MINUTES ?? '10', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

/** Stripe Checkout `expires_at` must be ≥30 minutes from session creation. */
export function getStripeCheckoutMinMinutes(): number {
    return 30;
}

/** Hold duration while user is on Stripe Checkout (never below Stripe minimum). */
export function getCheckoutHoldMinutes(): number {
    return Math.max(getSlotHoldMinutes(), getStripeCheckoutMinMinutes());
}

export function getCalComWebhookSecret(): string | null {
    const secret = process.env.CALCOM_WEBHOOK_SECRET?.trim();
    return secret || null;
}
