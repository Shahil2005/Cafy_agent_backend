import type { SupabaseClient } from '@supabase/supabase-js';
import admin from 'firebase-admin';
import { getUserBillingDoc, isPremiumActive, refreshSubscriptionIfExpired } from '../billing/subscriptionService';
import { isStripeConfigured } from '../billing/stripeClient';
import { captureServerError } from '../lib/observability/sentry';
import {
    createOrReconcileCalComBooking,
    fetchCalComSlots,
    isCalComSlotAvailable,
} from './calcomClient';
import {
    expireStaleReservations,
    getBookingById,
    insertBookingRow,
    listActiveReservationsForUser,
    listActiveSlotStartsForMentor,
    updateBookingRow,
    type MentorBookingRow,
} from './bookingRepository';
import {
    getBookingWindowDays,
    getCheckoutHoldMinutes,
    getMinNoticeMinutes,
    getSlotHoldMinutes,
    isCounsellingEnabled,
    isCounsellingPaymentRequired,
} from './config';
import { loadBookableMentor } from './mentorRepository';
import { getPublicPriceTable, getSessionPricePence } from './pricing';
import { isSlotInAvailabilityCache } from './slotsCache';
import {
    acquireSlotHold,
    extendSlotHold,
    filterHeldSlots,
    releaseSlotHold,
} from './slotHold';
import type { CounsellingBookingRecord, CounsellingSlot, DurationMinutes } from './types';

function minBookableTime(): Date {
    return new Date(Date.now() + getMinNoticeMinutes() * 60_000);
}

function bookingWindowEnd(): Date {
    const end = new Date();
    end.setUTCDate(end.getUTCDate() + getBookingWindowDays());
    end.setUTCHours(23, 59, 59, 999);
    return end;
}

function filterSlotsByRules(slots: CounsellingSlot[]): CounsellingSlot[] {
    const earliest = minBookableTime();
    const latest = bookingWindowEnd();

    return slots.filter((slot) => {
        const start = new Date(slot.startsAt);
        return start >= earliest && start <= latest;
    });
}

function normalizeSlotIso(iso: string): string {
    return new Date(iso).toISOString();
}

function formatLegacyBookedFields(slotStartsAt: string, timeZone: string): { bookedDay: string; bookedTime: string } {
    const date = new Date(slotStartsAt);
    const day = date.toLocaleDateString('en-CA', { timeZone });
    const time = date.toLocaleTimeString('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
    return { bookedDay: day, bookedTime: time };
}

function assertVerifiedBooker(email: string | null | undefined, emailVerified: boolean | undefined): void {
    if (!email?.trim()) {
        throw new Error('EMAIL_REQUIRED');
    }
    if (emailVerified === false) {
        throw new Error('EMAIL_NOT_VERIFIED');
    }
}

async function loadUserDisplayName(uid: string, email: string | null): Promise<string> {
    try {
        const snap = await admin.firestore().collection('users').doc(uid).get();
        const data = snap.data();
        const first = typeof data?.firstName === 'string' ? data.firstName.trim() : '';
        const last = typeof data?.lastName === 'string' ? data.lastName.trim() : '';
        const combined = `${first} ${last}`.trim();
        if (combined) return combined;
    } catch {
        // fall through
    }
    if (email) return email.split('@')[0] || 'Cafy User';
    return 'Cafy User';
}

function validateSlotTime(slotStartsAt: string): Date {
    const slotStart = new Date(slotStartsAt);
    if (!Number.isFinite(slotStart.getTime())) {
        throw new Error('INVALID_SLOT');
    }
    if (slotStart < minBookableTime()) {
        throw new Error('SLOT_TOO_SOON');
    }
    if (slotStart > bookingWindowEnd()) {
        throw new Error('SLOT_OUT_OF_RANGE');
    }
    return slotStart;
}

function mapBookingRow(row: MentorBookingRow | Record<string, unknown>): CounsellingBookingRecord {
    const r = row as MentorBookingRow;
    return {
        id: String(r.id),
        mentorId: Number(r.mentor_id),
        mentorName: typeof r.mentor_name === 'string' ? r.mentor_name : null,
        status: typeof r.status === 'string' ? r.status : 'unknown',
        slotStartsAt: typeof r.slot_starts_at === 'string' ? r.slot_starts_at : null,
        slotEndsAt: typeof r.slot_ends_at === 'string' ? r.slot_ends_at : null,
        durationMinutes: typeof r.duration_minutes === 'number' ? r.duration_minutes : null,
        meetingUrl: typeof r.meeting_url === 'string' ? r.meeting_url : null,
        goal: typeof r.goal === 'string' ? r.goal : null,
        bookedDay: typeof r.booked_day === 'string' ? r.booked_day : null,
        bookedTime: typeof r.booked_time === 'string' ? r.booked_time : null,
        createdAt: typeof r.created_at === 'string' ? r.created_at : null,
        reservationExpiresAt:
            typeof r.reservation_expires_at === 'string' ? r.reservation_expires_at : null,
    };
}

function reservationExpiryIso(): string {
    return new Date(Date.now() + getSlotHoldMinutes() * 60_000).toISOString();
}

function assertReservationActive(row: MentorBookingRow, uid: string): void {
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

function resolveAttendeeTimeZone(input: string | undefined, mentorTimezone: string): string {
    const tz = input?.trim();
    if (!tz || tz.length > 64) {
        return mentorTimezone;
    }
    return tz;
}

async function cancelOtherActiveReservationsForUser(
    db: SupabaseClient,
    uid: string,
    exceptReservationId?: string
): Promise<void> {
    const active = await listActiveReservationsForUser(db, uid);
    for (const row of active) {
        if (exceptReservationId && row.id === exceptReservationId) continue;
        const slotIso = row.slot_starts_at;
        await updateBookingRow(db, row.id, { status: 'cancelled' }).catch(() => {});
        if (slotIso && row.mentor_id) {
            await releaseSlotHold(row.mentor_id, slotIso, uid);
        }
    }
}

async function finalizeConfirmedBooking(
    db: SupabaseClient,
    reservationId: string,
    row: MentorBookingRow,
    patch: {
        calBookingUid: string;
        meetingUrl: string | null;
        goal: string;
    }
): Promise<CounsellingBookingRecord> {
    let lastError: unknown;

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            await updateBookingRow(db, reservationId, {
                status: 'confirmed',
                goal: patch.goal,
                cal_booking_uid: patch.calBookingUid,
                meeting_url: patch.meetingUrl,
                reservation_expires_at: null,
            });

            const updated = await getBookingById(db, reservationId);
            return mapBookingRow(
                updated ?? { ...row, status: 'confirmed', cal_booking_uid: patch.calBookingUid }
            );
        } catch (err) {
            lastError = err;
            if (attempt < 2) {
                await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
            }
        }
    }

    captureServerError(lastError, {
        tags: { feature: 'counselling', issue: 'confirm_db_failed' },
        extra: { reservationId, calBookingUid: patch.calBookingUid },
    });
    throw lastError;
}

export async function getCounsellingPublicConfig() {
    const prices = await getPublicPriceTable();
    const paymentRequired = isCounsellingPaymentRequired();
    return {
        enabled: true,
        skipPayment: !paymentRequired,
        paymentRequired,
        stripeConfigured: paymentRequired ? isStripeConfigured() : true,
        reservationHoldMinutes: getSlotHoldMinutes(),
        /** Global catalogue; booking UI further filters by mentor `availableDurations`. */
        durations: [30, 45, 60] as DurationMinutes[],
        /** Amounts from Stripe price IDs in env (cached). */
        prices: prices.standard,
        standardPrices: prices.standard,
        premiumPrices: prices.premium,
        minNoticeMinutes: getMinNoticeMinutes(),
        bookingWindowDays: getBookingWindowDays(),
    };
}

/** Unauthenticated status for tab gating and marketing pages. */
export function getCounsellingPublicStatus() {
    if (!isCounsellingEnabled()) {
        return { enabled: false };
    }
    const paymentRequired = isCounsellingPaymentRequired();
    return {
        enabled: true,
        paymentRequired,
        skipPayment: !paymentRequired,
        stripeConfigured: paymentRequired ? isStripeConfigured() : true,
        reservationHoldMinutes: getSlotHoldMinutes(),
        bookingWindowDays: getBookingWindowDays(),
        minNoticeMinutes: getMinNoticeMinutes(),
    };
}

export async function getAvailabilityForMentor(
    db: SupabaseClient,
    mentorId: number,
    durationMinutes: DurationMinutes,
    userId: string
): Promise<{ slots: CounsellingSlot[] }> {
    const expirePromise = expireStaleReservations(db);

    const mentor = await loadBookableMentor(db, mentorId);
    if (!mentor) {
        throw new Error('MENTOR_NOT_BOOKABLE');
    }

    const eventSlug = mentor.eventSlugForDuration(durationMinutes);
    if (!eventSlug) {
        // Duration not offered for this mentor — empty availability, not an error.
        await expirePromise;
        return { slots: [] };
    }

    const startTime = new Date();
    const endTime = bookingWindowEnd();

    const [rawSlots, activeDbStartsRaw] = await Promise.all([
        fetchCalComSlots(mentor, durationMinutes, startTime, endTime),
        listActiveSlotStartsForMentor(db, mentorId),
        expirePromise,
    ]);

    const filtered = filterSlotsByRules(rawSlots);
    const withoutHolds = await filterHeldSlots(mentor.id, filtered, userId);

    const activeDbStarts = new Set(activeDbStartsRaw.map((s) => normalizeSlotIso(s)));

    const slots = withoutHolds.filter((slot) => !activeDbStarts.has(normalizeSlotIso(slot.startsAt)));

    return { slots };
}

export async function reserveCounsellingSlot(
    db: SupabaseClient,
    input: {
        uid: string;
        email: string | null;
        emailVerified?: boolean;
        mentorId: number;
        durationMinutes: DurationMinutes;
        slotStartsAt: string;
    }
): Promise<{ reservationId: string; expiresAt: string; slotStartsAt: string }> {
    assertVerifiedBooker(input.email, input.emailVerified);

    const [mentor] = await Promise.all([
        loadBookableMentor(db, input.mentorId),
        expireStaleReservations(db),
    ]);

    if (!mentor) {
        throw new Error('MENTOR_NOT_BOOKABLE');
    }

    if (!mentor.eventSlugForDuration(input.durationMinutes)) {
        throw new Error('MENTOR_EVENT_NOT_CONFIGURED');
    }

    const slotStart = validateSlotTime(input.slotStartsAt);
    const slotIso = slotStart.toISOString();

    await cancelOtherActiveReservationsForUser(db, input.uid);

    const activeStarts = await listActiveSlotStartsForMentor(db, mentor.id);
    if (activeStarts.some((s) => normalizeSlotIso(s) === slotIso)) {
        throw new Error('SLOT_UNAVAILABLE');
    }

    const windowStart = new Date();
    const windowEnd = bookingWindowEnd();
    const cachedSlotAvailable = isSlotInAvailabilityCache(
        mentor.id,
        input.durationMinutes,
        slotIso,
        windowStart,
        windowEnd
    );

    if (cachedSlotAvailable === false) {
        throw new Error('SLOT_UNAVAILABLE');
    }

    const billingPromise = getUserBillingDoc(input.uid);

    const holdOk = await acquireSlotHold(mentor.id, slotIso, input.uid);
    if (!holdOk) {
        throw new Error('SLOT_HELD');
    }

    try {
        const calVerifyPromise =
            cachedSlotAvailable === true
                ? Promise.resolve(true)
                : isCalComSlotAvailable(mentor, input.durationMinutes, slotIso);

        const [stillFree, { subscription }] = await Promise.all([calVerifyPromise, billingPromise]);
        if (!stillFree) {
            throw new Error('SLOT_UNAVAILABLE');
        }

        const attendeeEmail = input.email!.trim();
        const expiresAt = reservationExpiryIso();
        const slotEnd = new Date(slotStart.getTime() + input.durationMinutes * 60_000);
        const legacy = formatLegacyBookedFields(slotIso, mentor.calTimezone);

        const isPremium = isPremiumActive(subscription);

        const row = await insertBookingRow(db, {
            user_id: input.uid,
            user_email: attendeeEmail,
            mentor_id: mentor.id,
            mentor_name: mentor.name,
            booked_day: legacy.bookedDay,
            booked_time: legacy.bookedTime,
            goal: '',
            status: 'reserved',
            payment_released: false,
            slot_starts_at: slotIso,
            slot_ends_at: slotEnd.toISOString(),
            duration_minutes: input.durationMinutes,
            price_tier: isPremium ? 'premium' : 'standard',
            amount_pence: await getSessionPricePence(input.durationMinutes, isPremium),
            reservation_expires_at: expiresAt,
        });

        return {
            reservationId: row.id,
            expiresAt,
            slotStartsAt: slotIso,
        };
    } catch (err) {
        await releaseSlotHold(mentor.id, slotIso, input.uid);
        throw err;
    }
}

export async function cancelCounsellingReservation(
    db: SupabaseClient,
    uid: string,
    reservationId: string
): Promise<void> {
    const row = await getBookingById(db, reservationId);
    if (!row || row.user_id !== uid || row.status !== 'reserved') {
        return;
    }

    const slotIso = row.slot_starts_at;
    await updateBookingRow(db, reservationId, { status: 'cancelled' });
    if (slotIso && row.mentor_id) {
        await releaseSlotHold(row.mentor_id, slotIso, uid);
    }
}

export async function confirmCounsellingReservation(
    db: SupabaseClient,
    input: {
        uid: string;
        email: string | null;
        emailVerified?: boolean;
        reservationId: string;
        goal?: string;
        attendeeTimeZone?: string;
        /** Set when Stripe webhook has verified payment. */
        paymentVerified?: boolean;
    }
): Promise<{ booking: CounsellingBookingRecord; meetingUrl: string | null }> {
    const paymentRequired = isCounsellingPaymentRequired();

    if (paymentRequired && !input.paymentVerified) {
        throw new Error('PAYMENT_REQUIRED');
    }

    if (!input.paymentVerified) {
        assertVerifiedBooker(input.email, input.emailVerified);
        await expireStaleReservations(db);
    }

    let row = await getBookingById(db, input.reservationId);
    if (!row || row.user_id !== input.uid) {
        throw new Error('RESERVATION_NOT_FOUND');
    }

    const goal = input.goal?.trim() ?? row.goal ?? '';

    if (row.status === 'confirmed' && row.cal_booking_uid) {
        if (goal && goal !== (row.goal ?? '')) {
            await updateBookingRow(db, input.reservationId, { goal });
        }
        return {
            booking: mapBookingRow({ ...row, goal: goal || row.goal }),
            meetingUrl: row.meeting_url,
        };
    }

    if (!input.paymentVerified) {
        assertReservationActive(row, input.uid);
    } else if (row.status === 'expired' || row.status === 'failed') {
        await updateBookingRow(db, input.reservationId, { status: 'reserved' });
        row = (await getBookingById(db, input.reservationId))!;
    } else if (row.status !== 'reserved') {
        throw new Error('RESERVATION_INVALID');
    }

    if (paymentRequired && !row.payment_released && !input.paymentVerified) {
        throw new Error('PAYMENT_REQUIRED');
    }

    const mentorId = row.mentor_id;
    const durationMinutes = row.duration_minutes as DurationMinutes;
    const slotIso = row.slot_starts_at;
    if (!slotIso || !durationMinutes) {
        throw new Error('RESERVATION_INVALID');
    }

    const mentor = await loadBookableMentor(db, mentorId);
    if (!mentor) {
        throw new Error('MENTOR_NOT_BOOKABLE');
    }

    const attendeeTimeZone = resolveAttendeeTimeZone(input.attendeeTimeZone, mentor.calTimezone);

    const holdTtlSeconds = input.paymentVerified
        ? getCheckoutHoldMinutes() * 60
        : getSlotHoldMinutes() * 60;

    let holdOk = await extendSlotHold(mentor.id, slotIso, input.uid, holdTtlSeconds);
    if (!holdOk && input.paymentVerified) {
        holdOk = await acquireSlotHold(mentor.id, slotIso, input.uid, holdTtlSeconds);
    }
    if (!holdOk && !input.paymentVerified) {
        throw new Error('SLOT_HELD');
    }

    try {
        if (!input.paymentVerified) {
            const stillFree = await isCalComSlotAvailable(mentor, durationMinutes, slotIso);
            if (!stillFree) {
                throw new Error('SLOT_UNAVAILABLE');
            }
        }

        const attendeeName = await loadUserDisplayName(input.uid, input.email);
        const attendeeEmail = input.email?.trim() || row.user_email?.trim();
        if (!attendeeEmail) {
            throw new Error('EMAIL_REQUIRED');
        }

        const calBooking = await createOrReconcileCalComBooking({
            mentor,
            durationMinutes,
            slotStartsAt: slotIso,
            attendeeName,
            attendeeEmail,
            attendeeTimeZone,
            goal: goal || undefined,
        });

        const booking = await finalizeConfirmedBooking(db, input.reservationId, row, {
            calBookingUid: calBooking.uid,
            meetingUrl: calBooking.meetingUrl,
            goal,
        });

        return {
            booking,
            meetingUrl: calBooking.meetingUrl,
        };
    } catch (err) {
        if (err instanceof Error && err.message === 'CALCOM_BOOKING_FAILED') {
            await updateBookingRow(db, input.reservationId, { status: 'failed' }).catch(() => {});
        }
        throw err;
    } finally {
        await releaseSlotHold(mentor.id, slotIso, input.uid);
    }
}

/** @deprecated Prefer reserve + confirm. One-shot for backwards compatibility. */
export async function bookSessionWithoutPayment(
    db: SupabaseClient,
    input: {
        uid: string;
        email: string | null;
        emailVerified?: boolean;
        mentorId: number;
        durationMinutes: DurationMinutes;
        slotStartsAt: string;
        goal?: string;
        attendeeTimeZone?: string;
    }
): Promise<{ booking: CounsellingBookingRecord; meetingUrl: string | null }> {
    const reserved = await reserveCounsellingSlot(db, input);
    return confirmCounsellingReservation(db, {
        uid: input.uid,
        email: input.email,
        emailVerified: input.emailVerified,
        reservationId: reserved.reservationId,
        goal: input.goal,
        attendeeTimeZone: input.attendeeTimeZone,
    });
}

export async function listUserBookings(
    db: SupabaseClient,
    uid: string
): Promise<CounsellingBookingRecord[]> {
    await expireStaleReservations(db);

    const { data, error } = await db
        .from('mentor_bookings')
        .select('*')
        .eq('user_id', uid)
        .in('status', ['reserved', 'confirmed', 'cancelled', 'expired', 'failed'])
        .order('slot_starts_at', { ascending: false, nullsFirst: false });

    if (error) {
        throw error;
    }

    return (data ?? [])
        .filter((row) => {
            const r = row as MentorBookingRow;
            if (r.status !== 'reserved') return true;
            const exp = r.reservation_expires_at;
            return !exp || new Date(exp).getTime() > Date.now();
        })
        .map((row) => mapBookingRow(row as MentorBookingRow));
}

export function mapCounsellingError(error: unknown): { status: number; code: string; message: string } {
    const code = error instanceof Error ? error.message : 'UNKNOWN';

    const table: Record<string, { status: number; message: string }> = {
        MENTOR_NOT_BOOKABLE: { status: 404, message: 'This mentor is not available for booking.' },
        MENTOR_EVENT_NOT_CONFIGURED: { status: 422, message: 'Session type is not configured for this mentor.' },
        CALCOM_SLOTS_FAILED: { status: 502, message: 'Could not load availability. Try again shortly.' },
        CALCOM_BOOKING_FAILED: { status: 502, message: 'Could not confirm the booking. Try another slot.' },
        SLOT_UNAVAILABLE: { status: 409, message: 'That slot is no longer available.' },
        SLOT_HELD: { status: 409, message: 'That slot is temporarily held by another user.' },
        SLOT_TOO_SOON: { status: 400, message: 'Choose a slot at least 1 hour from now.' },
        SLOT_OUT_OF_RANGE: { status: 400, message: 'That slot is outside the booking window.' },
        INVALID_SLOT: { status: 400, message: 'Invalid slot time.' },
        EMAIL_REQUIRED: { status: 400, message: 'An email address is required to book.' },
        EMAIL_NOT_VERIFIED: {
            status: 403,
            message: 'Please verify your email address before booking a session.',
        },
        PAYMENT_REQUIRED: { status: 403, message: 'Payment is required for booking.' },
        PAYMENT_NOT_REQUIRED: { status: 400, message: 'Payment is not required for this booking.' },
        STRIPE_NOT_CONFIGURED: {
            status: 503,
            message: 'Payments are not configured yet. Please try again later.',
        },
        STRIPE_PRICE_NOT_CONFIGURED: {
            status: 503,
            message: 'Session pricing is not configured yet. Please contact support.',
        },
        PRICE_NOT_ONE_TIME: {
            status: 503,
            message: 'Session pricing is misconfigured. Please contact support.',
        },
        CHECKOUT_URL_MISSING: { status: 502, message: 'Could not start checkout. Please try again.' },
        CHECKOUT_NOT_COUNSELLING: { status: 400, message: 'This checkout session is not a counselling booking.' },
        CHECKOUT_NOT_PAID: { status: 402, message: 'Payment has not been completed yet.' },
        CHECKOUT_SESSION_NOT_FOUND: { status: 404, message: 'Checkout session not found.' },
        CHECKOUT_SESSION_INVALID: { status: 400, message: 'Invalid checkout session.' },
        CHECKOUT_SESSION_FORBIDDEN: { status: 403, message: 'This checkout session does not belong to your account.' },
        PRICE_NOT_GBP: {
            status: 503,
            message: 'Session pricing is misconfigured. Please contact support.',
        },
        BOOKING_SAVE_FAILED: { status: 500, message: 'Could not save the booking.' },
        BOOKING_LIST_FAILED: {
            status: 503,
            message: 'Could not load booking availability. Please try again shortly.',
        },
        BOOKING_STATUS_CONSTRAINT: {
            status: 503,
            message: 'Booking is not fully configured yet. Please try again later.',
        },
        BOOKING_LOCK_UNAVAILABLE: {
            status: 503,
            message: 'Booking is temporarily unavailable. Please try again in a moment.',
        },
        RESERVATION_NOT_FOUND: { status: 404, message: 'Reservation not found.' },
        RESERVATION_INVALID: { status: 409, message: 'This reservation is no longer valid.' },
        RESERVATION_EXPIRED: {
            status: 409,
            message: 'Your hold on this slot expired. Please pick a time again.',
        },
    };

    const mapped = table[code] ?? { status: 500, message: 'Something went wrong.' };
    return { status: mapped.status, code, message: mapped.message };
}
