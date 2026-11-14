import * as admin from 'firebase-admin';
import crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isCounsellingEnabled } from './config';
import {
    findBookingByCalUid,
    findReconcilableBooking,
    updateBookingRow,
    type MentorBookingRow,
} from './bookingRepository';
import { loadMentorIdByCalUsername } from './mentorRepository';

type CalWebhookPayload = {
    triggerEvent?: string;
    createdAt?: string;
    payload?: CalBookingPayload;
};

type CalBookingPayload = {
    uid?: string;
    rescheduleUid?: string;
    startTime?: string;
    endTime?: string;
    length?: number;
    location?: string;
    videoCallData?: { url?: string };
    metadata?: { videoCallUrl?: string };
    organizer?: { username?: string; name?: string; timeZone?: string };
    attendees?: Array<{ email?: string; name?: string }>;
    additionalNotes?: string;
};

function eventDedupDocId(body: CalWebhookPayload): string {
    const uid = body.payload?.uid ?? '';
    const trigger = body.triggerEvent ?? 'unknown';
    const at = body.createdAt ?? '';
    const key = `${trigger}:${uid}:${at}`;
    return crypto.createHash('sha256').update(key).digest('hex');
}

async function isWebhookEventProcessed(key: string): Promise<boolean> {
    const ref = admin.firestore().doc(`counselling_webhook_events/${key}`);
    const snap = await ref.get();
    return snap.exists;
}

async function markWebhookEventProcessed(key: string, trigger: string): Promise<void> {
    await admin.firestore().doc(`counselling_webhook_events/${key}`).set({
        trigger,
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
}

function meetingUrlFromPayload(payload: CalBookingPayload): string | null {
    const fromVideo = payload.videoCallData?.url?.trim();
    if (fromVideo) return fromVideo;
    const fromMeta = payload.metadata?.videoCallUrl?.trim();
    if (fromMeta) return fromMeta;
    const loc = payload.location?.trim();
    if (loc?.startsWith('http://') || loc?.startsWith('https://')) return loc;
    return null;
}

function legacyBookedFields(slotStartsAt: string, timeZone: string): { bookedDay: string; bookedTime: string } {
    const date = new Date(slotStartsAt);
    return {
        bookedDay: date.toLocaleDateString('en-CA', { timeZone }),
        bookedTime: date.toLocaleTimeString('en-GB', {
            timeZone,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }),
    };
}

async function handleRescheduled(db: SupabaseClient, payload: CalBookingPayload): Promise<void> {
    const lookupUid = payload.rescheduleUid?.trim() || payload.uid?.trim();
    if (!lookupUid || !payload.startTime) {
        console.warn('[counselling webhook] BOOKING_RESCHEDULED missing uid or startTime');
        return;
    }

    const row = await findBookingByCalUid(db, lookupUid);
    if (!row) {
        console.warn('[counselling webhook] no mentor_bookings row for rescheduleUid', lookupUid);
        return;
    }

    const timeZone = payload.organizer?.timeZone?.trim() || 'Europe/London';
    const legacy = legacyBookedFields(payload.startTime, timeZone);
    const slotEnd =
        payload.endTime ??
        new Date(new Date(payload.startTime).getTime() + (payload.length ?? 30) * 60_000).toISOString();

    const patch: Record<string, unknown> = {
        status: 'confirmed',
        slot_starts_at: payload.startTime,
        slot_ends_at: slotEnd,
        booked_day: legacy.bookedDay,
        booked_time: legacy.bookedTime,
        meeting_url: meetingUrlFromPayload(payload),
        reservation_expires_at: null,
    };

    if (payload.uid && payload.uid !== lookupUid) {
        patch.cal_booking_uid = payload.uid;
    }

    await updateBookingRow(db, row.id, patch);
    console.log('[counselling webhook] rescheduled booking', row.id, payload.startTime);
}

async function handleCancelled(db: SupabaseClient, payload: CalBookingPayload): Promise<void> {
    const uid = payload.uid?.trim();
    if (!uid) {
        console.warn('[counselling webhook] BOOKING_CANCELLED missing uid');
        return;
    }

    const row = await findBookingByCalUid(db, uid);
    if (!row) {
        console.warn('[counselling webhook] no mentor_bookings row for cancelled uid', uid);
        return;
    }

    await updateBookingRow(db, row.id, { status: 'cancelled' });
    console.log('[counselling webhook] cancelled booking', row.id);
}

async function handleCreated(db: SupabaseClient, payload: CalBookingPayload): Promise<void> {
    const calUid = payload.uid?.trim();
    if (!calUid || !payload.startTime) return;

    const existing = await findBookingByCalUid(db, calUid);
    if (existing) {
        return;
    }

    const organizerUsername = payload.organizer?.username?.trim();
    const attendeeEmail = payload.attendees?.[0]?.email?.trim();
    if (!organizerUsername || !attendeeEmail) {
        console.info('[counselling webhook] BOOKING_CREATED — no Cafy row, missing organizer or attendee', calUid);
        return;
    }

    const mentorId = await loadMentorIdByCalUsername(db, organizerUsername);
    if (!mentorId) {
        console.info('[counselling webhook] BOOKING_CREATED — unknown mentor', organizerUsername, calUid);
        return;
    }

    const row = await findReconcilableBooking(db, {
        mentorId,
        attendeeEmail,
        slotStartsAt: payload.startTime,
    });

    if (!row) {
        console.info('[counselling webhook] BOOKING_CREATED — no reconcilable Cafy row', calUid);
        return;
    }

    const timeZone = payload.organizer?.timeZone?.trim() || 'Europe/London';
    const legacy = legacyBookedFields(payload.startTime, timeZone);
    const slotEnd =
        payload.endTime ??
        new Date(new Date(payload.startTime).getTime() + (payload.length ?? row.duration_minutes ?? 30) * 60_000).toISOString();

    await updateBookingRow(db, row.id, {
        status: 'confirmed',
        cal_booking_uid: calUid,
        meeting_url: meetingUrlFromPayload(payload),
        slot_starts_at: payload.startTime,
        slot_ends_at: slotEnd,
        booked_day: legacy.bookedDay,
        booked_time: legacy.bookedTime,
        reservation_expires_at: null,
    });

    console.log('[counselling webhook] reconciled BOOKING_CREATED to row', row.id, calUid);
}

export async function processCalComWebhook(db: SupabaseClient, body: CalWebhookPayload): Promise<void> {
    if (!isCounsellingEnabled()) {
        console.info('[counselling webhook] ignored — COUNSELLING_ENABLED is not true');
        return;
    }

    const trigger = body.triggerEvent ?? '';

    if (trigger === 'PING') {
        return;
    }

    const payload = body.payload;
    if (!payload) {
        console.warn('[counselling webhook] missing payload', trigger);
        return;
    }

    const dedupKey = eventDedupDocId(body);
    if (await isWebhookEventProcessed(dedupKey)) {
        return;
    }

    switch (trigger) {
        case 'BOOKING_RESCHEDULED':
            await handleRescheduled(db, payload);
            break;
        case 'BOOKING_CANCELLED':
            await handleCancelled(db, payload);
            break;
        case 'BOOKING_CREATED':
            await handleCreated(db, payload);
            break;
        default:
            console.info('[counselling webhook] unhandled trigger', trigger);
    }

    await markWebhookEventProcessed(dedupKey, trigger);
}
