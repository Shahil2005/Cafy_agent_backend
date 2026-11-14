import type { SupabaseClient } from '@supabase/supabase-js';
import { releaseSlotHold } from './slotHold';

export type BookingStatus = 'reserved' | 'confirmed' | 'cancelled' | 'expired' | 'failed' | 'pending';

export type MentorBookingRow = {
    id: string;
    user_id: string;
    mentor_id: number;
    mentor_name: string | null;
    status: string;
    slot_starts_at: string | null;
    slot_ends_at: string | null;
    duration_minutes: number | null;
    reservation_expires_at: string | null;
    cal_booking_uid: string | null;
    meeting_url: string | null;
    goal: string | null;
    booked_day: string | null;
    booked_time: string | null;
    user_email: string | null;
    price_tier: string | null;
    amount_pence: number | null;
    payment_released: boolean | null;
    stripe_checkout_session_id: string | null;
    stripe_payment_intent_id: string | null;
    paid_at: string | null;
    created_at: string | null;
};

function isStatusCheckViolation(message: string): boolean {
    return /mentor_bookings_status_check/i.test(message);
}

function isUniqueViolation(message: string): boolean {
    return /duplicate key|unique constraint|mentor_bookings_one_active_slot/i.test(message);
}

function normalizeSlotIso(iso: string): string {
    return new Date(iso).toISOString();
}

/** Active slot starts (reserved + confirmed, not past reservation expiry). */
export async function listActiveSlotStartsForMentor(
    db: SupabaseClient,
    mentorId: number
): Promise<string[]> {
    const nowIso = new Date().toISOString();

    const { data, error } = await db
        .from('mentor_bookings')
        .select('slot_starts_at, status, reservation_expires_at')
        .eq('mentor_id', mentorId)
        .in('status', ['reserved', 'confirmed']);

    if (error) {
        console.error('[counselling] list active slots failed', error.message);
        throw new Error('BOOKING_LIST_FAILED');
    }

    const starts: string[] = [];
    for (const row of data ?? []) {
        const start = row.slot_starts_at as string | null;
        if (!start) continue;
        if (row.status === 'reserved') {
            const exp = row.reservation_expires_at as string | null;
            if (exp && exp <= nowIso) continue;
        }
        starts.push(start);
    }
    return starts;
}

export async function listActiveReservationsForUser(
    db: SupabaseClient,
    uid: string
): Promise<MentorBookingRow[]> {
    const nowIso = new Date().toISOString();
    const { data, error } = await db
        .from('mentor_bookings')
        .select('*')
        .eq('user_id', uid)
        .eq('status', 'reserved');

    if (error) {
        console.error('[counselling] list user reservations failed', error.message);
        throw new Error('BOOKING_LIST_FAILED');
    }

    return (data ?? []).filter((row) => {
        const exp = (row as MentorBookingRow).reservation_expires_at;
        return !exp || exp > nowIso;
    }) as MentorBookingRow[];
}

export async function findBookingByCalUid(
    db: SupabaseClient,
    calUid: string
): Promise<MentorBookingRow | null> {
    const { data, error } = await db
        .from('mentor_bookings')
        .select('*')
        .eq('cal_booking_uid', calUid)
        .maybeSingle();

    if (error) {
        console.error('[counselling] find by cal uid failed', error.message);
        return null;
    }
    return (data as MentorBookingRow | null) ?? null;
}

/** Match a reserved/failed row when Cal.com webhook arrives before DB confirm completes. */
export async function findReconcilableBooking(
    db: SupabaseClient,
    input: {
        mentorId: number;
        attendeeEmail: string;
        slotStartsAt: string;
    }
): Promise<MentorBookingRow | null> {
    const slotIso = normalizeSlotIso(input.slotStartsAt);
    const email = input.attendeeEmail.trim().toLowerCase();

    const { data, error } = await db
        .from('mentor_bookings')
        .select('*')
        .eq('mentor_id', input.mentorId)
        .in('status', ['reserved', 'failed'])
        .ilike('user_email', email);

    if (error || !data?.length) {
        return null;
    }

    return (
        (data as MentorBookingRow[]).find(
            (row) => row.slot_starts_at && normalizeSlotIso(row.slot_starts_at) === slotIso
        ) ?? null
    );
}

export async function getBookingById(
    db: SupabaseClient,
    bookingId: string
): Promise<MentorBookingRow | null> {
    const { data, error } = await db.from('mentor_bookings').select('*').eq('id', bookingId).maybeSingle();
    if (error || !data) return null;
    return data as MentorBookingRow;
}

export async function insertBookingRow(
    db: SupabaseClient,
    payload: Record<string, unknown>
): Promise<MentorBookingRow> {
    const { data, error } = await db.from('mentor_bookings').insert(payload).select().single();
    if (error) {
        if (isUniqueViolation(error.message)) {
            throw new Error('SLOT_UNAVAILABLE');
        }
        if (isStatusCheckViolation(error.message)) {
            console.error(
                '[counselling] status check failed — run migrations/002_mentor_bookings_status_check.sql',
                error.message
            );
            throw new Error('BOOKING_STATUS_CONSTRAINT');
        }
        console.error('[counselling] insert booking failed', error.message, error.details);
        throw new Error('BOOKING_SAVE_FAILED');
    }
    return data as MentorBookingRow;
}

export async function updateBookingRow(
    db: SupabaseClient,
    bookingId: string,
    patch: Record<string, unknown>
): Promise<void> {
    const { error } = await db.from('mentor_bookings').update(patch).eq('id', bookingId);
    if (error) {
        if (isUniqueViolation(error.message)) {
            throw new Error('SLOT_UNAVAILABLE');
        }
        if (isStatusCheckViolation(error.message)) {
            throw new Error('BOOKING_STATUS_CONSTRAINT');
        }
        console.error('[counselling] update booking failed', bookingId, error.message);
        throw new Error('BOOKING_SAVE_FAILED');
    }
}

/** Expire stale holds and release Redis locks. Returns rows that were expired. */
export async function expireStaleReservations(db: SupabaseClient): Promise<MentorBookingRow[]> {
    const nowIso = new Date().toISOString();

    const { data: stale, error: selectError } = await db
        .from('mentor_bookings')
        .select('*')
        .eq('status', 'reserved')
        .lt('reservation_expires_at', nowIso);

    if (selectError) {
        console.warn('[counselling] list stale reservations failed', selectError.message);
        return [];
    }

    const rows = (stale ?? []) as MentorBookingRow[];
    if (!rows.length) {
        return [];
    }

    const { error: updateError } = await db
        .from('mentor_bookings')
        .update({ status: 'expired' })
        .eq('status', 'reserved')
        .lt('reservation_expires_at', nowIso);

    if (updateError) {
        console.warn('[counselling] expire stale reservations failed', updateError.message);
        return [];
    }

    for (const row of rows) {
        if (row.slot_starts_at && row.mentor_id) {
            await releaseSlotHold(row.mentor_id, row.slot_starts_at, row.user_id);
        }
    }

    return rows;
}
