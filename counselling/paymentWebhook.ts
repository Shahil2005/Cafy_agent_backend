import type { SupabaseClient } from '@supabase/supabase-js';
import { captureServerError } from '../lib/observability/sentry';
import { getBookingById, updateBookingRow } from './bookingRepository';
import { confirmCounsellingReservation } from './service';
import type { CounsellingBookingRecord } from './types';

export type CounsellingCheckoutSession = {
    id: string;
    payment_status?: string | null;
    client_reference_id?: string | null;
    customer_details?: { email?: string | null } | null;
    payment_intent?: string | { id?: string } | null;
    metadata?: {
        type?: string;
        firebaseUid?: string;
        reservationId?: string;
        goal?: string;
        attendeeTimeZone?: string;
    } | null;
};

export type CounsellingPaymentConfirmResult = {
    booking: CounsellingBookingRecord;
    meetingUrl: string | null;
    alreadyConfirmed: boolean;
};

export function isCounsellingCheckoutSession(session: CounsellingCheckoutSession): boolean {
    return session.metadata?.type === 'counselling' && !!session.metadata?.reservationId;
}

export async function processCounsellingPaidCheckout(
    db: SupabaseClient,
    session: CounsellingCheckoutSession,
    options?: { expectedUid?: string }
): Promise<CounsellingPaymentConfirmResult> {
    if (!isCounsellingCheckoutSession(session)) {
        throw new Error('CHECKOUT_NOT_COUNSELLING');
    }

    if (session.payment_status !== 'paid') {
        throw new Error('CHECKOUT_NOT_PAID');
    }

    const reservationId = session.metadata!.reservationId!;
    const uid = session.metadata!.firebaseUid || session.client_reference_id || null;
    if (!uid) {
        throw new Error('CHECKOUT_SESSION_INVALID');
    }

    if (options?.expectedUid && options.expectedUid !== uid) {
        throw new Error('CHECKOUT_SESSION_FORBIDDEN');
    }

    let row = await getBookingById(db, reservationId);
    if (!row || row.user_id !== uid) {
        throw new Error('RESERVATION_NOT_FOUND');
    }

    const alreadyConfirmed = row.status === 'confirmed' && !!row.cal_booking_uid;

    const paymentIntentId =
        typeof session.payment_intent === 'string'
            ? session.payment_intent
            : session.payment_intent?.id ?? null;

    if (!row.payment_released) {
        await updateBookingRow(db, reservationId, {
            payment_released: true,
            stripe_checkout_session_id: session.id,
            stripe_payment_intent_id: paymentIntentId,
            paid_at: new Date().toISOString(),
        });
    }

    if (!alreadyConfirmed && (row.status === 'expired' || row.status === 'failed')) {
        await updateBookingRow(db, reservationId, { status: 'reserved' });
        row = (await getBookingById(db, reservationId))!;
    }

    const goal = session.metadata?.goal?.trim() || row.goal?.trim() || undefined;
    const attendeeTimeZone = session.metadata?.attendeeTimeZone?.trim() || undefined;
    const email = session.customer_details?.email?.trim() || row.user_email?.trim() || null;

    try {
        const result = await confirmCounsellingReservation(db, {
            uid,
            email,
            reservationId,
            goal,
            attendeeTimeZone: attendeeTimeZone || undefined,
            paymentVerified: true,
        });

        return {
            booking: result.booking,
            meetingUrl: result.meetingUrl,
            alreadyConfirmed,
        };
    } catch (err) {
        console.error('[counselling payment] confirm after payment failed', reservationId, err);
        captureServerError(err, {
            tags: { feature: 'counselling', route: 'payment-confirm' },
            extra: { reservationId, checkoutSessionId: session.id, uid },
        });
        throw err;
    }
}

export async function handleCounsellingCheckoutCompleted(
    db: SupabaseClient,
    session: CounsellingCheckoutSession
): Promise<void> {
    if (!isCounsellingCheckoutSession(session)) {
        return;
    }

    if (session.payment_status !== 'paid') {
        console.warn('[counselling payment] checkout completed but not paid', session.id, session.payment_status);
        return;
    }

    await processCounsellingPaidCheckout(db, session);
}
