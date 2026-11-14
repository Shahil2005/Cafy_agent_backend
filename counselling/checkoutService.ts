import type { SupabaseClient } from '@supabase/supabase-js';
import { getFrontendUrl } from '../billing/config';
import { assertStripeHostedUrl } from '../billing/portalConfig';
import { isStripeConfigured } from '../billing/stripeClient';
import { getOrCreateStripeCustomerId, getUserBillingDoc } from '../billing/subscriptionService';
import { getStripe } from '../billing/stripeClient';
import { getBookingById, updateBookingRow } from './bookingRepository';
import { getStripeCheckoutMinMinutes, isCounsellingPaymentRequired } from './config';
import { assertGbpCounsellingPrice } from './priceValidation';
import { getCounsellingStripePriceId } from './pricing';
import { extendSlotHold } from './slotHold';
import type { DurationMinutes } from './types';

function assertVerifiedBooker(email: string | null | undefined, emailVerified: boolean | undefined): void {
    if (!email?.trim()) {
        throw new Error('EMAIL_REQUIRED');
    }
    if (emailVerified === false) {
        throw new Error('EMAIL_NOT_VERIFIED');
    }
}

function assertReservationActive(
    row: NonNullable<Awaited<ReturnType<typeof getBookingById>>>,
    uid: string
): void {
    if (row.user_id !== uid) {
        throw new Error('RESERVATION_NOT_FOUND');
    }
    if (row.status !== 'reserved') {
        throw new Error('RESERVATION_INVALID');
    }
    const exp = row.reservation_expires_at;
    if (exp && new Date(exp).getTime() <= Date.now()) {
        throw new Error('RESERVATION_EXPIRED');
    }
}

export async function createCounsellingCheckoutSession(
    db: SupabaseClient,
    input: {
        uid: string;
        email: string | null;
        emailVerified?: boolean;
        reservationId: string;
        goal?: string;
        attendeeTimeZone?: string;
    }
): Promise<{ url: string; sessionId: string }> {
    if (!isCounsellingPaymentRequired()) {
        throw new Error('PAYMENT_NOT_REQUIRED');
    }
    if (!isStripeConfigured()) {
        throw new Error('STRIPE_NOT_CONFIGURED');
    }

    assertVerifiedBooker(input.email, input.emailVerified);

    const row = await getBookingById(db, input.reservationId);
    if (!row) {
        throw new Error('RESERVATION_NOT_FOUND');
    }

    assertReservationActive(row, input.uid);

    const durationMinutes = row.duration_minutes as DurationMinutes | null;
    const mentorId = row.mentor_id;
    const slotIso = row.slot_starts_at;
    if (!durationMinutes || !slotIso || !mentorId) {
        throw new Error('RESERVATION_INVALID');
    }

    const goal = input.goal?.trim() ?? row.goal?.trim() ?? '';
    if (goal && goal !== (row.goal ?? '')) {
        await updateBookingRow(db, input.reservationId, { goal });
    }

    // Stripe requires checkout expires_at ≥30 min from now; extend hold + DB expiry to match.
    const stripeMinMs = getStripeCheckoutMinMinutes() * 60_000;
    const currentExpiryMs = row.reservation_expires_at
        ? new Date(row.reservation_expires_at).getTime()
        : Date.now();
    const checkoutExpiresMs = Math.max(currentExpiryMs, Date.now() + stripeMinMs);
    const checkoutExpiresAt = new Date(checkoutExpiresMs).toISOString();
    const holdTtlSeconds = Math.ceil((checkoutExpiresMs - Date.now()) / 1000);

    await updateBookingRow(db, input.reservationId, {
        reservation_expires_at: checkoutExpiresAt,
    });

    const extended = await extendSlotHold(mentorId, slotIso, input.uid, holdTtlSeconds);
    if (!extended) {
        throw new Error('SLOT_HELD');
    }

    const isPremium = row.price_tier === 'premium';
    const priceId = getCounsellingStripePriceId(durationMinutes, isPremium);
    if (!priceId) {
        throw new Error('STRIPE_PRICE_NOT_CONFIGURED');
    }

    await assertGbpCounsellingPrice(priceId);

    const { subscription } = await getUserBillingDoc(input.uid);
    const customerId = await getOrCreateStripeCustomerId(
        input.uid,
        input.email ?? undefined,
        subscription.stripeCustomerId ?? undefined
    );

    const frontend = getFrontendUrl().replace(/\/$/, '');
    const expiresAtUnix = Math.floor(checkoutExpiresMs / 1000);

    const session = await getStripe().checkout.sessions.create({
        mode: 'payment',
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${frontend}/career-counselling?booking=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${frontend}/career-counselling?booking=canceled`,
        locale: 'en-GB',
        adaptive_pricing: { enabled: false },
        allow_promotion_codes: true,
        client_reference_id: input.uid,
        expires_at: expiresAtUnix,
        metadata: {
            type: 'counselling',
            firebaseUid: input.uid,
            reservationId: input.reservationId,
            goal: goal.slice(0, 500),
            attendeeTimeZone: (input.attendeeTimeZone?.trim() || '').slice(0, 64),
        },
    });

    if (!session.url) {
        throw new Error('CHECKOUT_URL_MISSING');
    }

    assertStripeHostedUrl(session.url, 'checkout');

    await updateBookingRow(db, input.reservationId, {
        stripe_checkout_session_id: session.id,
    });

    return { url: session.url, sessionId: session.id };
}
